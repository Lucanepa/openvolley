//! The NetworkManager connection settings (`a{sa{sv}}`) for the tablet Wi-Fi
//! and the Bluetooth network, as plain data so they can be tested anywhere;
//! linux.rs turns them into D-Bus values.

use super::creds::Credentials;

#[derive(Debug, Clone, PartialEq)]
pub enum Val {
    Str(String),
    Bytes(Vec<u8>),
    Bool(bool),
    I32(i32),
    Strs(Vec<String>),
}

pub type Section = (&'static str, Vec<(&'static str, Val)>);

pub const HOTSPOT_CONNECTION_ID: &str = crate::flavour::CURRENT.hotspot_connection_id;
pub const BT_CONNECTION_ID: &str = crate::flavour::CURRENT.bt_connection_id;

/// NM_SETTING_WIRELESS_SECURITY_PMF_DISABLE: iPads failed to join some
/// NetworkManager hotspots with protected management frames on.
const PMF_DISABLE: i32 = 1;

fn s(v: &str) -> Val {
    Val::Str(v.to_string())
}

/// `connection.permissions` for the user who runs the app: a user-owned
/// connection needs only polkit's settings.modify.own (granted to the active
/// desktop session), not settings.modify.system (an admin password).
pub fn user_permission(login: Option<&str>) -> Option<String> {
    let login = login?;
    let ok = !login.is_empty()
        && login.len() <= 64
        && login.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'));
    ok.then(|| format!("user:{login}"))
}

fn connection_section(id: &str, kind: &str, interface: Option<&str>, login: Option<&str>) -> Section {
    let mut v = vec![
        ("id", s(id)),
        ("type", s(kind)),
        ("autoconnect", Val::Bool(false)),
        // firewalld puts a shared connection without a zone into "nm-shared",
        // which rejects everything but DHCP / DNS / SSH: the tablets would get
        // an address and still not reach the relay. Ignored without firewalld.
        ("zone", s("trusted")),
    ];
    if let Some(i) = interface {
        v.push(("interface-name", s(i)));
    }
    if let Some(p) = user_permission(login) {
        v.push(("permissions", Val::Strs(vec![p])));
    }
    ("connection", v)
}

fn shared_ip() -> [Section; 2] {
    [
        // shared: NetworkManager gives the laptop 10.42.N.1 and runs DHCP +
        // DNS (dnsmasq) for the tablets; no uplink needed
        ("ipv4", vec![("method", s("shared"))]),
        ("ipv6", vec![("method", s("ignore"))]),
    ]
}

/// A WPA2-PSK (CCMP) access point on 2.4 GHz: every tablet can join it and
/// Intel cards refuse to start an access point on 5 GHz (no-IR channels).
pub fn hotspot_settings(c: &Credentials, login: Option<&str>) -> Vec<Section> {
    let [ipv4, ipv6] = shared_ip();
    vec![
        connection_section(HOTSPOT_CONNECTION_ID, "802-11-wireless", None, login),
        (
            "802-11-wireless",
            vec![
                ("ssid", Val::Bytes(c.ssid.as_bytes().to_vec())),
                ("mode", s("ap")),
                ("band", s("bg")),
                ("hidden", Val::Bool(false)),
            ],
        ),
        (
            "802-11-wireless-security",
            vec![
                ("key-mgmt", s("wpa-psk")),
                ("psk", s(&c.password)),
                ("proto", Val::Strs(vec!["rsn".into()])),
                ("pairwise", Val::Strs(vec!["ccmp".into()])),
                ("group", Val::Strs(vec!["ccmp".into()])),
                ("pmf", Val::I32(PMF_DISABLE)),
            ],
        ),
        ipv4,
        ipv6,
    ]
}

/// A Bluetooth network access point (NAP) on the adapter `bdaddr`: a bridge
/// the paired tablets join, with the same shared addressing as the hotspot.
pub fn bt_nap_settings(bdaddr: [u8; 6], bridge: &str, login: Option<&str>) -> Vec<Section> {
    let [ipv4, ipv6] = shared_ip();
    vec![
        connection_section(BT_CONNECTION_ID, "bluetooth", Some(bridge), login),
        ("bluetooth", vec![("type", s("nap")), ("bdaddr", Val::Bytes(bdaddr.to_vec()))]),
        ("bridge", vec![("stp", Val::Bool(false))]),
        ipv4,
        ipv6,
    ]
}

/// "AA:BB:CC:DD:EE:FF" -> bytes.
pub fn parse_bdaddr(addr: &str) -> Option<[u8; 6]> {
    let parts: Vec<&str> = addr.split(':').collect();
    if parts.len() != 6 {
        return None;
    }
    let mut out = [0u8; 6];
    for (i, p) in parts.iter().enumerate() {
        if p.len() != 2 || !p.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        out[i] = u8::from_str_radix(p, 16).ok()?;
    }
    Some(out)
}

/// The value of `key` in `section` (tests).
#[cfg(test)]
pub fn get<'a>(settings: &'a [Section], section: &str, key: &str) -> Option<&'a Val> {
    settings.iter().find(|(name, _)| *name == section)?.1.iter().find(|(k, _)| *k == key).map(|(_, v)| v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn creds() -> Credentials {
        Credentials::checked("OpenVolley-AB12", "pa;ss \"word").unwrap()
    }

    #[test]
    fn hotspot_is_a_wpa2_access_point_with_shared_ipv4() {
        let st = hotspot_settings(&creds(), Some("luca"));
        assert_eq!(get(&st, "connection", "type"), Some(&Val::Str("802-11-wireless".into())));
        assert_eq!(get(&st, "connection", "autoconnect"), Some(&Val::Bool(false)));
        assert_eq!(get(&st, "connection", "zone"), Some(&Val::Str("trusted".into())));
        assert_eq!(get(&st, "connection", "permissions"), Some(&Val::Strs(vec!["user:luca".into()])));
        assert_eq!(get(&st, "802-11-wireless", "ssid"), Some(&Val::Bytes(b"OpenVolley-AB12".to_vec())));
        assert_eq!(get(&st, "802-11-wireless", "mode"), Some(&Val::Str("ap".into())));
        assert_eq!(get(&st, "802-11-wireless", "band"), Some(&Val::Str("bg".into())));
        assert_eq!(get(&st, "802-11-wireless-security", "key-mgmt"), Some(&Val::Str("wpa-psk".into())));
        // the password goes through as one D-Bus string, never a command line
        assert_eq!(get(&st, "802-11-wireless-security", "psk"), Some(&Val::Str("pa;ss \"word".into())));
        assert_eq!(get(&st, "802-11-wireless-security", "proto"), Some(&Val::Strs(vec!["rsn".into()])));
        assert_eq!(get(&st, "802-11-wireless-security", "pmf"), Some(&Val::I32(1)));
        assert_eq!(get(&st, "ipv4", "method"), Some(&Val::Str("shared".into())));
        assert_eq!(get(&st, "ipv6", "method"), Some(&Val::Str("ignore".into())));
    }

    #[test]
    fn user_permission_only_for_a_plain_login() {
        assert_eq!(user_permission(Some("pi-kscw")), Some("user:pi-kscw".into()));
        assert_eq!(user_permission(Some("a.b_c")), Some("user:a.b_c".into()));
        assert_eq!(user_permission(None), None);
        assert_eq!(user_permission(Some("")), None);
        assert_eq!(user_permission(Some("x;y")), None);
        assert_eq!(user_permission(Some("a b")), None);
        let st = hotspot_settings(&creds(), Some("bad login"));
        assert_eq!(get(&st, "connection", "permissions"), None);
    }

    #[test]
    fn bluetooth_nap_is_a_shared_bridge_on_the_adapter() {
        let addr = parse_bdaddr("A0:B1:C2:D3:E4:F5").unwrap();
        assert_eq!(addr, [0xa0, 0xb1, 0xc2, 0xd3, 0xe4, 0xf5]);
        let st = bt_nap_settings(addr, "pan-openvolley", Some("luca"));
        assert_eq!(get(&st, "connection", "type"), Some(&Val::Str("bluetooth".into())));
        assert_eq!(get(&st, "connection", "interface-name"), Some(&Val::Str("pan-openvolley".into())));
        assert_eq!(get(&st, "bluetooth", "type"), Some(&Val::Str("nap".into())));
        assert_eq!(get(&st, "bluetooth", "bdaddr"), Some(&Val::Bytes(addr.to_vec())));
        assert_eq!(get(&st, "bridge", "stp"), Some(&Val::Bool(false)));
        assert_eq!(get(&st, "ipv4", "method"), Some(&Val::Str("shared".into())));
    }

    #[test]
    fn parses_only_well_formed_addresses() {
        assert_eq!(parse_bdaddr("00:11:22:33:44:5"), None);
        assert_eq!(parse_bdaddr("00:11:22:33:44"), None);
        assert_eq!(parse_bdaddr("00:11:22:33:44:GG"), None);
        assert_eq!(parse_bdaddr("00-11-22-33-44-55"), None);
        assert_eq!(parse_bdaddr("00:11:22:33:44:+5"), None);
    }
}
