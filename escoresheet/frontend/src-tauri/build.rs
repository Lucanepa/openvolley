use std::{
    env, fs,
    path::{Path, PathBuf},
};

use serde_json::Value;

const APP_COMMANDS: &[&str] = &[
    // automatic match backups (backup.rs)
    "backup_info",
    "backup_write",
    "backup_list",
    "backup_remove",
    "backup_open_dir",
    "backup_pick_file",
    // networks the laptop creates for the tablets (netshare/)
    "hotspot_status",
    "hotspot_start",
    "hotspot_stop",
    "bluetooth_status",
    "bluetooth_start",
    "bluetooth_stop",
    // is the installer's firewall rule for the tablets there? (firewall.rs)
    "firewall_status",
    // close to tray / confirmed quit (lifecycle.rs)
    "app_page_state",
    "app_page_gone",
    "app_hide",
    "app_quit",
    "app_quit_ack",
    // automatic updates (updater.rs)
    "update_status",
    "update_check_now",
    "update_install_now",
    "update_set_prefs",
    // open / show a file the app downloaded, by its id (popups.rs)
    "download_open",
    "download_reveal",
];

/// The OpenBeach app's identifier (src/flavour.rs BEACH).
const BEACH_IDENTIFIER: &str = "com.openvolley.beach";

fn main() {
    select_flavour();

    // An app ACL manifest: these commands are denied unless a capability
    // grants them (capabilities/backup.json, capabilities/netshare.json,
    // capabilities/app.json, capabilities/update.json: only the main window,
    // only from http://localhost; capabilities/downloads.json: the main window
    // and the scoresheet windows, only from http://localhost).
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("failed to run tauri-build");
}

/// OpenVolley (default) or OpenBeach (src/flavour.rs), and the frontend the
/// relay embeds.
///
/// The flavour is the app the Tauri config describes: `tauri build --config
/// src-tauri/tauri.beach.conf.json` hands the merged --config to this script
/// as TAURI_CONFIG, whose identifier com.openvolley.beach means OpenBeach.
/// `OV_FLAVOUR=beach` without such a config (cargo build / test) merges
/// tauri.beach.conf.json (+ tauri.beach.linux.conf.json on Linux) here and
/// passes it on as TAURI_CONFIG, to tauri-build below and to
/// generate_context!, so the whole app is the beach one. OV_FLAVOUR naming the
/// other app than the config is an error.
///
/// The relay's embedded frontend (relay.rs, rust-embed `$OV_DIST`): OV_DIST
/// when set, else the config's build.frontendDist (../dist for OpenVolley,
/// the openbeach checkout's dist for OpenBeach). Relative to src-tauri.
fn select_flavour() {
    println!("cargo:rustc-check-cfg=cfg(ov_flavour, values(\"beach\"))");
    println!("cargo:rerun-if-env-changed=OV_FLAVOUR");
    println!("cargo:rerun-if-env-changed=OV_DIST");
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
    println!("cargo:rerun-if-changed=tauri.beach.conf.json");
    println!("cargo:rerun-if-changed=tauri.beach.linux.conf.json");

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let given: Option<Value> = env::var("TAURI_CONFIG")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(|s| serde_json::from_str(&s).expect("TAURI_CONFIG is not JSON"));
    let given_id = given
        .as_ref()
        .and_then(|c| c.get("identifier"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let from_config = given_id
        .as_deref()
        .map(|id| if id == BEACH_IDENTIFIER { "beach" } else { "openvolley" });
    let wanted = env::var("OV_FLAVOUR").ok().filter(|s| !s.is_empty());

    let flavour = match (wanted.as_deref(), from_config) {
        (Some(w), _) if w != "beach" && w != "openvolley" => {
            panic!("OV_FLAVOUR={w}: expected \"openvolley\" or \"beach\"")
        }
        (Some(w), Some(c)) if w != c => panic!(
            "OV_FLAVOUR={w}, but the Tauri config's identifier {} is the {c} app",
            given_id.unwrap_or_default()
        ),
        (Some(w), _) => w,
        (None, Some(c)) => c,
        (None, None) => "openvolley",
    };

    // The effective --config on top of tauri.conf.json (+ platform file).
    let mut effective = given.clone();
    if flavour == "beach" && from_config.is_none() {
        let mut cfg = read_json(&manifest_dir.join("tauri.beach.conf.json"));
        if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
            merge(&mut cfg, &read_json(&manifest_dir.join("tauri.beach.linux.conf.json")));
        }
        if let Some(g) = &given {
            merge(&mut cfg, g);
        }
        let json = serde_json::to_string(&cfg).unwrap();
        // tauri-build (in this process) and generate_context! (rustc) read it
        env::set_var("TAURI_CONFIG", &json);
        println!("cargo:rustc-env=TAURI_CONFIG={json}");
        effective = Some(cfg);
    }
    if flavour == "beach" {
        println!("cargo:rustc-cfg=ov_flavour=\"beach\"");
    }

    let dist = env::var("OV_DIST").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| {
        let from = |c: &Value| c.pointer("/build/frontendDist").and_then(Value::as_str).map(str::to_string);
        effective
            .as_ref()
            .and_then(from)
            .or_else(|| from(&read_json(&manifest_dir.join("tauri.conf.json"))))
            .expect("no build.frontendDist in the Tauri config: set OV_DIST")
    });
    println!("cargo:rustc-env=OV_DIST={dist}");
}

fn read_json(path: &Path) -> Value {
    let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// JSON merge patch (RFC 7396), as Tauri merges --config files: objects merge
/// key by key, null removes a key, anything else replaces.
fn merge(target: &mut Value, patch: &Value) {
    match patch {
        Value::Object(p) => {
            if !target.is_object() {
                *target = Value::Object(Default::default());
            }
            let t = target.as_object_mut().unwrap();
            for (k, v) in p {
                if v.is_null() {
                    t.remove(k);
                } else {
                    merge(t.entry(k.clone()).or_insert(Value::Null), v);
                }
            }
        }
        _ => *target = patch.clone(),
    }
}
