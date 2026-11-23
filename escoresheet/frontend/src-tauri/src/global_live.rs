//! The Global tool's live page for TVs, for the desktop app's relay: the rules
//! of backend/lib/globalLive.js, ported, so a laptop WITHOUT internet drives
//! the TVs on its own Wi-Fi (GET /tv/<code>, GET /api/global/live/<code>).
//!
//! A scorer opted in with a shared tournament code sends `globalLive: <code>`
//! (and `globalLiveCourt: <token>`) with its live-state-update; relay.rs hands
//! the room owner's state to `GlobalLive::update`, which keeps a SUMMARY per
//! court, in memory only:
//!
//!   team names, short names and colours, points, sets won, the finished
//!   sets' points, the current set, best of, who serves, the match status,
//!   timeout / set interval, the hall and the scheduled time.
//!
//! Never kept: players, line-ups, substitutions, sanctions, officials, PINs,
//! signatures, remarks. Bounded like Node: MAX_CODES codes, MAX_COURTS_PER_CODE
//! courts per code (the court updated longest ago gives way), a court is
//! dropped ENDED_KEEP_MS after its match ended and IDLE_MS after its last
//! update, a code with no court left is dropped.
//!
//! The TV page and its script are the backend's files (backend/lib/tv), so
//! both relays serve the same bytes; the summary is checked against the
//! shared cases in backend/lib/tv/summary-cases.json.
//!
//! Pure: no sockets, no locks; the caller passes `now` (ms since the epoch).
//! No cloud forwarding here: the app's webview pushes its court to the cloud
//! itself when online (frontend utils/globalLivePush.js).

use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::HashMap;

pub const MAX_CODES: usize = 1000;
pub const MAX_COURTS_PER_CODE: usize = 24;
pub const IDLE_MS: u64 = 3 * 60 * 60 * 1000;
pub const ENDED_KEEP_MS: u64 = 45 * 60 * 1000;

/// The page for any screen, smart TVs included (placeholder `{{CODE}}`).
pub const TV_HTML: &str = include_str!("../../../backend/lib/tv/tv.html");
/// Its script (ES5, same-origin polling of /api/global/live/<code>).
pub const TV_JS: &str = include_str!("../../../backend/lib/tv/tv.js");
/// /tv without a code: a GET form to /tv/go, no script (backend/lib/tv/entry.html).
pub const TV_ENTRY_HTML: &str = include_str!("../../../backend/lib/tv/entry.html");

/// The code entry page; `wrong`: the last code typed was not a code (backend tvEntryHtml).
pub fn tv_entry_html(wrong: bool) -> String {
    TV_ENTRY_HTML.replacen(
        "{{ERROR}}",
        if wrong { "<div class=\"err\">ABCD 2345 &middot; 8 letters and digits &middot; 8 Buchstaben und Ziffern &middot; 8 lettres et chiffres &middot; 8 lettere e cifre</div>" } else { "" },
        1,
    )
}

const LIVE_CODE_ALPHABET: &str = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/// A tournament code as the app makes it (frontend utils/globalLive.js).
pub fn is_live_code(code: &str) -> bool {
    code.len() == 8 && code.chars().all(|c| LIVE_CODE_ALPHABET.contains(c))
}

/// A court token: a hex hash of a match's own secret key.
pub fn is_court_token(t: &str) -> bool {
    t.len() == 32 && t.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A court token for a relay room that sent none (an older scorer app): a hash of the room key.
pub fn court_token_of(room_key: &str) -> String {
    let d = Sha256::digest(format!("room\0{room_key}").as_bytes());
    hex(&d)[..32].to_string()
}

/// A court's id on the page: a short hash of the code and the court token,
/// keyed with `key` (random per app start, `GlobalLive::new`), as the Node
/// relay keys its own (globalLive.js courtIdOf). Unkeyed, the id on the TV
/// page let anyone on the Wi-Fi who knows the code and the match's public id
/// test every game PIN offline against a court token made from it (2611
/// review, SR-3: the token comes from the game PIN now).
fn court_id_of(key: &[u8; 32], code: &str, token: &str) -> String {
    let mut h = Sha256::new();
    h.update(b"ov-tv-court-id:v1\0");
    h.update(key);
    h.update(format!("\0{code}\0{token}").as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(h.finalize())[..10].to_string()
}

/// 32 random bytes from the OS (the court ids' key).
fn random_key() -> [u8; 32] {
    use rand::TryRng; // rand 0.10: was TryRngCore (try_fill_bytes)
    let mut key = [0u8; 32];
    rand::rngs::SysRng.try_fill_bytes(&mut key).expect("the OS random source");
    key
}

/// Now as an ISO time (the updatedAt of a summary made outside the store).
pub fn iso_now() -> String {
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    iso_of_ms(ms)
}

/// A court number a scorer device set for its screen (1-99), from a number or
/// a digit string (backend screenNumber), else None.
pub fn screen_number(v: Option<&Value>) -> Option<u64> {
    let n = match v? {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => s.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    (n.fract() == 0.0 && (1.0..=99.0).contains(&n)).then_some(n as u64)
}

/// The court number for /tv/<code>/<n>: the one the scorer device set, else
/// the number at the end of the match's court (OpenBeach: "Court 3" -> 3).
pub fn screen_of(explicit: Option<&Value>, entry: &Value) -> Option<u64> {
    if let Some(n) = screen_number(explicit) {
        return Some(n);
    }
    match entry.get("match").and_then(|m| m.get("court")) {
        Some(Value::String(c)) => {
            let t = c.trim_end();
            let digits: String = t.chars().rev().take_while(|c| c.is_ascii_digit()).collect::<Vec<_>>().into_iter().rev().collect();
            if digits.is_empty() || digits.len() > 2 { None } else { screen_number(Some(&Value::String(digits))) }
        }
        Some(v @ Value::Number(_)) => screen_number(Some(v)),
        _ => None,
    }
}

/// The TV page for a live screen code, one court of it, or one league game
/// (backend tvPageHtml): only A-Z and 0-9 go into the page.
pub fn tv_page_html_for(code: &str, screen: Option<u64>, game: Option<&str>) -> String {
    let clean = |v: &str| -> String { v.chars().filter(|c| c.is_ascii_uppercase() || c.is_ascii_digit()).collect() };
    let (code, src, label) = match game {
        Some(g) => {
            let g = clean(g);
            (String::new(), format!("/api/global/live/game/{g}"), format!("#{g}"))
        }
        None => {
            let c = clean(code);
            let screen = screen.filter(|n| (1..=99).contains(n));
            let src = match screen { Some(n) => format!("/api/global/live/{c}?screen={n}"), None => format!("/api/global/live/{c}") };
            let head: String = c.chars().take(4).collect();
            let tail: String = c.chars().skip(4).collect();
            let label = match screen { Some(n) => format!("{head} {tail} \u{00b7} {n}"), None => format!("{head} {tail}") };
            (c, src, label)
        }
    };
    TV_HTML.replacen("{{CODE}}", &code, 1).replacen("{{SRC}}", &src, 1).replacen("{{LABEL}}", &label, 1)
}

/// The TV page for a code: only A-Z and 0-9 of it go into the page.
pub fn tv_page_html(code: &str) -> String {
    tv_page_html_for(code, None, None)
}

/// The code of a /tv/<code> address as Node reads it: upper case, without
/// whitespace and dashes.
pub fn tv_code_of(raw: &str) -> String {
    raw.to_uppercase().chars().filter(|&c| !is_js_space(c) && c != '-').collect()
}

// ---------------------------------------------------------------------------
// JavaScript value rules (String.prototype.trim, Number(), String()) so odd
// input gives what the Node relay gives
// ---------------------------------------------------------------------------

/// JS WhiteSpace + LineTerminator (what `trim()` and `\s` remove).
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
            | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// The first `max` UTF-16 units of `s` (String.prototype.slice); a character
/// that would be cut in half is left out.
fn slice_utf16(s: &str, max: usize) -> String {
    let mut n = 0;
    let mut out = String::new();
    for c in s.chars() {
        n += c.len_utf16();
        if n > max {
            break;
        }
        out.push(c);
    }
    out
}

/// globalLive.js `str`: a trimmed, non-empty string, cut to `max`.
fn text(v: Option<&Value>, max: usize) -> Option<String> {
    let t = v?.as_str()?.trim_matches(is_js_space);
    (!t.is_empty()).then(|| slice_utf16(t, max))
}

/// Number(text) for a string.
fn js_number_of_str(s: &str) -> f64 {
    let t = s.trim_matches(is_js_space);
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let b = t.as_bytes();
    if b.len() > 2 && b[0] == b'0' {
        let radix = match b[1] {
            b'x' | b'X' => 16,
            b'o' | b'O' => 8,
            b'b' | b'B' => 2,
            _ => 0,
        };
        if radix != 0 {
            let mut n = 0f64;
            for c in t[2..].chars() {
                match c.to_digit(radix) {
                    Some(d) => n = n * radix as f64 + d as f64,
                    None => return f64::NAN,
                }
            }
            return n;
        }
    }
    // StrDecimalLiteral: [+-] (digits [. digits] | . digits) [e [+-] digits]
    let body = t.strip_prefix(['+', '-']).unwrap_or(t);
    let (mantissa, exp) = match body.find(['e', 'E']) {
        Some(i) => (&body[..i], Some(&body[i + 1..])),
        None => (body, None),
    };
    let (int_part, frac) = match mantissa.find('.') {
        Some(i) => (&mantissa[..i], Some(&mantissa[i + 1..])),
        None => (mantissa, None),
    };
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    let ok_mantissa = digits(int_part)
        && frac.map_or(true, digits)
        && (!int_part.is_empty() || frac.map_or(false, |f| !f.is_empty()));
    let ok_exp = exp.map_or(true, |e| {
        let e = e.strip_prefix(['+', '-']).unwrap_or(e);
        !e.is_empty() && digits(e)
    });
    if !ok_mantissa || !ok_exp {
        return f64::NAN;
    }
    // Rust's parser wants a digit on both sides of the point
    let int_s = if int_part.is_empty() { "0" } else { int_part };
    let frac_s = frac.filter(|f| !f.is_empty()).unwrap_or("0");
    let sign = if t.starts_with('-') { "-" } else { "" };
    let exp_s = exp.map(|e| format!("e{e}")).unwrap_or_default();
    format!("{sign}{int_s}.{frac_s}{exp_s}").parse().unwrap_or(f64::NAN)
}

/// String(n) for a number (Number.prototype.toString()).
fn js_number_text(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if n == 0.0 {
        return "0".into();
    }
    let a = n.abs();
    if (1e-6..1e21).contains(&a) {
        if n.fract() == 0.0 {
            return format!("{}", n as i128);
        }
        return format!("{n}");
    }
    // exponent form: 1e-7, 1.5e+22
    let s = format!("{n:e}");
    match s.split_once('e') {
        Some((m, e)) if !e.starts_with('-') => format!("{m}e+{e}"),
        _ => s,
    }
}

/// String(v) for a JSON value (null as an array element is "").
fn js_text(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number_text(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .map(|x| if x.is_null() { String::new() } else { js_text(x) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// Number(v) for a JSON value.
fn js_number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => js_number_of_str(s),
        Value::Array(_) => js_number_of_str(&js_text(v)),
        Value::Object(_) => f64::NAN,
    }
}

/// globalLive.js `int`: 0..=999, 0 for anything that is not a number.
fn int(v: Option<&Value>) -> i64 {
    let Some(v) = v else { return 0 };
    if v.is_null() || v.as_str() == Some("") {
        return 0;
    }
    let n = js_number(v);
    if !n.is_finite() {
        return 0;
    }
    n.trunc().clamp(0.0, 999.0) as i64
}

/// globalLive.js `color`: a #hex colour, else null.
fn color(v: Option<&Value>) -> Option<String> {
    let t = v?.as_str()?.trim_matches(is_js_space);
    let hex = t.strip_prefix('#')?;
    ((3..=8).contains(&hex.len()) && hex.bytes().all(|b| b.is_ascii_hexdigit())).then(|| t.to_string())
}

/// JS truthiness of a JSON value.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map_or(false, |f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// String.prototype.localeCompare, near enough for times and hall names:
/// case-insensitive first, then lower case before upper case.
fn locale_cmp(a: &str, b: &str) -> Ordering {
    a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| b.cmp(a))
}

/// One court's summary from the scorer's live state and the room's synced
/// bundle (`{ match, homeTeam, awayTeam, sets, ... }`). Home and away as on
/// the scoresheet: the live state counts team A / B (the coin toss), so A is
/// mapped back. globalLive.js `courtSummary`.
pub fn court_summary(live: &Value, entry: &Value, now_iso: &str) -> Value {
    let ls = |k: &str| live.get(k);
    let m = |k: &str| entry.get("match").and_then(|m| m.get(k));
    let home_name = text(entry.get("homeTeam").and_then(|t| t.get("name")), 80);
    let away_name = text(entry.get("awayTeam").and_then(|t| t.get("name")), 80);
    let a_name = text(ls("team_a_name"), 80);
    // A is home unless the names say otherwise, or the coin toss gave A to away
    let names_say_away = matches!((&a_name, &away_name), (Some(a), Some(w)) if a == w && Some(a) != home_name.as_ref());
    let a_is_home = if names_say_away {
        false
    } else if truthy(m("coinTossTeamA")) {
        // (indoor says home/away, OpenBeach team1/team2)
        !matches!(m("coinTossTeamA").and_then(|v| v.as_str()), Some("away") | Some("team2"))
    } else {
        true
    };
    let side = |a: Value, b: Value| if a_is_home { (a, b) } else { (b, a) };
    let team = |p: &str| {
        json!({
            "name": text(ls(&format!("team_{p}_name")), 80),
            "short": text(ls(&format!("team_{p}_short")), 12),
            "color": color(ls(&format!("team_{p}_color"))),
        })
    };
    let (mut home, mut away) = side(team("a"), team("b"));
    if let Some(n) = home_name {
        home["name"] = json!(n);
    }
    if let Some(n) = away_name {
        away["name"] = json!(n);
    }
    let pair = |a: &str, b: &str| {
        let (h, w) = side(json!(int(ls(a))), json!(int(ls(b))));
        json!({ "home": h, "away": w })
    };
    // serving_team is a side (left/right); side_a says where team A stands
    fn lr(v: Option<&Value>) -> Option<&str> {
        v.and_then(|v| v.as_str()).filter(|s| *s == "left" || *s == "right")
    }
    let serving = match (lr(ls("serving_team")), lr(ls("side_a"))) {
        (Some(s), Some(a)) => json!(if (s == a) == a_is_home { "home" } else { "away" }),
        _ => Value::Null,
    };
    // The finished sets, home/away as the scoresheet keeps them
    let mut sets: Vec<&Value> = entry
        .get("sets")
        .and_then(|s| s.as_array())
        .map(|a| a.iter().filter(|s| s.get("finished") == Some(&Value::Bool(true))).collect())
        .unwrap_or_default();
    sets.sort_by_key(|s| int(s.get("index")));
    let sets: Vec<Value> = sets
        .into_iter()
        .take(5)
        .map(|s| json!({ "home": int(s.get("homePoints")), "away": int(s.get("awayPoints")) }))
        .collect();
    let status = text(ls("match_status"), 20);
    let ended = matches!(status.as_deref(), Some("final" | "ended" | "approved"));
    let best_of = if int(ls("best_of")) == 3 { 3 } else { 5 };
    // a best-of-3 decider is stored as set 5 (frontend domain/describe.js): it is set 3
    let current_set = match int(ls("current_set")) {
        5 if best_of == 3 => 3,
        n => n,
    };
    let game_n = m("gameN").filter(|v| !v.is_null()).map(|v| Value::String(js_text(v)));
    // the hall or venue, and the court when there is one (OpenBeach: the
    // same venue on every court, the court number tells them apart)
    let hall_parts: Vec<String> = [text(m("hall"), 80).or_else(|| text(m("venue"), 80)), text(m("court"), 80)]
        .into_iter()
        .flatten()
        .collect();
    let hall_label = if hall_parts.is_empty() { None } else { Some(hall_parts.join(" \u{00b7} ")) };
    json!({
        "home": home,
        "away": away,
        "setsWon": pair("sets_won_a", "sets_won_b"),
        "points": pair("points_a", "points_b"),
        "sets": sets,
        "currentSet": if current_set == 0 { Value::Null } else { json!(current_set) },
        "bestOf": best_of,
        "serving": serving,
        "status": status,
        "ended": ended,
        "timeout": ls("timeout_active") == Some(&Value::Bool(true)),
        "interval": ls("set_interval_active") == Some(&Value::Bool(true)),
        "hall": hall_label,
        "scheduledAt": text(m("scheduledAt"), 40),
        "gameNumber": text(game_n.as_ref(), 20),
        "updatedAt": now_iso,
    })
}

/// ms since the epoch as Date.prototype.toISOString does.
pub fn iso_of_ms(ms: u64) -> String {
    let secs = ms / 1000;
    let (days, rem) = (secs / 86_400, secs % 86_400);
    // Civil-from-days (Howard Hinnant), valid for the Unix era.
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if mo <= 2 { 1 } else { 0 };
    format!("{y:04}-{mo:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3600, (rem % 3600) / 60, rem % 60, ms % 1000)
}

struct Court {
    id: String,
    summary: Value,
    at: u64,
    /// when its match was first seen ended (0 counts as never, like JS)
    ended_at: Option<u64>,
}

/// The courts per code, in memory (globalLive.js `createGlobalLive`).
pub struct GlobalLive {
    /// code -> its courts, in the order they first came (a JS Map's order)
    codes: HashMap<String, Vec<Court>>,
    /// relay room (match key) -> (code, court id) of its court: one court per room
    rooms: HashMap<String, (String, String)>,
    max_codes: usize,
    max_courts_per_code: usize,
    idle_ms: u64,
    ended_keep_ms: u64,
    /// the court ids' key (court_id_of), random per app start
    id_key: [u8; 32],
}

impl Default for GlobalLive {
    fn default() -> Self {
        Self::new(MAX_CODES, MAX_COURTS_PER_CODE, IDLE_MS, ENDED_KEEP_MS)
    }
}

impl GlobalLive {
    pub fn new(max_codes: usize, max_courts_per_code: usize, idle_ms: u64, ended_keep_ms: u64) -> Self {
        Self { codes: HashMap::new(), rooms: HashMap::new(), max_codes, max_courts_per_code, idle_ms, ended_keep_ms, id_key: random_key() }
    }

    /// A court's id as this store names it on the page (court_id_of).
    pub fn court_id(&self, code: &str, token: &str) -> String {
        court_id_of(&self.id_key, code, token)
    }

    /// `update`, bound to the relay room (the match key) the state comes
    /// from: one court per room and code. A room whose court token changes
    /// (another scoring device of a build that made its token per device, a
    /// restore, an older app's room token and then the match's own) moves
    /// its court instead of leaving a second, frozen one on every TV until
    /// IDLE_MS (2611 review, SR-3; LOG-11's symptom).
    pub fn update_room(&mut self, code: &str, room: &str, token: &str, live: &Value, entry: &Value, now: u64, screen: Option<u64>) -> bool {
        let id = self.court_id(code, token);
        if let Some((was_code, was_id)) = self.rooms.get(room).cloned() {
            if was_code == code && was_id != id {
                if let Some(courts) = self.codes.get_mut(code) {
                    courts.retain(|c| c.id != was_id);
                }
            }
        }
        let ok = self.update(code, token, live, entry, now, screen);
        if ok && !room.is_empty() {
            if self.rooms.len() >= self.max_codes.saturating_mul(self.max_courts_per_code).max(1) {
                // the rooms whose court is gone first, then any
                let codes = &self.codes;
                self.rooms.retain(|_, (c, i)| codes.get(c.as_str()).is_some_and(|v| v.iter().any(|x| &x.id == i)));
                if self.rooms.len() >= self.max_codes.saturating_mul(self.max_courts_per_code).max(1) {
                    self.rooms.clear();
                }
            }
            self.rooms.insert(room.to_string(), (code.to_string(), id));
        }
        ok
    }

    pub fn sweep(&mut self, now: u64) {
        let (idle, keep) = (self.idle_ms, self.ended_keep_ms);
        self.codes.retain(|_, courts| {
            courts.retain(|c| {
                let ended_out = c.ended_at.map_or(false, |e| e != 0 && now.saturating_sub(e) > keep);
                !(now.saturating_sub(c.at) > idle || ended_out)
            });
            !courts.is_empty()
        });
    }

    /// The scorer's live state for one room. False: not taken (bad code,
    /// store full). The caller has checked that the sender owns the room.
    /// `screen`: the court number the scorer device set (1-99) for /tv/<code>/<n>.
    pub fn update(&mut self, code: &str, room_key: &str, live: &Value, entry: &Value, now: u64, screen: Option<u64>) -> bool {
        if !is_live_code(code) || room_key.is_empty() || !live.is_object() {
            return false;
        }
        self.sweep(now);
        if !self.codes.contains_key(code) {
            if self.codes.len() >= self.max_codes {
                return false;
            }
            self.codes.insert(code.to_string(), Vec::new());
        }
        let max_courts = self.max_courts_per_code;
        let courts = self.codes.get_mut(code).expect("just inserted");
        let id = court_id_of(&self.id_key, code, room_key);
        let mut summary = court_summary(live, entry, &iso_of_ms(now));
        summary["id"] = json!(id);
        summary["screen"] = json!(screen);
        let ended = summary["ended"] == Value::Bool(true);
        let prev = courts.iter().position(|c| c.id == id);
        if prev.is_none() && courts.len() >= max_courts {
            // the court updated longest ago gives way
            let mut oldest: Option<usize> = None;
            for (i, c) in courts.iter().enumerate() {
                if oldest.map_or(true, |o| c.at < courts[o].at) {
                    oldest = Some(i);
                }
            }
            if let Some(o) = oldest {
                courts.remove(o);
            }
        }
        let ended_at = |prev: Option<&Court>| {
            if !ended {
                return None;
            }
            Some(prev.and_then(|p| p.ended_at).filter(|&e| e != 0).unwrap_or(now))
        };
        match prev {
            Some(i) => {
                let e = ended_at(Some(&courts[i]));
                courts[i] = Court { id, summary, at: now, ended_at: e };
            }
            None => courts.push(Court { id, summary, at: now, ended_at: ended_at(None) }),
        }
        true
    }

    /// The page's data for a code, or None when nothing is live under it.
    /// The page's data for a code (only court `screen` when given).
    pub fn get(&mut self, code: &str, now: u64, screen: Option<u64>) -> Option<Value> {
        if !is_live_code(code) {
            return None;
        }
        self.sweep(now);
        let courts = self.codes.get(code).filter(|c| !c.is_empty())?;
        let mut list: Vec<&Value> = courts.iter().map(|c| &c.summary).filter(|c| screen.map_or(true, |n| c["screen"] == json!(n))).collect();
        let s = |v: &Value, k: &str| v[k].as_str().unwrap_or("").to_string();
        // running matches first, then by the scheduled time, then by hall
        list.sort_by(|a, b| {
            let ended = |v: &Value| v["ended"] == Value::Bool(true);
            ended(a)
                .cmp(&ended(b))
                .then_with(|| locale_cmp(&s(a, "scheduledAt"), &s(b, "scheduledAt")))
                .then_with(|| locale_cmp(&s(a, "hall"), &s(b, "hall")))
        });
        let updated_at = list.iter().map(|c| s(c, "updatedAt")).fold(String::new(), |m, u| if u > m { u } else { m });
        Some(json!({ "code": code, "updatedAt": updated_at, "courts": list }))
    }

    #[cfg(test)]
    pub fn size(&self) -> usize {
        self.codes.len()
    }
}

/// `{ data: { code, updatedAt, courts }, error: null }` for GET /api/global/live/<code>
/// (an empty page while nothing is live: the TV waits for the first rally).
pub fn page_body(store: &mut GlobalLive, code: &str, now: u64, screen: Option<u64>) -> Value {
    let data = store.get(code, now, screen).unwrap_or_else(|| json!({ "code": code, "updatedAt": null, "courts": [] }));
    json!({ "data": data, "error": null })
}

#[cfg(test)]
mod tests {
    use super::*;

    const CODE: &str = "ABCD2345";

    fn live(over: Value) -> Value {
        let mut v = json!({
            "team_a_name": "Bergtal IS", "team_a_short": "BIS", "team_a_color": "#1d4ed8",
            "team_b_name": "Seeblick IS", "team_b_short": "SIS", "team_b_color": "#dc2626",
            "sets_won_a": 1, "sets_won_b": 0, "points_a": 12, "points_b": 9,
            "current_set": 2, "best_of": 5, "side_a": "left", "serving_team": "left",
            "match_status": "live", "timeout_active": false, "set_interval_active": false,
            "lineup_a": { "I": 7 },
        });
        for (k, x) in over.as_object().unwrap() {
            v[k] = x.clone();
        }
        v
    }

    fn entry(over: Value) -> Value {
        let mut v = json!({
            "match": { "coinTossTeamA": "home", "hall": "Hall 1", "scheduledAt": "2027-11-05T09:00:00Z", "gameN": 3, "refereePin": "123456" },
            "homeTeam": { "name": "Bergtal IS" }, "awayTeam": { "name": "Seeblick IS" },
            "homePlayers": [{ "firstName": "Anna", "lastName": "Muster", "dob": "2009-01-01" }],
            "sets": [{ "index": 1, "homePoints": 25, "awayPoints": 20, "finished": true }, { "index": 2, "homePoints": 12, "awayPoints": 9, "finished": false }],
        });
        for (k, x) in over.as_object().unwrap() {
            v[k] = x.clone();
        }
        v
    }

    #[test]
    fn screen_of_takes_the_device_number_else_the_match_court() {
        assert_eq!(screen_of(Some(&json!(2)), &json!({ "match": { "court": "Court 5" } })), Some(2));
        assert_eq!(screen_of(None, &json!({ "match": { "court": "Court 5" } })), Some(5));
        assert_eq!(screen_of(None, &json!({ "match": { "court": "Terrain 12" } })), Some(12));
        assert_eq!(screen_of(None, &json!({ "match": { "court": 3 } })), Some(3));
        assert_eq!(screen_of(None, &json!({ "match": { "court": "Centre Court" } })), None);
        assert_eq!(screen_of(None, &json!({})), None);
    }

    #[test]
    fn one_court_by_its_screen_number_and_the_page_variants() {
        let mut store = GlobalLive::new(10, 10, IDLE_MS, ENDED_KEEP_MS);
        store.update(CODE, "r1", &live(json!({ "points_a": 1 })), &entry(json!({})), 1, Some(1));
        store.update(CODE, "r2", &live(json!({ "points_a": 2 })), &entry(json!({})), 1, Some(2));
        assert_eq!(store.get(CODE, 1, None).unwrap()["courts"].as_array().unwrap().len(), 2);
        let only = store.get(CODE, 1, Some(2)).unwrap();
        assert_eq!(only["courts"].as_array().unwrap().len(), 1);
        assert_eq!(only["courts"][0]["points"]["home"], json!(2));
        assert_eq!(screen_number(Some(&json!("7"))), Some(7));
        for bad in [json!(0), json!(100), json!(1.5), json!("x"), Value::Null] {
            assert_eq!(screen_number(Some(&bad)), None);
        }
        let h = tv_page_html_for("ABCD2345", Some(2), None);
        assert!(h.contains("data-src=\"/api/global/live/ABCD2345?screen=2\" data-label=\"ABCD 2345 \u{00b7} 2\""));
        let g = tv_page_html_for("", None, Some("4242"));
        assert!(g.contains("data-src=\"/api/global/live/game/4242\" data-label=\"#4242\""));
        assert!(!tv_page_html("ABCD2345").contains("{{"));
    }

    #[test]
    fn the_shared_summary_cases_of_the_node_relay() {
        let cases: Value = serde_json::from_str(include_str!("../../../backend/lib/tv/summary-cases.json")).unwrap();
        let cases = cases.as_array().unwrap();
        assert!(!cases.is_empty());
        for c in cases {
            let mut s = court_summary(&c["liveState"], &c["entry"], "T");
            s.as_object_mut().unwrap().remove("updatedAt");
            assert_eq!(s, c["expected"], "{}", c["name"]);
        }
    }

    #[test]
    fn codes_are_8_characters_from_the_alphabet_without_look_alikes() {
        assert!(is_live_code(CODE));
        for bad in ["abcd2345", "ABCD234", "ABCD23450", "ABCD234O", "ABCD2341", "../../x", "", "ABCD234É"] {
            assert!(!is_live_code(bad), "{bad}");
        }
        assert!(is_court_token(&"a".repeat(32)));
        assert!(is_court_token(&court_token_of("room-1")));
        for bad in ["A".repeat(32), "a".repeat(31), "g".repeat(32)] {
            assert!(!is_court_token(&bad), "{bad}");
        }
        assert_eq!(tv_code_of("tvpg-2345"), "TVPG2345");
        assert_eq!(tv_code_of("ab cd\t2345"), "ABCD2345");
    }

    #[test]
    fn hashes_are_the_node_relay_s() {
        // what globalLive.js courtTokenOf('r1') prints
        assert_eq!(court_token_of("r1"), "d38309fa8aa4d1dbb4e2d075db4d8960");
        // court ids: keyed per store (as the Node relay's idKey), per code
        let (a, b) = (GlobalLive::default(), GlobalLive::default());
        assert_eq!(a.court_id(CODE, "r1"), a.court_id(CODE, "r1"));
        assert_eq!(a.court_id(CODE, "r1").len(), 10);
        assert_ne!(a.court_id(CODE, "r1"), a.court_id("ZZZZ2345", "r1"));
        assert_ne!(a.court_id(CODE, "r1"), b.court_id(CODE, "r1"), "another app start, another key");
    }

    #[test]
    fn a_court_id_does_not_test_a_token_without_the_store_s_key() {
        // 2611 review, SR-3: the unkeyed SHA-256(code, token)[..10] the page
        // showed let a Wi-Fi guest test game PINs offline against the token
        let store = GlobalLive::default();
        let unkeyed = {
            let d = Sha256::digest(format!("{CODE}\0r1").as_bytes());
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(d)[..10].to_string()
        };
        assert_ne!(store.court_id(CODE, "r1"), unkeyed);
        assert_ne!(store.court_id(CODE, "r1"), "VbTkCNMYRe");
    }

    #[test]
    fn one_court_per_room_when_its_token_changes() {
        let mut store = GlobalLive::default();
        let a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        assert!(store.update_room(CODE, "match_1_x", a, &live(json!({ "points_a": 3 })), &entry(json!({})), 1, None));
        assert!(store.update_room(CODE, "match_2_y", b, &live(json!({ "points_a": 9 })), &entry(json!({})), 1, None));
        // the second tablet of match 1 (another token): its court moves, no frozen one stays
        let c = "cccccccccccccccccccccccccccccccc";
        assert!(store.update_room(CODE, "match_1_x", c, &live(json!({ "points_a": 4 })), &entry(json!({})), 2, None));
        let page = store.get(CODE, 3, None).unwrap();
        let courts = page["courts"].as_array().unwrap();
        assert_eq!(courts.len(), 2, "one court per match");
        let ids: Vec<&str> = courts.iter().map(|x| x["id"].as_str().unwrap()).collect();
        assert!(ids.contains(&store.court_id(CODE, c).as_str()));
        assert!(!ids.contains(&store.court_id(CODE, a).as_str()));
        assert!(ids.contains(&store.court_id(CODE, b).as_str()), "the other match keeps its court");
    }

    #[test]
    fn javascript_number_and_string_rules() {
        assert_eq!(int(Some(&json!("12"))), 12);
        assert_eq!(int(Some(&json!(" 7 "))), 7);
        assert_eq!(int(Some(&json!("0x10"))), 16);
        assert_eq!(int(Some(&json!("1e2"))), 100);
        assert_eq!(int(Some(&json!(".5e1"))), 5);
        assert_eq!(int(Some(&json!("x"))), 0);
        assert_eq!(int(Some(&json!("inf"))), 0);
        assert_eq!(int(Some(&json!("Infinity"))), 0);
        assert_eq!(int(Some(&json!(true))), 1);
        assert_eq!(int(Some(&json!([4]))), 4);
        assert_eq!(int(Some(&json!([1, 2]))), 0);
        assert_eq!(int(Some(&json!(-3))), 0);
        assert_eq!(int(Some(&json!(5000))), 999);
        assert_eq!(int(Some(&json!(12.9))), 12);
        assert_eq!(js_number_text(3.0), "3");
        assert_eq!(js_number_text(3.5), "3.5");
        assert_eq!(js_number_text(1e21), "1e+21");
        assert_eq!(js_number_text(1e-7), "1e-7");
        assert_eq!(text(Some(&json!("  Hall 1 \u{feff}")), 80).as_deref(), Some("Hall 1"));
        assert_eq!(text(Some(&json!("abcdef")), 3).as_deref(), Some("abc"));
        assert_eq!(text(Some(&json!("   ")), 80), None);
        assert_eq!(color(Some(&json!(" #ABC "))).as_deref(), Some("#ABC"));
        assert_eq!(color(Some(&json!("red;background:url(x)"))), None);
        let s = court_summary(&live(json!({ "match_status": { "a": 1 }, "best_of": 7, "points_a": "x" })), &json!({}), "T");
        assert_eq!(s["status"], Value::Null);
        assert_eq!(s["bestOf"], 5);
        assert_eq!(s["points"]["home"], 0);
        // gameN as String() makes it
        let s = court_summary(&live(json!({})), &entry(json!({ "match": { "gameN": 12 } })), "T");
        assert_eq!(s["gameNumber"], "12");
    }

    #[test]
    fn lists_the_courts_of_a_code_nothing_for_another_code() {
        let mut store = GlobalLive::default();
        assert!(store.update(CODE, "room-1", &live(json!({})), &entry(json!({})), 1000, None));
        assert!(store.update(CODE, "room-2", &live(json!({ "match_status": "final" })), &entry(json!({ "match": { "hall": "Hall 2" } })), 1000, None));
        let page = store.get(CODE, 1000, None).unwrap();
        assert_eq!(page["courts"].as_array().unwrap().len(), 2);
        assert_eq!(page["courts"][0]["ended"], false); // running first
        let text = page.to_string();
        for leak in ["room-", "Anna", "Muster", "123456", "lineup"] {
            assert!(!text.contains(leak), "{leak}");
        }
        assert_eq!(page["updatedAt"], "1970-01-01T00:00:01.000Z");
        assert!(store.get("ZZZZ2345", 1000, None).is_none());
        assert!(store.get("bad", 1000, None).is_none());
        assert!(!store.update("bad", "room-1", &live(json!({})), &entry(json!({})), 1000, None));
        assert!(!store.update(CODE, "", &live(json!({})), &entry(json!({})), 1000, None));
        assert!(!store.update(CODE, "room-1", &json!("x"), &entry(json!({})), 1000, None));
        assert_eq!(page_body(&mut store, "ZZZZ2345", 1000, None), json!({ "data": { "code": "ZZZZ2345", "updatedAt": null, "courts": [] }, "error": null }));
    }

    #[test]
    fn one_court_per_room_a_new_state_replaces_the_old_one() {
        let mut store = GlobalLive::default();
        store.update(CODE, "room-1", &live(json!({ "points_a": 1 })), &entry(json!({})), 1, None);
        store.update(CODE, "room-1", &live(json!({ "points_a": 2 })), &entry(json!({})), 2, None);
        let page = store.get(CODE, 2, None).unwrap();
        assert_eq!(page["courts"].as_array().unwrap().len(), 1);
        assert_eq!(page["courts"][0]["points"]["home"], 2);
    }

    #[test]
    fn drops_ended_courts_after_ended_keep_and_idle_ones_after_idle() {
        let mut t = 1_000_000;
        let mut store = GlobalLive::new(MAX_CODES, MAX_COURTS_PER_CODE, 10_000, 1_000);
        store.update(CODE, "done", &live(json!({ "match_status": "final" })), &entry(json!({})), t, None);
        store.update(CODE, "running", &live(json!({})), &entry(json!({})), t, None);
        t += 2_000;
        let ended: Vec<Value> = store.get(CODE, t, None).unwrap()["courts"].as_array().unwrap().iter().map(|c| c["ended"].clone()).collect();
        assert_eq!(ended, vec![json!(false)]);
        t += 20_000;
        assert!(store.get(CODE, t, None).is_none());
        assert_eq!(store.size(), 0);
    }

    #[test]
    fn an_ended_court_keeps_its_first_ended_time() {
        let mut store = GlobalLive::new(MAX_CODES, MAX_COURTS_PER_CODE, 1_000_000, 1_000);
        let fin = live(json!({ "match_status": "final" }));
        store.update(CODE, "done", &fin, &entry(json!({})), 10_000, None);
        store.update(CODE, "done", &fin, &entry(json!({})), 10_900, None); // still ended: the clock does not restart
        assert!(store.get(CODE, 10_999, None).is_some());
        assert!(store.get(CODE, 11_001, None).is_none());
    }

    #[test]
    fn is_bounded_codes_and_courts_per_code() {
        let mut t = 0;
        let mut tick = || {
            t += 1;
            t
        };
        let mut store = GlobalLive::new(2, 2, IDLE_MS, ENDED_KEEP_MS);
        let (l, e) = (live(json!({})), entry(json!({})));
        assert!(store.update("AAAA2345", "r", &l, &e, tick(), None));
        assert!(store.update("BBBB2345", "r", &l, &e, tick(), None));
        assert!(!store.update("CCCC2345", "r", &l, &e, tick(), None));
        store.update("AAAA2345", "r2", &l, &e, tick(), None);
        store.update("AAAA2345", "r3", &l, &e, tick(), None);
        let n = tick();
        let page = store.get("AAAA2345", n, None).unwrap();
        let ids: Vec<&str> = page["courts"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap()).collect();
        // the court updated longest ago ("r") gave way
        assert_eq!(ids.len(), 2);
        assert!(!ids.contains(&store.court_id("AAAA2345", "r").as_str()));
    }

    #[test]
    fn the_tv_page_names_its_code_and_loads_only_its_script() {
        assert_eq!(TV_HTML.matches("{{CODE}}").count(), 1);
        let html = tv_page_html("ABCD2345");
        assert!(html.contains("data-code=\"ABCD2345\""));
        assert!(html.contains("<script src=\"/tv/tv.js\"></script>"));
        assert!(!tv_page_html("AB\"><x").contains("\"><x"));
        assert!(TV_JS.contains("/api/global/live/"));
    }
}
