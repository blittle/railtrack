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
 * Build a piecewise expression in the crop variable `n` (frame index) for one
 * window property (x or y) across the keyframe segments. Holds the endpoints
 * outside the keyframed range. Easing belongs to each segment's destination kf.
 */
function buildExpr(keyframes: Keyframe[], pick: (k: Keyframe) => number): string {
  const k = [...keyframes].sort((a, b) => a.frame - b.frame);
  const last = k[k.length - 1];

  // default (n >= last frame): hold the last value
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
      const u = `(n-${num(a.frame)})/${num(span)}`; // normalized progress 0..1
      let t: string;
      if (b.easing === "easeInOut") {
        // smoothstep: u*u*(3-2*u)
        t = `(${u})*(${u})*(3-2*(${u}))`;
      } else {
        t = `(${u})`;
      }
      seg = `${num(va)}+(${num(vb - va)})*${t}`;
    }

    // apply this segment when n < b.frame (earlier guards handle n < a.frame)
    expr = `if(lt(n,${num(b.frame)}),${seg},${expr})`;
  }

  // before the first keyframe: hold the first value
  const first = k[0];
  expr = `if(lt(n,${num(first.frame)}),${num(pick(first))},${expr})`;
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
  // Commas inside an expression must be escaped, otherwise ffmpeg's filtergraph
  // parser reads them as filter-chain separators (e.g. "if(lt(n,0),0,..." breaks).
  const xExpr = escapeExpr(buildExpr(p.keyframes, (k) => k.x));
  const yExpr = escapeExpr(buildExpr(p.keyframes, (k) => k.y));

  // Output resolution: full for a real render, low-res for a preview.
  const ow = preview ? evenFloor(preview.width) : evenFloor(p.output.w);
  const oh = preview
    ? evenFloor((ow * p.output.h) / p.output.w)
    : evenFloor(p.output.h);

  const trail = p.post.starTrail;
  const parts: string[] = [];

  // Pre-crop, full-frame stage. With star trails we must accumulate (lagfun)
  // BEFORE cropping so trails form in fixed sensor space and the pan windows
  // into the result. Denoise also goes here when trailing, so noise isn't
  // baked into the trails as permanent speckle. (Preview skips denoise for speed.)
  if (!preview && trail && p.post.denoise) parts.push(denoiseFilter(p.post.denoise));
  if (trail) {
    const decay = Math.min(1, Math.max(0, trail.decay));
    let lagfun = `lagfun=decay=${num(decay)}`;
    // Optional delay: trails only start accumulating at `startFrame`. Before
    // that the filter is disabled (frames pass through), so it plays as a normal
    // timelapse, then trails suddenly begin forming. (comma escaped for parser)
    const start = Math.max(0, Math.floor(trail.startFrame ?? 0));
    if (start > 0) lagfun += `:enable=gte(n\\,${start})`;
    parts.push(lagfun);
  }

  parts.push(`crop=${cw}:${ch}:${xExpr}:${yExpr}`);
  parts.push(`scale=${ow}:${oh}:flags=${preview ? "lanczos" : p.output.scaleFlags}`);

  // Without star trails, denoise the smaller scaled output (cheaper). Preview skips it.
  if (!preview && !trail && p.post.denoise) parts.push(denoiseFilter(p.post.denoise));

  const outputFrames = p.source.frameCount;
  const filtergraph = parts.join(",");
  const inputPattern = `${p.source.dir.replace(/\/$/, "")}/${p.source.glob}`;

  const codecArgs = preview
    ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
       "-r", String(p.output.fps)]
    : videoCodecArgs(p.output);

  const args = [
    "-y",
    "-framerate", String(p.output.fps),
    "-pattern_type", "glob",
    "-i", inputPattern,
    "-vf", filtergraph,
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
