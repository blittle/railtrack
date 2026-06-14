/**
 * Keyframe interpolation: given the keyframes and a frame index, compute the
 * crop window at that frame. This is the single source of truth for both the
 * live canvas preview (UI) and the export geometry (buildFfmpeg).
 */

import type { Easing, Keyframe } from "./project";

export interface Window {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Map a normalized 0..1 progress through an easing curve. */
export function ease(t: number, kind: Easing): number {
  const u = Math.min(1, Math.max(0, t));
  switch (kind) {
    case "linear":
      return u;
    case "easeInOut":
      // smoothstep: flat at both ends, steep in the middle
      return u * u * (3 - 2 * u);
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * The crop window at an arbitrary (possibly fractional) frame index.
 * Holds the first keyframe's window before the first frame, and the last
 * keyframe's window after the last — no extrapolation past the ends.
 * `easing` belongs to the destination keyframe of each segment.
 */
export function windowAtFrame(keyframes: Keyframe[], frame: number): Window {
  if (keyframes.length === 0) {
    throw new Error("windowAtFrame: no keyframes");
  }
  const sorted = [...keyframes].sort((a, b) => a.frame - b.frame);

  const first = sorted[0];
  if (frame <= first.frame) {
    return { x: first.x, y: first.y, w: first.w, h: first.h };
  }
  const last = sorted[sorted.length - 1];
  if (frame >= last.frame) {
    return { x: last.x, y: last.y, w: last.w, h: last.h };
  }

  // find the segment [a, b] containing `frame`
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (frame >= a.frame && frame <= b.frame) {
      const span = b.frame - a.frame;
      const t = span === 0 ? 0 : ease((frame - a.frame) / span, b.easing);
      return {
        x: lerp(a.x, b.x, t),
        y: lerp(a.y, b.y, t),
        w: lerp(a.w, b.w, t),
        h: lerp(a.h, b.h, t),
      };
    }
  }
  // unreachable given the guards above
  return { x: last.x, y: last.y, w: last.w, h: last.h };
}

/** True if the window changes size across keyframes (i.e. an animated zoom). */
export function hasZoom(keyframes: Keyframe[]): boolean {
  if (keyframes.length < 2) return false;
  const { w, h } = keyframes[0];
  return keyframes.some((k) => k.w !== w || k.h !== h);
}
