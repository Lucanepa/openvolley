// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backup;
mod relay;

use tauri::menu::{Menu, MenuItem, Submenu};
use tauri::{WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

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

    let state = relay::new_state(http, ws);

    with_backup_commands(tauri::Builder::default().plugin(tauri_plugin_dialog::init()))
        .menu(|handle| {
            let tablet = MenuItem::with_id(handle, "connect_tablet", "Connect a Tablet…", true, None::<&str>)?;
            let help = Submenu::with_items(handle, "Help", true, &[&tablet])?;
            Menu::with_items(handle, &[&help])
        })
        .on_menu_event(move |app, event| {
            if event.id() == "connect_tablet" {
                let ip = relay::local_ip_string();
                let msg = format!(
                    "Tablets on the same Wi-Fi can open:\n\n\
                     Scoretable:  http://{ip}:{http}/\n\
                     Referee:     http://{ip}:{http}/referee\n\
                     Bench:       http://{ip}:{http}/bench\n\
                     Livescore:   http://{ip}:{http}/livescore\n\n\
                     The tablet must be on the same Wi-Fi/LAN as this computer.\n\
                     (Camera/QR scanning works on this desktop, not on tablets over plain HTTP.)"
                );
                app.dialog()
                    .message(msg)
                    .title("Connect a Tablet")
                    .show(|_| {});
            }
        })
        .setup(move |app| {
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
            .title("Openvolley eScoresheet")
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
