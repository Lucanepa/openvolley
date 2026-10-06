//! Windows Defender Firewall: is the installer's rule for the tablets there?
//!
//! The per-machine NSIS installer (windows/installer-hooks.nsh) adds one
//! inbound rule named [`RULE_NAME`]: this program, TCP, from the local
//! network only (LocalSubnet), on private and public networks. With it the
//! tablets reach the built-in server on any Wi-Fi, the laptop's own hotspot
//! included (usually a "Public" network). Without it (a dev build, a copy
//! run from elsewhere, a rule removed by IT) Defender asks at the first
//! start and "Public" must be ticked: the Connect tablets dialog shows that
//! step only while [`FirewallStatus::ready`] is false.
//!
//! Read through the firewall's COM API (INetFwPolicy2, any user may read
//! it): no netsh, no console window, no localised text to parse, and no
//! input from the page at all. The scoretable window only (build.rs app
//! manifest + capabilities/netshare.json).

use serde::Serialize;

/// Must match OV_FW_RULE in windows/installer-hooks.nsh.
pub const RULE_NAME: &str = "OpenVolley eScoresheet (tablets on the local network)";

const PROTOCOL_TCP: i32 = 6;
const PROTOCOL_ANY: i32 = 256;
const PROFILE_PRIVATE: i32 = 2;
const PROFILE_PUBLIC: i32 = 4;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FirewallStatus {
    pub platform: &'static str,
    /// Windows: the check means something. Elsewhere there is nothing to do.
    pub supported: bool,
    /// The installer's rule is there, on, and lets this program in over TCP
    /// on private and public networks.
    pub ready: bool,
    /// Why not: rule-missing, rule-disabled, rule-blocks, rule-outbound,
    /// other-program, protocol, profiles, check-failed, unsupported-os.
    pub reason: Option<&'static str>,
    pub detail: Option<String>,
}

/// What the check needs from a firewall rule.
#[derive(Debug, Clone, PartialEq)]
pub struct RuleView {
    pub enabled: bool,
    pub inbound: bool,
    pub allow: bool,
    pub protocol: i32,
    pub profiles: i32,
    pub application: String,
}

/// Does `rule` let `exe` in from the tablets? `env` expands `%ProgramFiles%`
/// style variables in the rule's program path.
pub fn assess(rule: Option<&RuleView>, exe: &str, env: &dyn Fn(&str) -> Option<String>) -> Result<(), &'static str> {
    let Some(rule) = rule else { return Err("rule-missing") };
    if !rule.enabled {
        return Err("rule-disabled");
    }
    if !rule.inbound {
        return Err("rule-outbound");
    }
    if !rule.allow {
        return Err("rule-blocks");
    }
    if rule.protocol != PROTOCOL_TCP && rule.protocol != PROTOCOL_ANY {
        return Err("protocol");
    }
    let both = PROFILE_PRIVATE | PROFILE_PUBLIC;
    if rule.profiles & both != both {
        return Err("profiles");
    }
    if !same_path(&rule.application, exe, env) {
        return Err("other-program");
    }
    Ok(())
}

/// Windows path equality: case-insensitive, `/` = `\`, without the `\\?\`
/// prefix, with `%VAR%` expanded (the firewall may keep a path as
/// `%ProgramFiles%\...`).
pub fn same_path(a: &str, b: &str, env: &dyn Fn(&str) -> Option<String>) -> bool {
    let norm = |p: &str| -> String {
        let p = expand_env(p.trim().trim_matches('"'), env).replace('/', "\\");
        let p = p.strip_prefix("\\\\?\\").unwrap_or(&p).to_string();
        p.trim_end_matches('\\').to_lowercase()
    };
    let (a, b) = (norm(a), norm(b));
    !a.is_empty() && a == b
}

/// `%NAME%` replaced by `env(NAME)`; unknown names and lone `%` stay as they are.
pub fn expand_env(s: &str, env: &dyn Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 => {
                let name = &after[..end];
                match env(name) {
                    Some(value) => out.push_str(&value),
                    None => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn status(result: Result<(), &'static str>, detail: Option<String>) -> FirewallStatus {
    FirewallStatus {
        platform: crate::netshare::PLATFORM,
        supported: cfg!(windows),
        ready: result.is_ok(),
        reason: result.err(),
        detail,
    }
}

#[cfg(windows)]
fn read_rule() -> windows::core::Result<Option<RuleView>> {
    use windows::core::BSTR;
    use windows::Win32::NetworkManagement::WindowsFirewall::{
        INetFwPolicy2, NetFwPolicy2, NET_FW_ACTION_ALLOW, NET_FW_RULE_DIR_IN,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};

    // ERROR_FILE_NOT_FOUND as an HRESULT: no rule by that name
    const NOT_FOUND: u32 = 0x8007_0002;

    // A blocking-pool thread: join (or start) the multithreaded apartment
    // for this call, leave it again after.
    let joined = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
    let result = (|| unsafe {
        let policy: INetFwPolicy2 = CoCreateInstance(&NetFwPolicy2, None, CLSCTX_INPROC_SERVER)?;
        let rule = match policy.Rules()?.Item(&BSTR::from(RULE_NAME)) {
            Ok(rule) => rule,
            Err(e) if e.code().0 as u32 == NOT_FOUND => return Ok(None),
            Err(e) => return Err(e),
        };
        Ok(Some(RuleView {
            enabled: rule.Enabled()?.as_bool(),
            inbound: rule.Direction()? == NET_FW_RULE_DIR_IN,
            allow: rule.Action()? == NET_FW_ACTION_ALLOW,
            protocol: rule.Protocol()?,
            profiles: rule.Profiles()?,
            application: rule.ApplicationName()?.to_string(),
        }))
    })();
    if joined {
        unsafe { CoUninitialize() };
    }
    result
}

#[cfg(windows)]
fn check() -> FirewallStatus {
    let exe = match std::env::current_exe() {
        Ok(p) => p.to_string_lossy().into_owned(),
        Err(e) => return status(Err("check-failed"), Some(e.to_string())),
    };
    match read_rule() {
        Ok(rule) => {
            let env = |name: &str| std::env::var(name).ok();
            let detail = rule.as_ref().map(|r| r.application.clone());
            status(assess(rule.as_ref(), &exe, &env), detail)
        }
        Err(e) => status(Err("check-failed"), Some(e.to_string())),
    }
}

/// The scoretable's question: will the tablets get through the firewall?
#[tauri::command]
pub async fn firewall_status() -> FirewallStatus {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(check)
            .await
            .unwrap_or_else(|e| status(Err("check-failed"), Some(e.to_string())))
    }
    #[cfg(not(windows))]
    {
        status(Err("unsupported-os"), None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = r"C:\Program Files\Openvolley eScoresheet\openvolley-escoresheet.exe";

    fn env(name: &str) -> Option<String> {
        match name.to_ascii_lowercase().as_str() {
            "programfiles" => Some(r"C:\Program Files".into()),
            "systemdrive" => Some("C:".into()),
            _ => None,
        }
    }

    fn installed() -> RuleView {
        RuleView {
            enabled: true,
            inbound: true,
            allow: true,
            protocol: PROTOCOL_TCP,
            profiles: PROFILE_PRIVATE | PROFILE_PUBLIC,
            application: EXE.into(),
        }
    }

    #[test]
    fn the_installers_rule_is_ready() {
        assert_eq!(assess(Some(&installed()), EXE, &env), Ok(()));
        // all profiles, any protocol: also fine
        let wide = RuleView { protocol: PROTOCOL_ANY, profiles: 0x7fff_ffff, ..installed() };
        assert_eq!(assess(Some(&wide), EXE, &env), Ok(()));
    }

    #[test]
    fn a_missing_or_unusable_rule_is_not() {
        assert_eq!(assess(None, EXE, &env), Err("rule-missing"));
        assert_eq!(assess(Some(&RuleView { enabled: false, ..installed() }), EXE, &env), Err("rule-disabled"));
        assert_eq!(assess(Some(&RuleView { inbound: false, ..installed() }), EXE, &env), Err("rule-outbound"));
        assert_eq!(assess(Some(&RuleView { allow: false, ..installed() }), EXE, &env), Err("rule-blocks"));
        assert_eq!(assess(Some(&RuleView { protocol: 17, ..installed() }), EXE, &env), Err("protocol"));
        // private only: the hotspot (Public) stays closed
        assert_eq!(assess(Some(&RuleView { profiles: PROFILE_PRIVATE, ..installed() }), EXE, &env), Err("profiles"));
        assert_eq!(assess(Some(&RuleView { profiles: PROFILE_PUBLIC, ..installed() }), EXE, &env), Err("profiles"));
    }

    #[test]
    fn the_rule_must_be_for_this_program() {
        // a dev build, or the old per-user copy
        let dev = r"D:\src\openvolley\escoresheet\frontend\src-tauri\target\release\openvolley-escoresheet.exe";
        assert_eq!(assess(Some(&installed()), dev, &env), Err("other-program"));
        let old = r"C:\Users\scorer\AppData\Local\Openvolley eScoresheet\openvolley-escoresheet.exe";
        assert_eq!(assess(Some(&installed()), old, &env), Err("other-program"));
        assert_eq!(assess(Some(&RuleView { application: String::new(), ..installed() }), EXE, &env), Err("other-program"));
    }

    #[test]
    fn windows_paths_compare_like_windows() {
        assert!(same_path(EXE, &EXE.to_uppercase(), &env));
        assert!(same_path(r"%ProgramFiles%\Openvolley eScoresheet\openvolley-escoresheet.exe", EXE, &env));
        assert!(same_path(r"%SystemDrive%\Program Files\Openvolley eScoresheet\openvolley-escoresheet.exe", EXE, &env));
        assert!(same_path(&format!(r"\\?\{EXE}"), EXE, &env));
        assert!(same_path(&format!("\"{EXE}\""), EXE, &env));
        assert!(same_path(&EXE.replace('\\', "/"), EXE, &env));
        assert!(!same_path(r"C:\Program Files\Other\openvolley-escoresheet.exe", EXE, &env));
        assert!(!same_path("", "", &env));
    }

    #[test]
    fn env_expansion_leaves_unknown_and_lone_percent_signs() {
        assert_eq!(expand_env(r"%ProgramFiles%\x", &env), r"C:\Program Files\x");
        assert_eq!(expand_env(r"%Nope%\x", &env), r"%Nope%\x");
        assert_eq!(expand_env("100% sure", &env), "100% sure");
        assert_eq!(expand_env("%%", &env), "%%");
        assert_eq!(expand_env("a%", &env), "a%");
    }

    #[test]
    fn the_rule_name_matches_the_installer() {
        let hooks = include_str!("../windows/installer-hooks.nsh");
        assert!(
            hooks.contains(&format!("!define OV_FW_RULE \"{RULE_NAME}\"")),
            "OV_FW_RULE in windows/installer-hooks.nsh must be {RULE_NAME:?}"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn nothing_to_check_off_windows() {
        let s = tauri::async_runtime::block_on(firewall_status());
        assert!(!s.supported && !s.ready);
        assert_eq!(s.reason, Some("unsupported-os"));
    }
}
