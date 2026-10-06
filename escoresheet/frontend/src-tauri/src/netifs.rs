//! The laptop's network addresses that tablets can open, each with what kind
//! of network it is: the hall Wi-Fi / Ethernet, the Wi-Fi the laptop creates
//! for the tablets (hotspot) or its Bluetooth network.
//!
//! `local_ip_address::local_ip()` returns only the default-route address:
//! with a laptop hotspot and no internet there is no default route (or it is
//! the wrong card), and the tablets were shown 127.0.0.1 or the hall address.
//! /api/server/status now lists every address with its kind, and the
//! "Connect tablets" dialog picks the one for the mode the scorer chose.

use serde::Serialize;
use std::net::{IpAddr, Ipv4Addr};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum IfKind {
    /// The laptop's own access point: NetworkManager shared mode
    /// (10.42.N.1 on a Wi-Fi card) or the Windows Mobile Hotspot / Wi-Fi
    /// Direct group (192.168.137.x).
    Hotspot,
    Wifi,
    Ethernet,
    /// The Bluetooth network the laptop serves (the app's NetworkManager NAP
    /// bridge). A Bluetooth network it only joined (tethered to a phone) is
    /// not listed: the tablets cannot reach it.
    Bluetooth,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NetIf {
    pub name: String,
    pub ip: String,
    pub kind: IfKind,
}

/// The bridge NetworkManager creates for the Bluetooth network
/// (netshare/linux.rs), at most 15 characters.
pub const BT_BRIDGE_NAME: &str = "pan-openvolley";

/// Interface names (Linux) and adapter names (Windows) of virtual networks a
/// tablet in the hall can never reach: containers, VMs, VPNs.
const VIRTUAL_PREFIXES: &[&str] = &[
    "docker", "br-", "veth", "virbr", "lxc", "lxd", "tailscale", "tun", "tap", "wg", "zt", "vmnet", "vboxnet", "cni",
    "flannel", "podman", "utun", "incusbr", "nordlynx", "proton",
];
const VIRTUAL_WORDS: &[&str] = &[
    "vethernet", "virtualbox", "vmware", "tailscale", "zerotier", "wireguard", "hyper-v", "loopback", "openvpn", "tap-windows",
    "npcap",
];

/// What kind of network an IPv4 address on `name` is, or None when no tablet
/// can use it (loopback, link-local, container / VM / VPN interfaces).
pub fn classify(name: &str, ip: Ipv4Addr) -> Option<IfKind> {
    if ip.is_loopback() || ip.is_link_local() || ip.is_unspecified() || ip.is_multicast() || ip.is_broadcast() {
        return None;
    }
    let lower = name.to_ascii_lowercase();
    if VIRTUAL_PREFIXES.iter().any(|p| lower.starts_with(p)) || VIRTUAL_WORDS.iter().any(|w| lower.contains(w)) {
        return None;
    }
    let o = ip.octets();
    if name == BT_BRIDGE_NAME {
        return Some(IfKind::Bluetooth);
    }
    // Any other Bluetooth network: the laptop joined it (Windows "Bluetooth
    // Network Connection", Linux bnep0 tethered to a phone), it serves none.
    if lower.starts_with("pan") || lower.starts_with("bnep") || lower.starts_with("bt-") || lower.contains("bluetooth") {
        return None;
    }
    // Windows Mobile Hotspot and Wi-Fi Direct groups (ICS): 192.168.137.0/24
    if o[0] == 192 && o[1] == 168 && o[2] == 137 {
        return Some(IfKind::Hotspot);
    }
    // NetworkManager shared mode: the laptop is 10.42.N.1 (a client of
    // another laptop's hotspot gets .2 and up)
    if o[0] == 10 && o[1] == 42 && o[3] == 1 {
        return Some(IfKind::Hotspot);
    }
    let wifi = lower.starts_with("wl") || lower.starts_with("ath") || lower.contains("wi-fi") || lower.contains("wifi") || lower.contains("wlan") || lower.contains("wireless");
    if wifi {
        return Some(IfKind::Wifi);
    }
    let ethernet = lower.starts_with("en") || lower.starts_with("eth") || lower.starts_with("em") || lower.contains("ethernet");
    if ethernet {
        return Some(IfKind::Ethernet);
    }
    Some(IfKind::Other)
}

/// Classified IPv4 addresses, hotspot first, then Wi-Fi, Ethernet,
/// Bluetooth, other; one entry per address.
pub fn classify_all<I: IntoIterator<Item = (String, IpAddr)>>(list: I) -> Vec<NetIf> {
    let mut out: Vec<NetIf> = Vec::new();
    for (name, ip) in list {
        let v4 = match ip {
            IpAddr::V4(v4) => v4,
            IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
                Some(v4) => v4,
                None => continue,
            },
        };
        let Some(kind) = classify(&name, v4) else { continue };
        let ip = v4.to_string();
        if out.iter().any(|n| n.ip == ip) {
            continue;
        }
        out.push(NetIf { name, ip, kind });
    }
    out.sort_by(|a, b| a.kind.cmp(&b.kind).then_with(|| a.name.cmp(&b.name)));
    out
}

/// Every address of this machine a tablet may open.
pub fn tablet_interfaces() -> Vec<NetIf> {
    classify_all(local_ip_address::list_afinet_netifas().unwrap_or_default())
}

/// The IPv4 address of one interface (by name), if it has one.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn ip_of(name: &str) -> Option<String> {
    local_ip_address::list_afinet_netifas()
        .ok()?
        .into_iter()
        .find_map(|(n, ip)| match ip {
            IpAddr::V4(v4) if n == name && !v4.is_loopback() && !v4.is_link_local() => Some(v4.to_string()),
            _ => None,
        })
}

/// The single address older clients read (`localIP`): the default-route
/// address when a tablet can use it, else the first hall network, then the
/// hotspot, then anything; 127.0.0.1 when the laptop has no network at all.
pub fn preferred_ip(list: &[NetIf], default_route: Option<String>) -> String {
    if let Some(ip) = default_route {
        if list.iter().any(|n| n.ip == ip) {
            return ip;
        }
    }
    for kind in [IfKind::Wifi, IfKind::Ethernet, IfKind::Hotspot, IfKind::Other, IfKind::Bluetooth] {
        if let Some(n) = list.iter().find(|n| n.kind == kind) {
            return n.ip.clone();
        }
    }
    "127.0.0.1".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> Ipv4Addr {
        s.parse().unwrap()
    }

    #[test]
    fn classifies_linux_interfaces() {
        assert_eq!(classify("wlp1s0", ip("192.168.1.42")), Some(IfKind::Wifi));
        assert_eq!(classify("wlp1s0", ip("10.42.0.1")), Some(IfKind::Hotspot));
        // a client of someone else's NetworkManager hotspot
        assert_eq!(classify("wlp1s0", ip("10.42.0.57")), Some(IfKind::Wifi));
        assert_eq!(classify("enp0s31f6", ip("10.0.0.5")), Some(IfKind::Ethernet));
        assert_eq!(classify("eth0", ip("172.16.3.4")), Some(IfKind::Ethernet));
        assert_eq!(classify(BT_BRIDGE_NAME, ip("10.42.1.1")), Some(IfKind::Bluetooth));
        // tethered to a phone over Bluetooth: joined, not served
        assert_eq!(classify("bnep0", ip("192.168.44.2")), None);
        assert_eq!(classify("pan0", ip("10.42.1.1")), None);
        assert_eq!(classify("lo", ip("127.0.0.1")), None);
        assert_eq!(classify("docker0", ip("172.17.0.1")), None);
        assert_eq!(classify("tailscale0", ip("100.114.142.10")), None);
        assert_eq!(classify("virbr0", ip("192.168.122.1")), None);
        assert_eq!(classify("wlp1s0", ip("169.254.10.2")), None);
    }

    #[test]
    fn classifies_windows_adapters() {
        assert_eq!(classify("Wi-Fi", ip("192.168.1.42")), Some(IfKind::Wifi));
        assert_eq!(classify("WLAN", ip("192.168.1.42")), Some(IfKind::Wifi));
        assert_eq!(classify("Ethernet 2", ip("10.1.1.4")), Some(IfKind::Ethernet));
        assert_eq!(classify("Local Area Connection* 10", ip("192.168.137.1")), Some(IfKind::Hotspot));
        assert_eq!(classify("LAN-Verbindung* 3", ip("192.168.137.1")), Some(IfKind::Hotspot));
        // Windows only ever joins a Bluetooth network
        assert_eq!(classify("Bluetooth Network Connection", ip("192.168.44.3")), None);
        assert_eq!(classify("Bluetooth-Netzwerkverbindung", ip("192.168.44.3")), None);
        assert_eq!(classify("Bluetooth Network Connection", ip("192.168.137.4")), None);
        assert_eq!(classify("vEthernet (WSL)", ip("172.20.0.1")), None);
        assert_eq!(classify("VirtualBox Host-Only Network", ip("192.168.56.1")), None);
        assert_eq!(classify("Some adapter", ip("192.168.5.5")), Some(IfKind::Other));
    }

    #[test]
    fn sorts_and_dedupes() {
        let list = classify_all(vec![
            ("enp0s31f6".to_string(), IpAddr::V4(ip("10.0.0.5"))),
            ("lo".to_string(), IpAddr::V4(ip("127.0.0.1"))),
            ("wlp1s0".to_string(), IpAddr::V4(ip("10.42.0.1"))),
            ("wlp1s0".to_string(), IpAddr::V6("fe80::1".parse().unwrap())),
            (BT_BRIDGE_NAME.to_string(), IpAddr::V4(ip("10.42.1.1"))),
            ("eth9".to_string(), IpAddr::V4(ip("10.0.0.5"))),
        ]);
        let kinds: Vec<_> = list.iter().map(|n| (n.name.as_str(), n.kind)).collect();
        assert_eq!(
            kinds,
            vec![("wlp1s0", IfKind::Hotspot), ("enp0s31f6", IfKind::Ethernet), (BT_BRIDGE_NAME, IfKind::Bluetooth)]
        );
    }

    #[test]
    fn preferred_ip_never_picks_loopback_when_offline() {
        let list = classify_all(vec![("wlp1s0".to_string(), IpAddr::V4(ip("10.42.0.1")))]);
        // no default route (laptop hotspot, no internet)
        assert_eq!(preferred_ip(&list, None), "10.42.0.1");
        assert_eq!(preferred_ip(&list, Some("127.0.0.1".into())), "10.42.0.1");
        let hall = classify_all(vec![
            ("wlp1s0".to_string(), IpAddr::V4(ip("192.168.1.42"))),
            ("enp0s31f6".to_string(), IpAddr::V4(ip("10.0.0.5"))),
        ]);
        assert_eq!(preferred_ip(&hall, Some("10.0.0.5".into())), "10.0.0.5");
        assert_eq!(preferred_ip(&hall, None), "192.168.1.42");
        assert_eq!(preferred_ip(&[], None), "127.0.0.1");
    }
}
