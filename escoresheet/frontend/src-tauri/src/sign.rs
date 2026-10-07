//! "Sign on phone" sessions (docs/qr-signing-spec.md, section 4): the Rust port
//! of `electron/signSessionCore.cjs`. Same endpoints, bodies, answers and codes;
//! the shared vectors in `electron/__fixtures__/sign-vectors.json` run against
//! both (the test module below).
//!
//!   start  { slot, matchKey?, context }  -> 201 { ok, token, watch, expiresAt, ttlSeconds, path }
//!   open   { k }                         -> 200 { ok, state:"opened", slot, context, expiresAt }
//!   submit { k, pad, strokes }           -> 200 { ok }                 (single use)
//!   wait   { watch, known? }             -> 200 { ok, state, ... }      (long-poll, <= 25 s)
//!   close  { watch }                     -> 200 { ok }                  (idempotent)
//!
//! Only SHA-256 hashes of the token and the watch secret are kept, in memory.
//! Nothing is logged but `sign.<event> ref=<8 hex> slot=<slot> via=lan`.
//! The relay (relay.rs) does the auth of `start` and reads the bodies.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use rand::RngCore;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;
use unicode_normalization::UnicodeNormalization;

pub const SIGN_TTL_MS: u64 = 10 * 60 * 1000;
pub const SIGNED_TTL_MS: u64 = 5 * 60 * 1000;
pub const MAX_LIFE_MS: u64 = 15 * 60 * 1000;
pub const TOMBSTONE_MS: u64 = 60 * 1000;
pub const WAIT_MS: u64 = 25 * 1000;
pub const SWEEP_MS: u64 = 60 * 1000;
pub const RATE_WINDOW_MS: u64 = 5 * 60 * 1000;
pub const SUBMIT_BODY_MAX: usize = 64 * 1024;
pub const BODY_MAX: usize = 4 * 1024;
pub const SIGN_PATH: &str = "/sign";

/// Headers of the phone page (/sign*), spec 4.7.
pub const SIGN_PAGE_CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Caps {
    pub total: usize,
    pub per_owner: usize,
    pub start_per_owner: u32,
    pub phone_per_ip: u32,
    pub waiters: usize,
}

pub const LAN_CAPS: Caps = Caps { total: 200, per_owner: 20, start_per_owner: 60, phone_per_ip: 600, waiters: 200 };

pub const SLOTS: &[&str] = &[
    "captain-a", "captain-b", "asst-scorer", "scorer", "ref2", "ref1",
    "coach-home", "coach-away", "captain-home", "captain-away",
    "captain-post-home", "captain-post-away",
];
const LANGS: &[&str] = &["en", "de", "de-CH", "fr", "it"];
const CONTEXT_TEXT: &[(&str, usize, bool)] =
    &[("matchNo", 20, false), ("home", 60, true), ("away", 60, true), ("name", 80, false), ("when", 32, false)];
const CONTEXT_ENUM: &[(&str, &[&str])] = &[("teamSide", &["home", "away"]), ("teamLabel", &["A", "B"]), ("lang", LANGS)];

const PAD_W: i64 = 4000;
const PAD_H_MIN: i64 = 1000;
const PAD_H_MAX: i64 = 4000;
const MAX_STROKES: usize = 300;
const MAX_STROKE_LEN: usize = 2000;
const MAX_POINTS: usize = 4000;
const MIN_INK: f64 = 0.06 * PAD_W as f64;

fn message(code: &str) -> &'static str {
    match code {
        "OV_SIGN_BAD_REQUEST" => "Invalid request",
        "OV_SIGN_SLOT" => "Unknown signature slot",
        "OV_SIGN_CONTEXT" => "Both team names are needed",
        "OV_SIGN_INK_INVALID" => "The signature is empty or invalid",
        "OV_SIGN_FORBIDDEN" => "This device may not start phone signing",
        "OV_SIGN_PIN_INVALID" => "Wrong game PIN",
        "OV_SIGN_NOT_FOUND" => "This link is not valid",
        "OV_SIGN_USED" => "This link was already used",
        "OV_SIGN_CANCELLED" => "Signing was cancelled on the scoring device",
        "OV_SIGN_EXPIRED" => "This link has expired",
        "OV_SIGN_TOO_LARGE" => "Request body too large",
        "OV_SIGN_RATE_LIMITED" => "Too many requests. Please wait a moment.",
        "OV_SIGN_BUSY" => "Phone signing is busy. Try again in a moment.",
        "OV_SIGN_UNAVAILABLE" => "Phone signing is not available on this server",
        _ => "Error",
    }
}

/// One answer of the protocol: HTTP status, JSON body, optional Retry-After (s).
#[derive(Debug, Clone, PartialEq)]
pub struct Answer {
    pub status: u16,
    pub body: Value,
    pub retry_after: Option<u64>,
}

impl Answer {
    fn ok(status: u16, body: Value) -> Self {
        Answer { status, body, retry_after: None }
    }
}

pub fn sign_error(status: u16, code: &str) -> Answer {
    Answer::ok(status, json!({ "ok": false, "code": code, "message": message(code) }))
}

fn sign_error_retry(status: u16, code: &str, retry_after: u64) -> Answer {
    Answer { retry_after: Some(retry_after), ..sign_error(status, code) }
}

/// Which endpoint a path is ("start" | "open" | "submit" | "wait" | "close").
pub fn endpoint_of(path: &str) -> Option<&'static str> {
    match path {
        "/api/sign/start" => Some("start"),
        "/api/sign/open" => Some("open"),
        "/api/sign/submit" => Some("submit"),
        "/api/sign/wait" => Some("wait"),
        "/api/sign/close" => Some("close"),
        _ => None,
    }
}

pub fn body_limit(endpoint: &str) -> usize {
    if endpoint == "submit" { SUBMIT_BODY_MAX } else { BODY_MAX }
}

/// /sign, /sign/ and everything below it.
pub fn is_sign_page_path(path: &str) -> bool {
    path == SIGN_PATH || path.starts_with("/sign/")
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

pub fn sha256_hex(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

const B64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// base64url without padding (32 bytes -> 43 characters).
pub fn base64url(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 4 / 3 + 2);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        let chars = chunk.len() + 1;
        for i in 0..chars {
            out.push(B64URL[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

fn new_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    base64url(&bytes)
}

/// 43 base64url characters: the only shape a token or watch secret has.
pub fn is_secret_shape(v: Option<&Value>) -> Option<&str> {
    let s = v?.as_str()?;
    if s.len() == 43 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        Some(s)
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Validation (same rules as signSessionCore.cjs)
// ---------------------------------------------------------------------------

fn is_removed(c: char) -> bool {
    matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

fn is_edge_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// NFC, control and bidi characters removed, trimmed, cut to `max` code points.
pub fn sanitize_text(value: &str, max: usize) -> String {
    let s: String = value.nfc().filter(|c| !is_removed(*c)).collect();
    let s = s.trim_matches(is_edge_space);
    if s.chars().count() > max {
        let cut: String = s.chars().take(max).collect();
        cut.trim_matches(is_edge_space).to_string()
    } else {
        s.to_string()
    }
}

/// Ok(context) or Err(code), see signSessionCore validateContext.
pub fn validate_context(raw: Option<&Value>) -> Result<Value, &'static str> {
    let Some(obj) = raw.and_then(|v| v.as_object()) else { return Err("OV_SIGN_BAD_REQUEST") };
    let mut out = Map::new();
    for (key, max, required) in CONTEXT_TEXT {
        match obj.get(*key) {
            None | Some(Value::Null) => {
                if *required {
                    return Err("OV_SIGN_CONTEXT");
                }
            }
            Some(Value::String(s)) => {
                let clean = sanitize_text(s, *max);
                if clean.is_empty() {
                    if *required {
                        return Err("OV_SIGN_CONTEXT");
                    }
                } else {
                    out.insert((*key).to_string(), json!(clean));
                }
            }
            Some(_) => return Err("OV_SIGN_BAD_REQUEST"),
        }
    }
    for (key, allowed) in CONTEXT_ENUM {
        match obj.get(*key) {
            None | Some(Value::Null) => {}
            Some(Value::String(s)) => {
                if allowed.contains(&s.as_str()) {
                    out.insert((*key).to_string(), json!(s));
                }
            }
            Some(_) => return Err("OV_SIGN_BAD_REQUEST"),
        }
    }
    Ok(Value::Object(out))
}

/// An integral JSON number in lo..=hi ("5" and "5.0" alike), as i64.
fn int_in(v: &Value, lo: i64, hi: i64) -> Option<i64> {
    let n = if let Some(i) = v.as_i64() {
        i
    } else {
        let f = v.as_f64()?;
        if f.fract() != 0.0 || !f.is_finite() || f < lo as f64 || f > hi as f64 {
            return None;
        }
        f as i64
    };
    (lo..=hi).contains(&n).then_some(n)
}

/// Ok((pad, strokes)) with integers, or Err("OV_SIGN_INK_INVALID").
pub fn validate_strokes(pad: Option<&Value>, strokes: Option<&Value>) -> Result<(Value, Value), &'static str> {
    const BAD: &str = "OV_SIGN_INK_INVALID";
    let pad = pad.and_then(|p| p.as_object()).ok_or(BAD)?;
    let w = pad.get("w").and_then(|v| int_in(v, PAD_W, PAD_W)).ok_or(BAD)?;
    let h = pad.get("h").and_then(|v| int_in(v, PAD_H_MIN, PAD_H_MAX)).ok_or(BAD)?;
    let list = strokes.and_then(|s| s.as_array()).ok_or(BAD)?;
    if list.is_empty() || list.len() > MAX_STROKES {
        return Err(BAD);
    }
    let mut points = 0usize;
    let mut ink = 0f64;
    let mut clean = Vec::with_capacity(list.len());
    for stroke in list {
        let s = stroke.as_array().ok_or(BAD)?;
        if s.len() < 2 || s.len() > MAX_STROKE_LEN || s.len() % 2 != 0 {
            return Err(BAD);
        }
        points += s.len() / 2;
        if points > MAX_POINTS {
            return Err(BAD);
        }
        let mut out: Vec<i64> = Vec::with_capacity(s.len());
        for pair in s.chunks(2) {
            let x = int_in(&pair[0], 0, w).ok_or(BAD)?;
            let y = int_in(&pair[1], 0, h).ok_or(BAD)?;
            if out.len() >= 2 {
                let dx = (x - out[out.len() - 2]) as f64;
                let dy = (y - out[out.len() - 1]) as f64;
                ink += (dx * dx + dy * dy).sqrt();
            }
            out.push(x);
            out.push(y);
        }
        clean.push(json!(out));
    }
    if !(ink >= MIN_INK) {
        return Err(BAD);
    }
    Ok((json!({ "w": w, "h": h }), Value::Array(clean)))
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum State {
    Pending,
    Opened,
    Signed,
}

impl State {
    fn as_str(self) -> &'static str {
        match self {
            State::Pending => "pending",
            State::Opened => "opened",
            State::Signed => "signed",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Dead {
    Expired,
    Cancelled,
    Used,
}

struct Tombstone {
    kind: Dead,
    until: u64,
}

struct Waiter {
    id: u64,
    tx: oneshot::Sender<Answer>,
}

struct Session {
    token_hash: String,
    watch_hash: String,
    reference: String,
    state: State,
    slot: String,
    context: Value,
    owner: String,
    created_at: u64,
    expires_at: u64,
    opened_at: Option<u64>,
    signed_at: Option<u64>,
    pad: Option<Value>,
    strokes: Option<Value>,
    waiter: Option<Waiter>,
}

impl Session {
    fn live_until(&self) -> u64 {
        match (self.state, self.signed_at) {
            (State::Signed, Some(at)) => (at + SIGNED_TTL_MS).min(self.created_at + MAX_LIFE_MS),
            _ => self.expires_at,
        }
    }

    fn wait_answer(&self) -> Answer {
        let mut body = json!({ "ok": true, "state": self.state.as_str(), "expiresAt": self.expires_at });
        if let Some(at) = self.opened_at {
            body["openedAt"] = json!(at);
        }
        if let Some(at) = self.signed_at {
            body["signedAt"] = json!(at);
        }
        if self.state == State::Signed {
            body["pad"] = self.pad.clone().unwrap_or(Value::Null);
            body["strokes"] = self.strokes.clone().unwrap_or(Value::Null);
        }
        Answer::ok(200, body)
    }
}

fn dead_wait_answer(kind: Dead) -> Answer {
    let state = if kind == Dead::Cancelled { "closed" } else { "expired" };
    Answer::ok(200, json!({ "ok": true, "state": state }))
}

fn dead_token_error(kind: Dead) -> Answer {
    match kind {
        Dead::Used => sign_error(409, "OV_SIGN_USED"),
        Dead::Cancelled => sign_error(409, "OV_SIGN_CANCELLED"),
        Dead::Expired => sign_error(410, "OV_SIGN_EXPIRED"),
    }
}

#[derive(Default)]
struct Inner {
    by_token: HashMap<String, Session>,
    /// watch hash -> token hash
    by_watch: HashMap<String, String>,
    dead_tokens: HashMap<String, Tombstone>,
    dead_watches: HashMap<String, Tombstone>,
    rate: HashMap<String, (u32, u64)>,
    waiters: usize,
    next_waiter: u64,
    sweeper: bool,
}

enum Found {
    Live,
    Dead(Dead),
    Missing,
}

pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

pub fn system_clock() -> Clock {
    Arc::new(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    })
}

/// The session table of one relay.
pub struct SignSessions {
    inner: Mutex<Inner>,
    caps: Caps,
    wait_ms: u64,
    now: Clock,
    me: Weak<SignSessions>,
}

impl SignSessions {
    pub fn new(caps: Caps, wait_ms: u64, now: Clock) -> Arc<Self> {
        Arc::new_cyclic(|me| SignSessions { inner: Mutex::new(Inner::default()), caps, wait_ms, now, me: me.clone() })
    }

    pub fn lan() -> Arc<Self> {
        Self::new(LAN_CAPS, WAIT_MS, system_clock())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn line(event: &str, s: &Session) {
        println!("[Sign] sign.{event} ref={} slot={} via=lan", s.reference, s.slot);
    }

    /// Fixed 5-minute window: counts one hit, returns the seconds to wait or 0.
    fn limited(&self, inner: &mut Inner, key: String, max: u32) -> u64 {
        let t = (self.now)();
        if inner.rate.len() > 10_000 {
            inner.rate.retain(|_, (_, start)| t.saturating_sub(*start) < RATE_WINDOW_MS);
            if inner.rate.len() > 10_000 {
                inner.rate.clear();
            }
        }
        let e = inner.rate.entry(key).or_insert((0, t));
        if t.saturating_sub(e.1) >= RATE_WINDOW_MS {
            *e = (0, t);
        }
        e.0 += 1;
        if e.0 <= max {
            return 0;
        }
        (e.1 + RATE_WINDOW_MS).saturating_sub(t).div_ceil(1000).max(1)
    }

    /// Take the session's waiter (it is answered by the caller or dropped).
    fn take_waiter(inner: &mut Inner, token_hash: &str) -> Option<Waiter> {
        let w = inner.by_token.get_mut(token_hash)?.waiter.take();
        if w.is_some() {
            inner.waiters -= 1;
        }
        w
    }

    fn wake(inner: &mut Inner, token_hash: &str) {
        let answer = inner.by_token.get(token_hash).map(|s| s.wait_answer());
        if let (Some(w), Some(a)) = (Self::take_waiter(inner, token_hash), answer) {
            let _ = w.tx.send(a);
        }
    }

    /// End a session ("expired" | "cancelled"); a signed one's token stays "used".
    fn end(inner: &mut Inner, token_hash: &str, kind: Dead, at: u64) {
        let waiter = Self::take_waiter(inner, token_hash);
        let Some(s) = inner.by_token.remove(token_hash) else { return };
        inner.by_watch.remove(&s.watch_hash);
        let until = at + TOMBSTONE_MS;
        let token_kind = if s.state == State::Signed { Dead::Used } else { kind };
        inner.dead_tokens.insert(s.token_hash.clone(), Tombstone { kind: token_kind, until });
        inner.dead_watches.insert(s.watch_hash.clone(), Tombstone { kind, until });
        if let Some(w) = waiter {
            let _ = w.tx.send(dead_wait_answer(kind));
        }
        Self::line(if kind == Dead::Cancelled { "close" } else { "expire" }, &s);
    }

    /// The live session for a token hash (ends it when it has run out), a tombstone or nothing.
    fn lookup_token(&self, inner: &mut Inner, token_hash: &str) -> Found {
        let t = (self.now)();
        if let Some(until) = inner.by_token.get(token_hash).map(|s| s.live_until()) {
            if t < until {
                return Found::Live;
            }
            Self::end(inner, token_hash, Dead::Expired, until);
        }
        if let Some(d) = inner.dead_tokens.get(token_hash) {
            if t < d.until {
                return Found::Dead(d.kind);
            }
            inner.dead_tokens.remove(token_hash);
        }
        Found::Missing
    }

    /// Same by watch hash: Some(token hash) when live.
    fn lookup_watch(&self, inner: &mut Inner, watch_hash: &str) -> Result<String, Found> {
        let t = (self.now)();
        if let Some(token_hash) = inner.by_watch.get(watch_hash).cloned() {
            let until = inner.by_token.get(&token_hash).map(|s| s.live_until()).unwrap_or(0);
            if t < until {
                return Ok(token_hash);
            }
            Self::end(inner, &token_hash, Dead::Expired, until);
        }
        if let Some(d) = inner.dead_watches.get(watch_hash) {
            if t < d.until {
                return Err(Found::Dead(d.kind));
            }
            inner.dead_watches.remove(watch_hash);
        }
        Err(Found::Missing)
    }

    /// Ends what has run out and forgets old tombstones and counters.
    pub fn sweep(&self) {
        let mut inner = self.lock();
        let t = (self.now)();
        let ended: Vec<(String, u64)> = inner
            .by_token
            .iter()
            .filter(|(_, s)| t >= s.live_until())
            .map(|(k, s)| (k.clone(), s.live_until()))
            .collect();
        for (k, until) in ended {
            Self::end(&mut inner, &k, Dead::Expired, until);
        }
        inner.dead_tokens.retain(|_, d| t < d.until);
        inner.dead_watches.retain(|_, d| t < d.until);
        inner.rate.retain(|_, (_, start)| t.saturating_sub(*start) < RATE_WINDOW_MS);
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
                // Gone with its relay: the task ends
                let Some(sessions) = me.upgrade() else { break };
                sessions.sweep();
            }
        });
    }

    /// POST /api/sign/start, after the relay's own auth (`owner`).
    pub fn start(&self, body: &Value, owner: &str) -> Answer {
        let mut inner = self.lock();
        let retry = self.limited(&mut inner, format!("start:{owner}"), self.caps.start_per_owner);
        if retry > 0 {
            return sign_error_retry(429, "OV_SIGN_RATE_LIMITED", retry);
        }
        let Some(obj) = body.as_object() else { return sign_error(400, "OV_SIGN_BAD_REQUEST") };
        let slot = match obj.get("slot").and_then(|v| v.as_str()) {
            Some(s) if SLOTS.contains(&s) => s.to_string(),
            _ => return sign_error(400, "OV_SIGN_SLOT"),
        };
        match obj.get("matchKey") {
            None | Some(Value::Null) => {}
            // .length of the trimmed text in JS: UTF-16 units
            Some(Value::String(s)) if s.trim().encode_utf16().count() <= 128 => {}
            _ => return sign_error(400, "OV_SIGN_BAD_REQUEST"),
        }
        let context = match validate_context(obj.get("context")) {
            Ok(c) => c,
            Err(code) => return sign_error(400, code),
        };
        if inner.by_token.len() >= self.caps.total {
            drop(inner);
            self.sweep();
            inner = self.lock();
        }
        if inner.by_token.len() >= self.caps.total {
            return sign_error_retry(503, "OV_SIGN_BUSY", 30);
        }
        if inner.by_token.values().filter(|s| s.owner == owner).count() >= self.caps.per_owner {
            return sign_error_retry(429, "OV_SIGN_RATE_LIMITED", 60);
        }
        let token = new_secret();
        let watch = new_secret();
        let t = (self.now)();
        let token_hash = sha256_hex(&token);
        let watch_hash = sha256_hex(&watch);
        let s = Session {
            reference: token_hash[..8].to_string(),
            token_hash: token_hash.clone(),
            watch_hash: watch_hash.clone(),
            state: State::Pending,
            slot,
            context,
            owner: owner.to_string(),
            created_at: t,
            expires_at: t + SIGN_TTL_MS,
            opened_at: None,
            signed_at: None,
            pad: None,
            strokes: None,
            waiter: None,
        };
        Self::line("start", &s);
        let expires_at = s.expires_at;
        inner.by_watch.insert(watch_hash, token_hash.clone());
        inner.by_token.insert(token_hash, s);
        self.ensure_sweeper(&mut inner);
        Answer::ok(
            201,
            json!({ "ok": true, "token": token, "watch": watch, "expiresAt": expires_at, "ttlSeconds": SIGN_TTL_MS / 1000, "path": SIGN_PATH }),
        )
    }

    /// The phone's rate limit and token lookup: Ok(token hash) or the error answer.
    fn phone_session(&self, inner: &mut Inner, body: &Value, ip_key: &str) -> Result<String, Answer> {
        let retry = self.limited(inner, format!("phone:{ip_key}"), self.caps.phone_per_ip);
        if retry > 0 {
            return Err(sign_error_retry(429, "OV_SIGN_RATE_LIMITED", retry));
        }
        let Some(obj) = body.as_object() else { return Err(sign_error(400, "OV_SIGN_BAD_REQUEST")) };
        let Some(k) = is_secret_shape(obj.get("k")) else { return Err(sign_error(404, "OV_SIGN_NOT_FOUND")) };
        let hash = sha256_hex(k);
        match self.lookup_token(inner, &hash) {
            Found::Missing => Err(sign_error(404, "OV_SIGN_NOT_FOUND")),
            Found::Dead(kind) => Err(dead_token_error(kind)),
            Found::Live => {
                if inner.by_token.get(&hash).map(|s| s.state) == Some(State::Signed) {
                    Err(sign_error(409, "OV_SIGN_USED"))
                } else {
                    Ok(hash)
                }
            }
        }
    }

    /// POST /api/sign/open (the phone page).
    pub fn open(&self, body: &Value, ip_key: &str) -> Answer {
        let mut inner = self.lock();
        let hash = match self.phone_session(&mut inner, body, ip_key) {
            Ok(h) => h,
            Err(a) => return a,
        };
        let t = (self.now)();
        let mut woke = false;
        if let Some(s) = inner.by_token.get_mut(&hash) {
            if s.state == State::Pending {
                s.state = State::Opened;
                s.opened_at = Some(t);
                Self::line("open", s);
                woke = true;
            }
        }
        if woke {
            Self::wake(&mut inner, &hash);
        }
        let s = &inner.by_token[&hash];
        Answer::ok(200, json!({ "ok": true, "state": s.state.as_str(), "slot": s.slot, "context": s.context, "expiresAt": s.expires_at }))
    }

    /// POST /api/sign/submit (the phone page): single use.
    pub fn submit(&self, body: &Value, ip_key: &str) -> Answer {
        let mut inner = self.lock();
        let hash = match self.phone_session(&mut inner, body, ip_key) {
            Ok(h) => h,
            Err(a) => return a,
        };
        let (pad, strokes) = match validate_strokes(body.get("pad"), body.get("strokes")) {
            Ok(v) => v,
            Err(code) => return sign_error(400, code),
        };
        let t = (self.now)();
        if let Some(s) = inner.by_token.get_mut(&hash) {
            if s.opened_at.is_none() {
                s.opened_at = Some(t);
            }
            s.state = State::Signed;
            s.signed_at = Some(t);
            s.pad = Some(pad);
            s.strokes = Some(strokes);
            Self::line("submit", s);
        }
        Self::wake(&mut inner, &hash);
        Answer::ok(200, json!({ "ok": true }))
    }

    /// POST /api/sign/close (the scoring device): idempotent.
    pub fn close(&self, body: &Value) -> Answer {
        let Some(obj) = body.as_object() else { return sign_error(400, "OV_SIGN_BAD_REQUEST") };
        let Some(watch) = is_secret_shape(obj.get("watch")) else { return sign_error(404, "OV_SIGN_NOT_FOUND") };
        let mut inner = self.lock();
        if let Some(token_hash) = inner.by_watch.get(&sha256_hex(watch)).cloned() {
            let t = (self.now)();
            Self::end(&mut inner, &token_hash, Dead::Cancelled, t);
        }
        Answer::ok(200, json!({ "ok": true }))
    }

    /// POST /api/sign/wait (the scoring device): at once when the state differs
    /// from `known`, else on the next change, else after the hold. Dropping the
    /// future (the HTTP request went away) removes the waiter.
    pub async fn wait(&self, body: &Value) -> Answer {
        let Some(obj) = body.as_object() else { return sign_error(400, "OV_SIGN_BAD_REQUEST") };
        let Some(watch) = is_secret_shape(obj.get("watch")) else { return sign_error(404, "OV_SIGN_NOT_FOUND") };
        let watch_hash = sha256_hex(watch);
        let known = obj.get("known").and_then(|v| v.as_str()).map(|s| s.to_string());
        let (rx, id, token_hash, hold) = {
            let mut inner = self.lock();
            let token_hash = match self.lookup_watch(&mut inner, &watch_hash) {
                Ok(h) => h,
                Err(Found::Dead(kind)) => return dead_wait_answer(kind),
                Err(_) => return sign_error(404, "OV_SIGN_NOT_FOUND"),
            };
            let s = &inner.by_token[&token_hash];
            if known.as_deref() != Some(s.state.as_str()) {
                return s.wait_answer();
            }
            // One wait per session: a newer one answers the older at once
            Self::wake(&mut inner, &token_hash);
            if inner.waiters >= self.caps.waiters {
                return sign_error_retry(503, "OV_SIGN_BUSY", 5);
            }
            let (tx, rx) = oneshot::channel();
            inner.next_waiter += 1;
            let id = inner.next_waiter;
            inner.waiters += 1;
            let s = inner.by_token.get_mut(&token_hash).expect("live session");
            let hold = self.wait_ms.min(s.live_until().saturating_sub((self.now)()));
            s.waiter = Some(Waiter { id, tx });
            (rx, id, token_hash, hold)
        };
        let _guard = WaitGuard { sessions: self, token_hash: token_hash.clone(), id };
        tokio::select! {
            answer = rx => answer.unwrap_or_else(|_| sign_error(503, "OV_SIGN_UNAVAILABLE")),
            _ = tokio::time::sleep(Duration::from_millis(hold)) => {
                let mut inner = self.lock();
                match self.lookup_watch(&mut inner, &watch_hash) {
                    Ok(h) => inner.by_token[&h].wait_answer(),
                    Err(Found::Dead(kind)) => dead_wait_answer(kind),
                    Err(_) => sign_error(404, "OV_SIGN_NOT_FOUND"),
                }
            }
        }
    }

    /// Every waiter answered, nothing kept.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn dispose(&self) {
        let mut inner = self.lock();
        let keys: Vec<String> = inner.by_token.keys().cloned().collect();
        for k in keys {
            if let Some(w) = Self::take_waiter(&mut inner, &k) {
                let _ = w.tx.send(sign_error(503, "OV_SIGN_UNAVAILABLE"));
            }
        }
        *inner = Inner { sweeper: inner.sweeper, next_waiter: inner.next_waiter, ..Inner::default() };
    }

    /// (live sessions, tombstones, held waits), for tests and status.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn stats(&self) -> (usize, usize, usize) {
        let inner = self.lock();
        (inner.by_token.len(), inner.dead_tokens.len(), inner.waiters)
    }
}

/// Removes a wait's waiter when its future ends or is dropped.
struct WaitGuard<'a> {
    sessions: &'a SignSessions,
    token_hash: String,
    id: u64,
}

impl Drop for WaitGuard<'_> {
    fn drop(&mut self) {
        let mut inner = self.sessions.lock();
        let mine = inner
            .by_token
            .get(&self.token_hash)
            .and_then(|s| s.waiter.as_ref())
            .map_or(false, |w| w.id == self.id);
        if mine {
            SignSessions::take_waiter(&mut inner, &self.token_hash);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    const VECTORS: &str = include_str!("../../electron/__fixtures__/sign-vectors.json");

    fn fill(v: &Value, saved: &HashMap<String, (String, String)>) -> Value {
        match v {
            Value::String(s) if s.starts_with("$token") || s.starts_with("$watch") => {
                let (what, name) = s[1..].split_once(':').unwrap_or((&s[1..], "_last"));
                match saved.get(name) {
                    Some((t, w)) => json!(if what == "token" { t } else { w }),
                    None => v.clone(),
                }
            }
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
        let vectors: Value = serde_json::from_str(VECTORS).expect("sign-vectors.json");
        let mut failures = Vec::new();

        for v in vectors["context"].as_array().unwrap() {
            let r = validate_context(Some(&v["in"]));
            let name = &v["name"];
            match (v.get("error"), r) {
                (Some(e), Err(code)) if e == code => {}
                (Some(e), r) => failures.push(format!("context {name}: {r:?} != error {e}")),
                (None, Ok(c)) if c == v["out"] => {}
                (None, r) => failures.push(format!("context {name}: {r:?} != {}", v["out"])),
            }
        }
        for v in vectors["strokes"].as_array().unwrap() {
            let r = validate_strokes(v.get("pad"), v.get("strokes"));
            let name = &v["name"];
            if v.get("ok") == Some(&json!(true)) && r.is_err() {
                failures.push(format!("strokes {name}: refused"));
            }
            if let Some(e) = v.get("error") {
                if r.as_ref().err().map(|c| json!(c)) != Some(e.clone()) {
                    failures.push(format!("strokes {name}: {:?} != {e}", r.err()));
                }
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
                        "waiters" => caps.waiters = n as usize,
                        other => panic!("unknown cap {other}"),
                    }
                }
            }
            let wait_ms = flow.get("waitMs").and_then(|v| v.as_u64()).unwrap_or(WAIT_MS);
            let sessions = SignSessions::new(caps, wait_ms, Arc::new(move || c.load(Ordering::SeqCst)));
            let mut saved: HashMap<String, (String, String)> = HashMap::new();
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
                    "open" => sessions.open(&body, ip),
                    "submit" => sessions.submit(&body, ip),
                    "wait" => sessions.wait(&body).await,
                    "close" => sessions.close(&body),
                    other => panic!("unknown op {other}"),
                };
                if op == "start" && r.status == 201 {
                    let pair = (r.body["token"].as_str().unwrap().to_string(), r.body["watch"].as_str().unwrap().to_string());
                    if let Some(name) = step.get("save").and_then(|v| v.as_str()) {
                        saved.insert(name.to_string(), pair.clone());
                    }
                    saved.insert("_last".into(), pair);
                }
                for f in check(&r, step.get("expect").unwrap_or(&json!({}))) {
                    failures.push(format!("flow {} step {i} ({op}): {f}", flow["name"]));
                }
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    #[test]
    fn sha256_and_base64url_are_the_standard_ones() {
        assert_eq!(sha256_hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(sha256_hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
        assert_eq!(base64url(b"hello"), "aGVsbG8");
        assert_eq!(base64url(&[0u8; 32]).len(), 43);
        let s = new_secret();
        assert!(is_secret_shape(Some(&json!(s))).is_some());
        assert_ne!(new_secret(), s);
    }

    fn ctx() -> Value {
        json!({ "slot": "captain-a", "context": { "home": "A", "away": "B" } })
    }
    fn ink(token: &str) -> Value {
        json!({ "k": token, "pad": { "w": 4000, "h": 2000 }, "strokes": [[0, 1000, 300, 1000]] })
    }

    #[tokio::test]
    async fn a_held_wait_wakes_on_open_and_submit_and_a_newer_wait_answers_the_older() {
        let sessions = SignSessions::lan();
        let r = sessions.start(&ctx(), "local");
        let (token, watch) = (r.body["token"].as_str().unwrap().to_string(), r.body["watch"].as_str().unwrap().to_string());
        let s2 = sessions.clone();
        let w = watch.clone();
        let held = tokio::spawn(async move { s2.wait(&json!({ "watch": w, "known": "pending" })).await });
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(sessions.stats().2, 1);
        sessions.open(&json!({ "k": token }), "ip");
        assert_eq!(held.await.unwrap().body["state"], "opened");

        let (s2, s3) = (sessions.clone(), sessions.clone());
        let (w2, w3) = (watch.clone(), watch.clone());
        let older = tokio::spawn(async move { s2.wait(&json!({ "watch": w2, "known": "opened" })).await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        let newer = tokio::spawn(async move { s3.wait(&json!({ "watch": w3, "known": "opened" })).await });
        assert_eq!(older.await.unwrap().body["state"], "opened");
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(sessions.stats().2, 1);
        sessions.submit(&ink(&token), "ip");
        let done = newer.await.unwrap();
        assert_eq!(done.body["state"], "signed");
        assert_eq!(done.body["strokes"], json!([[0, 1000, 300, 1000]]));
        assert_eq!(sessions.stats().2, 0);
    }

    #[tokio::test(start_paused = true)]
    async fn a_wait_holds_25_s_and_a_dropped_one_leaves_no_waiter() {
        let sessions = SignSessions::lan();
        let watch = sessions.start(&ctx(), "local").body["watch"].as_str().unwrap().to_string();
        let t0 = tokio::time::Instant::now();
        let r = sessions.wait(&json!({ "watch": watch, "known": "pending" })).await;
        assert_eq!(r.body["state"], "pending");
        assert!(t0.elapsed() >= Duration::from_millis(WAIT_MS));

        let s2 = sessions.clone();
        let w = watch.clone();
        let held = tokio::spawn(async move { s2.wait(&json!({ "watch": w, "known": "pending" })).await });
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(sessions.stats().2, 1);
        held.abort();
        let _ = held.await;
        assert_eq!(sessions.stats().2, 0);
    }

    #[tokio::test]
    async fn close_wakes_the_waiter_and_dispose_answers_everyone() {
        let sessions = SignSessions::lan();
        let watch = sessions.start(&ctx(), "local").body["watch"].as_str().unwrap().to_string();
        let s2 = sessions.clone();
        let w = watch.clone();
        let held = tokio::spawn(async move { s2.wait(&json!({ "watch": w, "known": "pending" })).await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        sessions.close(&json!({ "watch": watch }));
        assert_eq!(held.await.unwrap().body, json!({ "ok": true, "state": "closed" }));

        let watch = sessions.start(&ctx(), "local").body["watch"].as_str().unwrap().to_string();
        let s2 = sessions.clone();
        let held = tokio::spawn(async move { s2.wait(&json!({ "watch": watch, "known": "pending" })).await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        sessions.dispose();
        assert_eq!(held.await.unwrap().body["code"], "OV_SIGN_UNAVAILABLE");
        assert_eq!(sessions.stats(), (0, 0, 0));
    }

    #[tokio::test]
    async fn too_many_held_waits_answer_busy() {
        let caps = Caps { waiters: 1, ..LAN_CAPS };
        let sessions = SignSessions::new(caps, WAIT_MS, system_clock());
        let a = sessions.start(&ctx(), "local").body["watch"].as_str().unwrap().to_string();
        let b = sessions.start(&ctx(), "local").body["watch"].as_str().unwrap().to_string();
        let s2 = sessions.clone();
        let _held = tokio::spawn(async move { s2.wait(&json!({ "watch": a, "known": "pending" })).await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        let r = sessions.wait(&json!({ "watch": b, "known": "pending" })).await;
        assert_eq!(r.status, 503);
        assert_eq!(r.body["code"], "OV_SIGN_BUSY");
        sessions.dispose();
    }

    #[test]
    fn the_sweeper_forgets_ended_sessions_and_tombstones() {
        let clock = Arc::new(AtomicU64::new(0));
        let c = clock.clone();
        let sessions = SignSessions::new(LAN_CAPS, WAIT_MS, Arc::new(move || c.load(Ordering::SeqCst)));
        sessions.start(&ctx(), "local");
        clock.store(600_000, Ordering::SeqCst);
        sessions.sweep();
        assert_eq!(sessions.stats(), (0, 1, 0));
        clock.store(660_000, Ordering::SeqCst);
        sessions.sweep();
        assert_eq!(sessions.stats(), (0, 0, 0));
    }
}
