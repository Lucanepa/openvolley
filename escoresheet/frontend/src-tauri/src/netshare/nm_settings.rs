//! The NetworkManager connection settings (`a{sa{sv}}`) for the tablet Wi-Fi
//! and the Bluetooth network, as plain data so they can be tested anywhere;
//! linux.rs turns them into D-Bus values.

use super::creds::Credentials;
use super::NetError;

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

/// The firewalld zone the .deb ships for the tablets' networks
/// (linux/<name>.xml, installed to /usr/lib/firewalld/zones): DHCP, DNS,
/// ping and the relay's two default ports from the tablets, nothing else
/// to the laptop and nothing forwarded to its other networks.
pub const TABLET_ZONE: &str = if matches!(crate::flavour::CURRENT.key.as_bytes(), b"beach") {
    "openbeach-tablets"
} else {
    "openvolley-tablets"
};

/// Why the tablets' network cannot start safely (SEC-53): firewalld runs and
/// does not know the app's zone, or the zone does not open the ports the
/// relay listens on. Never "trusted" (every port of this computer open to
/// the tablets, and NetworkManager masquerades them to its uplink) in place
/// of the zone.
pub const ZONE_MISSING: &str = "firewall-zone-missing";
pub const ZONE_PORTS: &str = "firewall-zone-ports";

/// Does firewalld's port list (getPorts: [port or "a-b", protocol]) open `port`/tcp?
fn opens_tcp(ports: &[(String, String)], port: u16) -> bool {
    ports.iter().any(|(p, proto)| {
        if proto != "tcp" {
            return false;
        }
        match p.split_once('-') {
            Some((a, b)) => matches!((a.parse::<u16>(), b.parse::<u16>()), (Ok(a), Ok(b)) if a <= port && port <= b),
            None => p.parse::<u16>().ok() == Some(port),
        }
    })
}

/// The firewalld zone for the tablets' networks. firewalld puts a shared
/// connection without a zone into "nm-shared", which rejects everything but
/// DHCP / DNS / SSH: the tablets would get an address and still not reach the
/// relay. So the app's own zone (TABLET_ZONE: DHCP, DNS, ping and the relay's
/// two ports), and only where firewalld knows it and it opens the ports the
/// relay listens on; otherwise the network does not start, and the error
/// says how to add the zone or the ports (one root command, the same for the
/// .deb, the AppImage, the AUR, Snap and Flatpak packages). `zones`:
/// firewalld's zones, None when firewalld does not run (NetworkManager then
/// ignores the zone) or may not be asked (a sandbox: the zone is asked for
/// all the same, and firewalld puts an unknown one in its default zone,
/// which is never "trusted"). `zone_ports`: the ports TABLET_ZONE opens now (getPorts),
/// None when firewalld did not say: then the zone file's own, `default_ports`.
pub fn firewall_zone(
    zones: Option<&[String]>,
    zone_ports: Option<&[(String, String)]>,
    (http, ws): (u16, u16),
    default_ports: (u16, u16),
) -> Result<&'static str, NetError> {
    let Some(zones) = zones else { return Ok(TABLET_ZONE) };
    let zone = TABLET_ZONE;
    if !zones.iter().any(|z| z == zone) {
        let (dh, dw) = default_ports;
        let ports = if (http, ws) == default_ports { String::new() } else { format!(" --add-port={http}/tcp --add-port={ws}/tcp") };
        return Err(NetError::new(
            ZONE_MISSING,
            format!(
                "firewalld has no zone {zone} for the tablets (the .deb installs it: run firewall-cmd --reload). Add it once as root: \
firewall-cmd --permanent --new-zone={zone} && firewall-cmd --permanent --zone={zone} --add-service=dhcp --add-service=dns \
--add-protocol=icmp --add-port={dh}/tcp --add-port={dw}/tcp{ports} && firewall-cmd --reload"
            ),
        ));
    }
    let defaults = [(default_ports.0.to_string(), "tcp".to_string()), (default_ports.1.to_string(), "tcp".to_string())];
    let open = zone_ports.unwrap_or(&defaults);
    let missing: Vec<u16> = [http, ws].into_iter().filter(|p| !opens_tcp(open, *p)).collect();
    if missing.is_empty() {
        return Ok(zone);
    }
    let add: String = missing.iter().map(|p| format!(" --add-port={p}/tcp")).collect();
    Err(NetError::new(
        ZONE_PORTS,
        format!(
            "The firewalld zone {zone} does not open the relay's port(s) {}. Open them as root: \
firewall-cmd --zone={zone}{add} && firewall-cmd --permanent --zone={zone}{add}",
            missing.iter().map(|p| format!("{p}/tcp")).collect::<Vec<_>>().join(", ")
        ),
    ))
}

fn connection_section(id: &str, kind: &str, interface: Option<&str>, login: Option<&str>, zone: &str) -> Section {
    let mut v = vec![
        ("id", s(id)),
        ("type", s(kind)),
        ("autoconnect", Val::Bool(false)),
        // firewall_zone; ignored without firewalld
        ("zone", s(zone)),
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
pub fn hotspot_settings(c: &Credentials, login: Option<&str>, zone: &str) -> Vec<Section> {
    let [ipv4, ipv6] = shared_ip();
    vec![
        connection_section(HOTSPOT_CONNECTION_ID, "802-11-wireless", None, login, zone),
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
pub fn bt_nap_settings(bdaddr: [u8; 6], bridge: &str, login: Option<&str>, zone: &str) -> Vec<Section> {
    let [ipv4, ipv6] = shared_ip();
    vec![
        connection_section(BT_CONNECTION_ID, "bluetooth", Some(bridge), login, zone),
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
        let st = hotspot_settings(&creds(), Some("luca"), TABLET_ZONE);
        assert_eq!(get(&st, "connection", "type"), Some(&Val::Str("802-11-wireless".into())));
        assert_eq!(get(&st, "connection", "autoconnect"), Some(&Val::Bool(false)));
        assert_eq!(get(&st, "connection", "zone"), Some(&Val::Str("openvolley-tablets".into())));
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
        assert_eq!(user_permission(Some("pi-board")), Some("user:pi-board".into()));
        assert_eq!(user_permission(Some("a.b_c")), Some("user:a.b_c".into()));
        assert_eq!(user_permission(None), None);
        assert_eq!(user_permission(Some("")), None);
        assert_eq!(user_permission(Some("x;y")), None);
        assert_eq!(user_permission(Some("a b")), None);
        let st = hotspot_settings(&creds(), Some("bad login"), TABLET_ZONE);
        assert_eq!(get(&st, "connection", "permissions"), None);
    }

    #[test]
    fn bluetooth_nap_is_a_shared_bridge_on_the_adapter() {
        let addr = parse_bdaddr("A0:B1:C2:D3:E4:F5").unwrap();
        assert_eq!(addr, [0xa0, 0xb1, 0xc2, 0xd3, 0xe4, 0xf5]);
        let st = bt_nap_settings(addr, "pan-openvolley", Some("luca"), TABLET_ZONE);
        assert_eq!(get(&st, "connection", "type"), Some(&Val::Str("bluetooth".into())));
        assert_eq!(get(&st, "connection", "zone"), Some(&Val::Str("openvolley-tablets".into())));
        assert_eq!(get(&st, "connection", "interface-name"), Some(&Val::Str("pan-openvolley".into())));
        assert_eq!(get(&st, "bluetooth", "type"), Some(&Val::Str("nap".into())));
        assert_eq!(get(&st, "bluetooth", "bdaddr"), Some(&Val::Bytes(addr.to_vec())));
        assert_eq!(get(&st, "bridge", "stp"), Some(&Val::Bool(false)));
        assert_eq!(get(&st, "ipv4", "method"), Some(&Val::Str("shared".into())));
    }

    /// tauri-shell-3, SEC-53: never "trusted" (every port of the laptop open
    /// to the tablets): the app's own zone where firewalld knows it and it
    /// opens the relay's ports, else the network does not start and the error
    /// gives the root command (every package: AppImage, AUR, Snap, Flatpak).
    #[test]
    fn the_tablets_get_the_own_zone_never_trusted() {
        let with = vec!["public".to_string(), "nm-shared".into(), TABLET_ZONE.into(), "trusted".into()];
        let without = vec!["public".to_string(), "nm-shared".into(), "trusted".into()];
        let defaults = (5173, 8080);
        assert_eq!(firewall_zone(Some(&with), None, defaults, defaults), Ok(TABLET_ZONE));
        // no firewalld, or one this sandbox may not ask: the app zone, never "trusted"
        assert_eq!(firewall_zone(None, None, defaults, defaults), Ok(TABLET_ZONE));
        assert_eq!(firewall_zone(None, None, (9000, 9001), defaults), Ok(TABLET_ZONE));
        // firewalld without the zone (an AppImage, AUR, Snap, Flatpak, a .deb not reloaded yet)
        let e = firewall_zone(Some(&without), None, defaults, defaults).unwrap_err();
        assert_eq!(e.code, ZONE_MISSING);
        assert!(e.detail.contains("firewall-cmd --permanent --new-zone=openvolley-tablets"), "{}", e.detail);
        assert!(e.detail.contains("--add-port=5173/tcp --add-port=8080/tcp") && e.detail.contains("--add-service=dhcp"), "{}", e.detail);
        assert!(!e.detail.contains("trusted"));
        // firewalld answered with no zones at all: no zone, no "trusted"
        assert_eq!(firewall_zone(Some(&[]), None, defaults, defaults).unwrap_err().code, ZONE_MISSING);
        // ports moved (OPENVOLLEY_HTTP_PORT / _WS_PORT): only when the zone opens them
        let e = firewall_zone(Some(&with), None, (9000, 8080), defaults).unwrap_err();
        assert_eq!(e.code, ZONE_PORTS);
        assert!(e.detail.contains("--add-port=9000/tcp") && !e.detail.contains("--add-port=8080/tcp"), "{}", e.detail);
        let opened = vec![("9000".to_string(), "tcp".to_string()), ("8000-8100".to_string(), "tcp".to_string())];
        assert_eq!(firewall_zone(Some(&with), Some(&opened), (9000, 8080), defaults), Ok(TABLET_ZONE));
        // the zone's own ports as firewalld says them, udp does not count
        let udp = vec![("5173".to_string(), "udp".to_string()), ("8080".to_string(), "tcp".to_string())];
        assert_eq!(firewall_zone(Some(&with), Some(&udp), defaults, defaults).unwrap_err().code, ZONE_PORTS);
        let missing_ports = firewall_zone(Some(&without), None, (9000, 9001), defaults).unwrap_err();
        assert!(missing_ports.detail.contains("--add-port=9000/tcp --add-port=9001/tcp"), "{}", missing_ports.detail);
    }

    /// No "trusted" anywhere in the zone choice (SEC-53).
    #[test]
    fn no_trusted_fallback_is_left() {
        let code_of = |src: &'static str| -> String {
            let end = src.find("#[cfg(test)]").unwrap_or(src.len());
            src[..end].lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n")
        };
        for code in [code_of(include_str!("nm_settings.rs")), code_of(include_str!("linux.rs"))] {
            assert!(!code.contains("FALLBACK_ZONE") && !code.contains("\"trusted\""));
        }
    }

    /// The zone file the .deb ships opens DHCP, DNS and the relay's two
    /// default ports, nothing else, and forwards nothing.
    #[test]
    fn the_zone_file_opens_the_relay_ports_only() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("linux");
        for (file, http, ws) in [("openvolley-tablets.xml", 5173, 8080), ("beach/openbeach-tablets.xml", 5174, 8081)] {
            let xml = std::fs::read_to_string(dir.join(file)).unwrap();
            assert!(xml.contains(r#"<service name="dhcp"/>"#) && xml.contains(r#"<service name="dns"/>"#), "{file}");
            let ports: Vec<&str> = xml.match_indices("<port ").map(|(i, _)| &xml[i..i + xml[i..].find("/>").unwrap()]).collect();
            assert_eq!(ports, vec![format!(r#"<port protocol="tcp" port="{http}""#), format!(r#"<port protocol="tcp" port="{ws}""#)], "{file}");
            assert_eq!(xml.matches("<service ").count(), 2, "{file}");
            for never in ["<forward", "target=\"ACCEPT\"", "<masquerade", "ssh"] {
                assert!(!xml.contains(never), "{file}: {never}");
            }
        }
        let ov = crate::flavour::OPENVOLLEY;
        let beach = crate::flavour::BEACH;
        assert_eq!((ov.http_port, ov.ws_port, beach.http_port, beach.ws_port), (5173, 8080, 5174, 8081));
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
