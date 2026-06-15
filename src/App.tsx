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
  type Progress,
} from "./backend";
import { projectFromUi } from "./projectFromUi";
import { buildFfmpeg, buildProxyCommand } from "./engine/buildFfmpeg";
import type { Codec, DenoiseFilter, TimelapseProject } from "./engine/project";
import Preview from "./Preview";
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
  const [crf, setCrf] = useState(18);
  const [outputPath, setOutputPath] = useState("");

  // window / pan
  const [pan, setPan] = useState(200);
  const [panReverse, setPanReverse] = useState(false);
  const [yFrac, setYFrac] = useState(1); // 0 = top, 1 = bottom

  // post
  const [denoiseOn, setDenoiseOn] = useState(false);
  const [denoiseFilterName, setDenoiseFilterName] = useState<DenoiseFilter>("hqdn3d");
  const [denoiseStrength, setDenoiseStrength] = useState(0.5);
  const [panSmooth, setPanSmooth] = useState(1); // export sub-pixel pan factor (1=off)
  const [starTrailOn, setStarTrailOn] = useState(false);
  const [trailDecay, setTrailDecay] = useState(1.0);
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

  // Keyframes derived from the current pan/window settings — drives the preview.
  const keyframes = useMemo(() => {
    if (!frameCount || !srcW) return [];
    return projectFromUi({
      sourceDir, glob, frameCount, srcW, srcH,
      outW, outH, fps, codec, crf, outputPath: "",
      pan, panReverse, yFrac,
    }).keyframes;
  }, [frameCount, srcW, srcH, outW, outH, pan, panReverse, yFrac, sourceDir, glob, fps, codec, crf]);

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
      const rebuild = s.rebuildEachSession === true;
      if (rebuild) setRebuildEachSession(true);

      try {
        if (typeof s.ffmpegPath === "string" && s.ffmpegPath) {
          setFfmpegPath(s.ffmpegPath);
          setFfmpegOk(await validateFfmpeg(s.ffmpegPath));
        } else {
          const fm = await detectFfmpeg();
          if (fm) { setFfmpegPath(fm); setFfmpegOk(true); }
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
      JSON.stringify({ ffmpegPath, ffprobePath, proxyBaseDir, previewW, rebuildEachSession }),
    );
  }, [settingsLoaded, ffmpegPath, ffprobePath, proxyBaseDir, previewW, rebuildEachSession]);

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
    if (showSettings) refreshCacheSize();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSettings]);

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
      setStatus(`Found ${r.frame_count} frames at ${r.width}×${r.height}`);
      await refreshProxyStatus(dir);
    } catch (e) {
      setError(String(e));
    }
  }

  async function chooseFfmpeg() {
    const f = await pickFile();
    if (!f) return;
    setFfmpegPath(f);
    setFfmpegOk(await validateFfmpeg(f));
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
      outW, outH, fps, codec, crf, outputPath: outPath,
      pan, panReverse, yFrac,
      denoise: denoiseOn
        ? { filter: denoiseFilterName, strength: denoiseStrength }
        : undefined,
      starTrail: starTrailOn ? { decay: trailDecay } : undefined,
      trailStartFrac: starTrailOn ? trailStartFrac : undefined,
      trailEndFrac: starTrailOn ? trailEndFrac : undefined,
    });
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
    if (!outputPath) return setError("Choose an output file.");

    let args: string[];
    try {
      args = buildFfmpeg(currentProject(outputPath), { panSupersample: panSmooth }).args;
    } catch (e) {
      return setError(String(e));
    }

    setRunning(true);
    setProgress(null);
    setStatus("Rendering…");
    try {
      await runFfmpeg(ffmpegPath, args, frameCount);
      setStatus("Done ✓");
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

          <Section title="2 · Window &amp; pan" open={openSection === "window"} onToggle={() => toggle("window")}>
            <div className="field">
              <label>Pan — {pan}px {panReverse ? "(right → left)" : "(left → right)"}</label>
              <input type="range" min={0} max={Math.max(400, srcW ? srcW - outW : 800)}
                value={pan} onChange={(e) => setPan(+e.target.value)} />
            </div>
            <label className="check">
              <input type="checkbox" checked={panReverse}
                onChange={(e) => setPanReverse(e.target.checked)} />
              Reverse direction
            </label>
            <div className="field">
              <label>
                Vertical position — {Math.round(yFrac * 100)}%
                {keyframes[0] ? ` (y = ${keyframes[0].y}px)` : ""}
                <span className="hint"> · 0% top, 100% bottom</span>
              </label>
              <input type="range" min={0} max={1} step={0.005} value={yFrac}
                onChange={(e) => setYFrac(+e.target.value)} />
            </div>
          </Section>

          <Section title="3 · Star trails (lighten stack)" open={openSection === "trails"} onToggle={() => toggle("trails")}>
            <label className="check">
              <input type="checkbox" checked={starTrailOn}
                onChange={(e) => setStarTrailOn(e.target.checked)} />
              Enable star trails
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
                <div className="field">
                  <label>
                    Trails start at — {Math.round(trailStartFrac * 100)}%
                    {frameCount ? ` (frame ${Math.round(trailStartFrac * (frameCount - 1))})` : ""}
                  </label>
                  <input type="range" min={0} max={1} step={0.01} value={trailStartFrac}
                    onChange={(e) => setTrailStartFrac(Math.min(+e.target.value, trailEndFrac))} />
                </div>
                <div className="field">
                  <label>
                    Trails end at — {trailEndFrac >= 1 ? "100% (run to end)" : `${Math.round(trailEndFrac * 100)}%`}
                    {frameCount && trailEndFrac < 1 ? ` (frame ${Math.round(trailEndFrac * (frameCount - 1))})` : ""}
                  </label>
                  <input type="range" min={0} max={1} step={0.01} value={trailEndFrac}
                    onChange={(e) => setTrailEndFrac(Math.max(+e.target.value, trailStartFrac))} />
                </div>
                <p className="muted">
                  Start at 0% = trails from the beginning; higher plays a normal timelapse first,
                  then trails form. End below 100% makes the trails retract back to points (the
                  scene roughly holds during the retract, adding ~that many frames to the clip).
                  Stacking is applied before the pan; denoise (if on) runs before stacking.
                </p>
              </>
            )}
          </Section>

          <Section title="4 · Post-processing" open={openSection === "post"} onToggle={() => toggle("post")}>
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
                  </select>
                </div>
                <div className="field">
                  <label>Strength — {denoiseStrength.toFixed(2)}</label>
                  <input type="range" min={0} max={1} step={0.05} value={denoiseStrength}
                    onChange={(e) => setDenoiseStrength(+e.target.value)} />
                </div>
              </div>
            )}
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
          </Section>
        </div>

        <div style={{width: '100%'}}>
          <section className="panel preview-pane">
            <h2>Preview</h2>
            <Preview
              ffmpegPath={ffmpegPath}
              ready={ffmpegOk}
              sourceDir={proxyReady ? proxyDir : sourceDir}
              frameCount={frameCount}
              srcW={srcW}
              keyframes={keyframes}
              outAspect={outW / outH}
            />
          </section>
        </div>
      </div>

      {showSettings && (
        <div className="modalOverlay" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <h2>Settings</h2>
              <button onClick={() => setShowSettings(false)}>✕</button>
            </div>

            <h3>ffmpeg binaries</h3>
            <div className="field">
              <label>
                ffmpeg path
                <span className={ffmpegOk ? "ok" : "bad"}> · {ffmpegOk ? "✓ ready" : "not found"}</span>
              </label>
              <div className="row">
                <input className="grow" placeholder="path to ffmpeg"
                  value={ffmpegPath}
                  onChange={(e) => setFfmpegPath(e.target.value)}
                  onBlur={async () => setFfmpegOk(await validateFfmpeg(ffmpegPath))} />
                <button onClick={chooseFfmpeg}>Browse…</button>
              </div>
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
