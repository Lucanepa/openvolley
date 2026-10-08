//! Diagnostics mode (off by default): what is needed to explain a layout
//! jump, a dialog that flashes or a reload from the log alone, as daily files
//!
//!   <log dir>/diagnostics-YYYY-MM-DD.jsonl
//!
//! next to desktop.log and the activity files (activity.rs: Linux
//! `~/.local/share/<app>/logs`, Windows `%APPDATA%\<app>\logs`, macOS
//! `~/Library/Logs/<app>`, <app> OpenVolley or OpenBeach; `OPENVOLLEY_LOG_DIR`
//! overrides it).
//!
//! On when `OPENVOLLEY_DIAGNOSTICS=1` is set (the page learns it from an
//! initialization script, `window.__OV_DIAGNOSTICS__ = "env"`), or when the
//! page turns it on (Options; `diagnostics_native`). Two writers:
//! - the page (src/diagnostics): `diagnostics_append(lines)`, JSON lines it
//!   built and redacted (`"src":"page"`), the same rules as activity_append;
//! - this module: the window's native events (`"src":"native"`): size and
//!   scale factor changes, focus, page loads, the webview version at start.
//!
//! The app's pop-up windows ("popup-<n>", popups.rs) may not call these
//! commands (main.rs scoresheet_windows_may_not_back_up): their pages send
//! their lines to the scoretable page, which appends them tagged with the
//! window (src/diagnostics/popupForward.js).
//!
//! A day's file stops at 20 MB (one `diag.capped` line says so); 7 files are
//! kept. Folder 0700, files 0600 on unix. ACL: capabilities/diagnostics.json
//! (the scoretable window from http://localhost only). OpenBeach builds from
//! this src-tauri: its page calls the same two commands.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, Runtime};

use crate::activity::{is_daily_file, log_root, open_append, prune_daily, today, utc_date, valid_line, MAX_LINES, MAX_LINE_BYTES};
use crate::backup::create_private_dir;

/// The environment variable that switches diagnostics on for a run.
pub const ENV: &str = "OPENVOLLEY_DIAGNOSTICS";
/// One day's file stops growing here (a `diag.capped` line marks the cut).
pub const DAY_CAP_BYTES: u64 = 20 * 1024 * 1024;
/// Room kept below the cap for the `diag.capped` line.
const MARKER_ROOM: u64 = 4 * 1024;
pub const KEEP_FILES: usize = 7;
pub const KEEP_BYTES: u64 = KEEP_FILES as u64 * DAY_CAP_BYTES;
const PREFIX: &str = "diagnostics-";

/// What the scoretable page runs before its own scripts when ENV is set.
pub const INIT_SCRIPT: &str = "window.__OV_DIAGNOSTICS__ = 'env';";

static NATIVE_ON: AtomicBool = AtomicBool::new(false);
static START_WRITTEN: AtomicBool = AtomicBool::new(false);
static ROOT: Mutex<Option<PathBuf>> = Mutex::new(None);
// The page's appends and the native writer never interleave inside a file.
static WRITE_LOCK: Mutex<()> = Mutex::new(());
static NATIVE_TX: OnceLock<Mutex<Sender<String>>> = OnceLock::new();

fn process_start() -> Instant {
    static START: OnceLock<Instant> = OnceLock::new();
    *START.get_or_init(Instant::now)
}

/// Is ENV set to an "on" value (1, true, on, yes)?
pub fn env_value_on(value: Option<&str>) -> bool {
    matches!(value.map(|v| v.trim().to_ascii_lowercase()).as_deref(), Some("1" | "true" | "on" | "yes"))
}

pub fn env_enabled() -> bool {
    env_value_on(std::env::var(ENV).ok().as_deref())
}

pub fn file_name_for(date: &str) -> String {
    format!("{PREFIX}{date}.jsonl")
}

fn is_diagnostics_file(name: &str) -> bool {
    is_daily_file(name, PREFIX)
}

/// `2026-10-08T12:34:56.789Z` of a unix time in milliseconds.
pub fn iso_utc(millis: u128) -> String {
    let secs = (millis / 1000) as u64;
    let ms = (millis % 1000) as u32;
    let day = secs % 86_400;
    format!("{}T{:02}:{:02}:{:02}.{ms:03}Z", utc_date(secs), day / 3600, (day / 60) % 60, day % 60)
}

fn now_millis() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// What one append did: lines written, lines dropped at the day's cap.
#[derive(Debug, PartialEq, Eq)]
pub struct Appended {
    pub written: u32,
    pub dropped: u32,
}

/// Does the file's last line say the day is capped?
fn ends_with_cap_marker(path: &Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = fs::File::open(path) else { return false };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let tail = len.min(512);
    if f.seek(SeekFrom::Start(len - tail)).is_err() {
        return false;
    }
    let mut buf = Vec::with_capacity(tail as usize);
    if f.take(tail).read_to_end(&mut buf).is_err() {
        return false;
    }
    let text = String::from_utf8_lossy(&buf);
    text.trim_end().rsplit('\n').next().is_some_and(|last| last.contains("\"k\":\"diag.capped\""))
}

/// Appends the lines to the day's file while it stays under `cap` bytes (the
/// rest is dropped, and one `diag.capped` line says how many; after it the
/// day's file takes nothing more). Refuses the whole call when one line is not one JSON
/// object of at most 16 KB, or when there are more than 500.
pub fn append_capped(root: &Path, lines: &[String], date: &str, cap: u64, now_ms: u128) -> Result<Appended, String> {
    if lines.len() > MAX_LINES {
        return Err(format!("at most {MAX_LINES} lines per call"));
    }
    if let Some(bad) = lines.iter().position(|l| !valid_line(l)) {
        return Err(format!("line {bad} is not one JSON object of at most {MAX_LINE_BYTES} bytes"));
    }
    if lines.is_empty() {
        return Ok(Appended { written: 0, dropped: 0 });
    }
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    create_private_dir(root).map_err(|e| format!("cannot create {}: {e}", root.display()))?;
    let path = root.join(file_name_for(date));
    let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let room = cap.saturating_sub(MARKER_ROOM);
    // The day is capped once its marker is written: nothing more (the page
    // flushes every second, which would otherwise add a marker each time).
    // A marker follows a line that did not fit, so only a nearly full file
    // can end with one.
    if size + MAX_LINE_BYTES as u64 + 1 > room && ends_with_cap_marker(&path) {
        return Ok(Appended { written: 0, dropped: lines.len() as u32 });
    }
    let mut buf = String::new();
    let mut used = size;
    let mut written = 0u32;
    for l in lines {
        let len = l.len() as u64 + 1;
        if used + len > room {
            break;
        }
        buf.push_str(l);
        buf.push('\n');
        used += len;
        written += 1;
    }
    let dropped = lines.len() as u32 - written;
    if dropped > 0 && used < cap {
        let marker = serde_json::json!({
            "ts": iso_utc(now_ms),
            "src": "native",
            "k": "diag.capped",
            "d": { "capBytes": cap, "dropped": dropped }
        });
        buf.push_str(&marker.to_string());
        buf.push('\n');
    }
    if !buf.is_empty() {
        let mut f = open_append(&path).map_err(|e| format!("cannot open {}: {e}", path.display()))?;
        f.write_all(buf.as_bytes()).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    }
    Ok(Appended { written, dropped })
}

/// Deletes the oldest diagnostics files beyond 7 or 140 MB in all (the newest
/// stays); activity files, desktop.log and anything else are never touched.
pub fn prune(root: &Path, keep_files: usize, keep_bytes: u64) -> Vec<String> {
    prune_daily(root, is_diagnostics_file, keep_files, keep_bytes)
}

fn root() -> Option<PathBuf> {
    ROOT.lock().ok()?.clone()
}

/// One native line: `{"ts","m","src":"native","k","d"}`.
pub fn native_line(kind: &str, data: serde_json::Value, now_ms: u128, mono_ms: f64) -> String {
    serde_json::json!({
        "ts": iso_utc(now_ms),
        "m": (mono_ms * 10.0).round() / 10.0,
        "src": "native",
        "k": kind,
        "d": data
    })
    .to_string()
}

fn native_sender() -> Option<Sender<String>> {
    let tx = NATIVE_TX.get_or_init(|| {
        let (tx, rx) = channel::<String>();
        std::thread::Builder::new()
            .name("ov-diagnostics".into())
            .spawn(move || {
                while let Ok(first) = rx.recv() {
                    let mut batch = vec![first];
                    while let Ok(more) = rx.try_recv() {
                        batch.push(more);
                        if batch.len() >= MAX_LINES {
                            break;
                        }
                    }
                    if let Some(root) = root() {
                        if let Err(e) = append_capped(&root, &batch, &today(), DAY_CAP_BYTES, now_millis()) {
                            log::warn!("[diagnostics] native write failed: {e}");
                        }
                    }
                }
            })
            .ok();
        Mutex::new(tx)
    });
    tx.lock().ok().map(|t| t.clone())
}

/// Records a native event when diagnostics is on (a no-op otherwise). Never
/// blocks the caller on the file: a background thread writes.
pub fn native(kind: &str, data: serde_json::Value) {
    if !NATIVE_ON.load(Ordering::Relaxed) {
        return;
    }
    let mono = process_start().elapsed().as_secs_f64() * 1000.0;
    if let Some(tx) = native_sender() {
        let _ = tx.send(native_line(kind, data, now_millis(), mono));
    }
}

pub fn native_on() -> bool {
    NATIVE_ON.load(Ordering::Relaxed)
}

/// At start (setup): where the files go, and ENV.
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    process_start();
    if let Ok(dir) = log_root(app) {
        if let Ok(mut r) = ROOT.lock() {
            *r = Some(dir);
        }
    }
    if env_enabled() {
        log::info!("[diagnostics] on ({ENV}=1): diagnostics-<date>.jsonl in the log folder");
        set_native(app, true);
    }
}

fn set_native<R: Runtime>(app: &AppHandle<R>, on: bool) {
    let was = NATIVE_ON.swap(on, Ordering::Relaxed);
    if on && !was && !START_WRITTEN.swap(true, Ordering::Relaxed) {
        let info = app.package_info();
        native(
            "native.start",
            serde_json::json!({
                "app": crate::flavour::CURRENT.name,
                "version": info.version.to_string(),
                "os": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "webview": tauri::webview_version().unwrap_or_default(),
                "env": env_enabled(),
                "desktop": desktop_session(),
            }),
        );
    }
    if on && !was {
        if let Some(w) = app.get_webview_window(crate::lifecycle::MAIN) {
            window_snapshot(&w, "enabled");
        }
    }
}

/// XDG_CURRENT_DESKTOP / XDG_SESSION_TYPE on Linux (KDE + Wayland vs X11
/// changes how WebKitGTK sizes and scales the window); empty elsewhere.
fn desktop_session() -> String {
    let get = |k: &str| std::env::var(k).unwrap_or_default();
    let parts: Vec<String> = [get("XDG_CURRENT_DESKTOP"), get("XDG_SESSION_TYPE"), get("GDK_SCALE"), get("WEBKIT_DISABLE_DMABUF_RENDERER")]
        .into_iter()
        .enumerate()
        .filter(|(_, v)| !v.is_empty())
        .map(|(i, v)| match i {
            2 => format!("GDK_SCALE={v}"),
            3 => format!("WEBKIT_DISABLE_DMABUF_RENDERER={v}"),
            _ => v,
        })
        .collect();
    parts.join(" ")
}

/// The window's sizes, scale factor and monitor (native.window).
pub fn window_snapshot<R: Runtime>(w: &tauri::WebviewWindow<R>, why: &str) {
    if !native_on() {
        return;
    }
    let inner = w.inner_size().ok().map(|s| [s.width, s.height]);
    let outer = w.outer_size().ok().map(|s| [s.width, s.height]);
    let monitor = w.current_monitor().ok().flatten().map(|m| {
        serde_json::json!({ "w": m.size().width, "h": m.size().height, "scale": m.scale_factor() })
    });
    native(
        "native.window",
        serde_json::json!({
            "why": why,
            "inner": inner,
            "outer": outer,
            "scale": w.scale_factor().ok(),
            "maximized": w.is_maximized().ok(),
            "fullscreen": w.is_fullscreen().ok(),
            "monitor": monitor,
        }),
    );
}

/// The scoretable window's events worth a line (main.rs on_window_event).
pub fn window_event(event: &tauri::WindowEvent) {
    if !native_on() {
        return;
    }
    match event {
        tauri::WindowEvent::Resized(size) => native("native.resized", serde_json::json!({ "w": size.width, "h": size.height })),
        tauri::WindowEvent::ScaleFactorChanged { scale_factor, new_inner_size, .. } => native(
            "native.scale",
            serde_json::json!({ "scale": scale_factor, "w": new_inner_size.width, "h": new_inner_size.height }),
        ),
        tauri::WindowEvent::Focused(focused) => native("native.focus", serde_json::json!({ "focused": focused })),
        tauri::WindowEvent::CloseRequested { .. } => native("native.close_requested", serde_json::json!({})),
        tauri::WindowEvent::ThemeChanged(theme) => native("native.theme", serde_json::json!({ "theme": format!("{theme:?}") })),
        _ => {}
    }
}

/// A page load of the scoretable (main.rs on_page_load), the URL without its
/// query or fragment (tablet links carry ?pin=).
pub fn page_load(started: bool, url: &tauri::Url) {
    if !native_on() {
        return;
    }
    let mut bare = url.clone();
    bare.set_query(None);
    bare.set_fragment(None);
    native(
        if started { "native.page_load_started" } else { "native.page_load_finished" },
        serde_json::json!({ "url": bare.as_str() }),
    );
}

/// Appends the page's diagnostics lines to today's file (and prunes old
/// files). Returns the number of lines written (lines past the day's 20 MB are
/// dropped, not an error).
#[tauri::command]
pub async fn diagnostics_append<R: Runtime>(app: AppHandle<R>, lines: Vec<String>) -> Result<u32, String> {
    let root = log_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let out = append_capped(&root, &lines, &today(), DAY_CAP_BYTES, now_millis())?;
        let removed = prune(&root, KEEP_FILES, KEEP_BYTES);
        if !removed.is_empty() {
            log::info!("[diagnostics] removed {} old file(s)", removed.len());
        }
        Ok(out.written)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The page turned diagnostics on or off (Options): the native events follow.
/// ENV keeps them on. Returns whether they are on now.
#[tauri::command]
pub fn diagnostics_native<R: Runtime>(app: AppHandle<R>, on: bool) -> Result<bool, String> {
    let on = on || env_enabled();
    if on != native_on() {
        log::info!("[diagnostics] native events {}", if on { "on" } else { "off" });
    }
    set_native(&app, on);
    Ok(on)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ov-diag-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn env_values() {
        for on in ["1", "true", "ON", " yes "] {
            assert!(env_value_on(Some(on)), "{on}");
        }
        for off in ["0", "", "false", "no", "2"] {
            assert!(!env_value_on(Some(off)), "{off}");
        }
        assert!(!env_value_on(None));
    }

    #[test]
    fn iso_times_are_utc_with_millis() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_utc(1_791_331_199_123), "2026-10-06T23:59:59.123Z");
        assert_eq!(file_name_for("2026-10-08"), "diagnostics-2026-10-08.jsonl");
    }

    #[test]
    fn native_lines_are_one_json_object() {
        let line = native_line("native.resized", serde_json::json!({ "w": 1400, "h": 900 }), 1_791_331_200_000, 12.345);
        assert!(valid_line(&line));
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["src"], "native");
        assert_eq!(v["k"], "native.resized");
        assert_eq!(v["m"], 12.3);
        assert_eq!(v["ts"], "2026-10-07T00:00:00.000Z");
    }

    #[test]
    fn appends_until_the_day_cap_then_marks_the_cut_once() {
        let root = temp_root("cap");
        let line = format!("{{\"k\":\"geo.size\",\"d\":\"{}\"}}", "x".repeat(1000));
        let cap = MARKER_ROOM + 10 * 1024;
        let lines: Vec<String> = (0..20).map(|_| line.clone()).collect();
        let out = append_capped(&root, &lines, "2026-10-08", cap, 0).unwrap();
        assert!(out.written >= 9 && out.written < 20, "{out:?}");
        assert_eq!(out.written + out.dropped, 20);
        let path = root.join("diagnostics-2026-10-08.jsonl");
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.lines().all(valid_line));
        let last: serde_json::Value = serde_json::from_str(text.lines().last().unwrap()).unwrap();
        assert_eq!(last["k"], "diag.capped");
        assert_eq!(last["d"]["dropped"], out.dropped);
        assert!(fs::metadata(&path).unwrap().len() <= cap);
        // full: later lines are dropped (no further growth past the cap)
        let size = fs::metadata(&path).unwrap().len();
        let again = append_capped(&root, &lines, "2026-10-08", cap, 0).unwrap();
        assert_eq!(again.written, 0);
        assert!(fs::metadata(&path).unwrap().len() <= cap.max(size + 200));
        // another day starts empty
        assert_eq!(append_capped(&root, &lines[..2], "2026-10-09", cap, 0).unwrap(), Appended { written: 2, dropped: 0 });
        // invalid lines refuse the whole call
        assert!(append_capped(&root, &["nope".to_string()], "2026-10-09", cap, 0).is_err());
        let too_many: Vec<String> = (0..=MAX_LINES).map(|_| "{}".to_string()).collect();
        assert!(append_capped(&root, &too_many, "2026-10-09", cap, 0).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let _ = fs::remove_dir_all(&root);
    }

    /// The page flushes every second: once the day is capped, later calls add
    /// nothing, not one more `diag.capped` line each.
    #[test]
    fn a_capped_day_takes_no_further_lines_or_markers() {
        let root = temp_root("cap-once");
        let big = format!("{{\"k\":\"geo.box\",\"d\":\"{}\"}}", "x".repeat(2000));
        let small = "{\"k\":\"ui.click\"}".to_string();
        let cap = MARKER_ROOM + 10 * 1024;
        let path = root.join("diagnostics-2026-10-08.jsonl");
        let first = append_capped(&root, &vec![big.clone(); 10], "2026-10-08", cap, 0).unwrap();
        assert!(first.dropped > 0, "{first:?}");
        let size = fs::metadata(&path).unwrap().len();
        for _ in 0..100 {
            let out = append_capped(&root, &[big.clone(), small.clone()], "2026-10-08", cap, 0).unwrap();
            assert_eq!(out, Appended { written: 0, dropped: 2 });
        }
        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(text.matches("diag.capped").count(), 1, "one marker for the day");
        assert_eq!(fs::metadata(&path).unwrap().len(), size);
        assert!(size <= cap);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn prunes_old_diagnostics_files_only() {
        let root = temp_root("prune");
        fs::create_dir_all(&root).unwrap();
        for d in 1..=9 {
            fs::write(root.join(format!("diagnostics-2026-10-0{d}.jsonl")), b"{}\n").unwrap();
        }
        fs::write(root.join("activity-2026-10-01.jsonl"), b"{}\n").unwrap();
        fs::write(root.join("desktop.log"), b"keep").unwrap();
        let removed = prune(&root, KEEP_FILES, KEEP_BYTES);
        assert_eq!(removed, vec!["diagnostics-2026-10-02.jsonl", "diagnostics-2026-10-01.jsonl"]);
        assert!(root.join("activity-2026-10-01.jsonl").is_file());
        assert!(root.join("desktop.log").is_file());
        let _ = fs::remove_dir_all(&root);
    }
}
