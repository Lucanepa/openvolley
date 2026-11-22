//! Scoreboard codes (docs/scoreboard-code-spec.md): the Rust port of
//! `electron/displayCodeCore.cjs`. A short read-only code the scorer shows, by
//! which any scoreboard finds the match on the relay and follows its public
//! live state. Same codes, limits, lifetimes, messages and HTTP answers; the
//! shared vectors in `electron/__fixtures__/display-code-vectors.json` run
//! against both (the test module below).
//!
//!   set(room, code, issuedAt, owner) -> Ok(endsAt) | Err(reason)
//!   set(room, null)                  -> revoke (Err("revoked"))
//!   resolve(code, ipKey)             -> Ok(Resolved { room, endsAt, hash }) | Err(Refusal { reason, retryAfter? })
//!   drop_room(room)                  the relay dropped the room
//!   http(endpoint, ...)              POST /api/display/lookup | live
//!
//! The JS core calls `onEnd(room, hash, reason)` for every code that ends;
//! here every call queues them and the relay takes them with `take_ended()`
//! (it ends the boards that followed by the code).
//!
//! Only sha256("d:" + CODE) is kept, in memory. Nothing is logged but
//! `display.<event> ref=<8 hex of the hash> via=lan`: never a code. The
//! relay (relay.rs) checks the scorer socket owns the room and reads bodies.

use std::collections::{BTreeMap, HashMap};
use std::net::IpAddr;

use serde_json::{json, Map, Value};

use crate::sign::{sha256_hex, system_clock, Clock};

pub const CODE_ALPHABET: &str = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 symbols, no 0/O/1/I
pub const CODE_LEN: usize = 8; // 40 bits
pub const MAX_LIFE_MS: u64 = 12 * 60 * 60 * 1000;
pub const TOMBSTONE_MS: u64 = 10 * 60 * 1000;
pub const RATE_WINDOW_MS: u64 = 5 * 60 * 1000;
pub const SWEEP_MS: u64 = 60 * 1000;
pub const BODY_MAX: usize = 1024;
pub const ROOM_MAX: usize = 128;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// total: live codes; fail_per_ip: wrong codes per address and window
/// (guesses); lookup_per_ip: every lookup per address and window (a board
/// polling /api/display/live every 2 s makes 150); set_per_owner: set /
/// revoke per scorer socket and window; tombstones: ended codes remembered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Caps {
    pub total: usize,
    pub fail_per_ip: u32,
    pub lookup_per_ip: u32,
    pub set_per_owner: u32,
    pub tombstones: usize,
}

#[cfg_attr(not(test), allow(dead_code))] // the JS core's API; the relay uses the LAN side
pub const CLOUD_CAPS: Caps = Caps { total: 5000, fail_per_ip: 20, lookup_per_ip: 600, set_per_owner: 30, tombstones: 5000 };
pub const LAN_CAPS: Caps = Caps { total: 200, fail_per_ip: 60, lookup_per_ip: 1200, set_per_owner: 60, tombstones: 500 };

/// The live-state columns only a socket with the match's PIN gets (the same
/// list as backend/lib/publicColumns.js LIVE_STATE_PRIVATE_COLUMNS): line-ups
/// and substitutions with shirt numbers, sanctions, the last event's data.
pub const LIVE_STATE_PRIVATE_COLUMNS: &[&str] = &[
    "lineup_a", "lineup_b", "sanctions_a", "sanctions_b", "subs_a", "subs_b", "last_event_data", "scorer_attention_trigger",
];

pub const SET_REASONS: &[&str] = &["revoked", "expired", "bad-code", "taken", "not-match-owner", "busy", "rate-limited"];
#[cfg_attr(not(test), allow(dead_code))] // the JS core's API; the relay uses the LAN side
pub const END_REASONS: &[&str] = &["revoked", "replaced", "expired", "dropped"];

pub const DISPLAY_API_HEADERS: &[(&str, &str)] = &[("Cache-Control", "no-store"), ("Access-Control-Allow-Origin", "*")];
pub const DISPLAY_PREFLIGHT_HEADERS: &[(&str, &str)] = &[
    ("Access-Control-Allow-Origin", "*"),
    ("Access-Control-Allow-Methods", "POST, OPTIONS"),
    ("Access-Control-Allow-Headers", "Content-Type"),
    ("Access-Control-Max-Age", "600"),
    ("Cache-Control", "no-store"),
];

fn message(code: &str) -> &'static str {
    match code {
        "OV_DISPLAY_BAD_REQUEST" => "Invalid request",
        "OV_DISPLAY_NOT_FOUND" => "This scoreboard code is not valid",
        "OV_DISPLAY_ENDED" => "This scoreboard code has ended",
        "OV_DISPLAY_TOO_LARGE" => "Request body too large",
        "OV_DISPLAY_RATE_LIMITED" => "Too many requests. Please wait a moment.",
        "OV_DISPLAY_UNAVAILABLE" => "Scoreboard codes are not available on this server",
        _ => "Error",
    }
}

/// An HTTP answer of /api/display/*: status, JSON body, headers (in order).
#[derive(Debug, Clone, PartialEq)]
pub struct HttpAnswer {
    pub status: u16,
    pub body: Value,
    pub headers: Vec<(String, String)>,
}

fn api_headers(extra: &[(&str, &str)]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = DISPLAY_API_HEADERS.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    for (k, v) in extra {
        match out.iter_mut().find(|(ek, _)| ek == k) {
            Some(e) => e.1 = v.to_string(),
            None => out.push((k.to_string(), v.to_string())),
        }
    }
    out
}

/// An error answer: { ok:false, code, message } with the API headers.
pub fn display_error(status: u16, code: &str, extra: &[(&str, &str)]) -> HttpAnswer {
    HttpAnswer { status, body: json!({ "ok": false, "code": code, "message": message(code) }), headers: api_headers(extra) }
}

// ---------------------------------------------------------------------------
// The code
// ---------------------------------------------------------------------------

/// 8 symbols of CODE_ALPHABET from 5 random bytes (40 bits, 5 per symbol).
/// (The scoring device makes the code; the relay only compares it.)
#[cfg_attr(not(test), allow(dead_code))]
pub fn code_from_bytes(bytes: &[u8]) -> String {
    let alphabet = CODE_ALPHABET.as_bytes();
    let mut acc: u64 = 0;
    for b in &bytes[..5] {
        acc = (acc << 8) | *b as u64;
    }
    (0..CODE_LEN).rev().map(|i| alphabet[((acc >> (i * 5)) & 31) as usize] as char).collect()
}

/// JavaScript's `\s` (WhiteSpace and LineTerminator), not Rust's
/// `char::is_whitespace` (which has U+0085 and lacks U+FEFF).
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
            | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// A typed code as the relay compares it: upper case, spaces and dashes
/// removed, 8 symbols of the alphabet; else None.
pub fn normalize_code(value: &str) -> Option<String> {
    if value.encode_utf16().count() > 32 {
        return None;
    }
    let s: String = value.to_uppercase().chars().filter(|c| !js_space(*c) && *c != '-').collect();
    if s.encode_utf16().count() != CODE_LEN || !s.chars().all(|c| CODE_ALPHABET.contains(c)) {
        return None;
    }
    Some(s)
}

/// `normalize_code` of any JSON value (a non-string is no code).
pub fn normalize_code_value(value: &Value) -> Option<String> {
    value.as_str().and_then(normalize_code)
}

/// ABCD2345 -> ABCD-2345 (what people read and type).
#[cfg_attr(not(test), allow(dead_code))]
pub fn display_code(code: &str) -> String {
    let units: Vec<u16> = code.encode_utf16().collect();
    if units.len() == CODE_LEN {
        format!("{}-{}", String::from_utf16_lossy(&units[..4]), String::from_utf16_lossy(&units[4..]))
    } else {
        code.to_string()
    }
}

/// The hash a relay keeps of a (normalised) code.
pub fn code_key(code: &str) -> String {
    sha256_hex(&format!("d:{code}"))
}

/// A live state as a board gets it: every column but
/// LIVE_STATE_PRIVATE_COLUMNS (null for anything but an object).
pub fn public_live_state(live: &Value) -> Value {
    let Some(o) = live.as_object() else { return Value::Null };
    let out: Map<String, Value> =
        o.iter().filter(|(k, _)| !LIVE_STATE_PRIVATE_COLUMNS.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
    Value::Object(out)
}

/// Which /api/display/* path this is ("lookup" | "live").
pub fn endpoint_of(path: &str) -> Option<&'static str> {
    match path {
        "/api/display/lookup" => Some("lookup"),
        "/api/display/live" => Some("live"),
        _ => None,
    }
}

/// /^\s*(application\/json|text\/plain)\s*(;|$)/i
fn display_content_type(content_type: &str) -> bool {
    let rest = content_type.trim_start_matches(js_space);
    for t in ["application/json", "text/plain"] {
        let n = t.len();
        if rest.len() >= n && rest.as_bytes()[..n].eq_ignore_ascii_case(t.as_bytes()) {
            let tail = rest[n..].trim_start_matches(js_space);
            return tail.is_empty() || tail.starts_with(';');
        }
    }
    false
}

/// The body of a POST /api/display/*: its `code` (raw, not normalised), or None.
pub fn parse_body(content_type: &str, text: &str) -> Option<String> {
    if !display_content_type(content_type) || text.encode_utf16().count() > BODY_MAX {
        return None;
    }
    let body: Value = serde_json::from_str(text).ok()?;
    body.as_object()?.get("code")?.as_str().map(str::to_string)
}

/// The address a lookup is counted for: IPv4 (IPv4-mapped IPv6 as IPv4), or
/// the /64 of an IPv6 address (one device's privacy addresses are one).
pub fn ip_key(ip: IpAddr) -> String {
    let ip = match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        v4 => v4,
    };
    match ip {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => {
            let s = v6.segments();
            format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3])
        }
    }
}

/// `issuedAt` as the JS core takes it: a safe, non-negative integer.
fn issued_at_of(v: &Value) -> Option<u64> {
    if let Some(u) = v.as_u64() {
        return (u <= MAX_SAFE_INTEGER).then_some(u);
    }
    if v.as_i64().is_some() {
        return None; // negative
    }
    let f = v.as_f64()?;
    (f.is_finite() && f.fract() == 0.0 && f >= 0.0 && f <= MAX_SAFE_INTEGER as f64).then_some(f as u64)
}

// ---------------------------------------------------------------------------
// An insertion-ordered map (the JS core's Map: oldest first)
// ---------------------------------------------------------------------------

struct Ordered<V> {
    map: HashMap<String, (u64, V)>,
    order: BTreeMap<u64, String>,
    next: u64,
}

impl<V> Default for Ordered<V> {
    fn default() -> Self {
        Ordered { map: HashMap::new(), order: BTreeMap::new(), next: 0 }
    }
}

impl<V> Ordered<V> {
    fn len(&self) -> usize {
        self.map.len()
    }
    fn get(&self, k: &str) -> Option<&V> {
        self.map.get(k).map(|(_, v)| v)
    }
    fn get_mut(&mut self, k: &str) -> Option<&mut V> {
        self.map.get_mut(k).map(|(_, v)| v)
    }
    /// Map.set: a key already there keeps its place.
    fn insert(&mut self, k: String, v: V) {
        if let Some(e) = self.map.get_mut(&k) {
            e.1 = v;
            return;
        }
        self.next += 1;
        self.order.insert(self.next, k.clone());
        self.map.insert(k, (self.next, v));
    }
    fn remove(&mut self, k: &str) -> Option<V> {
        let (seq, v) = self.map.remove(k)?;
        self.order.remove(&seq);
        Some(v)
    }
    fn first_key(&self) -> Option<String> {
        self.order.values().next().cloned()
    }
    fn keys(&self) -> Vec<String> {
        self.order.values().cloned().collect()
    }
}

// ---------------------------------------------------------------------------
// The code table
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct Entry {
    hash: String,
    room: String,
    start: u64,
    ends_at: u64,
    reference: String,
}

struct Tombstone {
    room: String,
    until: u64,
}

/// A code that ended (the JS core's onEnd call): the relay ends its boards.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ended {
    pub room: String,
    pub hash: String,
    pub reason: &'static str,
}

/// A board's lookup that found the room.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resolved {
    pub room: String,
    pub ends_at: u64,
    pub hash: String,
}

/// A board's lookup that did not ('rate-limited' with the seconds to wait).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub reason: &'static str,
    pub retry_after: Option<u64>,
}

fn refusal(reason: &'static str) -> Refusal {
    Refusal { reason, retry_after: None }
}

pub type Logger = Box<dyn Fn(&str) + Send + Sync>;

/// The code table of one relay.
pub struct DisplayCodes {
    pub caps: Caps,
    via: &'static str,
    now: Clock,
    log: Logger,
    by_hash: Ordered<Entry>,
    by_room: HashMap<String, String>,
    dead: Ordered<Tombstone>,
    /// key -> (count, start, window)
    rate: HashMap<String, (u32, u64, u64)>,
    ended: Vec<Ended>,
    sweeper: bool,
    sweeper_wanted: bool,
}

impl DisplayCodes {
    pub fn new(caps: Caps, via: &'static str, now: Clock, log: Logger) -> Self {
        DisplayCodes {
            caps,
            via,
            now,
            log,
            by_hash: Ordered::default(),
            by_room: HashMap::new(),
            dead: Ordered::default(),
            rate: HashMap::new(),
            ended: Vec::new(),
            sweeper: false,
            sweeper_wanted: false,
        }
    }

    /// The desktop app's relay: LAN caps, the system clock, stdout.
    pub fn lan() -> Self {
        Self::new(LAN_CAPS, "lan", system_clock(), Box::new(|line| println!("[Display] {line}")))
    }

    fn t(&self) -> u64 {
        (self.now)()
    }

    fn line(&self, event: &str, reference: &str) {
        (self.log)(&format!("display.{event} ref={reference} via={}", self.via));
    }

    /// The codes that ended since the last call (oldest first).
    pub fn take_ended(&mut self) -> Vec<Ended> {
        std::mem::take(&mut self.ended)
    }

    /// True once, after the first code was set: the relay starts its sweep
    /// (every SWEEP_MS, `sweep`).
    pub fn take_sweeper_request(&mut self) -> bool {
        std::mem::take(&mut self.sweeper_wanted)
    }

    fn ensure_sweeper(&mut self) {
        if !self.sweeper {
            self.sweeper = true;
            self.sweeper_wanted = true;
        }
    }

    /// Fixed window: counts one hit, returns the seconds to wait or 0.
    fn limited(&mut self, key: String, max: u32) -> u64 {
        let t = self.t();
        if self.rate.len() > 10_000 {
            self.rate.retain(|_, (_, start, w)| t.saturating_sub(*start) < *w);
            if self.rate.len() > 10_000 {
                self.rate.clear();
            }
        }
        let e = self.rate.entry(key).or_insert((0, t, RATE_WINDOW_MS));
        if t.saturating_sub(e.1) >= e.2 {
            *e = (0, t, RATE_WINDOW_MS);
        }
        e.0 += 1;
        if e.0 <= max {
            return 0;
        }
        (e.1 + e.2).saturating_sub(t).div_ceil(1000).max(1)
    }

    /// Seconds to wait when `key` is already over `max` (counts nothing), else 0.
    fn over(&self, key: &str, max: u32) -> u64 {
        let t = self.t();
        match self.rate.get(key) {
            Some((count, start, w)) if t.saturating_sub(*start) < *w && *count >= max => (start + w).saturating_sub(t).div_ceil(1000).max(1),
            _ => 0,
        }
    }

    /// End a code: forgotten, a tombstone kept, the relay told.
    fn end(&mut self, hash: &str, reason: &'static str, at: Option<u64>) {
        let at = at.unwrap_or_else(|| self.t());
        let Some(entry) = self.by_hash.remove(hash) else { return };
        if self.by_room.get(&entry.room).map(String::as_str) == Some(entry.hash.as_str()) {
            self.by_room.remove(&entry.room);
        }
        if self.dead.len() >= self.caps.tombstones {
            if let Some(k) = self.dead.first_key() {
                self.dead.remove(&k);
            }
        }
        self.dead.insert(entry.hash.clone(), Tombstone { room: entry.room.clone(), until: at + TOMBSTONE_MS });
        let event = match reason {
            "replaced" => "replace",
            "revoked" => "revoke",
            "expired" => "expire",
            _ => "drop",
        };
        self.line(event, &entry.reference);
        self.ended.push(Ended { room: entry.room, hash: entry.hash, reason });
    }

    /// The live entry of `hash` (an expired one ends here), or None.
    fn live(&mut self, hash: &str) -> Option<Entry> {
        let e = self.by_hash.get(hash)?.clone();
        if self.t() >= e.ends_at {
            self.end(hash, "expired", Some(e.ends_at));
            return None;
        }
        Some(e)
    }

    /// Ends what has run out, forgets old tombstones and counters.
    pub fn sweep(&mut self) {
        let t = self.t();
        for k in self.by_hash.keys() {
            if let Some(ends_at) = self.by_hash.get(&k).map(|e| e.ends_at) {
                if t >= ends_at {
                    self.end(&k, "expired", Some(ends_at));
                }
            }
        }
        for k in self.dead.keys() {
            if self.dead.get(&k).is_some_and(|d| t >= d.until) {
                self.dead.remove(&k);
            }
        }
        self.rate.retain(|_, (_, start, w)| t.saturating_sub(*start) < *w);
    }

    fn valid_room(room: Option<&str>) -> Option<&str> {
        room.filter(|r| {
            let n = r.encode_utf16().count();
            n > 0 && n <= ROOM_MAX
        })
    }

    /// The scorer's display-code-set, after the relay checked that its socket
    /// owns `room` (None: not a string). `code` null: revoke. `owner`: the
    /// socket (for the rate limit). Ok(endsAt) or Err(reason).
    pub fn set(&mut self, room: Option<&str>, code: &Value, issued_at: &Value, owner: &str) -> Result<u64, &'static str> {
        let Some(room) = Self::valid_room(room) else { return Err("bad-code") };
        if self.limited(format!("set:{owner}"), self.caps.set_per_owner) > 0 {
            return Err("rate-limited");
        }
        if code.is_null() {
            self.revoke(room);
            return Err("revoked");
        }
        let Some(c) = normalize_code_value(code) else { return Err("bad-code") };
        let t = self.t();
        let start = issued_at_of(issued_at).unwrap_or(t).min(t);
        if t - start >= MAX_LIFE_MS {
            return Err("expired");
        }
        let hash = code_key(&c);
        let existing = self.live(&hash);
        if existing.as_ref().is_some_and(|e| e.room != room) {
            return Err("taken");
        }
        if existing.is_none() && self.dead.get(&hash).is_some_and(|d| t < d.until && d.room != room) {
            return Err("taken");
        }
        if existing.is_some() {
            // the same code again (a reconnect): its first start counts
            let e = self.by_hash.get_mut(&hash).expect("live code");
            e.start = e.start.min(start);
            e.ends_at = e.start + MAX_LIFE_MS;
            let ends_at = e.ends_at;
            if t >= ends_at {
                self.end(&hash, "expired", Some(ends_at));
                return Err("expired");
            }
            return Ok(ends_at);
        }
        let current = self.by_room.get(room).filter(|h| self.by_hash.get(h).is_some()).cloned();
        if current.is_none() && self.by_hash.len() >= self.caps.total {
            self.sweep();
        }
        if current.is_none() && self.by_hash.len() >= self.caps.total {
            return Err("busy");
        }
        if let Some(h) = current {
            self.end(&h, "replaced", Some(t));
        }
        self.dead.remove(&hash);
        let entry = Entry { reference: hash[..8].to_string(), hash: hash.clone(), room: room.to_string(), start, ends_at: start + MAX_LIFE_MS };
        let (ends_at, reference) = (entry.ends_at, entry.reference.clone());
        self.by_hash.insert(hash.clone(), entry);
        self.by_room.insert(room.to_string(), hash);
        self.ensure_sweeper();
        self.line("set", &reference);
        Ok(ends_at)
    }

    /// The scorer revoked the room's code (idempotent). True when one ended.
    pub fn revoke(&mut self, room: &str) -> bool {
        let Some(hash) = self.by_room.get(room).filter(|h| self.by_hash.get(h).is_some()).cloned() else { return false };
        self.end(&hash, "revoked", None);
        true
    }

    /// The relay dropped the room (deleted, or let go as idle): its code ends.
    pub fn drop_room(&mut self, room: &str) -> bool {
        let Some(hash) = self.by_room.get(room).filter(|h| self.by_hash.get(h).is_some()).cloned() else { return false };
        self.end(&hash, "dropped", None);
        true
    }

    /// The room's live code: Some(endsAt) or None.
    pub fn code_of_room(&mut self, room: &str) -> Option<u64> {
        let hash = self.by_room.get(room)?.clone();
        self.live(&hash).map(|e| e.ends_at)
    }

    /// Is the code behind `hash` still live for `room`? (a board's subscription)
    pub fn is_live(&mut self, hash: &str, room: &str) -> bool {
        self.live(hash).is_some_and(|e| e.room == room)
    }

    /// A board's lookup. `ip_key`: the caller's address (`ip_key`).
    pub fn resolve(&mut self, code: &Value, ip_key: &str) -> Result<Resolved, Refusal> {
        // over the wrong-code budget: refused before any comparison
        let blocked = self.over(&format!("fail:{ip_key}"), self.caps.fail_per_ip);
        if blocked > 0 {
            return Err(Refusal { reason: "rate-limited", retry_after: Some(blocked) });
        }
        let retry = self.limited(format!("look:{ip_key}"), self.caps.lookup_per_ip);
        if retry > 0 {
            return Err(Refusal { reason: "rate-limited", retry_after: Some(retry) });
        }
        let c = normalize_code_value(code);
        let hash = c.as_deref().map(code_key);
        if let Some(e) = hash.as_deref().and_then(|h| self.live(h)) {
            return Ok(Resolved { room: e.room, ends_at: e.ends_at, hash: e.hash });
        }
        self.limited(format!("fail:{ip_key}"), self.caps.fail_per_ip);
        let Some(hash) = hash else { return Err(refusal("bad-code")) };
        let t = self.t();
        if self.dead.get(&hash).is_some_and(|d| t < d.until) {
            return Err(refusal("ended"));
        }
        Err(refusal("not-found"))
    }

    /// A failed resolve as an HTTP answer.
    fn lookup_error(r: &Refusal) -> HttpAnswer {
        match r.reason {
            "rate-limited" => {
                let secs = r.retry_after.unwrap_or(60).to_string();
                display_error(429, "OV_DISPLAY_RATE_LIMITED", &[("Retry-After", secs.as_str())])
            }
            "ended" => display_error(410, "OV_DISPLAY_ENDED", &[]),
            _ => display_error(404, "OV_DISPLAY_NOT_FOUND", &[]),
        }
    }

    /// POST /api/display/<endpoint>. `summary_of(room)`: the relay's public
    /// summary of the room ({ match, homeTeam, awayTeam, sets, liveState })
    /// or None when it does not hold the match now.
    pub fn http(&mut self, endpoint: &str, content_type: &str, text: &str, ip_key: &str, summary_of: impl FnOnce(&str) -> Option<Value>) -> HttpAnswer {
        if endpoint != "lookup" && endpoint != "live" {
            return display_error(404, "OV_DISPLAY_NOT_FOUND", &[]);
        }
        if text.encode_utf16().count() > BODY_MAX {
            return display_error(413, "OV_DISPLAY_TOO_LARGE", &[]);
        }
        let Some(code) = parse_body(content_type, text) else { return display_error(400, "OV_DISPLAY_BAD_REQUEST", &[]) };
        let r = match self.resolve(&Value::String(code), ip_key) {
            Ok(r) => r,
            Err(e) => return Self::lookup_error(&e),
        };
        if endpoint == "lookup" {
            return HttpAnswer { status: 200, body: json!({ "ok": true, "matchId": r.room, "endsAt": r.ends_at }), headers: api_headers(&[]) };
        }
        let s = summary_of(&r.room).filter(Value::is_object);
        let field = |k: &str| s.as_ref().and_then(|s| s.get(k));
        let body = json!({
            "ok": true,
            "matchId": r.room,
            "endsAt": r.ends_at,
            "match": field("match").filter(|m| m.is_object()).cloned().unwrap_or(Value::Null),
            "homeTeam": field("homeTeam").cloned().unwrap_or(Value::Null),
            "awayTeam": field("awayTeam").cloned().unwrap_or(Value::Null),
            "sets": field("sets").filter(|x| x.is_array()).cloned().unwrap_or_else(|| json!([])),
            "liveState": field("liveState").map(public_live_state).unwrap_or(Value::Null),
        });
        HttpAnswer { status: 200, body, headers: api_headers(&[]) }
    }

    /// For tests and status: (codes, tombstones, sweeper); never a code or a hash.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn stats(&self) -> (usize, usize, bool) {
        (self.by_hash.len(), self.dead.len(), self.sweeper)
    }
}

// ---------------------------------------------------------------------------
// WebSocket messages (the same on every relay)
// ---------------------------------------------------------------------------

/// The scorer's answer to display-code-set: display-code-state.
pub fn code_state_message(match_id: &str, r: Result<u64, &str>) -> Value {
    match r {
        Ok(ends_at) => json!({ "type": "display-code-state", "matchId": match_id, "active": true, "endsAt": ends_at }),
        Err(reason) => {
            let reason = SET_REASONS.iter().find(|x| **x == reason).copied().unwrap_or("bad-code");
            json!({ "type": "display-code-state", "matchId": match_id, "active": false, "reason": reason })
        }
    }
}

/// A board's answer to subscribe-match { code }: display-code.
pub fn code_answer_message(r: &Result<Resolved, Refusal>) -> Value {
    match r {
        Ok(r) => json!({ "type": "display-code", "ok": true, "matchId": r.room, "endsAt": r.ends_at }),
        Err(e) => {
            let reason = if e.reason == "bad-code" { "not-found" } else { e.reason };
            let mut out = json!({ "type": "display-code", "ok": false, "reason": reason });
            if e.reason == "rate-limited" {
                if let Some(s) = e.retry_after {
                    out["retryAfter"] = json!(s);
                }
            }
            out
        }
    }
}

/// The code a board followed by has ended: display-code ended.
pub fn code_ended_message(match_id: &str) -> Value {
    json!({ "type": "display-code", "ok": false, "reason": "ended", "matchId": match_id })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};

    const VECTORS: &str = include_str!("../../electron/__fixtures__/display-code-vectors.json");

    fn fill(v: &Value) -> Value {
        match v {
            Value::Object(o) if o.get("$repeat").is_some_and(|r| r.is_array()) => {
                let r = o["$repeat"].as_array().unwrap();
                json!(r[0].as_str().unwrap().repeat(r[1].as_u64().unwrap() as usize))
            }
            Value::Array(a) => Value::Array(a.iter().map(fill).collect()),
            Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), fill(x))).collect()),
            _ => v.clone(),
        }
    }

    fn set_json(r: Result<u64, &str>) -> Value {
        match r {
            Ok(e) => json!({ "ok": true, "endsAt": e }),
            Err(reason) => json!({ "ok": false, "reason": reason }),
        }
    }

    fn resolve_json(r: &Result<Resolved, Refusal>) -> Value {
        match r {
            Ok(r) => json!({ "ok": true, "room": r.room, "endsAt": r.ends_at }),
            Err(e) => {
                let mut out = json!({ "ok": false, "reason": e.reason });
                if let Some(s) = e.retry_after {
                    out["retryAfter"] = json!(s);
                }
                out
            }
        }
    }

    fn http_json(a: &HttpAnswer) -> Value {
        let headers: Map<String, Value> = a.headers.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
        json!({ "status": a.status, "body": a.body, "headers": headers })
    }

    struct Run {
        table: DisplayCodes,
        clock: Arc<AtomicU64>,
        lines: Arc<Mutex<Vec<String>>>,
    }

    fn table_for(scenario: &Value) -> Run {
        let via = if scenario.get("via").and_then(Value::as_str) == Some("cloud") { "cloud" } else { "lan" };
        let mut caps = if via == "cloud" { CLOUD_CAPS } else { LAN_CAPS };
        if let Some(o) = scenario.get("caps").and_then(Value::as_object) {
            for (k, v) in o {
                let n = v.as_u64().unwrap();
                match k.as_str() {
                    "total" => caps.total = n as usize,
                    "failPerIp" => caps.fail_per_ip = n as u32,
                    "lookupPerIp" => caps.lookup_per_ip = n as u32,
                    "setPerOwner" => caps.set_per_owner = n as u32,
                    "tombstones" => caps.tombstones = n as usize,
                    other => panic!("unknown cap {other}"),
                }
            }
        }
        let clock = Arc::new(AtomicU64::new(0));
        let c = clock.clone();
        let lines = Arc::new(Mutex::new(Vec::new()));
        let l = lines.clone();
        let table = DisplayCodes::new(caps, via, Arc::new(move || c.load(Ordering::SeqCst)), Box::new(move |s| l.lock().unwrap().push(s.to_string())));
        Run { table, clock, lines }
    }

    /// One step; its result as the JS runner sees it (None: no result to check).
    fn run_step(run: &mut Run, step: &Value) -> Option<Value> {
        if let Some(at) = step.get("at").and_then(Value::as_u64) {
            run.clock.store(at, Ordering::SeqCst);
        }
        let null = Value::Null;
        let get = |k: &str| step.get(k).map(fill).unwrap_or(Value::Null);
        let ip = step.get("ip").and_then(Value::as_str).unwrap_or("192.0.2.1").to_string();
        let t = &mut run.table;
        match step["op"].as_str().unwrap() {
            "set" => {
                let room = get("room");
                let owner = step.get("owner").and_then(Value::as_str).unwrap_or("o1");
                Some(set_json(t.set(room.as_str(), &get("code"), step.get("issuedAt").unwrap_or(&null), owner)))
            }
            "resolve" => Some(resolve_json(&t.resolve(&get("code"), &ip))),
            "codeOfRoom" => Some(t.code_of_room(get("room").as_str().unwrap()).map_or(Value::Null, |e| json!({ "endsAt": e }))),
            "isLive" => {
                let code = normalize_code_value(&get("code")).expect("an isLive code");
                Some(json!(t.is_live(&code_key(&code), get("room").as_str().unwrap())))
            }
            "stats" => {
                let (codes, tombstones, sweeper) = t.stats();
                Some(json!({ "codes": codes, "tombstones": tombstones, "sweeper": sweeper }))
            }
            "ends" => Some(Value::Array(
                t.take_ended()
                    .into_iter()
                    .inspect(|e| assert!(END_REASONS.contains(&e.reason), "{}", e.reason))
                    .map(|e| json!([e.room, e.reason]))
                    .collect(),
            )),
            "revoke" => Some(json!(t.revoke(get("room").as_str().unwrap()))),
            "drop" => Some(json!(t.drop_room(get("room").as_str().unwrap()))),
            "sweep" => {
                t.sweep();
                None
            }
            "repeat" => {
                for _ in 0..step["n"].as_u64().unwrap() {
                    run_step(run, &step["step"]);
                }
                None
            }
            "http" => {
                let text = match step.get("text") {
                    Some(x) => fill(x).as_str().unwrap().to_string(),
                    None => serde_json::to_string(&get("body")).unwrap(),
                };
                let summary = get("summary");
                let ct = step.get("contentType").and_then(Value::as_str).unwrap_or("");
                let endpoint = step["endpoint"].as_str().unwrap();
                Some(http_json(&t.http(endpoint, ct, &text, &ip, |room| summary.get(room).cloned())))
            }
            other => panic!("unknown op {other}"),
        }
    }

    /// `want` against `got`; for stats only the keys the vector names.
    fn matches(op: &str, got: &Value, want: &Value) -> bool {
        if op == "stats" {
            return want.as_object().unwrap().iter().all(|(k, v)| got.get(k) == Some(v));
        }
        got == want
    }

    #[test]
    fn agrees_with_every_shared_vector() {
        let vectors: Value = serde_json::from_str(VECTORS).expect("display-code-vectors.json");
        let mut failures = Vec::new();
        let mut checked = 0;
        for v in vectors["codes"].as_array().unwrap() {
            checked += 1;
            if normalize_code_value(&v["in"]).map(Value::from).unwrap_or(Value::Null) != v["out"] {
                failures.push(format!("code {}", v["in"]));
            }
        }
        for v in vectors["display"].as_array().unwrap() {
            checked += 1;
            if json!(display_code(v["in"].as_str().unwrap())) != v["out"] {
                failures.push(format!("display {}", v["in"]));
            }
        }
        for v in vectors["fromBytes"].as_array().unwrap() {
            checked += 1;
            let bytes: Vec<u8> = v["in"].as_array().unwrap().iter().map(|b| b.as_u64().unwrap() as u8).collect();
            if json!(code_from_bytes(&bytes)) != v["out"] {
                failures.push(format!("fromBytes {}", v["in"]));
            }
        }
        for v in vectors["endpoints"].as_array().unwrap() {
            checked += 1;
            if endpoint_of(v["path"].as_str().unwrap()).map(Value::from).unwrap_or(Value::Null) != v["out"] {
                failures.push(format!("endpoint {}", v["path"]));
            }
        }
        for v in vectors["bodies"].as_array().unwrap() {
            checked += 1;
            let r = parse_body(v["contentType"].as_str().unwrap(), v["text"].as_str().unwrap());
            if r.map(Value::from).unwrap_or(Value::Null) != v["out"] {
                failures.push(format!("body {} {}", v["contentType"], v["text"]));
            }
        }
        for v in vectors["publicLive"].as_array().unwrap() {
            checked += 1;
            if public_live_state(&v["in"]) != v["out"] {
                failures.push(format!("publicLive {}", v["in"]));
            }
        }
        for v in vectors["messages"].as_array().unwrap() {
            checked += 1;
            let input = &v["in"];
            let got = match v["fn"].as_str().unwrap() {
                "state" => {
                    let r = if input["ok"] == json!(true) { Ok(input["endsAt"].as_u64().unwrap()) } else { Err(input["reason"].as_str().unwrap()) };
                    code_state_message(v["matchId"].as_str().unwrap(), r)
                }
                "answer" => {
                    let r = if input["ok"] == json!(true) {
                        Ok(Resolved {
                            room: input["room"].as_str().unwrap().into(),
                            ends_at: input["endsAt"].as_u64().unwrap(),
                            hash: input["hash"].as_str().unwrap_or("").into(),
                        })
                    } else {
                        let reason: &'static str = Box::leak(input["reason"].as_str().unwrap().to_string().into_boxed_str());
                        Err(Refusal { reason, retry_after: input.get("retryAfter").and_then(Value::as_u64) })
                    };
                    code_answer_message(&r)
                }
                "ended" => code_ended_message(v["matchId"].as_str().unwrap()),
                other => panic!("unknown message fn {other}"),
            };
            if got != v["out"] {
                failures.push(format!("message {}: {got}", v["fn"]));
            }
        }
        let mut steps = 0;
        for scenario in vectors["scenarios"].as_array().unwrap() {
            let mut run = table_for(scenario);
            for (i, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
                let op = step["op"].as_str().unwrap();
                let got = run_step(&mut run, step);
                steps += 1;
                if let (Some(want), Some(got)) = (step.get("expect"), got) {
                    if !matches(op, &got, want) {
                        failures.push(format!("scenario {} step {i} ({op}): {got} != {want}", scenario["name"]));
                    }
                }
            }
            // never a code in a log line
            for line in run.lines.lock().unwrap().iter() {
                assert!(line.starts_with("display.") && line.contains(" ref=") && line.ends_with(&format!(" via={}", run.table.via)), "{line}");
                for code in ["ABCD", "WXYZ", "HJKL", "MNPQ"] {
                    assert!(!line.contains(code), "a code in {line}");
                }
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
        assert!(checked >= 40 && steps >= 100, "{checked} vectors, {steps} scenario steps");
        println!("display-code vectors: {checked} plus {steps} scenario steps in {} scenarios", vectors["scenarios"].as_array().unwrap().len());
    }

    #[test]
    fn js_whitespace_and_content_types() {
        // JS \s: U+FEFF counts, U+0085 does not
        assert_eq!(normalize_code("\u{feff}ABCD 2345").as_deref(), Some("ABCD2345"));
        assert_eq!(normalize_code("\u{85}ABCD2345"), None);
        assert_eq!(normalize_code("\u{3000}abcd\u{2028}2345"), Some("ABCD2345".into()));
        assert!(display_content_type(" Application/JSON ; charset=utf-8"));
        assert!(display_content_type("text/plain"));
        assert!(!display_content_type("text/plainx"));
        assert!(!display_content_type("application/json5"));
        assert!(!display_content_type("x application/json"));
    }

    #[test]
    fn addresses_count_ipv4_and_the_ipv6_64() {
        assert_eq!(ip_key("192.0.2.7".parse().unwrap()), "192.0.2.7");
        assert_eq!(ip_key("::ffff:192.0.2.7".parse().unwrap()), "192.0.2.7");
        assert_eq!(ip_key("2001:db8:1:2:aaaa::1".parse().unwrap()), "2001:db8:1:2::/64");
        assert_eq!(ip_key("2001:db8:1:2:bbbb::9".parse().unwrap()), ip_key("2001:db8:1:2:aaaa::1".parse().unwrap()));
    }

    #[test]
    fn issued_at_is_a_safe_non_negative_integer() {
        assert_eq!(issued_at_of(&json!(5)), Some(5));
        assert_eq!(issued_at_of(&json!(5.0)), Some(5));
        assert_eq!(issued_at_of(&json!(1.5)), None);
        assert_eq!(issued_at_of(&json!(-5)), None);
        assert_eq!(issued_at_of(&json!(9_007_199_254_740_992u64)), None);
        assert_eq!(issued_at_of(&json!("5")), None);
    }

    #[test]
    fn the_sweeper_is_asked_for_once() {
        let mut t = DisplayCodes::new(LAN_CAPS, "lan", Arc::new(|| 0), Box::new(|_| {}));
        assert!(!t.take_sweeper_request());
        assert!(t.set(Some("r"), &json!("ABCD2345"), &json!(0), "o").is_ok());
        assert!(t.take_sweeper_request());
        assert!(t.set(Some("r"), &json!("WXYZ6789"), &json!(0), "o").is_ok());
        assert!(!t.take_sweeper_request());
        assert_eq!(t.stats(), (1, 1, true));
        assert_eq!(t.take_ended(), vec![Ended { room: "r".into(), hash: code_key("ABCD2345"), reason: "replaced" }]);
    }
}
