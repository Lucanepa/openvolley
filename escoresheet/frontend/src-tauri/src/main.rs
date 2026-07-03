// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
            .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
