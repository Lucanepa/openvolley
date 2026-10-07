//! The match activity log as daily files, next to the native backups:
//!
//!   <data dir>/OpenVolley/logs/activity-YYYY-MM-DD.jsonl
//!
//! (Linux `~/.local/share/OpenVolley/logs`, Windows `%APPDATA%\OpenVolley\logs`;
//! `OPENVOLLEY_LOG_DIR` overrides it.) The web app (src/utils/activity) hands
//! over the entries it stored, one JSON object per line; the desktop log
//! (tauri-plugin-log, main.rs) writes `desktop.log` into the same folder.
//!
//! The page sends lines only, never a path or a file name: the file is the
//! day's (UTC), and each line must be one JSON object of at most 16 KB. Old
//! files go: at most 30 daily files and 50 MB in all. Like the backups the
//! folder is 0700 and the files 0600 on unix. ACL: capabilities/activity.json
//! (the scoretable window from http://localhost only).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, Runtime};

use crate::backup::{create_private_dir, file_manager_command};

/// Longest line accepted (the app keeps an entry's data under 4 KB).
pub const MAX_LINE_BYTES: usize = 16 * 1024;
/// Most lines in one call (the app flushes every 2 s or 50 lines).
pub const MAX_LINES: usize = 500;
pub const KEEP_FILES: usize = 30;
pub const KEEP_BYTES: u64 = 50 * 1024 * 1024;
const PREFIX: &str = "activity-";
const SUFFIX: &str = ".jsonl";

/// The UTC date `YYYY-MM-DD` of a unix time in seconds (proleptic Gregorian).
pub fn utc_date(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    // Howard Hinnant's civil_from_days
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

pub fn file_name_for(date: &str) -> String {
    format!("{PREFIX}{date}{SUFFIX}")
}

fn is_activity_file(name: &str) -> bool {
    name.len() == PREFIX.len() + 10 + SUFFIX.len()
        && name.starts_with(PREFIX)
        && name.ends_with(SUFFIX)
        && name[PREFIX.len()..PREFIX.len() + 10].chars().all(|c| c.is_ascii_digit() || c == '-')
}

/// One line the page may write: a single JSON object, no line break, <= 16 KB.
pub fn valid_line(line: &str) -> bool {
    if line.is_empty() || line.len() > MAX_LINE_BYTES || line.contains('\n') || line.contains('\r') {
        return false;
    }
    matches!(serde_json::from_str::<serde_json::Value>(line), Ok(serde_json::Value::Object(_)))
}

fn open_append(path: &Path) -> std::io::Result<fs::File> {
    let mut opts = fs::OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)
}

/// Appends the lines to the day's file; refuses the whole call when one line
/// is not valid. Returns the number of lines written.
pub fn append_lines(root: &Path, lines: &[String], date: &str) -> Result<u32, String> {
    if lines.len() > MAX_LINES {
        return Err(format!("at most {MAX_LINES} lines per call"));
    }
    if let Some(bad) = lines.iter().position(|l| !valid_line(l)) {
        return Err(format!("line {bad} is not one JSON object of at most {MAX_LINE_BYTES} bytes"));
    }
    if lines.is_empty() {
        return Ok(0);
    }
    create_private_dir(root).map_err(|e| format!("cannot create {}: {e}", root.display()))?;
    let path = root.join(file_name_for(date));
    let mut buf = String::with_capacity(lines.iter().map(|l| l.len() + 1).sum());
    for l in lines {
        buf.push_str(l);
        buf.push('\n');
    }
    let mut f = open_append(&path).map_err(|e| format!("cannot open {}: {e}", path.display()))?;
    f.write_all(buf.as_bytes()).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    Ok(lines.len() as u32)
}

/// Deletes the oldest activity files beyond `keep_files` files or `keep_bytes`
/// in all (the newest file always stays). Other files are never touched.
/// Returns the names removed.
pub fn prune(root: &Path, keep_files: usize, keep_bytes: u64) -> Vec<String> {
    let Ok(entries) = fs::read_dir(root) else { return Vec::new() };
    let mut files: Vec<(String, u64)> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let meta = e.metadata().ok()?;
            (meta.is_file() && is_activity_file(&name)).then_some((name, meta.len()))
        })
        .collect();
    // newest first (the date is in the name)
    files.sort_by(|a, b| b.0.cmp(&a.0));
    let mut removed = Vec::new();
    let mut total = 0u64;
    for (i, (name, size)) in files.iter().enumerate() {
        total += size;
        if i > 0 && (i >= keep_files || total > keep_bytes) && fs::remove_file(root.join(name)).is_ok() {
            removed.push(name.clone());
        }
    }
    removed
}

/// The log folder without an app handle (the log plugin is built before the
/// app): the platform data folder as Tauri's `data_dir()` resolves it, and on
/// macOS the user's ~/Library/Logs/<app> (OpenVolley or OpenBeach), where
/// Console.app and support scripts look.
pub fn default_log_root() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("OPENVOLLEY_LOG_DIR").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    let env_dir = |k: &str| std::env::var_os(k).filter(|d| !d.is_empty()).map(PathBuf::from);
    #[cfg(target_os = "windows")]
    let data = env_dir("APPDATA").map(data_log_root);
    #[cfg(target_os = "macos")]
    let data = env_dir("HOME").map(mac_log_root);
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let data = env_dir("XDG_DATA_HOME").or_else(|| env_dir("HOME").map(|h| h.join(".local").join("share"))).map(data_log_root);
    data
}

pub fn log_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("OPENVOLLEY_LOG_DIR").filter(|d| !d.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    #[cfg(target_os = "macos")]
    {
        let home = app.path().home_dir().map_err(|e| format!("no home folder: {e}"))?;
        Ok(mac_log_root(home))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let data = app.path().data_dir().map_err(|e| format!("no data folder: {e}"))?;
        Ok(data_log_root(data))
    }
}

/// Windows, Linux: <data dir>/OpenVolley/logs.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn data_log_root(data: PathBuf) -> PathBuf {
    data.join("OpenVolley").join("logs")
}

/// macOS: ~/Library/Logs/OpenVolley (OpenBeach: ~/Library/Logs/OpenBeach).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn mac_log_root(home: PathBuf) -> PathBuf {
    home.join("Library").join("Logs").join(crate::flavour::CURRENT.data_folder)
}

fn today() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    utc_date(secs)
}

/// Appends activity lines to today's file (and prunes old files).
#[tauri::command]
pub async fn activity_append<R: Runtime>(app: AppHandle<R>, lines: Vec<String>) -> Result<u32, String> {
    let root = log_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let n = append_lines(&root, &lines, &today())?;
        let removed = prune(&root, KEEP_FILES, KEEP_BYTES);
        if !removed.is_empty() {
            log::info!("[activity] removed {} old log file(s)", removed.len());
        }
        Ok(n)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Opens the log folder in the system file manager.
#[tauri::command]
pub async fn activity_open_dir<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let root = log_root(&app)?;
    create_private_dir(&root).map_err(|e| format!("cannot create {}: {e}", root.display()))?;
    let mut child = file_manager_command(&root)
        .spawn()
        .map_err(|e| format!("cannot open the file manager: {e}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ov-activity-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn log_folders_per_platform() {
        assert_eq!(data_log_root(PathBuf::from("/home/s/.local/share")), PathBuf::from("/home/s/.local/share/OpenVolley/logs"));
        let mac = mac_log_root(PathBuf::from("/Users/s"));
        assert_eq!(mac, PathBuf::from("/Users/s/Library/Logs").join(crate::flavour::CURRENT.data_folder));
    }

    #[test]
    fn dates_are_utc_calendar_days() {
        assert_eq!(utc_date(0), "1970-01-01");
        assert_eq!(utc_date(951_782_400), "2000-02-29");
        assert_eq!(utc_date(1_791_331_199), "2026-10-06");
        assert_eq!(utc_date(1_791_331_200), "2026-10-07");
        assert_eq!(file_name_for("2026-10-07"), "activity-2026-10-07.jsonl");
    }

    #[test]
    fn appends_valid_json_lines_only() {
        let root = temp_root("append");
        let ok = vec![r#"{"kind":"app.start","uid":"a"}"#.to_string(), r#"{"kind":"event.add"}"#.to_string()];
        assert_eq!(append_lines(&root, &ok, "2026-10-07").unwrap(), 2);
        assert_eq!(append_lines(&root, &ok[..1], "2026-10-07").unwrap(), 1);
        let text = fs::read_to_string(root.join("activity-2026-10-07.jsonl")).unwrap();
        assert_eq!(text.lines().count(), 3);
        for bad in ["not json", "[1,2]", "{\"a\":1}\n{\"b\":2}", ""] {
            let err = append_lines(&root, &[ok[0].clone(), bad.to_string()], "2026-10-07").unwrap_err();
            assert!(err.contains("line 1"), "{bad:?}: {err}");
        }
        let long = format!("{{\"x\":\"{}\"}}", "y".repeat(MAX_LINE_BYTES));
        assert!(append_lines(&root, &[long], "2026-10-07").is_err());
        assert_eq!(fs::read_to_string(root.join("activity-2026-10-07.jsonl")).unwrap().lines().count(), 3, "nothing of a refused call is written");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&root).unwrap().permissions().mode() & 0o777, 0o700);
            assert_eq!(fs::metadata(root.join("activity-2026-10-07.jsonl")).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn prunes_the_oldest_files_beyond_the_count_and_size_only() {
        let root = temp_root("prune");
        fs::create_dir_all(&root).unwrap();
        for d in 1..=5 {
            fs::write(root.join(format!("activity-2026-10-0{d}.jsonl")), vec![b'x'; 100]).unwrap();
        }
        fs::write(root.join("desktop.log"), b"keep me").unwrap();
        fs::write(root.join("activity-notes.txt"), b"keep me").unwrap();
        let removed = prune(&root, 3, u64::MAX);
        assert_eq!(removed, vec!["activity-2026-10-02.jsonl", "activity-2026-10-01.jsonl"]);
        let removed = prune(&root, 30, 150);
        assert_eq!(removed, vec!["activity-2026-10-04.jsonl", "activity-2026-10-03.jsonl"]);
        // the newest file stays even when it alone is over the size
        assert!(prune(&root, 30, 10).is_empty());
        assert!(root.join("activity-2026-10-05.jsonl").is_file());
        assert!(root.join("desktop.log").is_file());
        assert!(root.join("activity-notes.txt").is_file());
        let _ = fs::remove_dir_all(&root);
    }
}
