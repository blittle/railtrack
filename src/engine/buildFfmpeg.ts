/**
 * The heart of the engine: turn a TimelapseProject into a concrete ffmpeg
 * argument vector. Deterministic and pure — no filesystem, no spawning. The
 * Rust/Tauri backend takes the returned `args` and executes them; a future CLI
 * would do the same. This mirrors the hand-written make_timelapse.sh pipeline
 * we validated, generalized to arbitrary keyframes.
 */

import type {
  ColorSettings,
  DebandSettings,
  DeflickerSettings,
  DenoiseSettings,
  FrameStackSettings,
  Keyframe,
  LightenSpeedupSettings,
  OutputSettings,
  TimelapseProject,
} from "./project";
import { VIDEOTOOLBOX_ENCODER } from "./project";
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
  /**
   * Horizontal supersample factor for sub-pixel (smooth) panning on the full
   * render. 1 = off (default). Higher = smoother slow pans, but much slower to
   * render (it upscales each full-res frame). Previews always supersample.
   */
  panSupersample?: number;
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
  if (d.filter === "nlmeans") {
    // Highest quality, slowest. Map strength 0..1 -> denoise strength s 1..10
    // (ffmpeg allows up to 30, but past ~10 it smears detail). Patch/research
    // windows keep their defaults.
    const str = num(+(1 + s * 9).toFixed(2));
    return `nlmeans=s=${str}`;
  }
  // fftdnoiz: strength 0.5 -> sigma 4 (matches our validated preset)
  const sigma = num(+(s * 8).toFixed(2));
  return `fftdnoiz=sigma=${sigma}`;
}

/**
 * Deband filter: raise the per-plane thresholds from ffmpeg's gentle 0.02 default
 * so smooth gradients (skies) lose their stepped banding. Strength 0..1 maps to
 * ~0.005..0.06; past that it starts eroding real detail.
 */
export function debandFilter(d: DebandSettings): string {
  const s = Math.min(1, Math.max(0, d.strength));
  const thr = num(+(0.005 + s * 0.055).toFixed(5));
  return `deband=1thr=${thr}:2thr=${thr}:3thr=${thr}:4thr=${thr}`;
}

/**
 * Temporal frame-stacking filter for noise reduction.
 * - median: `tmedian=radius=r` — picks the per-pixel median across 2r+1 frames,
 *   rejecting transient outliers (satellites/planes/hot pixels).
 * - mean: `tmix=frames=n` with triangular (center-weighted) weights so the
 *   current frame dominates and stacking softens noise without over-blurring.
 * Both preserve the frame count (a trailing/centered window), so no downstream
 * frame-count math changes.
 */
export function frameStackFilter(s: FrameStackSettings): string {
  const n = Math.max(2, Math.min(15, Math.floor(s.frames)));
  if (s.mode === "median") {
    // tmedian needs an odd window (2r+1); radius from the requested size.
    return `tmedian=radius=${Math.max(1, Math.floor(n / 2))}`;
  }
  // Triangular weights, e.g. n=5 -> "1 2 3 2 1"; tmix normalizes by their sum.
  const mid = (n - 1) / 2;
  const w = Array.from({ length: n }, (_, i) => num(mid - Math.abs(i - mid) + 1));
  return `tmix=frames=${n}:weights='${w.join(" ")}'`;
}

/**
 * Deflicker filter: normalize luminance over a rolling window (arithmetic mean).
 * Clamped to ffmpeg's supported 2..129 frame window.
 */
export function deflickerFilter(s: DeflickerSettings): string {
  const size = Math.max(2, Math.min(129, Math.floor(s.size)));
  return `deflicker=size=${size}:mode=am`;
}

/** Clamp a lighten-speedup factor to a sane integer (>= 2). */
export function speedupFactor(s: LightenSpeedupSettings): number {
  return Math.max(2, Math.floor(s.factor));
}

/**
 * Lighten speed-up: `factor-1` chained `tblend=all_mode=lighten` build a sliding
 * max over `factor` frames; `framestep=factor` keeps one per non-overlapping
 * group; `setpts=PTS/factor` retimes the survivors so the clip actually plays
 * `factor`x faster (framestep alone drops frames but keeps the original timing).
 */
export function lightenSpeedupFilter(factor: number): string {
  const blends = Array(factor - 1).fill("tblend=all_mode=lighten").join(",");
  return `${blends},framestep=${factor},setpts=PTS/${factor}`;
}

export function brightnessToGamma(brightness: number): number {
  return Math.max(0.1, Math.min(10, 1 + brightness));
}

function toneCurveFilter(shadows: number, highlights: number): string | null {
  if (shadows === 0 && highlights === 0) return null;
  const shadowY = Math.max(0, Math.min(1, 0.25 + shadows * 0.002));
  const highlightY = Math.max(0, Math.min(1, 0.75 + highlights * 0.002));
  return `curves=all='0/0 0.25/${num(shadowY)} 0.75/${num(highlightY)} 1/1'`;
}

function tintFilter(tint: number): string | null {
  if (tint === 0) return null;
  const t = Math.max(-1, Math.min(1, tint / 100));
  const rg = num(+(t * 0.08).toFixed(4));
  const gg = num(+(-t * 0.08).toFixed(4));
  const bg = num(+(t * 0.08).toFixed(4));
  return `colorbalance=rm=${rg}:gm=${gg}:bm=${bg}`;
}

/** Color grade -> ffmpeg tone/color filter chain. */
export function gradeFilter(c: ColorSettings): string {
  const parts: string[] = [];
  const eq: string[] = [];
  const exposure = c.exposure ?? 0;
  const saturation = c.saturation ?? 1;
  if (exposure !== 0) eq.push(`brightness=${num(exposure)}`);
  if (c.brightness !== 0) eq.push(`gamma=${num(brightnessToGamma(c.brightness))}`);
  if (c.contrast !== 1) eq.push(`contrast=${num(c.contrast)}`);
  if (saturation !== 1) eq.push(`saturation=${num(saturation)}`);
  if (eq.length) parts.push(`eq=${eq.join(":")}`);
  const toneCurve = toneCurveFilter(c.shadows ?? 0, c.highlights ?? 0);
  if (toneCurve) parts.push(toneCurve);
  if (c.temperature !== 6500) {
    parts.push(`colortemperature=temperature=${num(Math.round(c.temperature))}`);
  }
  const tint = tintFilter(c.tint ?? 0);
  if (tint) parts.push(tint);
  const vibrance = c.vibrance ?? 0;
  if (vibrance !== 0) parts.push(`vibrance=intensity=${num(vibrance)}`);
  return parts.join(",");
}

/**
 * Map the CRF slider (12..30, lower = better) onto VideoToolbox's constant-quality
 * scale (-q:v, 1..100, higher = better). VideoToolbox has no CRF; this keeps the
 * one quality control meaningful across both encoder families. crf 12 -> ~85,
 * crf 18 -> ~72, crf 30 -> ~45.
 */
function crfToVtQuality(crf: number): number {
  const q = Math.round(((30 - crf) / (30 - 12)) * 40 + 45);
  return Math.max(1, Math.min(100, q));
}

function videoCodecArgs(o: OutputSettings): string[] {
  const hw = o.hwAccel;
  switch (o.codec) {
    case "h264":
      // VideoToolbox rejects x264's -preset/-crf; drive quality with -q:v instead.
      return hw
        ? ["-c:v", VIDEOTOOLBOX_ENCODER.h264, "-q:v", String(crfToVtQuality(o.crf)),
           "-pix_fmt", "yuv420p"]
        : ["-c:v", "libx264", "-preset", "slow", "-crf", String(o.crf),
           "-pix_fmt", "yuv420p"];
    case "h265":
      return hw
        ? ["-c:v", VIDEOTOOLBOX_ENCODER.h265, "-q:v", String(crfToVtQuality(o.crf)),
           "-pix_fmt", "yuv420p", "-tag:v", "hvc1"]
        : ["-c:v", "libx265", "-preset", "slow", "-crf", String(o.crf),
           "-pix_fmt", "yuv420p", "-tag:v", "hvc1"];
    case "prores":
      return hw
        ? ["-c:v", VIDEOTOOLBOX_ENCODER.prores, "-profile:v", "3", "-pix_fmt", "yuv422p10le"]
        : ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"];
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
  if (p.post.lightenSpeedup && p.post.starTrail) {
    throw new Error(
      "Lighten speed-up and star trails can't be combined — both are lighten " +
        "stacks, but speed-up decimates frames while trails preserve them. " +
        "Enable one or the other.",
    );
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
  // Temporal frame stacking (noise reduction) runs on the raw pre-crop frames,
  // ahead of everything else, so the pan is applied after the blend (no pan
  // ghosting). Kept in previews — unlike denoise — so the effect is visible.
  const stack = p.post.frameStack ? frameStackFilter(p.post.frameStack) : null;
  // Deflicker normalizes exposure per raw frame; it must run first, before any
  // blending averages a flickering frame into its neighbours. Kept in previews.
  const deflicker = p.post.deflicker ? deflickerFilter(p.post.deflicker) : null;
  // Lighten speed-up: decimates by `speedup` and shortens the clip. Guarded above
  // to be mutually exclusive with star trails, so it only appears on the simple
  // (non-trail) path. Kept in previews so its motion effect is visible.
  const speedup = p.post.lightenSpeedup ? speedupFactor(p.post.lightenSpeedup) : 0;
  // Shared pre-crop prefix for the complex (star-trail) filtergraphs: deflicker,
  // then stack, then denoise, applied before the stream is split. Empty if none.
  const preHead = [deflicker, stack, denoise].filter(Boolean).join(",");
  const head = preHead ? `${preHead},` : "";
  const decayNum = trail ? Math.min(1, Math.max(0, trail.decay)) : 1;
  const decay = num(decayNum);

  // Sub-pixel pan: ffmpeg's crop is integer-only, so a slow pan jumps a whole
  // pixel every few frames (stutter). Supersampling horizontally (upscale ->
  // integer-crop in the finer space -> downscale) makes each step a fraction of
  // a pixel. Cheap on small preview proxies; off (ss=1) for the full render,
  // where the frame is ~42MP and the downscale already softens the steps.
  const ss = preview ? 4 : Math.max(1, Math.floor(opts.panSupersample ?? 1));
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

  // Lighten speed-up drops the clip to 1/speedup its length (framestep=speedup).
  let outputFrames = speedup ? Math.ceil(N / speedup) : N;
  const inputPattern = `${p.source.dir.replace(/\/$/, "")}/${p.source.glob}`;

  const codecArgs = preview
    ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
       "-r", String(p.output.fps)]
    : videoCodecArgs(p.output);

  // Fade in/out to black — applied as the very last filter on the output.
  const fade = p.post.fade;
  const fadeInF = fade ? Math.max(0, Math.round(fade.inSec * p.output.fps)) : 0;
  const fadeOutF = fade ? Math.max(0, Math.round(fade.outSec * p.output.fps)) : 0;
  const fadeSuffix = (frames: number): string => {
    const fs: string[] = [];
    if (fadeInF > 0) fs.push(`fade=t=in:s=0:n=${fadeInF}`);
    if (fadeOutF > 0 && frames > fadeOutF) {
      fs.push(`fade=t=out:s=${frames - fadeOutF}:n=${fadeOutF}`);
    }
    return fs.length ? `,${fs.join(",")}` : "";
  };

  let graphArgs: string[];
  let filtergraph: string;

  if (trail && windDown && decayNum < 1) {
    // COMET wind-down: a fading comet has a direction, and the reverse-erosion
    // trick flips that direction (visible swap). Instead, crossfade the comet
    // stream into the plain timelapse over a short window after `end`, so trails
    // dissolve away while the scene keeps playing live. No added frames; both
    // streams share crop("n") so they stay aligned and the pan tracks normally.
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
    filtergraph =
      `[0:v]${head}split=2[a][b];` +
      `[a]trim=end_frame=${start},setpts=PTS-STARTPTS[pre];` +
      `[b]trim=start_frame=${start},setpts=PTS-STARTPTS,lagfun=decay=${decay}[post];` +
      `[pre][post]concat=n=2:v=1,${windowCropScale("n")}[outv]`;
    graphArgs = ["-filter_complex", filtergraph, "-map", "[outv]", "-r", String(p.output.fps)];
  } else {
    const parts: string[] = [];
    if (deflicker) parts.push(deflicker); // exposure normalization, before any blend
    if (stack) parts.push(stack); // pre-crop temporal noise reduction
    // Lighten speed-up decimates here (pre-crop), so downstream the crop sees the
    // shortened stream: map output frame n back to source frame speedup*n so the
    // pan keeps tracking the same composition across the faster timeline.
    if (speedup) parts.push(lightenSpeedupFilter(speedup));
    if (denoise && trail) parts.push(denoise); // before lagfun
    if (trail) parts.push(`lagfun=decay=${decay}`);
    parts.push(windowCropScale(speedup ? `${speedup}*n` : "n"));
    if (denoise && !trail) parts.push(denoise); // after scale (cheaper)
    filtergraph = parts.join(",");
    // setpts retimes the decimated frames; -r locks the output to a constant rate
    // (preview already carries -r in its codec args).
    graphArgs = speedup && !preview
      ? ["-vf", filtergraph, "-r", String(p.output.fps)]
      : ["-vf", filtergraph];
  }

  // Append the output tail (color grade, deband, then fade) to the final output —
  // before the [outv] label for complex graphs. Grade first so the fade dips the
  // already-graded image to black; deband after grade so it smooths any banding
  // the grade's tone-stretching introduced, before compression bakes it in.
  const grade = p.post.color ? gradeFilter(p.post.color) : "";
  const deband = p.post.deband ? debandFilter(p.post.deband) : "";
  const tail =
    (grade ? `,${grade}` : "") +
    (deband ? `,${deband}` : "") +
    fadeSuffix(outputFrames);
  if (tail) {
    filtergraph =
      graphArgs[0] === "-filter_complex"
        ? filtergraph.replace(/\[outv\]$/, `${tail}[outv]`)
        : filtergraph + tail;
    graphArgs[1] = filtergraph;
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
