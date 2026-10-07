//! Which app this build is: OpenVolley eScoresheet (the default) or OpenBeach.
//!
//! One shell, two apps. OpenBeach is a separate app (its own frontend from
//! the Lucanepa/openbeach repo, its own identifier, ports, package and
//! update channel) built from this same Rust code; only the names below
//! differ. build.rs picks the flavour at compile time:
//!
//! - `tauri build --config src-tauri/tauri.beach.conf.json [...]`: the
//!   identifier in the merged config (TAURI_CONFIG) is `com.openvolley.beach`;
//! - or `OV_FLAVOUR=beach cargo build|test` (build.rs then merges
//!   tauri.beach.conf.json itself, so the Tauri context is the beach one too).
//!
//! Both disagreeing is a build error. The frontend the relay embeds comes from
//! OV_DIST (or the config's build.frontendDist), see build.rs.
//!
//! OpenVolley's values must never change: its identifier keeps the installed
//! apps' data, its ports are what the tablets and the cloud's CORS know, its
//! firewall rule name is what its installer removes. The tests below and
//! src/utils/__tests__/desktopFlavours.test.js pin them.

/// The names and numbers that differ between the two apps. (Some fields are
/// read on Windows or by the tests only; one of the two apps is always unused.)
#[allow(dead_code)]
#[derive(Debug)]
pub struct Flavour {
    /// "openvolley" | "beach" (OV_FLAVOUR).
    pub key: &'static str,
    /// The Tauri identifier (tauri.conf.json / tauri.beach.conf.json).
    pub identifier: &'static str,
    /// Short name in sentences: "Quit OpenVolley?", "Show OpenBeach".
    pub name: &'static str,
    /// Window title of the scoretable and of its scoresheet windows.
    pub window_title: &'static str,
    /// Default relay ports (OPENVOLLEY_HTTP_PORT / OPENVOLLEY_WS_PORT override
    /// them in both apps). Different per app so both run on one laptop.
    pub http_port: u16,
    pub ws_port: u16,
    /// The .deb package and the command (/usr/bin/<package>).
    pub package: &'static str,
    /// Windows Defender Firewall rule the installer adds
    /// (OV_FW_RULE in windows/installer-hooks.nsh).
    pub firewall_rule: &'static str,
    /// Folder under the user's data / local app data folder: backups, and the
    /// Windows "tablet Wi-Fi left on" marker.
    pub data_folder: &'static str,
    /// The tablets' Wi-Fi name: prefix + 4 characters (netshare/creds.rs).
    pub ssid_prefix: &'static str,
    /// NetworkManager connection names (netshare/nm_settings.rs).
    pub hotspot_connection_id: &'static str,
    pub bt_connection_id: &'static str,
    /// The Bluetooth network's bridge, at most 15 characters (netifs.rs).
    pub bt_bridge_name: &'static str,
    /// The tray icon's id (lifecycle.rs).
    pub tray_id: &'static str,
    /// OPENVOLLEY_UPDATE_CHANNEL=staging: the canary manifest (updater.rs);
    /// the release endpoints are in the Tauri config (plugins.updater).
    pub staging_endpoint: &'static str,
    /// The root helper the .deb ships for the in-app update (linux/).
    pub apt_helper: &'static str,
    /// The relay serves the first of these that exists for "/" and as the
    /// single-page fallback (relay.rs).
    pub index_pages: &'static [&'static str],
}

#[allow(dead_code)]
pub const OPENVOLLEY: Flavour = Flavour {
    key: "openvolley",
    identifier: "com.openvolley.escoresheet",
    name: "OpenVolley",
    window_title: "OpenVolley eScoresheet",
    http_port: 5173,
    ws_port: 8080,
    package: "openvolley-escoresheet",
    firewall_rule: "OpenVolley eScoresheet (tablets on the local network)",
    data_folder: "OpenVolley",
    ssid_prefix: "OpenVolley-",
    hotspot_connection_id: "OpenVolley tablets Wi-Fi",
    bt_connection_id: "OpenVolley tablets Bluetooth",
    bt_bridge_name: "pan-openvolley",
    tray_id: "openvolley",
    staging_endpoint: "https://get.openvolley.app/desktop/staging.json",
    apt_helper: "/usr/libexec/openvolley-escoresheet/apt-upgrade",
    index_pages: &["index.html"],
};

#[allow(dead_code)]
pub const BEACH: Flavour = Flavour {
    key: "beach",
    identifier: "com.openvolley.beach",
    name: "OpenBeach",
    window_title: "OpenBeach",
    http_port: 5174,
    ws_port: 8081,
    package: "openbeach-escoresheet",
    firewall_rule: "OpenBeach (tablets on the local network)",
    data_folder: "OpenBeach",
    ssid_prefix: "OpenBeach-",
    hotspot_connection_id: "OpenBeach tablets Wi-Fi",
    bt_connection_id: "OpenBeach tablets Bluetooth",
    bt_bridge_name: "pan-openbeach",
    tray_id: "openbeach",
    staging_endpoint: "https://get.openvolley.app/desktop/beach/staging.json",
    apt_helper: "/usr/libexec/openbeach-escoresheet/apt-upgrade",
    // openbeach's Vite build names its scoretable page index_beach.html
    index_pages: &["index.html", "index_beach.html"],
};

#[cfg(not(ov_flavour = "beach"))]
pub const CURRENT: &Flavour = &OPENVOLLEY;
#[cfg(ov_flavour = "beach")]
pub const CURRENT: &Flavour = &BEACH;

#[cfg(test)]
mod tests {
    use super::*;

    /// OpenVolley's identity is fixed for good (installed apps, tablets,
    /// firewall rules and the APT package depend on it).
    #[test]
    fn openvolley_identity_never_changes() {
        let f = &OPENVOLLEY;
        assert_eq!(f.identifier, "com.openvolley.escoresheet");
        assert_eq!((f.http_port, f.ws_port), (5173, 8080));
        assert_eq!(f.window_title, "OpenVolley eScoresheet");
        assert_eq!(f.package, "openvolley-escoresheet");
        assert_eq!(f.firewall_rule, "OpenVolley eScoresheet (tablets on the local network)");
        assert_eq!(f.data_folder, "OpenVolley");
        assert_eq!(f.ssid_prefix, "OpenVolley-");
        assert_eq!((f.hotspot_connection_id, f.bt_connection_id), ("OpenVolley tablets Wi-Fi", "OpenVolley tablets Bluetooth"));
        assert_eq!((f.bt_bridge_name, f.tray_id), ("pan-openvolley", "openvolley"));
        assert_eq!(f.staging_endpoint, "https://get.openvolley.app/desktop/staging.json");
        assert_eq!(f.apt_helper, "/usr/libexec/openvolley-escoresheet/apt-upgrade");
        assert_eq!(f.index_pages, &["index.html"]);
    }

    /// Nothing OpenBeach uses may collide with OpenVolley: both apps run on
    /// one laptop (ports, tray, networks, firewall rule, data, package).
    #[test]
    fn beach_shares_no_name_or_port_with_openvolley() {
        let (o, b) = (&OPENVOLLEY, &BEACH);
        assert_eq!(b.identifier, "com.openvolley.beach");
        assert_eq!((b.http_port, b.ws_port), (5174, 8081));
        assert_eq!(b.window_title, "OpenBeach");
        assert_eq!(b.package, "openbeach-escoresheet");
        let ports = [o.http_port, o.ws_port, b.http_port, b.ws_port];
        for (i, p) in ports.iter().enumerate() {
            assert!(!ports[i + 1..].contains(p), "port {p} used twice");
        }
        for (x, y) in [
            (o.identifier, b.identifier),
            (o.package, b.package),
            (o.firewall_rule, b.firewall_rule),
            (o.data_folder, b.data_folder),
            (o.ssid_prefix, b.ssid_prefix),
            (o.hotspot_connection_id, b.hotspot_connection_id),
            (o.bt_connection_id, b.bt_connection_id),
            (o.bt_bridge_name, b.bt_bridge_name),
            (o.tray_id, b.tray_id),
            (o.staging_endpoint, b.staging_endpoint),
            (o.apt_helper, b.apt_helper),
        ] {
            assert_ne!(x, y);
        }
        assert!(b.bt_bridge_name.len() <= 15, "Linux interface names have at most 15 characters");
        assert!(b.apt_helper.starts_with(&format!("/usr/libexec/{}/", b.package)));
    }

    /// The build is the app its Tauri config says (build.rs checks the
    /// config's identifier against OV_FLAVOUR; this checks the result).
    #[test]
    fn the_build_is_the_app_its_tauri_config_says() {
        let ctx: tauri::Context<tauri::test::MockRuntime> = tauri::generate_context!();
        assert_eq!(ctx.config().identifier, CURRENT.identifier);
        let expected = if cfg!(ov_flavour = "beach") { "beach" } else { "openvolley" };
        assert_eq!(CURRENT.key, expected);
    }
}
