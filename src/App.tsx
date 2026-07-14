import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { tempDir, join } from "@tauri-apps/api/path";
import {
  cacheSize,
  cancelFfmpeg,
  clearAllProxies,
  clearProxies,
  detectFfmpeg,
  detectFfprobe,
  onProgress,
  openFile,
  pickDirectory,
  pickFile,
  pickSavePath,
  prepareProxyDir,
  probeDir,
  runFfmpeg,
  validateFfmpeg,
  videotoolboxEncoders,
  type Progress,
} from "./backend";
import { projectFromUi } from "./projectFromUi";
import { brightnessToGamma, buildFfmpeg, buildProxyCommand } from "./engine/buildFfmpeg";
import { VIDEOTOOLBOX_ENCODER } from "./engine/project";
import type { Codec, DenoiseFilter, FrameStackMode, Keyframe, TimelapseProject } from "./engine/project";
import { windowRect, centerFromXY, maxFitSize } from "./cropMath";
import Stage from "./Stage";
import Timeline from "./Timeline";
import "./App.css";

const SETTINGS_KEY = "timelapse-studio.settings";

const PREVIEW_RES: Record<string, number> = {
  "720p (1280px)": 1280,
  "1080p (1920px)": 1920,
  "1440p (2560px)": 2560,
};

function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function fmtBytes(b: number): string {
  if (b <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

/** Quote an ffmpeg argument for display as a copy-pasteable shell command. */
function shellQuote(s: string): string {
  return /[^A-Za-z0-9_\-./:=]/.test(s) ? `'${s.replace(/'/g, "'\\''")}'` : s;
}

const RES_PRESETS: Record<string, [number, number]> = {
  "4K (3840×2160)": [3840, 2160],
  "1440p (2560×1440)": [2560, 1440],
  "1080p (1920×1080)": [1920, 1080],
};

/** A collapsible accordion panel with an animated body. */
function Section({
  title, open, onToggle, children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);

  // After the expand animation settles, bring the section fully into view.
  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    if (!el) return;
    const t = setTimeout(
      () => el.scrollIntoView({ behavior: "smooth", block: "start" }),
      240,
    );
    return () => clearTimeout(t);
  }, [open]);

  return (
    <section ref={ref} className={`panel accordion${open ? " open" : ""}`}>
      <button className="accordionHeader" onClick={onToggle}>
        <span className="chev">▸</span>
        <span>{title}</span>
      </button>
      <div className="accordionBodyOuter">
        <div className="accordionBody">{children}</div>
      </div>
    </section>
  );
}

export default function App() {
  // ffmpeg (BYO) — persisted in settings
  const [ffmpegPath, setFfmpegPath] = useState("");
  const [ffprobePath, setFfprobePath] = useState("");
  const [ffmpegOk, setFfmpegOk] = useState(false);
  // Why validation failed (loader error, non-zero exit, …); shown in Settings.
  const [ffmpegErr, setFfmpegErr] = useState<string | null>(null);

  // settings
  const [proxyBaseDir, setProxyBaseDir] = useState(""); // "" = system temp
  const [previewW, setPreviewW] = useState(1920); // proxy/preview resolution
  const [rebuildEachSession, setRebuildEachSession] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [openSection, setOpenSection] = useState("source");
  const toggle = (id: string) => setOpenSection((cur) => (cur === id ? "" : id));
  const [cmdText, setCmdText] = useState<string | null>(null);

  function showCommand() {
    try {
      const { args } = buildFfmpeg(currentProject(outputPath || "output.mp4"), {
        panSupersample: panSmooth,
      });
      setCmdText([ffmpegPath || "ffmpeg", ...args].map(shellQuote).join(" "));
    } catch (e) {
      setCmdText(`# Could not build command:\n${String(e)}`);
    }
  }

  // source
  const [sourceDir, setSourceDir] = useState("");
  const [glob, setGlob] = useState("*.jpg");
  const [frameCount, setFrameCount] = useState(0);
  const [srcW, setSrcW] = useState(0);
  const [srcH, setSrcH] = useState(0);

  // proxy cache status (runtime)
  const [proxyDir, setProxyDir] = useState("");
  const [proxyCount, setProxyCount] = useState(0);
  const [cacheBytes, setCacheBytes] = useState<number | null>(null);

  // output
  const [resKey, setResKey] = useState("4K (3840×2160)");
  const [vertical, setVertical] = useState(false);
  const [fps, setFps] = useState(30);
  const [codec, setCodec] = useState<Codec>("h264");
  const [hwAccel, setHwAccel] = useState(false);
  // VideoToolbox encoders the resolved ffmpeg build actually supports.
  const [vtEncoders, setVtEncoders] = useState<string[]>([]);
  const [crf, setCrf] = useState(18);
  const [outputPath, setOutputPath] = useState("");

  // crop windows (the visual editor) — two keyframes' worth of framing.
  // zoom = window size as a fraction of the max-fit; centers are 0..1 of source.
  // Per-box zoom lets the Start/End windows differ in size (an animated zoom);
  // the Zoom slider sets both at once, corner handles resize one independently.
  const [startZoom, setStartZoom] = useState(0.85);
  const [endZoom, setEndZoom] = useState(0.85);
  const [startC, setStartC] = useState({ cx: 0.45, cy: 0.5 });
  const [endC, setEndC] = useState({ cx: 0.55, cy: 0.5 });
  const [playhead, setPlayhead] = useState(0); // 0..1 timeline position
  const [playing, setPlaying] = useState(false);

  // post
  // Deflicker (exposure flicker removal)
  const [deflickerOn, setDeflickerOn] = useState(false);
  const [deflickerSize, setDeflickerSize] = useState(7);
  const [denoiseOn, setDenoiseOn] = useState(false);
  const [denoiseFilterName, setDenoiseFilterName] = useState<DenoiseFilter>("hqdn3d");
  const [denoiseStrength, setDenoiseStrength] = useState(0.5);
  // Temporal frame stacking (cross-frame noise reduction)
  const [frameStackOn, setFrameStackOn] = useState(false);
  const [frameStackMode, setFrameStackMode] = useState<FrameStackMode>("median");
  const [frameStackFrames, setFrameStackFrames] = useState(3);
  // Lighten speed-up (blend groups of frames, shorten the clip)
  const [speedupOn, setSpeedupOn] = useState(false);
  const [speedFactor, setSpeedFactor] = useState(2);
  // Speed ramp (ease-in / hold / ease-out over the timeline)
  const [speedRampOn, setSpeedRampOn] = useState(false);
  const [speedPeak, setSpeedPeak] = useState(4); // peak playback multiplier
  const [rampUpFrac, setRampUpFrac] = useState(0.3);   // reach peak by here
  const [rampDownFrac, setRampDownFrac] = useState(0.7); // leave peak here
  const [rampEase, setRampEase] = useState(1); // 0 = linear, 1 = full smoothstep
  // Deband (smooth gradient banding)
  const [debandOn, setDebandOn] = useState(false);
  const [debandStrength, setDebandStrength] = useState(0.5);
  const [panSmooth, setPanSmooth] = useState(1); // export sub-pixel pan factor (1=off)
  const [fadeInSec, setFadeInSec] = useState(0);
  const [fadeOutSec, setFadeOutSec] = useState(0);
  // color grade
  const [exposure, setExposure] = useState(0);
  const [brightness, setBrightness] = useState(0); // -0.3..1 -> eq gamma 0.7..2
  const [contrast, setContrast] = useState(1); // 0.5..2 (eq)
  const [highlights, setHighlights] = useState(0);
  const [shadows, setShadows] = useState(0);
  const [warmth, setWarmth] = useState(0); // -100 cool .. +100 warm -> Kelvin
  const [tint, setTint] = useState(0);
  const [vibrance, setVibrance] = useState(0);
  const [saturation, setSaturation] = useState(1);
  const [starTrailOn, setStarTrailOn] = useState(false);
  const [trailDecay, setTrailDecay] = useState(0.99);
  const [trailStartFrac, setTrailStartFrac] = useState(0); // when trails begin
  const [trailEndFrac, setTrailEndFrac] = useState(1); // when trails retract (1 = end)

  // run state
  const [progress, setProgress] = useState<Progress | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  const [presetW, presetH] = RES_PRESETS[resKey];
  // Vertical/portrait output just swaps width & height.
  const outW = vertical ? presetH : presetW;
  const outH = vertical ? presetW : presetH;
  const proxyReady = frameCount > 0 && proxyCount >= frameCount;

  // The two crop windows (source px) derived from zoom + centers + output aspect.
  const outAspect = outW / outH;
  const startWin = useMemo(
    () => windowRect(srcW, srcH, outAspect, startZoom, startC.cx, startC.cy),
    [srcW, srcH, outAspect, startZoom, startC],
  );
  const endWin = useMemo(
    () => windowRect(srcW, srcH, outAspect, endZoom, endC.cx, endC.cy),
    [srcW, srcH, outAspect, endZoom, endC],
  );
  const keyframes = useMemo<Keyframe[]>(() => {
    if (!frameCount || !srcW) return [];
    const last = Math.max(1, frameCount - 1);
    return [
      { frame: 0, ...startWin, easing: "linear" },
      { frame: last, ...endWin, easing: "linear" },
    ];
  }, [frameCount, srcW, startWin, endWin]);

  // Dragging a crop box on the Stage updates that endpoint's fractional center.
  function handleDragWindow(which: "start" | "end", x: number, y: number) {
    const win = which === "start" ? startWin : endWin;
    const c = centerFromXY(x, y, win.w, win.h, srcW, srcH);
    if (which === "start") setStartC(c);
    else setEndC(c);
  }

  // Dragging a corner handle resizes that window (a new width in source px), which
  // maps back to a per-box zoom fraction. Differing sizes = an animated zoom.
  function handleResizeWindow(which: "start" | "end", widthSrc: number) {
    const max = maxFitSize(srcW, srcH, outAspect);
    if (max.w <= 0) return;
    const z = Math.max(0.1, Math.min(1, widthSrc / max.w));
    if (which === "start") setStartZoom(z);
    else setEndZoom(z);
  }

  // Animate the playhead when playing (sweeps the clip in ~6s, looping).
  useEffect(() => {
    if (!playing || !frameCount) return;
    let raf = 0;
    let last: number | null = null;
    const tick = (t: number) => {
      if (last != null) {
        const dt = (t - last) / 1000;
        setPlayhead((p) => {
          const np = p + dt / 6;
          return np >= 1 ? 0 : np;
        });
      }
      last = t;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, frameCount]);

  // Estimated time remaining from ffmpeg's reported encode fps.
  const eta =
    progress && !progress.done && progress.fps > 0
      ? (frameCount - progress.frame) / progress.fps
      : null;

  // Load persisted settings on launch, then fall back to auto-detect.
  useEffect(() => {
    (async () => {
      let s: Record<string, unknown> = {};
      try {
        s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      } catch {
        /* ignore corrupt settings */
      }
      if (typeof s.proxyBaseDir === "string") setProxyBaseDir(s.proxyBaseDir);
      if (typeof s.previewW === "number") setPreviewW(s.previewW);
      // Apple Silicon acceleration is a per-machine preference, not per-project —
      // persist it globally so it isn't reset every launch.
      if (typeof s.hwAccel === "boolean") setHwAccel(s.hwAccel);
      const rebuild = s.rebuildEachSession === true;
      if (rebuild) setRebuildEachSession(true);

      try {
        if (typeof s.ffmpegPath === "string" && s.ffmpegPath) {
          setFfmpegPath(s.ffmpegPath);
          await checkFfmpeg(s.ffmpegPath);
        } else {
          const fm = await detectFfmpeg();
          if (fm) { setFfmpegPath(fm); setFfmpegOk(true); setFfmpegErr(null); }
        }
        if (typeof s.ffprobePath === "string" && s.ffprobePath) {
          setFfprobePath(s.ffprobePath);
        } else {
          const fp = await detectFfprobe();
          if (fp) setFfprobePath(fp);
        }
        // "Rebuild each session" → wipe the whole cache at startup.
        if (rebuild) {
          await clearAllProxies(
            typeof s.proxyBaseDir === "string" ? s.proxyBaseDir : null,
          );
        }
      } catch (e) {
        console.warn("startup init unavailable:", e);
      }
      setSettingsLoaded(true);
    })();
  }, []);

  // Persist settings whenever they change (after the initial load).
  useEffect(() => {
    if (!settingsLoaded) return;
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ ffmpegPath, ffprobePath, proxyBaseDir, previewW, rebuildEachSession, hwAccel }),
    );
  }, [settingsLoaded, ffmpegPath, ffprobePath, proxyBaseDir, previewW, rebuildEachSession, hwAccel]);

  // Probe which VideoToolbox encoders the current ffmpeg supports (gates the
  // "Apple Silicon acceleration" checkbox). Re-runs whenever the binary changes.
  useEffect(() => {
    if (!ffmpegPath) { setVtEncoders([]); return; }
    let cancelled = false;
    videotoolboxEncoders(ffmpegPath)
      .then((e) => { if (!cancelled) setVtEncoders(e); })
      .catch(() => { if (!cancelled) setVtEncoders([]); });
    return () => { cancelled = true; };
  }, [ffmpegPath]);

  // subscribe to progress events
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onProgress((p) => {
      setProgress(p);
      if (p.done) setStatus("Finishing…");
    })
      .then((f) => (unlisten = f))
      .catch((e) => console.warn("progress listener unavailable:", e));
    return () => unlisten?.();
  }, []);

  async function refreshProxyStatus(dir = sourceDir) {
    if (!dir) { setProxyDir(""); setProxyCount(0); return; }
    try {
      const pd = await prepareProxyDir(dir, proxyBaseDir, previewW);
      setProxyDir(pd.dir);
      setProxyCount(pd.count);
    } catch (e) {
      console.warn("proxy status unavailable:", e);
    }
  }

  async function refreshCacheSize() {
    try {
      setCacheBytes(await cacheSize(proxyBaseDir));
    } catch (e) {
      console.warn("cache size unavailable:", e);
    }
  }

  // Refresh total cache size whenever the Settings modal opens.
  useEffect(() => {
    if (!showSettings) return;
    let cancelled = false;
    cacheSize(proxyBaseDir)
      .then((bytes) => {
        if (!cancelled) setCacheBytes(bytes);
      })
      .catch((e) => {
        console.warn("cache size unavailable:", e);
      });
    return () => {
      cancelled = true;
    };
  }, [showSettings, proxyBaseDir]);

  async function clearAllCaches() {
    setError("");
    try {
      await clearAllProxies(proxyBaseDir);
      await refreshProxyStatus();
      await refreshCacheSize();
      setStatus("All preview caches cleared");
    } catch (e) {
      setError(String(e));
    }
  }

  async function chooseSource() {
    const dir = await pickDirectory();
    if (!dir) return;
    setSourceDir(dir);
    setError("");
    try {
      const r = await probeDir(dir, ffprobePath || "ffprobe");
      setFrameCount(r.frame_count);
      setSrcW(r.width);
      setSrcH(r.height);
      setGlob(r.glob);
      // reset the editor framing for the new source
      setStartZoom(0.85);
      setEndZoom(0.85);
      setStartC({ cx: 0.45, cy: 0.5 });
      setEndC({ cx: 0.55, cy: 0.5 });
      setPlayhead(0);
      setPlaying(false);
      setStatus(`Found ${r.frame_count} frames at ${r.width}×${r.height}`);
      await refreshProxyStatus(dir);
    } catch (e) {
      setError(String(e));
    }
  }

  // Validate an ffmpeg path and record both the verdict and (on failure) why.
  async function checkFfmpeg(path: string) {
    const r = await validateFfmpeg(path);
    setFfmpegOk(r.ok);
    setFfmpegErr(r.ok ? null : r.detail);
  }

  async function chooseFfmpeg() {
    const f = await pickFile();
    if (!f) return;
    setFfmpegPath(f);
    await checkFfmpeg(f);
  }

  async function chooseFfprobe() {
    const f = await pickFile();
    if (f) setFfprobePath(f);
  }

  async function chooseProxyDir() {
    const d = await pickDirectory();
    if (d) {
      setProxyBaseDir(d);
      // cache location changed — re-check status against the new location
      setTimeout(refreshProxyStatus, 0);
    }
  }

  async function chooseOutput() {
    const p = await pickSavePath("timelapse.mp4");
    if (p) setOutputPath(p);
  }

  function currentProject(outPath: string): TimelapseProject {
    return projectFromUi({
      sourceDir, glob, frameCount, srcW, srcH,
      outW, outH, fps, codec, crf,
      hwAccel: hwAccel && vtEncoders.includes(VIDEOTOOLBOX_ENCODER[codec]),
      outputPath: outPath,
      keyframes,
      deflicker: deflickerOn ? { size: deflickerSize } : undefined,
      frameStack: frameStackOn
        ? { frames: frameStackFrames, mode: frameStackMode }
        : undefined,
      lightenSpeedup: speedupOn ? { factor: speedFactor } : undefined,
      speedRamp: speedRampOn
        ? { peak: speedPeak, upFrac: rampUpFrac, downFrac: rampDownFrac, ease: rampEase }
        : undefined,
      denoise: denoiseOn
        ? { filter: denoiseFilterName, strength: denoiseStrength }
        : undefined,
      starTrail: starTrailOn ? { decay: trailDecay } : undefined,
      trailStartFrac: starTrailOn ? trailStartFrac : undefined,
      trailEndFrac: starTrailOn ? trailEndFrac : undefined,
      fadeInSec,
      fadeOutSec,
      color: {
        exposure,
        brightness,
        contrast,
        highlights,
        shadows,
        temperature: Math.round(6500 - warmth * 30),
        tint,
        vibrance,
        saturation,
      },
      deband: debandOn ? { strength: debandStrength } : undefined,
    });
  }

  // Is any grade control off its neutral value? Drives the grade badge + reset.
  const gradeActive =
    exposure !== 0 || brightness !== 0 || contrast !== 1 || highlights !== 0 ||
    shadows !== 0 || warmth !== 0 || tint !== 0 || vibrance !== 0 || saturation !== 1;

  function resetGrade() {
    setExposure(0);
    setBrightness(0);
    setContrast(1);
    setHighlights(0);
    setShadows(0);
    setWarmth(0);
    setTint(0);
    setVibrance(0);
    setSaturation(1);
  }

  function precheck(): string | null {
    if (!ffmpegOk) return "ffmpeg not found — set its path in Settings.";
    if (!sourceDir || frameCount === 0) return "Pick a source folder of frames.";
    return null;
  }

  /** Ensure the proxy cache exists for the current source; returns the proxy dir. */
  async function ensureCache(): Promise<string> {
    const pd = await prepareProxyDir(sourceDir, proxyBaseDir, previewW);
    if (pd.count < frameCount) {
      setStatus(`Building preview cache (one-time, ${frameCount} frames)…`);
      await runFfmpeg(
        ffmpegPath,
        buildProxyCommand(sourceDir, glob, pd.dir, previewW),
        frameCount,
      );
    }
    return pd.dir;
  }

  async function generateCache() {
    setError("");
    const bad = precheck();
    if (bad) return setError(bad);
    setRunning(true);
    setProgress(null);
    try {
      await ensureCache();
      await refreshProxyStatus();
      await refreshCacheSize();
      setStatus("Preview cache ready ✓");
    } catch (e) {
      setError(String(e));
      setStatus("");
    } finally {
      setRunning(false);
    }
  }

  async function clearCache() {
    setError("");
    if (!sourceDir) return;
    try {
      await clearProxies(sourceDir, proxyBaseDir, previewW);
      await refreshProxyStatus();
      await refreshCacheSize();
      setStatus("Preview cache cleared");
    } catch (e) {
      setError(String(e));
    }
  }

  async function render() {
    setError("");
    setStatus("");
    const bad = precheck();
    if (bad) return setError(bad);

    // No destination yet → pop the save dialog instead of erroring out, and use
    // the picked path directly (state updates are async, can't rely on it here).
    let outPath = outputPath;
    if (!outPath) {
      const picked = await pickSavePath("timelapse.mp4");
      if (!picked) return; // user cancelled the dialog
      outPath = picked;
      setOutputPath(picked);
    }

    let args: string[];
    try {
      args = buildFfmpeg(currentProject(outPath), { panSupersample: panSmooth }).args;
    } catch (e) {
      return setError(String(e));
    }

    setRunning(true);
    setProgress(null);
    setStatus("Rendering…");
    try {
      await runFfmpeg(ffmpegPath, args, frameCount);
      setStatus("Done ✓ — opening…");
      await openFile(outPath);
    } catch (e) {
      setError(String(e));
      setStatus("");
    } finally {
      setRunning(false);
    }
  }

  async function previewRender() {
    setError("");
    setStatus("");
    const bad = precheck();
    if (bad) return setError(bad);

    setRunning(true);
    setProgress(null);
    try {
      const dir = await ensureCache();
      await refreshProxyStatus();

      setStatus("Rendering preview…");
      setProgress(null);
      const info = await probeDir(dir, ffprobePath || "ffprobe");
      const f = info.width / srcW; // proxy px per source px
      const previewPath = await join(await tempDir(), "timelapse_preview.mp4");
      const base = currentProject(previewPath);
      const project: TimelapseProject = {
        ...base,
        source: {
          ...base.source,
          dir,
          glob: "*.jpg",
          frameCount: info.frame_count,
          width: info.width,
          height: info.height,
        },
        keyframes: base.keyframes.map((k) => ({
          ...k,
          x: Math.round(k.x * f),
          y: Math.round(k.y * f),
          w: Math.round(k.w * f),
          h: Math.round(k.h * f),
        })),
      };
      const built = buildFfmpeg(project, { preview: { width: info.width } });
      await runFfmpeg(ffmpegPath, built.args, built.outputFrames);
      setStatus("Preview ready ✓ — opening…");
      await openFile(previewPath);
    } catch (e) {
      setError(String(e));
      setStatus("");
    } finally {
      setRunning(false);
    }
  }

  async function cancel() {
    await cancelFfmpeg();
    setStatus("Cancelled");
    setRunning(false);
  }

  const pct = progress ? Math.round(progress.pct * 100) : 0;

  return (
    <div className="app">
      <div className="header">
        <h1>RailTrack</h1>
        <button onClick={() => setShowSettings(true)} title="Settings">⚙ Settings</button>
      </div>

      {!ffmpegOk && (
        <div className="banner">
          ffmpeg isn’t configured. <button className="link" onClick={() => setShowSettings(true)}>Open Settings</button>
        </div>
      )}

      <div className="main">
        <div className="leftColumn">
        <div className="sections">
          <Section title="1 · Source frames" open={openSection === "source"} onToggle={() => toggle("source")}>
            <div className="row">
              <button onClick={chooseSource}>Choose folder…</button>
              <span className="grow mono">{sourceDir || "no folder selected"}</span>
            </div>
            {frameCount > 0 && (
              <p className="muted">
                {frameCount} frames · {srcW}×{srcH} · {glob}
                {" · "}
                preview cache: {proxyReady ? "ready ✓" : proxyCount > 0 ? `${proxyCount}/${frameCount}` : "not built"}
              </p>
            )}
          </Section>

          <Section title="2 · Motion & framing" open={openSection === "framing"} onToggle={() => toggle("framing")}>
            <p className="muted">
              Set the move by dragging the <b>Start</b> and <b>End</b> boxes on the preview, and
              the framing tightness with the <b>Zoom</b> slider beneath it. The window glides from
              Start to End across the clip.
            </p>
            <div className="field" style={{ marginTop: 10 }}>
              <label>
                Smooth pan on export
                <span className="hint"> · supersamples to remove pan stutter (slower render)</span>
              </label>
              <select value={panSmooth} onChange={(e) => setPanSmooth(+e.target.value)}>
                <option value={1}>Off</option>
                <option value={2}>2× (smoother)</option>
                <option value={4}>4× (smoothest, slowest)</option>
              </select>
            </div>
            <label className="check">
              <input type="checkbox" checked={speedRampOn}
                onChange={(e) => setSpeedRampOn(e.target.checked)} />
              Speed ramp <span className="hint">(ease up to a peak speed, then back down)</span>
            </label>
            {speedRampOn && (
              <>
                <div className="fieldGrid">
                  <div className="field">
                    <label>Peak speed — {speedPeak}×</label>
                    <input type="range" min={1} max={16} step={1} value={speedPeak}
                      onChange={(e) => setSpeedPeak(+e.target.value)} />
                  </div>
                  <div className="field">
                    <label>
                      Easing — {Math.round(rampEase * 100)}%
                      <span className="hint"> · {rampEase === 0 ? "linear" : rampEase >= 1 ? "smooth" : "eased"}</span>
                    </label>
                    <input type="range" min={0} max={1} step={0.05} value={rampEase}
                      onChange={(e) => setRampEase(+e.target.value)} />
                  </div>
                </div>
                <p className="hint" style={{ fontSize: 12, margin: "2px 0 0" }}>
                  Plays at 1× at the ends and eases up to {speedPeak}× in between. Drag the two
                  blue <b>markers on the timeline</b> to set where it reaches and leaves peak speed.
                  Easing controls how gradual the ramps are (0% = linear, 100% = smooth). Shortens
                  the clip (faster-only, so frames are dropped, not blended).
                </p>
              </>
            )}
          </Section>

          <Section title="3 · Stacking & motion FX" open={openSection === "fx"} onToggle={() => toggle("fx")}>
            <label className="check">
              <input type="checkbox" checked={starTrailOn}
                onChange={(e) => {
                  setStarTrailOn(e.target.checked);
                  if (e.target.checked) setSpeedupOn(false); // exclusive with lighten speed-up
                }} />
              Star trails <span className="hint">(lighten stack)</span>
            </label>
            {starTrailOn && (
              <>
                <div className="field">
                  <label>
                    Persistence — {trailDecay.toFixed(3)}
                    <span className="hint"> · {trailDecay >= 1 ? "permanent trails" : "fading (comet style)"}</span>
                  </label>
                  <input type="range" min={0.9} max={1} step={0.002} value={trailDecay}
                    onChange={(e) => setTrailDecay(+e.target.value)} />
                </div>
                <p className="muted">
                  Drag the <b>star-trail markers on the timeline</b> to set when trails start and
                  end. Persistence below 1.000 fades trails (comet style); ending trails before the
                  clip's end makes them retract back to a normal timelapse.
                </p>
              </>
            )}
            <label className="check">
              <input type="checkbox" checked={speedupOn}
                onChange={(e) => {
                  setSpeedupOn(e.target.checked);
                  if (e.target.checked) setStarTrailOn(false); // exclusive with star trails
                }} />
              Lighten speed-up <span className="hint">(blend & shorten)</span>
            </label>
            {speedupOn && (
              <>
                <div className="field">
                  <label>Factor</label>
                  <select value={speedFactor}
                    onChange={(e) => setSpeedFactor(+e.target.value)}>
                    <option value={2}>2× (half length)</option>
                    <option value={4}>4× (quarter length)</option>
                  </select>
                </div>
                <p className="hint" style={{ fontSize: 12, margin: "2px 0 0" }}>
                  Lighten-blends each group of {speedFactor} frames and shortens the clip
                  to 1/{speedFactor}. Moving highlights (stars) fuse into trails; foreground
                  motion smooths out. Doesn't reduce noise. Not combinable with star trails.
                </p>
              </>
            )}
            <label className="check">
              <input type="checkbox" checked={frameStackOn}
                onChange={(e) => setFrameStackOn(e.target.checked)} />
              Frame stacking <span className="hint">(cross-frame noise reduction)</span>
            </label>
            {frameStackOn && (
              <>
                <div className="fieldGrid">
                  <div className="field">
                    <label>Mode</label>
                    <select value={frameStackMode}
                      onChange={(e) => setFrameStackMode(e.target.value as FrameStackMode)}>
                      <option value="median">Median (rejects planes/satellites)</option>
                      <option value="mean">Mean (gentle average)</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>Window — {frameStackFrames} frames</label>
                    <input type="range" min={2} max={15} step={1} value={frameStackFrames}
                      onChange={(e) => setFrameStackFrames(+e.target.value)} />
                  </div>
                </div>
                <p className="hint" style={{ fontSize: 12, margin: "2px 0 0" }}>
                  Stacks each frame with its neighbours to cut noise. Wider windows are
                  cleaner but soften/trail moving stars.
                </p>
              </>
            )}
            <label className="check">
              <input type="checkbox" checked={deflickerOn}
                onChange={(e) => setDeflickerOn(e.target.checked)} />
              Deflicker <span className="hint">(remove exposure flicker)</span>
            </label>
            {deflickerOn && (
              <div className="field">
                <label>Window — {deflickerSize} frames</label>
                <input type="range" min={2} max={31} step={1} value={deflickerSize}
                  onChange={(e) => setDeflickerSize(+e.target.value)} />
                <p className="hint" style={{ fontSize: 12, margin: "2px 0 0" }}>
                  Normalizes each frame's brightness to its neighbours. Wider windows
                  ride out slower exposure drift; narrower ones react faster.
                </p>
              </div>
            )}
            <label className="check">
              <input type="checkbox" checked={denoiseOn}
                onChange={(e) => setDenoiseOn(e.target.checked)} />
              Denoise
            </label>
            {denoiseOn && (
              <div className="fieldGrid">
                <div className="field">
                  <label>Filter</label>
                  <select value={denoiseFilterName}
                    onChange={(e) => setDenoiseFilterName(e.target.value as DenoiseFilter)}>
                    <option value="hqdn3d">hqdn3d (fast)</option>
                    <option value="fftdnoiz">fftdnoiz (quality)</option>
                    <option value="nlmeans">nlmeans (best, slow)</option>
                  </select>
                </div>
                <div className="field">
                  <label>Strength — {denoiseStrength.toFixed(2)}</label>
                  <input type="range" min={0} max={1} step={0.05} value={denoiseStrength}
                    onChange={(e) => setDenoiseStrength(+e.target.value)} />
                </div>
              </div>
            )}
            <label className="check">
              <input type="checkbox" checked={debandOn}
                onChange={(e) => setDebandOn(e.target.checked)} />
              Deband <span className="hint">(smooth sky-gradient banding)</span>
            </label>
            {debandOn && (
              <div className="field">
                <label>Strength — {debandStrength.toFixed(2)}</label>
                <input type="range" min={0} max={1} step={0.05} value={debandStrength}
                  onChange={(e) => setDebandStrength(+e.target.value)} />
                <p className="hint" style={{ fontSize: 12, margin: "2px 0 0" }}>
                  Smooths stepped gradients (runs after the grade). Higher strength
                  clears more banding but can soften fine detail.
                </p>
              </div>
            )}
          </Section>

          <Section title="4 · Color grade" open={openSection === "look"} onToggle={() => toggle("look")}>
            <div className="colorGrade">
              <div className="row" style={{ alignItems: "center", minHeight: 20 }}>
                <span className="hint" style={{ marginRight: "auto", fontSize: 12 }}>
                  {gradeActive ? "active" : "neutral"}
                </span>
                {gradeActive && (
                  <button className="link" onClick={resetGrade}>reset</button>
                )}
              </div>
              <div className="row" style={{ margin: "8px 0 8px" }}>
                <span className="hint" style={{ fontSize: 11 }}>Tone</span>
              </div>
              <div className="fieldGrid">
                <div className="field">
                  <label>Exposure — {exposure >= 0 ? "+" : ""}{exposure.toFixed(2)}</label>
                  <input type="range" min={-0.5} max={0.5} step={0.01} value={exposure}
                    onChange={(e) => setExposure(+e.target.value)} />
                </div>
                <div className="field">
                  <label>Contrast — {contrast.toFixed(2)}×</label>
                  <input type="range" min={0.5} max={2} step={0.02} value={contrast}
                    onChange={(e) => setContrast(+e.target.value)} />
                </div>
                <div className="field">
                  <label>Highlights — {highlights >= 0 ? "+" : ""}{Math.round(highlights)}</label>
                  <input type="range" min={-100} max={100} step={1} value={highlights}
                    onChange={(e) => setHighlights(+e.target.value)} />
                </div>
                <div className="field">
                  <label>Shadows — {shadows >= 0 ? "+" : ""}{Math.round(shadows)}</label>
                  <input type="range" min={-100} max={100} step={1} value={shadows}
                    onChange={(e) => setShadows(+e.target.value)} />
                </div>
                <div className="field">
                  <label>Gamma — {brightnessToGamma(brightness).toFixed(2)}</label>
                  <input type="range" min={-0.3} max={1} step={0.01} value={brightness}
                    onChange={(e) => setBrightness(+e.target.value)} />
                </div>
              </div>
              <div className="row" style={{ margin: "4px 0 8px" }}>
                <span className="hint" style={{ fontSize: 11 }}>Color</span>
              </div>
              <div className="fieldGrid">
                <div className="field">
                  <label>Temperature <span className="hint">· cool ← → warm</span></label>
                  <input type="range" min={-100} max={100} step={1} value={warmth}
                    onChange={(e) => setWarmth(+e.target.value)} />
                </div>
                <div className="field">
                  <label>Tint <span className="hint">· green ← → magenta</span></label>
                  <input type="range" min={-100} max={100} step={1} value={tint}
                    onChange={(e) => setTint(+e.target.value)} />
                </div>
                <div className="field">
                  <label>Vibrance — {vibrance >= 0 ? "+" : ""}{vibrance.toFixed(2)}</label>
                  <input type="range" min={-1} max={1} step={0.02} value={vibrance}
                    onChange={(e) => setVibrance(+e.target.value)} />
                </div>
                <div className="field">
                  <label>Saturation — {saturation.toFixed(2)}×</label>
                  <input type="range" min={0} max={2} step={0.02} value={saturation}
                    onChange={(e) => setSaturation(+e.target.value)} />
                </div>
              </div>
            </div>
          </Section>

          <Section title="5 · Output &amp; render" open={openSection === "output"} onToggle={() => toggle("output")}>
            <div className="fieldGrid">
              <div className="field">
                <label>Resolution</label>
                <select value={resKey} onChange={(e) => setResKey(e.target.value)}>
                  {Object.keys(RES_PRESETS).map((k) => (
                    <option key={k}>{k}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Frame rate (fps)</label>
                <input type="number" min={1} max={120} value={fps}
                  onChange={(e) => setFps(+e.target.value)} />
              </div>
            </div>
            <label className="check">
              <input type="checkbox" checked={vertical}
                onChange={(e) => setVertical(e.target.checked)} />
              Vertical / portrait ({outW}×{outH})
            </label>
            <div className="fieldGrid">
              <div className="field">
                <label>Codec</label>
                <select value={codec} onChange={(e) => setCodec(e.target.value as Codec)}>
                  <option value="h264">H.264</option>
                  <option value="h265">H.265</option>
                  <option value="prores">ProRes</option>
                </select>
              </div>
              {codec !== "prores" && (
                <div className="field">
                  <label>Quality — CRF {crf} <span className="hint">(lower = better)</span></label>
                  <input type="range" min={12} max={30} value={crf}
                    onChange={(e) => setCrf(+e.target.value)} />
                </div>
              )}
            </div>

            <div className="field">
              <label>Destination file</label>
              <div className="row">
                <button onClick={chooseOutput}>Choose…</button>
                <span className="grow mono">{outputPath || "no file selected"}</span>
              </div>
            </div>
          </Section>
        </div>

        <div className="actionBar">
          <div className="actions">
            {!running ? (
              <>
                <button className="primary" onClick={render}>Render</button>
                <button onClick={previewRender} title="Low-res preview of the whole timelapse. First run builds a one-time cache; later previews are fast.">
                  ⚡ Preview render
                </button>
              </>
            ) : (
              <button className="danger" onClick={cancel}>Cancel</button>
            )}
            <button onClick={showCommand} title="Show the ffmpeg command this will run">
              ⌗ View command
            </button>
            <span className="grow status">{status}</span>
          </div>
          {running && (
            <div className="progress">
              <div className="bar" style={{ width: `${pct}%` }} />
              <span className="pct">
                {pct}% · frame {progress?.frame ?? 0}/{frameCount}
                {progress?.speed ? ` · ${progress.speed}` : ""}
                {eta != null ? ` · ${fmtTime(eta)} left` : ""}
              </span>
            </div>
          )}
          {error && <pre className="error">{error}</pre>}
        </div>
        </div>

        <section className="panel preview-pane">
          <Stage
            ffmpegPath={ffmpegPath}
            ready={ffmpegOk}
            sourceDir={proxyReady ? proxyDir : sourceDir}
            frameCount={frameCount}
            srcW={srcW}
            srcH={srcH}
            startWin={startWin}
            endWin={endWin}
            playhead={playhead}
            grade={{ exposure, brightness, contrast, highlights, shadows, warmth, tint, vibrance, saturation }}
            onDragWindow={handleDragWindow}
            onResizeWindow={handleResizeWindow}
          />
          <p className="muted stageHint">
            Drag the boxes to pan · drag a corner to resize (Start ≠ End size = zoom)
          </p>
          <div className="stageBar">
            <span className="zoomLabel">Zoom</span>
            <input type="range" min={0.3} max={1} step={0.01} value={startZoom}
              disabled={!srcW}
              onChange={(e) => { const v = +e.target.value; setStartZoom(v); setEndZoom(v); }}
              className="grow" />
            {startZoom !== endZoom && <span className="hint">zoom</span>}
            <button
              disabled={!srcW || (endC.cx === startC.cx && endC.cy === startC.cy && startZoom === endZoom)}
              onClick={() => { setEndC(startC); setEndZoom(startZoom); }}
              title="Snap the End box onto the Start box (no pan, no zoom — static framing)">
              Reset
            </button>
          </div>
          <Timeline
            frameCount={frameCount}
            fps={fps}
            playhead={playhead}
            onPlayhead={setPlayhead}
            playing={playing}
            onPlay={setPlaying}
            fadeInSec={fadeInSec}
            fadeOutSec={fadeOutSec}
            onFadeIn={setFadeInSec}
            onFadeOut={setFadeOutSec}
            starTrail={starTrailOn}
            trailStartFrac={trailStartFrac}
            trailEndFrac={trailEndFrac}
            onTrailStart={setTrailStartFrac}
            onTrailEnd={setTrailEndFrac}
            speedRamp={speedRampOn}
            speedPeak={speedPeak}
            rampUpFrac={rampUpFrac}
            rampDownFrac={rampDownFrac}
            onRampUp={setRampUpFrac}
            onRampDown={setRampDownFrac}
          />
        </section>
      </div>

      {showSettings && (
        <div className="modalOverlay" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <h2>Settings</h2>
              <button onClick={() => setShowSettings(false)}>✕</button>
            </div>

            <h3>ffmpeg binaries</h3>
            <div className="fieldGrid">
              <div className="field">
                <label>
                  ffmpeg path
                  <span className={ffmpegOk ? "ok" : "bad"}> · {ffmpegOk ? "✓ ready" : "not found"}</span>
                </label>
                <div className="row">
                  <input className="grow" placeholder="path to ffmpeg"
                    value={ffmpegPath}
                    onChange={(e) => setFfmpegPath(e.target.value)}
                    onBlur={() => checkFfmpeg(ffmpegPath)} />
                  <button onClick={chooseFfmpeg}>Browse…</button>
                </div>
                {!ffmpegOk && ffmpegErr && (
                  <pre className="toolError">{ffmpegErr}</pre>
                )}
              </div>
              <div className="field">
                <label>ffprobe path</label>
                <div className="row">
                  <input className="grow" placeholder="path to ffprobe"
                    value={ffprobePath}
                    onChange={(e) => setFfprobePath(e.target.value)} />
                  <button onClick={chooseFfprobe}>Browse…</button>
                </div>
              </div>
            </div>

            <h3>Encoding</h3>
            {(() => {
              const hwAvailable = vtEncoders.length > 0;
              return (
                <label
                  className={`check${hwAvailable ? "" : " disabled"}`}
                  title={hwAvailable
                    ? "Encode on Apple Silicon's hardware media engine (VideoToolbox) — much faster. Quality is driven by the CRF slider, mapped to VideoToolbox's constant-quality scale. Applies to any codec whose VideoToolbox encoder this ffmpeg supports."
                    : "This ffmpeg build has no VideoToolbox encoders, so hardware acceleration isn't available."}>
                  <input type="checkbox" checked={hwAccel && hwAvailable}
                    disabled={!hwAvailable}
                    onChange={(e) => setHwAccel(e.target.checked)} />
                  Apple Silicon acceleration
                  {!hwAvailable && <span className="hint">(not in this ffmpeg build)</span>}
                </label>
              );
            })()}
            <p className="hint" style={{ fontSize: 12, margin: "2px 0 0" }}>
              Falls back to software encoding automatically for any codec without a
              VideoToolbox encoder in your ffmpeg build.
            </p>

            <h3>Preview cache</h3>
            <div className="fieldGrid">
              <div className="field">
                <label>Resolution <span className="hint">(sharper = larger cache)</span></label>
                <select
                  value={previewW}
                  onChange={(e) => { setPreviewW(+e.target.value); setTimeout(refreshProxyStatus, 0); }}
                >
                  {Object.entries(PREVIEW_RES).map(([k, v]) => (
                    <option key={k} value={v}>{k}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Total on disk</label>
                <div className="statLine">
                  <span>{cacheBytes == null ? "…" : fmtBytes(cacheBytes)}</span>
                  <button className="link" onClick={refreshCacheSize}>refresh</button>
                </div>
              </div>
            </div>
            <div className="field">
              <label>Cache location</label>
              <div className="row">
                <input className="grow" placeholder="system temp directory (default)"
                  value={proxyBaseDir}
                  onChange={(e) => setProxyBaseDir(e.target.value)} />
                <button onClick={chooseProxyDir}>Browse…</button>
                {proxyBaseDir && <button onClick={() => { setProxyBaseDir(""); setTimeout(refreshProxyStatus, 0); }}>Default</button>}
              </div>
            </div>
            <p className="muted">
              {sourceDir
                ? proxyReady
                  ? `Current source: ${proxyCount} frames cached.`
                  : proxyCount > 0
                    ? `Current source: partial cache ${proxyCount}/${frameCount}.`
                    : "Current source has no cache yet."
                : "Select a source folder to manage its cache."}
            </p>
            <div className="row">
              <button onClick={generateCache} disabled={running || !sourceDir}>Generate now</button>
              <button onClick={clearCache} disabled={!sourceDir}>Clear this source</button>
              <button onClick={clearAllCaches} disabled={!cacheBytes}>Clear all</button>
            </div>
            <label className="check">
              <input type="checkbox" checked={rebuildEachSession}
                onChange={(e) => setRebuildEachSession(e.target.checked)} />
              Rebuild cache each session (clears all caches on startup)
            </label>
            <p className="muted">
              Proxies are downscales of your frames, reused across runs and keyed by source
              folder and resolution. Enable the toggle to never reuse them.
            </p>
          </div>
        </div>
      )}

      {cmdText !== null && (
        <div className="modalOverlay" onClick={() => setCmdText(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <h2>ffmpeg command</h2>
              <button onClick={() => setCmdText(null)}>✕</button>
            </div>
            <p className="muted">The render command for the current settings.</p>
            <pre className="cmdBlock">{cmdText}</pre>
            <div className="row">
              <button className="primary" onClick={() => navigator.clipboard?.writeText(cmdText)}>Copy</button>
              <button onClick={() => setCmdText(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
