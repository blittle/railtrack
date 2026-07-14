/**
 * Core data model for a timelapse project.
 *
 * A project is a fully self-describing, serializable spec: given the source
 * frames + this object, the engine deterministically produces an ffmpeg
 * invocation. The GUI edits this object; the engine consumes it. It is also
 * the on-disk save format and what a future headless CLI would load.
 */

export type Easing = "linear" | "easeInOut";

/**
 * A keyframe pins the crop window to a rectangle at a specific source-frame
 * index. The window is in SOURCE pixel coordinates (the full 42MP frame).
 * Between keyframes the engine interpolates x/y/w/h; `easing` controls how the
 * approach to THIS keyframe is shaped.
 */
export interface Keyframe {
  frame: number; // 0-based index into the sorted source frames
  x: number; // left edge of window, source px
  y: number; // top edge of window, source px
  w: number; // window width, source px
  h: number; // window height, source px
  easing: Easing;
}

export type Codec = "h264" | "h265" | "prores";

/** The VideoToolbox (Apple Silicon hardware) encoder each codec maps to. */
export const VIDEOTOOLBOX_ENCODER: Record<Codec, string> = {
  h264: "h264_videotoolbox",
  h265: "hevc_videotoolbox",
  prores: "prores_videotoolbox",
};

export interface OutputSettings {
  w: number; // output width  (e.g. 3840)
  h: number; // output height (e.g. 2160)
  path: string; // destination file
  fps: number;
  codec: Codec;
  crf: number; // quality for x264/x265 (lower = better)
  /**
   * Encode on Apple Silicon's hardware media engine via VideoToolbox
   * (h264_videotoolbox / hevc_videotoolbox / prores_videotoolbox). Much faster,
   * but constant-quality is driven by -q:v rather than -crf (see buildFfmpeg).
   */
  hwAccel?: boolean;
  scaleFlags: "lanczos" | "bicubic" | "bilinear";
}

export type DenoiseFilter = "hqdn3d" | "fftdnoiz" | "nlmeans";

export interface DenoiseSettings {
  filter: DenoiseFilter;
  /** 0..1 user-facing strength; mapped to filter-specific params at build time. */
  strength: number;
}

/**
 * Deflicker: normalize each frame's luminance to a rolling average of its
 * neighbours, removing the exposure flicker common in intervalometer timelapses
 * (aperture/shutter variance, auto-exposure hunting). Runs first, on the raw
 * frames, before any blending. Orthogonal to noise/motion filters.
 */
export interface DeflickerSettings {
  /** Window size in frames to average brightness over (2..129). */
  size: number;
}

export type FrameStackMode = "median" | "mean";

/**
 * Temporal frame stacking for noise reduction: blend each output frame with a
 * small window of its neighbours. `median` (tmedian) rejects transient outliers
 * (satellites, planes, hot pixels); `mean` (weighted tmix) is a gentler average.
 * Runs pre-crop on the raw frames so the pan doesn't smear into ghosting.
 * NOTE: stacking trades against motion sharpness — a wider window reduces noise
 * more but softens/trails moving stars.
 */
export interface FrameStackSettings {
  /** Window size in frames (2..15). Odd values give a symmetric-ish window. */
  frames: number;
  mode: FrameStackMode;
}

/**
 * "Lighten speed-up": combine each non-overlapping group of `factor` consecutive
 * frames with a lighten (max) blend and drop the clip to 1/factor its length.
 * Moving bright elements (stars) fuse into connected trails; foreground motion
 * (leaves, etc.) melts together. Does nothing for noise (max, not average).
 * Runs pre-crop; mutually exclusive with [[StarTrailSettings]].
 */
export interface LightenSpeedupSettings {
  /** How many frames collapse into one (2 = half length, 4 = quarter). */
  factor: number;
}

export interface StarTrailSettings {
  /**
   * Per-frame persistence of the lighten (max) stack, 0..1.
   * 1.0 = permanent, ever-growing trails; < 1.0 = trails fade over time.
   */
  decay: number;
  /**
   * Frame index at which trails begin accumulating. Before this the clip plays
   * as a normal timelapse; at this frame the trails start forming. 0 = from the
   * start (default).
   */
  startFrame?: number;
  /**
   * Frame index at which trails stop growing and begin retracting (FIFO erosion)
   * back to points. Omitted / last frame = trails run to the end of the clip.
   */
  endFrame?: number;
}

/**
 * Deband: smooth the stepped banding that shows up in smooth gradients (night
 * skies especially), worsened by 8-bit output and lossy compression. Applied
 * late — after the color grade, which can introduce banding by stretching tones.
 */
export interface DebandSettings {
  /** 0..1 user-facing strength; mapped to deband's per-plane thresholds. */
  strength: number;
}

export interface FadeSettings {
  /** Fade in from black over this many seconds (0 = none). */
  inSec: number;
  /** Fade out to black over this many seconds at the end (0 = none). */
  outSec: number;
}

export interface ColorSettings {
  /** eq brightness/exposure offset, -1..1ish (0 = neutral). */
  exposure?: number;
  /** Slider offset mapped to ffmpeg eq gamma (0 = neutral). */
  brightness: number;
  /** eq contrast, 0..4ish (1 = neutral). */
  contrast: number;
  /** Shadows recovery/crush, -100..100 (0 = neutral). */
  shadows?: number;
  /** Highlights recovery/boost, -100..100 (0 = neutral). */
  highlights?: number;
  /** white balance in Kelvin (6500 = neutral; lower = warmer, higher = cooler). */
  temperature: number;
  /** Green/magenta tint, -100..100 (0 = neutral). */
  tint?: number;
  /** Selective saturation boost/cut, -1..1ish (0 = neutral). */
  vibrance?: number;
  /** eq saturation, 0..3ish (1 = neutral). */
  saturation?: number;
}

export interface PostSettings {
  /** Remove frame-to-frame exposure flicker (pre-crop, runs first). */
  deflicker?: DeflickerSettings;
  denoise?: DenoiseSettings;
  /** Temporal noise reduction by stacking neighbouring frames (pre-crop). */
  frameStack?: FrameStackSettings;
  /** Lighten-blend groups of frames and shorten the clip (pre-crop). */
  lightenSpeedup?: LightenSpeedupSettings;
  starTrail?: StarTrailSettings;
  fade?: FadeSettings;
  color?: ColorSettings;
  /** Smooth gradient banding (post-grade, pre-fade). */
  deband?: DebandSettings;
}

export interface SourceInfo {
  dir: string;
  /** Glob or explicit ordering hint; the runner expands/sorts these. */
  glob: string; // e.g. "*.jpg"
  frameCount: number;
  width: number; // source frame width  (e.g. 7952)
  height: number; // source frame height (e.g. 5304)
}

export interface TimelapseProject {
  version: 1;
  source: SourceInfo;
  output: OutputSettings;
  /** At least 2 keyframes, sorted ascending by `frame`. */
  keyframes: Keyframe[];
  post: PostSettings;
}

/** Output aspect ratio as a single number, e.g. 3840/2160 = 1.777… */
export function outputAspect(p: TimelapseProject): number {
  return p.output.w / p.output.h;
}
