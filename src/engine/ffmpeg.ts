/**
 * BYO-ffmpeg resolution (MVP strategy).
 *
 * The engine itself is pure and only decides WHICH binary string to invoke;
 * the Tauri/Rust backend does the actual `which`-style detection on disk and
 * the spawning. This keeps the resolution policy in one tested place.
 */

/**
 * Resolve the ffmpeg binary to invoke.
 * - If the user configured an explicit path, use it (trimmed).
 * - Otherwise fall back to "ffmpeg" and rely on PATH (the backend may replace
 *   this with an absolute path discovered via detection).
 */
export function resolveFfmpeg(configuredPath?: string | null): string {
  const p = configuredPath?.trim();
  return p && p.length > 0 ? p : "ffmpeg";
}

/** Same policy for ffprobe (used for source frame dimensions/counts). */
export function resolveFfprobe(configuredPath?: string | null): string {
  const p = configuredPath?.trim();
  return p && p.length > 0 ? p : "ffprobe";
}
