// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backup;
mod relay;

use tauri::{WebviewUrl, WebviewWindowBuilder};

const DEFAULT_HTTP_PORT: u16 = 5173;
const DEFAULT_WS_PORT: u16 = 8080;

fn http_port() -> u16 {
    std::env::var("OPENVOLLEY_HTTP_PORT").ok().and_then(|s| s.parse().ok()).unwrap_or(DEFAULT_HTTP_PORT)
}
fn ws_port() -> u16 {
    std::env::var("OPENVOLLEY_WS_PORT").ok().and_then(|s| s.parse().ok()).unwrap_or(DEFAULT_WS_PORT)
}

fn main() {
    let http = http_port();
    let ws = ws_port();

    // Headless server-only mode (no window / no display) — used for testing and
    // as a plain "server for tablets" runtime.
    if std::env::args().any(|a| a == "--server-only") {
        run_server_only(http, ws);
        return;
    }

    // Pre-bind the ports synchronously so the window can't race ahead of the
    // server (a queued connection is fine; a refused one would blank the window).
    let http_listener = std::net::TcpListener::bind(("0.0.0.0", http)).unwrap_or_else(|e| {
        eprintln!("Cannot bind HTTP port {http}: {e}");
        std::process::exit(1);
    });
    let ws_listener = std::net::TcpListener::bind(("0.0.0.0", ws)).unwrap_or_else(|e| {
        eprintln!("Cannot bind WebSocket port {ws}: {e}");
        std::process::exit(1);
    });

    // The cloud backend's CORS trusts the desktop window on port 5173 only:
    // on another port the app runs the venue as usual and says "Cloud sync
    // unavailable on port N" (isCloudBlockedOnThisPort in backendConfig.js).
    if http != DEFAULT_HTTP_PORT {
        eprintln!("OPENVOLLEY_HTTP_PORT={http}: cloud sync needs port {DEFAULT_HTTP_PORT}; the tablets keep working");
    }

    let state = relay::new_state(http, ws);

    with_backup_commands(tauri::Builder::default().plugin(tauri_plugin_dialog::init()))
        // No native menu bar on Linux / Windows: it held only Help > Connect a
        // Tablet and rendered in the GTK system theme (dark on a dark desktop).
        // The app's own header menu has Connect tablets (LAN addresses + QR),
        // help and the version. macOS keeps Tauri's default app menu (quit,
        // copy / paste).
        .setup(move |app| {
            #[cfg(target_os = "linux")]
            force_light_gtk_theme();

            // Start the LAN relay on Tauri's async runtime.
            let st = state.clone();
            tauri::async_runtime::spawn(async move {
                relay::serve(st, http_listener, ws_listener).await;
            });

            // Load the desktop window from the local relay so window.location is
            // a real http origin (the existing LAN client code + the scoresheet
            // popups resolve correctly, and http://localhost keeps camera/QR).
            WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(format!("http://localhost:{http}/").parse().unwrap()),
            )
            .title("OpenVolley eScoresheet")
            .inner_size(1400.0, 900.0)
            .min_inner_size(1200.0, 700.0)
            // Light only (volleyui): a dark OS theme must not darken the
            // native title bar, pickers or scrollbars of the scoretable.
            .theme(Some(tauri::Theme::Light))
            .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// The light variant of a GTK theme name, or None when it is not a dark one:
/// "Yaru-dark" -> "Yaru", "Yaru-blue-dark" -> "Yaru-blue", "Adwaita-dark" ->
/// "Adwaita". Ubuntu's dark style switches the GTK 3 theme itself (not just
/// gtk-application-prefer-dark-theme), so Theme::Light alone left the title
/// bar, menus and scrollbars dark.
pub fn light_gtk_theme_name(name: &str) -> Option<String> {
    let lower = name.to_ascii_lowercase();
    for suffix in ["-dark", "_dark", ":dark"] {
        if lower.ends_with(suffix) && name.len() > suffix.len() {
            return Some(name[..name.len() - suffix.len()].to_string());
        }
    }
    None
}

/// Light only (volleyui): no dark variant and no dark GTK theme for the
/// window's title bar, pickers and scrollbars. GTK_THEME set by the user
/// still wins (GTK reads it before these settings).
///
/// Applied at startup and again whenever the desktop pushes a new style while
/// the app runs (XSETTINGS / the settings portal reset gtk-theme-name to
/// "Yaru-dark" when the user flips Ubuntu's style). Each handler only writes
/// when the value is dark, so its own write (now light) ends the loop.
#[cfg(target_os = "linux")]
fn force_light_gtk_theme() {
    use gtk::prelude::GtkSettingsExt;
    let Some(settings) = gtk::Settings::default() else { return };
    apply_light_gtk_settings(&settings);
    settings.connect_gtk_theme_name_notify(apply_light_gtk_settings);
    settings.connect_gtk_application_prefer_dark_theme_notify(apply_light_gtk_settings);
}

#[cfg(target_os = "linux")]
fn apply_light_gtk_settings(settings: &gtk::Settings) {
    use gtk::prelude::GtkSettingsExt;
    if settings.is_gtk_application_prefer_dark_theme() {
        settings.set_gtk_application_prefer_dark_theme(false);
    }
    if let Some(dark) = settings.gtk_theme_name() {
        if let Some(light) = light_gtk_theme_name(dark.as_str()) {
            eprintln!("[theme] GTK theme {dark} -> {light} (the scoretable is light only)");
            settings.set_gtk_theme_name(Some(&light));
        }
    }
}

/// Automatic match backups (see backup.rs; ACL in capabilities/backup.json).
fn with_backup_commands<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.invoke_handler(tauri::generate_handler![
        backup::backup_info,
        backup::backup_write,
        backup::backup_list,
        backup::backup_remove,
        backup::backup_open_dir,
        backup::backup_pick_file
    ])
}

fn run_server_only(http: u16, ws: u16) {
    let http_listener = std::net::TcpListener::bind(("0.0.0.0", http)).expect("bind http");
    let ws_listener = std::net::TcpListener::bind(("0.0.0.0", ws)).expect("bind ws");
    let state = relay::new_state(http, ws);
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    println!("relay listening: http :{http}  ws :{ws}  (server-only)");
    rt.block_on(relay::serve(state, http_listener, ws_listener));
}

#[cfg(test)]
mod tests {
    use super::light_gtk_theme_name;

    #[test]
    fn strips_the_dark_variant_of_a_gtk_theme() {
        assert_eq!(light_gtk_theme_name("Yaru-dark").as_deref(), Some("Yaru"));
        assert_eq!(light_gtk_theme_name("Yaru-blue-dark").as_deref(), Some("Yaru-blue"));
        assert_eq!(light_gtk_theme_name("Adwaita-dark").as_deref(), Some("Adwaita"));
        assert_eq!(light_gtk_theme_name("Pop-Dark").as_deref(), Some("Pop"));
        assert_eq!(light_gtk_theme_name("Adwaita:dark").as_deref(), Some("Adwaita"));
    }

    #[test]
    fn keeps_a_light_theme() {
        assert_eq!(light_gtk_theme_name("Yaru"), None);
        assert_eq!(light_gtk_theme_name("Adwaita"), None);
        assert_eq!(light_gtk_theme_name("Darkmode"), None);
        assert_eq!(light_gtk_theme_name("-dark"), None);
    }
}

/// The backup commands through the real IPC path and the app's real ACL
/// (build.rs app manifest + capabilities/*.json, from generate_context!), on
/// Tauri's mock runtime: what the scoretable page at http://localhost:<port>
/// may call, and what any other origin may not.
#[cfg(test)]
mod ipc_acl_tests {
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    fn request(cmd: &str, url: &str, body: serde_json::Value) -> InvokeRequest {
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: url.parse().unwrap(),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        }
    }

    #[test]
    fn scoretable_page_may_back_up_other_origins_may_not() {
        let root = std::env::temp_dir().join(format!("ov-backup-ipc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::env::set_var("OPENVOLLEY_BACKUP_DIR", &root);

        let app = super::with_backup_commands(mock_builder())
            .build(tauri::generate_context!())
            .expect("mock app");
        let window = WebviewWindowBuilder::new(&app, "main", WebviewUrl::External("http://localhost:5173/".parse().unwrap()))
            .build()
            .unwrap();
        let write = serde_json::json!({
            "matchDir": "game7-match_1759740000000_ab12cd",
            "fileName": "20261006T100000.000Z-00001.json",
            "contents": "{\"version\":1}",
            "latest": true
        });

        // the scoretable page (served by the built-in server)
        let res = get_ipc_response(&window, request("backup_write", "http://localhost:5173/", write.clone()));
        assert!(res.is_ok(), "localhost refused: {res:?}");
        let dir = root.join("game7-match_1759740000000_ab12cd");
        assert_eq!(std::fs::read_to_string(dir.join("20261006T100000.000Z-00001.json")).unwrap(), "{\"version\":1}");
        assert!(dir.join("latest.json").is_file());
        let listed = get_ipc_response(&window, request("backup_list", "http://localhost:5173/?match=1", serde_json::json!({})))
            .expect("list")
            .deserialize::<serde_json::Value>()
            .unwrap();
        assert_eq!(listed[0]["dir"], "game7-match_1759740000000_ab12cd");

        // anything else: a LAN address, another site, a look-alike host
        for url in ["http://192.168.1.20:5173/", "https://example.com/", "http://localhost.evil.com:5173/"] {
            for cmd in ["backup_write", "backup_list", "backup_remove", "backup_info"] {
                let err = get_ipc_response(&window, request(cmd, url, write.clone()))
                    .expect_err(&format!("{cmd} from {url} must be refused"));
                assert!(err.to_string().contains("not allowed"), "{cmd} from {url}: refused by the ACL, got {err}");
            }
        }
        let _ = std::fs::remove_dir_all(&root);
    }
}
