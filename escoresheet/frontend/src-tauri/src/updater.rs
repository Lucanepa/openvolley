//! Automatic updates of the desktop app, never during a match.
//!
//! The app asks get.openvolley.app (then GitHub) for `latest.json` 60 s after
//! the scoretable page first loaded, every 6 hours, at sign-in and on "Check
//! for updates". What happens next depends on how it was installed ([`Kind`]):
//!
//! - **Windows (NSIS) and the Linux AppImage**: the update downloads in the
//!   background and is verified (minisign, the public key in tauri.conf.json;
//!   `requireSignedVersion`: the signature must name the version announced).
//!   It installs when the scorer quits OpenVolley (`app_quit` in
//!   lifecycle.rs, Windows: one administrator prompt, the installer runs
//!   without relaunching), or at once with "Restart and update" (page, tray).
//! - **Linux .deb from the APT repo** (`/etc/apt/sources.list.d/openvolley.list`):
//!   the root helper `/usr/libexec/openvolley-escoresheet/apt-upgrade`
//!   (polkit, no password for the local active session) upgrades the package
//!   in the background while no match is live. The running app keeps its old
//!   binary (the web bundle is embedded); it says "Restart to finish". The
//!   same check notices an `apt upgrade` or unattended-upgrades.
//! - **A .deb installed by hand** (no repo): it says how to add the repo once.
//! - **Anything else** (a development build, `--server-only`): nothing.
//!
//! The gate is here, in Rust, and checked before every download, install and
//! restart, whatever the page asks:
//!
//! - download: no live match (the venue's uplink is for the live sync);
//! - restart ("Restart and update"): no live match, no tablet connected, no
//!   tablet network of this app running, the page loaded;
//! - install on a confirmed quit: no live match;
//! - never: at startup, by itself, or when the OS ends the app
//!   (`lifecycle::os_exit` does not come here).
//!
//! The page gets the status through `update_status` and the window event
//! `ov-update` (src/hooks/useDesktopUpdate.js); the plugin's own JS commands
//! are not granted to any window (capabilities/update.json).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::utils::config::BundleType;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::lifecycle::{self, Lifecycle, MatchLive};

/// The window event the page listens for (useDesktopUpdate.js).
pub const UPDATE_EVENT: &str = "ov-update";
/// `OPENVOLLEY_UPDATE_CHANNEL=staging`: the canary manifest (still verified
/// with the same key).
pub const STAGING_ENDPOINT: &str = crate::flavour::CURRENT.staging_endpoint;
/// Written by install.sh: the machine gets the app from the APT repo.
pub const APT_LIST: &str = "/etc/apt/sources.list.d/openvolley.list";
/// The root helper the .deb ships (linux/apt-upgrade, polkit action
/// com.openvolley.escoresheet.update).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const APT_HELPER: &str = crate::flavour::CURRENT.apt_helper;

pub const CHECK_EVERY: Duration = Duration::from_secs(6 * 3600);
pub const SIGN_IN_EVERY: Duration = Duration::from_secs(15 * 60);
pub const FIRST_CHECK_DELAY: Duration = Duration::from_secs(60);
/// After a match ended, the next automatic check or download waits this long
/// (the scorer is still busy with signatures and the PDF).
pub const AFTER_MATCH: Duration = Duration::from_secs(5 * 60);
/// A declined administrator prompt: no prompt on quit for this version for 3 days.
pub const DECLINE_SECS: u64 = 3 * 24 * 3600;
const TICK: Duration = Duration::from_secs(30);
const MAX_NOTES: usize = 4000;

// ---------------------------------------------------------------------------
// Plain data and rules (unit-tested)

/// How this copy was installed, so how it updates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Nsis,
    AppImage,
    DebApt,
    DebNoRepo,
    Unsupported,
}

impl Kind {
    /// From the bundle the binary came in (the bundler patches it in) and
    /// whether the APT repo's list file exists.
    pub fn detect(bundle: Option<BundleType>, apt_list: bool) -> Self {
        match bundle {
            Some(BundleType::Nsis) => Self::Nsis,
            Some(BundleType::AppImage) => Self::AppImage,
            Some(BundleType::Deb) if apt_list => Self::DebApt,
            Some(BundleType::Deb) => Self::DebNoRepo,
            _ => Self::Unsupported,
        }
    }

    /// The app itself downloads and installs the update file.
    pub fn downloads(self) -> bool {
        matches!(self, Self::Nsis | Self::AppImage)
    }

    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    fn is_deb(self) -> bool {
        matches!(self, Self::DebApt | Self::DebNoRepo)
    }

    #[cfg(debug_assertions)]
    fn from_test_name(name: &str) -> Option<Self> {
        match name {
            "nsis" => Some(Self::Nsis),
            "appimage" => Some(Self::AppImage),
            "deb-apt" => Some(Self::DebApt),
            "deb-norepo" => Some(Self::DebNoRepo),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum Phase {
    Idle,
    Checking,
    /// Found, not downloaded yet (a match is live, or it is next).
    Available,
    Downloading { got: u64, total: Option<u64> },
    /// Downloaded and verified (Windows, AppImage); known to the APT helper
    /// (deb); or waiting for the repo to be added (deb without the repo).
    Ready,
    Installing,
    /// Linux deb: the new version is installed, the app runs the old one.
    RestartPending,
    UpToDate,
    /// `msg`: checkFailed, downloadFailed, installFailed, needsAdmin,
    /// noPkexec, aptFailed.
    Failed { msg: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Reason {
    Start,
    Timer,
    SignIn,
    Manual,
}

/// What the update gate looks at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GateInput {
    pub live: MatchLive,
    pub tablets: usize,
    pub tablet_net_on: bool,
    pub page_ready: bool,
}

/// Why "Restart and update" has to wait.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Blocker {
    MatchLive,
    Tablets { count: usize },
    TabletNetwork,
    PageNotReady,
}

/// Everything in the way of a restart now; empty: it may restart.
pub fn restart_blockers(i: &GateInput) -> Vec<Blocker> {
    let mut out = Vec::new();
    if i.live != MatchLive::None {
        out.push(Blocker::MatchLive);
    }
    if i.tablets > 0 {
        out.push(Blocker::Tablets { count: i.tablets });
    }
    if i.tablet_net_on {
        out.push(Blocker::TabletNetwork);
    }
    if !i.page_ready {
        out.push(Blocker::PageNotReady);
    }
    out
}

/// A confirmed quit installs a downloaded update only with no live match
/// (quitting already stops the tablets and their network).
pub fn quit_install_allowed(i: &GateInput) -> bool {
    i.live == MatchLive::None
}

/// No download during a match: the venue's uplink is for the live sync.
pub fn download_allowed(i: &GateInput) -> bool {
    i.live == MatchLive::None
}

/// Whether a check for `reason` is due: every 6 h (start, timer), 15 min
/// after the last one at sign-in, always when asked.
pub fn check_due(now: Instant, last: Option<Instant>, reason: Reason) -> bool {
    let every = match reason {
        Reason::Manual => return true,
        Reason::SignIn => SIGN_IN_EVERY,
        Reason::Start | Reason::Timer => CHECK_EVERY,
    };
    last.map_or(true, |l| now.saturating_duration_since(l) >= every)
}

/// No automatic network use during a match and for AFTER_MATCH after it.
pub fn quiet_after_match(now: Instant, live: MatchLive, live_ended: Option<Instant>) -> bool {
    live == MatchLive::None && live_ended.map_or(true, |t| now.saturating_duration_since(t) >= AFTER_MATCH)
}

/// `readlink /proc/self/exe` of a binary dpkg replaced while it ran.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn exe_replaced(proc_self_exe: &str) -> bool {
    proc_self_exe.ends_with(" (deleted)")
}

/// What the scheduler does on a tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Nothing,
    Check,
    Download,
    DebUpgrade,
}

/// The scheduler's state for [`next_step`].
#[derive(Debug, Clone)]
pub struct TickInput {
    pub now: Instant,
    pub kind: Kind,
    pub live: MatchLive,
    pub live_ended: Option<Instant>,
    pub last_check: Option<Instant>,
    pub auto_check: bool,
    pub auto_install: bool,
    pub phase: Phase,
    /// The version found by the last check.
    pub available: Option<String>,
    pub downloaded: bool,
    /// The version the APT helper already ran for.
    pub deb_tried: Option<String>,
}

pub fn next_step(t: &TickInput) -> Step {
    if t.kind == Kind::Unsupported || !quiet_after_match(t.now, t.live, t.live_ended) {
        return Step::Nothing;
    }
    if matches!(t.phase, Phase::Checking | Phase::Downloading { .. } | Phase::Installing | Phase::RestartPending) {
        return Step::Nothing;
    }
    if t.auto_check && check_due(t.now, t.last_check, Reason::Timer) {
        return Step::Check;
    }
    // a failed download or install is tried again with the next check, not
    // every tick (a file that does not verify must not be fetched in a loop)
    if matches!(t.phase, Phase::Failed { .. }) {
        return Step::Nothing;
    }
    let Some(version) = &t.available else { return Step::Nothing };
    if t.kind.downloads() && !t.downloaded {
        return Step::Download;
    }
    if t.kind == Kind::DebApt && t.auto_install && t.deb_tried.as_deref() != Some(version) {
        return Step::DebUpgrade;
    }
    Step::Nothing
}

/// The APT helper's exit code (`None`: pkexec could not run).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DebOutcome {
    /// The binary on disk is the new one: restart to finish.
    Upgraded,
    /// Nothing newer in the repo yet (latest.json is ahead of it): later.
    NotUpgraded,
    /// No /etc/apt/sources.list.d/openvolley.list.
    NoRepo,
    Failed(&'static str),
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn deb_outcome(code: Option<i32>, replaced: bool) -> DebOutcome {
    match code {
        Some(0) if replaced => DebOutcome::Upgraded,
        Some(0) => DebOutcome::NotUpgraded,
        Some(3) => DebOutcome::NoRepo,
        // pkexec: 126 not authorised / dismissed, 127 cannot authenticate (or missing)
        None | Some(126) | Some(127) => DebOutcome::Failed("noPkexec"),
        _ => DebOutcome::Failed("aptFailed"),
    }
}

/// A declined administrator prompt (Windows) for a version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Declined {
    pub version: String,
    /// Unix seconds.
    pub until: u64,
}

/// The two settings (Options > App version), in `<config dir>/update.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
    pub auto_check: bool,
    pub auto_install: bool,
    pub declined: Option<Declined>,
}

impl Default for Prefs {
    fn default() -> Self {
        Self { auto_check: true, auto_install: true, declined: None }
    }
}

impl Prefs {
    /// A damaged file is the defaults (on), never an error.
    pub fn parse(text: &str) -> Self {
        serde_json::from_str(text).unwrap_or_default()
    }

    pub fn declined_active(&self, version: &str, now: u64) -> bool {
        self.declined.as_ref().is_some_and(|d| d.version == version && now < d.until)
    }

    pub fn decline(&mut self, version: &str, now: u64) {
        self.declined = Some(Declined { version: version.to_string(), until: now + DECLINE_SECS });
    }
}

/// What the page shows of a found update.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Available {
    pub version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
}

/// The page's view (`update_status`, `ov-update`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub kind: Kind,
    #[serde(flatten)]
    pub phase: Phase,
    pub current: String,
    pub available: Option<Available>,
    pub auto_check: bool,
    pub auto_install: bool,
    /// What a restart waits for (empty: nothing).
    pub blockers: Vec<Blocker>,
    /// "Restart and update" can run now.
    pub can_restart: bool,
    /// The last check was asked for (its failure is shown).
    pub manual: bool,
    /// Increases with every status the page gets (command answers and
    /// `ov-update` events): an answer computed before a newer event (a page
    /// that just loaded asks while it reports the end of a match) is older
    /// and the page keeps the newer one.
    pub seq: u64,
}

/// Something to restart into: downloaded (Windows, AppImage), installed and
/// waiting for the restart (a deb, or an AppImage whose restart the gate
/// held back), or the deb installable by the helper.
pub fn restart_ready(kind: Kind, phase: &Phase, downloaded: bool, available: bool) -> bool {
    match kind {
        Kind::Nsis | Kind::AppImage => {
            matches!(phase, Phase::RestartPending) || (downloaded && !matches!(phase, Phase::Installing))
        }
        Kind::DebApt => matches!(phase, Phase::RestartPending) || (available && matches!(phase, Phase::Ready | Phase::Available)),
        Kind::DebNoRepo | Kind::Unsupported => false,
    }
}

/// Why "Restart and update" did nothing.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallError {
    /// blocked, nothing, busy, installFailed, needsAdmin, noPkexec, aptFailed
    pub code: String,
    pub blockers: Vec<Blocker>,
}

impl InstallError {
    fn code(code: &str) -> Self {
        Self { code: code.to_string(), blockers: Vec::new() }
    }
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Windows: ShellExecute's error when the administrator prompt was
/// cancelled (ERROR_CANCELLED) or refused (access denied).
fn needs_admin(e: &tauri_plugin_updater::Error) -> bool {
    matches!(e, tauri_plugin_updater::Error::Io(io) if matches!(io.raw_os_error(), Some(1223) | Some(5)))
}

// ---------------------------------------------------------------------------
// Managed state

struct Pending {
    update: Update,
    bytes: Vec<u8>,
}

struct Inner {
    kind: Kind,
    phase: Phase,
    available: Option<Available>,
    pending: Option<Pending>,
    last_check: Option<Instant>,
    manual: bool,
    prefs: Prefs,
    prefs_path: Option<PathBuf>,
    live: MatchLive,
    live_ended: Option<Instant>,
    deb_tried: Option<String>,
    last_pushed: String,
}

pub struct Updates {
    inner: Mutex<Inner>,
    /// A check, download, APT run or install is running (one at a time).
    busy: AtomicBool,
}

impl Updates {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                kind: detect_kind(),
                phase: Phase::Idle,
                available: None,
                pending: None,
                last_check: None,
                manual: false,
                prefs: Prefs::default(),
                prefs_path: None,
                live: MatchLive::None,
                live_ended: None,
                deb_tried: None,
                last_pushed: String::new(),
            }),
            busy: AtomicBool::new(false),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn try_begin(&self) -> Option<Busy<'_>> {
        self.busy.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).ok().map(|_| Busy(&self.busy))
    }

    fn set_phase(&self, phase: Phase) {
        self.lock().phase = phase;
    }
}

impl Default for Updates {
    fn default() -> Self {
        Self::new()
    }
}

struct Busy<'a>(&'a AtomicBool);

impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// Test hooks of a debug build (the Linux Xvfb check against a local
/// server, with a throwaway key). A release build has none of them.
#[cfg(debug_assertions)]
fn test_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

#[cfg(not(debug_assertions))]
fn test_env(_name: &str) -> Option<String> {
    None
}

fn detect_kind() -> Kind {
    #[cfg(debug_assertions)]
    if let Some(kind) = test_env("OPENVOLLEY_UPDATE_TEST_KIND").and_then(|v| Kind::from_test_name(&v)) {
        return kind;
    }
    Kind::detect(tauri::utils::platform::bundle_type(), Path::new(APT_LIST).is_file())
}

fn test_secs(name: &str, default: Duration) -> Duration {
    test_env(name).and_then(|v| v.parse().ok()).map(Duration::from_secs).unwrap_or(default)
}

pub fn gate_input<R: Runtime>(app: &AppHandle<R>) -> GateInput {
    let lc = app.state::<Lifecycle>();
    GateInput {
        live: lc.live(),
        tablets: lc.tablets(),
        tablet_net_on: crate::netshare::app_network_on(app),
        page_ready: lc.page_ready(),
    }
}

static SEQ: AtomicU64 = AtomicU64::new(0);

fn next_seq() -> u64 {
    SEQ.fetch_add(1, Ordering::Relaxed) + 1
}

/// The status the page sees, numbered (see `Status::seq`).
pub fn status<R: Runtime>(app: &AppHandle<R>) -> Status {
    Status { seq: next_seq(), ..current(app) }
}

/// The status without its number. Linux deb: also notices a binary replaced
/// by APT (the helper, `apt upgrade`, unattended-upgrades).
fn current<R: Runtime>(app: &AppHandle<R>) -> Status {
    let gate = gate_input(app);
    let updates = app.state::<Updates>();
    notice_replaced_binary(&updates);
    let i = updates.lock();
    let blockers = restart_blockers(&gate);
    let ready = restart_ready(i.kind, &i.phase, i.pending.is_some(), i.available.is_some());
    Status {
        kind: i.kind,
        phase: i.phase.clone(),
        current: app.package_info().version.to_string(),
        available: i.available.clone(),
        auto_check: i.prefs.auto_check,
        auto_install: i.prefs.auto_install,
        can_restart: ready && blockers.is_empty(),
        blockers,
        manual: i.manual,
        seq: 0,
    }
}

#[cfg(target_os = "linux")]
fn notice_replaced_binary(updates: &Updates) {
    let mut i = updates.lock();
    if !i.kind.is_deb() || matches!(i.phase, Phase::RestartPending | Phase::Installing) {
        return;
    }
    let replaced = std::fs::read_link("/proc/self/exe").map(|p| exe_replaced(&p.to_string_lossy())).unwrap_or(false);
    if !replaced {
        return;
    }
    if i.available.is_none() {
        i.available = installed_deb_version().map(|version| Available { version, notes: None, date: None });
    }
    i.phase = Phase::RestartPending;
}

#[cfg(not(target_os = "linux"))]
fn notice_replaced_binary(_updates: &Updates) {}

/// The version dpkg has installed now (after an upgrade behind the app's back).
#[cfg(target_os = "linux")]
fn installed_deb_version() -> Option<String> {
    let out = std::process::Command::new("dpkg-query")
        .args(["-W", "-f=${Version}", crate::flavour::CURRENT.package])
        .output()
        .ok()?;
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !v.is_empty() && v.len() <= 32).then_some(v)
}

fn event_script(status_json: &str) -> String {
    format!("window.dispatchEvent(new CustomEvent('{UPDATE_EVENT}', {{ detail: {status_json} }}))")
}

/// Tell the page (when something changed) and the tray.
pub fn push<R: Runtime>(app: &AppHandle<R>) {
    let Some(updates) = app.try_state::<Updates>() else { return };
    let st = current(app);
    let offer = if st.can_restart { st.available.as_ref().map(|a| a.version.clone()) } else { None };
    lifecycle::set_update_offer(app, offer);
    let Ok(unnumbered) = serde_json::to_string(&st) else { return };
    {
        let mut i = updates.lock();
        if i.last_pushed == unnumbered {
            return;
        }
        i.last_pushed = unnumbered;
    }
    let Ok(json) = serde_json::to_string(&Status { seq: next_seq(), ..st }) else { return };
    if let Some(main) = app.get_webview_window(lifecycle::MAIN) {
        let _ = main.eval(event_script(&json));
    }
}

/// `app_page_state` (lifecycle.rs): the live match or the page changed.
pub fn on_page_state<R: Runtime>(app: &AppHandle<R>) {
    let Some(updates) = app.try_state::<Updates>() else { return };
    let live = app.state::<Lifecycle>().live();
    {
        let mut i = updates.lock();
        if i.live != MatchLive::None && live == MatchLive::None {
            i.live_ended = Some(Instant::now());
        }
        i.live = live;
    }
    push(app);
}

fn prefs_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("update.json"))
}

fn save_prefs(path: Option<&Path>, prefs: &Prefs) {
    let Some(path) = path else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string_pretty(prefs) {
        if let Err(e) = std::fs::write(path, text) {
            eprintln!("[update] cannot save {}: {e}", path.display());
        }
    }
}

// ---------------------------------------------------------------------------
// Scheduler

/// Loads the settings and starts the scheduler (main.rs setup).
pub fn start<R: Runtime>(app: AppHandle<R>) {
    let updates = app.state::<Updates>();
    let path = prefs_path(&app);
    let kind = {
        let mut i = updates.lock();
        if let Some(p) = &path {
            if let Ok(text) = std::fs::read_to_string(p) {
                i.prefs = Prefs::parse(&text);
            }
        }
        i.prefs_path = path;
        i.kind
    };
    if kind == Kind::Unsupported {
        eprintln!("[update] not an installed copy (no bundle type): no automatic updates");
        return;
    }
    eprintln!("[update] {} {kind:?}: checking after the page loaded, then every 6 h", app.package_info().version);
    tauri::async_runtime::spawn(async move {
        // never at startup: once the scoretable page is there, and a minute later
        while !app.state::<Lifecycle>().page_ready() {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        tokio::time::sleep(test_secs("OPENVOLLEY_UPDATE_TEST_FIRST_DELAY", FIRST_CHECK_DELAY)).await;
        let tick = test_secs("OPENVOLLEY_UPDATE_TEST_TICK", TICK);
        let mut first = true;
        loop {
            run_tick(&app, first).await;
            first = false;
            tokio::time::sleep(tick).await;
        }
    });
}

async fn run_tick<R: Runtime>(app: &AppHandle<R>, first: bool) {
    let gate = gate_input(app);
    let step = {
        let updates = app.state::<Updates>();
        let i = updates.lock();
        next_step(&TickInput {
            now: Instant::now(),
            kind: i.kind,
            live: gate.live,
            live_ended: i.live_ended,
            last_check: i.last_check,
            auto_check: i.prefs.auto_check,
            auto_install: i.prefs.auto_install,
            phase: i.phase.clone(),
            available: i.available.as_ref().map(|a| a.version.clone()),
            downloaded: i.pending.is_some(),
            deb_tried: i.deb_tried.clone(),
        })
    };
    match step {
        Step::Check => check(app, if first { Reason::Start } else { Reason::Timer }).await,
        Step::Download => {
            if let Some(_busy) = app.state::<Updates>().try_begin() {
                download(app).await;
            }
        }
        Step::DebUpgrade => {
            if let Some(_busy) = app.state::<Updates>().try_begin() {
                deb_upgrade(app).await;
            }
        }
        Step::Nothing => {}
    }
    push(app);
}

/// Windows: the plugin runs this right before it starts the installer
/// (ShellExecute, which shows the administrator prompt) and, once the
/// installer runs, ends the process itself (no RunEvent::Exit). Only what
/// must happen before that exit, and nothing that cannot be undone: the
/// prompt can be cancelled, and the app then runs on
/// ([`after_failed_install`]). So the tablets' network stops and the tray
/// icon leaves the notification area (an icon a process leaves behind stays
/// there, dead, until the mouse passes over it). Not the plugin's own hook,
/// `AppHandle::cleanup_before_exit`: it drops the tray icon for good and
/// hides every window, which left a running app with no window and no tray
/// after a cancelled prompt.
fn before_installer<R: Runtime>(app: &AppHandle<R>) {
    crate::netshare::shutdown(app);
    lifecycle::set_tray_visible(app, false);
}

/// The installer did not start (Windows: the administrator prompt was
/// cancelled or refused): the app runs on, its tray icon comes back.
fn after_failed_install<R: Runtime>(app: &AppHandle<R>) {
    lifecycle::set_tray_visible(app, true);
}

fn updater<R: Runtime>(app: &AppHandle<R>) -> Result<tauri_plugin_updater::Updater, String> {
    let h = app.clone();
    // replaces the plugin's own hook (cleanup_before_exit), see before_installer
    let mut b = app.updater_builder().on_before_exit(move || before_installer(&h));
    if std::env::var("OPENVOLLEY_UPDATE_CHANNEL").as_deref() == Ok("staging") {
        b = b.endpoints(vec![STAGING_ENDPOINT.parse().map_err(|e| format!("{e}"))?]).map_err(|e| e.to_string())?;
    }
    if let Some(url) = test_env("OPENVOLLEY_UPDATE_TEST_ENDPOINT") {
        b = b.endpoints(vec![url.parse().map_err(|e| format!("{e}"))?]).map_err(|e| e.to_string())?;
    }
    if let Some(key) = test_env("OPENVOLLEY_UPDATE_TEST_PUBKEY") {
        b = b.pubkey(key);
    }
    if let Some(exe) = test_env("OPENVOLLEY_UPDATE_TEST_EXE") {
        b = b.executable_path(exe);
    }
    b.build().map_err(|e| e.to_string())
}

/// Ask the server; then download (Windows, AppImage) or run the APT helper
/// (deb) when the gate allows.
pub async fn check<R: Runtime>(app: &AppHandle<R>, reason: Reason) {
    let updates = app.state::<Updates>();
    if updates.lock().kind == Kind::Unsupported {
        return;
    }
    let Some(_busy) = updates.try_begin() else { return };
    let live = gate_input(app).live;
    if reason != Reason::Manual && live != MatchLive::None {
        return;
    }
    {
        let mut i = updates.lock();
        if reason != Reason::Manual && !i.prefs.auto_check {
            return;
        }
        if !check_due(Instant::now(), i.last_check, reason) {
            return;
        }
        i.phase = Phase::Checking;
        i.manual = reason == Reason::Manual;
    }
    push(app);

    let found = match updater(app) {
        Ok(u) => u.check().await.map_err(|e| e.to_string()),
        Err(e) => Err(e),
    };
    let found = {
        let mut i = updates.lock();
        i.last_check = Some(Instant::now());
        match found {
            Err(e) => {
                // offline, a venue Wi-Fi without uplink, both endpoints down
                eprintln!("[update] check failed: {e}");
                i.phase = Phase::Failed { msg: "checkFailed".into() };
                None
            }
            Ok(None) => {
                i.phase = Phase::UpToDate;
                i.available = None;
                i.pending = None;
                None
            }
            Ok(Some(update)) => {
                eprintln!("[update] {} is available (running {})", update.version, update.current_version);
                let same = i.available.as_ref().is_some_and(|a| a.version == update.version);
                i.available = Some(Available {
                    version: update.version.clone(),
                    notes: update.body.as_ref().map(|n| n.chars().take(MAX_NOTES).collect()),
                    date: update.date.map(|d| d.date().to_string()),
                });
                if !same {
                    i.pending = None;
                }
                // the APT helper may run again for it (the repo can lag behind latest.json)
                i.deb_tried = None;
                let kind = i.kind;
                i.phase = match kind {
                    // installed already, only the restart is missing
                    _ if i.phase == Phase::RestartPending => Phase::RestartPending,
                    Kind::DebNoRepo | Kind::DebApt => Phase::Ready,
                    _ if i.pending.is_some() => Phase::Ready,
                    _ => Phase::Available,
                };
                Some((kind, update))
            }
        }
    };
    push(app);
    let Some((kind, update)) = found else { return };
    let gate = gate_input(app);
    let (has_file, auto_install, phase) = {
        let i = updates.lock();
        (i.pending.is_some(), i.prefs.auto_install, i.phase.clone())
    };
    // RestartPending: installed already (an AppImage whose restart the gate held back)
    if kind.downloads() && download_allowed(&gate) && !has_file && phase != Phase::RestartPending {
        download_update(app, update).await;
    } else if kind == Kind::DebApt && download_allowed(&gate) && auto_install && phase == Phase::Ready {
        deb_upgrade(app).await;
    }
}

/// The scheduler's download of an update found earlier (while a match was live).
async fn download<R: Runtime>(app: &AppHandle<R>) {
    // the Update object is not kept without its file: ask again (cheap)
    let update = match updater(app) {
        Ok(u) => u.check().await.ok().flatten(),
        Err(_) => None,
    };
    match update {
        Some(update) => download_update(app, update).await,
        None => {
            let updates = app.state::<Updates>();
            let mut i = updates.lock();
            i.phase = Phase::UpToDate;
            i.available = None;
        }
    }
}

/// Download and verify; stops (and tries again later) when a match starts.
async fn download_update<R: Runtime>(app: &AppHandle<R>, update: Update) {
    let updates = app.state::<Updates>();
    updates.set_phase(Phase::Downloading { got: 0, total: None });
    push(app);
    let progress_app = app.clone();
    let mut got: u64 = 0;
    let mut last_push = Instant::now();
    let on_chunk = move |len: usize, total: Option<u64>| {
        got += len as u64;
        progress_app.state::<Updates>().set_phase(Phase::Downloading { got, total });
        if last_push.elapsed() >= Duration::from_millis(400) {
            last_push = Instant::now();
            push(&progress_app);
        }
    };
    let watch_app = app.clone();
    let match_started = async move {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            if !download_allowed(&gate_input(&watch_app)) {
                return;
            }
        }
    };
    let result = tokio::select! {
        r = update.download(on_chunk, || {}) => Some(r),
        _ = match_started => None,
    };
    let mut i = updates.lock();
    match result {
        None => {
            eprintln!("[update] a match started: download stopped, again after it");
            i.phase = Phase::Available;
        }
        Some(Err(e)) => {
            // includes a signature that does not verify
            eprintln!("[update] download of {} failed: {e}", update.version);
            i.phase = Phase::Failed { msg: "downloadFailed".into() };
        }
        Some(Ok(bytes)) => {
            eprintln!("[update] {} downloaded and verified ({} bytes)", update.version, bytes.len());
            i.pending = Some(Pending { update, bytes });
            i.phase = Phase::Ready;
        }
    }
    drop(i);
    push(app);
}

/// Linux deb: the root helper upgrades the package (polkit, no password for
/// the local active session). Only with no live match.
#[cfg(target_os = "linux")]
async fn deb_upgrade<R: Runtime>(app: &AppHandle<R>) {
    let updates = app.state::<Updates>();
    if !download_allowed(&gate_input(app)) {
        return;
    }
    let version = {
        let mut i = updates.lock();
        i.deb_tried = i.available.as_ref().map(|a| a.version.clone());
        i.phase = Phase::Installing;
        i.deb_tried.clone()
    };
    push(app);
    let code = tauri::async_runtime::spawn_blocking(|| {
        std::process::Command::new("pkexec")
            .arg(APT_HELPER)
            .stdin(std::process::Stdio::null())
            .status()
            .map(|s| s.code())
            .unwrap_or_else(|e| {
                eprintln!("[update] pkexec: {e}");
                None
            })
    })
    .await
    .unwrap_or(None);
    let replaced = std::fs::read_link("/proc/self/exe").map(|p| exe_replaced(&p.to_string_lossy())).unwrap_or(false);
    let outcome = deb_outcome(code, replaced);
    eprintln!("[update] apt-upgrade for {version:?}: exit {code:?} -> {outcome:?}");
    let mut i = updates.lock();
    i.phase = match outcome {
        DebOutcome::Upgraded => Phase::RestartPending,
        DebOutcome::NotUpgraded => Phase::Ready,
        DebOutcome::NoRepo => {
            i.kind = Kind::DebNoRepo;
            Phase::Ready
        }
        DebOutcome::Failed(msg) => Phase::Failed { msg: msg.into() },
    };
    drop(i);
    push(app);
}

#[cfg(not(target_os = "linux"))]
async fn deb_upgrade<R: Runtime>(_app: &AppHandle<R>) {}

// ---------------------------------------------------------------------------
// Installing

/// An exit that is a restart: the lifecycle gate lets it through, the
/// tablets' network stops and the single-instance lock is released on
/// RunEvent::Exit, then Tauri starts the binary again (for a deb: the new one
/// on disk; for an AppImage: $APPIMAGE).
fn restart_app<R: Runtime>(app: &AppHandle<R>) {
    eprintln!("[update] restarting into the new version");
    lifecycle::confirm_restart(app);
    app.request_restart();
}

/// Runs `f` on a plain thread (install() may block, and on Windows it stops
/// the tablets' network with block_on, which a runtime thread cannot do).
async fn on_thread<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.await.ok()
}

/// The gate, refused with its reasons.
fn gate_clear<R: Runtime>(app: &AppHandle<R>) -> Result<(), InstallError> {
    let blockers = restart_blockers(&gate_input(app));
    if blockers.is_empty() {
        return Ok(());
    }
    push(app);
    Err(InstallError { code: "blocked".into(), blockers })
}

/// The update is installed (the deb by the helper, the AppImage file
/// replaced): restart, if the gate is still open. The install step can take
/// minutes (the APT helper waits for the dpkg lock and downloads), and a
/// match may have started or a tablet connected in the meantime: then the
/// app stays as it is, "Restart to finish" (RestartPending), and the page
/// and the tray offer the restart again once the gate opens.
fn restart_when_clear<R: Runtime>(app: &AppHandle<R>) -> Result<(), InstallError> {
    app.state::<Updates>().set_phase(Phase::RestartPending);
    if let Err(e) = gate_clear(app) {
        eprintln!("[update] installed; the restart waits (the gate closed meanwhile)");
        return Err(e);
    }
    restart_app(app);
    Ok(())
}

/// "Restart and update" (the page's button, the tray item). Refused with the
/// reasons while the gate is closed, before the install and again before the
/// restart; never restarts anyway.
pub async fn install_now<R: Runtime>(app: &AppHandle<R>) -> Result<(), InstallError> {
    gate_clear(app)?;
    let updates = app.state::<Updates>();
    let Some(_busy) = updates.try_begin() else { return Err(InstallError::code("busy")) };
    let (kind, phase) = {
        let i = updates.lock();
        (i.kind, i.phase.clone())
    };
    if phase == Phase::RestartPending && restart_ready(kind, &phase, false, false) {
        // installed already, only the restart is missing
        return restart_when_clear(app);
    }
    match kind {
        Kind::Nsis | Kind::AppImage => {
            let Some(pending) = updates.lock().pending.take() else { return Err(InstallError::code("nothing")) };
            updates.set_phase(Phase::Installing);
            push(app);
            let version = pending.update.version.clone();
            // Windows: the installer (one administrator prompt) replaces the
            // app and starts it again (/R); install() ends this process.
            let result = on_thread(move || {
                let r = pending.update.install(&pending.bytes);
                (r, pending)
            })
            .await;
            let Some((result, pending)) = result else {
                after_failed_install(app);
                updates.set_phase(Phase::Failed { msg: "installFailed".into() });
                push(app);
                return Err(InstallError::code("installFailed"));
            };
            match result {
                // AppImage: the file is replaced; Windows does not get here
                Ok(()) => restart_when_clear(app),
                Err(e) => {
                    eprintln!("[update] install of {version} failed: {e}");
                    after_failed_install(app);
                    let code = if needs_admin(&e) { "needsAdmin" } else { "installFailed" };
                    let mut i = updates.lock();
                    if code == "needsAdmin" {
                        i.prefs.decline(&version, now_secs());
                        save_prefs(i.prefs_path.as_deref(), &i.prefs);
                    }
                    i.pending = Some(pending);
                    i.phase = Phase::Failed { msg: code.into() };
                    drop(i);
                    push(app);
                    Err(InstallError::code(code))
                }
            }
        }
        Kind::DebApt => {
            if updates.lock().available.is_none() {
                return Err(InstallError::code("nothing"));
            }
            deb_upgrade(app).await;
            after_deb_upgrade(app)
        }
        Kind::DebNoRepo | Kind::Unsupported => Err(InstallError::code("nothing")),
    }
}

/// After the APT helper ran for "Restart and update": restart (when the gate
/// is still open) or say why not.
fn after_deb_upgrade<R: Runtime>(app: &AppHandle<R>) -> Result<(), InstallError> {
    let phase = app.state::<Updates>().lock().phase.clone();
    match phase {
        Phase::RestartPending => restart_when_clear(app),
        Phase::Failed { msg } => Err(InstallError::code(&msg)),
        _ => Err(InstallError::code("installFailed")),
    }
}

/// The tray's "Restart to update to {v}" (shown only while the gate is open).
pub fn install_from_tray<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = install_now(&app).await {
            eprintln!("[update] tray restart refused: {}", e.code);
            lifecycle::show_windows(&app);
        }
    });
}

/// A confirmed "Quit OpenVolley" (lifecycle `app_quit`, on the main thread,
/// right before the exit): install a downloaded update when no match is live
/// and installing automatically is on. Windows: the installer runs without
/// relaunching the app (one administrator prompt) and this process ends;
/// a declined prompt is not asked again on quit for 3 days. AppImage: the
/// file is replaced, the next start is the new version. Deb: nothing here
/// (the helper already ran). Never on an OS shutdown / logout.
pub fn on_confirmed_quit<R: Runtime>(app: &AppHandle<R>) {
    let Some(updates) = app.try_state::<Updates>() else { return };
    let gate = gate_input(app);
    let pending = {
        let mut i = updates.lock();
        if !i.prefs.auto_install || !quit_install_allowed(&gate) || !i.kind.downloads() {
            return;
        }
        let declined = i.pending.as_ref().is_some_and(|p| i.prefs.declined_active(&p.update.version, now_secs()));
        if declined {
            eprintln!("[update] the administrator prompt was declined recently: not installing on quit");
            return;
        }
        let Some(p) = i.pending.take() else { return };
        p
    };
    let version = pending.update.version.clone();
    eprintln!("[update] installing {version} on quit");
    let update = pending.update.restart_after_install(false);
    if let Err(e) = update.install(&pending.bytes) {
        eprintln!("[update] install of {version} on quit failed: {e}");
        if needs_admin(&e) {
            let mut i = updates.lock();
            i.prefs.decline(&version, now_secs());
            save_prefs(i.prefs_path.as_deref(), &i.prefs);
        }
    }
}

// ---------------------------------------------------------------------------
// Commands (capabilities/update.json: the scoretable window on http://localhost)

#[tauri::command]
pub fn update_status<R: Runtime>(app: AppHandle<R>) -> Status {
    status(&app)
}

/// "Check for updates" (`manual`) or a sign-in (`signIn`, at most every 15
/// minutes, only with automatic checks on). Answers at once; the result
/// comes as `ov-update`.
#[tauri::command]
pub fn update_check_now<R: Runtime>(app: AppHandle<R>, reason: Option<Reason>) -> Status {
    let reason = match reason {
        Some(Reason::SignIn) => Reason::SignIn,
        _ => Reason::Manual,
    };
    let h = app.clone();
    tauri::async_runtime::spawn(async move { check(&h, reason).await });
    status(&app)
}

#[tauri::command]
pub async fn update_install_now<R: Runtime>(app: AppHandle<R>) -> Result<Status, InstallError> {
    install_now(&app).await?;
    Ok(status(&app))
}

#[tauri::command]
pub fn update_set_prefs<R: Runtime>(app: AppHandle<R>, auto_check: Option<bool>, auto_install: Option<bool>) -> Status {
    {
        let updates = app.state::<Updates>();
        let mut i = updates.lock();
        if let Some(v) = auto_check {
            i.prefs.auto_check = v;
        }
        if let Some(v) = auto_install {
            i.prefs.auto_install = v;
        }
        save_prefs(i.prefs_path.as_deref(), &i.prefs);
    }
    push(&app);
    status(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gate(live: MatchLive, tablets: usize, net: bool, page: bool) -> GateInput {
        GateInput { live, tablets, tablet_net_on: net, page_ready: page }
    }

    #[test]
    fn restart_only_when_everything_is_clear() {
        let lives = [MatchLive::None, MatchLive::Official, MatchLive::Test];
        for live in lives {
            for tablets in [0usize, 1, 3] {
                for net in [false, true] {
                    for page in [false, true] {
                        let g = gate(live, tablets, net, page);
                        let b = restart_blockers(&g);
                        let clear = live == MatchLive::None && tablets == 0 && !net && page;
                        assert_eq!(b.is_empty(), clear, "{g:?} -> {b:?}");
                        assert_eq!(b.contains(&Blocker::MatchLive), live != MatchLive::None);
                        assert_eq!(b.contains(&Blocker::Tablets { count: tablets }), tablets > 0);
                        assert_eq!(b.contains(&Blocker::TabletNetwork), net);
                        assert_eq!(b.contains(&Blocker::PageNotReady), !page);
                    }
                }
            }
        }
    }

    #[test]
    fn quit_install_and_download_only_without_a_live_match() {
        assert!(quit_install_allowed(&gate(MatchLive::None, 3, true, false)), "tablets stop with the quit anyway");
        assert!(!quit_install_allowed(&gate(MatchLive::Official, 0, false, true)));
        assert!(!quit_install_allowed(&gate(MatchLive::Test, 0, false, true)));
        assert!(download_allowed(&gate(MatchLive::None, 2, true, true)));
        assert!(!download_allowed(&gate(MatchLive::Official, 0, false, true)));
        assert!(!download_allowed(&gate(MatchLive::Test, 0, false, true)));
    }

    #[test]
    fn checks_are_due() {
        let t0 = Instant::now();
        let at = |secs: u64| t0 + Duration::from_secs(secs);
        assert!(check_due(t0, None, Reason::Start));
        assert!(!check_due(at(5 * 3600), Some(t0), Reason::Timer));
        assert!(check_due(at(6 * 3600), Some(t0), Reason::Timer));
        assert!(!check_due(at(14 * 60), Some(t0), Reason::SignIn));
        assert!(check_due(at(15 * 60), Some(t0), Reason::SignIn));
        assert!(check_due(t0, Some(t0), Reason::Manual));
        // a clock that went backwards is not "due" by underflow
        assert!(!check_due(t0, Some(at(10)), Reason::Timer));
    }

    #[test]
    fn a_replaced_binary_is_noticed() {
        assert!(exe_replaced("/usr/bin/openvolley-escoresheet (deleted)"));
        assert!(!exe_replaced("/usr/bin/openvolley-escoresheet"));
        assert!(!exe_replaced("/tmp/.mount_OpenvoXyz/usr/bin/openvolley-escoresheet"));
    }

    #[test]
    fn kind_from_the_bundle_and_the_repo() {
        assert_eq!(Kind::detect(Some(BundleType::Nsis), false), Kind::Nsis);
        assert_eq!(Kind::detect(Some(BundleType::AppImage), true), Kind::AppImage);
        assert_eq!(Kind::detect(Some(BundleType::Deb), true), Kind::DebApt);
        assert_eq!(Kind::detect(Some(BundleType::Deb), false), Kind::DebNoRepo);
        assert_eq!(Kind::detect(Some(BundleType::Msi), false), Kind::Unsupported);
        assert_eq!(Kind::detect(Some(BundleType::Rpm), false), Kind::Unsupported);
        assert_eq!(Kind::detect(None, true), Kind::Unsupported, "a development build");
        assert!(Kind::Nsis.downloads() && Kind::AppImage.downloads());
        assert!(!Kind::DebApt.downloads() && !Kind::DebNoRepo.downloads());
    }

    #[test]
    fn prefs_round_trip_and_the_declined_prompt_expires() {
        let mut p = Prefs::default();
        assert!(p.auto_check && p.auto_install);
        p.auto_install = false;
        p.decline("2.2.1", 1_000);
        let back = Prefs::parse(&serde_json::to_string(&p).unwrap());
        assert_eq!(back, p);
        assert!(back.declined_active("2.2.1", 1_000 + DECLINE_SECS - 1));
        assert!(!back.declined_active("2.2.1", 1_000 + DECLINE_SECS), "after 3 days it asks again");
        assert!(!back.declined_active("2.2.2", 1_001), "a newer version asks again");
        // camelCase on disk; a damaged or partial file is the defaults
        assert!(serde_json::to_string(&p).unwrap().contains("\"autoInstall\":false"));
        assert_eq!(Prefs::parse("{not json"), Prefs::default());
        assert_eq!(Prefs::parse(r#"{"autoCheck":false}"#), Prefs { auto_check: false, ..Prefs::default() });
    }

    #[test]
    fn deb_helper_exit_codes() {
        assert_eq!(deb_outcome(Some(0), true), DebOutcome::Upgraded);
        assert_eq!(deb_outcome(Some(0), false), DebOutcome::NotUpgraded);
        assert_eq!(deb_outcome(Some(3), false), DebOutcome::NoRepo);
        assert_eq!(deb_outcome(Some(4), false), DebOutcome::Failed("aptFailed"));
        assert_eq!(deb_outcome(Some(5), false), DebOutcome::Failed("aptFailed"));
        assert_eq!(deb_outcome(Some(64), false), DebOutcome::Failed("aptFailed"));
        assert_eq!(deb_outcome(Some(126), false), DebOutcome::Failed("noPkexec"));
        assert_eq!(deb_outcome(Some(127), false), DebOutcome::Failed("noPkexec"));
        assert_eq!(deb_outcome(None, false), DebOutcome::Failed("noPkexec"));
    }

    fn tick(kind: Kind) -> TickInput {
        TickInput {
            now: Instant::now(),
            kind,
            live: MatchLive::None,
            live_ended: None,
            last_check: None,
            auto_check: true,
            auto_install: true,
            phase: Phase::Idle,
            available: None,
            downloaded: false,
            deb_tried: None,
        }
    }

    #[test]
    fn the_scheduler_waits_for_the_match_and_a_bit_after() {
        let t = tick(Kind::Nsis);
        assert_eq!(next_step(&t), Step::Check);
        assert_eq!(next_step(&TickInput { live: MatchLive::Official, ..t.clone() }), Step::Nothing);
        assert_eq!(next_step(&TickInput { live: MatchLive::Test, ..t.clone() }), Step::Nothing);
        let ended = t.now - Duration::from_secs(60);
        assert_eq!(next_step(&TickInput { live_ended: Some(ended), ..t.clone() }), Step::Nothing, "1 min after the match");
        let ended = t.now - AFTER_MATCH;
        assert_eq!(next_step(&TickInput { live_ended: Some(ended), ..t.clone() }), Step::Check, "5 min after");
        assert_eq!(next_step(&TickInput { auto_check: false, ..t.clone() }), Step::Nothing);
        assert_eq!(next_step(&tick(Kind::Unsupported)), Step::Nothing);
    }

    #[test]
    fn the_scheduler_downloads_what_a_match_held_back() {
        let t = TickInput { last_check: Some(Instant::now()), available: Some("2.2.1".into()), phase: Phase::Available, ..tick(Kind::AppImage) };
        assert_eq!(next_step(&t), Step::Download);
        assert_eq!(next_step(&TickInput { live: MatchLive::Official, ..t.clone() }), Step::Nothing);
        assert_eq!(next_step(&TickInput { downloaded: true, phase: Phase::Ready, ..t.clone() }), Step::Nothing);
        assert_eq!(next_step(&TickInput { phase: Phase::Downloading { got: 1, total: None }, ..t.clone() }), Step::Nothing);
        // also when automatic checks are off (the scorer checked by hand)
        assert_eq!(next_step(&TickInput { auto_check: false, ..t.clone() }), Step::Download);
        // a download that failed (offline, a signature that does not verify)
        // waits for the next check
        let failed = TickInput { phase: Phase::Failed { msg: "downloadFailed".into() }, ..t.clone() };
        assert_eq!(next_step(&failed), Step::Nothing);
        let later = TickInput { last_check: Some(t.now - CHECK_EVERY), ..failed };
        assert_eq!(next_step(&later), Step::Check);
    }

    #[test]
    fn the_scheduler_runs_the_apt_helper_once_per_version() {
        let t = TickInput { last_check: Some(Instant::now()), available: Some("2.2.1".into()), phase: Phase::Ready, ..tick(Kind::DebApt) };
        assert_eq!(next_step(&t), Step::DebUpgrade);
        assert_eq!(next_step(&TickInput { deb_tried: Some("2.2.1".into()), ..t.clone() }), Step::Nothing);
        assert_eq!(next_step(&TickInput { deb_tried: Some("2.2.0".into()), ..t.clone() }), Step::DebUpgrade);
        assert_eq!(next_step(&TickInput { auto_install: false, ..t.clone() }), Step::Nothing);
        assert_eq!(next_step(&TickInput { phase: Phase::RestartPending, ..t.clone() }), Step::Nothing);
        assert_eq!(next_step(&TickInput { live: MatchLive::Test, ..t.clone() }), Step::Nothing);
        let t = TickInput { kind: Kind::DebNoRepo, ..t };
        assert_eq!(next_step(&t), Step::Nothing);
    }

    #[test]
    fn what_can_restart() {
        assert!(restart_ready(Kind::Nsis, &Phase::Ready, true, true));
        assert!(!restart_ready(Kind::Nsis, &Phase::Available, false, true));
        assert!(!restart_ready(Kind::AppImage, &Phase::Installing, true, true));
        // the file replaced, the restart held back by the gate
        assert!(restart_ready(Kind::AppImage, &Phase::RestartPending, false, false));
        assert!(restart_ready(Kind::DebApt, &Phase::RestartPending, false, false));
        assert!(restart_ready(Kind::DebApt, &Phase::Ready, false, true));
        assert!(!restart_ready(Kind::DebNoRepo, &Phase::Ready, false, true));
        assert!(!restart_ready(Kind::Unsupported, &Phase::Ready, true, true));
    }

    #[test]
    fn status_for_the_page() {
        let st = Status {
            kind: Kind::AppImage,
            phase: Phase::Downloading { got: 10, total: Some(100) },
            current: "2.2.0".into(),
            available: Some(Available { version: "2.2.1".into(), notes: Some("Fixes".into()), date: None }),
            auto_check: true,
            auto_install: false,
            blockers: vec![Blocker::MatchLive, Blocker::Tablets { count: 2 }],
            can_restart: false,
            manual: false,
            seq: 7,
        };
        let v = serde_json::to_value(&st).unwrap();
        assert_eq!(v["kind"], "appImage");
        assert_eq!(v["phase"], "downloading");
        assert_eq!(v["got"], 10);
        assert_eq!(v["total"], 100);
        assert_eq!(v["available"]["version"], "2.2.1");
        assert_eq!(v["autoInstall"], false);
        assert_eq!(v["blockers"][0]["kind"], "matchLive");
        assert_eq!(v["blockers"][1], serde_json::json!({ "kind": "tablets", "count": 2 }));
        assert_eq!(v["canRestart"], false);
        assert_eq!(v["seq"], 7);
        assert!(next_seq() < next_seq(), "numbered in order");
        let failed = serde_json::to_value(Phase::Failed { msg: "needsAdmin".into() }).unwrap();
        assert_eq!(failed, serde_json::json!({ "phase": "failed", "msg": "needsAdmin" }));
        assert_eq!(serde_json::to_value(Phase::RestartPending).unwrap()["phase"], "restartPending");
        assert_eq!(serde_json::to_value(Kind::DebNoRepo).unwrap(), "debNoRepo");
        assert_eq!(serde_json::from_str::<Reason>(r#""signIn""#).unwrap(), Reason::SignIn);
        assert_eq!(
            event_script(r#"{"phase":"idle"}"#),
            r#"window.dispatchEvent(new CustomEvent('ov-update', { detail: {"phase":"idle"} }))"#
        );
    }

    /// The manifest publish-pkgs.sh writes: every platform key the three
    /// kinds of install look up (`{os}-{arch}-{installer}`, then `{os}-{arch}`).
    #[test]
    fn manifest_fixture_has_every_platform() {
        let text = include_str!("../tests/fixtures/latest.json");
        let release: tauri_plugin_updater::RemoteRelease = serde_json::from_str(text).unwrap();
        assert_eq!(release.version.to_string(), "2.2.1");
        assert!(release.notes.as_deref().unwrap_or_default().contains("never during a match"));
        for key in [
            "windows-x86_64-nsis",
            "windows-x86_64",
            "linux-x86_64-appimage",
            "linux-x86_64",
            "linux-x86_64-deb",
        ] {
            let url = release.download_url(key).unwrap_or_else(|e| panic!("{key}: {e}"));
            assert_eq!(url.scheme(), "https", "{key}");
            assert!(url.as_str().contains("2.2.1"), "{key}: {url}");
            assert!(!release.signature(key).unwrap().is_empty(), "{key}");
        }
        assert!(release.download_url("windows-x86_64-nsis").unwrap().as_str().ends_with("_x64-setup.exe"));
        assert!(release.download_url("linux-x86_64-deb").unwrap().as_str().ends_with("_amd64.deb"));
        assert!(release.download_url("linux-x86_64-appimage").unwrap().as_str().ends_with(".AppImage"));
    }

    // -- on Tauri's mock runtime, with the app's real managed state ----------

    fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
        crate::with_app_commands(tauri::test::mock_builder())
            .build(tauri::generate_context!())
            .expect("mock app")
    }

    fn set_installed(h: &AppHandle<tauri::test::MockRuntime>, kind: Kind, phase: Phase) {
        let updates = h.state::<Updates>();
        let mut i = updates.lock();
        i.kind = kind;
        i.available = Some(Available { version: "2.2.0".into(), notes: None, date: None });
        i.pending = None;
        i.phase = phase;
    }

    /// "Restart and update": the gate was open when the scorer clicked, the
    /// install step ran (the APT helper can take minutes), and meanwhile a
    /// tablet connected. No restart: it waits, "Restart to finish", and is
    /// offered again once the gate opens.
    #[test]
    fn a_restart_waits_when_the_gate_closed_during_the_install() {
        let app = mock_app();
        let h = app.handle();
        h.state::<Lifecycle>().gate().page_attached("h1");
        set_installed(h, Kind::DebApt, Phase::Ready);
        assert!(gate_clear(h).is_ok(), "the gate is open when the scorer clicks");
        assert!(status(h).can_restart);

        // the helper upgraded the package; a tablet connected meanwhile
        h.state::<Updates>().set_phase(Phase::RestartPending);
        lifecycle::set_tablet_count(h, 2);
        let err = after_deb_upgrade(h).expect_err("no restart with a tablet connected");
        assert_eq!(err.code, "blocked");
        assert_eq!(err.blockers, vec![Blocker::Tablets { count: 2 }]);
        assert_eq!(h.state::<Updates>().lock().phase, Phase::RestartPending);
        // the restart was not let through: an exit is still asked for
        assert_eq!(h.state::<Lifecycle>().gate().exit_requested(true), lifecycle::ExitDecision::Prevent);
        let st = status(h);
        assert!(!st.can_restart);
        assert_eq!(st.phase, Phase::RestartPending);

        // AppImage: the file is replaced, the restart waits the same way
        set_installed(h, Kind::AppImage, Phase::Installing);
        let err = restart_when_clear(h).expect_err("no restart with a tablet connected");
        assert_eq!(err.code, "blocked");
        assert_eq!(h.state::<Updates>().lock().phase, Phase::RestartPending);
        assert_eq!(h.state::<Lifecycle>().gate().exit_requested(true), lifecycle::ExitDecision::Prevent);

        // the tablet left: the page and the tray offer the restart again
        lifecycle::set_tablet_count(h, 0);
        let st = status(h);
        assert!(st.can_restart, "offered again: {st:?}");
        assert!(st.blockers.is_empty());
    }

    /// Windows: the plugin runs the before-exit hook before the
    /// administrator prompt, which the scorer can cancel. The hook must not
    /// be Tauri's exit cleanup (cleanup_before_exit drops the tray icon for
    /// good, hides every window and clears the app's resources): after a
    /// cancelled prompt the app runs on with its window and its tray.
    #[test]
    fn the_installer_hook_leaves_a_running_app() {
        struct Marker;
        impl tauri::Resource for Marker {}
        let app = mock_app();
        let h = app.handle();
        let _main = tauri::WebviewWindowBuilder::new(h, lifecycle::MAIN, tauri::WebviewUrl::External("http://localhost:5173/".parse().unwrap()))
            .build()
            .unwrap();
        let rid = h.resources_table().add(Marker);
        before_installer(h);
        after_failed_install(h);
        assert!(h.resources_table().get::<Marker>(rid).is_ok(), "the hook ran the app's exit cleanup");
        assert!(h.get_webview_window(lifecycle::MAIN).is_some());
    }
}
