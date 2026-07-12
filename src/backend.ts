/**
 * Typed bridge to the Tauri backend (Rust commands + dialogs + events).
 * Keeps all `invoke` string literals in one place so the UI stays clean.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";

export interface ProbeResult {
  frame_count: number;
  width: number;
  height: number;
  glob: string;
  first_file: string;
}

export interface Progress {
  frame: number;
  total: number;
  pct: number;
  fps: number;
  speed: string;
  done: boolean;
}

export const detectFfmpeg = () => invoke<string | null>("detect_ffmpeg");
export const detectFfprobe = () => invoke<string | null>("detect_ffprobe");
export interface ToolCheck {
  ok: boolean;
  /** Human-readable failure reason when ok is false (e.g. loader error tail). */
  detail: string | null;
}

export const validateFfmpeg = (path: string) =>
  invoke<ToolCheck>("validate_ffmpeg", { path });

/** Which VideoToolbox (Apple Silicon HW) encoders this ffmpeg build supports. */
export const videotoolboxEncoders = (path: string) =>
  invoke<string[]>("videotoolbox_encoders", { path });

export const probeDir = (dir: string, ffprobePath: string) =>
  invoke<ProbeResult>("probe_dir", { dir, ffprobePath });

/** Extract one source frame (by index), downscaled, as a base64 PNG data URL. */
export const framePreview = (
  ffmpegPath: string,
  dir: string,
  index: number,
  maxW: number,
  gradeFilter?: string,
) => invoke<string>("frame_proxy", { ffmpegPath, dir, index, maxW, gradeFilter });

export const runFfmpeg = (
  ffmpegPath: string,
  args: string[],
  totalFrames: number,
) => invoke<number>("run_ffmpeg", { ffmpegPath, args, totalFrames });

export const cancelFfmpeg = () => invoke<void>("cancel_ffmpeg");

export const openFile = (path: string) => invoke<void>("open_file", { path });

export interface ProxyDir {
  dir: string;
  count: number;
}

/** Get/create the proxy-cache dir for a source folder and how many proxies exist. */
export const prepareProxyDir = (
  sourceDir: string,
  baseDir: string | null,
  width: number,
) => invoke<ProxyDir>("prepare_proxy_dir", { sourceDir, baseDir: baseDir || null, width });

/** Delete the proxy cache for one source folder (at a given proxy width). */
export const clearProxies = (
  sourceDir: string,
  baseDir: string | null,
  width: number,
) => invoke<void>("clear_proxies", { sourceDir, baseDir: baseDir || null, width });

/** Delete the entire proxy cache (all source folders). */
export const clearAllProxies = (baseDir?: string | null) =>
  invoke<void>("clear_all_proxies", { baseDir: baseDir || null });

/** Total bytes used by the whole proxy cache. */
export const cacheSize = (baseDir?: string | null) =>
  invoke<number>("cache_size", { baseDir: baseDir || null });

/** Subscribe to ffmpeg progress events. Returns an unlisten function. */
export function onProgress(cb: (p: Progress) => void): Promise<UnlistenFn> {
  return listen<Progress>("ffmpeg-progress", (e) => cb(e.payload));
}

/** Native pickers. */
export const pickDirectory = () =>
  open({ directory: true, multiple: false }) as Promise<string | null>;

export const pickSavePath = (defaultName = "timelapse.mp4") =>
  save({
    defaultPath: defaultName,
    filters: [{ name: "Video", extensions: ["mp4", "mov"] }],
  });

export const pickFile = () =>
  open({ directory: false, multiple: false }) as Promise<string | null>;
