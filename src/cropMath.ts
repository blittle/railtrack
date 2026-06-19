/**
 * Crop-window geometry for the visual editor. A window is a rectangle (output
 * aspect) inside the source frame. The two keyframe windows share one size
 * (`zoom` × the largest fitting rect) so there's never an animated zoom; only
 * their positions differ, which is the pan.
 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const even = (v: number) => {
  const n = Math.floor(v);
  return n - (n % 2);
};
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Largest rect of the given aspect (w/h) that fits inside the source, even dims. */
export function maxFitSize(srcW: number, srcH: number, aspect: number): { w: number; h: number } {
  if (srcW <= 0 || srcH <= 0 || aspect <= 0) return { w: 0, h: 0 };
  let w = srcW;
  let h = w / aspect;
  if (h > srcH) {
    h = srcH;
    w = h * aspect;
  }
  return { w: even(w), h: even(h) };
}

/**
 * The window rect for a fractional center (0..1 of the source) at a zoom level
 * (0..1 fraction of the max-fit size), clamped so it stays inside the source.
 */
export function windowRect(
  srcW: number,
  srcH: number,
  aspect: number,
  zoom: number,
  cx: number,
  cy: number,
): Rect {
  const max = maxFitSize(srcW, srcH, aspect);
  const z = clamp(zoom, 0.1, 1);
  const w = Math.max(2, even(max.w * z));
  const h = Math.max(2, even(max.h * z));
  const x = even(clamp(cx * srcW - w / 2, 0, Math.max(0, srcW - w)));
  const y = even(clamp(cy * srcH - h / 2, 0, Math.max(0, srcH - h)));
  return { x, y, w, h };
}

/** Convert a (possibly out-of-bounds) top-left position to a clamped fractional center. */
export function centerFromXY(
  x: number,
  y: number,
  w: number,
  h: number,
  srcW: number,
  srcH: number,
): { cx: number; cy: number } {
  const cx = (clamp(x, 0, Math.max(0, srcW - w)) + w / 2) / srcW;
  const cy = (clamp(y, 0, Math.max(0, srcH - h)) + h / 2) / srcH;
  return { cx, cy };
}
