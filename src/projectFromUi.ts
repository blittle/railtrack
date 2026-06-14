/**
 * Translate the simple Phase-2 UI controls into a full TimelapseProject.
 * This is the "easy mode" that builds a 2-keyframe horizontal pan, mirroring
 * make_timelapse.sh. The richer keyframe editor (Phase 4) will replace this
 * with arbitrary keyframes, but it produces the same project shape.
 */
import type {
  Codec,
  DenoiseSettings,
  StarTrailSettings,
  TimelapseProject,
} from "./engine/project";

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
  outputPath: string;

  pan: number; // horizontal pan, px
  panReverse?: boolean; // pan right-to-left instead of left-to-right
  yFrac: number; // vertical window position, 0 (top) .. 1 (bottom)
  denoise?: DenoiseSettings;
  starTrail?: StarTrailSettings;
  /** When trails begin, as a fraction of the timeline (0 = from start). */
  trailStartFrac?: number;
  /** When trails stop growing & retract, as a fraction (1 = run to the end). */
  trailEndFrac?: number;
}

function evenFloor(v: number): number {
  const n = Math.floor(v);
  return n - (n % 2);
}

export function projectFromUi(s: UiSettings): TimelapseProject {
  // Widest window matching the output aspect ratio that still leaves `pan` px
  // of horizontal travel, clamped to the source height.
  const cropW = evenFloor(s.srcW - s.pan);
  let cropH = evenFloor((cropW * s.outH) / s.outW);
  if (cropH > s.srcH) cropH = evenFloor(s.srcH);

  const yMax = s.srcH - cropH;
  const y = Math.round(Math.min(1, Math.max(0, s.yFrac)) * yMax);

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
      scaleFlags: "lanczos",
    },
    keyframes: [
      { frame: 0, x: s.panReverse ? s.pan : 0, y, w: cropW, h: cropH, easing: "linear" },
      { frame: lastFrame, x: s.panReverse ? 0 : s.pan, y, w: cropW, h: cropH, easing: "linear" },
    ],
    post: {
      ...(s.denoise ? { denoise: s.denoise } : {}),
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
    },
  };
}
