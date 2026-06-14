import { useEffect, useMemo, useRef, useState } from "react";
import { framePreview } from "./backend";
import { windowAtFrame } from "./engine/interpolate";
import type { Keyframe } from "./engine/project";

const PROXY_W = 1920; // downscaled source width fetched for the preview

interface Props {
  ffmpegPath: string;
  ready: boolean;
  sourceDir: string;
  frameCount: number;
  srcW: number;
  srcH: number;
  keyframes: Keyframe[];
  outAspect: number;
}

/**
 * Timeline scrubber + canvas showing the actual windowed output at any frame.
 * Scrubbing start->end reveals both the scene change and the pan/window move.
 * The canvas fills the available width; source proxy frames are fetched on
 * demand (debounced) and cached by index.
 */
export default function Preview({
  ffmpegPath, ready, sourceDir, frameCount, srcW, srcH, keyframes, outAspect,
}: Props) {
  const [t, setT] = useState(0); // 0..1 timeline position
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cache = useRef(new Map<number, HTMLImageElement>());
  const reqId = useRef(0);

  const index = Math.round(t * Math.max(0, frameCount - 1));

  // Measure the container so the canvas buffer matches its on-screen size.
  const [boxW, setBoxW] = useState(0);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setBoxW(el.clientWidth);
    const ro = new ResizeObserver((entries) => setBoxW(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const dpr = window.devicePixelRatio || 1;
  const bufW = Math.max(1, Math.round(boxW * dpr));
  const bufH = Math.max(1, Math.round((boxW / outAspect) * dpr));

  // The currently-loaded proxy image (kept in state so draws re-run).
  const [img, setImg] = useState<HTMLImageElement | null>(null);

  // Fetch (debounced) the proxy for the scrubbed frame index.
  useEffect(() => {
    if (!ready || !sourceDir || frameCount === 0) return;
    const cached = cache.current.get(index);
    if (cached) {
      setImg(cached);
      return;
    }
    const my = ++reqId.current;
    setLoading(true);
    const handle = setTimeout(async () => {
      try {
        const dataUrl = await framePreview(ffmpegPath, sourceDir, index, PROXY_W);
        const image = new Image();
        image.onload = () => {
          cache.current.set(index, image);
          if (my === reqId.current) {
            setImg(image);
            setLoading(false);
          }
        };
        image.src = dataUrl;
      } catch (e) {
        if (my === reqId.current) {
          setErr(String(e));
          setLoading(false);
        }
      }
    }, 120);
    return () => clearTimeout(handle);
  }, [ready, sourceDir, frameCount, index, ffmpegPath]);

  const win = useMemo(
    () => (keyframes.length >= 2 ? windowAtFrame(keyframes, index) : null),
    [keyframes, index],
  );

  // Reset the cache when the source changes (e.g. proxy becomes available).
  useEffect(() => {
    cache.current.clear();
  }, [sourceDir]);

  // Draw the windowed crop region from the proxy into the canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!img || !win || srcW === 0) return;

    const scale = img.naturalWidth / srcW; // proxy px per source px
    ctx.drawImage(
      img,
      win.x * scale, win.y * scale, win.w * scale, win.h * scale,
      0, 0, canvas.width, canvas.height,
    );
  }, [img, win, srcW, bufW, bufH]);

  const disabled = !ready || frameCount === 0;

  return (
    <div>
      <div className="previewWrap" ref={wrapRef} style={{ aspectRatio: String(outAspect) }}>
        <canvas ref={canvasRef} width={bufW} height={bufH} />
        {disabled && <div className="previewHint">load a source folder to preview</div>}
        {loading && !disabled && <div className="previewHint">rendering frame…</div>}
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        <button onClick={() => setT(0)} disabled={disabled}>⏮ Start</button>
        <input
          type="range" min={0} max={1} step={0.001} value={t}
          disabled={disabled}
          onChange={(e) => setT(+e.target.value)}
          className="grow"
        />
        <button onClick={() => setT(1)} disabled={disabled}>End ⏭</button>
      </div>
      <p className="muted">
        frame {index + 1}/{frameCount || 0}
        {win ? ` · window x ${Math.round(win.x)} → ${Math.round(win.x + win.w)}` : ""}
      </p>
      {err && <pre className="error">{err}</pre>}
    </div>
  );
}
