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
//!   The page must take the request (`app_quit_ack`) within [`ACK_TIMEOUT`];
//!   a page that cannot (crashed into its error screen, a hung web process,
//!   still loading) gets a native "Quit OpenVolley?" from the app instead,
//!   so the app can always be quit, and never without a confirmation.
//! - **The OS ends the session**: never blocked. Windows ends the event loop
//!   on WM_ENDSESSION (tao), which is RunEvent::Exit, not ExitRequested.
//!   Linux: SIGTERM / SIGINT / SIGHUP quit at once (`os_exit`), with a
//!   watchdog in case the event loop no longer answers.
//! - **Second launch**: tauri-plugin-single-instance hands it to this one,
//!   which shows its window (main.rs). `--quit` (the Windows installer and
//!   uninstaller, windows/installer-hooks.nsh, after they asked) quits it cleanly.
//!
//! The decisions are in [`ExitGate`] (plain data, unit-tested); the rest
//! applies them to the windows.

use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime, State, WebviewWindow};

pub const MAIN: &str = "main";
pub const TRAY_ID: &str = "openvolley";
const MENU_SHOW: &str = "ov-show";
const MENU_STATUS: &str = "ov-status";
const MENU_QUIT: &str = "ov-quit";

/// The command-line argument that quits the running app (main.rs).
pub const QUIT_ARG: &str = "--quit";

/// How long the page has to take "quit-requested" before the app asks itself.
pub const ACK_TIMEOUT: Duration = Duration::from_millis(2500);

/// Page handler tokens are short (appLifecycle.js); anything else is cut.
const MAX_TOKEN: usize = 64;
/// Detached handlers remembered, so a late report of one cannot re-attach it.
const MAX_DETACHED: usize = 8;

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
    /// Show the window and let the page ask; request number `n` must be
    /// acknowledged (`app_quit_ack`) within ACK_TIMEOUT.
    AskPage(u64),
    /// No page that could ask: the app asks with a native dialog.
    AskNative,
    /// The native question is already on screen: only show it again.
    Showing,
    /// Exit now (already confirmed, or the OS is ending the app).
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
    /// The scoretable page's lifecycle handler (a token per install), while
    /// it can answer the lifecycle events: set by `app_page_state`, cleared by
    /// a page (re)load and by `app_page_gone` (the handler was uninstalled,
    /// e.g. the page crashed into its error screen).
    page: Option<String>,
    /// Handlers that said they are gone (a late report must not revive one).
    detached: Vec<String>,
    /// The first-close notice was asked for this run.
    notice_asked: bool,
    /// A "quit-requested" the page has not acknowledged yet (its number).
    quit_unacked: Option<u64>,
    quit_seq: u64,
    /// The native "Quit OpenVolley?" is on screen.
    native_open: bool,
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

    fn page_ready(&self) -> bool {
        self.page.is_some()
    }

    /// `app_page_state`: the page's handler `token` answers from now on
    /// (unless it already said it is gone).
    pub fn page_attached(&mut self, token: &str) {
        let token: String = token.chars().take(MAX_TOKEN).collect();
        if !self.detached.contains(&token) {
            self.page = Some(token);
        }
    }

    /// `app_page_gone`: the handler was uninstalled, nothing answers now.
    pub fn page_detached(&mut self, token: &str) {
        let token: String = token.chars().take(MAX_TOKEN).collect();
        if self.page.as_deref() == Some(token.as_str()) {
            self.page = None;
        }
        if !self.detached.contains(&token) {
            if self.detached.len() >= MAX_DETACHED {
                self.detached.remove(0);
            }
            self.detached.push(token);
        }
    }

    /// The main window started loading a page: it answers again only after
    /// it called app_page_state.
    pub fn page_unloaded(&mut self) {
        self.page = None;
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
        if self.page_ready() && !self.notice_asked {
            self.notice_asked = true;
            return CloseAction::AskPage;
        }
        self.hide_action()
    }

    /// "Quit OpenVolley…" in the tray menu, or an exit nobody confirmed.
    pub fn quit_requested(&mut self) -> QuitAction {
        if self.exiting() {
            return QuitAction::Exit;
        }
        if self.native_open {
            return QuitAction::Showing;
        }
        // Without a page that answers (still loading, crashed, uninstalled
        // its handler), or when it did not take the last request: the app
        // asks itself. A broken window must neither make the app impossible
        // to quit nor quit it without a confirmation.
        if !self.page_ready() || self.quit_unacked.is_some() {
            return self.ask_native();
        }
        self.quit_seq += 1;
        self.quit_unacked = Some(self.quit_seq);
        QuitAction::AskPage(self.quit_seq)
    }

    fn ask_native(&mut self) -> QuitAction {
        self.quit_unacked = None;
        self.native_open = true;
        QuitAction::AskNative
    }

    /// `app_quit_ack`: the page took the request and its question is on screen.
    pub fn quit_acked(&mut self) {
        self.quit_unacked = None;
    }

    /// Request `n` was not taken in time (or could not be sent): true when
    /// the app must ask natively now.
    pub fn quit_not_taken(&mut self, n: u64) -> bool {
        if self.exiting() || self.native_open || self.quit_unacked != Some(n) {
            return false;
        }
        self.ask_native();
        true
    }

    /// The native question was answered.
    pub fn native_answered(&mut self, quit: bool) {
        self.native_open = false;
        if quit {
            self.quit_confirmed = true;
        }
    }

    /// The page's confirm dialog was answered with Quit.
    pub fn confirm_quit(&mut self) {
        self.quit_confirmed = true;
    }

    /// The OS ends the app (logout / shutdown / SIGTERM), or the installer
    /// asked (`--quit`, after its own question).
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

/// The tray texts and the native "Quit OpenVolley?", in the page's language
/// (`app_page_state`). The last ones a page sent stay after it crashed.
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
    pub quit_title: String,
    pub quit_title_match: String,
    pub quit_title_test_match: String,
    /// "Tablets on this computer's network will disconnect."
    pub quit_body: String,
    /// The match is saved and can be continued.
    pub quit_match_body: String,
    pub quit_test_match_body: String,
    pub quit_confirm: String,
    pub keep_running: String,
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
            quit_title: "Quit OpenVolley?".into(),
            quit_title_match: "Quit OpenVolley during the match?".into(),
            quit_title_test_match: "Quit OpenVolley during the test match?".into(),
            quit_body: "Tablets on this computer's network will disconnect.".into(),
            quit_match_body: "A match is in progress. It is saved on this computer: start OpenVolley again and continue it from the home screen.".into(),
            quit_test_match_body: "A test match is in progress. It is saved on this computer: start OpenVolley again and continue it from the home screen.".into(),
            quit_confirm: "Quit OpenVolley".into(),
            keep_running: "Keep running".into(),
        }
    }
}

/// At most this many characters per label (a sentence of the native
/// question: MAX_TEXT); no control characters.
const MAX_LABEL: usize = 80;
const MAX_TEXT: usize = 300;

fn clean_label(s: &str, fallback: &str) -> String {
    clean_text(s, fallback, MAX_LABEL)
}

fn clean_text(s: &str, fallback: &str, max: usize) -> String {
    let s: String = s.chars().filter(|c| !c.is_control()).take(max).collect();
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
            quit_title: clean_label(&self.quit_title, &d.quit_title),
            quit_title_match: clean_label(&self.quit_title_match, &d.quit_title_match),
            quit_title_test_match: clean_label(&self.quit_title_test_match, &d.quit_title_test_match),
            quit_body: clean_text(&self.quit_body, &d.quit_body, MAX_TEXT),
            quit_match_body: clean_text(&self.quit_match_body, &d.quit_match_body, MAX_TEXT),
            quit_test_match_body: clean_text(&self.quit_test_match_body, &d.quit_test_match_body, MAX_TEXT),
            quit_confirm: clean_label(&self.quit_confirm, &d.quit_confirm),
            keep_running: clean_label(&self.keep_running, &d.keep_running),
        }
    }

    /// The native "Quit OpenVolley?": title, message, confirm and cancel.
    pub fn native_question(&self, live: MatchLive) -> (String, String, String, String) {
        let (title, message) = match live {
            MatchLive::None => (self.quit_title.clone(), self.quit_body.clone()),
            MatchLive::Official => (self.quit_title_match.clone(), format!("{}\n\n{}", self.quit_match_body, self.quit_body)),
            MatchLive::Test => (self.quit_title_test_match.clone(), format!("{}\n\n{}", self.quit_test_match_body, self.quit_body)),
        };
        (title, message, self.quit_confirm.clone(), self.keep_running.clone())
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

/// "Quit OpenVolley…": the window comes back and the page asks. A page that
/// does not take the request within ACK_TIMEOUT (crashed, hung, loading), or
/// none at all, gets the app's own native question instead.
pub fn request_quit<R: Runtime>(app: &AppHandle<R>) {
    let action = app.state::<Lifecycle>().gate().quit_requested();
    match action {
        QuitAction::Exit => app.exit(0),
        QuitAction::Showing => show_windows(app),
        QuitAction::AskNative => {
            show_windows(app);
            ask_native(app);
        }
        QuitAction::AskPage(n) => {
            show_windows(app);
            let sent = main_window(app).map(|w| w.eval(page_event_script("quit-requested")).is_ok()).unwrap_or(false);
            if !sent {
                if app.state::<Lifecycle>().gate().quit_not_taken(n) {
                    ask_native(app);
                }
                return;
            }
            // eval is fire-and-forget: Ok says nothing about a page that
            // still listens (an error screen, a hung web process)
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(ACK_TIMEOUT);
                if app.state::<Lifecycle>().gate().quit_not_taken(n) {
                    eprintln!("[app] the page did not take the quit request: asking natively");
                    ask_native(&app);
                }
            });
        }
    }
}

/// The app's own "Quit OpenVolley?" (tauri-plugin-dialog, no page needed),
/// in the last language the page reported.
fn ask_native<R: Runtime>(app: &AppHandle<R>) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let lifecycle = app.state::<Lifecycle>();
    let live = *lifecycle.live.lock().unwrap_or_else(|e| e.into_inner());
    let (title, message, ok, cancel) = lifecycle.labels().native_question(live);
    let mut dialog = app
        .dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(ok, cancel));
    if let Some(main) = main_window(app) {
        dialog = dialog.parent(&main);
    }
    let handle = app.clone();
    dialog.show(move |quit| {
        handle.state::<Lifecycle>().gate().native_answered(quit);
        if quit {
            handle.exit(0);
        }
    });
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

/// The OS ends the app (or the installer, after it asked): never blocked.
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
    app.state::<Lifecycle>().gate().page_unloaded();
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    /// A tray icon exists (closing hides to it); false: closing minimises.
    pub tray: bool,
}

/// The scoretable page: its handler `handler` is installed and listens for
/// `ov-app-lifecycle`; its tray texts (its language) and whether a match is
/// in progress.
#[tauri::command]
pub fn app_page_state<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Lifecycle>,
    handler: Option<String>,
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
        gate.page_attached(handler.as_deref().unwrap_or_default());
        gate.has_tray()
    };
    refresh_tray(&app);
    PageInfo { tray }
}

/// The page's lifecycle handler was uninstalled (the page crashed into its
/// error screen, or unmounts): it cannot answer any more, so a quit is asked
/// natively.
#[tauri::command]
pub fn app_page_gone(state: State<'_, Lifecycle>, handler: String) {
    state.gate().page_detached(&handler);
}

/// The page took a "quit-requested": its question is on screen.
#[tauri::command]
pub fn app_quit_ack(state: State<'_, Lifecycle>) {
    state.gate().quit_acked();
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
        g.page_attached("h1");
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
        g.page_attached("h1");
        assert_eq!(g.close_requested(), CloseAction::AskPage);
        // a reload does not show it again in the same run
        g.page_unloaded();
        g.page_attached("h2");
        assert_eq!(g.close_requested(), CloseAction::Hide);
    }

    #[test]
    fn quitting_without_confirmation_is_prevented() {
        let mut g = ready(true);
        assert_eq!(g.quit_requested(), QuitAction::AskPage(1));
        assert_eq!(g.exit_requested(true), ExitDecision::Prevent);
    }

    #[test]
    fn a_page_that_takes_the_quit_request_asks_it() {
        let mut g = ready(true);
        assert_eq!(g.quit_requested(), QuitAction::AskPage(1));
        g.quit_acked();
        assert!(!g.quit_not_taken(1), "taken in time: no native question");
        // Keep running, then Quit again: the page asks again
        assert_eq!(g.quit_requested(), QuitAction::AskPage(2));
        g.quit_acked();
        assert_eq!(g.exit_requested(true), ExitDecision::Prevent);
    }

    #[test]
    fn a_page_that_does_not_take_the_quit_request_gets_the_native_question() {
        // e.g. a hung web process: eval returned Ok, nothing listens
        let mut g = ready(true);
        assert_eq!(g.quit_requested(), QuitAction::AskPage(1));
        assert!(g.quit_not_taken(1), "no ack within ACK_TIMEOUT: ask natively");
        assert!(!g.quit_not_taken(1), "only once");
        // Quit again while the native question is open: it is only shown again
        assert_eq!(g.quit_requested(), QuitAction::Showing);
        assert_eq!(g.exit_requested(true), ExitDecision::Prevent, "not without an answer");
        g.native_answered(false);
        assert_eq!(g.exit_requested(true), ExitDecision::Prevent, "Keep running");
        // the page still did not answer: the next Quit asks natively at once
        // (the page is trusted again only by acknowledging)
        assert_eq!(g.quit_requested(), QuitAction::AskPage(2));
        assert_eq!(g.quit_requested(), QuitAction::AskNative, "a second Quit while one is unanswered");
        g.native_answered(true);
        assert_eq!(g.exit_requested(true), ExitDecision::Proceed);
        assert_eq!(g.close_requested(), CloseAction::Close);
    }

    #[test]
    fn a_late_timer_of_an_answered_request_does_nothing() {
        let mut g = ready(true);
        assert_eq!(g.quit_requested(), QuitAction::AskPage(1));
        g.quit_acked();
        assert_eq!(g.quit_requested(), QuitAction::AskPage(2));
        assert!(!g.quit_not_taken(1), "request 1's timer: not the pending one");
        assert!(g.quit_not_taken(2));
    }

    #[test]
    fn a_crashed_page_quits_through_the_native_question() {
        // The page crashed into its error screen: its handler said it is gone.
        // The page itself is still loaded (no new page load), so only
        // app_page_gone tells the app that nothing answers.
        let mut g = ready(true);
        g.page_detached("h1");
        assert_eq!(g.quit_requested(), QuitAction::AskNative);
        assert_eq!(g.exit_requested(true), ExitDecision::Prevent);
        g.native_answered(true);
        assert_eq!(g.exit_requested(true), ExitDecision::Proceed);
    }

    #[test]
    fn a_reinstalled_handler_is_not_cleared_by_the_old_one() {
        // React StrictMode (and a remount) uninstall then install again; the
        // two calls may arrive in any order
        let mut g = ready(true);
        g.page_attached("h2");
        g.page_detached("h1");
        assert!(matches!(g.quit_requested(), QuitAction::AskPage(_)), "h2 still answers");
        // a late report of a gone handler does not bring it back
        let mut g = ready(true);
        g.page_detached("h1");
        g.page_attached("h1");
        assert_eq!(g.quit_requested(), QuitAction::AskNative);
        // only a few gone handlers are remembered
        let mut g = ExitGate::new(true);
        for i in 0..(MAX_DETACHED + 5) {
            g.page_detached(&format!("x{i}"));
        }
        assert!(g.detached.len() <= MAX_DETACHED);
        g.page_attached(&"y".repeat(500));
        assert_eq!(g.page.as_ref().map(|t| t.chars().count()), Some(MAX_TOKEN));
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
        // even with a quit question open
        assert_eq!(g.quit_requested(), QuitAction::AskPage(1));
        g.os_exit();
        assert_eq!(g.exit_requested(true), ExitDecision::Proceed);
        assert_eq!(g.close_requested(), CloseAction::Close);
        assert_eq!(g.quit_requested(), QuitAction::Exit);
        assert!(!g.quit_not_taken(1), "no native question while exiting");
    }

    #[test]
    fn a_destroyed_scoretable_window_exits() {
        // e.g. the OS destroyed it: nothing left that could ask
        let g = ready(true);
        assert_eq!(g.exit_requested(false), ExitDecision::Proceed);
    }

    #[test]
    fn without_a_page_quit_asks_natively() {
        // a blank / broken window must not make the app impossible to quit,
        // nor quit it without a confirmation
        let mut g = ExitGate::new(true);
        assert_eq!(g.quit_requested(), QuitAction::AskNative);
        g.native_answered(true);
        assert_eq!(g.quit_requested(), QuitAction::Exit);
    }

    #[test]
    fn native_question_texts() {
        let l = TrayLabels::default();
        let (title, message, ok, cancel) = l.native_question(MatchLive::None);
        assert_eq!((title.as_str(), ok.as_str(), cancel.as_str()), ("Quit OpenVolley?", "Quit OpenVolley", "Keep running"));
        assert_eq!(message, "Tablets on this computer's network will disconnect.");
        let (title, message, _, _) = l.native_question(MatchLive::Official);
        assert_eq!(title, "Quit OpenVolley during the match?");
        assert!(message.starts_with("A match is in progress.") && message.ends_with("will disconnect."));
        let (title, message, _, _) = l.native_question(MatchLive::Test);
        assert_eq!(title, "Quit OpenVolley during the test match?");
        assert!(message.starts_with("A test match is in progress."));
        // the page's language, sentences kept longer than a tray label
        let page: TrayLabels = serde_json::from_str(&format!(
            r#"{{"quitTitle":"OpenVolley beenden?","quitBody":"{}"}}"#,
            "b".repeat(200)
        ))
        .unwrap();
        let (title, message, ok, _) = page.cleaned().native_question(MatchLive::None);
        assert_eq!(title, "OpenVolley beenden?");
        assert_eq!(message.chars().count(), 200);
        assert_eq!(ok, "Quit OpenVolley", "missing: English");
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
