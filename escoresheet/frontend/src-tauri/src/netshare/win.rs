//! Windows 10 / 11: the Mobile Hotspot through WinRT
//! (NetworkOperatorTetheringManager), and a Wi-Fi Direct legacy access point
//! when that is not possible. No netsh, no hosted network (gone from modern
//! Wi-Fi drivers).
//!
//! - Offline: the Settings toggle refuses without internet, the API does
//!   not. It needs *a* connection profile to tether from, not a connected
//!   one: the internet profile if any, else the first profile Windows allows
//!   (a saved Wi-Fi, the Ethernet).
//! - Name / password: Windows 11 24H2+ takes them for this session only
//!   (NetworkOperatorTetheringSessionAccessPointConfiguration). Older builds
//!   store them as the user's own Mobile Hotspot settings: those are read
//!   first and put back on stop.
//! - "Turn off when no devices are connected" (5 minutes) is switched off
//!   while the tablets' Wi-Fi runs and restored on stop.
//! - No automatic teardown like NetworkManager's: stopped on exit, and at
//!   the next start-up after a crash (a marker file says it was on).
//! - The laptop stays on its own Wi-Fi: the hotspot runs on the Wi-Fi Direct
//!   virtual adapter (192.168.137.1).
//! - Fallback (no usable profile, or tethering refused for a reason other
//!   than group policy): WiFiDirectAdvertisementPublisher with legacy
//!   settings, alive while this process holds it.
//!
//! The WinRT calls that wait (`.get()`) run on blocking threads, never on the
//! window's thread. Bluetooth: Windows can only join a Bluetooth network
//! (PANU), never serve one (NAP), so it answers "not supported".

use super::{BluetoothStatus, Credentials, HotspotStatus, NetError};
use crate::netifs::{self, IfKind};
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Runtime};
use windows::core::HSTRING;
use windows::Devices::WiFiDirect::{
    WiFiDirectAdvertisementListenStateDiscoverability, WiFiDirectAdvertisementPublisher, WiFiDirectAdvertisementPublisherStatus,
};
use windows::Foundation::Metadata::ApiInformation;
use windows::Networking::Connectivity::{ConnectionProfile, NetworkInformation};
use windows::Networking::NetworkOperators::{
    NetworkOperatorTetheringAccessPointConfiguration, NetworkOperatorTetheringManager,
    NetworkOperatorTetheringSessionAccessPointConfiguration, TetheringCapability, TetheringOperationStatus,
    TetheringOperationalState, TetheringWiFiAuthenticationKind, TetheringWiFiBand,
};
use windows::Security::Credentials::PasswordCredential;

const SESSION_CONFIG_TYPE: &str = "Windows.Networking.NetworkOperators.NetworkOperatorTetheringSessionAccessPointConfiguration";
const DEFAULT_GATEWAY: &str = "192.168.137.1";

/// The user's own Mobile Hotspot settings before we replaced them.
#[derive(Clone, Debug)]
struct SavedAp {
    ssid: String,
    passphrase: String,
    band: Option<TetheringWiFiBand>,
}

#[derive(Default)]
pub struct Inner {
    method: Option<&'static str>,
    publisher: Option<WiFiDirectAdvertisementPublisher>,
    saved: Option<SavedAp>,
    /// "Turn off when no devices are connected" was on before we started.
    restore_timeout: bool,
}

fn we(code: &'static str) -> impl Fn(windows::core::Error) -> NetError {
    move |e| NetError::new(code, e.to_string())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, NetError> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| NetError::new("hotspot-failed", e.to_string()))
}

fn marker() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA").filter(|v| !v.is_empty())?;
    Some(PathBuf::from(base).join("OpenVolley").join("tablet-wifi-on"))
}

fn write_marker() {
    if let Some(m) = marker() {
        if let Some(dir) = m.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(m, b"1");
    }
}

fn remove_marker() {
    if let Some(m) = marker() {
        let _ = std::fs::remove_file(m);
    }
}

fn capability(p: &ConnectionProfile) -> TetheringCapability {
    NetworkOperatorTetheringManager::GetTetheringCapabilityFromConnectionProfile(p)
        .unwrap_or(TetheringCapability::DisabledDueToUnknownCause)
}

/// The profile to tether from: the internet one, else any profile Windows
/// allows (that is what makes it work offline). Also the first refusal seen.
fn pick_profile() -> (Option<ConnectionProfile>, Option<TetheringCapability>) {
    let mut refused = None;
    if let Ok(p) = NetworkInformation::GetInternetConnectionProfile() {
        let c = capability(&p);
        if c == TetheringCapability::Enabled {
            return (Some(p), None);
        }
        refused = Some(c);
    }
    if let Ok(list) = NetworkInformation::GetConnectionProfiles() {
        for i in 0..list.Size().unwrap_or(0) {
            let Ok(p) = list.GetAt(i) else { continue };
            let c = capability(&p);
            if c == TetheringCapability::Enabled {
                return (Some(p), None);
            }
            refused.get_or_insert(c);
        }
    }
    (None, refused)
}

fn manager() -> Option<NetworkOperatorTetheringManager> {
    let (profile, _) = pick_profile();
    NetworkOperatorTetheringManager::CreateFromConnectionProfile(&profile?).ok()
}

fn capability_error(c: Option<TetheringCapability>) -> NetError {
    match c {
        Some(TetheringCapability::DisabledByGroupPolicy) => NetError::new("disabled-by-policy", "Mobile Hotspot is turned off by group policy"),
        Some(TetheringCapability::DisabledByHardwareLimitation) => NetError::new("disabled-by-hardware", "the Wi-Fi adapter cannot host a hotspot"),
        Some(other) => NetError::new("hotspot-failed", format!("Mobile Hotspot is not available (capability {})", other.0)),
        None => NetError::new("no-profile", "no network connection profile to start the Mobile Hotspot from"),
    }
}

fn status_error(status: TetheringOperationStatus, message: String) -> NetError {
    let code = match status {
        TetheringOperationStatus::WiFiDeviceOff => "wifi-off",
        TetheringOperationStatus::RadioRestriction | TetheringOperationStatus::BandInterference => "radio-restriction",
        TetheringOperationStatus::OperationInProgress => "busy",
        _ => "hotspot-failed",
    };
    NetError::new(code, format!("status {} {message}", status.0).trim().to_string())
}

struct Probe {
    tether_ok: bool,
    refused: Option<TetheringCapability>,
    on: bool,
    clients: Option<u32>,
    max: Option<u32>,
}

fn probe() -> Probe {
    let (profile, refused) = pick_profile();
    let mut r = Probe { tether_ok: profile.is_some(), refused, on: false, clients: None, max: None };
    if let Some(m) = profile.and_then(|p| NetworkOperatorTetheringManager::CreateFromConnectionProfile(&p).ok()) {
        r.on = m.TetheringOperationalState().map(|s| s == TetheringOperationalState::On).unwrap_or(false);
        r.clients = m.ClientCount().ok();
        r.max = m.MaxClientCount().ok();
    }
    r
}

fn restore(m: &NetworkOperatorTetheringManager, saved: &SavedAp) {
    let Ok(cfg) = NetworkOperatorTetheringAccessPointConfiguration::new() else { return };
    let _ = cfg.SetSsid(&HSTRING::from(saved.ssid.as_str()));
    let _ = cfg.SetPassphrase(&HSTRING::from(saved.passphrase.as_str()));
    if let Some(b) = saved.band {
        let _ = cfg.SetBand(b);
    }
    let _ = m.ConfigureAccessPointAsync(&cfg).and_then(|a| a.get());
}

/// Start the Mobile Hotspot; returns the user's settings to put back (older
/// Windows) and whether the no-connections timeout was on.
fn start_tethering(ssid: &str, pass: &str, keep_saved: Option<SavedAp>) -> Result<(Option<SavedAp>, bool), NetError> {
    let (profile, refused) = pick_profile();
    let Some(profile) = profile else { return Err(capability_error(refused)) };
    let mgr = NetworkOperatorTetheringManager::CreateFromConnectionProfile(&profile).map_err(we("hotspot-failed"))?;
    if mgr.TetheringOperationalState().map(|s| s == TetheringOperationalState::On).unwrap_or(false) {
        let _ = mgr.StopTetheringAsync().and_then(|op| op.get());
    }
    let timeout_was_on = NetworkOperatorTetheringManager::IsNoConnectionsTimeoutEnabled().unwrap_or(false);
    let _ = NetworkOperatorTetheringManager::DisableNoConnectionsTimeoutAsync().and_then(|a| a.get());

    let ssid_h = HSTRING::from(ssid);
    let pass_h = HSTRING::from(pass);
    let session = ApiInformation::IsTypePresent(&HSTRING::from(SESSION_CONFIG_TYPE)).unwrap_or(false);
    let mut saved = keep_saved;
    let result = if session {
        let cfg = NetworkOperatorTetheringSessionAccessPointConfiguration::new().map_err(we("hotspot-failed"))?;
        cfg.SetSsid(&ssid_h).map_err(we("hotspot-failed"))?;
        cfg.SetPassphrase(&pass_h).map_err(we("hotspot-failed"))?;
        if cfg.IsBandSupported(TetheringWiFiBand::TwoPointFourGigahertz).unwrap_or(false) {
            let _ = cfg.SetBand(TetheringWiFiBand::TwoPointFourGigahertz);
        }
        let _ = cfg.SetAuthenticationKind(TetheringWiFiAuthenticationKind::Wpa2);
        mgr.StartTetheringAsync2(&cfg).and_then(|op| op.get()).map_err(we("hotspot-failed"))?
    } else {
        if saved.is_none() {
            let cur = mgr.GetCurrentAccessPointConfiguration().map_err(we("hotspot-failed"))?;
            saved = Some(SavedAp {
                ssid: cur.Ssid().map(|h| h.to_string()).unwrap_or_default(),
                passphrase: cur.Passphrase().map(|h| h.to_string()).unwrap_or_default(),
                band: cur.Band().ok(),
            });
        }
        let cfg = NetworkOperatorTetheringAccessPointConfiguration::new().map_err(we("hotspot-failed"))?;
        cfg.SetSsid(&ssid_h).map_err(we("hotspot-failed"))?;
        cfg.SetPassphrase(&pass_h).map_err(we("hotspot-failed"))?;
        if cfg.IsBandSupported(TetheringWiFiBand::TwoPointFourGigahertz).unwrap_or(false) {
            let _ = cfg.SetBand(TetheringWiFiBand::TwoPointFourGigahertz);
        }
        mgr.ConfigureAccessPointAsync(&cfg).and_then(|a| a.get()).map_err(we("hotspot-failed"))?;
        mgr.StartTetheringAsync().and_then(|op| op.get()).map_err(we("hotspot-failed"))?
    };
    let status = result.Status().unwrap_or(TetheringOperationStatus::Unknown);
    if status != TetheringOperationStatus::Success {
        let message = result.AdditionalErrorMessage().map(|h| h.to_string()).unwrap_or_default();
        if let Some(s) = &saved {
            restore(&mgr, s);
        }
        if timeout_was_on {
            let _ = NetworkOperatorTetheringManager::EnableNoConnectionsTimeoutAsync().and_then(|a| a.get());
        }
        return Err(status_error(status, message));
    }
    Ok((saved, timeout_was_on))
}

fn stop_tethering(saved: Option<SavedAp>, restore_timeout: bool) {
    if let Some(m) = manager() {
        let _ = m.StopTetheringAsync().and_then(|op| op.get());
        if let Some(s) = &saved {
            restore(&m, s);
        }
    }
    if restore_timeout {
        let _ = NetworkOperatorTetheringManager::EnableNoConnectionsTimeoutAsync().and_then(|a| a.get());
    }
}

fn start_wifi_direct(ssid: &str, pass: &str) -> Result<WiFiDirectAdvertisementPublisher, NetError> {
    let e = we("hotspot-failed");
    let publisher = WiFiDirectAdvertisementPublisher::new().map_err(&e)?;
    let adv = publisher.Advertisement().map_err(&e)?;
    adv.SetIsAutonomousGroupOwnerEnabled(true).map_err(&e)?;
    adv.SetListenStateDiscoverability(WiFiDirectAdvertisementListenStateDiscoverability::Normal).map_err(&e)?;
    let legacy = adv.LegacySettings().map_err(&e)?;
    legacy.SetIsEnabled(true).map_err(&e)?;
    legacy.SetSsid(&HSTRING::from(ssid)).map_err(&e)?;
    let credential = PasswordCredential::new().map_err(&e)?;
    credential.SetPassword(&HSTRING::from(pass)).map_err(&e)?;
    legacy.SetPassphrase(&credential).map_err(&e)?;
    publisher.Start().map_err(&e)?;
    for _ in 0..50 {
        match publisher.Status() {
            Ok(WiFiDirectAdvertisementPublisherStatus::Started) => return Ok(publisher),
            Ok(WiFiDirectAdvertisementPublisherStatus::Aborted) | Ok(WiFiDirectAdvertisementPublisherStatus::Stopped) => {
                return Err(NetError::new("hotspot-failed", "the Wi-Fi Direct access point stopped right away (driver?)"))
            }
            Ok(_) => std::thread::sleep(Duration::from_millis(100)),
            Err(err) => return Err(e(err)),
        }
    }
    let _ = publisher.Stop();
    Err(NetError::new("hotspot-failed", "the Wi-Fi Direct access point did not start in 5 s"))
}

fn hotspot_ip() -> Option<String> {
    netifs::tablet_interfaces().into_iter().find(|n| n.kind == IfKind::Hotspot).map(|n| n.ip)
}

pub async fn hotspot_status(inner: &mut Inner) -> HotspotStatus {
    let mut st = HotspotStatus::default();
    if inner.method == Some("wifi-direct") {
        let up = inner.publisher.as_ref().map(|p| matches!(p.Status(), Ok(WiFiDirectAdvertisementPublisherStatus::Started))).unwrap_or(false);
        if up {
            st.supported = true;
            st.active = true;
            st.method = Some("wifi-direct");
            st.gateway_ip = Some(hotspot_ip().unwrap_or_else(|| DEFAULT_GATEWAY.into()));
            return st;
        }
        inner.publisher = None;
        inner.method = None;
    }
    let p = match blocking(probe).await {
        Ok(p) => p,
        Err(e) => {
            st.reason = Some("hotspot-failed");
            st.detail = Some(e.detail);
            return st;
        }
    };
    st.clients = p.clients;
    st.max_clients = p.max;
    if inner.method == Some("mobile-hotspot") {
        if p.on {
            st.supported = true;
            st.active = true;
            st.method = Some("mobile-hotspot");
            st.gateway_ip = Some(hotspot_ip().unwrap_or_else(|| DEFAULT_GATEWAY.into()));
            return st;
        }
        // switched off elsewhere (Settings, the quick settings toggle)
        let _ = hotspot_stop(inner).await;
    }
    if p.tether_ok {
        st.supported = true;
        st.method = Some("mobile-hotspot");
    } else {
        match p.refused {
            Some(TetheringCapability::DisabledByGroupPolicy) => {
                st.reason = Some("disabled-by-policy");
            }
            other => {
                // the Wi-Fi Direct access point may still work
                st.supported = true;
                st.method = Some("wifi-direct");
                st.detail = Some(capability_error(other).detail);
            }
        }
    }
    st
}

pub async fn hotspot_start(inner: &mut Inner, c: &Credentials) -> Result<(), NetError> {
    hotspot_stop(inner).await?;
    let (ssid, pass) = (c.ssid.clone(), c.password.clone());
    let tether = blocking(move || start_tethering(&ssid, &pass, None)).await?;
    match tether {
        Ok((saved, restore_timeout)) => {
            inner.method = Some("mobile-hotspot");
            inner.saved = saved;
            inner.restore_timeout = restore_timeout;
            write_marker();
        }
        Err(e) if e.code == "disabled-by-policy" => return Err(e),
        Err(e) => {
            let (ssid, pass) = (c.ssid.clone(), c.password.clone());
            match blocking(move || start_wifi_direct(&ssid, &pass)).await? {
                Ok(p) => {
                    inner.publisher = Some(p);
                    inner.method = Some("wifi-direct");
                }
                Err(e2) => return Err(NetError::new(e.code, format!("{} · Wi-Fi Direct: {}", e.detail, e2.detail))),
            }
        }
    }
    for _ in 0..32 {
        if hotspot_ip().is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Ok(())
}

pub async fn hotspot_stop(inner: &mut Inner) -> Result<(), NetError> {
    if let Some(p) = inner.publisher.take() {
        let _ = p.Stop();
    }
    if inner.method == Some("mobile-hotspot") {
        let saved = inner.saved.take();
        let restore_timeout = std::mem::take(&mut inner.restore_timeout);
        blocking(move || stop_tethering(saved, restore_timeout)).await?;
        remove_marker();
    }
    inner.method = None;
    Ok(())
}

pub async fn bluetooth_status(_inner: &mut Inner) -> BluetoothStatus {
    BluetoothStatus { reason: Some("windows-cannot-serve"), ..Default::default() }
}

pub async fn bluetooth_start(_inner: &mut Inner) -> Result<(), NetError> {
    Err(NetError::new("windows-cannot-serve", ""))
}

pub async fn bluetooth_stop(_inner: &mut Inner) -> Result<(), NetError> {
    Ok(())
}

/// A previous run crashed with the tablets' Wi-Fi on: switch it off.
pub fn recover<R: Runtime>(_app: &AppHandle<R>) {
    if marker().map(|m| m.exists()).unwrap_or(false) {
        tauri::async_runtime::spawn_blocking(|| {
            stop_tethering(None, false);
            remove_marker();
        });
    }
}
