const APP_COMMANDS: &[&str] = &[
    // automatic match backups (backup.rs)
    "backup_info",
    "backup_write",
    "backup_list",
    "backup_remove",
    "backup_open_dir",
    "backup_pick_file",
    // networks the laptop creates for the tablets (netshare/)
    "hotspot_status",
    "hotspot_start",
    "hotspot_stop",
    "bluetooth_status",
    "bluetooth_start",
    "bluetooth_stop",
    // is the installer's firewall rule for the tablets there? (firewall.rs)
    "firewall_status",
    // close to tray / confirmed quit (lifecycle.rs)
    "app_page_state",
    "app_page_gone",
    "app_hide",
    "app_quit",
    "app_quit_ack",
];

fn main() {
    // An app ACL manifest: these commands are denied unless a capability
    // grants them (capabilities/backup.json, capabilities/netshare.json,
    // capabilities/app.json: only the main window, only from http://localhost).
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
