// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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

    let state = relay::new_state(http, ws);

    tauri::Builder::default()
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
