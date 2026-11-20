//! "Pair a phone" (docs/phone-keyboard-spec.md): the Rust port of
//! `electron/pairSessionCore.cjs`. Same endpoints, bodies, answers and codes;
//! the shared vectors in `electron/__fixtures__/pair-vectors.json` run against
//! both (the test module below).
//!
//!   scoring device  start { matchKey?, context }           -> 201 { ok, token, code, watch, joinBy, endsAt, path }
//!                   wait  { watch, knownState?, after?, knownPhone? } -> 200 { ok, state, seq, inputs, phone, endsAt }
//!                   focus { watch, field, applied? }        -> 200 { ok, v }
//!                   close { watch }                         -> 200 { ok }
//!   phone           join  { k } | { code }                  -> 200 { ok, phone, state, context, endsAt }
//!                   poll  { phone, known? }                 -> 200 { ok, state, v, field, applied, endsAt }
//!                   input { phone, n, field, text?, action?, base? } -> 200 { ok, seq }
//!
//! Only SHA-256 hashes of the secrets and the code are kept, in memory.
//! Nothing is logged but `pair.<event> ref=<8 hex> via=lan`. The relay
//! (relay.rs) does the auth of `start` (the /api/sign/start rule) and reads the bodies.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use rand::TryRng; // rand 0.10: was TryRngCore (try_fill_bytes)
use serde_json::{json, Map, Value};
use tokio::sync::oneshot;
use unicode_normalization::UnicodeNormalization;

use crate::sign::{base64url, is_secret_shape, sanitize_text, sha256_hex, system_clock, Answer, Clock};

pub const JOIN_TTL_MS: u64 = 10 * 60 * 1000;
pub const MAX_LIFE_MS: u64 = 6 * 60 * 60 * 1000;
pub const DEVICE_IDLE_MS: u64 = 5 * 60 * 1000;
pub const PHONE_SEEN_MS: u64 = 40 * 1000;
pub const TOMBSTONE_MS: u64 = 60 * 1000;
pub const WAIT_MS: u64 = 25 * 1000;
pub const SWEEP_MS: u64 = 60 * 1000;
pub const RATE_WINDOW_MS: u64 = 5 * 60 * 1000;
const BURST_WINDOW_MS: u64 = 1000;
pub const BODY_MAX: usize = 4 * 1024;
pub const TEXT_BODY_MAX: usize = 64 * 1024;
pub const PAIR_PATH: &str = "/pair";

const TEXT_MAX: u64 = 8000;
const LABEL_MAX: usize = 80;
const INPUT_QUEUE_MAX: usize = 64;
const ACTIONS: &[&str] = &["next", "prev", "enter", "done"];
const CODE_ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_N: f64 = 9007199254740991.0;
const LANGS: &[&str] = &["en", "de", "de-CH", "fr", "it"];
const CONTEXT_TEXT: &[(&str, usize, bool)] = &[("matchNo", 20, false), ("home", 60, true), ("away", 60, true), ("when", 32, false)];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Caps {
    pub total: usize,
    pub per_owner: usize,
    pub start_per_owner: u32,
    pub phone_per_ip: u32,
    pub code_per_ip: u32,
    pub input_burst: u32,
    pub waiters: usize,
    pub local_reserve: usize,
}

pub const LAN_CAPS: Caps = Caps { total: 60, per_owner: 5, start_per_owner: 30, phone_per_ip: 6000, code_per_ip: 60, input_burst: 30, waiters: 120, local_reserve: 10 };

fn message(code: &str) -> &'static str {
    match code {
        "OV_PAIR_BAD_REQUEST" => "Invalid request",
        "OV_PAIR_CONTEXT" => "Both team names are needed",
        "OV_PAIR_FIELD" => "Invalid field",
        "OV_PAIR_TEXT_TOO_LONG" => "The text is too long for this field",
        "OV_PAIR_STALE" => "Another field is selected on the scoring device",
        "OV_PAIR_NO_FIELD" => "No text field is selected on the scoring device",
        "OV_PAIR_FORBIDDEN" => "This device may not pair a phone",
        "OV_PAIR_PIN_INVALID" => "Wrong game PIN",
        "OV_PAIR_NOT_FOUND" => "This link or code is not valid",
        "OV_PAIR_USED" => "Another phone is already paired",
        "OV_PAIR_CANCELLED" => "The scoring device ended the pairing",
        "OV_PAIR_EXPIRED" => "This pairing has expired",
        "OV_PAIR_TOO_LARGE" => "Request body too large",
        "OV_PAIR_RATE_LIMITED" => "Too many requests. Please wait a moment.",
        "OV_PAIR_BUSY" => "Phone pairing is busy. Try again in a moment.",
        "OV_PAIR_UNAVAILABLE" => "Phone pairing is not available on this server",
        _ => "Error",
    }
}

pub fn pair_error(status: u16, code: &str) -> Answer {
    Answer { status, body: json!({ "ok": false, "code": code, "message": message(code) }), retry_after: None }
}

fn pair_error_retry(status: u16, code: &str, retry_after: u64) -> Answer {
    Answer { retry_after: Some(retry_after), ..pair_error(status, code) }
}

fn ok(status: u16, body: Value) -> Answer {
    Answer { status, body, retry_after: None }
}

/// Which /api/pair/* endpoint a path is.
pub fn endpoint_of(path: &str) -> Option<&'static str> {
    match path {
        "/api/pair/start" => Some("start"),
        "/api/pair/wait" => Some("wait"),
        "/api/pair/focus" => Some("focus"),
        "/api/pair/close" => Some("close"),
        "/api/pair/join" => Some("join"),
        "/api/pair/poll" => Some("poll"),
        "/api/pair/input" => Some("input"),
        _ => None,
    }
}

pub fn body_limit(endpoint: &str) -> usize {
    if endpoint == "focus" || endpoint == "input" { TEXT_BODY_MAX } else { BODY_MAX }
}

/// /pair, /pair/ and everything below it (the /sign page's headers).
pub fn is_pair_page_path(path: &str) -> bool {
    path == PAIR_PATH || path.starts_with("/pair/")
}

// ---------------------------------------------------------------------------
// The code, the secrets
// ---------------------------------------------------------------------------

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    rand::rngs::SysRng.try_fill_bytes(&mut bytes).expect("the OS random source");
    bytes
}

/// 8 symbols of the alphabet from 5 bytes (40 bits, 5 per symbol).
pub fn code_from_bytes(bytes: &[u8]) -> String {
    let mut acc: u64 = 0;
    for b in &bytes[..5] {
        acc = (acc << 8) | *b as u64;
    }
    (0..8).rev().map(|i| CODE_ALPHABET[((acc >> (i * 5)) & 31) as usize] as char).collect()
}

/// A typed code as compared: upper case, spaces and dashes out, 8 symbols of the alphabet.
pub fn normalize_code(v: &Value) -> Option<String> {
    let s = v.as_str()?;
    if s.encode_utf16().count() > 32 {
        return None;
    }
    let up: String = s.chars().filter(|c| !c.is_whitespace() && *c != '-').flat_map(|c| c.to_uppercase()).collect();
    if up.chars().count() != 8 || !up.bytes().all(|b| CODE_ALPHABET.contains(&b)) || !up.is_ascii() {
        return None;
    }
    Some(up)
}

// ---------------------------------------------------------------------------
// Validation (same rules as pairSessionCore.cjs)
// ---------------------------------------------------------------------------

fn is_text_control(c: char) -> bool {
    matches!(c, '\u{0}'..='\u{9}' | '\u{b}'..='\u{1f}' | '\u{7f}'..='\u{9f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

/// A field's text as typed: NFC, line ends made \n ("line": spaces), a tab a
/// space, other control and bidi characters out; not trimmed.
pub fn sanitize_field_text(value: &str, line: bool) -> String {
    let s: String = value.nfc().collect();
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        let c = match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                '\n'
            }
            '\u{2028}' | '\u{2029}' => '\n',
            '\t' => ' ',
            c => c,
        };
        if c != '\n' && is_text_control(c) {
            continue;
        }
        out.push(if line && c == '\n' { ' ' } else { c });
    }
    out
}

fn cut(s: String, max: u64) -> String {
    if s.chars().count() as u64 > max { s.chars().take(max as usize).collect() } else { s }
}

/// An integral JSON number (5 and 5.0 alike) in lo..=hi.
fn int_in(v: &Value, lo: f64, hi: f64) -> Option<u64> {
    let f = v.as_f64()?;
    if !f.is_finite() || f.fract() != 0.0 || f < lo || f > hi {
        return None;
    }
    Some(f as u64)
}

pub fn validate_context(raw: Option<&Value>) -> Result<Value, &'static str> {
    let Some(obj) = raw.and_then(|v| v.as_object()) else { return Err("OV_PAIR_BAD_REQUEST") };
    let mut out = Map::new();
    for (key, max, required) in CONTEXT_TEXT {
        match obj.get(*key) {
            None | Some(Value::Null) => {
                if *required {
                    return Err("OV_PAIR_CONTEXT");
                }
            }
            Some(Value::String(s)) => {
                let clean = sanitize_text(s, *max);
                if clean.is_empty() {
                    if *required {
                        return Err("OV_PAIR_CONTEXT");
                    }
                } else {
                    out.insert((*key).to_string(), json!(clean));
                }
            }
            Some(_) => return Err("OV_PAIR_BAD_REQUEST"),
        }
    }
    match obj.get("lang") {
        None | Some(Value::Null) => {}
        Some(Value::String(s)) => {
            if LANGS.contains(&s.as_str()) {
                out.insert("lang".into(), json!(s));
            }
        }
        Some(_) => return Err("OV_PAIR_BAD_REQUEST"),
    }
    Ok(Value::Object(out))
}

fn field_id_ok(s: &str) -> bool {
    (1..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

/// Ok(null | { id, label, kind, text, maxLength }) or Err(code).
pub fn validate_field(raw: &Value) -> Result<Value, &'static str> {
    if raw.is_null() {
        return Ok(Value::Null);
    }
    let Some(obj) = raw.as_object() else { return Err("OV_PAIR_FIELD") };
    let Some(id) = obj.get("id").and_then(|v| v.as_str()).filter(|s| field_id_ok(s)) else { return Err("OV_PAIR_FIELD") };
    let kind = match obj.get("kind") {
        None | Some(Value::Null) => "line",
        Some(Value::String(k)) if k == "line" || k == "multiline" => k.as_str(),
        Some(_) => return Err("OV_PAIR_FIELD"),
    };
    let max = match obj.get("maxLength") {
        None | Some(Value::Null) => TEXT_MAX,
        Some(v) => int_in(v, 1.0, f64::MAX).ok_or("OV_PAIR_FIELD")?.min(TEXT_MAX),
    };
    let label = match obj.get("label") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => sanitize_text(s, LABEL_MAX),
        Some(_) => return Err("OV_PAIR_BAD_REQUEST"),
    };
    let text = match obj.get("text") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => cut(sanitize_field_text(s, kind == "line"), max),
        Some(_) => return Err("OV_PAIR_BAD_REQUEST"),
    };
    Ok(json!({ "id": id, "label": label, "kind": kind, "text": text, "maxLength": max }))
}

/// Ok(the input to queue, without its seq) or Err(code), for the focused `field`.
fn validate_input(obj: &Map<String, Value>, field: &Value) -> Result<Map<String, Value>, &'static str> {
    const BAD: &str = "OV_PAIR_BAD_REQUEST";
    let n = obj.get("n").and_then(|v| int_in(v, 1.0, MAX_N)).ok_or(BAD)?;
    let fid = obj.get("field").and_then(|v| v.as_str()).filter(|s| field_id_ok(s)).ok_or(BAD)?;
    let text = obj.get("text").filter(|v| !v.is_null());
    let action = obj.get("action").filter(|v| !v.is_null());
    if text.is_none() && action.is_none() {
        return Err(BAD);
    }
    if text.map_or(false, |t| !t.is_string()) {
        return Err(BAD);
    }
    if action.map_or(false, |a| !a.as_str().map_or(false, |s| ACTIONS.contains(&s))) {
        return Err(BAD);
    }
    let base = obj.get("base").filter(|v| !v.is_null());
    if base.map_or(false, |b| !b.as_str().map_or(false, |s| s.len() == 8 && s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')))) {
        return Err(BAD);
    }
    if field.is_null() {
        return Err("OV_PAIR_NO_FIELD");
    }
    if field["id"].as_str() != Some(fid) {
        return Err("OV_PAIR_STALE");
    }
    let mut out = Map::new();
    out.insert("n".into(), json!(n));
    out.insert("field".into(), json!(fid));
    if let Some(t) = text.and_then(|t| t.as_str()) {
        let clean = sanitize_field_text(t, field["kind"] == "line");
        if clean.chars().count() as u64 > field["maxLength"].as_u64().unwrap_or(TEXT_MAX) {
            return Err("OV_PAIR_TEXT_TOO_LONG");
        }
        out.insert("text".into(), json!(clean));
    }
    if let Some(a) = action {
        out.insert("action".into(), a.clone());
    }
    if let Some(b) = base {
        out.insert("base".into(), b.clone());
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Dead {
    Expired,
    Cancelled,
}

struct Tombstone {
    kind: Dead,
    until: u64,
}

struct Waiter {
    id: u64,
    tx: oneshot::Sender<Answer>,
    after: u64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Side {
    Device,
    Phone,
}

struct Session {
    watch_hash: String,
    token_hash: String,
    code_hash: String,
    phone_hash: Option<String>,
    reference: String,
    paired: bool,
    context: Value,
    owner: String,
    join_by: u64,
    ends_at: u64,
    device_seen_at: u64,
    phone_seen_at: Option<u64>,
    paired_at: Option<u64>,
    field: Value,
    v: u64,
    applied: u64,
    inputs: Vec<Value>,
    seq: u64,
    last_n: u64,
    device_waiter: Option<Waiter>,
    phone_waiter: Option<Waiter>,
}

impl Session {
    fn state(&self) -> &'static str {
        if self.paired { "paired" } else { "pending" }
    }
    fn live_until(&self, t: u64) -> u64 {
        let last = if self.device_waiter.is_some() { t } else { self.device_seen_at };
        let end = self.ends_at.min(last + DEVICE_IDLE_MS);
        if self.paired { end } else { end.min(self.join_by) }
    }
    fn phone_connected(&self, t: u64) -> bool {
        self.phone_waiter.is_some() || self.phone_seen_at.map_or(false, |at| t.saturating_sub(at) < PHONE_SEEN_MS)
    }
    fn device_answer(&self, after: u64, t: u64) -> Answer {
        let inputs: Vec<Value> = self.inputs.iter().filter(|i| i["seq"].as_u64().unwrap_or(0) > after).cloned().collect();
        let mut body = json!({ "ok": true, "state": self.state(), "seq": self.seq, "inputs": inputs, "phone": { "connected": self.phone_connected(t) }, "endsAt": self.ends_at });
        if !self.paired {
            body["joinBy"] = json!(self.join_by);
        }
        if let Some(at) = self.paired_at {
            body["pairedAt"] = json!(at);
        }
        ok(200, body)
    }
    fn phone_answer(&self) -> Answer {
        ok(200, json!({ "ok": true, "state": self.state(), "v": self.v, "field": self.field, "applied": self.applied, "endsAt": self.ends_at }))
    }
    fn waiter(&mut self, side: Side) -> &mut Option<Waiter> {
        match side {
            Side::Device => &mut self.device_waiter,
            Side::Phone => &mut self.phone_waiter,
        }
    }
}

fn dead_answer(kind: Dead) -> Answer {
    ok(200, json!({ "ok": true, "state": if kind == Dead::Cancelled { "closed" } else { "expired" } }))
}

fn dead_error(kind: Dead) -> Answer {
    match kind {
        Dead::Cancelled => pair_error(409, "OV_PAIR_CANCELLED"),
        Dead::Expired => pair_error(410, "OV_PAIR_EXPIRED"),
    }
}

#[derive(Default)]
struct Inner {
    by_watch: HashMap<String, Session>,
    by_token: HashMap<String, String>,
    by_code: HashMap<String, String>,
    by_phone: HashMap<String, String>,
    dead: HashMap<String, Tombstone>,
    /// key -> (count, start, window)
    rate: HashMap<String, (u32, u64, u64)>,
    waiters: usize,
    next_waiter: u64,
    sweeper: bool,
}

enum Found {
    Live(String),
    Dead(Dead),
    Missing,
}

/// The pairing table of one relay.
pub struct PairSessions {
    inner: Mutex<Inner>,
    caps: Caps,
    wait_ms: u64,
    now: Clock,
    me: Weak<PairSessions>,
}

impl PairSessions {
    pub fn new(caps: Caps, wait_ms: u64, now: Clock) -> Arc<Self> {
        Arc::new_cyclic(|me| PairSessions { inner: Mutex::new(Inner::default()), caps, wait_ms, now, me: me.clone() })
    }

    pub fn lan() -> Arc<Self> {
        Self::new(LAN_CAPS, WAIT_MS, system_clock())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn line(event: &str, s: &Session) {
        println!("[Pair] pair.{event} ref={} via=lan", s.reference);
    }

    fn limited(&self, inner: &mut Inner, key: String, max: u32, window: u64) -> u64 {
        let t = (self.now)();
        if inner.rate.len() > 10_000 {
            inner.rate.retain(|_, (_, start, w)| t.saturating_sub(*start) < *w);
            if inner.rate.len() > 10_000 {
                inner.rate.clear();
            }
        }
        let e = inner.rate.entry(key).or_insert((0, t, window));
        if t.saturating_sub(e.1) >= e.2 {
            *e = (0, t, window);
        }
        e.0 += 1;
        if e.0 <= max {
            return 0;
        }
        (e.1 + e.2).saturating_sub(t).div_ceil(1000).max(1)
    }

    fn take_waiter(inner: &mut Inner, watch_hash: &str, side: Side) -> Option<Waiter> {
        let w = inner.by_watch.get_mut(watch_hash)?.waiter(side).take();
        if w.is_some() {
            inner.waiters -= 1;
        }
        w
    }

    /// Answer a side's held request with its current state (or `answer`).
    fn wake(&self, inner: &mut Inner, watch_hash: &str, side: Side, answer: Option<Answer>) {
        let Some(w) = Self::take_waiter(inner, watch_hash, side) else { return };
        let t = (self.now)();
        let a = answer.or_else(|| {
            inner.by_watch.get(watch_hash).map(|s| if side == Side::Device { s.device_answer(w.after, t) } else { s.phone_answer() })
        });
        if let Some(a) = a {
            let _ = w.tx.send(a);
        }
    }

    fn end(&self, inner: &mut Inner, watch_hash: &str, kind: Dead, at: u64) {
        let dw = Self::take_waiter(inner, watch_hash, Side::Device);
        let pw = Self::take_waiter(inner, watch_hash, Side::Phone);
        let Some(s) = inner.by_watch.remove(watch_hash) else { return };
        inner.by_token.remove(&s.token_hash);
        inner.by_code.remove(&s.code_hash);
        if let Some(p) = &s.phone_hash {
            inner.by_phone.remove(p);
        }
        let until = at + TOMBSTONE_MS;
        for h in [Some(&s.watch_hash), Some(&s.token_hash), Some(&s.code_hash), s.phone_hash.as_ref()].into_iter().flatten() {
            inner.dead.insert(h.clone(), Tombstone { kind, until });
        }
        for w in [dw, pw].into_iter().flatten() {
            let _ = w.tx.send(dead_answer(kind));
        }
        Self::line(if kind == Dead::Cancelled { "close" } else { "expire" }, &s);
    }

    /// The live pairing behind `hash` (through `index`, or a watch hash), a tombstone, or nothing.
    fn lookup(&self, inner: &mut Inner, index: Option<fn(&Inner) -> &HashMap<String, String>>, hash: &str) -> Found {
        let t = (self.now)();
        let watch = match index {
            Some(f) => f(inner).get(hash).cloned(),
            None => Some(hash.to_string()),
        };
        if let Some(w) = watch {
            if let Some(until) = inner.by_watch.get(&w).map(|s| s.live_until(t)) {
                if t < until {
                    return Found::Live(w);
                }
                self.end(inner, &w, Dead::Expired, until);
            }
        }
        if let Some(d) = inner.dead.get(hash) {
            if t < d.until {
                return Found::Dead(d.kind);
            }
            inner.dead.remove(hash);
        }
        Found::Missing
    }

    pub fn sweep(&self) {
        let mut inner = self.lock();
        let t = (self.now)();
        let ended: Vec<(String, u64)> =
            inner.by_watch.iter().filter(|(_, s)| t >= s.live_until(t)).map(|(k, s)| (k.clone(), s.live_until(t))).collect();
        for (k, until) in ended {
            self.end(&mut inner, &k, Dead::Expired, until);
        }
        inner.dead.retain(|_, d| t < d.until);
        inner.rate.retain(|_, (_, start, w)| t.saturating_sub(*start) < *w);
    }

    fn ensure_sweeper(&self, inner: &mut Inner) {
        if inner.sweeper {
            return;
        }
        let Ok(handle) = tokio::runtime::Handle::try_current() else { return };
        inner.sweeper = true;
        let me = self.me.clone();
        handle.spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(SWEEP_MS));
            tick.tick().await;
            loop {
                tick.tick().await;
                let Some(sessions) = me.upgrade() else { break };
                sessions.sweep();
            }
        });
    }

    /// Hold a long-poll for `side`; `again` answers it when the hold ends without a wake.
    async fn hold(&self, watch_hash: String, side: Side, after: u64) -> Answer {
        let (rx, id, hold) = {
            let mut inner = self.lock();
            self.wake(&mut inner, &watch_hash, side, None);
            if inner.waiters >= self.caps.waiters {
                return pair_error_retry(503, "OV_PAIR_BUSY", 5);
            }
            let (tx, rx) = oneshot::channel();
            inner.next_waiter += 1;
            let id = inner.next_waiter;
            inner.waiters += 1;
            let t = (self.now)();
            let s = inner.by_watch.get_mut(&watch_hash).expect("live pairing");
            let hold = self.wait_ms.min(s.live_until(t).saturating_sub(t));
            *s.waiter(side) = Some(Waiter { id, tx, after });
            (rx, id, hold)
        };
        let guard = HoldGuard { sessions: self, watch_hash: watch_hash.clone(), side, id };
        let answer = tokio::select! {
            a = rx => a.unwrap_or_else(|_| pair_error(503, "OV_PAIR_UNAVAILABLE")),
            _ = tokio::time::sleep(Duration::from_millis(hold)) => {
                let mut inner = self.lock();
                let mine = inner.by_watch.get(&watch_hash).and_then(|s| match side { Side::Device => s.device_waiter.as_ref(), Side::Phone => s.phone_waiter.as_ref() }).map_or(false, |w| w.id == id);
                if mine {
                    Self::take_waiter(&mut inner, &watch_hash, side);
                }
                let t = (self.now)();
                if side == Side::Device {
                    if let Some(s) = inner.by_watch.get_mut(&watch_hash) {
                        s.device_seen_at = t;
                    }
                }
                match self.lookup(&mut inner, None, &watch_hash) {
                    Found::Live(w) => {
                        let s = &inner.by_watch[&w];
                        if side == Side::Device { s.device_answer(after, t) } else { s.phone_answer() }
                    }
                    Found::Dead(kind) => dead_answer(kind),
                    Found::Missing => pair_error(404, "OV_PAIR_NOT_FOUND"),
                }
            }
        };
        drop(guard);
        let mut inner = self.lock();
        let t = (self.now)();
        if let Some(s) = inner.by_watch.get_mut(&watch_hash) {
            match side {
                Side::Device => s.device_seen_at = s.device_seen_at.max(t),
                Side::Phone => s.phone_seen_at = Some(t),
            }
        }
        answer
    }

    // --- the scoring device ----------------------------------------------------

    /// POST /api/pair/start, after the relay's own auth (`owner`).
    pub fn start(&self, body: &Value, owner: &str) -> Answer {
        let mut inner = self.lock();
        let retry = self.limited(&mut inner, format!("start:{owner}"), self.caps.start_per_owner, RATE_WINDOW_MS);
        if retry > 0 {
            return pair_error_retry(429, "OV_PAIR_RATE_LIMITED", retry);
        }
        let Some(obj) = body.as_object() else { return pair_error(400, "OV_PAIR_BAD_REQUEST") };
        match obj.get("matchKey") {
            None | Some(Value::Null) => {}
            Some(Value::String(s)) if s.trim().encode_utf16().count() <= 128 => {}
            _ => return pair_error(400, "OV_PAIR_BAD_REQUEST"),
        }
        let context = match validate_context(obj.get("context")) {
            Ok(c) => c,
            Err(code) => return pair_error(400, code),
        };
        let room = if owner == "local" { self.caps.total } else { self.caps.total.saturating_sub(self.caps.local_reserve) };
        if inner.by_watch.len() >= room {
            drop(inner);
            self.sweep();
            inner = self.lock();
        }
        if inner.by_watch.len() >= room {
            return pair_error_retry(503, "OV_PAIR_BUSY", 30);
        }
        if inner.by_watch.values().filter(|s| s.owner == owner).count() >= self.caps.per_owner {
            return pair_error_retry(429, "OV_PAIR_RATE_LIMITED", 60);
        }
        let token = base64url(&random_bytes::<32>());
        let watch = base64url(&random_bytes::<32>());
        let mut code = None;
        for _ in 0..8 {
            let c = code_from_bytes(&random_bytes::<5>());
            let h = sha256_hex(&format!("c:{c}"));
            if !inner.by_code.contains_key(&h) && !inner.dead.contains_key(&h) {
                code = Some((c, h));
                break;
            }
        }
        let Some((code, code_hash)) = code else { return pair_error_retry(503, "OV_PAIR_BUSY", 5) };
        let t = (self.now)();
        let token_hash = sha256_hex(&format!("k:{token}"));
        let watch_hash = sha256_hex(&format!("w:{watch}"));
        let s = Session {
            reference: token_hash[..8].to_string(),
            watch_hash: watch_hash.clone(),
            token_hash: token_hash.clone(),
            code_hash: code_hash.clone(),
            phone_hash: None,
            paired: false,
            context,
            owner: owner.to_string(),
            join_by: t + JOIN_TTL_MS,
            ends_at: t + MAX_LIFE_MS,
            device_seen_at: t,
            phone_seen_at: None,
            paired_at: None,
            field: Value::Null,
            v: 0,
            applied: 0,
            inputs: Vec::new(),
            seq: 0,
            last_n: 0,
            device_waiter: None,
            phone_waiter: None,
        };
        Self::line("start", &s);
        let (join_by, ends_at) = (s.join_by, s.ends_at);
        inner.by_token.insert(token_hash, watch_hash.clone());
        inner.by_code.insert(code_hash, watch_hash.clone());
        inner.by_watch.insert(watch_hash, s);
        self.ensure_sweeper(&mut inner);
        ok(201, json!({ "ok": true, "token": token, "code": code, "watch": watch, "joinBy": join_by, "endsAt": ends_at, "path": PAIR_PATH }))
    }

    /// The device's pairing for a body's watch secret.
    fn device_session(&self, inner: &mut Inner, body: &Value) -> Result<String, Answer> {
        let Some(obj) = body.as_object() else { return Err(pair_error(400, "OV_PAIR_BAD_REQUEST")) };
        let Some(watch) = is_secret_shape(obj.get("watch")) else { return Err(pair_error(404, "OV_PAIR_NOT_FOUND")) };
        match self.lookup(inner, None, &sha256_hex(&format!("w:{watch}"))) {
            Found::Live(w) => {
                let t = (self.now)();
                inner.by_watch.get_mut(&w).expect("live").device_seen_at = t;
                Ok(w)
            }
            Found::Dead(kind) => Err(dead_answer(kind)),
            Found::Missing => Err(pair_error(404, "OV_PAIR_NOT_FOUND")),
        }
    }

    /// POST /api/pair/wait (the scoring device).
    pub async fn wait(&self, body: &Value) -> Answer {
        let (w, after) = {
            let mut inner = self.lock();
            let w = match self.device_session(&mut inner, body) {
                Ok(w) => w,
                Err(a) => return a,
            };
            let after = body.get("after").and_then(|v| int_in(v, 0.0, MAX_N)).unwrap_or(0);
            let t = (self.now)();
            let s = inner.by_watch.get_mut(&w).expect("live");
            if after > 0 {
                s.inputs.retain(|i| i["seq"].as_u64().unwrap_or(0) > after);
            }
            let known_phone = body.get("knownPhone").and_then(|v| v.as_bool());
            let ready = body.get("knownState").and_then(|v| v.as_str()) != Some(s.state())
                || s.inputs.iter().any(|i| i["seq"].as_u64().unwrap_or(0) > after)
                || known_phone.map_or(false, |k| k != s.phone_connected(t));
            if ready {
                return s.device_answer(after, t);
            }
            (w, after)
        };
        self.hold(w, Side::Device, after).await
    }

    /// POST /api/pair/focus (the scoring device).
    pub fn focus(&self, body: &Value) -> Answer {
        let mut inner = self.lock();
        let w = match self.device_session(&mut inner, body) {
            Ok(w) => w,
            Err(a) if a.status == 200 => {
                return pair_error(409, if a.body["state"] == "closed" { "OV_PAIR_CANCELLED" } else { "OV_PAIR_EXPIRED" });
            }
            Err(a) => return a,
        };
        let Some(raw) = body.get("field") else { return pair_error(400, "OV_PAIR_BAD_REQUEST") };
        let field = match validate_field(raw) {
            Ok(f) => f,
            Err(code) => return pair_error(400, code),
        };
        let s = inner.by_watch.get_mut(&w).expect("live");
        let applied = match body.get("applied") {
            None | Some(Value::Null) => s.applied,
            Some(v) => match int_in(v, 0.0, MAX_N) {
                Some(n) => n,
                None => return pair_error(400, "OV_PAIR_BAD_REQUEST"),
            },
        };
        if field != s.field || applied != s.applied {
            let new_id = field.get("id").cloned();
            if field.is_null() || s.field.is_null() || s.field.get("id") != new_id.as_ref() {
                s.inputs.retain(|i| new_id.as_ref().map_or(false, |id| i.get("field") == Some(id)));
            }
            s.field = field;
            s.applied = applied;
            s.v += 1;
            self.wake(&mut inner, &w, Side::Phone, None);
        }
        let v = inner.by_watch[&w].v;
        ok(200, json!({ "ok": true, "v": v }))
    }

    /// POST /api/pair/close (the scoring device): unpair; idempotent.
    pub fn close(&self, body: &Value) -> Answer {
        let Some(obj) = body.as_object() else { return pair_error(400, "OV_PAIR_BAD_REQUEST") };
        let Some(watch) = is_secret_shape(obj.get("watch")) else { return pair_error(404, "OV_PAIR_NOT_FOUND") };
        let mut inner = self.lock();
        let h = sha256_hex(&format!("w:{watch}"));
        if inner.by_watch.contains_key(&h) {
            let t = (self.now)();
            self.end(&mut inner, &h, Dead::Cancelled, t);
        }
        ok(200, json!({ "ok": true }))
    }

    // --- the phone ---------------------------------------------------------------

    /// POST /api/pair/join: the token or the code, once.
    pub fn join(&self, body: &Value, ip_key: &str) -> Answer {
        let mut inner = self.lock();
        let retry = self.limited(&mut inner, format!("phone:{ip_key}"), self.caps.phone_per_ip, RATE_WINDOW_MS);
        if retry > 0 {
            return pair_error_retry(429, "OV_PAIR_RATE_LIMITED", retry);
        }
        let Some(obj) = body.as_object() else { return pair_error(400, "OV_PAIR_BAD_REQUEST") };
        let found = if obj.contains_key("k") {
            let Some(k) = is_secret_shape(obj.get("k")) else { return pair_error(404, "OV_PAIR_NOT_FOUND") };
            self.lookup(&mut inner, Some(|i: &Inner| &i.by_token), &sha256_hex(&format!("k:{k}")))
        } else if let Some(raw) = obj.get("code") {
            let retry = self.limited(&mut inner, format!("code:{ip_key}"), self.caps.code_per_ip, RATE_WINDOW_MS);
            if retry > 0 {
                return pair_error_retry(429, "OV_PAIR_RATE_LIMITED", retry);
            }
            let Some(code) = normalize_code(raw) else { return pair_error(404, "OV_PAIR_NOT_FOUND") };
            self.lookup(&mut inner, Some(|i: &Inner| &i.by_code), &sha256_hex(&format!("c:{code}")))
        } else {
            return pair_error(400, "OV_PAIR_BAD_REQUEST");
        };
        let w = match found {
            Found::Live(w) => w,
            Found::Dead(kind) => return dead_error(kind),
            Found::Missing => return pair_error(404, "OV_PAIR_NOT_FOUND"),
        };
        if inner.by_watch[&w].paired {
            return pair_error(409, "OV_PAIR_USED");
        }
        let phone = base64url(&random_bytes::<32>());
        let phone_hash = sha256_hex(&format!("p:{phone}"));
        let t = (self.now)();
        inner.by_phone.insert(phone_hash.clone(), w.clone());
        let s = inner.by_watch.get_mut(&w).expect("live");
        s.phone_hash = Some(phone_hash);
        s.paired = true;
        s.paired_at = Some(t);
        s.phone_seen_at = Some(t);
        Self::line("join", s);
        let answer = json!({ "ok": true, "phone": phone, "state": "paired", "context": s.context, "endsAt": s.ends_at });
        self.wake(&mut inner, &w, Side::Device, None);
        ok(200, answer)
    }

    /// The phone's rate limit and lookup by its secret: Ok(watch hash), or Err(the answer / tombstone).
    fn phone_session(&self, inner: &mut Inner, body: &Value, ip_key: &str) -> Result<String, Result<Dead, Answer>> {
        let retry = self.limited(inner, format!("phone:{ip_key}"), self.caps.phone_per_ip, RATE_WINDOW_MS);
        if retry > 0 {
            return Err(Err(pair_error_retry(429, "OV_PAIR_RATE_LIMITED", retry)));
        }
        let Some(obj) = body.as_object() else { return Err(Err(pair_error(400, "OV_PAIR_BAD_REQUEST"))) };
        let Some(p) = is_secret_shape(obj.get("phone")) else { return Err(Err(pair_error(404, "OV_PAIR_NOT_FOUND"))) };
        match self.lookup(inner, Some(|i: &Inner| &i.by_phone), &sha256_hex(&format!("p:{p}"))) {
            Found::Live(w) => {
                let t = (self.now)();
                let s = inner.by_watch.get_mut(&w).expect("live");
                let was = s.phone_connected(t);
                s.phone_seen_at = Some(t);
                if !was {
                    self.wake(inner, &w, Side::Device, None);
                }
                Ok(w)
            }
            Found::Dead(kind) => Err(Ok(kind)),
            Found::Missing => Err(Err(pair_error(404, "OV_PAIR_NOT_FOUND"))),
        }
    }

    /// POST /api/pair/poll (the phone).
    pub async fn poll(&self, body: &Value, ip_key: &str) -> Answer {
        let w = {
            let mut inner = self.lock();
            let w = match self.phone_session(&mut inner, body, ip_key) {
                Ok(w) => w,
                Err(Ok(kind)) => return dead_answer(kind),
                Err(Err(a)) => return a,
            };
            let s = &inner.by_watch[&w];
            let known = body.get("known").and_then(|v| v.as_f64());
            if known != Some(s.v as f64) {
                return s.phone_answer();
            }
            w
        };
        self.hold(w, Side::Phone, 0).await
    }

    /// POST /api/pair/input (the phone).
    pub fn input(&self, body: &Value, ip_key: &str) -> Answer {
        let mut inner = self.lock();
        let w = match self.phone_session(&mut inner, body, ip_key) {
            Ok(w) => w,
            Err(Ok(kind)) => return dead_error(kind),
            Err(Err(a)) => return a,
        };
        let reference = inner.by_watch[&w].reference.clone();
        let burst = self.limited(&mut inner, format!("burst:{reference}"), self.caps.input_burst, BURST_WINDOW_MS);
        if burst > 0 {
            return pair_error_retry(429, "OV_PAIR_RATE_LIMITED", burst);
        }
        let obj = body.as_object().expect("an object");
        let s = inner.by_watch.get_mut(&w).expect("live");
        if let Some(n) = obj.get("n").and_then(|v| int_in(v, 1.0, MAX_N)) {
            if n <= s.last_n {
                return ok(200, json!({ "ok": true, "seq": s.seq, "duplicate": true }));
            }
        }
        let mut inp = match validate_input(obj, &s.field) {
            Ok(i) => i,
            Err(code) => return pair_error(if code == "OV_PAIR_STALE" || code == "OV_PAIR_NO_FIELD" { 409 } else { 400 }, code),
        };
        let text_only = inp.contains_key("text") && !inp.contains_key("action");
        if text_only {
            if let Some(last) = s.inputs.last() {
                if last.get("field") == inp.get("field") && last.get("text").is_some() && last.get("action").is_none() {
                    s.inputs.pop();
                }
            }
        }
        if s.inputs.len() >= INPUT_QUEUE_MAX {
            return pair_error_retry(429, "OV_PAIR_RATE_LIMITED", 1);
        }
        s.seq += 1;
        s.last_n = inp["n"].as_u64().unwrap_or(0);
        if let Some(t) = inp.get("text").cloned() {
            if s.field.is_object() {
                s.field["text"] = t;
            }
        }
        inp.insert("seq".into(), json!(s.seq));
        s.inputs.push(Value::Object(inp));
        let seq = s.seq;
        self.wake(&mut inner, &w, Side::Device, None);
        ok(200, json!({ "ok": true, "seq": seq }))
    }

    #[allow(dead_code)]
    pub fn dispose(&self) {
        let mut inner = self.lock();
        let keys: Vec<String> = inner.by_watch.keys().cloned().collect();
        for k in keys {
            for side in [Side::Device, Side::Phone] {
                if let Some(w) = Self::take_waiter(&mut inner, &k, side) {
                    let _ = w.tx.send(pair_error(503, "OV_PAIR_UNAVAILABLE"));
                }
            }
        }
        *inner = Inner { sweeper: inner.sweeper, next_waiter: inner.next_waiter, ..Inner::default() };
    }

    /// (live pairings, tombstones, held requests), for tests and status.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn stats(&self) -> (usize, usize, usize) {
        let inner = self.lock();
        (inner.by_watch.len(), inner.dead.len(), inner.waiters)
    }
}

/// Removes a held request's waiter when its future ends or is dropped.
struct HoldGuard<'a> {
    sessions: &'a PairSessions,
    watch_hash: String,
    side: Side,
    id: u64,
}

impl Drop for HoldGuard<'_> {
    fn drop(&mut self) {
        let mut inner = self.sessions.lock();
        let mine = inner
            .by_watch
            .get(&self.watch_hash)
            .and_then(|s| match self.side {
                Side::Device => s.device_waiter.as_ref(),
                Side::Phone => s.phone_waiter.as_ref(),
            })
            .map_or(false, |w| w.id == self.id);
        if mine {
            PairSessions::take_waiter(&mut inner, &self.watch_hash, self.side);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    const VECTORS: &str = include_str!("../../electron/__fixtures__/pair-vectors.json");

    fn fill(v: &Value, saved: &HashMap<&'static str, String>) -> Value {
        match v {
            Value::Object(o) if o.get("$repeat").map_or(false, |r| r.is_array()) => {
                let r = o["$repeat"].as_array().unwrap();
                json!(r[0].as_str().unwrap().repeat(r[1].as_u64().unwrap() as usize))
            }
            Value::String(s) if s.starts_with('$') => saved.get(&s[1..]).map(|x| json!(x)).unwrap_or_else(|| v.clone()),
            Value::Array(a) => Value::Array(a.iter().map(|x| fill(x, saved)).collect()),
            Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), fill(x, saved))).collect()),
            _ => v.clone(),
        }
    }

    fn check(answer: &Answer, expect: &Value) -> Vec<String> {
        let mut out = Vec::new();
        for (k, want) in expect.as_object().unwrap() {
            match k.as_str() {
                "status" => {
                    if json!(answer.status) != *want {
                        out.push(format!("status {} != {want} ({})", answer.status, answer.body));
                    }
                }
                "has" => {
                    for key in want.as_array().unwrap() {
                        if answer.body.get(key.as_str().unwrap()).is_none() {
                            out.push(format!("body lacks {key}"));
                        }
                    }
                }
                "lacks" => {
                    for key in want.as_array().unwrap() {
                        if answer.body.get(key.as_str().unwrap()).is_some() {
                            out.push(format!("body has {key}"));
                        }
                    }
                }
                "retryAfter" => {
                    if want.as_bool() == Some(true) && !answer.retry_after.map_or(false, |r| r > 0) {
                        out.push("no Retry-After".into());
                    }
                }
                _ => {
                    let got = answer.body.get(k).cloned().unwrap_or(Value::Null);
                    if got != *want {
                        out.push(format!("{k}: {got} != {want}"));
                    }
                }
            }
        }
        out
    }

    #[tokio::test]
    async fn agrees_with_every_shared_vector() {
        let vectors: Value = serde_json::from_str(VECTORS).expect("pair-vectors.json");
        let none = HashMap::new();
        let mut failures = Vec::new();
        for v in vectors["context"].as_array().unwrap() {
            let r = validate_context(Some(&fill(&v["in"], &none)));
            match (v.get("error"), r) {
                (Some(e), Err(code)) if e == code => {}
                (None, Ok(c)) if c == fill(&v["out"], &none) => {}
                (_, r) => failures.push(format!("context {}: {r:?}", v["name"])),
            }
        }
        for v in vectors["fields"].as_array().unwrap() {
            let r = validate_field(&fill(&v["in"], &none));
            match (v.get("error"), r) {
                (Some(e), Err(code)) if e == code => {}
                (None, Ok(f)) if f == fill(&v["out"], &none) => {}
                (_, r) => failures.push(format!("field {}: {r:?}", v["name"])),
            }
        }
        for v in vectors["codes"].as_array().unwrap() {
            let r = normalize_code(&v["in"]);
            if r.map(Value::from).unwrap_or(Value::Null) != v["out"] {
                failures.push(format!("code {}", v["in"]));
            }
        }
        for flow in vectors["flows"].as_array().unwrap() {
            let clock = Arc::new(AtomicU64::new(0));
            let c = clock.clone();
            let mut caps = LAN_CAPS;
            if let Some(o) = flow.get("caps").and_then(|c| c.as_object()) {
                for (k, v) in o {
                    let n = v.as_u64().unwrap();
                    match k.as_str() {
                        "total" => caps.total = n as usize,
                        "perOwner" => caps.per_owner = n as usize,
                        "startPerOwner" => caps.start_per_owner = n as u32,
                        "phonePerIp" => caps.phone_per_ip = n as u32,
                        "codePerIp" => caps.code_per_ip = n as u32,
                        "inputBurst" => caps.input_burst = n as u32,
                        "waiters" => caps.waiters = n as usize,
                        "localReserve" => caps.local_reserve = n as usize,
                        other => panic!("unknown cap {other}"),
                    }
                }
            }
            let sessions = PairSessions::new(caps, 0, Arc::new(move || c.load(Ordering::SeqCst)));
            let mut saved: HashMap<&'static str, String> = HashMap::new();
            for (i, step) in flow["steps"].as_array().unwrap().iter().enumerate() {
                if let Some(at) = step.get("at").and_then(|v| v.as_u64()) {
                    clock.store(at, Ordering::SeqCst);
                }
                let body = fill(&step["body"], &saved);
                let owner = step.get("owner").and_then(|v| v.as_str()).unwrap_or("local");
                let ip = step.get("ip").and_then(|v| v.as_str()).unwrap_or("192.0.2.1");
                let op = step["op"].as_str().unwrap();
                let r = match op {
                    "start" => sessions.start(&body, owner),
                    "wait" => sessions.wait(&body).await,
                    "focus" => sessions.focus(&body),
                    "close" => sessions.close(&body),
                    "join" => sessions.join(&body, ip),
                    "poll" => sessions.poll(&body, ip).await,
                    "input" => sessions.input(&body, ip),
                    other => panic!("unknown op {other}"),
                };
                if op == "start" && r.status == 201 {
                    let code = r.body["code"].as_str().unwrap().to_string();
                    saved.insert("codeDashed", format!("{}-{}", &code[..4], &code[4..]));
                    saved.insert("code", code);
                    saved.insert("token", r.body["token"].as_str().unwrap().to_string());
                    saved.insert("watch", r.body["watch"].as_str().unwrap().to_string());
                }
                if op == "join" && r.status == 200 {
                    saved.insert("phone", r.body["phone"].as_str().unwrap().to_string());
                }
                for f in check(&r, &fill(step.get("expect").unwrap_or(&json!({})), &saved)) {
                    failures.push(format!("flow {} step {i} ({op}): {f}", flow["name"]));
                }
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    #[test]
    fn the_code_takes_40_bits() {
        assert_eq!(code_from_bytes(&[0, 0, 0, 0, 0]), "AAAAAAAA");
        assert_eq!(code_from_bytes(&[255, 255, 255, 255, 255]), "99999999");
        // the same symbols as the JS core for the same bytes
        assert_eq!(code_from_bytes(&[1, 2, 3, 4, 5]), "AEBAGBAF");
    }

    #[test]
    fn secrets_and_codes_come_from_the_os_source() {
        // random_bytes(): getrandom's SysRng (the system CSPRNG). The 32-byte
        // secrets are the token shape and all different; the codes are 8
        // symbols of the alphabet and over 2000 of them every symbol shows up
        let mut secrets = std::collections::HashSet::new();
        let mut symbols = std::collections::HashSet::new();
        for _ in 0..2000 {
            let s = base64url(&random_bytes::<32>());
            assert!(is_secret_shape(Some(&json!(s))).is_some(), "{s}");
            assert!(secrets.insert(s));
            let c = code_from_bytes(&random_bytes::<5>());
            assert_eq!(c.len(), 8);
            assert_eq!(normalize_code(&json!(c)).as_deref(), Some(c.as_str()));
            symbols.extend(c.bytes());
        }
        assert_eq!(symbols.len(), CODE_ALPHABET.len());
    }

    #[tokio::test]
    async fn held_requests_wake_on_join_input_focus_and_close() {
        let sessions = PairSessions::new(LAN_CAPS, 25_000, system_clock());
        let started = sessions.start(&json!({ "context": { "home": "A", "away": "B" } }), "local").body;
        let watch = started["watch"].as_str().unwrap().to_string();
        let s2 = sessions.clone();
        let w = watch.clone();
        let held = tokio::spawn(async move { s2.wait(&json!({ "watch": w, "knownState": "pending", "after": 0, "knownPhone": false })).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        let phone = sessions.join(&json!({ "k": started["token"] }), "ip").body["phone"].as_str().unwrap().to_string();
        assert_eq!(held.await.unwrap().body["state"], "paired");

        let s3 = sessions.clone();
        let p = phone.clone();
        let polled = tokio::spawn(async move { s3.poll(&json!({ "phone": p, "known": 0 }), "ip").await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        sessions.focus(&json!({ "watch": watch, "field": { "id": "ov-remarks", "kind": "multiline" } }));
        assert_eq!(polled.await.unwrap().body["field"]["id"], "ov-remarks");

        let s4 = sessions.clone();
        let w = watch.clone();
        let held = tokio::spawn(async move { s4.wait(&json!({ "watch": w, "knownState": "paired", "after": 0, "knownPhone": true })).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        sessions.input(&json!({ "phone": phone, "n": 1, "field": "ov-remarks", "text": "Hi" }), "ip");
        assert_eq!(held.await.unwrap().body["inputs"][0]["text"], "Hi");

        let s5 = sessions.clone();
        let p = phone.clone();
        let polled = tokio::spawn(async move { s5.poll(&json!({ "phone": p, "known": 1 }), "ip").await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        sessions.close(&json!({ "watch": watch }));
        assert_eq!(polled.await.unwrap().body["state"], "closed");
        assert_eq!(sessions.stats().2, 0);
    }
}
