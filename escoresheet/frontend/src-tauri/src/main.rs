// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backup;
mod firewall;
mod flavour;
mod lifecycle;
mod netifs;
mod netshare;
mod popups;
mod relay;
mod updater;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

// OpenVolley 5173 / 8080, OpenBeach 5174 / 8081 (flavour.rs)
const DEFAULT_HTTP_PORT: u16 = flavour::CURRENT.http_port;
const DEFAULT_WS_PORT: u16 = flavour::CURRENT.ws_port;

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

    // The cloud backend's CORS trusts the desktop window on its default port
    // only (5173; OpenBeach 5174):
    // on another port the app runs the venue as usual and says "Cloud sync
    // unavailable on port N" (isCloudBlockedOnThisPort in backendConfig.js).
    if http != DEFAULT_HTTP_PORT {
        eprintln!("OPENVOLLEY_HTTP_PORT={http}: cloud sync needs port {DEFAULT_HTTP_PORT}; the tablets keep working");
    }

    let state = relay::new_state(http, ws);

    // One app per computer: a second launch (the app is in the tray, the
    // scorer clicks its icon again) shows the running one and exits, before
    // it would fail on the relay's ports. Registered first, so it runs before
    // anything else.
    //
    // `--quit` (the Windows installer and uninstaller, windows/installer-hooks.nsh,
    // after they asked the user): the running app quits cleanly, so the
    // tablets' Wi-Fi is switched off and the user's hotspot settings come
    // back. Without it the installer ended the app with TerminateProcess.
    let mut builder = tauri::Builder::default();
    if single_instance_available() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if argv.iter().any(|a| a == lifecycle::QUIT_ARG) {
                lifecycle::os_exit(app, "the installer asked (--quit)");
                return;
            }
            eprintln!("[app] started again: showing the running app");
            lifecycle::show_windows(app);
        }));
    }

    with_app_commands(builder.plugin(tauri_plugin_dialog::init()))
        // No native menu bar on Linux / Windows: it held only Help > Connect a
        // Tablet and rendered in the GTK system theme (dark on a dark desktop).
        // The app's own header menu has Connect tablets (LAN addresses + QR),
        // help and the version. macOS keeps Tauri's default app menu (quit,
        // copy / paste).
        .setup(move |app| {
            // `--quit` and no running app to hand it to: only undo a tablet
            // Wi-Fi a crashed run left on (Windows), then exit, before the
            // ports are bound or a window opens.
            if std::env::args().any(|a| a == lifecycle::QUIT_ARG) {
                eprintln!("[app] --quit: {} is not running", flavour::CURRENT.name);
                netshare::recover_now();
                std::process::exit(0);
            }

            // Bind the ports synchronously so the window can't race ahead of
            // the server (a queued connection is fine; a refused one would
            // blank the window). Here, after the single-instance check: a
            // second launch never gets this far.
            let http_listener = std::net::TcpListener::bind(("0.0.0.0", http)).unwrap_or_else(|e| {
                eprintln!("Cannot bind HTTP port {http}: {e}");
                std::process::exit(1);
            });
            let ws_listener = std::net::TcpListener::bind(("0.0.0.0", ws)).unwrap_or_else(|e| {
                eprintln!("Cannot bind WebSocket port {ws}: {e}");
                std::process::exit(1);
            });

            #[cfg(target_os = "linux")]
            force_light_gtk_theme();

            // A tablet Wi-Fi a crashed run left on (Windows) goes off.
            netshare::recover(app.handle());

            // Start the LAN relay on Tauri's async runtime.
            let st = state.clone();
            tauri::async_runtime::spawn(async move {
                relay::serve(st, http_listener, ws_listener).await;
            });

            // Closing the window hides it to the tray (lifecycle.rs); its
            // status line counts the tablets, and so does the update gate
            // (updater.rs: no restart while a tablet is connected), with or
            // without a tray.
            lifecycle::create_tray(app.handle());
            {
                let st = state.clone();
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        lifecycle::set_tablet_count(&handle, relay::tablet_count(&st).await);
                        // the tray's "Restart to update" follows the gate
                        updater::push(&handle);
                        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    }
                });
            }
            lifecycle::quit_on_signals(app.handle());
            // automatic updates: the first check a minute after the page
            // loaded, never during a match (updater.rs)
            updater::start(app.handle().clone());

            // Load the desktop window from the local relay so window.location is
            // a real http origin (the existing LAN client code + the scoresheet
            // popups resolve correctly, and http://localhost keeps camera/QR).
            let main = WebviewWindowBuilder::new(
                app,
                lifecycle::MAIN,
                WebviewUrl::External(format!("http://localhost:{http}/").parse().unwrap()),
            )
            .title(flavour::CURRENT.window_title)
            .inner_size(1400.0, 900.0)
            .min_inner_size(1200.0, 700.0)
            // Light only (volleyui): a dark OS theme must not darken the
            // native title bar, pickers or scrollbars of the scoretable.
            .theme(Some(tauri::Theme::Light))
            // window.open(): the scoresheet etc. as app windows, web links in
            // the system browser (popups.rs); "Save PDF" into Downloads.
            .on_new_window(popups::new_window_handler(app.handle().clone(), http))
            .on_download(popups::on_download)
            // a (re)loading page cannot answer "close" / "quit" until it has
            // called app_page_state again
            .on_page_load(|window, payload| {
                if payload.event() == tauri::webview::PageLoadEvent::Started {
                    lifecycle::page_load_started(window.app_handle());
                }
            })
            .build()?;
            popups::let_scripts_open_windows(&main);
            // The close button / Alt+F4 hides the scoretable (and its
            // scoresheet windows) to the tray: the relay and the tablets'
            // network keep running. Quitting is "Quit OpenVolley…" and a
            // confirmation (lifecycle.rs).
            //
            // Should the window still be destroyed (by the OS), its scoresheet
            // windows go with it and the app quits: Tauri only exits when the
            // last window is gone, so a scoresheet left open kept the process,
            // the LAN relay and ports 5173 / 8080 alive, and the next launch
            // then failed with "Cannot bind HTTP port".
            let handle = app.handle().clone();
            main.on_window_event(move |event| match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if lifecycle::on_close_requested(&handle) {
                        api.prevent_close();
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    popups::close_app_windows(&handle);
                    handle.exit(0);
                }
                _ => {}
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // Only a confirmed quit, the OS or a scoretable window that is
            // gone ends the app; any other exit becomes the question.
            // A restart into an update (updater.rs) is never asked: the
            // gate was checked before.
            tauri::RunEvent::ExitRequested { code: Some(tauri::RESTART_EXIT_CODE), .. } => {}
            tauri::RunEvent::ExitRequested { api, .. } => {
                if lifecycle::on_exit_requested(app) {
                    api.prevent_exit();
                }
            }
            // Quitting: the tablets' Wi-Fi / Bluetooth network goes down with
            // the app (and the user's own hotspot settings come back).
            tauri::RunEvent::Exit => netshare::shutdown(app),
            _ => {}
        });
}

/// tauri-plugin-single-instance needs the session bus on Linux (it unwraps
/// a malformed DBUS_SESSION_BUS_ADDRESS). Without one the app still starts;
/// a second launch then fails on the busy ports as before.
fn single_instance_available() -> bool {
    #[cfg(target_os = "linux")]
    {
        if let Err(e) = zbus::Address::session() {
            eprintln!("[app] no session bus ({e}): a second launch is not redirected to this one");
            return false;
        }
    }
    true
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

/// The scoretable window's native commands: automatic match backups
/// (backup.rs; ACL in capabilities/backup.json), the networks the laptop
/// creates for the tablets (netshare/; capabilities/netshare.json) and the
/// check of the installer's firewall rule (firewall.rs; same capability) and
/// the close-to-tray / quit handshake (lifecycle.rs, and the list of the
/// scoresheet windows a quit closes, popups.rs; capabilities/app.json) and
/// the automatic updates (updater.rs; capabilities/update.json; the updater
/// plugin's own commands are granted to no window) and opening / showing a
/// file the app downloaded (popups.rs; capabilities/downloads.json, also for the
/// scoresheet windows). One invoke handler: a second call would replace the first.
fn with_app_commands<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(netshare::NetShare::new())
        .manage(lifecycle::Lifecycle::new())
        .manage(updater::Updates::new())
        .invoke_handler(tauri::generate_handler![
        backup::backup_info,
        backup::backup_write,
        backup::backup_list,
        backup::backup_remove,
        backup::backup_open_dir,
        backup::backup_pick_file,
        netshare::hotspot_status,
        netshare::hotspot_start,
        netshare::hotspot_stop,
        netshare::bluetooth_status,
        netshare::bluetooth_start,
        netshare::bluetooth_stop,
        firewall::firewall_status,
        lifecycle::app_page_state,
        lifecycle::app_page_gone,
        lifecycle::app_hide,
        lifecycle::app_quit,
        lifecycle::app_quit_ack,
        lifecycle::app_quit_cancel,
        popups::app_windows,
        updater::update_status,
        updater::update_check_now,
        updater::update_install_now,
        updater::update_set_prefs,
        popups::download_open,
        popups::download_reveal
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

        let app = super::with_app_commands(mock_builder())
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

    /// A scoresheet window (window.open of /scoresheet/, label "popup-<n>",
    /// popups.rs) loads the same http://localhost origin as the scoretable,
    /// so only the capabilities naming "main" keep the backup and tablet-network
    /// commands from it. A later `"windows": ["*"]` or a new capability must fail here.
    #[test]
    fn scoresheet_windows_may_not_back_up() {
        let app = super::with_app_commands(mock_builder())
            .build(tauri::generate_context!())
            .expect("mock app");
        let label = crate::popups::next_popup_label();
        let popup = WebviewWindowBuilder::new(&app, label.as_str(), WebviewUrl::External("http://localhost:5173/scoresheet/".parse().unwrap()))
            .build()
            .unwrap();
        let body = serde_json::json!({
            "matchDir": "game7-match_1759740000000_ab12cd",
            "fileName": "20261006T100000.000Z-00001.json",
            "contents": "{}",
            "latest": true
        });
        for cmd in ["backup_info", "backup_write", "backup_list", "backup_remove", "backup_open_dir", "backup_pick_file",
                    "hotspot_status", "hotspot_start", "hotspot_stop", "bluetooth_status", "bluetooth_start", "bluetooth_stop",
                    "firewall_status",
                    "app_page_state", "app_page_gone", "app_hide", "app_quit", "app_quit_ack",
                    "app_quit_cancel", "app_windows",
                    "update_status", "update_check_now", "update_install_now", "update_set_prefs"] {
            let err = get_ipc_response(&popup, request(cmd, "http://localhost:5173/scoresheet/?matchId=7", body.clone()))
                .expect_err(&format!("{cmd} from {label} must be refused"));
            assert!(err.to_string().contains("not allowed"), "{cmd} from {label}: refused by the ACL, got {err}");
        }
    }

    /// "Open file" / "Show in folder" after the scoresheet's Save PDF: the
    /// scoresheet window (popup-<n>) and the scoretable may ask for a download
    /// the app recorded, by its id; never another origin, and never a path.
    #[test]
    fn scoresheet_windows_may_open_their_downloads_only() {
        let app = super::with_app_commands(mock_builder())
            .build(tauri::generate_context!())
            .expect("mock app");
        let label = crate::popups::next_popup_label();
        let popup = WebviewWindowBuilder::new(&app, label.as_str(), WebviewUrl::External("http://localhost:5173/scoresheet/".parse().unwrap()))
            .build()
            .unwrap();
        let main = WebviewWindowBuilder::new(&app, "main", WebviewUrl::External("http://localhost:5173/".parse().unwrap()))
            .build()
            .unwrap();
        let unknown = serde_json::json!({ "id": u64::MAX });
        for (window, url) in [(&popup, "http://localhost:5173/scoresheet/?matchId=7&action=save"), (&main, "http://localhost:5173/")] {
            for cmd in ["download_open", "download_reveal"] {
                // through the ACL into the command, which knows no such download
                let err = get_ipc_response(window, request(cmd, url, unknown.clone()))
                    .expect_err(&format!("{cmd}: an unknown id is refused"));
                assert!(err.to_string().contains("unknown download"), "{cmd} from {url}: refused by the command, got {err}");
            }
        }
        // a path instead of an id never reaches a file
        let err = get_ipc_response(&popup, request("download_open", "http://localhost:5173/scoresheet/", serde_json::json!({ "path": "/etc/passwd" })))
            .expect_err("a path is not an id");
        assert!(!err.to_string().contains("not allowed"), "reached the command (bad arguments): {err}");
        // a tablet on the LAN, another site, a look-alike host: the ACL refuses
        for url in ["http://192.168.1.20:5173/scoresheet/", "https://example.com/", "http://localhost.evil.com:5173/"] {
            for cmd in ["download_open", "download_reveal"] {
                let err = get_ipc_response(&popup, request(cmd, url, unknown.clone()))
                    .expect_err(&format!("{cmd} from {url} must be refused"));
                assert!(err.to_string().contains("not allowed"), "{cmd} from {url}: refused by the ACL, got {err}");
            }
        }
        // a window that is neither the scoretable nor a scoresheet window
        let other = WebviewWindowBuilder::new(&app, "settings", WebviewUrl::External("http://localhost:5173/".parse().unwrap()))
            .build()
            .unwrap();
        let err = get_ipc_response(&other, request("download_open", "http://localhost:5173/", unknown.clone()))
            .expect_err("download_open from an unnamed window must be refused");
        assert!(err.to_string().contains("not allowed"), "got {err}");
    }

    /// Close to tray / quit: the scoretable page reports its state; a tablet,
    /// another site or a look-alike host may not hide or quit the app.
    #[test]
    fn only_the_scoretable_page_may_hide_or_quit_the_app() {
        let app = super::with_app_commands(mock_builder())
            .build(tauri::generate_context!())
            .expect("mock app");
        let window = WebviewWindowBuilder::new(&app, "main", WebviewUrl::External("http://localhost:5173/".parse().unwrap()))
            .build()
            .unwrap();

        let state = serde_json::json!({ "handler": "h1", "labels": { "show": "OpenVolley anzeigen" }, "live": "official" });
        let info = get_ipc_response(&window, request("app_page_state", "http://localhost:5173/", state.clone()))
            .expect("the scoretable page reports its state")
            .deserialize::<serde_json::Value>()
            .unwrap();
        assert_eq!(info["tray"], false, "no tray icon in the mock app");
        // the page's handler goes away (error screen) and takes a quit request
        get_ipc_response(&window, request("app_quit_ack", "http://localhost:5173/", serde_json::json!({})))
            .expect("the scoretable page acknowledges a quit request");
        get_ipc_response(&window, request("app_page_gone", "http://localhost:5173/", serde_json::json!({ "handler": "h1" })))
            .expect("the scoretable page says its handler is gone");
        // Keep running: the scoresheet windows hidden with it come back
        get_ipc_response(&window, request("app_quit_cancel", "http://localhost:5173/", serde_json::json!({})))
            .expect("the scoretable page says the quit was cancelled");

        // the quit question lists the other app windows (the scoresheets), hidden ones too
        let none = get_ipc_response(&window, request("app_windows", "http://localhost:5173/", serde_json::json!({})))
            .expect("app_windows from the scoretable page")
            .deserialize::<Vec<String>>()
            .unwrap();
        assert!(none.is_empty(), "no scoresheet window yet: {none:?}");
        for _ in 0..2 {
            let label = crate::popups::next_popup_label();
            let popup = WebviewWindowBuilder::new(&app, label.as_str(), WebviewUrl::External("http://localhost:5173/scoresheet/".parse().unwrap()))
                .build()
                .unwrap();
            let _ = popup.hide();
        }
        let windows = get_ipc_response(&window, request("app_windows", "http://localhost:5173/", serde_json::json!({})))
            .expect("app_windows from the scoretable page")
            .deserialize::<Vec<String>>()
            .unwrap();
        assert_eq!(windows.len(), 2, "both scoresheet windows, not the scoretable: {windows:?}");

        for url in ["http://192.168.1.20:5173/", "http://10.42.0.1:5173/", "https://example.com/", "http://localhost.evil.com:5173/"] {
            for cmd in ["app_page_state", "app_page_gone", "app_hide", "app_quit", "app_quit_ack", "app_quit_cancel", "app_windows"] {
                let err = get_ipc_response(&window, request(cmd, url, state.clone()))
                    .expect_err(&format!("{cmd} from {url} must be refused"));
                assert!(err.to_string().contains("not allowed"), "{cmd} from {url}: refused by the ACL, got {err}");
            }
        }
    }

    /// Updates: the scoretable page reads the status, asks for a check,
    /// changes the settings and asks to restart (refused by the Rust gate
    /// while the page has not reported itself); the updater plugin's own
    /// commands (download, install) are granted to no window at all.
    #[test]
    fn only_the_scoretable_page_may_ask_for_updates_and_never_through_the_plugin() {
        let app = super::with_app_commands(mock_builder())
            .build(tauri::generate_context!())
            .expect("mock app");
        let window = WebviewWindowBuilder::new(&app, "main", WebviewUrl::External("http://localhost:5173/".parse().unwrap()))
            .build()
            .unwrap();
        let local = "http://localhost:5173/";
        let status = get_ipc_response(&window, request("update_status", local, serde_json::json!({})))
            .expect("update_status from the scoretable page")
            .deserialize::<serde_json::Value>()
            .unwrap();
        assert_eq!(status["kind"], "unsupported", "a test build has no bundle type: got {status}");
        // the app's version (tauri config "version": OpenVolley's package.json,
        // OpenBeach's own), not the crate's
        assert_eq!(status["current"], app.package_info().version.to_string());
        assert_eq!(status["autoCheck"], true);
        get_ipc_response(&window, request("update_check_now", local, serde_json::json!({ "reason": "manual" })))
            .expect("update_check_now from the scoretable page");
        let prefs = get_ipc_response(&window, request("update_set_prefs", local, serde_json::json!({ "autoInstall": false })))
            .expect("update_set_prefs from the scoretable page")
            .deserialize::<serde_json::Value>()
            .unwrap();
        assert_eq!((prefs["autoCheck"].as_bool(), prefs["autoInstall"].as_bool()), (Some(true), Some(false)));
        // reaches the command; its gate refuses (the page never reported itself)
        let err = get_ipc_response(&window, request("update_install_now", local, serde_json::json!({})))
            .expect_err("no restart while the page is not ready");
        assert_eq!(err["code"], "blocked", "got {err}");
        assert_eq!(err["blockers"][0]["kind"], "pageNotReady", "got {err}");

        let plugin = ["plugin:updater|check", "plugin:updater|download", "plugin:updater|install", "plugin:updater|download_and_install"];
        for cmd in plugin {
            let err = get_ipc_response(&window, request(cmd, local, serde_json::json!({})))
                .expect_err(&format!("{cmd} must be refused even to the scoretable page"));
            assert!(err.to_string().contains("not allowed"), "{cmd}: refused by the ACL, got {err}");
        }
        let ours = ["update_status", "update_check_now", "update_install_now", "update_set_prefs"];
        for url in ["http://192.168.1.20:5173/", "http://10.42.0.1:5173/", "https://example.com/", "http://localhost.evil.com:5173/"] {
            for cmd in ours.iter().chain(plugin.iter()) {
                let err = get_ipc_response(&window, request(cmd, url, serde_json::json!({})))
                    .expect_err(&format!("{cmd} from {url} must be refused"));
                assert!(err.to_string().contains("not allowed"), "{cmd} from {url}: refused by the ACL, got {err}");
            }
        }
    }

    #[test]
    fn only_the_scoretable_page_may_start_a_tablet_network() {
        let app = super::with_app_commands(mock_builder())
            .build(tauri::generate_context!())
            .expect("mock app");
        let window = WebviewWindowBuilder::new(&app, "main", WebviewUrl::External("http://localhost:5173/".parse().unwrap()))
            .build()
            .unwrap();

        // the scoretable page reaches the command; bad input is refused by the
        // command itself (strict checks), before any system call
        let pass = "x".repeat(8);
        let bad = serde_json::json!({ "ssid": "x;$(reboot)", "password": pass });
        let err = get_ipc_response(&window, request("hotspot_start", "http://localhost:5173/", bad.clone()))
            .expect_err("invalid name refused");
        assert_eq!(err["code"], "invalid-credentials", "got {err}");
        let half = serde_json::json!({ "ssid": "OpenVolley-AB12" });
        let err = get_ipc_response(&window, request("hotspot_start", "http://localhost:5173/", half))
            .expect_err("name without password refused");
        assert_eq!(err["code"], "invalid-credentials", "got {err}");

        // the firewall check answers the scoretable page (off Windows: nothing to check)
        let fw = get_ipc_response(&window, request("firewall_status", "http://localhost:5173/", serde_json::json!({})))
            .expect("firewall_status from the scoretable page")
            .deserialize::<serde_json::Value>()
            .unwrap();
        assert_eq!(fw["supported"], cfg!(windows), "got {fw}");
        assert!(fw.get("ready").is_some(), "got {fw}");

        // a tablet on the LAN, another site, a look-alike host: the ACL refuses
        let cmds = ["hotspot_status", "hotspot_start", "hotspot_stop", "bluetooth_status", "bluetooth_start", "bluetooth_stop", "firewall_status"];
        for url in ["http://192.168.1.20:5173/", "http://10.42.0.1:5173/", "https://example.com/", "http://localhost.evil.com:5173/"] {
            for cmd in cmds {
                let err = get_ipc_response(&window, request(cmd, url, bad.clone()))
                    .expect_err(&format!("{cmd} from {url} must be refused"));
                assert!(err.to_string().contains("not allowed"), "{cmd} from {url}: refused by the ACL, got {err}");
            }
        }
    }
}
