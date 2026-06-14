use std::fs;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// List the sorted full paths of JPEG frames in a directory.
fn list_jpegs(dir: &str) -> Result<Vec<String>, String> {
    let mut files: Vec<String> = fs::read_dir(dir)
        .map_err(|e| format!("cannot read directory: {e}"))?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| {
            let l = n.to_lowercase();
            l.ends_with(".jpg") || l.ends_with(".jpeg")
        })
        .collect();
    files.sort();
    let base = dir.trim_end_matches('/');
    Ok(files.into_iter().map(|f| format!("{base}/{f}")).collect())
}

/// Holds the currently-running ffmpeg child so it can be cancelled.
#[derive(Default)]
struct Runner(Mutex<Option<Arc<Mutex<std::process::Child>>>>);

#[derive(Serialize, Clone)]
struct ProbeResult {
    frame_count: usize,
    width: u32,
    height: u32,
    glob: String,
    first_file: String,
}

#[derive(Serialize, Clone)]
struct Progress {
    frame: u64,
    total: u64,
    pct: f64,
    fps: f64,
    speed: String,
    done: bool,
}

/// Return true if `<path> -version` runs successfully.
fn tool_works(path: &str) -> bool {
    Command::new(path)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Find an ffmpeg/ffprobe-like tool: try PATH, then common install locations.
fn detect_tool(name: &str) -> Option<String> {
    let mut candidates = vec![name.to_string()];
    for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        candidates.push(format!("{dir}/{name}"));
    }
    candidates.into_iter().find(|c| tool_works(c))
}

#[tauri::command]
fn detect_ffmpeg() -> Option<String> {
    detect_tool("ffmpeg")
}

#[tauri::command]
fn detect_ffprobe() -> Option<String> {
    detect_tool("ffprobe")
}

#[tauri::command]
fn validate_ffmpeg(path: String) -> bool {
    tool_works(&path)
}

/// Scan a directory for JPEG frames and probe the first one's dimensions.
#[tauri::command]
fn probe_dir(dir: String, ffprobe_path: String) -> Result<ProbeResult, String> {
    let files = list_jpegs(&dir)?;
    if files.is_empty() {
        return Err("no .jpg/.jpeg files found in directory".into());
    }

    let first_path = files[0].clone();
    let out = Command::new(&ffprobe_path)
        .args([
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "csv=p=0",
        ])
        .arg(&first_path)
        .output()
        .map_err(|e| format!("ffprobe failed to run: {e}"))?;

    if !out.status.success() {
        return Err(format!(
            "ffprobe error: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let dims: Vec<&str> = text.trim().split(',').collect();
    if dims.len() < 2 {
        return Err(format!("could not parse dimensions from: {text:?}"));
    }
    let width = dims[0].trim().parse().map_err(|_| "bad width".to_string())?;
    let height = dims[1].trim().parse().map_err(|_| "bad height".to_string())?;

    Ok(ProbeResult {
        frame_count: files.len(),
        width,
        height,
        glob: "*.jpg".into(),
        first_file: first_path,
    })
}

#[derive(Serialize, Clone)]
struct ProxyDir {
    dir: String,
    count: usize,
}

/// Compute (and create) the proxy-cache directory for a source folder, and
/// report how many proxy frames already exist there. The cache key is derived
/// from the source path so each folder gets its own stable cache.
#[tauri::command]
fn prepare_proxy_dir(
    source_dir: String,
    base_dir: Option<String>,
    width: u32,
) -> Result<ProxyDir, String> {
    let dir = proxy_dir_for(&source_dir, &base_dir, width);
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create proxy dir: {e}"))?;

    let dir_str = dir.to_string_lossy().to_string();
    let count = list_jpegs(&dir_str).map(|v| v.len()).unwrap_or(0);
    Ok(ProxyDir { dir: dir_str, count })
}

/// Resolve the proxy-cache root ("timelapse-studio-proxies") under a base dir
/// (or the OS temp dir when none is given).
fn proxy_root(base_dir: &Option<String>) -> std::path::PathBuf {
    let mut dir = match base_dir.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(b) => std::path::PathBuf::from(b),
        None => std::env::temp_dir(),
    };
    dir.push("timelapse-studio-proxies");
    dir
}

/// The proxy directory for a given source folder + proxy width. Width is part
/// of the key so different proxy resolutions never collide.
fn proxy_dir_for(source_dir: &str, base_dir: &Option<String>, width: u32) -> std::path::PathBuf {
    let key: String = source_dir
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .collect();
    proxy_root(base_dir).join(format!("{key}_w{width}"))
}

/// Delete the proxy cache for a single source folder.
#[tauri::command]
fn clear_proxies(source_dir: String, base_dir: Option<String>, width: u32) -> Result<(), String> {
    let dir = proxy_dir_for(&source_dir, &base_dir, width);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("cannot clear cache: {e}"))?;
    }
    Ok(())
}

/// Recursively sum the size (bytes) of all files under a directory.
fn dir_size(path: &std::path::Path) -> u64 {
    let mut total = 0;
    if let Ok(rd) = fs::read_dir(path) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                total += dir_size(&p);
            } else if let Ok(m) = e.metadata() {
                total += m.len();
            }
        }
    }
    total
}

/// Total bytes used by the whole TL Studio proxy cache (all source folders).
#[tauri::command]
fn cache_size(base_dir: Option<String>) -> Result<u64, String> {
    let root = proxy_root(&base_dir);
    Ok(if root.exists() { dir_size(&root) } else { 0 })
}

/// Delete the entire proxy cache root (all source folders).
#[tauri::command]
fn clear_all_proxies(base_dir: Option<String>) -> Result<(), String> {
    let dir = proxy_root(&base_dir);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("cannot clear cache: {e}"))?;
    }
    Ok(())
}

/// Extract a single source frame (by index) downscaled to `max_w` and return it
/// as a base64 PNG data URL for the preview canvas. Indexes the exact file so it
/// never has to decode the whole sequence.
#[tauri::command]
fn frame_proxy(
    ffmpeg_path: String,
    dir: String,
    index: usize,
    max_w: u32,
) -> Result<String, String> {
    let files = list_jpegs(&dir)?;
    if files.is_empty() {
        return Err("no frames found".into());
    }
    let i = index.min(files.len() - 1);

    let out = Command::new(&ffmpeg_path)
        .args(["-v", "error", "-y", "-i"])
        .arg(&files[i])
        .args([
            "-vf",
            &format!("scale={max_w}:-1:flags=bilinear"),
            "-frames:v",
            "1",
            "-f",
            "image2pipe",
            "-vcodec",
            "png",
            "pipe:1",
        ])
        .output()
        .map_err(|e| format!("ffmpeg proxy failed: {e}"))?;

    if !out.status.success() {
        return Err(format!(
            "ffmpeg proxy error: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(&out.stdout);
    Ok(format!("data:image/png;base64,{b64}"))
}

/// Run ffmpeg with the given args, streaming `ffmpeg-progress` events to the UI.
/// `total_frames` is used to compute a percentage. Returns the exit code.
#[tauri::command]
async fn run_ffmpeg(
    app: AppHandle,
    runner: State<'_, Runner>,
    ffmpeg_path: String,
    args: Vec<String>,
    total_frames: u64,
) -> Result<i32, String> {
    // Insert progress reporting just before the output path (the last arg).
    let mut full = args.clone();
    let output = full.pop().ok_or("empty args")?;
    full.extend([
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
    ]);
    full.push(output);

    let mut child = Command::new(&ffmpeg_path)
        .args(&full)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start ffmpeg: {e}"))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let child = Arc::new(Mutex::new(child));
    *runner.0.lock().unwrap() = Some(child.clone());

    // Drain stderr so the pipe never fills and blocks ffmpeg; keep the tail for errors.
    let err_tail = Arc::new(Mutex::new(String::new()));
    {
        let err_tail = err_tail.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                let mut t = err_tail.lock().unwrap();
                t.push_str(&line);
                t.push('\n');
                if t.len() > 4000 {
                    let cut = t.len() - 4000;
                    *t = t.split_off(cut);
                }
            }
        });
    }

    // Parse the -progress key=value stream and emit events.
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let reader = BufReader::new(stdout);
        let mut frame: u64 = 0;
        let mut fps: f64 = 0.0;
        let mut speed = String::new();
        for line in reader.lines().map_while(Result::ok) {
            if let Some(v) = line.strip_prefix("frame=") {
                frame = v.trim().parse().unwrap_or(frame);
            } else if let Some(v) = line.strip_prefix("fps=") {
                fps = v.trim().parse().unwrap_or(fps);
            } else if let Some(v) = line.strip_prefix("speed=") {
                speed = v.trim().to_string();
            } else if let Some(v) = line.strip_prefix("progress=") {
                let done = v.trim() == "end";
                let pct = if total_frames > 0 {
                    (frame as f64 / total_frames as f64).min(1.0)
                } else {
                    0.0
                };
                let _ = app2.emit(
                    "ffmpeg-progress",
                    Progress { frame, total: total_frames, pct, fps, speed: speed.clone(), done },
                );
            }
        }
    })
    .await
    .map_err(|e| format!("progress reader join error: {e}"))?;

    let status = {
        let mut guard = child.lock().unwrap();
        guard.wait().map_err(|e| format!("wait failed: {e}"))?
    };
    *runner.0.lock().unwrap() = None;

    let code = status.code().unwrap_or(-1);
    if !status.success() {
        let tail = err_tail.lock().unwrap().clone();
        let last: String = tail
            .lines()
            .rev()
            .take(6)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        return Err(format!("ffmpeg exited with code {code}:\n{last}"));
    }
    Ok(code)
}

/// Open a file with the OS default application (e.g. play a preview clip).
#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let prog = "open";
    #[cfg(target_os = "linux")]
    let prog = "xdg-open";
    #[cfg(target_os = "windows")]
    let prog = "explorer";

    Command::new(prog)
        .arg(&path)
        .spawn()
        .map_err(|e| format!("failed to open file: {e}"))?;
    Ok(())
}

/// Kill the currently-running ffmpeg, if any.
#[tauri::command]
fn cancel_ffmpeg(runner: State<'_, Runner>) -> Result<(), String> {
    if let Some(child) = runner.0.lock().unwrap().take() {
        child
            .lock()
            .unwrap()
            .kill()
            .map_err(|e| format!("kill failed: {e}"))?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Runner::default())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            detect_ffmpeg,
            detect_ffprobe,
            validate_ffmpeg,
            probe_dir,
            frame_proxy,
            prepare_proxy_dir,
            clear_proxies,
            clear_all_proxies,
            cache_size,
            run_ffmpeg,
            cancel_ffmpeg,
            open_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
