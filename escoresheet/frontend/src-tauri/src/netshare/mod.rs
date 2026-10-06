//! Networks the laptop creates for the tablets, so a hall without Wi-Fi (or
//! without internet) still works:
//!
//!   - **Wi-Fi for tablets** (hotspot): the laptop is the access point.
//!     Linux: NetworkManager shared mode over D-Bus (linux.rs). Windows: the
//!     Mobile Hotspot API (WinRT tethering), falling back to a Wi-Fi Direct
//!     legacy access point (win.rs).
//!   - **Bluetooth network** (Linux only): a NetworkManager Bluetooth NAP
//!     bridge the tablets join after pairing. Windows can only join a
//!     Bluetooth network, never serve one, so it answers "not supported".
//!
//! The commands are for the scoretable window only (build.rs app manifest +
//! capabilities/netshare.json: the main window on http://localhost); a LAN
//! tablet is a plain browser and never gets them. The relay already listens
//! on 0.0.0.0, so it serves every network these create; netifs.rs reports
//! their addresses.
//!
//! The network name and password are made once per app run (or chosen by the
//! scoretable page, which remembers the last ones so the tablets rejoin match
//! after match) and checked strictly here: nothing from the page reaches a
//! shell or a file.

pub mod creds;
#[cfg(any(target_os = "linux", test))]
pub mod nm_settings;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux as platform;

#[cfg(windows)]
mod win;
#[cfg(windows)]
use win as platform;

#[cfg(not(any(target_os = "linux", windows)))]
mod other;
#[cfg(not(any(target_os = "linux", windows)))]
use other as platform;

use creds::Credentials;
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, State};

pub const PLATFORM: &str = if cfg!(target_os = "linux") {
    "linux"
} else if cfg!(windows) {
    "windows"
} else if cfg!(target_os = "macos") {
    "macos"
} else {
    "other"
};

/// A failure the page can explain: a stable `code` (translated in the
/// dialog) and the system's own words in `detail`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NetError {
    pub code: &'static str,
    pub detail: String,
}

impl NetError {
    pub fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self { code, detail: detail.into() }
    }
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HotspotStatus {
    /// This laptop can create a Wi-Fi (as far as can be told before trying).
    pub supported: bool,
    /// Why not, or what is in the way: no-networkmanager, no-wifi-device,
    /// no-ap-mode, wifi-off, not-authorized, disabled-by-policy,
    /// disabled-by-hardware, unsupported-os, ...
    pub reason: Option<&'static str>,
    pub detail: Option<String>,
    pub platform: &'static str,
    /// networkmanager | mobile-hotspot | wifi-direct
    pub method: Option<&'static str>,
    /// The system will ask for an administrator password (polkit "auth").
    pub needs_admin: bool,
    /// The laptop's Wi-Fi card becomes the access point: its own Wi-Fi
    /// connection (hall Wi-Fi, internet) drops while the hotspot runs.
    pub takes_over_wifi: bool,
    /// The network the laptop leaves when `takes_over_wifi` (its connection
    /// name, usually the hall Wi-Fi's name), for the confirmation.
    pub leaves_network: Option<String>,
    pub active: bool,
    /// On, but not started by this app run: switched on in the system's own
    /// settings (Windows quick settings Mobile Hotspot, GNOME "Turn On Wi-Fi
    /// Hotspot"). Its links work; the app does not stop it. `ssid` /
    /// `password` are the system's when it tells them, else empty.
    pub external: bool,
    pub ssid: String,
    pub password: String,
    /// The laptop's address on the new network: the tablet URLs use it.
    pub gateway_ip: Option<String>,
    pub interface: Option<String>,
    pub clients: Option<u32>,
    pub max_clients: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothStatus {
    pub supported: bool,
    /// no-bluez, no-adapter, no-networkmanager, unsupported-os,
    /// not-authorized, ...
    pub reason: Option<&'static str>,
    pub detail: Option<String>,
    pub platform: &'static str,
    pub needs_admin: bool,
    pub powered: bool,
    pub discoverable: bool,
    /// The Bluetooth name tablets see when pairing.
    pub adapter_name: Option<String>,
    pub active: bool,
    /// Up, but not started by this app run (the bridge exists already): the
    /// app does not stop it.
    pub external: bool,
    pub interface: Option<String>,
    pub ip: Option<String>,
}

/// Managed state: the session's network name / password and the running
/// networks (platform specific).
pub struct NetShare {
    creds: std::sync::Mutex<Option<Credentials>>,
    inner: tokio::sync::Mutex<platform::Inner>,
}

impl NetShare {
    pub fn new() -> Self {
        Self { creds: std::sync::Mutex::new(None), inner: tokio::sync::Mutex::new(platform::Inner::default()) }
    }

    /// The session's credentials, made on first use.
    fn creds(&self) -> Credentials {
        let mut c = self.creds.lock().unwrap_or_else(|e| e.into_inner());
        c.get_or_insert_with(creds::generate).clone()
    }

    fn set_creds(&self, value: Credentials) {
        *self.creds.lock().unwrap_or_else(|e| e.into_inner()) = Some(value);
    }
}

impl Default for NetShare {
    fn default() -> Self {
        Self::new()
    }
}

fn with_creds(mut status: HotspotStatus, c: &Credentials) -> HotspotStatus {
    // Never put this run's name / password on a network someone else started
    if status.ssid.is_empty() && !status.external {
        status.ssid = c.ssid.clone();
        status.password = c.password.clone();
    }
    status.platform = PLATFORM;
    status
}

#[tauri::command]
pub async fn hotspot_status(state: State<'_, NetShare>) -> Result<HotspotStatus, NetError> {
    let c = state.creds();
    let mut inner = state.inner.lock().await;
    Ok(with_creds(platform::hotspot_status(&mut inner).await, &c))
}

/// Start the tablet Wi-Fi with the given name / password (both or neither;
/// neither = the session's own).
#[tauri::command]
pub async fn hotspot_start(
    state: State<'_, NetShare>,
    ssid: Option<String>,
    password: Option<String>,
) -> Result<HotspotStatus, NetError> {
    let c = match (ssid, password) {
        (Some(s), Some(p)) => {
            let c = Credentials::checked(&s, &p).map_err(|e| NetError::new("invalid-credentials", e))?;
            state.set_creds(c.clone());
            c
        }
        (None, None) => state.creds(),
        _ => return Err(NetError::new("invalid-credentials", "give both the network name and the password")),
    };
    let mut inner = state.inner.lock().await;
    platform::hotspot_start(&mut inner, &c).await?;
    Ok(with_creds(platform::hotspot_status(&mut inner).await, &c))
}

#[tauri::command]
pub async fn hotspot_stop(state: State<'_, NetShare>) -> Result<HotspotStatus, NetError> {
    let c = state.creds();
    let mut inner = state.inner.lock().await;
    platform::hotspot_stop(&mut inner).await?;
    Ok(with_creds(platform::hotspot_status(&mut inner).await, &c))
}

fn bt(mut status: BluetoothStatus) -> BluetoothStatus {
    status.platform = PLATFORM;
    status
}

#[tauri::command]
pub async fn bluetooth_status(state: State<'_, NetShare>) -> Result<BluetoothStatus, NetError> {
    let mut inner = state.inner.lock().await;
    Ok(bt(platform::bluetooth_status(&mut inner).await))
}

#[tauri::command]
pub async fn bluetooth_start(state: State<'_, NetShare>) -> Result<BluetoothStatus, NetError> {
    let mut inner = state.inner.lock().await;
    platform::bluetooth_start(&mut inner).await?;
    Ok(bt(platform::bluetooth_status(&mut inner).await))
}

#[tauri::command]
pub async fn bluetooth_stop(state: State<'_, NetShare>) -> Result<BluetoothStatus, NetError> {
    let mut inner = state.inner.lock().await;
    platform::bluetooth_stop(&mut inner).await?;
    Ok(bt(platform::bluetooth_status(&mut inner).await))
}

/// Stop whatever this app started (the app is quitting). Linux would tear
/// down by itself (bind-activation), Windows would not.
pub fn shutdown<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<NetShare>() else { return };
    tauri::async_runtime::block_on(async {
        let mut inner = state.inner.lock().await;
        let _ = platform::hotspot_stop(&mut inner).await;
        let _ = platform::bluetooth_stop(&mut inner).await;
    });
}

/// At start-up: undo a hotspot a crashed run left on (Windows has no
/// automatic teardown).
pub fn recover<R: Runtime>(app: &AppHandle<R>) {
    platform::recover(app);
}
