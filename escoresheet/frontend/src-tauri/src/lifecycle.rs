//! The app keeps running when its window is closed, and quits only after the
//! scorer confirmed it.
//!
//! The scoretable is also the server of the tablets (relay.rs) and may run
//! their network (netshare/): closing the window by habit (the close button,
//! Alt+F4) must not take the referee, bench and livescore tablets down.
//!
//! - **Close** (the window's close button, Alt+F4): the scoretable and its
//!   scoresheet windows hide to the tray icon; the relay, the tablets'
//!   Wi-Fi / Bluetooth and the match stay as they are. The first close of a
//!   run asks the page first, which says "OpenVolley keeps running in the
//!   tray" and then hides (`app_hide`). Without a tray (Linux without a
//!   StatusNotifier host, or without libayatana-appindicator3) the window is
//!   minimised instead, so it can never become unreachable.
//! - **Tray icon**: a click shows the window (Windows; on Linux a click opens
//!   the menu), menu: Show OpenVolley, a status line (tablets connected,
//!   match in progress), Quit OpenVolley…. The page sends its translated
//!   labels (`app_page_state`); until then they are English.
//! - **Quit** (tray menu, the page's header menu): the window comes back and
//!   the page asks (askConfirm, danger). Only its `app_quit` exits; the exit
//!   then stops the tablets' network (RunEvent::Exit in main.rs) as before.
//! - **The OS ends the session**: never blocked. Windows ends the event loop
//!   on WM_ENDSESSION (tao), which is RunEvent::Exit, not ExitRequested.
//!   Linux: SIGTERM / SIGINT / SIGHUP quit at once (`os_exit`), with a
//!   watchdog in case the event loop no longer answers.
//! - **Second launch**: tauri-plugin-single-instance hands it to this one,
//!   which shows its window (main.rs).
//!
//! The decisions are in [`ExitGate`] (plain data, unit-tested); the rest
//! applies them to the windows.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime, State, WebviewWindow};

pub const MAIN: &str = "main";
pub const TRAY_ID: &str = "openvolley";
const MENU_SHOW: &str = "ov-show";
const MENU_STATUS: &str = "ov-status";
const MENU_QUIT: &str = "ov-quit";

/// What closing the scoretable window does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    /// The first close of a run: the page shows its notice, then hides.
    AskPage,
    /// Hide the windows to the tray icon.
    Hide,
    /// No tray icon: minimise, so the window stays reachable.
    Minimize,
    /// The app is quitting: let the window close.
    Close,
}

/// What "Quit OpenVolley…" does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitAction {
    /// Show the window and let the page ask.
    AskPage,
    /// Exit now (confirmed, the OS asked, or no page that could ask).
    Exit,
}

/// Whether an exit the event loop reports may go ahead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitDecision {
    Proceed,
    Prevent,
}

/// The close / quit rules.
#[derive(Debug, Default)]
pub struct ExitGate {
    /// The scorer confirmed "Quit OpenVolley?" in the page.
    quit_confirmed: bool,
    /// The OS is ending the app (logout, shutdown, a terminating signal).
    os_exit: bool,
    /// The tray icon exists.
    tray: bool,
    /// The scoretable page has loaded and handles the lifecycle events.
    page_ready: bool,
    /// The first-close notice was asked for this run.
    notice_asked: bool,
}

impl ExitGate {
    pub fn new(tray: bool) -> Self {
        Self { tray, ..Self::default() }
    }

    fn exiting(&self) -> bool {
        self.quit_confirmed || self.os_exit
    }

    pub fn has_tray(&self) -> bool {
        self.tray
    }

    pub fn set_tray(&mut self, tray: bool) {
        self.tray = tray;
    }

    pub fn set_page_ready(&mut self, ready: bool) {
        self.page_ready = ready;
    }

    /// Hide or minimise: what "out of the way, still running" is here.
    pub fn hide_action(&self) -> CloseAction {
        if self.tray {
            CloseAction::Hide
        } else {
            CloseAction::Minimize
        }
    }

    /// The scoretable window's close button / Alt+F4.
    pub fn close_requested(&mut self) -> CloseAction {
        if self.exiting() {
            return CloseAction::Close;
        }
        // The page shows the notice once per run. A page that does not answer
        // (still loading, stuck) only delays the hide to the next close.
        if self.page_ready && !self.notice_asked {
            self.notice_asked = true;
            return CloseAction::AskPage;
        }
        self.hide_action()
    }

    /// "Quit OpenVolley…" in the tray menu, or an exit nobody confirmed.
    pub fn quit_requested(&self) -> QuitAction {
        // Without a loaded page nobody could answer: a blank or broken window
        // must not make the app impossible to quit (the match is in IndexedDB).
        if self.exiting() || !self.page_ready {
            QuitAction::Exit
        } else {
            QuitAction::AskPage
        }
    }

    /// The page's confirm dialog was answered with Quit.
    pub fn confirm_quit(&mut self) {
        self.quit_confirmed = true;
    }

    /// The OS ends the app (logout / shutdown / SIGTERM).
    #[cfg_attr(not(unix), allow(dead_code))] // Windows: WM_ENDSESSION is RunEvent::Exit
    pub fn os_exit(&mut self) {
        self.os_exit = true;
    }

    /// RunEvent::ExitRequested. Prevented only while the scoretable window
    /// still exists and nobody confirmed: such an exit is turned into the
    /// question instead. Once the window is gone (the OS destroyed it) the
    /// app cannot be reached any more, so it quits.
    pub fn exit_requested(&self, main_window_open: bool) -> ExitDecision {
        if self.exiting() || !main_window_open {
            ExitDecision::Proceed
        } else {
            ExitDecision::Prevent
        }
    }
}

/// The tray texts, in the page's language (`app_page_state`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TrayLabels {
    pub tooltip: String,
    pub show: String,
    pub quit: String,
    pub no_tablets: String,
    pub one_tablet: String,
    /// "{{count}} tablets connected"
    pub tablets: String,
    pub match_live: String,
    pub test_match_live: String,
}

impl Default for TrayLabels {
    fn default() -> Self {
        Self {
            tooltip: "OpenVolley eScoresheet".into(),
            show: "Show OpenVolley".into(),
            quit: "Quit OpenVolley…".into(),
            no_tablets: "No tablets connected".into(),
            one_tablet: "1 tablet connected".into(),
            tablets: "{{count}} tablets connected".into(),
            match_live: "Match in progress".into(),
            test_match_live: "Test match in progress".into(),
        }
    }
}

/// At most this many characters per label; no control characters.
const MAX_LABEL: usize = 80;

fn clean_label(s: &str, fallback: &str) -> String {
    let s: String = s.chars().filter(|c| !c.is_control()).take(MAX_LABEL).collect();
    let s = s.trim();
    if s.is_empty() {
        fallback.to_string()
    } else {
        s.to_string()
    }
}

impl TrayLabels {
    /// The page's labels with the English ones for anything empty, cut to
    /// MAX_LABEL characters.
    pub fn cleaned(&self) -> Self {
        let d = Self::default();
        Self {
            tooltip: clean_label(&self.tooltip, &d.tooltip),
            show: clean_label(&self.show, &d.show),
            quit: clean_label(&self.quit, &d.quit),
            no_tablets: clean_label(&self.no_tablets, &d.no_tablets),
            one_tablet: clean_label(&self.one_tablet, &d.one_tablet),
            tablets: clean_label(&self.tablets, &d.tablets),
            match_live: clean_label(&self.match_live, &d.match_live),
            test_match_live: clean_label(&self.test_match_live, &d.test_match_live),
        }
    }

    /// The tray's status line: "2 tablets connected · Match in progress".
    pub fn status_line(&self, tablets: usize, live: MatchLive) -> String {
        let tablets = match tablets {
            0 => self.no_tablets.clone(),
            1 => self.one_tablet.clone(),
            n => self.tablets.replace("{{count}}", &n.to_string()),
        };
        match live {
            MatchLive::None => tablets,
            MatchLive::Official => format!("{tablets} · {}", self.match_live),
            MatchLive::Test => format!("{tablets} · {}", self.test_match_live),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MatchLive {
    #[default]
    None,
    Official,
    Test,
}

/// Managed state: the gate, the tray texts and the windows hidden with the
/// scoretable.
pub struct Lifecycle {
    gate: Mutex<ExitGate>,
    labels: Mutex<TrayLabels>,
    live: Mutex<MatchLive>,
    tablets: Mutex<usize>,
    hidden_popups: Mutex<Vec<String>>,
}

impl Lifecycle {
    pub fn new() -> Self {
        Self {
            gate: Mutex::new(ExitGate::new(false)),
            labels: Mutex::new(TrayLabels::default()),
            live: Mutex::new(MatchLive::None),
            tablets: Mutex::new(0),
            hidden_popups: Mutex::new(Vec::new()),
        }
    }

    pub fn gate(&self) -> std::sync::MutexGuard<'_, ExitGate> {
        self.gate.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn labels(&self) -> TrayLabels {
        self.labels.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn status_line(&self) -> String {
        let tablets = *self.tablets.lock().unwrap_or_else(|e| e.into_inner());
        let live = *self.live.lock().unwrap_or_else(|e| e.into_inner());
        self.labels().status_line(tablets, live)
    }
}

impl Default for Lifecycle {
    fn default() -> Self {
        Self::new()
    }
}

/// The tray menu items whose text changes (language, status).
struct TrayItems<R: Runtime> {
    show: MenuItem<R>,
    status: MenuItem<R>,
    quit: MenuItem<R>,
}

/// The page's lifecycle event (src/utils/desktopLifecycle.js listens).
fn page_event_script(kind: &str) -> String {
    let detail = serde_json::json!({ "type": kind });
    format!("window.dispatchEvent(new CustomEvent('ov-app-lifecycle', {{ detail: {detail} }}))")
}

fn main_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window(MAIN)
}

/// The scoretable (and the scoresheet windows hidden with it) back on screen,
/// in front.
pub fn show_windows<R: Runtime>(app: &AppHandle<R>) {
    let Some(main) = main_window(app) else { return };
    let _ = main.show();
    let _ = main.unminimize();
    let _ = main.set_focus();
    let hidden = std::mem::take(&mut *app.state::<Lifecycle>().hidden_popups.lock().unwrap_or_else(|e| e.into_inner()));
    for label in hidden {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.show();
        }
    }
    // the scoretable stays in front of its scoresheets
    let _ = main.set_focus();
}

/// Out of the way, still running: hidden to the tray, or minimised without one.
pub fn hide_windows<R: Runtime>(app: &AppHandle<R>) {
    let action = app.state::<Lifecycle>().gate().hide_action();
    let Some(main) = main_window(app) else { return };
    if action == CloseAction::Minimize {
        let _ = main.minimize();
        return;
    }
    let mut hidden = Vec::new();
    for (label, window) in app.webview_windows() {
        if crate::popups::is_popup_label(&label) && window.is_visible().unwrap_or(false) {
            let _ = window.hide();
            hidden.push(label);
        }
    }
    app.state::<Lifecycle>().hidden_popups.lock().unwrap_or_else(|e| e.into_inner()).extend(hidden);
    let _ = main.hide();
}

/// The scoretable window's close button / Alt+F4: returns true when the close
/// must be prevented.
pub fn on_close_requested<R: Runtime>(app: &AppHandle<R>) -> bool {
    let action = app.state::<Lifecycle>().gate().close_requested();
    match action {
        CloseAction::Close => false,
        CloseAction::AskPage => {
            // in front of its scoresheet windows: the notice is in this one
            let main = main_window(app);
            if let Some(w) = &main {
                let _ = w.set_focus();
            }
            match main.map(|w| w.eval(page_event_script("close-requested"))) {
                Some(Ok(())) => {}
                _ => hide_windows(app),
            }
            true
        }
        CloseAction::Hide | CloseAction::Minimize => {
            hide_windows(app);
            true
        }
    }
}

/// "Quit OpenVolley…": the window comes back and the page asks; without a
/// page that could ask, the app exits.
pub fn request_quit<R: Runtime>(app: &AppHandle<R>) {
    let action = app.state::<Lifecycle>().gate().quit_requested();
    if action == QuitAction::AskPage {
        show_windows(app);
        if let Some(main) = main_window(app) {
            if main.eval(page_event_script("quit-requested")).is_ok() {
                return;
            }
        }
    }
    app.state::<Lifecycle>().gate().confirm_quit();
    app.exit(0);
}

/// RunEvent::ExitRequested: true when the exit must be prevented (the
/// question is asked instead).
pub fn on_exit_requested<R: Runtime>(app: &AppHandle<R>) -> bool {
    let open = main_window(app).is_some();
    let decision = app.state::<Lifecycle>().gate().exit_requested(open);
    if decision == ExitDecision::Prevent {
        eprintln!("[app] exit without confirmation: asking the scorer");
        let app = app.clone();
        // not from inside the event loop's own callback
        let _ = std::thread::spawn(move || request_quit(&app));
        return true;
    }
    false
}

/// The OS ends the app: never blocked.
#[cfg_attr(not(unix), allow(dead_code))]
pub fn os_exit<R: Runtime>(app: &AppHandle<R>, why: &str) {
    eprintln!("[app] {why}: quitting");
    app.state::<Lifecycle>().gate().os_exit();
    app.exit(0);
}

/// Linux: SIGTERM (logout, shutdown, `kill`), SIGINT and SIGHUP quit cleanly
/// (the tablets' network is stopped by RunEvent::Exit). A second signal, or an
/// event loop that does not exit within 10 s, ends the process at once, so a
/// session end is never held up.
#[cfg(unix)]
pub fn quit_on_signals<R: Runtime>(app: &AppHandle<R>) {
    use tokio::signal::unix::{signal, SignalKind};
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let (Ok(mut term), Ok(mut int), Ok(mut hup)) =
            (signal(SignalKind::terminate()), signal(SignalKind::interrupt()), signal(SignalKind::hangup()))
        else {
            eprintln!("[app] cannot listen for termination signals");
            return;
        };
        let name = tokio::select! {
            _ = term.recv() => "SIGTERM",
            _ = int.recv() => "SIGINT",
            _ = hup.recv() => "SIGHUP",
        };
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_secs(10));
            eprintln!("[app] did not exit within 10 s: ending now");
            std::process::exit(0);
        });
        os_exit(&app, name);
        tokio::select! {
            _ = term.recv() => {},
            _ = int.recv() => {},
            _ = hup.recv() => {},
        }
        std::process::exit(0);
    });
}

#[cfg(not(unix))]
pub fn quit_on_signals<R: Runtime>(_app: &AppHandle<R>) {}

/// Whether a tray icon can be shown here. Linux: libayatana-appindicator3 (or
/// libappindicator3) must load (tray-icon panics without it) and a
/// StatusNotifier host must be on the session bus (GNOME needs the
/// AppIndicator extension; Ubuntu ships it on). Windows: always.
#[cfg(target_os = "linux")]
pub fn tray_supported() -> Result<(), String> {
    let lib_ok = ["libayatana-appindicator3.so.1", "libappindicator3.so.1"]
        .iter()
        .any(|name| unsafe { libloading::Library::new(name) }.is_ok());
    if !lib_ok {
        return Err("libayatana-appindicator3 (or libappindicator3) is not installed".into());
    }
    let host = tauri::async_runtime::block_on(async {
        tokio::time::timeout(std::time::Duration::from_secs(2), status_notifier_host()).await
    });
    match host {
        Ok(Ok(true)) => Ok(()),
        Ok(Ok(false)) => Err("no StatusNotifier host on the session bus (GNOME: the AppIndicator extension)".into()),
        Ok(Err(e)) => Err(format!("session bus: {e}")),
        Err(_) => Err("session bus did not answer".into()),
    }
}

#[cfg(target_os = "linux")]
async fn status_notifier_host() -> zbus::Result<bool> {
    let conn = zbus::Connection::session().await?;
    let dbus = zbus::fdo::DBusProxy::new(&conn).await?;
    for name in ["org.kde.StatusNotifierWatcher", "org.freedesktop.StatusNotifierWatcher"] {
        if let Ok(bus_name) = zbus::names::BusName::try_from(name) {
            if dbus.name_has_owner(bus_name).await.unwrap_or(false) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

#[cfg(not(target_os = "linux"))]
pub fn tray_supported() -> Result<(), String> {
    Ok(())
}

/// The tray icon, or false (logged) when there cannot be one: closing then
/// minimises.
pub fn create_tray<R: Runtime>(app: &AppHandle<R>) -> bool {
    if let Err(why) = tray_supported() {
        eprintln!("[tray] no tray icon: {why}. Closing the window minimises it instead.");
        return false;
    }
    match build_tray(app) {
        Ok(()) => {
            app.state::<Lifecycle>().gate().set_tray(true);
            true
        }
        Err(e) => {
            eprintln!("[tray] cannot create the tray icon: {e}. Closing the window minimises it instead.");
            false
        }
    }
}

fn build_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let lifecycle = app.state::<Lifecycle>();
    let labels = lifecycle.labels();
    let show = MenuItem::with_id(app, MENU_SHOW, &labels.show, true, None::<&str>)?;
    let status = MenuItem::with_id(app, MENU_STATUS, lifecycle.status_line(), false, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, &labels.quit, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &status, &PredefinedMenuItem::separator(app)?, &quit])?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(&labels.tooltip)
        .menu(&menu)
        // Windows: a left click shows the window, the right click the menu
        .show_menu_on_left_click(false)
        .on_menu_event(|app: &AppHandle<R>, event: MenuEvent| match event.id().as_ref() {
            MENU_SHOW => show_windows(app),
            MENU_QUIT => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. }
            | TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } => show_windows(tray.app_handle()),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    app.manage(TrayItems { show, status, quit });
    Ok(())
}

/// The tray's texts after a language or status change.
fn refresh_tray<R: Runtime>(app: &AppHandle<R>) {
    let Some(items) = app.try_state::<TrayItems<R>>() else { return };
    let lifecycle = app.state::<Lifecycle>();
    let labels = lifecycle.labels();
    let _ = items.show.set_text(&labels.show);
    let _ = items.quit.set_text(&labels.quit);
    let _ = items.status.set_text(lifecycle.status_line());
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(&labels.tooltip));
    }
}

/// The relay's tablet count, for the status line (main.rs polls it).
pub fn set_tablet_count<R: Runtime>(app: &AppHandle<R>, count: usize) {
    let lifecycle = app.state::<Lifecycle>();
    let mut current = lifecycle.tablets.lock().unwrap_or_else(|e| e.into_inner());
    if *current != count {
        *current = count;
        drop(current);
        refresh_tray(app);
    }
}

/// The main window started loading a page: until it calls app_page_state, it
/// cannot answer the lifecycle events.
pub fn page_load_started<R: Runtime>(app: &AppHandle<R>) {
    app.state::<Lifecycle>().gate().set_page_ready(false);
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    /// A tray icon exists (closing hides to it); false: closing minimises.
    pub tray: bool,
}

/// The scoretable page: it is loaded and listens for `ov-app-lifecycle`; its
/// tray texts (its language) and whether a match is in progress.
#[tauri::command]
pub fn app_page_state<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Lifecycle>,
    labels: Option<TrayLabels>,
    live: Option<MatchLive>,
) -> PageInfo {
    if let Some(labels) = labels {
        *state.labels.lock().unwrap_or_else(|e| e.into_inner()) = labels.cleaned();
    }
    if let Some(live) = live {
        *state.live.lock().unwrap_or_else(|e| e.into_inner()) = live;
    }
    let tray = {
        let mut gate = state.gate();
        gate.set_page_ready(true);
        gate.has_tray()
    };
    refresh_tray(&app);
    PageInfo { tray }
}

/// The page showed its first-close notice: hide (or minimise) now.
#[tauri::command]
pub fn app_hide<R: Runtime>(app: AppHandle<R>) {
    hide_windows(&app);
}

/// The scorer confirmed "Quit OpenVolley?": exit (the tablets' network stops
/// on RunEvent::Exit).
#[tauri::command]
pub fn app_quit<R: Runtime>(app: AppHandle<R>, state: State<'_, Lifecycle>) {
    state.gate().confirm_quit();
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready(tray: bool) -> ExitGate {
        let mut g = ExitGate::new(tray);
        g.set_page_ready(true);
        g
    }

    #[test]
    fn closing_the_window_hides_it() {
        let mut g = ready(true);
        // the first close asks the page (notice), then hides
        assert_eq!(g.close_requested(), CloseAction::AskPage);
        assert_eq!(g.close_requested(), CloseAction::Hide);
        assert_eq!(g.close_requested(), CloseAction::Hide);
        assert_eq!(g.exit_requested(true), ExitDecision::Prevent, "closing never quits");
    }

    #[test]
    fn without_a_tray_closing_minimises() {
        let mut g = ready(false);
        assert_eq!(g.close_requested(), CloseAction::AskPage);
        assert_eq!(g.close_requested(), CloseAction::Minimize);
        assert_eq!(g.hide_action(), CloseAction::Minimize);
    }

    #[test]
    fn a_page_that_is_not_loaded_is_not_waited_for() {
        let mut g = ExitGate::new(true);
        assert_eq!(g.close_requested(), CloseAction::Hide);
        // the notice is still shown once the page is there
        g.set_page_ready(true);
        assert_eq!(g.close_requested(), CloseAction::AskPage);
        // a reload does not show it again in the same run
        g.set_page_ready(false);
        g.set_page_ready(true);
        assert_eq!(g.close_requested(), CloseAction::Hide);
    }

    #[test]
    fn quitting_without_confirmation_is_prevented() {
        let g = ready(true);
        assert_eq!(g.quit_requested(), QuitAction::AskPage);
        assert_eq!(g.exit_requested(true), ExitDecision::Prevent);
    }

    #[test]
    fn quitting_after_confirmation_exits() {
        let mut g = ready(true);
        g.confirm_quit();
        assert_eq!(g.quit_requested(), QuitAction::Exit);
        assert_eq!(g.exit_requested(true), ExitDecision::Proceed);
        // the windows may close now
        assert_eq!(g.close_requested(), CloseAction::Close);
    }

    #[test]
    fn the_os_ending_the_session_exits() {
        let mut g = ready(true);
        g.os_exit();
        assert_eq!(g.exit_requested(true), ExitDecision::Proceed);
        assert_eq!(g.close_requested(), CloseAction::Close);
        assert_eq!(g.quit_requested(), QuitAction::Exit);
    }

    #[test]
    fn a_destroyed_scoretable_window_exits() {
        // e.g. the OS destroyed it: nothing left that could ask
        let g = ready(true);
        assert_eq!(g.exit_requested(false), ExitDecision::Proceed);
    }

    #[test]
    fn without_a_page_quit_exits() {
        // a blank / broken window must not make the app impossible to quit
        let g = ExitGate::new(true);
        assert_eq!(g.quit_requested(), QuitAction::Exit);
    }

    #[test]
    fn status_line() {
        let l = TrayLabels::default();
        assert_eq!(l.status_line(0, MatchLive::None), "No tablets connected");
        assert_eq!(l.status_line(1, MatchLive::Official), "1 tablet connected · Match in progress");
        assert_eq!(l.status_line(3, MatchLive::Test), "3 tablets connected · Test match in progress");
    }

    #[test]
    fn page_labels_are_cleaned() {
        let page = TrayLabels {
            show: "  OpenVolley anzeigen ".into(),
            quit: "\u{7}\n".into(),
            tablets: "x".repeat(200),
            ..TrayLabels::default()
        };
        let c = page.cleaned();
        assert_eq!(c.show, "OpenVolley anzeigen");
        assert_eq!(c.quit, "Quit OpenVolley…", "empty after cleaning: English");
        assert_eq!(c.tablets.chars().count(), MAX_LABEL);
        // a partial object from the page keeps the English defaults
        let partial: TrayLabels = serde_json::from_str(r#"{"show":"Afficher OpenVolley"}"#).unwrap();
        assert_eq!(partial.cleaned().quit, "Quit OpenVolley…");
        assert_eq!(serde_json::from_str::<MatchLive>(r#""test""#).unwrap(), MatchLive::Test);
    }

    #[test]
    fn page_event_script_is_plain() {
        assert_eq!(
            page_event_script("quit-requested"),
            r#"window.dispatchEvent(new CustomEvent('ov-app-lifecycle', { detail: {"type":"quit-requested"} }))"#
        );
    }
}
