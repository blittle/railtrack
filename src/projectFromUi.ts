/**
 * Assemble a full TimelapseProject from the UI state. The crop windows come from
 * the visual editor (the Stage) as ready-made keyframes; this just packages the
 * source/output/post-processing settings around them.
 */
import type {
  Codec,
  ColorSettings,
  DebandSettings,
  DeflickerSettings,
  DenoiseSettings,
  FrameStackSettings,
  Keyframe,
  LightenSpeedupSettings,
  StarTrailSettings,
  TimelapseProject,
} from "./engine/project";

/** UI form of the speed ramp: peak multiplier + the two marker positions (0..1). */
export interface SpeedRampUi {
  peak: number;
  upFrac: number;
  downFrac: number;
  /** Easing smoothness of the ramps: 0 = linear, 1 = full smoothstep. */
  ease: number;
}

export interface UiSettings {
  sourceDir: string;
  glob: string;
  frameCount: number;
  srcW: number;
  srcH: number;

  outW: number;
  outH: number;
  fps: number;
  codec: Codec;
  crf: number;
  /** Encode via Apple Silicon VideoToolbox (hardware) instead of the software encoder. */
  hwAccel: boolean;
  outputPath: string;

  /** The two crop windows (start & end), in source pixels, from the editor. */
  keyframes: Keyframe[];

  deflicker?: DeflickerSettings;
  denoise?: DenoiseSettings;
  frameStack?: FrameStackSettings;
  lightenSpeedup?: LightenSpeedupSettings;
  /** Ease-in / hold / ease-out speed ramp (preset form). */
  speedRamp?: SpeedRampUi;
  starTrail?: StarTrailSettings;
  /** When trails begin, as a fraction of the timeline (0 = from start). */
  trailStartFrac?: number;
  /** When trails stop growing & retract, as a fraction (1 = run to the end). */
  trailEndFrac?: number;
  /** Fade from/to black, in seconds (0 = none). */
  fadeInSec?: number;
  fadeOutSec?: number;
  /** Color grade (tone + color controls). */
  color?: ColorSettings;
  /** Gradient debanding (post-grade). */
  deband?: DebandSettings;
}

/**
 * Turn the ease-in / hold / ease-out preset into speed keyframes: 1× at both
 * ends, easing up to `peak` over [start, upFrame] and back down over
 * [downFrame, end], holding `peak` in between.
 */
function speedRampKeyframes(r: SpeedRampUi, lastFrame: number) {
  const up = Math.round(Math.min(1, Math.max(0, r.upFrac)) * lastFrame);
  const down = Math.round(Math.min(1, Math.max(0, r.downFrac)) * lastFrame);
  const peak = Math.max(1, r.peak);
  const ease = Math.min(1, Math.max(0, r.ease));
  return {
    keyframes: [
      { frame: 0, speed: 1, easing: "linear" as const },
      { frame: up, speed: peak, easing: "easeInOut" as const, easeAmount: ease },
      { frame: Math.max(up, down), speed: peak, easing: "linear" as const },
      { frame: lastFrame, speed: 1, easing: "easeInOut" as const, easeAmount: ease },
    ],
  };
}

function neutralColor(c?: ColorSettings): boolean {
  return !c || (
    (c.exposure ?? 0) === 0 &&
    c.brightness === 0 &&
    c.contrast === 1 &&
    (c.shadows ?? 0) === 0 &&
    (c.highlights ?? 0) === 0 &&
    c.temperature === 6500 &&
    (c.tint ?? 0) === 0 &&
    (c.vibrance ?? 0) === 0 &&
    (c.saturation ?? 1) === 1
  );
}

export function projectFromUi(s: UiSettings): TimelapseProject {
  const lastFrame = Math.max(1, s.frameCount - 1);

  return {
    version: 1,
    source: {
      dir: s.sourceDir,
      glob: s.glob,
      frameCount: s.frameCount,
      width: s.srcW,
      height: s.srcH,
    },
    output: {
      w: s.outW,
      h: s.outH,
      path: s.outputPath,
      fps: s.fps,
      codec: s.codec,
      crf: s.crf,
      hwAccel: s.hwAccel,
      scaleFlags: "lanczos",
    },
    keyframes: s.keyframes,
    post: {
      ...(s.deflicker ? { deflicker: s.deflicker } : {}),
      ...(s.denoise ? { denoise: s.denoise } : {}),
      ...(s.frameStack ? { frameStack: s.frameStack } : {}),
      ...(s.lightenSpeedup ? { lightenSpeedup: s.lightenSpeedup } : {}),
      ...(s.speedRamp ? { speedRamp: speedRampKeyframes(s.speedRamp, lastFrame) } : {}),
      ...(s.starTrail
        ? {
            starTrail: {
              ...s.starTrail,
              startFrame: Math.round(
                Math.min(1, Math.max(0, s.trailStartFrac ?? 0)) * lastFrame,
              ),
              endFrame: Math.round(
                Math.min(1, Math.max(0, s.trailEndFrac ?? 1)) * lastFrame,
              ),
            },
          }
        : {}),
      ...((s.fadeInSec ?? 0) > 0 || (s.fadeOutSec ?? 0) > 0
        ? { fade: { inSec: s.fadeInSec ?? 0, outSec: s.fadeOutSec ?? 0 } }
        : {}),
      ...(neutralColor(s.color) ? {} : { color: s.color }),
      ...(s.deband ? { deband: s.deband } : {}),
    },
  };
}
