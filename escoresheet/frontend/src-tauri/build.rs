const BACKUP_COMMANDS: &[&str] = &[
    "backup_info",
    "backup_write",
    "backup_list",
    "backup_remove",
    "backup_open_dir",
    "backup_pick_file",
];

fn main() {
    // An app ACL manifest: the backup commands are denied unless a capability
    // grants them (capabilities/backup.json: only the main window, only from
    // http://localhost).
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(BACKUP_COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
