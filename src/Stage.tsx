import { useEffect, useMemo, useRef, useState } from "react";
import { framePreview } from "./backend";
import { gradeFilter } from "./engine/buildFfmpeg";
import { windowAtFrame } from "./engine/interpolate";
import type { Rect } from "./cropMath";

const PROXY_W = 1600; // downscaled full frame fetched for the stage background

interface Props {
  ffmpegPath: string;
  ready: boolean;
  sourceDir: string; // effective dir (proxy cache when ready)
  frameCount: number;
  srcW: number;
  srcH: number;
  startWin: Rect;
  endWin: Rect;
  playhead: number; // 0..1
  /** Color grade filter settings for the ffmpeg-rendered preview frame. */
  grade: {
    exposure: number;
    brightness: number;
    contrast: number;
    highlights: number;
    shadows: number;
    warmth: number;
    tint: number;
    vibrance: number;
    saturation: number;
  };
  /** Called while dragging a crop box; gives the new top-left in source px. */
  onDragWindow: (which: "start" | "end", x: number, y: number) => void;
  /** Called while dragging a corner handle; gives the new window width in source px. */
  onResizeWindow: (which: "start" | "end", widthSrc: number) => void;
}

const CORNER = 8; // corner handle size in buffer px

function drawBox(
  ctx: CanvasRenderingContext2D,
  r: Rect,
  color: string,
  label: string,
  dashed = false,
) {
  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  if (dashed) ctx.setLineDash([6, 4]);
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.setLineDash([]);
  // corner resize handles (filled squares centered on each corner)
  ctx.fillStyle = color;
  for (const [hx, hy] of [
    [r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h],
  ]) {
    ctx.fillRect(hx - CORNER / 2, hy - CORNER / 2, CORNER, CORNER);
  }
  ctx.font = "600 12px system-ui, sans-serif";
  const tw = ctx.measureText(label).width;
  const ly = Math.max(0, r.y - 17);
  ctx.fillStyle = color;
  ctx.fillRect(r.x, ly, tw + 12, 17);
  ctx.fillStyle = "#0b0d12";
  ctx.fillText(label, r.x + 6, ly + 12);
  ctx.restore();
}

/**
 * Shows the full uncropped frame with the Start and End crop windows overlaid
 * (draggable), plus a dimmed "current view" that interpolates with the playhead.
 */
export default function Stage({
  ffmpegPath, ready, sourceDir, frameCount, srcW, srcH, startWin, endWin, playhead, grade, onDragWindow, onResizeWindow,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cache = useRef(new Map<string, HTMLImageElement>());
  const reqId = useRef(0);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const index = Math.round(playhead * Math.max(0, frameCount - 1));
  const disabled = !ready || frameCount === 0 || srcW === 0;
  const { exposure, brightness, contrast, highlights, shadows, warmth, tint, vibrance, saturation } = grade;

  // canvas buffer at SOURCE aspect (the stage always shows the full frame)
  const bufW = 1400;
  const bufH = srcW ? Math.max(1, Math.round((bufW * srcH) / srcW)) : Math.round((bufW * 9) / 16);
  const scale = srcW ? bufW / srcW : 1; // source px -> buffer px
  const previewFilter = useMemo(() => gradeFilter({
    exposure,
    brightness,
    contrast,
    highlights,
    shadows,
    temperature: Math.round(6500 - warmth * 30),
    tint,
    vibrance,
    saturation,
  }), [exposure, brightness, contrast, highlights, shadows, warmth, tint, vibrance, saturation]);

  // reset cache when the source changes (e.g. proxy becomes available)
  useEffect(() => {
    cache.current.clear();
  }, [sourceDir]);

  // fetch the frame for the current index (debounced + cached); during play the
  // constantly-changing index keeps the debounce from firing, so the image
  // holds while only the window overlay animates.
  useEffect(() => {
    if (disabled) return;
    const cacheKey = `${index}:${previewFilter}`;
    const cached = cache.current.get(cacheKey);
    if (cached) {
      setImg(cached);
      return;
    }
    const my = ++reqId.current;
    setLoading(true);
    const handle = setTimeout(async () => {
      try {
        const url = await framePreview(ffmpegPath, sourceDir, index, PROXY_W, previewFilter);
        const image = new Image();
        image.onload = () => {
          cache.current.set(cacheKey, image);
          if (my === reqId.current) {
            setImg(image);
            setLoading(false);
          }
        };
        image.src = url;
      } catch (e) {
        if (my === reqId.current) {
          setErr(String(e));
          setLoading(false);
        }
      }
    }, 150);
    return () => clearTimeout(handle);
  }, [disabled, index, sourceDir, ffmpegPath, previewFilter]);

  const cur = useMemo(() => {
    if (disabled) return null;
    const last = Math.max(1, frameCount - 1);
    return windowAtFrame(
      [
        { frame: 0, ...startWin, easing: "linear" },
        { frame: last, ...endWin, easing: "linear" },
      ],
      index,
    );
  }, [disabled, startWin, endWin, frameCount, index]);

  // draw
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#0a0b0e";
    ctx.fillRect(0, 0, c.width, c.height);
    if (img) {
      ctx.drawImage(img, 0, 0, c.width, c.height);
    }
    if (disabled || !cur) return;

    const S = (r: Rect): Rect => ({ x: r.x * scale, y: r.y * scale, w: r.w * scale, h: r.h * scale });
    const a = S(startWin);
    const b = S(endWin);
    const cw = S(cur);

    // dim everything outside the current view
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.beginPath();
    ctx.rect(0, 0, c.width, c.height);
    ctx.rect(cw.x, cw.y, cw.w, cw.h);
    ctx.fill("evenodd");
    ctx.restore();

    // pan path (start center -> end center)
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.4)";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(a.x + a.w / 2, a.y + a.h / 2);
    ctx.lineTo(b.x + b.w / 2, b.y + b.h / 2);
    ctx.stroke();
    ctx.restore();

    drawBox(ctx, a, "#4f8cff", "Start");
    drawBox(ctx, b, "#e0a23b", "End", true);

    // current view outline
    ctx.save();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.strokeRect(cw.x + 1, cw.y + 1, cw.w - 2, cw.h - 2);
    ctx.restore();
  }, [img, cur, startWin, endWin, scale, disabled, bufW, bufH,
      exposure, brightness, contrast, highlights, shadows, warmth, tint, vibrance, saturation]);

  // dragging (move a box) or resizing (drag a corner handle)
  const drag = useRef<
    | { mode: "move"; which: "start" | "end"; offX: number; offY: number }
    | { mode: "resize"; which: "start" | "end" }
    | null
  >(null);
  const [overCorner, setOverCorner] = useState(false);
  function toSource(e: React.PointerEvent): { sx: number; sy: number } {
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect();
    return {
      sx: ((e.clientX - rect.left) / rect.width) * srcW,
      sy: ((e.clientY - rect.top) / rect.height) * srcH,
    };
  }
  // Corner hit-test threshold in source px (matches the on-screen handle size).
  const cornerThr = () => (srcW && bufW ? (CORNER * srcW) / bufW : 0);
  function nearestCorner(sx: number, sy: number): "start" | "end" | null {
    const thr = cornerThr();
    let best: { which: "start" | "end"; d: number } | null = null;
    for (const [which, r] of [["start", startWin], ["end", endWin]] as const) {
      for (const [hx, hy] of [
        [r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h],
      ]) {
        const d = Math.hypot(sx - hx, sy - hy);
        if (d <= thr && (!best || d < best.d)) best = { which, d };
      }
    }
    return best?.which ?? null;
  }
  function onDown(e: React.PointerEvent) {
    if (disabled) return;
    const { sx, sy } = toSource(e);
    // Corner handle → resize that box (takes priority over a move).
    const corner = nearestCorner(sx, sy);
    if (corner) {
      drag.current = { mode: "resize", which: corner };
      canvasRef.current!.setPointerCapture(e.pointerId);
      return;
    }
    const inside = (r: Rect) => sx >= r.x && sx <= r.x + r.w && sy >= r.y && sy <= r.y + r.h;
    const inA = inside(startWin);
    const inB = inside(endWin);
    let which: "start" | "end" | null = null;
    if (inA && inB) {
      const dA = Math.hypot(sx - (startWin.x + startWin.w / 2), sy - (startWin.y + startWin.h / 2));
      const dB = Math.hypot(sx - (endWin.x + endWin.w / 2), sy - (endWin.y + endWin.h / 2));
      which = dB <= dA ? "end" : "start";
    } else if (inB) which = "end";
    else if (inA) which = "start";
    if (!which) return;
    const r = which === "start" ? startWin : endWin;
    drag.current = { mode: "move", which, offX: sx - r.x, offY: sy - r.y };
    canvasRef.current!.setPointerCapture(e.pointerId);
  }
  function onMove(e: React.PointerEvent) {
    const { sx, sy } = toSource(e);
    if (!drag.current) {
      if (!disabled) setOverCorner(nearestCorner(sx, sy) !== null);
      return;
    }
    if (drag.current.mode === "resize") {
      const r = drag.current.which === "start" ? startWin : endWin;
      const cx = r.x + r.w / 2;
      // Resize symmetrically around the center; aspect stays locked in App.
      const newW = Math.max(2, 2 * Math.abs(sx - cx));
      onResizeWindow(drag.current.which, newW);
    } else {
      onDragWindow(drag.current.which, sx - drag.current.offX, sy - drag.current.offY);
    }
  }
  function onUp(e: React.PointerEvent) {
    drag.current = null;
    try {
      canvasRef.current!.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="stageArea">
      <canvas
        ref={canvasRef}
        className="stageCanvas"
        width={bufW}
        height={bufH}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        style={{ cursor: disabled ? "default" : overCorner ? "nwse-resize" : "grab" }}
      />
      {disabled && <div className="previewHint">load a source folder to start</div>}
      {loading && !disabled && <div className="previewHint stageLoading">rendering frame…</div>}
      {err && <pre className="error">{err}</pre>}
    </div>
  );
}
