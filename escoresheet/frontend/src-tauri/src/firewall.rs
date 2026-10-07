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
//! A Block rule for this program beats any Allow rule, so those count too.
//! Defender makes them itself: the installer's rule leaves out Domain
//! networks, so on a domain laptop's office network Defender still asks at
//! the first start, and Cancel there (or a standard user who cannot elevate)
//! adds inbound Block rules for this exe that later shut the tablets out on
//! the hotspot as well. The manual step ("Allow an app through firewall",
//! tick Public) turns such a rule back into an Allow one.
//!
//! Read through the firewall's COM API (INetFwPolicy2, any user may read
//! it): no netsh, no console window, no localised text to parse, and no
//! input from the page at all. The scoretable window only (build.rs app
//! manifest + capabilities/netshare.json).
//!
//! Elsewhere (Linux, macOS) `firewall_status` answers "unsupported-os"; the
//! rule logic stays compiled for its tests.
#![cfg_attr(not(windows), allow(dead_code))]

use serde::Serialize;

/// Must match OV_FW_RULE in windows/installer-hooks.nsh (per app: flavour.rs).
pub const RULE_NAME: &str = crate::flavour::CURRENT.firewall_rule;

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
    /// Why not: blocked-by-rule (another rule blocks this program),
    /// rule-missing, rule-disabled, rule-blocks, rule-outbound,
    /// other-program, protocol, profiles, check-failed, unsupported-os.
    pub reason: Option<&'static str>,
    pub detail: Option<String>,
}

/// What the check needs from a firewall rule.
#[derive(Debug, Clone, PartialEq)]
pub struct RuleView {
    pub name: String,
    pub enabled: bool,
    pub inbound: bool,
    pub allow: bool,
    pub protocol: i32,
    pub profiles: i32,
    pub application: String,
}

/// Does `rule` (the installer's) let `exe` in from the tablets, with none of
/// `others` (every other rule, or at least the inbound Block ones) shutting
/// it out? `env` expands `%ProgramFiles%` style variables in program paths.
pub fn assess(
    rule: Option<&RuleView>,
    others: &[RuleView],
    exe: &str,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<(), &'static str> {
    if others.iter().any(|r| blocks_tablets(r, exe, env)) {
        return Err("blocked-by-rule");
    }
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

/// An enabled inbound Block rule for `exe` (TCP or any protocol) on private or
/// public networks: Block beats Allow in Windows Defender Firewall. Rules
/// for all programs or for a port only are not counted: Defender never makes
/// those, and an administrator who does means something else by it.
pub fn blocks_tablets(rule: &RuleView, exe: &str, env: &dyn Fn(&str) -> Option<String>) -> bool {
    rule.enabled
        && rule.inbound
        && !rule.allow
        && (rule.protocol == PROTOCOL_TCP || rule.protocol == PROTOCOL_ANY)
        && rule.profiles & (PROFILE_PRIVATE | PROFILE_PUBLIC) != 0
        && same_path(&rule.application, exe, env)
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

/// The installer's rule by name, and every enabled inbound Block rule (any
/// program: [`assess`] picks the ones for this exe).
#[cfg(windows)]
fn read_rules() -> windows::core::Result<(Option<RuleView>, Vec<RuleView>)> {
    use windows::core::{Interface, BSTR};
    use windows::Win32::NetworkManagement::WindowsFirewall::{
        INetFwPolicy2, INetFwRule, NetFwPolicy2, NET_FW_ACTION_ALLOW, NET_FW_ACTION_BLOCK, NET_FW_RULE_DIR_IN,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, IDispatch, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
    use windows::Win32::System::Ole::IEnumVARIANT;
    use windows::Win32::System::Variant::{VariantClear, VARIANT, VT_DISPATCH};

    // ERROR_FILE_NOT_FOUND as an HRESULT: no rule by that name
    const NOT_FOUND: u32 = 0x8007_0002;

    unsafe fn view(rule: &INetFwRule) -> windows::core::Result<RuleView> {
        Ok(RuleView {
            name: rule.Name()?.to_string(),
            enabled: rule.Enabled()?.as_bool(),
            inbound: rule.Direction()? == NET_FW_RULE_DIR_IN,
            allow: rule.Action()? == NET_FW_ACTION_ALLOW,
            protocol: rule.Protocol()?,
            profiles: rule.Profiles()?,
            // empty (all programs) when the rule has none
            application: rule.ApplicationName().map(|a| a.to_string()).unwrap_or_default(),
        })
    }

    // A blocking-pool thread: join (or start) the multithreaded apartment
    // for this call, leave it again after.
    let joined = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
    let result = (|| unsafe {
        let policy: INetFwPolicy2 = CoCreateInstance(&NetFwPolicy2, None, CLSCTX_INPROC_SERVER)?;
        let rules = policy.Rules()?;
        let ours = match rules.Item(&BSTR::from(RULE_NAME)) {
            Ok(rule) => Some(view(&rule)?),
            Err(e) if e.code().0 as u32 == NOT_FOUND => None,
            Err(e) => return Err(e),
        };

        let mut blocks = Vec::new();
        let items: IEnumVARIANT = rules._NewEnum()?.cast()?;
        loop {
            let mut slot = [VARIANT::default()];
            let mut fetched = 0u32;
            items.Next(&mut slot, &mut fetched).ok()?;
            if fetched == 0 {
                break;
            }
            let item = &mut slot[0];
            let dispatch: Option<IDispatch> = if item.Anonymous.Anonymous.vt == VT_DISPATCH {
                (*item.Anonymous.Anonymous.Anonymous.pdispVal).clone()
            } else {
                None
            };
            let _ = VariantClear(item);
            let Some(rule) = dispatch.and_then(|d| d.cast::<INetFwRule>().ok()) else { continue };
            // only enabled inbound Block rules matter; one unreadable rule
            // (a broken third-party one) does not fail the whole check
            let wanted = rule.Enabled().map(|e| e.as_bool()).unwrap_or(false)
                && rule.Direction().map(|d| d == NET_FW_RULE_DIR_IN).unwrap_or(false)
                && rule.Action().map(|a| a == NET_FW_ACTION_BLOCK).unwrap_or(false);
            if wanted {
                if let Ok(v) = view(&rule) {
                    blocks.push(v);
                }
            }
        }
        Ok((ours, blocks))
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
    match read_rules() {
        Ok((rule, blocks)) => {
            let env = |name: &str| std::env::var(name).ok();
            let result = assess(rule.as_ref(), &blocks, &exe, &env);
            let detail = if result == Err("blocked-by-rule") {
                // the Block rule(s) by name, as wf.msc lists them
                let names: Vec<&str> =
                    blocks.iter().filter(|b| blocks_tablets(b, &exe, &env)).map(|b| b.name.as_str()).collect();
                Some(names.join(", "))
            } else {
                rule.as_ref().map(|r| r.application.clone())
            };
            status(result, detail)
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
            name: RULE_NAME.into(),
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
        assert_eq!(assess(Some(&installed()), &[], EXE, &env), Ok(()));
        // all profiles, any protocol: also fine
        let wide = RuleView { protocol: PROTOCOL_ANY, profiles: 0x7fff_ffff, ..installed() };
        assert_eq!(assess(Some(&wide), &[], EXE, &env), Ok(()));
    }

    #[test]
    fn a_missing_or_unusable_rule_is_not() {
        assert_eq!(assess(None, &[], EXE, &env), Err("rule-missing"));
        assert_eq!(assess(Some(&RuleView { enabled: false, ..installed() }), &[], EXE, &env), Err("rule-disabled"));
        assert_eq!(assess(Some(&RuleView { inbound: false, ..installed() }), &[], EXE, &env), Err("rule-outbound"));
        assert_eq!(assess(Some(&RuleView { allow: false, ..installed() }), &[], EXE, &env), Err("rule-blocks"));
        assert_eq!(assess(Some(&RuleView { protocol: 17, ..installed() }), &[], EXE, &env), Err("protocol"));
        // private only: the hotspot (Public) stays closed
        assert_eq!(assess(Some(&RuleView { profiles: PROFILE_PRIVATE, ..installed() }), &[], EXE, &env), Err("profiles"));
        assert_eq!(assess(Some(&RuleView { profiles: PROFILE_PUBLIC, ..installed() }), &[], EXE, &env), Err("profiles"));
    }

    #[test]
    fn the_rule_must_be_for_this_program() {
        // a dev build, or the old per-user copy
        let dev = r"D:\src\openvolley\escoresheet\frontend\src-tauri\target\release\openvolley-escoresheet.exe";
        assert_eq!(assess(Some(&installed()), &[], dev, &env), Err("other-program"));
        let old = r"C:\Users\scorer\AppData\Local\Openvolley eScoresheet\openvolley-escoresheet.exe";
        assert_eq!(assess(Some(&installed()), &[], old, &env), Err("other-program"));
        assert_eq!(assess(Some(&RuleView { application: String::new(), ..installed() }), &[], EXE, &env), Err("other-program"));
    }

    /// What Defender adds when its first-start prompt is cancelled: inbound
    /// Block rules (TCP and UDP) for the program, named after the app.
    fn defender_block(profiles: i32, protocol: i32) -> RuleView {
        RuleView {
            name: "openvolley-escoresheet.exe".into(),
            allow: false,
            protocol,
            profiles,
            application: EXE.into(),
            ..installed()
        }
    }

    #[test]
    fn a_block_rule_for_this_program_beats_the_installers_rule() {
        // Cancel at Defender's prompt on a domain network: Block on Domain +
        // Public (or Private) beats the Allow rule on the hotspot
        for profiles in [PROFILE_PUBLIC, PROFILE_PRIVATE, 1 | PROFILE_PUBLIC, 0x7fff_ffff] {
            let blocks = [defender_block(profiles, 17), defender_block(profiles, PROTOCOL_TCP)];
            assert_eq!(assess(Some(&installed()), &blocks, EXE, &env), Err("blocked-by-rule"), "profiles {profiles:#x}");
        }
        // any protocol, %ProgramFiles% path: the same
        let any = RuleView {
            application: r"%ProgramFiles%\Openvolley eScoresheet\openvolley-escoresheet.exe".into(),
            ..defender_block(PROFILE_PUBLIC, PROTOCOL_ANY)
        };
        assert_eq!(assess(Some(&installed()), &[any], EXE, &env), Err("blocked-by-rule"));
        // and it is the reason even when the installer's rule is missing too
        assert_eq!(assess(None, &[defender_block(PROFILE_PUBLIC, PROTOCOL_TCP)], EXE, &env), Err("blocked-by-rule"));
    }

    #[test]
    fn block_rules_that_do_not_shut_the_tablets_out_are_ignored() {
        let block = defender_block(PROFILE_PUBLIC, PROTOCOL_TCP);
        let harmless = [
            // Domain only: never the hotspot or the hall Wi-Fi
            RuleView { profiles: 1, ..block.clone() },
            // UDP only: the tablets use TCP
            RuleView { protocol: 17, ..block.clone() },
            // switched off
            RuleView { enabled: false, ..block.clone() },
            // outbound
            RuleView { inbound: false, ..block.clone() },
            // the old per-user copy (its rules are removed by the installer anyway)
            RuleView { application: r"C:\Users\scorer\AppData\Local\Openvolley eScoresheet\openvolley-escoresheet.exe".into(), ..block.clone() },
            // all programs: not Defender's, not ours to judge
            RuleView { application: String::new(), ..block.clone() },
            // an Allow rule for the same program (ticked at the prompt)
            RuleView { allow: true, ..block },
        ];
        assert_eq!(assess(Some(&installed()), &harmless, EXE, &env), Ok(()));
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

    /// The template's own running-app check (CheckIfAppIsRunning, right
    /// after NSIS_HOOK_PREINSTALL) closes the app for all users in perMachine
    /// mode, but the old per-user uninstaller only closes this user's copy:
    /// the hook must close it for everyone, and stop on failure, before the
    /// old copy is removed, so a Cancel never leaves the machine without one.
    #[test]
    fn the_installer_closes_the_app_for_all_users_before_removing_the_old_copy() {
        let hooks = include_str!("../windows/installer-hooks.nsh");
        let body = &hooks[hooks.find("!macro OV_REMOVE_PER_USER_INSTALL").expect("the per-user takeover macro")..];
        let body = &body[..body.find("!macroend").unwrap()];
        let ask = body.find("MessageBox MB_OKCANCEL").expect("one question");
        let kill = body.find("nsis_tauri_utils::KillProcess \"").expect("closes it for all users");
        let failed = body[kill..].find("Abort").map(|i| kill + i).expect("stops when it cannot close it");
        let uninstall = body.find("ExecWait").expect("runs the old uninstaller");
        assert!(ask < kill && kill < failed && failed < uninstall, "ask, close for all users, stop on failure, then uninstall");
        assert!(!body.contains("KillProcessCurrentUser") && !body.contains("FindProcessCurrentUser"), "all users, never only this one");
        assert_eq!(body.matches("MessageBox").count(), 1, "one question");
    }

    #[cfg(not(windows))]
    #[test]
    fn nothing_to_check_off_windows() {
        let s = tauri::async_runtime::block_on(firewall_status());
        assert!(!s.supported && !s.ready);
        assert_eq!(s.reason, Some("unsupported-os"));
    }
}
