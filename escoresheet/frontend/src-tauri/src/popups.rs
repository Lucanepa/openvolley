//! window.open() from the scoretable page, and the files it downloads.
//!
//! Without a new-window handler the webview refuses every window.open()
//! (WebKitGTK: null, so the app said "allow popups" and the scoresheet never
//! opened). Here:
//!
//! - the app's own pages (http://localhost:<port>/..., e.g. /scoresheet/) open
//!   as a new app window. It is the webview the opener asked for, so it shares
//!   the web process and data store (the scoresheet reads the match from the
//!   same IndexedDB) and keeps window.opener (the PDF of the match-end
//!   approval comes back by postMessage);
//! - web links and mailto: go to the system browser / mail app;
//! - anything else (file:, data:, custom schemes) is refused.
//!
//! New windows get labels "popup-<n>": the capabilities only name "main", so
//! they have no app commands (backups) of their own (main.rs ipc_acl_tests
//! checks that a "popup-1" window is refused them). They belong to the
//! scoretable: when the main window goes, they are closed with it.
//!
//! Downloads (the scoresheet's "Save PDF" is a blob download) go to the
//! user's Downloads folder under a free name; when one finishes, the file on
//! disk is checked (a PDF must be complete: `%PDF-` ... `%%EOF`) and the page
//! hears where (`ov-download-finished` DOM event with the path, the file name
//! and an id). With that id, and only that, the page may ask the app to open
//! the file or show it in its folder (`download_open` / `download_reveal`,
//! capabilities/downloads.json): never a path the page names itself.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::webview::{DownloadEvent, NewWindowFeatures, NewWindowResponse};
use tauri::{AppHandle, Manager, Runtime, Url, Webview, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[derive(Debug, PartialEq, Eq)]
pub enum PopupTarget {
    /// One of the app's own pages: a new app window.
    AppWindow,
    /// A web or mail link: the system's default handler.
    System,
    /// Refused.
    Deny,
}

fn is_loopback_host(host: Option<&str>) -> bool {
    matches!(host, Some("localhost") | Some("127.0.0.1") | Some("[::1]"))
}

/// Where a window.open(url) from the app goes. `http_port` is the port of the
/// built-in server the app window is loaded from.
pub fn classify(url: &Url, http_port: u16) -> PopupTarget {
    match url.scheme() {
        "http" if is_loopback_host(url.host_str()) && url.port_or_known_default() == Some(http_port) => {
            PopupTarget::AppWindow
        }
        "http" | "https" => {
            if url.host_str().is_some_and(|h| !h.is_empty()) {
                PopupTarget::System
            } else {
                PopupTarget::Deny
            }
        }
        "mailto" => PopupTarget::System,
        _ => PopupTarget::Deny,
    }
}

/// The command that hands `url` to the system's default browser / mail app.
/// The URL is one argument (no shell), and classify() only lets http(s) and
/// mailto through.
pub fn system_open_command(url: &str) -> std::process::Command {
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("rundll32.exe");
        c.arg("url.dll,FileProtocolHandler");
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut cmd = std::process::Command::new("xdg-open");
    cmd.arg(url);
    cmd
}

/// At most one link handed to the system per this interval. Scripts may open
/// windows without a click on Linux (see let_scripts_open_windows), so this
/// caps what a script could do with that: no burst of browser tabs / mail
/// windows. A scorer never clicks two external links within a second.
pub const SYSTEM_OPEN_MIN_INTERVAL: Duration = Duration::from_secs(1);

static LAST_SYSTEM_OPEN: Mutex<Option<Instant>> = Mutex::new(None);

/// Whether a system open at `now` is allowed after the last one at `last`.
pub fn system_open_allowed(last: Option<Instant>, now: Instant, min_interval: Duration) -> bool {
    match last {
        Some(last) => now.saturating_duration_since(last) >= min_interval,
        None => true,
    }
}

fn open_in_system(url: &Url) {
    {
        let mut last = LAST_SYSTEM_OPEN.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        if !system_open_allowed(*last, now, SYSTEM_OPEN_MIN_INTERVAL) {
            eprintln!("[popup] refused {url}: another link was opened less than a second ago");
            return;
        }
        *last = Some(now);
    }
    match system_open_command(url.as_str()).spawn() {
        Ok(mut child) => {
            std::thread::spawn(move || {
                let _ = child.wait(); // reap it (no zombie)
            });
        }
        Err(e) => eprintln!("[popup] cannot open {url} in the system browser: {e}"),
    }
}

static POPUP_COUNTER: AtomicUsize = AtomicUsize::new(0);

/// A unique label for the next app window opened by window.open().
pub fn next_popup_label() -> String {
    format!("popup-{}", POPUP_COUNTER.fetch_add(1, Ordering::Relaxed) + 1)
}

/// Whether a window label is one of the app windows opened by window.open().
pub fn is_popup_label(label: &str) -> bool {
    label.starts_with("popup-")
}

/// Closes every app window opened by window.open() (the scoresheet windows).
/// Called when the main window goes: they belong to the scoretable.
pub fn close_app_windows<R: Runtime>(app: &AppHandle<R>) {
    for (label, window) in app.webview_windows() {
        if is_popup_label(&label) {
            let _ = window.destroy();
        }
    }
}

/// The window.open() handler for an app window (the main one and the popups).
pub fn new_window_handler<R: Runtime>(
    app: AppHandle<R>,
    http_port: u16,
) -> impl Fn(Url, NewWindowFeatures) -> NewWindowResponse<R> + Send + 'static {
    move |url, features| match classify(&url, http_port) {
        PopupTarget::AppWindow => match build_popup(&app, http_port, features) {
            Ok(window) => NewWindowResponse::Create { window },
            Err(e) => {
                eprintln!("[popup] cannot open a window for {url}: {e}");
                NewWindowResponse::Deny
            }
        },
        PopupTarget::System => {
            open_in_system(&url);
            NewWindowResponse::Deny
        }
        PopupTarget::Deny => {
            eprintln!("[popup] refused window.open({url})");
            NewWindowResponse::Deny
        }
    }
}

/// The new app window for a window.open() of one of the app's pages. It starts
/// on about:blank: the webview then loads the requested page itself, as the
/// opener's child (same web process / environment, window.opener set).
fn build_popup<R: Runtime>(
    app: &AppHandle<R>,
    http_port: u16,
    features: NewWindowFeatures,
) -> tauri::Result<WebviewWindow<R>> {
    let builder = WebviewWindowBuilder::new(app, next_popup_label(), WebviewUrl::External("about:blank".parse().unwrap()))
        .title(crate::flavour::CURRENT.window_title)
        .inner_size(1200.0, 900.0)
        .min_inner_size(600.0, 400.0)
        .theme(Some(tauri::Theme::Light))
        // window.open's width/height (Windows / macOS) and, above all, the
        // opener's web process / environment / configuration
        .window_features(features)
        .on_document_title_changed(|window, title| {
            let _ = window.set_title(&title);
        })
        .on_new_window(new_window_handler(app.clone(), http_port));
    // WebView2 (and WKWebView) report downloads per webview: the popup needs
    // its own handler, or the scoresheet's "Save PDF" never says where the
    // file went. On WebKitGTK the handler is on the web context the popups
    // share with the main window: a second one would fire twice per download.
    #[cfg(not(target_os = "linux"))]
    let builder = builder.on_download(on_download);
    let window = builder.build()?;
    let_scripts_open_windows(&window);
    close_on_window_close(&window);
    Ok(window)
}

/// WebKitGTK only asks the new-window handler about a window.open() made
/// during a click: the app's buttons first read the match from IndexedDB and
/// call window.open() after those awaits, which WebKit then blocked on its own
/// (no handler call, null). The handler above decides what may open, so let
/// scripts open windows. (WebView2 always asks the handler.)
///
/// The trade-off: any script in the app's windows may now open a window
/// without a click. Only the app's own pages load in them, and the handler
/// still decides: app pages as app windows, http(s) / mailto to the system at
/// most once a second (SYSTEM_OPEN_MIN_INTERVAL), everything else refused. An
/// injected script (e.g. through a team or player name) could at worst open
/// one web / mail link per second, not a burst of them.
#[cfg(target_os = "linux")]
pub fn let_scripts_open_windows<R: Runtime>(window: &WebviewWindow<R>) {
    use webkit2gtk::{SettingsExt, WebViewExt};
    let _ = window.with_webview(|platform| {
        let webview: webkit2gtk::WebView = platform.inner();
        if let Some(settings) = WebViewExt::settings(&webview) {
            settings.set_javascript_can_open_windows_automatically(true);
        }
    });
}

#[cfg(not(target_os = "linux"))]
pub fn let_scripts_open_windows<R: Runtime>(_window: &WebviewWindow<R>) {}

/// window.close() in a popup (the match-end PDF window closes itself once the
/// PDF is sent): WebKitGTK only destroys the webview, which left an empty
/// window behind. Close the app window with it. (WebView2 already closes the
/// window; macOS is not a target.)
#[cfg(target_os = "linux")]
fn close_on_window_close<R: Runtime>(window: &WebviewWindow<R>) {
    use gtk::prelude::WidgetExt;
    let w = window.clone();
    let _ = window.with_webview(move |platform| {
        let webview: webkit2gtk::WebView = platform.inner();
        let w = w.clone();
        // wry answers WebKit's "close" by destroying the webview, which also
        // drops every other "close" handler: hook the destroy instead. (When
        // the window itself is closed, close() on it again is a no-op.)
        webview.connect_destroy(move |_| {
            let _ = w.close();
        });
    });
}

#[cfg(not(target_os = "linux"))]
fn close_on_window_close<R: Runtime>(_window: &WebviewWindow<R>) {}

/// The JS that tells a page where its download went (or that it failed).
/// `fileName` lets a page tell its own download from another window's (the
/// scoresheet ignores the match-end ZIP of the scoretable); `id` names the
/// recorded download for download_open / download_reveal.
pub fn download_finished_script(path: Option<&std::path::Path>, success: bool, id: Option<u64>) -> String {
    let detail = serde_json::json!({
        "path": path.map(|p| p.to_string_lossy().into_owned()),
        "fileName": path.and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()),
        "success": success,
        "id": id,
    });
    format!("window.dispatchEvent(new CustomEvent('ov-download-finished', {{ detail: {detail} }}))")
}

/// Whether `bytes` are a whole PDF: the header at the start, `%%EOF` at the end
/// (trailing white space allowed). A cut-off or empty download is not.
pub fn is_complete_pdf(bytes: &[u8]) -> bool {
    if bytes.len() < 64 || !bytes.starts_with(b"%PDF-") {
        return false;
    }
    let tail = &bytes[bytes.len().saturating_sub(64)..];
    let trimmed = tail
        .iter()
        .rposition(|b| !b.is_ascii_whitespace())
        .map(|end| &tail[..=end])
        .unwrap_or(&[]);
    trimmed.ends_with(b"%%EOF")
}

/// Whether the finished download really is on disk, whole. A `.pdf` must be a
/// complete PDF; anything else must at least not be empty.
///
/// wry (WebKitGTK) keeps one "failed" flag for the whole web context and never
/// resets it: after one failed or cancelled download it reports every later one
/// as failed, without a path. So the file on disk decides, not `success`.
pub fn verify_download(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else { return false };
    if !meta.is_file() || meta.len() == 0 {
        return false;
    }
    let is_pdf = path
        .extension()
        .is_some_and(|e| e.to_string_lossy().eq_ignore_ascii_case("pdf"));
    if !is_pdf {
        return true;
    }
    match std::fs::read(path) {
        Ok(bytes) => is_complete_pdf(&bytes),
        Err(_) => false,
    }
}

/// Downloads that finished and were checked, by id (the newest RECENT_DOWNLOADS):
/// the only files download_open / download_reveal will touch.
const RECENT_DOWNLOADS: usize = 32;
static DOWNLOADS: Mutex<Vec<(u64, PathBuf)>> = Mutex::new(Vec::new());
static NEXT_DOWNLOAD_ID: AtomicU64 = AtomicU64::new(1);
/// Destinations chosen in DownloadEvent::Requested, by URL: wry reports no path
/// for a download once its stale "failed" flag is set.
static REQUESTED: Mutex<Vec<(String, PathBuf)>> = Mutex::new(Vec::new());

/// Records a finished, checked download; returns its id.
pub fn record_download(path: PathBuf) -> u64 {
    let id = NEXT_DOWNLOAD_ID.fetch_add(1, Ordering::Relaxed);
    let mut list = DOWNLOADS.lock().unwrap_or_else(|e| e.into_inner());
    list.push((id, path));
    let excess = list.len().saturating_sub(RECENT_DOWNLOADS);
    list.drain(..excess);
    id
}

/// The file of a recorded download.
pub fn recorded_download(id: u64) -> Option<PathBuf> {
    let list = DOWNLOADS.lock().unwrap_or_else(|e| e.into_inner());
    list.iter().find(|(i, _)| *i == id).map(|(_, p)| p.clone())
}

fn remember_requested(url: &Url, destination: &Path) {
    let mut list = REQUESTED.lock().unwrap_or_else(|e| e.into_inner());
    list.push((url.as_str().to_string(), destination.to_path_buf()));
    let excess = list.len().saturating_sub(RECENT_DOWNLOADS);
    list.drain(..excess);
}

fn take_requested(url: &Url) -> Option<PathBuf> {
    let mut list = REQUESTED.lock().unwrap_or_else(|e| e.into_inner());
    let pos = list.iter().rposition(|(u, _)| u == url.as_str())?;
    Some(list.remove(pos).1)
}

/// The command that opens a file with its default application. One argument
/// (no shell); the path is always a recorded download.
pub fn open_file_command(path: &Path) -> std::process::Command {
    #[cfg(target_os = "windows")]
    let program = "explorer";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let program = "xdg-open";
    let mut cmd = std::process::Command::new(program);
    cmd.arg(path);
    cmd
}

/// The command that shows a file in the system file manager: selected in its
/// folder on Windows (`explorer /select,<path>`, one argument), its folder
/// elsewhere.
pub fn reveal_file_command(path: &Path) -> std::process::Command {
    #[cfg(target_os = "windows")]
    {
        let mut select = std::ffi::OsString::from("/select,");
        select.push(path.as_os_str());
        let mut cmd = std::process::Command::new("explorer");
        cmd.arg(select);
        cmd
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        cmd.arg("-R").arg(path);
        cmd
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let mut cmd = std::process::Command::new("xdg-open");
        cmd.arg(path.parent().unwrap_or(path));
        cmd
    }
}

fn spawn_and_reap(mut cmd: std::process::Command) -> Result<(), String> {
    // spawn, never wait: explorer.exe exits 1 even on success
    let mut child = cmd.spawn().map_err(|e| format!("cannot start the file manager: {e}"))?;
    std::thread::spawn(move || {
        let _ = child.wait(); // reap it (no zombie)
    });
    Ok(())
}

/// The recorded download `id`, still on disk.
fn existing_download(id: u64) -> Result<PathBuf, String> {
    let path = recorded_download(id).ok_or_else(|| "unknown download".to_string())?;
    if !path.is_file() {
        return Err(format!("{} is not there any more", path.display()));
    }
    Ok(path)
}

/// Opens a file the app downloaded (the scoresheet's PDF) with its default
/// application. Only an id recorded by on_download: never a page-supplied path.
#[tauri::command]
pub async fn download_open(id: u64) -> Result<(), String> {
    let path = existing_download(id)?;
    spawn_and_reap(open_file_command(&path))
}

/// Shows a file the app downloaded in the system file manager.
#[tauri::command]
pub async fn download_reveal(id: u64) -> Result<(), String> {
    let path = existing_download(id)?;
    spawn_and_reap(reveal_file_command(&path))
}

/// The folder downloads go to: the XDG / known Downloads folder, else
/// ~/Downloads when it exists, else home. (Without user-dirs.dirs, wry fell
/// back to the process's working directory, wherever the app was started.)
pub fn downloads_dir(known: Option<PathBuf>, home: Option<PathBuf>) -> Option<PathBuf> {
    known.or_else(|| {
        let home = home?;
        let downloads = home.join("Downloads");
        Some(if downloads.is_dir() { downloads } else { home })
    })
}

/// `dir/name`, or `dir/name (1).ext`, `(2)` ... when taken (like wry / WebView2).
pub fn free_path(dir: &Path, file_name: &str) -> PathBuf {
    let candidate = dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = match file_name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem.to_string(), format!(".{ext}")),
        _ => (file_name.to_string(), String::new()),
    };
    (1..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap()
}

/// Downloads of the app's windows (the scoresheet's "Save PDF", the match-end
/// ZIP). The file goes to the Downloads folder; the page then hears where
/// (`ov-download-finished`; the scoresheet window shows it).
///
/// WebKitGTK: the handler sits on the web context the popups share with the
/// main window, so the one registered on the main window sees every download,
/// and `webview` is always the main one, not the window that started it: the
/// event goes to every window, and each page keeps only its own file (by
/// `fileName`). WebView2 / WKWebView: one handler per webview (build_popup
/// registers it on the popups too), and `webview` is the one that downloaded.
pub fn on_download<R: Runtime>(webview: Webview<R>, event: DownloadEvent<'_>) -> bool {
    match event {
        DownloadEvent::Requested { url, destination } => {
            let paths = webview.path();
            if let Some(dir) = downloads_dir(paths.download_dir().ok(), paths.home_dir().ok()) {
                let name = destination
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "download".into());
                // always a free name of our own (wry numbers "a.b.pdf" as "a (1).b.pdf")
                *destination = free_path(&dir, &name);
            }
            remember_requested(&url, destination);
            eprintln!("[download] {} -> {}", short(&url), destination.display());
            true
        }
        DownloadEvent::Finished { url, path, success } => {
            let requested = take_requested(&url);
            let dest = path.or(requested);
            // the file on disk decides (see verify_download)
            let ok = dest.as_deref().is_some_and(verify_download);
            eprintln!("[download] {} finished: reported {success}, on disk {ok}: {:?}", short(&url), dest);
            let id = if ok { dest.clone().map(record_download) } else { None };
            let script = download_finished_script(if ok { dest.as_deref() } else { None }, ok, id);
            if cfg!(target_os = "linux") {
                for window in webview.app_handle().webview_windows().values() {
                    let _ = window.eval(&script);
                }
            } else {
                let _ = webview.eval(&script);
            }
            true
        }
        _ => true,
    }
}

// blob:/data: URLs can be huge (data:) or meaningless; log the scheme + start only
fn short(url: &Url) -> String {
    url.as_str().chars().take(80).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        s.parse().unwrap()
    }

    #[test]
    fn app_pages_open_as_app_windows() {
        assert_eq!(classify(&u("http://localhost:5173/scoresheet/?matchId=7"), 5173), PopupTarget::AppWindow);
        assert_eq!(classify(&u("http://127.0.0.1:5173/scoresheet/"), 5173), PopupTarget::AppWindow);
        assert_eq!(classify(&u("http://localhost:5174/scoresheet/"), 5174), PopupTarget::AppWindow);
    }

    #[test]
    fn other_origins_are_not_app_windows() {
        // another port, https, a look-alike host, the LAN address
        assert_eq!(classify(&u("http://localhost:8080/"), 5173), PopupTarget::System);
        assert_eq!(classify(&u("https://localhost:5173/"), 5173), PopupTarget::System);
        assert_eq!(classify(&u("http://localhost.evil.com:5173/"), 5173), PopupTarget::System);
        assert_eq!(classify(&u("http://192.168.1.20:5173/"), 5173), PopupTarget::System);
        assert_eq!(classify(&u("https://openvolley.app/help"), 5173), PopupTarget::System);
        assert_eq!(classify(&u("mailto:support@openvolley.app?subject=x"), 5173), PopupTarget::System);
    }

    #[test]
    fn other_schemes_are_refused() {
        for s in ["file:///etc/passwd", "data:text/html,<b>x</b>", "javascript:alert(1)", "ftp://example.com/", "blob:http://localhost:5173/abc", "about:blank"] {
            assert_eq!(classify(&u(s), 5173), PopupTarget::Deny, "{s}");
        }
    }

    #[test]
    fn system_open_passes_the_url_as_one_argument() {
        let url = "https://example.com/?a=1&b=2;rm -rf ~";
        let cmd = system_open_command(url);
        let args: Vec<_> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args.last().map(String::as_str), Some(url));
        #[cfg(target_os = "linux")]
        assert_eq!(cmd.get_program(), "xdg-open");
    }

    #[test]
    fn popup_labels_are_unique() {
        let a = next_popup_label();
        let b = next_popup_label();
        assert_ne!(a, b);
        assert!(a.starts_with("popup-") && b.starts_with("popup-"));
    }

    #[test]
    fn downloads_go_to_the_downloads_folder() {
        let tmp = std::env::temp_dir().join(format!("ov-dl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        // the known (XDG) folder wins
        assert_eq!(downloads_dir(Some("/x/Dl".into()), Some(tmp.clone())), Some(PathBuf::from("/x/Dl")));
        // no XDG folder: ~/Downloads when it exists, else home
        assert_eq!(downloads_dir(None, Some(tmp.clone())), Some(tmp.clone()));
        std::fs::create_dir(tmp.join("Downloads")).unwrap();
        assert_eq!(downloads_dir(None, Some(tmp.clone())), Some(tmp.join("Downloads")));
        assert_eq!(downloads_dir(None, None), None);

        // never overwrite: "name (1).pdf", "name (2).pdf"
        let dir = tmp.join("Downloads");
        assert_eq!(free_path(&dir, "7_A_B.pdf"), dir.join("7_A_B.pdf"));
        std::fs::write(dir.join("7_A_B.pdf"), b"x").unwrap();
        assert_eq!(free_path(&dir, "7_A_B.pdf"), dir.join("7_A_B (1).pdf"));
        std::fs::write(dir.join("7_A_B (1).pdf"), b"x").unwrap();
        assert_eq!(free_path(&dir, "7_A_B.pdf"), dir.join("7_A_B (2).pdf"));
        std::fs::write(dir.join("noext"), b"x").unwrap();
        assert_eq!(free_path(&dir, "noext"), dir.join("noext (1)"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn download_script_escapes_the_path() {
        let js = download_finished_script(Some(std::path::Path::new("/home/a\"b/Downloads/x'.pdf")), true, Some(7));
        assert!(js.contains(r#""path":"/home/a\"b/Downloads/x'.pdf""#), "{js}");
        assert!(js.contains(r#""success":true"#));
        assert!(js.contains(r#""fileName":"x'.pdf""#), "{js}");
        assert!(js.contains(r#""id":7"#), "{js}");
        let failed = download_finished_script(None, false, None);
        assert!(failed.contains(r#""path":null"#) && failed.contains(r#""fileName":null"#), "{failed}");
        assert!(failed.contains(r#""id":null"#), "{failed}");
    }

    #[test]
    fn a_pdf_counts_only_when_complete() {
        let mut pdf = b"%PDF-1.3\n".to_vec();
        pdf.extend(std::iter::repeat(b'x').take(200));
        pdf.extend(b"\nstartxref\n123\n%%EOF\n");
        assert!(is_complete_pdf(&pdf));
        // cut off: no %%EOF
        assert!(!is_complete_pdf(&pdf[..pdf.len() - 8]));
        // not a PDF, empty, too short
        assert!(!is_complete_pdf(b"<html>%%EOF</html>"));
        assert!(!is_complete_pdf(b""));
        assert!(!is_complete_pdf(b"%PDF-%%EOF"));

        let tmp = std::env::temp_dir().join(format!("ov-dl-verify-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("ok.pdf"), &pdf).unwrap();
        std::fs::write(tmp.join("cut.pdf"), &pdf[..100]).unwrap();
        std::fs::write(tmp.join("match.zip"), b"PK\x03\x04 something").unwrap();
        std::fs::write(tmp.join("empty.zip"), b"").unwrap();
        assert!(verify_download(&tmp.join("ok.pdf")));
        assert!(!verify_download(&tmp.join("cut.pdf")));
        assert!(verify_download(&tmp.join("match.zip")));
        assert!(!verify_download(&tmp.join("empty.zip")));
        assert!(!verify_download(&tmp.join("missing.pdf")));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn only_recorded_downloads_can_be_opened() {
        let a = record_download(PathBuf::from("/x/Downloads/a.pdf"));
        let b = record_download(PathBuf::from("/x/Downloads/b.pdf"));
        assert_ne!(a, b);
        assert_eq!(recorded_download(a), Some(PathBuf::from("/x/Downloads/a.pdf")));
        assert_eq!(recorded_download(b), Some(PathBuf::from("/x/Downloads/b.pdf")));
        assert_eq!(recorded_download(u64::MAX), None);
        // gone from disk: refused, nothing is started
        assert!(existing_download(a).unwrap_err().contains("not there"));
        assert_eq!(existing_download(u64::MAX).unwrap_err(), "unknown download");
        // only the newest RECENT_DOWNLOADS are kept
        for i in 0..RECENT_DOWNLOADS {
            record_download(PathBuf::from(format!("/x/Downloads/{i}.pdf")));
        }
        assert_eq!(recorded_download(a), None);
    }

    #[test]
    fn open_and_reveal_pass_the_path_as_one_argument() {
        let p = Path::new("/home/u/Downloads/20261007_382208_KSCW-H1_vs_Spada-H1 (1).pdf");
        let open: Vec<_> = open_file_command(p).get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(open, vec![p.to_string_lossy().into_owned()]);
        let reveal: Vec<_> = reveal_file_command(p).get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(reveal.len(), 1, "{reveal:?}");
        #[cfg(target_os = "linux")]
        assert_eq!(reveal[0], "/home/u/Downloads");
        #[cfg(target_os = "windows")]
        assert_eq!(reveal[0], format!("/select,{}", p.display()));
    }

    #[test]
    fn popup_labels_are_recognised() {
        assert!(is_popup_label(&next_popup_label()));
        assert!(is_popup_label("popup-12"));
        assert!(!is_popup_label("main"));
        assert!(!is_popup_label("popup"));
    }

    #[test]
    fn system_opens_are_rate_limited() {
        let t0 = Instant::now();
        let min = SYSTEM_OPEN_MIN_INTERVAL;
        assert!(system_open_allowed(None, t0, min));
        assert!(!system_open_allowed(Some(t0), t0, min));
        assert!(!system_open_allowed(Some(t0), t0 + Duration::from_millis(999), min));
        assert!(system_open_allowed(Some(t0), t0 + min, min));
        // a clock that went backwards: refused, not a panic
        assert!(!system_open_allowed(Some(t0 + min), t0, min));
    }
}
