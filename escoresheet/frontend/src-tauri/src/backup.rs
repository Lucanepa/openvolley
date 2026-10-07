//! Native automatic match backups for the desktop scoretable.
//!
//! The web app (src/utils/nativeBackup) writes one JSON file per scoring
//! event through these commands. Everything stays inside ONE folder:
//!
//!   <data dir>/OpenVolley/backups/<match dir>/<file>.json
//!
//! (Linux `~/.local/share/OpenVolley/backups`, Windows
//! `%APPDATA%\OpenVolley\backups`; `OPENVOLLEY_BACKUP_DIR` overrides it.)
//! The commands take only a match folder name and a file name, both checked
//! against a strict character set, so no path from the page can leave that
//! folder. Their ACL (build.rs app manifest + capabilities/backup.json) admits
//! only the scoretable window loaded from http://localhost.
//!
//! On unix the folders are created 0700 and the files 0600: a backup holds
//! player names and birth dates, and other local users must not read it.

use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;

/// Largest backup accepted (a long 5-set match with snapshots is a few MB).
const MAX_BACKUP_BYTES: usize = 64 * 1024 * 1024;
const LATEST_FILE: &str = "latest.json";

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub dir: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupFile {
    pub name: String,
    pub size: u64,
    pub modified_ms: u64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupDir {
    pub dir: String,
    pub files: Vec<BackupFile>,
}

/// A single path segment: 1-100 chars of [A-Za-z0-9_.-], not starting with a
/// dot (so never `.`, `..` or a hidden temp file).
pub fn valid_segment(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && !s.starts_with('.')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
}

fn valid_file_name(s: &str) -> bool {
    valid_segment(s) && s.ends_with(".json")
}

fn check_dir(match_dir: &str) -> Result<(), String> {
    if valid_segment(match_dir) {
        Ok(())
    } else {
        Err(format!("invalid backup folder name: {match_dir:?}"))
    }
}

fn check_file(file_name: &str) -> Result<(), String> {
    if valid_file_name(file_name) {
        Ok(())
    } else {
        Err(format!("invalid backup file name: {file_name:?}"))
    }
}

/// Creates a folder (and its parents) readable by the owner only on unix.
pub(crate) fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
        // a folder made by an older version (0755) is tightened too
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(dir)
    }
}

fn create_private_file(path: &Path) -> std::io::Result<fs::File> {
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)
}

/// Write via a hidden temp file + rename, so a crash never leaves half a file
/// (rename replaces an existing latest.json on Linux and Windows).
fn write_atomic(dir: &Path, name: &str, contents: &[u8]) -> std::io::Result<()> {
    let tmp = dir.join(format!(".{name}.tmp"));
    let _ = fs::remove_file(&tmp); // a leftover temp file keeps its old mode otherwise
    {
        let mut f = create_private_file(&tmp)?;
        f.write_all(contents)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, dir.join(name)).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

/// Writes one event backup (+ latest.json). Only a failed event file is an
/// error; when just latest.json cannot be replaced (Windows: a virus scan or
/// the Explorer preview pane holds it open) the event file is saved and the
/// result is `Ok(Some(warning))`.
pub fn write_backup(root: &Path, match_dir: &str, file_name: &str, contents: &str, latest: bool) -> Result<Option<String>, String> {
    check_dir(match_dir)?;
    check_file(file_name)?;
    if contents.len() > MAX_BACKUP_BYTES {
        return Err("backup too large".into());
    }
    let dir = root.join(match_dir);
    create_private_dir(root).map_err(|e| format!("cannot create {}: {e}", root.display()))?;
    create_private_dir(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    write_atomic(&dir, file_name, contents.as_bytes()).map_err(|e| format!("cannot write {file_name}: {e}"))?;
    if latest && file_name != LATEST_FILE {
        if let Err(e) = write_atomic(&dir, LATEST_FILE, contents.as_bytes()) {
            return Ok(Some(format!("cannot update {match_dir}/{LATEST_FILE}: {e}")));
        }
    }
    Ok(None)
}

pub fn list_backups(root: &Path) -> Result<Vec<BackupDir>, String> {
    let mut out = Vec::new();
    let entries = match fs::read_dir(root) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(format!("cannot list {}: {e}", root.display())),
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !valid_segment(&name) || !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let mut files = Vec::new();
        if let Ok(inner) = fs::read_dir(entry.path()) {
            for f in inner.flatten() {
                let fname = f.file_name().to_string_lossy().to_string();
                let Ok(meta) = f.metadata() else { continue };
                if !meta.is_file() || !valid_file_name(&fname) {
                    continue;
                }
                let modified_ms = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                files.push(BackupFile { name: fname, size: meta.len(), modified_ms });
            }
        }
        files.sort_by(|a, b| a.name.cmp(&b.name));
        out.push(BackupDir { dir: name, files });
    }
    out.sort_by(|a, b| a.dir.cmp(&b.dir));
    Ok(out)
}

/// Deletes event backups of one match. latest.json is never deleted here.
pub fn remove_backups(root: &Path, match_dir: &str, file_names: &[String]) -> Result<u32, String> {
    check_dir(match_dir)?;
    let mut removed = 0;
    for name in file_names {
        check_file(name)?;
        if name == LATEST_FILE {
            continue;
        }
        match fs::remove_file(root.join(match_dir).join(name)) {
            Ok(()) => removed += 1,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("cannot delete {name}: {e}")),
        }
    }
    Ok(removed)
}

pub fn backup_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("OPENVOLLEY_BACKUP_DIR").filter(|d| !d.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    let data = app.path().data_dir().map_err(|e| format!("no data folder: {e}"))?;
    Ok(data.join(crate::flavour::CURRENT.data_folder).join("backups"))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn backup_info<R: Runtime>(app: AppHandle<R>) -> Result<BackupInfo, String> {
    let root = backup_root(&app)?;
    Ok(BackupInfo { dir: root.display().to_string() })
}

#[tauri::command]
pub async fn backup_write<R: Runtime>(
    app: AppHandle<R>,
    match_dir: String,
    file_name: String,
    contents: String,
    latest: bool,
) -> Result<Option<String>, String> {
    let root = backup_root(&app)?;
    blocking(move || write_backup(&root, &match_dir, &file_name, &contents, latest)).await
}

#[tauri::command]
pub async fn backup_list<R: Runtime>(app: AppHandle<R>) -> Result<Vec<BackupDir>, String> {
    let root = backup_root(&app)?;
    blocking(move || list_backups(&root)).await
}

#[tauri::command]
pub async fn backup_remove<R: Runtime>(app: AppHandle<R>, match_dir: String, file_names: Vec<String>) -> Result<u32, String> {
    let root = backup_root(&app)?;
    blocking(move || remove_backups(&root, &match_dir, &file_names)).await
}

/// The system file manager command for a folder. The path is one argument
/// (no shell), and it is always the backup root, never a path from the page.
/// (tauri-plugin-opener would do the same but re-resolves ~60 locked crates.)
pub(crate) fn file_manager_command(dir: &Path) -> std::process::Command {
    #[cfg(target_os = "windows")]
    let program = "explorer";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let program = "xdg-open";
    let mut cmd = std::process::Command::new(program);
    cmd.arg(dir);
    cmd
}

/// Opens the backup folder in the system file manager.
#[tauri::command]
pub async fn backup_open_dir<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let root = backup_root(&app)?;
    create_private_dir(&root).map_err(|e| format!("cannot create {}: {e}", root.display()))?;
    // spawn, never wait: explorer.exe exits 1 even on success
    let mut child = file_manager_command(&root)
        .spawn()
        .map_err(|e| format!("cannot open the file manager: {e}"))?;
    std::thread::spawn(move || {
        let _ = child.wait(); // reap it (no zombie)
    });
    Ok(())
}

/// Native "open file" dialog starting in the backup folder; returns the chosen
/// file's text (the page parses and restores it), or None when cancelled.
#[tauri::command]
pub async fn backup_pick_file<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    let root = backup_root(&app)?;
    let _ = create_private_dir(&root);
    let dialog = app.dialog().clone();
    blocking(move || {
        let picked = dialog
            .file()
            .set_title("Restore from a backup file")
            .set_directory(&root)
            .add_filter(format!("{} backup", crate::flavour::CURRENT.name), &["json"])
            .blocking_pick_file();
        let Some(picked) = picked else { return Ok(None) };
        let path = picked.into_path().map_err(|e| e.to_string())?;
        let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
        if meta.len() as usize > MAX_BACKUP_BYTES {
            return Err("file too large for a backup".into());
        }
        fs::read_to_string(&path).map(Some).map_err(|e| format!("cannot read {}: {e}", path.display()))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ov-backup-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn segments_are_strict() {
        assert!(valid_segment("game42-abc_DEF"));
        assert!(valid_file_name("20261006T143015.123Z-00042.json"));
        assert!(valid_file_name("latest.json"));
        for bad in ["", ".", "..", "../x", "a/b", "a\\b", ".hidden", "C:", "x y", "über", &"a".repeat(101)] {
            assert!(!valid_segment(bad), "{bad:?} must be rejected");
        }
        assert!(!valid_file_name("backup.txt"));
    }

    #[test]
    fn write_list_remove_roundtrip() {
        let root = temp_root("roundtrip");
        write_backup(&root, "game7-seed", "20261006T100000.000Z-00001.json", "{\"a\":1}", true).unwrap();
        write_backup(&root, "game7-seed", "20261006T100001.000Z-00002.json", "{\"a\":2}", true).unwrap();
        assert_eq!(fs::read_to_string(root.join("game7-seed/latest.json")).unwrap(), "{\"a\":2}");

        let dirs = list_backups(&root).unwrap();
        assert_eq!(dirs.len(), 1);
        let names: Vec<_> = dirs[0].files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["20261006T100000.000Z-00001.json", "20261006T100001.000Z-00002.json", "latest.json"]);

        let removed = remove_backups(
            &root,
            "game7-seed",
            &["20261006T100000.000Z-00001.json".into(), "latest.json".into(), "missing.json".into()],
        )
        .unwrap();
        assert_eq!(removed, 1);
        assert!(root.join("game7-seed/latest.json").exists(), "latest.json is never deleted");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_stuck_latest_json_is_a_warning_not_an_error() {
        let root = temp_root("stuck-latest");
        // a folder named latest.json makes the rename fail, like a locked file on Windows
        fs::create_dir_all(root.join("game7-seed/latest.json")).unwrap();
        let warning = write_backup(&root, "game7-seed", "20261006T100000.000Z-00001.json", "{}", true).unwrap();
        assert!(warning.unwrap().contains("latest.json"));
        assert!(root.join("game7-seed/20261006T100000.000Z-00001.json").is_file(), "the event file is saved");
        assert!(!root.join("game7-seed/.latest.json.tmp").exists(), "no temp file left behind");
        assert_eq!(write_backup(&root, "game8-seed", "20261006T100000.000Z-00001.json", "{}", true).unwrap(), None);
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn backups_are_private_to_the_user() {
        use std::os::unix::fs::PermissionsExt;
        let root = temp_root("private");
        // a folder left 0755 by an older version is tightened
        fs::create_dir_all(root.join("game7-seed")).unwrap();
        fs::set_permissions(root.join("game7-seed"), fs::Permissions::from_mode(0o755)).unwrap();
        write_backup(&root, "game7-seed", "20261006T100000.000Z-00001.json", "{}", true).unwrap();
        let mode = |p: PathBuf| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(root.clone()), 0o700);
        assert_eq!(mode(root.join("game7-seed")), 0o700);
        assert_eq!(mode(root.join("game7-seed/20261006T100000.000Z-00001.json")), 0o600);
        assert_eq!(mode(root.join("game7-seed/latest.json")), 0o600);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn nothing_leaves_the_root() {
        let root = temp_root("escape");
        assert!(write_backup(&root, "..", "x.json", "{}", false).is_err());
        assert!(write_backup(&root, "ok", "../../x.json", "{}", false).is_err());
        assert!(write_backup(&root, "ok", "x.sh", "{}", false).is_err());
        assert!(remove_backups(&root, "ok", &["../latest.json".into()]).is_err());
        assert!(!root.exists() || list_backups(&root).unwrap().is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn file_manager_gets_the_folder_as_one_argument() {
        let dir = Path::new("/data/Open Volley/backups");
        let cmd = file_manager_command(dir);
        let args: Vec<_> = cmd.get_args().collect();
        assert_eq!(args, [dir.as_os_str()]);
    }

    #[test]
    fn missing_root_lists_empty() {
        assert!(list_backups(&temp_root("missing")).unwrap().is_empty());
    }

    #[test]
    fn capability_admits_only_the_local_scoretable() {
        // capabilities/backup.json: the remote URL the backup commands accept
        let cap: serde_json::Value = serde_json::from_str(include_str!("../capabilities/backup.json")).unwrap();
        let patterns: Vec<tauri::utils::acl::RemoteUrlPattern> = cap["remote"]["urls"]
            .as_array()
            .unwrap()
            .iter()
            .map(|u| u.as_str().unwrap().parse().unwrap())
            .collect();
        let allowed = |u: &str| patterns.iter().any(|p| p.test(&u.parse().unwrap()));
        assert!(allowed("http://localhost:5173/"));
        assert!(allowed("http://localhost:5173/?match=1"));
        assert!(allowed("http://localhost:6000/"));
        assert!(!allowed("http://192.168.1.20:5173/"));
        assert!(!allowed("https://example.com/"));
        assert!(!allowed("http://localhost.evil.com:5173/"));
        assert_eq!(cap["windows"], serde_json::json!(["main"]));
    }
}
