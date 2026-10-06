//! Linux: NetworkManager over D-Bus (zbus), no shell, no nmcli.
//!
//! Both networks are added with AddAndActivateConnection2 and
//! `persist: volatile` (the profile lives in memory only and disappears when
//! it goes down) plus `bind-activation: dbus-client`: NetworkManager takes
//! the network down by itself when this app's D-Bus connection closes, so a
//! crash or a kill never leaves the laptop stuck as an access point, and its
//! normal Wi-Fi comes back. The connection is kept open while a network runs.
//! NetworkManager older than 1.16 has no AddAndActivateConnection2: then the
//! plain call, and the profile is deleted on stop.
//!
//! Permissions (polkit, upstream defaults): wifi.share.protected and
//! settings.modify.own are granted to the active desktop session, so a
//! user-owned connection (connection.permissions = user:<login>) needs no
//! password. GetPermissions tells beforehand when a password ("auth") or a
//! refusal ("no", e.g. an ssh session) is coming.

use super::nm_settings::{self, Section, Val};
use super::{BluetoothStatus, Credentials, HotspotStatus, NetError};
use crate::netifs;
use std::collections::HashMap;
use std::time::Duration;
use tauri::{AppHandle, Runtime};
use zbus::proxy::{Builder, CacheProperties};
use zbus::zvariant::{ObjectPath, OwnedObjectPath, OwnedValue, Value};
use zbus::{Connection, Proxy};

const NM: &str = "org.freedesktop.NetworkManager";
const NM_PATH: &str = "/org/freedesktop/NetworkManager";
const NM_DEVICE: &str = "org.freedesktop.NetworkManager.Device";
const NM_WIRELESS: &str = "org.freedesktop.NetworkManager.Device.Wireless";
const NM_ACTIVE: &str = "org.freedesktop.NetworkManager.Connection.Active";
const NM_SETTINGS_CONN: &str = "org.freedesktop.NetworkManager.Settings.Connection";
const BLUEZ: &str = "org.bluez";
const BLUEZ_ADAPTER: &str = "org.bluez.Adapter1";

const NM_DEVICE_TYPE_WIFI: u32 = 2;
/// NM_802_11_MODE_AP: the card is an access point (a hotspot).
const NM_WIFI_MODE_AP: u32 = 3;
/// NM_WIFI_DEVICE_CAP_AP: the card can be an access point.
const WIFI_CAP_AP: u32 = 0x40;
const NM_DEVICE_STATE_ACTIVATED: u32 = 100;
const NM_ACTIVE_STATE_ACTIVATED: u32 = 2;
const NM_ACTIVE_STATE_DEACTIVATED: u32 = 4;

const PERM_WIFI_SHARE: &str = "org.freedesktop.NetworkManager.wifi.share.protected";
const PERM_MODIFY_OWN: &str = "org.freedesktop.NetworkManager.settings.modify.own";
const PERM_NETWORK_CONTROL: &str = "org.freedesktop.NetworkManager.network-control";

const ACTIVATE_TIMEOUT: Duration = Duration::from_secs(45);
/// Bluetooth stays visible for pairing this long after the network starts.
const BT_DISCOVERABLE_SECS: u32 = 180;

/// A network this app started and keeps up.
pub struct Running {
    /// Kept open: bind-activation ties the network to this connection.
    conn: Connection,
    active: OwnedObjectPath,
    /// Old NetworkManager (no volatile profiles): delete this on stop.
    delete_settings: Option<OwnedObjectPath>,
    interface: String,
}

#[derive(Default)]
pub struct Inner {
    hotspot: Option<Running>,
    bluetooth: Option<Running>,
}

fn dbus_err(code: &'static str, e: zbus::Error) -> NetError {
    NetError::new(code, e.to_string())
}

async fn proxy(conn: &Connection, dest: &'static str, path: ObjectPath<'static>, iface: &'static str) -> zbus::Result<Proxy<'static>> {
    Builder::<Proxy<'static>>::new(conn)
        .destination(dest)?
        .path(path)?
        .interface(iface)?
        .cache_properties(CacheProperties::No)
        .build()
        .await
}

async fn nm_proxy(conn: &Connection) -> zbus::Result<Proxy<'static>> {
    proxy(conn, NM, ObjectPath::from_static_str_unchecked(NM_PATH), NM).await
}

fn to_value(v: &Val) -> Value<'static> {
    match v {
        Val::Str(s) => Value::from(s.clone()),
        Val::Bytes(b) => Value::from(b.clone()),
        Val::Bool(b) => Value::from(*b),
        Val::I32(n) => Value::from(*n),
        Val::Strs(list) => Value::from(list.clone()),
    }
}

fn to_dbus(settings: &[Section]) -> HashMap<&'static str, HashMap<&'static str, Value<'static>>> {
    settings
        .iter()
        .map(|(name, keys)| (*name, keys.iter().map(|(k, v)| (*k, to_value(v))).collect()))
        .collect()
}

fn login() -> Option<String> {
    std::env::var("USER").ok().or_else(|| std::env::var("LOGNAME").ok())
}

/// What polkit answers for `action`: "yes", "auth", "no" (or "unknown").
async fn permission(nm: &Proxy<'_>, action: &str) -> String {
    let perms: HashMap<String, String> = nm.call("GetPermissions", &()).await.unwrap_or_default();
    perms.get(action).cloned().unwrap_or_else(|| "unknown".into())
}

struct WifiDevice {
    path: OwnedObjectPath,
    interface: String,
    /// Connected to a network right now (the hall Wi-Fi): it drops.
    in_use: bool,
    /// The name of that connection (usually the hall Wi-Fi's name).
    connection: Option<String>,
}

enum WifiProbe {
    Found(WifiDevice),
    NoWifi,
    NoApMode(String),
}

/// The name (connection id) of the device's active connection, if any.
async fn active_connection_id(conn: &Connection, dev: &Proxy<'_>) -> Option<String> {
    let active: OwnedObjectPath = dev.get_property("ActiveConnection").await.ok()?;
    if active.as_str() == "/" {
        return None;
    }
    let p = proxy(conn, NM, active.into_inner(), NM_ACTIVE).await.ok()?;
    p.get_property::<String>("Id").await.ok().filter(|s| !s.is_empty())
}

/// A Wi-Fi card that is an access point right now although this run did not
/// start one: a hotspot switched on in the system settings (GNOME "Turn On
/// Wi-Fi Hotspot", nmcli). Its interface name.
async fn system_hotspot(conn: &Connection, nm: &Proxy<'_>) -> zbus::Result<Option<String>> {
    let devices: Vec<OwnedObjectPath> = nm.call("GetDevices", &()).await?;
    for path in devices {
        let dev = proxy(conn, NM, path.clone().into_inner(), NM_DEVICE).await?;
        if dev.get_property::<u32>("DeviceType").await.unwrap_or(0) != NM_DEVICE_TYPE_WIFI {
            continue;
        }
        if dev.get_property::<u32>("State").await.unwrap_or(0) != NM_DEVICE_STATE_ACTIVATED {
            continue;
        }
        let wireless = proxy(conn, NM, path.into_inner(), NM_WIRELESS).await?;
        if wireless.get_property::<u32>("Mode").await.unwrap_or(0) == NM_WIFI_MODE_AP {
            return Ok(Some(dev.get_property("Interface").await.unwrap_or_default()));
        }
    }
    Ok(None)
}

/// An AP-capable Wi-Fi card, preferring one that is not connected (a second
/// adapter keeps the hall Wi-Fi up).
async fn find_wifi(conn: &Connection, nm: &Proxy<'_>) -> zbus::Result<WifiProbe> {
    let devices: Vec<OwnedObjectPath> = nm.call("GetDevices", &()).await?;
    let mut capable: Vec<WifiDevice> = Vec::new();
    let mut without_ap: Vec<String> = Vec::new();
    for path in devices {
        let dev = proxy(conn, NM, path.clone().into_inner(), NM_DEVICE).await?;
        if dev.get_property::<u32>("DeviceType").await.unwrap_or(0) != NM_DEVICE_TYPE_WIFI {
            continue;
        }
        if !dev.get_property::<bool>("Managed").await.unwrap_or(false) {
            continue;
        }
        let interface: String = dev.get_property("Interface").await.unwrap_or_default();
        let state: u32 = dev.get_property("State").await.unwrap_or(0);
        let wireless = proxy(conn, NM, path.clone().into_inner(), NM_WIRELESS).await?;
        let caps: u32 = wireless.get_property("WirelessCapabilities").await.unwrap_or(0);
        if caps & WIFI_CAP_AP == 0 {
            without_ap.push(interface);
            continue;
        }
        let in_use = state == NM_DEVICE_STATE_ACTIVATED;
        let connection = if in_use { active_connection_id(conn, &dev).await } else { None };
        capable.push(WifiDevice { path, interface, in_use, connection });
    }
    capable.sort_by_key(|d| d.in_use);
    Ok(match capable.into_iter().next() {
        Some(d) => WifiProbe::Found(d),
        None if without_ap.is_empty() => WifiProbe::NoWifi,
        None => WifiProbe::NoApMode(without_ap.join(", ")),
    })
}

/// Still up? Forget it when NetworkManager took it down (Wi-Fi switched off,
/// the user picked another network).
async fn still_up(slot: &mut Option<Running>) -> bool {
    let Some(r) = slot.as_ref() else { return false };
    let up = match proxy(&r.conn, NM, r.active.clone().into_inner(), NM_ACTIVE).await {
        Ok(p) => matches!(p.get_property::<u32>("State").await, Ok(s) if s <= NM_ACTIVE_STATE_ACTIVATED),
        Err(_) => false,
    };
    if !up {
        if let Some(r) = slot.take() {
            delete_profile(&r).await;
        }
    }
    up
}

async fn delete_profile(r: &Running) {
    if let Some(path) = &r.delete_settings {
        if let Ok(p) = proxy(&r.conn, NM, path.clone().into_inner(), NM_SETTINGS_CONN).await {
            let _: zbus::Result<()> = p.call("Delete", &()).await;
        }
    }
}

async fn deactivate(r: Running) {
    if let Ok(nm) = nm_proxy(&r.conn).await {
        let _: zbus::Result<()> = nm.call("DeactivateConnection", &(r.active.clone(),)).await;
    }
    delete_profile(&r).await;
}

/// Add and activate a volatile profile bound to `conn`; waits until it is up.
async fn add_and_activate(
    conn: &Connection,
    settings: &[Section],
    device: ObjectPath<'static>,
    interface: String,
    failed_code: &'static str,
) -> Result<Running, NetError> {
    let nm = nm_proxy(conn).await.map_err(|e| dbus_err("no-networkmanager", e))?;
    let dict = to_dbus(settings);
    let root = ObjectPath::from_static_str_unchecked("/");
    let mut options: HashMap<&str, Value> = HashMap::new();
    options.insert("persist", Value::from("volatile"));
    options.insert("bind-activation", Value::from("dbus-client"));
    let modern: zbus::Result<(OwnedObjectPath, OwnedObjectPath, HashMap<String, OwnedValue>)> =
        nm.call("AddAndActivateConnection2", &(&dict, &device, &root, &options)).await;
    let (active, delete_settings) = match modern {
        Ok((_, active, _)) => (active, None),
        Err(zbus::Error::MethodError(name, _, _)) if name.as_str() == "org.freedesktop.DBus.Error.UnknownMethod" => {
            let (settings_path, active): (OwnedObjectPath, OwnedObjectPath) = nm
                .call("AddAndActivateConnection", &(&dict, &device, &root))
                .await
                .map_err(|e| start_error(failed_code, e))?;
            (active, Some(settings_path))
        }
        Err(e) => return Err(start_error(failed_code, e)),
    };
    let running = Running { conn: conn.clone(), active, delete_settings, interface };

    let deadline = std::time::Instant::now() + ACTIVATE_TIMEOUT;
    loop {
        let state = match proxy(conn, NM, running.active.clone().into_inner(), NM_ACTIVE).await {
            Ok(p) => p.get_property::<u32>("State").await.unwrap_or(NM_ACTIVE_STATE_DEACTIVATED),
            Err(_) => NM_ACTIVE_STATE_DEACTIVATED,
        };
        if state == NM_ACTIVE_STATE_ACTIVATED {
            return Ok(running);
        }
        if state >= NM_ACTIVE_STATE_DEACTIVATED {
            let reason = device_reason(conn, &device).await;
            deactivate(running).await;
            return Err(NetError::new(failed_code, reason));
        }
        if std::time::Instant::now() > deadline {
            deactivate(running).await;
            return Err(NetError::new(failed_code, "NetworkManager did not finish starting the network in 45 s"));
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

fn start_error(code: &'static str, e: zbus::Error) -> NetError {
    let text = e.to_string();
    if text.contains("PermissionDenied") || text.contains("not authorized") || text.contains("NotAuthorized") {
        NetError::new("not-authorized", text)
    } else {
        NetError::new(code, text)
    }
}

/// Why the device fell back (NMDeviceStateReason), for the error text.
async fn device_reason(conn: &Connection, device: &ObjectPath<'static>) -> String {
    if device.as_str() == "/" {
        return "NetworkManager stopped the network while starting it".into();
    }
    let reason = match proxy(conn, NM, device.clone(), NM_DEVICE).await {
        Ok(p) => p.get_property::<(u32, u32)>("StateReason").await.map(|(_, r)| r).unwrap_or(0),
        Err(_) => 0,
    };
    let hint = match reason {
        // NM_DEVICE_STATE_REASON_SHARED_START_FAILED / _FAILED
        52 | 53 => " (dnsmasq could not start: is the dnsmasq package installed?)",
        // SUPPLICANT_FAILED / SUPPLICANT_CONFIG_FAILED: the card or band refused AP mode
        7 | 10 | 11 => " (the Wi-Fi card refused to start the access point)",
        _ => "",
    };
    format!("NetworkManager stopped the network while starting it: reason {reason}{hint}")
}

async fn wait_for_ip(interface: &str, fallback: &str) -> String {
    for _ in 0..20 {
        if let Some(ip) = netifs::ip_of(interface) {
            return ip;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    fallback.to_string()
}

// ---------------------------------------------------------------------------
// Wi-Fi for tablets
// ---------------------------------------------------------------------------

pub async fn hotspot_status(inner: &mut Inner) -> HotspotStatus {
    let mut st = HotspotStatus { method: Some("networkmanager"), ..Default::default() };
    if still_up(&mut inner.hotspot).await {
        let r = inner.hotspot.as_ref().expect("up");
        st.supported = true;
        st.active = true;
        st.interface = Some(r.interface.clone());
        st.gateway_ip = Some(netifs::ip_of(&r.interface).unwrap_or_else(|| "10.42.0.1".into()));
        return st;
    }
    let conn = match Connection::system().await {
        Ok(c) => c,
        Err(e) => {
            st.reason = Some("no-networkmanager");
            st.detail = Some(e.to_string());
            return st;
        }
    };
    let nm = match nm_proxy(&conn).await {
        Ok(p) => p,
        Err(e) => {
            st.reason = Some("no-networkmanager");
            st.detail = Some(e.to_string());
            return st;
        }
    };
    // A hotspot the system runs (not this app): the tablets on it can use it
    if let Ok(Some(interface)) = system_hotspot(&conn, &nm).await {
        st.supported = true;
        st.active = true;
        st.external = true;
        st.gateway_ip = netifs::ip_of(&interface);
        st.interface = Some(interface);
        return st;
    }
    let wifi = match find_wifi(&conn, &nm).await {
        Ok(w) => w,
        Err(e) => {
            st.reason = Some("no-networkmanager");
            st.detail = Some(e.to_string());
            return st;
        }
    };
    match wifi {
        WifiProbe::NoWifi => st.reason = Some("no-wifi-device"),
        WifiProbe::NoApMode(names) => {
            st.reason = Some("no-ap-mode");
            st.detail = Some(names);
        }
        WifiProbe::Found(dev) => {
            st.supported = true;
            st.interface = Some(dev.interface);
            st.takes_over_wifi = dev.in_use;
            st.leaves_network = if dev.in_use { dev.connection } else { None };
            if !nm.get_property::<bool>("WirelessEnabled").await.unwrap_or(true) {
                st.reason = Some("wifi-off");
            }
            let share = permission(&nm, PERM_WIFI_SHARE).await;
            let own = permission(&nm, PERM_MODIFY_OWN).await;
            if share == "no" || own == "no" {
                st.reason = Some("not-authorized");
                st.detail = Some(format!("wifi.share.protected: {share}, settings.modify.own: {own}"));
            } else if share == "auth" || own == "auth" {
                st.needs_admin = true;
            }
        }
    }
    st
}

pub async fn hotspot_start(inner: &mut Inner, c: &Credentials) -> Result<(), NetError> {
    if still_up(&mut inner.hotspot).await {
        if let Some(r) = inner.hotspot.take() {
            deactivate(r).await;
        }
    }
    let conn = Connection::system().await.map_err(|e| dbus_err("no-networkmanager", e))?;
    let nm = nm_proxy(&conn).await.map_err(|e| dbus_err("no-networkmanager", e))?;
    if !nm.get_property::<bool>("WirelessEnabled").await.unwrap_or(true) {
        return Err(NetError::new("wifi-off", "Wi-Fi is switched off (airplane mode?)"));
    }
    let dev = match find_wifi(&conn, &nm).await.map_err(|e| dbus_err("no-networkmanager", e))? {
        WifiProbe::Found(d) => d,
        WifiProbe::NoWifi => return Err(NetError::new("no-wifi-device", "")),
        WifiProbe::NoApMode(names) => return Err(NetError::new("no-ap-mode", names)),
    };
    let settings = nm_settings::hotspot_settings(c, login().as_deref());
    let running = add_and_activate(&conn, &settings, dev.path.clone().into_inner(), dev.interface.clone(), "hotspot-failed").await?;
    wait_for_ip(&running.interface, "10.42.0.1").await;
    inner.hotspot = Some(running);
    Ok(())
}

pub async fn hotspot_stop(inner: &mut Inner) -> Result<(), NetError> {
    if let Some(r) = inner.hotspot.take() {
        deactivate(r).await;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Bluetooth network (NAP)
// ---------------------------------------------------------------------------

struct Adapter {
    path: OwnedObjectPath,
    address: String,
    name: Option<String>,
    powered: bool,
    discoverable: bool,
}

type ManagedObjects = HashMap<OwnedObjectPath, HashMap<String, HashMap<String, OwnedValue>>>;

async fn find_adapter(conn: &Connection) -> Result<Option<Adapter>, NetError> {
    let om = proxy(conn, BLUEZ, ObjectPath::from_static_str_unchecked("/"), "org.freedesktop.DBus.ObjectManager")
        .await
        .map_err(|e| dbus_err("no-bluez", e))?;
    let objects: ManagedObjects = om.call("GetManagedObjects", &()).await.map_err(|e| dbus_err("no-bluez", e))?;
    let mut adapters: Vec<Adapter> = objects
        .into_iter()
        .filter_map(|(path, ifaces)| {
            let props = ifaces.get(BLUEZ_ADAPTER)?;
            let text = |k: &str| props.get(k).and_then(|v| String::try_from(v.try_clone().ok()?).ok());
            let flag = |k: &str| props.get(k).and_then(|v| bool::try_from(v).ok()).unwrap_or(false);
            Some(Adapter {
                address: text("Address")?,
                name: text("Alias").or_else(|| text("Name")),
                powered: flag("Powered"),
                discoverable: flag("Discoverable"),
                path,
            })
        })
        .collect();
    adapters.sort_by(|a, b| a.path.as_str().cmp(b.path.as_str()));
    Ok(adapters.into_iter().next())
}

async fn set_adapter(conn: &Connection, adapter: &OwnedObjectPath, key: &str, value: Value<'_>) -> zbus::Result<()> {
    let props = proxy(conn, BLUEZ, adapter.clone().into_inner(), "org.freedesktop.DBus.Properties").await?;
    props.call("Set", &(BLUEZ_ADAPTER, key, &value)).await
}

pub async fn bluetooth_status(inner: &mut Inner) -> BluetoothStatus {
    let mut st = BluetoothStatus::default();
    let conn = match Connection::system().await {
        Ok(c) => c,
        Err(e) => {
            st.reason = Some("no-bluez");
            st.detail = Some(e.to_string());
            return st;
        }
    };
    match find_adapter(&conn).await {
        Err(e) => {
            st.reason = Some(e.code);
            st.detail = Some(e.detail);
            return st;
        }
        Ok(None) => {
            st.reason = Some("no-adapter");
            return st;
        }
        Ok(Some(a)) => {
            st.powered = a.powered;
            st.discoverable = a.discoverable;
            st.adapter_name = a.name;
        }
    }
    let nm = match nm_proxy(&conn).await {
        Ok(p) if p.get_property::<String>("Version").await.is_ok() => p,
        Ok(_) | Err(_) => {
            st.reason = Some("no-networkmanager");
            return st;
        }
    };
    st.supported = true;
    let own = permission(&nm, PERM_MODIFY_OWN).await;
    let control = permission(&nm, PERM_NETWORK_CONTROL).await;
    if own == "no" || control == "no" {
        st.reason = Some("not-authorized");
        st.detail = Some(format!("settings.modify.own: {own}, network-control: {control}"));
    } else if own == "auth" || control == "auth" {
        st.needs_admin = true;
    }
    if still_up(&mut inner.bluetooth).await {
        let r = inner.bluetooth.as_ref().expect("up");
        st.active = true;
        st.interface = Some(r.interface.clone());
        st.ip = netifs::ip_of(&r.interface);
    } else if let Some(ip) = netifs::ip_of(netifs::BT_BRIDGE_NAME) {
        // started outside this run (or by hand with the same bridge name):
        // its links work, but this run holds nothing to stop it with
        st.active = true;
        st.external = true;
        st.interface = Some(netifs::BT_BRIDGE_NAME.into());
        st.ip = Some(ip);
    }
    st
}

pub async fn bluetooth_start(inner: &mut Inner) -> Result<(), NetError> {
    if still_up(&mut inner.bluetooth).await {
        if let Some(r) = inner.bluetooth.take() {
            deactivate(r).await;
        }
    }
    let conn = Connection::system().await.map_err(|e| dbus_err("no-bluez", e))?;
    let adapter = find_adapter(&conn).await?.ok_or_else(|| NetError::new("no-adapter", ""))?;
    if !adapter.powered {
        set_adapter(&conn, &adapter.path, "Powered", Value::from(true))
            .await
            .map_err(|e| dbus_err("bluetooth-off", e))?;
    }
    let bdaddr = nm_settings::parse_bdaddr(&adapter.address)
        .ok_or_else(|| NetError::new("no-adapter", format!("unreadable adapter address {}", adapter.address)))?;
    let settings = nm_settings::bt_nap_settings(bdaddr, netifs::BT_BRIDGE_NAME, login().as_deref());
    let running = add_and_activate(
        &conn,
        &settings,
        ObjectPath::from_static_str_unchecked("/"),
        netifs::BT_BRIDGE_NAME.into(),
        "bluetooth-failed",
    )
    .await?;
    // Visible and pairable for a few minutes, so the tablets can pair. Not
    // fatal: the desktop's Bluetooth settings do the same while open.
    let _ = set_adapter(&conn, &adapter.path, "DiscoverableTimeout", Value::from(BT_DISCOVERABLE_SECS)).await;
    let _ = set_adapter(&conn, &adapter.path, "Pairable", Value::from(true)).await;
    let _ = set_adapter(&conn, &adapter.path, "Discoverable", Value::from(true)).await;
    wait_for_ip(&running.interface, "").await;
    inner.bluetooth = Some(running);
    Ok(())
}

pub async fn bluetooth_stop(inner: &mut Inner) -> Result<(), NetError> {
    if let Some(r) = inner.bluetooth.take() {
        if let Ok(Some(adapter)) = find_adapter(&r.conn).await {
            let _ = set_adapter(&r.conn, &adapter.path, "Discoverable", Value::from(false)).await;
        }
        deactivate(r).await;
    }
    Ok(())
}

/// Nothing to recover: bind-activation already took a crashed run's
/// networks down.
pub fn recover<R: Runtime>(_app: &AppHandle<R>) {}

pub fn recover_now() {}

#[cfg(test)]
mod tests {
    /// Read-only probe of this machine (no network is started):
    /// `cargo test -- --ignored --nocapture probe_this_machine`
    #[test]
    #[ignore = "talks to this machine's NetworkManager / BlueZ"]
    fn probe_this_machine() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let mut inner = super::Inner::default();
            println!("hotspot: {:#?}", super::hotspot_status(&mut inner).await);
            println!("bluetooth: {:#?}", super::bluetooth_status(&mut inner).await);
        });
    }
}
