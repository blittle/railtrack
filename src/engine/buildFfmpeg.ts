/**
 * The heart of the engine: turn a TimelapseProject into a concrete ffmpeg
 * argument vector. Deterministic and pure — no filesystem, no spawning. The
 * Rust/Tauri backend takes the returned `args` and executes them; a future CLI
 * would do the same. This mirrors the hand-written make_timelapse.sh pipeline
 * we validated, generalized to arbitrary keyframes.
 */

import type {
  DenoiseSettings,
  Keyframe,
  OutputSettings,
  TimelapseProject,
} from "./project";
import { hasZoom } from "./interpolate";

export class ZoomNotSupportedError extends Error {
  constructor() {
    super(
      "Animated zoom (keyframes with differing w/h) is not supported by the " +
        "crop-expression path. ffmpeg's crop filter fixes w/h at config time; " +
        "zoom requires the zoompan path (planned). For now keep window size " +
        "constant across keyframes (pan/move only).",
    );
    this.name = "ZoomNotSupportedError";
  }
}

export interface BuiltCommand {
  /** The full ffmpeg argument vector (excluding the ffmpeg binary itself). */
  args: string[];
  /** The -vf filtergraph string, exposed for inspection/tests. */
  filtergraph: string;
  /** Approximate number of output frames (for progress %). */
  outputFrames: number;
}

export interface PreviewOptions {
  /** Output width in px; height derives from the project's output aspect. */
  width: number;
}

export interface BuildOptions {
  /**
   * When set, render fast & low-res with an ultrafast preset (and no denoise).
   * Decode cost is bounded by limiting the *input* frames (e.g. a symlinked
   * subset), NOT by decimating here — so the clip plays at full frame rate.
   */
  preview?: PreviewOptions;
}

/** Format a number for an ffmpeg expression: integers stay clean, no exp notation. */
function num(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(4).replace(/\.?0+$/, "");
}

function evenFloor(v: number): number {
  const n = Math.floor(v);
  return n - (n % 2);
}

/** Escape commas so the filtergraph parser keeps them inside the expression. */
function escapeExpr(expr: string): string {
  return expr.replace(/,/g, "\\,");
}

/**
 * Build a piecewise expression for one window property (x or y) across the
 * keyframe segments, evaluated against `frameVar` (an ffmpeg expression giving
 * the effective source-frame index — usually "n", but a shifted/held expression
 * when segments are reordered for star-trail wind-down). Holds the endpoints
 * outside the keyframed range. Easing belongs to each segment's destination kf.
 */
function buildExpr(
  keyframes: Keyframe[],
  pick: (k: Keyframe) => number,
  frameVar = "n",
): string {
  const k = [...keyframes].sort((a, b) => a.frame - b.frame);
  const last = k[k.length - 1];
  const V = frameVar;

  // default (frame >= last frame): hold the last value
  let expr = num(pick(last));

  for (let i = k.length - 2; i >= 0; i--) {
    const a = k[i];
    const b = k[i + 1];
    const va = pick(a);
    const vb = pick(b);
    const span = b.frame - a.frame;

    let seg: string;
    if (span === 0 || va === vb) {
      seg = num(vb);
    } else {
      const u = `(${V}-${num(a.frame)})/${num(span)}`; // normalized progress 0..1
      let t: string;
      if (b.easing === "easeInOut") {
        // smoothstep: u*u*(3-2*u)
        t = `(${u})*(${u})*(3-2*(${u}))`;
      } else {
        t = `(${u})`;
      }
      seg = `${num(va)}+(${num(vb - va)})*${t}`;
    }

    // apply this segment when frame < b.frame (earlier guards handle frame < a.frame)
    expr = `if(lt(${V},${num(b.frame)}),${seg},${expr})`;
  }

  // before the first keyframe: hold the first value
  const first = k[0];
  expr = `if(lt(${V},${num(first.frame)}),${num(pick(first))},${expr})`;
  return expr;
}

/** Map user 0..1 denoise strength to a concrete ffmpeg filter string. */
export function denoiseFilter(d: DenoiseSettings): string {
  const s = Math.min(1, Math.max(0, d.strength));
  if (d.filter === "hqdn3d") {
    // strength 0.5 -> "4:3:6:0" (matches our validated gentle preset).
    // Keep chroma-temporal at 0 so moving stars don't smear.
    const ls = num(+(s * 8).toFixed(2));
    const cs = num(+(s * 6).toFixed(2));
    const lt = num(+(s * 12).toFixed(2));
    return `hqdn3d=${ls}:${cs}:${lt}:0`;
  }
  // fftdnoiz: strength 0.5 -> sigma 4 (matches our validated preset)
  const sigma = num(+(s * 8).toFixed(2));
  return `fftdnoiz=sigma=${sigma}`;
}

function videoCodecArgs(o: OutputSettings): string[] {
  switch (o.codec) {
    case "h264":
      return ["-c:v", "libx264", "-preset", "slow", "-crf", String(o.crf),
              "-pix_fmt", "yuv420p"];
    case "h265":
      return ["-c:v", "libx265", "-preset", "slow", "-crf", String(o.crf),
              "-pix_fmt", "yuv420p", "-tag:v", "hvc1"];
    case "prores":
      return ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"];
  }
}

/**
 * Build the full ffmpeg command for a project.
 * Pass `opts.preview` to render fast & low-res with an ultrafast preset (and no
 * denoise). It plays the whole timelapse at full frame rate; speed comes from
 * pointing the source at a low-res proxy cache, not from decimating here.
 * @throws ZoomNotSupportedError if keyframes animate the window size.
 */
export function buildFfmpeg(p: TimelapseProject, opts: BuildOptions = {}): BuiltCommand {
  if (p.keyframes.length < 2) {
    throw new Error("buildFfmpeg: need at least 2 keyframes");
  }
  if (hasZoom(p.keyframes)) {
    throw new ZoomNotSupportedError();
  }
  const preview = opts.preview;

  // window size is constant across keyframes (pan/move only)
  const cw = evenFloor(p.keyframes[0].w);
  const ch = evenFloor(p.keyframes[0].h);

  // Output resolution: full for a real render, low-res for a preview.
  const ow = preview ? evenFloor(preview.width) : evenFloor(p.output.w);
  const oh = preview
    ? evenFloor((ow * p.output.h) / p.output.w)
    : evenFloor(p.output.h);

  // crop filter whose pan is evaluated against an effective-frame expression
  // (usually "n"; a shifted/held one for reordered star-trail segments).
  // Commas inside the expressions are escaped so the filtergraph parser keeps
  // them inside the crop options instead of reading them as filter separators.
  const cropFor = (fv: string) =>
    `crop=${cw}:${ch}:` +
    `${escapeExpr(buildExpr(p.keyframes, (k) => k.x, fv))}:` +
    `${escapeExpr(buildExpr(p.keyframes, (k) => k.y, fv))}`;

  const trail = p.post.starTrail;
  const scaleFilter = `scale=${ow}:${oh}:flags=${preview ? "lanczos" : p.output.scaleFlags}`;
  // Denoise runs before stacking when trailing (so noise isn't baked into trails);
  // otherwise after scaling (cheaper). Preview skips denoise for speed.
  const denoise = preview || !p.post.denoise ? null : denoiseFilter(p.post.denoise);
  const decayNum = trail ? Math.min(1, Math.max(0, trail.decay)) : 1;
  const decay = num(decayNum);

  // Sub-pixel pan: ffmpeg's crop is integer-only, so a slow pan jumps a whole
  // pixel every few frames (stutter). Supersampling horizontally (upscale ->
  // integer-crop in the finer space -> downscale) makes each step a fraction of
  // a pixel. Cheap on small preview proxies; off (ss=1) for the full render,
  // where the frame is ~42MP and the downscale already softens the steps.
  const ss = preview ? 4 : 1;
  const windowCropScale = (fv: string): string => {
    if (ss <= 1) return `${cropFor(fv)},${scaleFilter}`;
    const xe = escapeExpr(`(${buildExpr(p.keyframes, (k) => k.x, fv)})*${ss}`);
    const ye = escapeExpr(buildExpr(p.keyframes, (k) => k.y, fv));
    return (
      `scale=iw*${ss}:ih:flags=bilinear,` +
      `crop=${cw * ss}:${ch}:${xe}:${ye},` +
      `${scaleFilter}`
    );
  };

  const N = p.source.frameCount;
  const clampN = (v: number) => Math.max(0, Math.min(N - 1, Math.floor(v)));
  // Trail accumulates over [start, end]. lagfun keeps an internal running max
  // even when timeline-disabled, so `enable=` can't gate it — instead we split
  // the stream and run lagfun only on the relevant segment(s) and concat.
  const start = trail ? clampN(trail.startFrame ?? 0) : 0;
  const end = trail ? Math.max(start, clampN(trail.endFrame ?? N - 1)) : N - 1;
  const delayedStart = !!trail && start > 0;
  const windDown = !!trail && end < N - 1; // frames remain after the trail -> retract

  let outputFrames = N;
  const inputPattern = `${p.source.dir.replace(/\/$/, "")}/${p.source.glob}`;

  const codecArgs = preview
    ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
       "-r", String(p.output.fps)]
    : videoCodecArgs(p.output);

  let graphArgs: string[];
  let filtergraph: string;

  if (trail && windDown && decayNum < 1) {
    // COMET wind-down: a fading comet has a direction, and the reverse-erosion
    // trick flips that direction (visible swap). Instead, crossfade the comet
    // stream into the plain timelapse over a short window after `end`, so trails
    // dissolve away while the scene keeps playing live. No added frames; both
    // streams share crop("n") so they stay aligned and the pan tracks normally.
    const head = denoise ? `${denoise},` : "";
    const fadeLen = Math.min(N - 1 - end, Math.max(1, Math.round(p.output.fps * 1.5)));
    const cropScale = windowCropScale("n");
    const alpha = escapeExpr(`clip((N-${end})/${fadeLen},0,1)`);
    const trailChain =
      start > 0
        ? `[ti]split=2[a][b];` +
          `[a]trim=end_frame=${start},setpts=PTS-STARTPTS[pre];` +
          `[b]trim=start_frame=${start},setpts=PTS-STARTPTS,lagfun=decay=${decay}[post];` +
          `[pre][post]concat=n=2:v=1,${cropScale}[t]`
        : `[ti]lagfun=decay=${decay},${cropScale}[t]`;
    filtergraph =
      `[0:v]${head}split=2[ti][pi];` +
      `${trailChain};` +
      `[pi]${cropScale}[p];` +
      `[t][p]blend=all_expr=A*(1-(${alpha}))+B*(${alpha})[outv]`;
    graphArgs = ["-filter_complex", filtergraph, "-map", "[outv]", "-r", String(p.output.fps)];
  } else if (trail && windDown) {
    // Segments: A untouched [0,start) | B grow [start,end] | C retract | D normal
    // [end+1,N). C is reverse(lagfun(reverse([start,end]))) — a FIFO erosion that
    // retracts the trail back to points. C adds (end-start+1) frames, so the clip
    // is that much longer (the scene roughly holds while the trail retracts).
    const L = end - start;
    outputFrames = N + (L + 1);
    // Pan is parameterized by OUTPUT time (mapped back to a source frame) so it
    // keeps gliding continuously across every segment — including the retract —
    // instead of stalling. Each segment supplies its output-frame offset.
    const K = (N - 1) / (outputFrames - 1);
    const fv = (offset: number) => `(${num(K)}*(n+${offset}))`;
    const cs = (offset: number) => windowCropScale(fv(offset));
    const head = denoise ? `${denoise},` : "";

    // Retract C: do the (reverse) max on a downscaled FIXED full frame so the
    // window can move afterwards without smearing trails — and so `reverse`'s
    // frame buffer is bounded by output size, not the 42MP source.
    const sf = ow / cw; // source-window px -> output px
    const w2 = evenFloor(p.source.width * sf) + 2;
    const h2 = evenFloor((p.source.height * w2) / p.source.width);
    const cOff = start + L + 1; // C's first output frame
    const cx = escapeExpr(
      `min(max((${buildExpr(p.keyframes, (k) => k.x, fv(cOff))})*${num(sf)},0),${w2 - ow})`,
    );
    const cy = escapeExpr(
      `min(max((${buildExpr(p.keyframes, (k) => k.y, fv(cOff))})*${num(sf)},0),${h2 - oh})`,
    );

    const segs: string[] = [];
    if (start > 0) segs.push("A");
    segs.push("B", "C");
    if (end < N - 1) segs.push("D");

    const splitPads = segs.map((s) => `[${s}0]`).join("");
    const chains = [`[0:v]${head}split=${segs.length}${splitPads}`];
    if (segs.includes("A"))
      chains.push(`[A0]trim=end_frame=${start},setpts=PTS-STARTPTS,${cs(0)}[A]`);
    chains.push(
      `[B0]trim=start_frame=${start}:end_frame=${end + 1},setpts=PTS-STARTPTS,` +
        `lagfun=decay=${decay},${cs(start)}[B]`,
    );
    chains.push(
      `[C0]trim=start_frame=${start}:end_frame=${end + 1},setpts=PTS-STARTPTS,` +
        `scale=${w2}:${h2},reverse,lagfun=decay=${decay},reverse,crop=${ow}:${oh}:${cx}:${cy}[C]`,
    );
    if (segs.includes("D"))
      chains.push(`[D0]trim=start_frame=${end + 1},setpts=PTS-STARTPTS,${cs(start + 2 * L + 2)}[D]`);
    chains.push(`${segs.map((s) => `[${s}]`).join("")}concat=n=${segs.length}:v=1[outv]`);

    filtergraph = chains.join(";");
    graphArgs = ["-filter_complex", filtergraph, "-map", "[outv]", "-r", String(p.output.fps)];
  } else if (trail && delayedStart) {
    // delayed start, trail runs to the end of the clip (no retract)
    const head = denoise ? `${denoise},` : "";
    filtergraph =
      `[0:v]${head}split=2[a][b];` +
      `[a]trim=end_frame=${start},setpts=PTS-STARTPTS[pre];` +
      `[b]trim=start_frame=${start},setpts=PTS-STARTPTS,lagfun=decay=${decay}[post];` +
      `[pre][post]concat=n=2:v=1,${windowCropScale("n")}[outv]`;
    graphArgs = ["-filter_complex", filtergraph, "-map", "[outv]", "-r", String(p.output.fps)];
  } else {
    const parts: string[] = [];
    if (denoise && trail) parts.push(denoise); // before lagfun
    if (trail) parts.push(`lagfun=decay=${decay}`);
    parts.push(windowCropScale("n"));
    if (denoise && !trail) parts.push(denoise); // after scale (cheaper)
    filtergraph = parts.join(",");
    graphArgs = ["-vf", filtergraph];
  }

  const args = [
    "-y",
    "-framerate", String(p.output.fps),
    "-pattern_type", "glob",
    "-i", inputPattern,
    ...graphArgs,
    ...codecArgs,
    "-movflags", "+faststart",
    p.output.path,
  ];

  return { args, filtergraph, outputFrames };
}

/**
 * Build the ffmpeg command that generates the low-res proxy cache: one decode
 * pass over the source frames, downscaled to `width`, written as numbered JPEGs
 * into `proxyDir`. Run once; later previews read these small frames and are fast.
 */
export function buildProxyCommand(
  sourceDir: string,
  glob: string,
  proxyDir: string,
  width: number,
): string[] {
  const input = `${sourceDir.replace(/\/$/, "")}/${glob}`;
  const output = `${proxyDir.replace(/\/$/, "")}/frame_%05d.jpg`;
  return [
    "-y",
    "-pattern_type", "glob",
    "-i", input,
    "-vf", `scale=${evenFloor(width)}:-1:flags=bilinear`,
    "-q:v", "3",
    output,
  ];
}
