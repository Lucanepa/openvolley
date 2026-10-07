//! In-process LAN relay (Rust / axum) for the Tauri desktop app.
//!
//! This is the Rust port of `electron/relayServer.js`: an HTTP server that
//! serves the embedded frontend + `/api/*` match endpoints, plus a WebSocket
//! relay so the desktop scoretable can push live match data and referee/bench/
//! livescore tablets on the LAN can subscribe.
//!
//! Ports mirror the JS relay so the existing client code connects unchanged:
//!   - HTTP on 5173 (static site + API)
//!   - WebSocket on 8080
//! (OpenBeach: 5174 / 8081, src/flavour.rs, so both apps run on one laptop.)
//!
//! The WS message protocol and the `/api/*` shapes are a port of
//! `electron/lanRelayCore.cjs` (shared by `server.js`, the Electron relay and
//! the Vite dev plugin) — clients talk to all of them interchangeably, so keep
//! them in sync. In short:
//!   - match-full-data / match-data-update are FLAT bundles with PIN-free `match`;
//!   - match ids are always strings;
//!   - a socket proves the scoreboard role for a match with the match's game PIN
//!     (first sync of a new match claims it); only proven sockets may write,
//!     send actions / live-state, delete or clear (their own) matches;
//!   - PINs are validated by the relay from its own store, never by a WS client,
//!     and /api/match/validate-pin + by-game-number are rate limited per IP;
//!   - an id nobody owns is reusable after 60 s when its match is finished, after
//!     10 min otherwise, and its displaced game PIN may reclaim it once; wrong-PIN
//!     claims are limited per IP / connection and a LAN IP may own few ids;
//!   - the liveState is kept across syncs only for the same owner / game PIN and
//!     is mirrored as `data: { liveState }` for the LedBox bridge;
//!   - only the relay host itself may take / release the main-instance lock, a
//!     lock of the "/" page only: several courts share one relay, each scorer
//!     claims its own match, /api/match/list lists them all, and a LAN browser
//!     opts in to score another court with `/?court=other`;
//!   - openbeach's team1 / team2 names (teams, players, PINs, bench connections)
//!     are taken as home / away, its PINs are secret, and validate-pin
//!     `{ sport: "beach" }` finds beach matches only;
//!   - subscribers get the bundle (rosters, events) and match-actions only after
//!     proving a PIN of the match (subscribe-match `pin`, or the X-OV-Match-Pin
//!     header on GET /api/match/:id): the referee PIN, an enabled bench PIN or
//!     the game PIN. Everyone else gets the public summary (`access: "summary"`:
//!     teams, status, set scores, live state). Wrong PINs are limited per
//!     connection / IP.

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::{
    body::Body,
    extract::{
        connect_info::ConnectInfo,
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{HeaderMap, HeaderValue, Method, Request, StatusCode, Uri},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use rust_embed::RustEmbed;
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, Mutex};

/// The frontend this app serves: OpenVolley's ../dist, or the openbeach
/// build for OpenBeach (build.rs sets OV_DIST from the Tauri config).
#[derive(RustEmbed)]
#[folder = "$OV_DIST"]
struct Assets;

/// PIN/secret fields that must never be returned to a client. The team1* /
/// team2* ones are openbeach's names for the bench and upload PINs (team1Pin,
/// older builds team1TeamPin); matchPin is openbeach's PIN that protects the
/// match on the scorer's device. Same list as lanRelayCore.cjs / backend server.js.
const MATCH_SECRET_FIELDS: &[&str] = &[
    "refereePin",
    "homeTeamPin",
    "awayTeamPin",
    "homeTeamUploadPin",
    "awayTeamUploadPin",
    "connection_pins",
    "connectionPins",
    "game_pin",
    "gamePin",
    "team1Pin",
    "team2Pin",
    "team1TeamPin",
    "team2TeamPin",
    "team1UploadPin",
    "team2UploadPin",
    "team1TeamUploadPin",
    "team2TeamUploadPin",
    "matchPin",
];

/// Personal data the relay never hands out. Subscribing needs no PIN and the
/// room key is the match's public external_id, so every match object and
/// bundle that leaves the relay is public (only the scorer, who sent it, has
/// the full bundle). Same lists as lanRelayCore.cjs / backend publicColumns.js.
const PERSON_PRIVATE_FIELDS: &[&str] = &[
    "dob",
    "dateOfBirth",
    "date_of_birth",
    "birthDate",
    "birthdate",
    "birth_date",
    "country",
    "nationality",
    "email",
    "phone",
    "address",
];
/// Match keys never relayed, besides every key containing "signature".
const MATCH_PRIVATE_FIELDS: &[&str] = &[
    "officials",
    "signatures",
    "approval",
    "manualChanges",
    "manual_changes",
    "pendingHomeRoster",
    "pendingAwayRoster",
    "pending_home_roster",
    "pending_away_roster",
];
/// Match keys holding people: kept, each entry without PERSON_PRIVATE_FIELDS.
const MATCH_ROSTER_FIELDS: &[&str] = &[
    "players_home",
    "players_away",
    "bench_home",
    "bench_away",
    "players_team1",
    "players_team2",
    "benchHome",
    "benchAway",
    "homePlayers",
    "awayPlayers",
];

/// What a subscriber without a PIN gets of a match (lanRelayCore
/// `relaySummaryBundle`, backend publicColumns.js): allowlists.
const SUMMARY_MATCH_FIELDS: &[&str] = &[
    "id", "status", "gameNumber", "gameN", "game_n", "seed_key", "seedKey", "external_id", "externalId",
    "scheduledAt", "scheduled_at", "sport_type", "sportType", "test", "league", "best_of", "bestOf",
    "coinTossTeamA", "coinTossTeamB", "homeShortName", "awayShortName", "homeTeamName", "awayTeamName",
    "refereeConnectionEnabled", "homeTeamConnectionEnabled", "awayTeamConnectionEnabled",
    "_syncedAt", "_syncedSeq", "_syncSession",
];
const SUMMARY_TEAM_FIELDS: &[&str] = &["name", "shortName", "short_name", "color"];
const SUMMARY_SET_FIELDS: &[&str] = &[
    "id", "index", "homePoints", "awayPoints", "home_points", "away_points", "finished", "startTime", "endTime",
];
/// Wrong PINs offered for a match's bundle per connection / IP per window.
const PIN_FAILURE_LIMIT: u32 = 5;
const MAX_ACCESS_KEYS: usize = 16;

/// Same cap as the Node relays / cloud relay.
const WS_MAX_MESSAGE: usize = 10 * 1024 * 1024;
const MAX_MATCH_ID_LEN: usize = 128;
/// A FINISHED match whose scoreboard left this long ago may be claimed by
/// another scoreboard (Dexie ids restart at 1 on every device). Far longer than
/// a Wi-Fi blip, so a live scoreboard is never displaced.
const ORPHAN_TAKEOVER: Duration = Duration::from_secs(60);
/// An UNFINISHED match is claimable only after this long without an owner.
const STALE_TAKEOVER: Duration = Duration::from_secs(10 * 60);
/// Rate-limit window shared by every per-IP / per-connection counter.
const RATE_WINDOW: Duration = Duration::from_secs(60);
/// Wrong game-PIN claims per IP / connection per window before claims needing
/// proof are refused without comparing the PIN (no guessing oracle). One limit
/// for both on purpose: on the venue LAN every scorer device has its own
/// address, unlike the cloud relay behind venue NATs (per-IP limit 20 there).
const CLAIM_FAILURE_LIMIT: u32 = 5;
/// Distinct match ids one (non-loopback) IP may own, and new ids per window.
/// Sized for a venue with several courts: every court tablet has its own
/// address, the relay host (loopback) is exempt, and a tablet keeps the ids of
/// the matches it scored on one connection until it releases them
/// (clear-all-matches / delete-match) or reconnects, so 8 covers a block of
/// matches on one court. Same value as lanRelayCore.cjs (the cloud relay: 20).
const MAX_OWNED_PER_IP: usize = 8;
const NEW_CLAIM_LIMIT: u32 = 10;
/// Same per-IP budgets as the Node relays' HTTP endpoints.
const VALIDATE_PIN_LIMIT: u32 = 10;
const BY_GAME_NUMBER_LIMIT: u32 = 60;
const FINISHED_STATUSES: &[&str] = &["final", "ended", "completed", "finished"];

type Tx = mpsc::UnboundedSender<Message>;

/// A relay -> scoreboard request waiting for its answer.
struct Pending {
    tx: oneshot::Sender<Value>,
    /// Response type that may answer it (e.g. "match-data-response").
    response_type: String,
    match_id: Option<String>,
    /// Only these (proven scoreboard) connections were asked and may answer.
    targets: HashSet<u64>,
}

/// What the relay knows about one WebSocket connection.
struct ConnMeta {
    ip: IpAddr,
    /// 'subscriber' | 'referee' | 'bench' | 'livescore' (subscribe-match `device`
    /// label, `role` is the old name): a label for /api/server/connections only.
    role: String,
    /// 'home' | 'away' (subscribe-match `team`), label only
    team: Option<String>,
    /// id this connection synced under (its Dexie id) -> room key (seed_key)
    aliases: HashMap<String, String>,
    /// room keys this connection sent PINs for, oldest first (see 'pins-required')
    pin_keys: Vec<String>,
    /// room key -> (PIN offered in subscribe-match, verified against the match yet)
    access: HashMap<String, (String, bool)>,
    connected_at: String,
}

const MAX_ALIASES: usize = 16;

/// One fixed-window counter.
struct Window {
    count: u32,
    start: std::time::Instant,
}

/// How a scoreboard claim was granted (see `claim`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum ClaimKind {
    Owner,
    Proved,
    New,
    Open,
    Takeover,
    Reclaim,
}

pub struct AppState {
    /// matchId -> bundle { match, homeTeam, awayTeam, homePlayers, awayPlayers, sets, events, liveState? }
    matches: Mutex<HashMap<String, Value>>,
    main_instance: Mutex<Option<String>>,
    clients: Mutex<HashMap<u64, Tx>>,
    subs: Mutex<HashMap<String, HashSet<u64>>>,
    /// connection id -> match ids it proved the scoreboard role for
    owners: Mutex<HashMap<u64, HashSet<String>>>,
    /// match id -> when its last owning connection left
    orphaned_since: Mutex<HashMap<String, std::time::Instant>>,
    /// connection id -> ip / role / connected time
    conn_meta: Mutex<HashMap<u64, ConnMeta>>,
    /// fixed-window counters: "fail:ip:..", "fail:ws:..", "new:..", "pin:..", "gn:.."
    limits: Mutex<HashMap<String, Window>>,
    /// match id -> game PIN an unfinished match had before a stale takeover
    displaced: Mutex<HashMap<String, String>>,
    pending: Mutex<HashMap<String, Pending>>,
    next_id: AtomicU64,
    pub http_port: u16,
    pub ws_port: u16,
}

pub fn new_state(http_port: u16, ws_port: u16) -> Arc<AppState> {
    Arc::new(AppState {
        matches: Mutex::new(HashMap::new()),
        main_instance: Mutex::new(None),
        clients: Mutex::new(HashMap::new()),
        subs: Mutex::new(HashMap::new()),
        owners: Mutex::new(HashMap::new()),
        orphaned_since: Mutex::new(HashMap::new()),
        conn_meta: Mutex::new(HashMap::new()),
        limits: Mutex::new(HashMap::new()),
        displaced: Mutex::new(HashMap::new()),
        pending: Mutex::new(HashMap::new()),
        next_id: AtomicU64::new(1),
        http_port,
        ws_port,
    })
}

/// IPv4-mapped IPv6 (`::ffff:a.b.c.d`) as plain IPv4.
fn canonical_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        v4 => v4,
    }
}

/// The request comes from the relay host itself: loopback, or one of its own
/// interface addresses (the desktop app calls the relay on its LAN IP).
fn is_local(addr: &SocketAddr) -> bool {
    let ip = canonical_ip(addr.ip());
    if ip.is_loopback() {
        return true;
    }
    local_ip_address::list_afinet_netifas()
        .map(|list| list.iter().any(|(_, a)| canonical_ip(*a) == ip))
        .unwrap_or(false)
}

fn window_count(map: &HashMap<String, Window>, key: &str) -> u32 {
    match map.get(key) {
        Some(w) if w.start.elapsed() <= RATE_WINDOW => w.count,
        _ => 0,
    }
}

/// Count one more hit for `key` and return the count in the current window.
fn window_bump(map: &mut HashMap<String, Window>, key: &str) -> u32 {
    if map.len() > 10_000 {
        map.retain(|_, w| w.start.elapsed() <= RATE_WINDOW);
        if map.len() > 10_000 {
            map.clear(); // bound memory under a flood
        }
    }
    let w = map
        .entry(key.to_string())
        .or_insert(Window { count: 0, start: std::time::Instant::now() });
    if w.start.elapsed() > RATE_WINDOW {
        w.count = 0;
        w.start = std::time::Instant::now();
    }
    w.count += 1;
    w.count
}

async fn http_rate_limited(state: &Arc<AppState>, prefix: &str, addr: &SocketAddr, limit: u32) -> bool {
    let key = format!("{prefix}:{}", canonical_ip(addr.ip()));
    window_bump(&mut *state.limits.lock().await, &key) > limit
}

fn is_finished(m: Option<&Value>) -> bool {
    let status = m
        .and_then(|m| m.get("status"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    FINISHED_STATUSES.contains(&status.as_str())
}

/// RFC 3339 UTC timestamp (like JS `toISOString()`), without a date crate.
fn iso_now() -> String {
    let ms = now_ms();
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
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60,
        ms % 1000
    )
}

/// Remove the personal keys of every person in a roster array.
fn strip_people(list: &mut Value) {
    if let Some(arr) = list.as_array_mut() {
        for p in arr.iter_mut() {
            if let Some(o) = p.as_object_mut() {
                for k in PERSON_PRIVATE_FIELDS {
                    o.remove(*k);
                }
            }
        }
    }
}

/// Make a match object public: no PINs, no officials / signatures / pending
/// rosters / manual changes, rosters without personal keys.
fn strip_secrets(m: &mut Value) {
    if let Some(obj) = m.as_object_mut() {
        for k in MATCH_SECRET_FIELDS {
            obj.remove(*k);
        }
        for k in MATCH_PRIVATE_FIELDS {
            obj.remove(*k);
        }
        obj.retain(|k, _| !k.to_ascii_lowercase().contains("signature"));
        for k in MATCH_ROSTER_FIELDS {
            if let Some(v) = obj.get_mut(*k) {
                strip_people(v);
            }
        }
    }
}

/// A bundle as the relay hands it out: public match, players without personal
/// keys, without the relay's own `sportType` note (see `bundle_from`).
fn strip_bundle_secrets(bundle: &Value) -> Value {
    let mut b = bundle.clone();
    if let Some(obj) = b.as_object_mut() {
        obj.remove("sportType");
    }
    if let Some(m) = b.get_mut("match") {
        strip_secrets(m);
    }
    for k in ["homePlayers", "awayPlayers"] {
        if let Some(v) = b.get_mut(k) {
            strip_people(v);
        }
    }
    b
}

/// Room / store key for a match id: always a string (Dexie ids are numbers).
fn norm_id(v: Option<&Value>) -> Option<String> {
    let s = match v? {
        Value::String(s) => s.trim().to_string(),
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    if s.is_empty() || s.len() > MAX_MATCH_ID_LEN {
        None
    } else {
        Some(s)
    }
}

/// Room key of a synced match: its seed_key when it carries one, else the id the
/// scoreboard sent (lanRelayCore `relayKeyOf`). Every device's first match is
/// Dexie id 1, and the tablets know the seed key.
fn relay_key_of(raw: Option<String>, m: Option<&Value>) -> Option<String> {
    let seed = m.and_then(|m| m.get("seed_key").or_else(|| m.get("seedKey")));
    match seed {
        Some(v @ Value::String(_)) => norm_id(Some(v)).or(raw),
        _ => raw,
    }
}

/// True when the match object carries a game PIN field at all (even empty).
fn has_game_pin_field(m: Option<&Value>) -> bool {
    m.and_then(|m| m.as_object()).map_or(false, |o| o.contains_key("gamePin") || o.contains_key("game_pin"))
}

/// True when the match object carries any PIN field at all (even empty).
fn has_any_pin_field(m: Option<&Value>) -> bool {
    m.and_then(|m| m.as_object()).map_or(false, |o| MATCH_SECRET_FIELDS.iter().any(|k| o.contains_key(*k)))
}

/// A scoreboard that already proved the match sends its PINs only when they
/// change: fields it leaves out keep the stored values.
fn carry_match_secrets(prev: Option<&Value>, bundle: &mut Value) {
    let Some(prev) = prev.and_then(|p| p.as_object()) else { return };
    let Some(next) = bundle.get_mut("match").and_then(|m| m.as_object_mut()) else { return };
    for k in MATCH_SECRET_FIELDS {
        if !next.contains_key(*k) {
            if let Some(v) = prev.get(*k) {
                next.insert((*k).to_string(), v.clone());
            }
        }
    }
}

/// The room key for an id a connection sends (its Dexie id is an alias of the seed_key).
async fn resolve_key(state: &Arc<AppState>, conn_id: u64, raw: Option<String>) -> Option<String> {
    let raw = raw?;
    let meta = state.conn_meta.lock().await;
    Some(meta.get(&conn_id).and_then(|m| m.aliases.get(&raw).cloned()).unwrap_or(raw))
}

/// The match's game PIN as a comparable string; None for matches without one.
fn game_pin_of(m: Option<&Value>) -> Option<String> {
    let m = m?;
    let v = match m.get("gamePin") {
        Some(v) if !v.is_null() && v.as_str() != Some("") => v,
        _ => m.get("game_pin")?,
    };
    let s = match v {
        Value::String(s) => s.trim().to_string(),
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// Is this sync from openbeach? It sends its teams as team1Team / team2Team /
/// team1Players / team2Players (before its home/away wire adapter) or names the
/// sport on the match (lanRelayCore `isBeachSync`, backend handleSyncMatchData).
fn is_beach_sync(src: &Value, m: &Value) -> bool {
    let truthy = |k: &str| src.get(k).map_or(false, |v| !matches!(v, Value::Null | Value::Bool(false)));
    ["team1Team", "team2Team", "team1Players", "team2Players"].iter().any(|k| truthy(k))
        || m.get("sportType").and_then(|v| v.as_str()) == Some("beach")
        || m.get("sport_type").and_then(|v| v.as_str()) == Some("beach")
}

/// The sport of a stored bundle: "beach" or "indoor".
fn bundle_sport(bundle: &Value) -> &'static str {
    if bundle.get("sportType").and_then(|v| v.as_str()) == Some("beach") {
        "beach"
    } else {
        "indoor"
    }
}

/// Build the stored bundle from a sync (flat or `{ matchData }`) or response payload.
/// `sportType` ("beach" only, when the sync says so) is the relay's own note
/// for POST /api/match/validate-pin `{ sport }` and the `sportType` of its
/// GET /api/match/list row: it is not part of any bundle sent out
/// (`strip_bundle_secrets`, `summary_bundle`).
fn bundle_from(src: &Value) -> Option<Value> {
    let src = match src.get("matchData") {
        Some(md) if md.is_object() => md,
        _ => src,
    };
    let m = src.get("match")?;
    if !m.is_object() {
        return None;
    }
    let arr = |k: &str| match src.get(k) {
        Some(v) if v.is_array() => v.clone(),
        _ => json!([]),
    };
    // The first array among `keys` (openbeach: team1Players / team2Players)
    let players = |keys: &[&str]| {
        keys.iter()
            .find_map(|k| src.get(*k).filter(|v| v.is_array()).cloned())
            .unwrap_or_else(|| json!([]))
    };
    // openbeach names its teams team1Team / team2Team (team1 / team2)
    let team = |keys: &[&str]| {
        keys.iter()
            .find_map(|k| src.get(*k).filter(|v| !v.is_null()).cloned())
            .unwrap_or(Value::Null)
    };
    let mut bundle = json!({
        "match": m.clone(),
        "homeTeam": team(&["homeTeam", "team1Team", "team1"]),
        "awayTeam": team(&["awayTeam", "team2Team", "team2"]),
        "homePlayers": players(&["homePlayers", "team1Players"]),
        "awayPlayers": players(&["awayPlayers", "team2Players"]),
        "sets": arr("sets"),
        "events": arr("events"),
    });
    if is_beach_sync(src, m) {
        bundle["sportType"] = json!("beach");
    }
    Some(bundle)
}

/// A flat, PIN-free match message: `{ type, matchId, match, homeTeam, ..., liveState? }`.
/// A stored liveState is mirrored as `data: { liveState }` (nothing else under
/// `data`) for the LedBox bridge, which reads `msg.data.liveState`.
#[cfg(test)]
fn bundle_message(msg_type: &str, match_id: &str, bundle: &Value, sb_ts: Option<Value>) -> Value {
    bundle_message_access(msg_type, match_id, bundle, sb_ts, true)
}

/// Only `keys` of an object; anything else as it is (null when missing).
fn pick_fields(v: Option<&Value>, keys: &[&str]) -> Value {
    match v {
        Some(Value::Object(o)) => {
            let mut out = serde_json::Map::new();
            for k in keys {
                if let Some(x) = o.get(*k) {
                    out.insert((*k).to_string(), x.clone());
                }
            }
            Value::Object(out)
        }
        Some(other) => other.clone(),
        None => Value::Null,
    }
}

/// The public summary of a bundle (no PIN proved): same shape, rosters and
/// events empty, `access: "summary"` (lanRelayCore `relaySummaryBundle`).
fn summary_bundle(bundle: &Value) -> Value {
    let sets: Vec<Value> = bundle
        .get("sets")
        .and_then(|s| s.as_array())
        .map(|a| a.iter().map(|s| pick_fields(Some(s), SUMMARY_SET_FIELDS)).collect())
        .unwrap_or_default();
    let mut out = json!({
        "access": "summary",
        "match": pick_fields(bundle.get("match"), SUMMARY_MATCH_FIELDS),
        "homeTeam": pick_fields(bundle.get("homeTeam"), SUMMARY_TEAM_FIELDS),
        "awayTeam": pick_fields(bundle.get("awayTeam"), SUMMARY_TEAM_FIELDS),
        "homePlayers": [],
        "awayPlayers": [],
        "sets": sets,
        "events": [],
    });
    if let Some(live) = bundle.get("liveState") {
        out["liveState"] = live.clone();
    }
    out
}

fn pin_text(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

/// Constant time for equal lengths.
fn ct_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Does `pin` prove access to the match: the referee PIN (referee connection
/// on), a bench PIN (that bench connection on; beach: team1 / team2) or the
/// game PIN? A match without any of them grants nothing (lanRelayCore
/// `pinGrantsAccess`).
fn pin_grants_access(m: Option<&Value>, pin: &str) -> bool {
    let p = pin.trim();
    let Some(m) = m.filter(|m| m.is_object()) else { return false };
    if p.is_empty() {
        return false;
    }
    let on = |k: &str| m.get(k).and_then(|v| v.as_bool()) == Some(true);
    let mut candidates = Vec::new();
    if on("refereeConnectionEnabled") {
        candidates.push(pin_text(m.get("refereePin")));
    }
    if on("homeTeamConnectionEnabled") {
        candidates.push(pin_text(m.get("homeTeamPin")));
    }
    if on("awayTeamConnectionEnabled") {
        candidates.push(pin_text(m.get("awayTeamPin")));
    }
    // Beach (openbeach) benches: team1 / team2 (team1Pin, older builds team1TeamPin)
    let first_pin = |keys: &[&str]| keys.iter().find_map(|k| pin_text(m.get(*k)));
    if on("team1TeamConnectionEnabled") {
        candidates.push(first_pin(&["team1Pin", "team1TeamPin"]));
    }
    if on("team2TeamConnectionEnabled") {
        candidates.push(first_pin(&["team2Pin", "team2TeamPin"]));
    }
    candidates.push(game_pin_of(Some(m)));
    let mut ok = false;
    for c in candidates.into_iter().flatten() {
        if ct_eq(&c, p) {
            ok = true;
        }
    }
    ok
}

/// A match message with the full (PIN-free) bundle, or the summary.
fn bundle_message_access(msg_type: &str, match_id: &str, bundle: &Value, sb_ts: Option<Value>, full: bool) -> Value {
    let mut out = if full {
        let mut b = strip_bundle_secrets(bundle);
        if let Some(obj) = b.as_object_mut() {
            obj.insert("access".into(), json!("full"));
        }
        b
    } else {
        summary_bundle(bundle)
    };
    if let Some(obj) = out.as_object_mut() {
        let now = now_ms();
        obj.insert("type".into(), json!(msg_type));
        obj.insert("matchId".into(), json!(match_id));
        obj.insert("_timestamp".into(), json!(now));
        obj.insert("_scoreboardTimestamp".into(), sb_ts.unwrap_or(json!(now)));
        if let Some(live) = obj.get("liveState").cloned() {
            obj.insert("data".into(), json!({ "liveState": live }));
        }
    }
    out
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Numeric ids stay numbers in HTTP responses (clients compare them to Dexie ids).
fn public_id(key: &str) -> Value {
    if !key.is_empty() && key.chars().all(|c| c.is_ascii_digit()) {
        if let Ok(n) = key.parse::<i64>() {
            return json!(n);
        }
    }
    json!(key)
}

fn json_response(status: StatusCode, value: Value) -> Response {
    (status, [("content-type", "application/json")], value.to_string()).into_response()
}

// ---------------------------------------------------------------------------
// Serve both listeners (pre-bound in main to avoid a load race with the window)
// ---------------------------------------------------------------------------

pub async fn serve(
    state: Arc<AppState>,
    http_listener: std::net::TcpListener,
    ws_listener: std::net::TcpListener,
) {
    http_listener.set_nonblocking(true).ok();
    ws_listener.set_nonblocking(true).ok();
    let http = tokio::net::TcpListener::from_std(http_listener).expect("http listener");
    let ws = tokio::net::TcpListener::from_std(ws_listener).expect("ws listener");

    let http_app = http_router(state.clone());
    let ws_app = Router::new()
        .route("/", get(ws_handler))
        .with_state(state.clone());

    let http_fut = axum::serve(
        http,
        http_app.into_make_service_with_connect_info::<SocketAddr>(),
    );
    let ws_fut = axum::serve(ws, ws_app.into_make_service_with_connect_info::<SocketAddr>());

    tokio::select! {
        _ = http_fut => {},
        _ = ws_fut => {},
    }
}

fn http_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/api/health", get(health))
        .route("/api/server/status", get(server_status))
        .route("/api/server/register-main", get(register_main).post(register_main))
        .route("/api/server/unregister-main", get(unregister_main).post(unregister_main))
        .route("/api/match/validate-pin", post(validate_pin))
        .route("/api/match/list", get(match_list))
        .route("/api/match/by-game-number", get(by_game_number))
        .route("/api/match/:id", get(match_get).patch(match_patch))
        .route("/api/server/connections", get(server_connections))
        .fallback(static_handler)
        .layer(middleware::from_fn(add_headers))
        .with_state(state)
}

// ---------------------------------------------------------------------------
// Middleware: security headers + LAN CORS + OPTIONS short-circuit
// ---------------------------------------------------------------------------

fn cors_origin_allowed(origin: &str) -> bool {
    if let Ok(u) = Uri::try_from(origin) {
        if let Some(host) = u.host() {
            if host == "localhost" || host == "127.0.0.1" {
                return true;
            }
            if host.ends_with(".openvolley.app") || host == "openvolley.app" {
                return true;
            }
            if host.starts_with("192.168.") || host.starts_with("10.") {
                return true;
            }
            if host.starts_with("172.") {
                // 172.16.x - 172.31.x
                if let Some(second) = host.split('.').nth(1).and_then(|s| s.parse::<u8>().ok()) {
                    if (16..=31).contains(&second) {
                        return true;
                    }
                }
            }
        }
    }
    false
}

async fn add_headers(req: Request<Body>, next: Next) -> Response {
    let origin = req
        .headers()
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let is_options = req.method() == Method::OPTIONS;

    let mut res = if is_options {
        StatusCode::OK.into_response()
    } else {
        next.run(req).await
    };

    let h = res.headers_mut();
    h.insert("X-Content-Type-Options", HeaderValue::from_static("nosniff"));
    h.insert("X-Frame-Options", HeaderValue::from_static("SAMEORIGIN"));
    h.insert(
        "Referrer-Policy",
        HeaderValue::from_static("strict-origin-when-cross-origin"),
    );
    if let Some(o) = origin {
        if cors_origin_allowed(&o) {
            if let Ok(val) = HeaderValue::from_str(&o) {
                h.insert("Access-Control-Allow-Origin", val);
            }
        }
    }
    h.insert(
        "Access-Control-Allow-Methods",
        HeaderValue::from_static("GET, POST, PATCH, OPTIONS"),
    );
    h.insert(
        "Access-Control-Allow-Headers",
        HeaderValue::from_static("Content-Type, X-Instance-ID, X-OV-Match-Pin, X-OV-Match-Token"),
    );
    res
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

async fn health() -> Response {
    json_response(StatusCode::OK, json!({ "status": "ok", "running": true }))
}

async fn server_status(State(state): State<Arc<AppState>>) -> Response {
    let interfaces = crate::netifs::tablet_interfaces();
    let ip = crate::netifs::preferred_ip(&interfaces, local_ip_address::local_ip().ok().map(|ip| ip.to_string()));
    let p = state.http_port;
    let ws = state.ws_port;
    let main = state.main_instance.lock().await.clone();
    json_response(
        StatusCode::OK,
        json!({
            "running": true,
            "mainInstanceId": main,
            "hasMainInstance": main.is_some(),
            "protocol": "http",
            "wsProtocol": "ws",
            "hostname": "localhost",
            "localIP": ip,
            "port": p,
            "wsPort": ws,
            // every address a tablet may open, with its network: hotspot,
            // wifi, ethernet, bluetooth, other (netifs.rs)
            "interfaces": interfaces,
            "urls": {
                "main": format!("http://{ip}:{p}/"),
                "mainIP": format!("http://{ip}:{p}/"),
                "referee": format!("http://{ip}:{p}/referee"),
                "refereeIP": format!("http://{ip}:{p}/referee"),
                "bench": format!("http://{ip}:{p}/bench"),
                "benchIP": format!("http://{ip}:{p}/bench"),
                "livescore": format!("http://{ip}:{p}/livescore"),
                "livescoreIP": format!("http://{ip}:{p}/livescore"),
                "websocket": format!("ws://{ip}:{ws}"),
                "websocketIP": format!("ws://{ip}:{ws}"),
            }
        }),
    )
}

/// Main-instance lock: only the relay host itself may take (and always
/// re-take) or release it, so a LAN device can never lock the scoretable out
/// of "/". Same rule as lanRelayCore's createMainInstanceGate.
async fn register_main(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    if !is_local(&addr) {
        return json_response(
            StatusCode::FORBIDDEN,
            json!({ "success": false, "error": "Only the scoretable machine can register the main instance" }),
        );
    }
    let instance_id = headers
        .get("x-instance-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("instance-{}", state.next_id.fetch_add(1, Ordering::Relaxed)));
    *state.main_instance.lock().await = Some(instance_id.clone());
    json_response(StatusCode::OK, json!({ "success": true, "instanceId": instance_id }))
}

async fn unregister_main(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
) -> Response {
    if !is_local(&addr) {
        return json_response(
            StatusCode::FORBIDDEN,
            json!({ "success": false, "error": "Not the registered instance" }),
        );
    }
    *state.main_instance.lock().await = None;
    json_response(StatusCode::OK, json!({ "success": true }))
}

async fn validate_pin(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Response {
    if http_rate_limited(&state, "pin", &addr, VALIDATE_PIN_LIMIT).await {
        return json_response(
            StatusCode::TOO_MANY_REQUESTS,
            json!({ "success": false, "error": "Too many attempts. Please wait a minute before trying again." }),
        );
    }
    let pin = match body.get("pin") {
        Some(Value::String(p)) => p.trim().to_string(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    };
    let typ = body.get("type").and_then(|v| v.as_str()).unwrap_or("referee").to_string();
    // The asking app's sport (openbeach: "beach"; left out: "indoor"): a PIN
    // never finds a match of the other sport (lanRelayCore `validatePin`).
    let sport = match body.get("sport") {
        None | Some(Value::Null) => "indoor",
        Some(Value::String(s)) if s == "indoor" => "indoor",
        Some(Value::String(s)) if s == "beach" => "beach",
        _ => return json_response(StatusCode::BAD_REQUEST, json!({ "success": false, "error": "Invalid request" })),
    };
    if pin.len() != 6 {
        return json_response(StatusCode::BAD_REQUEST, json!({ "success": false, "error": "Invalid PIN format" }));
    }
    let (pin_field, enabled_field) = match typ.as_str() {
        "referee" => ("refereePin", "refereeConnectionEnabled"),
        "homeTeam" => ("homeTeamPin", "homeTeamConnectionEnabled"),
        "awayTeam" => ("awayTeamPin", "awayTeamConnectionEnabled"),
        _ => return json_response(StatusCode::BAD_REQUEST, json!({ "success": false, "error": "Invalid PIN type" })),
    };

    // The relay answers from its own store (filled by the scoreboard's syncs).
    // It never asks — or tells — a WS client about a PIN.
    let matches = state.matches.lock().await;
    for (id, bundle) in matches.iter() {
        let Some(m) = bundle.get("match") else { continue };
        if bundle_sport(bundle) != sport {
            continue;
        }
        let match_pin = match m.get(pin_field) {
            Some(Value::String(p)) => Some(p.trim().to_string()),
            Some(Value::Number(n)) => Some(n.to_string()),
            _ => None,
        };
        let enabled = m.get(enabled_field).and_then(|v| v.as_bool()).unwrap_or(false);
        let status = m.get("status").and_then(|v| v.as_str()).unwrap_or("");
        if match_pin.as_deref() == Some(pin.as_str()) && enabled && status != "final" {
            let mut found = m.clone();
            strip_secrets(&mut found);
            if let Some(obj) = found.as_object_mut() {
                obj.insert("id".to_string(), public_id(id));
                // A beach answer names its sport (the indoor answer is unchanged)
                if sport == "beach" {
                    obj.insert("sportType".to_string(), json!("beach"));
                }
            }
            return json_response(StatusCode::OK, json!({ "success": true, "match": found }));
        }
    }
    json_response(
        StatusCode::NOT_FOUND,
        json!({ "success": false, "error": "No match found with this PIN. Make sure the main scoresheet is running and connected." }),
    )
}

/// Path match id, normalised like every WS match id (trimmed, length-capped).
fn path_match_id(raw: String) -> Option<String> {
    norm_id(Some(&Value::String(raw)))
}

fn bad_match_id() -> Response {
    json_response(StatusCode::BAD_REQUEST, json!({ "success": false, "error": "Match ID required" }))
}

/// GET /api/match/:id: the bundle when the X-OV-Match-Pin header carries a PIN
/// that grants the match, the public summary otherwise.
async fn match_get(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let Some(id) = path_match_id(id) else { return bad_match_id() };
    let offered = headers
        .get("x-ov-match-pin")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let fail_key = format!("pinfail:ip:{}", canonical_ip(addr.ip()));
    if offered.is_some() && window_count(&*state.limits.lock().await, &fail_key) >= PIN_FAILURE_LIMIT {
        return json_response(
            StatusCode::TOO_MANY_REQUESTS,
            json!({ "success": false, "error": "Too many wrong PINs. Wait a minute." }),
        );
    }
    let answer = |bundle: &Value, full: bool| {
        let mut out = if full {
            let mut b = strip_bundle_secrets(bundle);
            if let Some(obj) = b.as_object_mut() {
                obj.insert("access".into(), json!("full"));
            }
            b
        } else {
            summary_bundle(bundle)
        };
        if let Some(obj) = out.as_object_mut() {
            obj.insert("success".to_string(), json!(true));
        }
        json_response(StatusCode::OK, out)
    };
    let stored = state.matches.lock().await.get(&id).cloned();
    let found = match stored {
        Some(b) => Some(b),
        None => {
            let rid = format!("match-data-request-{}", state.next_id.fetch_add(1, Ordering::Relaxed));
            let req_msg = json!({ "type": "match-data-request", "requestId": rid, "matchId": id });
            // The WS side validates the answer (proven scoreboard, game PIN) and stores it.
            ws_roundtrip(&state, req_msg, &rid, "match-data-response", Some(id.clone())).await
        }
    };
    let Some(bundle) = found else {
        return json_response(
            StatusCode::NOT_FOUND,
            json!({ "success": false, "error": "Match data not found. Make sure the main scoresheet is running and connected." }),
        );
    };
    let full = offered.as_deref().map_or(false, |p| pin_grants_access(bundle.get("match"), p));
    if offered.is_some() && !full {
        window_bump(&mut *state.limits.lock().await, &fail_key);
    }
    answer(&bundle, full)
}

/// A team's display name: the bundle's team (object or plain string), else `None`.
fn team_name(team: Option<&Value>) -> Option<&str> {
    let name = match team {
        Some(Value::String(s)) => Some(s.as_str()),
        Some(t) => t.get("name").and_then(|v| v.as_str()),
        None => None,
    };
    name.filter(|n| !n.trim().is_empty())
}

/// One GET /api/match/list row for a stored bundle, or `None` when the match is
/// not listed (lanRelayCore `matchListEntry`). Listed: status "scheduled" or
/// "live" (none counts as "scheduled"), whatever the referee connection:
/// display devices (the point-hub LedBox bridge) need no PIN and pick their
/// match from this list; with `include_finished` (`?finished=1`, the
/// livescore) a finished one too. Public fields only: no PINs, no people.
fn match_list_entry(id: &str, bundle: &Value, include_finished: bool) -> Option<Value> {
    let empty = json!({});
    let m = bundle.get("match").filter(|m| m.is_object()).unwrap_or(&empty);
    let status = match m.get("status") {
        None | Some(Value::Null) => "scheduled".to_string(),
        Some(Value::String(s)) if s.is_empty() => "scheduled".to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    };
    let finished = FINISHED_STATUSES.contains(&status.to_ascii_lowercase().as_str());
    if status != "scheduled" && status != "live" && !(include_finished && finished) {
        return None;
    }
    let home = team_name(bundle.get("homeTeam")).or_else(|| team_name(m.get("homeTeamName"))).unwrap_or("Home");
    let away = team_name(bundle.get("awayTeam")).or_else(|| team_name(m.get("awayTeamName"))).unwrap_or("Away");
    let truthy = |v: Option<&Value>| v.map_or(false, |v| !matches!(v, Value::Null | Value::Bool(false)) && *v != json!(0) && *v != json!(""));
    let game_number = ["gameNumber", "game_n"]
        .iter()
        .find_map(|k| m.get(*k).filter(|v| truthy(Some(v))).cloned())
        .unwrap_or_else(|| json!(id));
    Some(json!({
        "id": public_id(id),
        "gameNumber": game_number,
        "homeTeam": home,
        "awayTeam": away,
        "scheduledAt": m.get("scheduledAt").cloned().unwrap_or(Value::Null),
        // No display string here (no time zone data): clients format scheduledAt
        "dateTime": Value::Null,
        "status": status,
        // "beach" (openbeach) or "indoor": each app lists its own sport's matches
        "sportType": bundle_sport(bundle),
        "test": m.get("test") == Some(&json!(true)),
        // PINs intentionally NOT returned: validated via /api/match/validate-pin
        "refereeConnectionEnabled": m.get("refereeConnectionEnabled") == Some(&json!(true)),
        // The referee / bench apps offer only the matches they can join
        "homeTeamConnectionEnabled": m.get("homeTeamConnectionEnabled") == Some(&json!(true)),
        "awayTeamConnectionEnabled": m.get("awayTeamConnectionEnabled") == Some(&json!(true)),
    }))
}

/// Every match a scorer currently publishes here (match_list_entry), newest
/// first: not one whose scoreboard left longer ago than an unfinished match
/// is held for it (STALE_TAKEOVER). Finished ones only with
/// `include_finished`. Takes one lock at a time.
async fn match_list_rows(state: &Arc<AppState>, include_finished: bool) -> Vec<Value> {
    let stale: HashSet<String> = {
        let owners = state.owners.lock().await;
        let orphaned = state.orphaned_since.lock().await;
        orphaned
            .iter()
            .filter(|(id, t)| t.elapsed() >= STALE_TAKEOVER && !owners.values().any(|o| o.contains(*id)))
            .map(|(id, _)| id.clone())
            .collect()
    };
    let matches = state.matches.lock().await;
    let mut list: Vec<Value> = matches
        .iter()
        .filter(|(id, _)| !stale.contains(*id))
        .filter_map(|(id, bundle)| match_list_entry(id, bundle, include_finished))
        .collect();
    drop(matches);
    // Newest first (ISO dates sort lexically; none last)
    list.sort_by(|a, b| {
        let ka = a.get("scheduledAt").and_then(|v| v.as_str()).unwrap_or("");
        let kb = b.get("scheduledAt").and_then(|v| v.as_str()).unwrap_or("");
        kb.cmp(ka)
    });
    list
}

/// GET /api/match/list (`?finished=1`: finished matches too, for the livescore).
async fn match_list(State(state): State<Arc<AppState>>, Query(params): Query<HashMap<String, String>>) -> Response {
    let include_finished = params.get("finished").map(|v| v == "1").unwrap_or(false);
    let list = match_list_rows(&state, include_finished).await;
    json_response(StatusCode::OK, json!({ "success": true, "matches": list }))
}

async fn by_game_number(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    if http_rate_limited(&state, "gn", &addr, BY_GAME_NUMBER_LIMIT).await {
        return json_response(StatusCode::TOO_MANY_REQUESTS, json!({ "success": false, "error": "Too many requests" }));
    }
    let game_number = params.get("gameNumber").map(|s| s.trim().to_string()).unwrap_or_default();
    if game_number.is_empty() {
        return json_response(StatusCode::BAD_REQUEST, json!({ "success": false, "error": "Game number required" }));
    }
    {
        let matches = state.matches.lock().await;
        for (id, bundle) in matches.iter() {
            if let Some(m) = bundle.get("match") {
                let gn = m.get("gameNumber").map(|v| v.to_string().trim_matches('"').to_string());
                let gnn = m.get("game_n").map(|v| v.to_string().trim_matches('"').to_string());
                if gn.as_deref() == Some(game_number.as_str())
                    || gnn.as_deref() == Some(game_number.as_str())
                    || id == &game_number
                {
                    let mut mm = m.clone();
                    strip_secrets(&mut mm);
                    return json_response(
                        StatusCode::OK,
                        json!({ "success": true, "match": mm, "matchId": id }),
                    );
                }
            }
        }
    }
    let rid = format!("game-number-request-{}", state.next_id.fetch_add(1, Ordering::Relaxed));
    let req_msg = json!({ "type": "game-number-request", "requestId": rid, "gameNumber": game_number });
    match ws_roundtrip(&state, req_msg, &rid, "game-number-response", None).await {
        Some(v) if v.get("match").is_some() => {
            let mut m = v.get("match").cloned().unwrap();
            strip_secrets(&mut m);
            json_response(StatusCode::OK, json!({ "success": true, "match": m, "matchId": v.get("matchId").cloned().unwrap_or(Value::Null) }))
        }
        _ => json_response(StatusCode::NOT_FOUND, json!({ "success": false, "error": "Match not found with this game number" })),
    }
}

async fn match_patch(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(updates): Json<Value>,
) -> Response {
    let Some(id) = path_match_id(id) else { return bad_match_id() };
    let rid = format!("match-update-{}", state.next_id.fetch_add(1, Ordering::Relaxed));
    let req_msg = json!({ "type": "match-update-request", "requestId": rid, "matchId": id, "updates": updates });
    match ws_roundtrip(&state, req_msg, &rid, "match-update-response", Some(id.clone())).await {
        Some(v) => {
            // `data` was validated + stored by the WS side; never echo PINs.
            let mut out = match v.get("data") {
                Some(d) if d.is_object() => strip_bundle_secrets(d),
                _ => json!({}),
            };
            if let Some(obj) = out.as_object_mut() {
                obj.insert("success".to_string(), json!(true));
            }
            json_response(StatusCode::OK, out)
        }
        _ => json_response(StatusCode::INTERNAL_SERVER_ERROR, json!({ "success": false, "error": "Update request timeout. Make sure the main scoresheet is running." })),
    }
}

/// Devices connected over the network (the tray's "2 tablets connected"):
/// WebSocket connections from another machine. The scoretable on this
/// computer (loopback or one of its own addresses) does not count.
pub async fn tablet_count(state: &Arc<AppState>) -> usize {
    let ips: Vec<IpAddr> = state.conn_meta.lock().await.values().map(|m| m.ip).collect();
    if ips.is_empty() {
        return 0;
    }
    let own: Vec<IpAddr> = local_ip_address::list_afinet_netifas()
        .map(|list| list.into_iter().map(|(_, a)| canonical_ip(a)).collect())
        .unwrap_or_default();
    count_remote(&ips, &own)
}

fn count_remote(ips: &[IpAddr], own: &[IpAddr]) -> usize {
    ips.iter()
        .map(|ip| canonical_ip(*ip))
        .filter(|ip| !ip.is_loopback() && !own.contains(ip))
        .count()
}

async fn server_connections(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let filter = params.get("matchId").and_then(|f| norm_id(Some(&Value::String(f.clone()))));
    let mut clients: Vec<Value> = Vec::new();
    let mut counts = serde_json::Map::new();
    let (mut referees, mut benches) = (0, 0);
    {
        let owners = state.owners.lock().await;
        let subs = state.subs.lock().await;
        let meta = state.conn_meta.lock().await;
        for (match_id, set) in subs.iter() {
            counts.insert(match_id.clone(), json!(set.len()));
            if filter.as_deref().map_or(false, |f| f != match_id) {
                continue;
            }
            for conn in set {
                // Scoreboards are not dashboards.
                if owners.get(conn).map_or(false, |o| !o.is_empty()) {
                    continue;
                }
                let m = meta.get(conn);
                let role = m.map_or("subscriber", |m| m.role.as_str());
                match role {
                    "referee" => referees += 1,
                    "bench" => benches += 1,
                    _ => {}
                }
                clients.push(json!({
                    "id": format!("c{conn}"),
                    "ip": m.map(|m| m.ip.to_string()),
                    "role": role,
                    "team": m.and_then(|m| m.team.clone()),
                    "matchId": match_id,
                    "connectedAt": m.map(|m| m.connected_at.clone()),
                }));
            }
        }
    }
    let total = state.clients.lock().await.len();
    json_response(
        StatusCode::OK,
        json!({
            "totalClients": total,
            "dashboardClients": clients.len(),
            "referees": referees,
            "benches": benches,
            "clients": clients,
            "matchSubscriptions": counts,
        }),
    )
}

// ---------------------------------------------------------------------------
// Static file serving (embedded dist) with SPA fallback + main-instance gate
// ---------------------------------------------------------------------------

/// "Score another court on this device": the "already running" page links to
/// `/?court=other`, which sets this cookie and redirects to "/"; a browser that
/// carries it gets the scoresheet while the main instance is registered (a
/// page navigation cannot send X-Instance-ID). Same names as lanRelayCore.cjs.
const OTHER_COURT_COOKIE: &str = "ov_other_court";

/// The "already running" page: links to the role pages this app has
/// (OpenBeach has no bench page).
fn main_instance_page(f: &crate::flavour::Flavour) -> String {
    let links: String = [("referee", "Referee App"), ("bench", "Bench App"), ("livescore", "Livescore App")]
        .iter()
        .filter(|(role, _)| f.role_pages.iter().any(|(r, _)| r == role))
        .map(|(role, label)| format!("<li><a href=\"/{role}\">{label}</a></li>"))
        .collect();
    format!(
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\">\
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Main Instance Already Running</title>\
<style>body{{font-family:Arial,sans-serif;text-align:center;padding:50px 16px}}h1{{color:#ef4444}}p{{color:#666}}ul{{list-style:none;padding:0}}li{{margin:8px 0}}</style>\
</head><body><h1>Main Scoresheet Already Running</h1>\
<p>Another scoretable is active on this server.</p>\
<p>You can still open:</p>\
<ul>{links}</ul>\
<p>Scoring a match on another court?</p>\
<ul><li><a href=\"/?court=other\">Open the scoresheet for another court on this device</a></li></ul>\
</body></html>"
    )
}

/// Does the query string carry `court=other`?
fn is_other_court_query(query: &str) -> bool {
    query.split('&').any(|kv| kv == "court=other")
}

/// Does the Cookie header carry the other-court opt-in?
fn has_other_court_cookie(headers: &HeaderMap) -> bool {
    let want = format!("{OTHER_COURT_COOKIE}=1");
    headers
        .get_all("cookie")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .any(|v| v.split(';').any(|c| c.trim() == want))
}

async fn static_handler(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let path = uri.path();

    // Unknown API routes get JSON, not the SPA's index.html with a 200.
    if path.starts_with("/api/") {
        return json_response(StatusCode::NOT_FOUND, json!({ "success": false, "error": "Not found" }));
    }

    // Single main-instance gate — skipped for the desktop app itself, for a
    // request that presents the registered instance id and for a browser that
    // opted in to score another court (lanRelayCore `createMainInstanceGate`:
    // a page lock, not a match lock; the game PIN decides who scores a match).
    if path == "/" || path == "/index.html" {
        if uri.query().map_or(false, is_other_court_query) {
            return (
                StatusCode::FOUND,
                [
                    ("location", "/".to_string()),
                    ("set-cookie", format!("{OTHER_COURT_COOKIE}=1; Path=/; Max-Age=43200; SameSite=Lax")),
                    ("cache-control", "no-store".to_string()),
                ],
            )
                .into_response();
        }
        if !is_local(&addr) && !has_other_court_cookie(&headers) {
            let main = state.main_instance.lock().await.clone();
            let presented = headers.get("x-instance-id").and_then(|v| v.to_str().ok());
            if main.is_some() && presented != main.as_deref() {
                return (
                    StatusCode::FORBIDDEN,
                    [("content-type", "text/html; charset=utf-8"), ("cache-control", "no-store")],
                    main_instance_page(crate::flavour::CURRENT),
                )
                    .into_response();
            }
        }
    }

    serve_asset(path)
}

fn serve_asset(req_path: &str) -> Response {
    let exists = |p: &str| Assets::get(p).is_some();
    match resolve_asset(req_path, crate::flavour::CURRENT, &exists).and_then(|p| try_file(&p)) {
        Some(r) => r,
        None => (StatusCode::NOT_FOUND, "Not Found").into_response(),
    }
}

/// The pages the relay hands out by name (server_status urls, the QR codes,
/// the "already running" page) in either app. One of them that the running
/// app does not have is a 404: a tablet must never get the scoretable for it.
const ROLE_PATHS: &[&str] = &["referee", "bench", "livescore", "scoreboard", "scoresheet", "upload_roster"];

/// Which embedded file answers `req_path` (None: 404). The file itself;
/// a role page (/referee, /referee/, /referee.html) from the flavour's
/// role_pages; folder pages (x/ -> x/index.html, x -> x.html | x/index.html,
/// legacy x.html -> x/index.html); else the single-page fallback (index).
fn resolve_asset(req_path: &str, f: &crate::flavour::Flavour, exists: &dyn Fn(&str) -> bool) -> Option<String> {
    let index = || f.index_pages.iter().find(|p| exists(p)).map(|p| p.to_string());
    let p = req_path.trim_start_matches('/');
    if p.is_empty() {
        return index();
    }
    if exists(p) {
        return Some(p.to_string());
    }
    let role = p.strip_suffix('/').or_else(|| p.strip_suffix(".html")).unwrap_or(p);
    if ROLE_PATHS.contains(&role) {
        let own = f.role_pages.iter().find(|(r, _)| *r == role).map(|(_, file)| *file);
        if let Some(file) = own.filter(|file| exists(file)) {
            return Some(file.to_string());
        }
    }
    let candidates: Vec<String> = if p.ends_with('/') {
        vec![format!("{p}index.html")]
    } else if !p.contains('.') {
        vec![format!("{p}.html"), format!("{p}/index.html")]
    } else if let Some(stem) = p.strip_suffix(".html") {
        // Legacy /referee.html links: Vite builds folder pages (referee/index.html).
        vec![format!("{stem}/index.html")]
    } else {
        vec![]
    };
    if let Some(found) = candidates.into_iter().find(|c| exists(c)) {
        return Some(found);
    }
    if ROLE_PATHS.contains(&role) {
        return None;
    }
    // SPA fallback
    index()
}

fn try_file(path: &str) -> Option<Response> {
    Assets::get(path).map(|file| {
        let mime = mime_guess::from_path(path).first_or_octet_stream();
        let no_cache = path.ends_with(".html")
            || path.ends_with(".json")
            || path.ends_with("sw.js")
            || path.ends_with(".webmanifest");
        let cache = if no_cache { "no-cache" } else { "public, max-age=31536000" };
        Response::builder()
            .status(StatusCode::OK)
            .header("content-type", mime.as_ref())
            .header("cache-control", cache)
            .body(Body::from(file.data.into_owned()))
            .unwrap()
    })
}

// ---------------------------------------------------------------------------
// WebSocket relay
// ---------------------------------------------------------------------------

async fn ws_handler(
    ws: WebSocketUpgrade,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
) -> Response {
    ws.max_message_size(WS_MAX_MESSAGE)
        .on_upgrade(move |socket| handle_socket(socket, state, canonical_ip(addr.ip())))
}

async fn send_to(state: &Arc<AppState>, conn_id: u64, msg: &Value) {
    if let Some(tx) = state.clients.lock().await.get(&conn_id) {
        let _ = tx.send(Message::Text(msg.to_string()));
    }
}

fn send_error(tx: &Tx, code: &str, message: &str, match_id: Option<&str>) {
    let mut err = json!({ "type": "error", "code": code, "message": message });
    if let Some(id) = match_id {
        err["matchId"] = json!(id);
    }
    let _ = tx.send(Message::Text(err.to_string()));
}

/// Connections that proved the scoreboard role for at least one match.
async fn scoreboard_ids(state: &Arc<AppState>) -> HashSet<u64> {
    state
        .owners
        .lock()
        .await
        .iter()
        .filter(|(_, owned)| !owned.is_empty())
        .map(|(id, _)| *id)
        .collect()
}

/// Ask the connected scoreboards; returns the validated result (see
/// `on_response`) or None on timeout / no scoreboard / every one declined.
async fn ws_roundtrip(
    state: &Arc<AppState>,
    request_msg: Value,
    request_id: &str,
    response_type: &str,
    match_id: Option<String>,
) -> Option<Value> {
    let targets = scoreboard_ids(state).await;
    if targets.is_empty() {
        return None;
    }
    let (tx, rx) = oneshot::channel();
    state.pending.lock().await.insert(
        request_id.to_string(),
        Pending { tx, response_type: response_type.to_string(), match_id, targets: targets.clone() },
    );
    for id in targets {
        send_to(state, id, &request_msg).await;
    }
    match tokio::time::timeout(Duration::from_secs(5), rx).await {
        Ok(Ok(v)) => Some(v),
        _ => {
            state.pending.lock().await.remove(request_id);
            None
        }
    }
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>, ip: IpAddr) {
    let (mut sink, mut stream) = socket.split();
    let conn_id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    state.clients.lock().await.insert(conn_id, tx.clone());
    state.conn_meta.lock().await.insert(
        conn_id,
        ConnMeta {
            ip,
            role: "subscriber".to_string(),
            team: None,
            aliases: HashMap::new(),
            pin_keys: Vec::new(),
            access: HashMap::new(),
            connected_at: iso_now(),
        },
    );

    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    let _ = tx.send(Message::Text(
        json!({ "type": "connected", "message": "Connected to eScoresheet WebSocket server", "timestamp": now_ms() }).to_string(),
    ));

    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(t) => handle_ws_message(&state, conn_id, &tx, &t).await,
            Message::Close(_) => break,
            _ => {}
        }
    }

    state.clients.lock().await.remove(&conn_id);
    state.conn_meta.lock().await.remove(&conn_id);
    state.limits.lock().await.remove(&format!("fail:ws:{conn_id}"));
    {
        let mut owners = state.owners.lock().await;
        if let Some(owned) = owners.remove(&conn_id) {
            let now = std::time::Instant::now();
            let mut orphaned = state.orphaned_since.lock().await;
            for id in owned {
                if !owners.values().any(|o| o.contains(&id)) {
                    orphaned.insert(id, now);
                }
            }
        }
    }
    {
        let mut subs = state.subs.lock().await;
        subs.retain(|_, set| {
            set.remove(&conn_id);
            !set.is_empty()
        });
    }
    // A scoreboard that left can no longer answer pending requests.
    {
        let mut pending = state.pending.lock().await;
        pending.retain(|_, p| {
            p.targets.remove(&conn_id);
            !p.targets.is_empty()
        });
    }
    send_task.abort();
}

async fn is_owner(state: &Arc<AppState>, conn_id: u64, match_id: &str) -> bool {
    state
        .owners
        .lock()
        .await
        .get(&conn_id)
        .map_or(false, |o| o.contains(match_id))
}

/// Squatting limits for a connection about to own an id it did not own.
fn new_claim_denied(
    owners: &HashMap<u64, HashSet<String>>,
    meta: &HashMap<u64, ConnMeta>,
    limits: &mut HashMap<String, Window>,
    ip: Option<IpAddr>,
    match_id: &str,
) -> Option<&'static str> {
    let ip = match ip {
        Some(ip) if !ip.is_loopback() => ip, // the scoretable machine itself is exempt
        _ => return None,
    };
    let mut ids: HashSet<&String> = HashSet::new();
    for (cid, owned) in owners.iter() {
        if meta.get(cid).map(|m| m.ip) == Some(ip) {
            ids.extend(owned.iter().filter(|id| id.as_str() != match_id));
        }
    }
    if ids.len() >= MAX_OWNED_PER_IP {
        return Some("too-many-matches");
    }
    if window_bump(limits, &format!("new:{ip}")) > NEW_CLAIM_LIMIT {
        return Some("rate-limited");
    }
    None
}

fn claim_error_message(code: &str) -> &'static str {
    match code {
        "not-match-owner" => "Match is owned by another scoreboard (game PIN mismatch)",
        "rate-limited" => "Too many failed scoreboard claims. Wait a minute.",
        "too-many-matches" => "This device already drives the maximum number of matches",
        "pins-required" => "Send this match again with its PINs (the relay lost it, or this connection has not proved it yet)",
        _ => "Refused",
    }
}

/// Prove the scoreboard role for `match_id` with the match's own game PIN
/// (port of lanRelayCore `claim`):
/// - a match new to the relay is claimed by its first scoreboard;
/// - a stored match with a game PIN needs the same PIN;
/// - a stored match without one (test match) may be written by anyone, but
///   only an existing owner may attach a PIN to it;
/// - a match nobody has owned for ORPHAN_TAKEOVER (finished) / STALE_TAKEOVER
///   (in play) may be taken over; an unfinished one taken over with another
///   PIN may be reclaimed once by its own PIN.
/// A connection that never proved the match and leaves the game PIN out is
/// asked for it ('pins-required'), not counted. Wrong-PIN claims (only claims
/// carrying a PIN) are limited per IP and per connection: over the limit a
/// claim needing proof is refused BEFORE the PIN is compared (no oracle).
async fn claim(
    state: &Arc<AppState>,
    conn_id: u64,
    match_id: &str,
    incoming: Option<&Value>,
) -> Result<ClaimKind, &'static str> {
    let stored = {
        let matches = state.matches.lock().await;
        matches.get(match_id).map(|b| (game_pin_of(b.get("match")), is_finished(b.get("match"))))
    };
    let incoming_pin = game_pin_of(incoming);
    // Fixed lock order: owners -> orphaned -> conn_meta -> limits -> displaced.
    let mut owners = state.owners.lock().await;
    let mut orphaned = state.orphaned_since.lock().await;
    let meta = state.conn_meta.lock().await;
    let mut limits = state.limits.lock().await;
    let mut displaced = state.displaced.lock().await;
    let ip = meta.get(&conn_id).map(|m| m.ip);
    let was_owner = owners.get(&conn_id).map_or(false, |o| o.contains(match_id));

    let grant = |owners: &mut HashMap<u64, HashSet<String>>,
                 orphaned: &mut HashMap<String, std::time::Instant>,
                 kind: ClaimKind| {
        owners.entry(conn_id).or_default().insert(match_id.to_string());
        orphaned.remove(match_id);
        Ok(kind)
    };

    let Some((stored_pin, finished)) = stored else {
        if !was_owner {
            if let Some(code) = new_claim_denied(&owners, &meta, &mut limits, ip, match_id) {
                return Err(code);
            }
        }
        return grant(&mut owners, &mut orphaned, if was_owner { ClaimKind::Owner } else { ClaimKind::New });
    };
    if stored_pin.is_none() && (incoming_pin.is_none() || was_owner) {
        if !was_owner {
            if let Some(code) = new_claim_denied(&owners, &meta, &mut limits, ip, match_id) {
                return Err(code);
            }
        }
        return grant(&mut owners, &mut orphaned, if was_owner { ClaimKind::Owner } else { ClaimKind::Open });
    }
    // An owner re-sending its own PIN proved it already: never rate limited.
    // Leaving the PIN out is fine too (PINs are sent only when they change).
    if was_owner && stored_pin.is_some() && (incoming_pin == stored_pin || !has_game_pin_field(incoming)) {
        return grant(&mut owners, &mut orphaned, ClaimKind::Owner);
    }
    // Proof takes the game PIN. A connection that leaves it out (the scorer
    // after a reconnect) is asked for it: nothing compared, nothing counted.
    if stored_pin.is_some() && !has_game_pin_field(incoming) {
        return Err("pins-required");
    }
    let mut keys = vec![format!("fail:ws:{conn_id}")];
    if let Some(ip) = ip {
        keys.push(format!("fail:ip:{ip}"));
    }
    if keys.iter().any(|k| window_count(&limits, k) >= CLAIM_FAILURE_LIMIT) {
        return Err("rate-limited");
    }
    if stored_pin.is_some() && incoming_pin == stored_pin {
        return grant(&mut owners, &mut orphaned, ClaimKind::Proved);
    }
    if incoming_pin.is_some() && displaced.get(match_id) == incoming_pin.as_ref() {
        displaced.remove(match_id);
        for (cid, owned) in owners.iter_mut() {
            if *cid != conn_id {
                owned.remove(match_id);
            }
        }
        return grant(&mut owners, &mut orphaned, ClaimKind::Reclaim);
    }
    let grace = if finished { ORPHAN_TAKEOVER } else { STALE_TAKEOVER };
    let abandoned = !owners.values().any(|o| o.contains(match_id))
        && orphaned.get(match_id).map_or(false, |t| t.elapsed() >= grace);
    if abandoned {
        if let Some(code) = new_claim_denied(&owners, &meta, &mut limits, ip, match_id) {
            return Err(code);
        }
        match &stored_pin {
            Some(p) if incoming_pin.as_ref() != Some(p) && !finished => {
                displaced.insert(match_id.to_string(), p.clone());
            }
            _ => {
                displaced.remove(match_id);
            }
        }
        return grant(&mut owners, &mut orphaned, ClaimKind::Takeover);
    }
    // Only a claim with a PIN is a guess (a null PIN proves nothing either way)
    if incoming_pin.is_some() {
        for k in &keys {
            window_bump(&mut limits, k);
        }
    }
    Err("not-match-owner")
}

/// Store a bundle. A sync carries no liveState: the last one pushed is kept
/// only while the same scoreboard / game PIN keeps the match — never across a
/// takeover, reclaim or PIN change (it would describe another match).
async fn store_bundle(state: &Arc<AppState>, match_id: &str, mut bundle: Value, kind: ClaimKind) -> Value {
    let mut matches = state.matches.lock().await;
    if let Some(prev) = matches.get(match_id) {
        if matches!(kind, ClaimKind::Owner | ClaimKind::Proved) {
            carry_match_secrets(prev.get("match"), &mut bundle);
            // A sync without its teams keeps the sport the same scorer set before
            if bundle.get("sportType").is_none() {
                if let Some(sport) = prev.get("sportType").cloned() {
                    bundle["sportType"] = sport;
                }
            }
        }
        let same_pin = game_pin_of(prev.get("match")) == game_pin_of(bundle.get("match"));
        if matches!(kind, ClaimKind::Owner | ClaimKind::Proved) && same_pin && bundle.get("liveState").is_none() {
            if let Some(prev_live) = prev.get("liveState").cloned() {
                bundle["liveState"] = prev_live;
            }
        }
    }
    matches.insert(match_id.to_string(), bundle.clone());
    bundle
}

async fn delete_match(state: &Arc<AppState>, match_id: &str) {
    // Tell the subscribers BEFORE their room is dropped.
    notify_subscribers(state, match_id, &json!({ "type": "match-deleted", "matchId": match_id }), None).await;
    state.subs.lock().await.remove(match_id);
    state.matches.lock().await.remove(match_id);
    state.orphaned_since.lock().await.remove(match_id);
    state.displaced.lock().await.remove(match_id);
    for owned in state.owners.lock().await.values_mut() {
        owned.remove(match_id);
    }
}

async fn handle_ws_message(state: &Arc<AppState>, conn_id: u64, tx: &Tx, text: &str) {
    let data: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => {
            send_error(tx, "bad-request", "Invalid message format", None);
            return;
        }
    };
    let msg_type = data.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let match_id = norm_id(data.get("matchId"));

    match msg_type {
        "ping" => {
            let _ = tx.send(Message::Text(json!({ "type": "pong", "timestamp": now_ms() }).to_string()));
        }
        "sync-match-data" => {
            let bundle = bundle_from(&data);
            let raw_id = match_id;
            let key = relay_key_of(raw_id.clone(), bundle.as_ref().and_then(|b| b.get("match")));
            let (Some(match_id), Some(bundle)) = (key, bundle) else {
                send_error(tx, "bad-request", "sync-match-data needs matchId and match", None);
                return;
            };
            // A scoreboard leaves its PINs out once the relay holds them. If the
            // relay lost the match meanwhile, a PIN-less sync would recreate it
            // without PINs (claimable by anyone): ask for them instead.
            let sent_pins = has_any_pin_field(bundle.get("match"));
            let held = state.matches.lock().await.contains_key(&match_id);
            let pins_required = {
                let mut meta = state.conn_meta.lock().await;
                match meta.get_mut(&conn_id) {
                    Some(m) if sent_pins => {
                        m.pin_keys.retain(|k| *k != match_id);
                        if m.pin_keys.len() >= MAX_ALIASES {
                            m.pin_keys.remove(0);
                        }
                        m.pin_keys.push(match_id.clone());
                        false
                    }
                    Some(m) => !held && m.pin_keys.contains(&match_id),
                    None => false,
                }
            };
            if pins_required {
                send_error(tx, "pins-required", claim_error_message("pins-required"), Some(&match_id));
                return;
            }
            let kind = match claim(state, conn_id, &match_id, bundle.get("match")).await {
                Ok(kind) => kind,
                Err(code) => {
                    send_error(tx, code, claim_error_message(code), Some(&match_id));
                    return;
                }
            };
            if let Some(raw) = raw_id.filter(|r| *r != match_id) {
                if let Some(m) = state.conn_meta.lock().await.get_mut(&conn_id) {
                    m.aliases.remove(&raw);
                    if m.aliases.len() >= MAX_ALIASES {
                        if let Some(k) = m.aliases.keys().next().cloned() {
                            m.aliases.remove(&k);
                        }
                    }
                    m.aliases.insert(raw, match_id.clone());
                }
            }
            let stored = store_bundle(state, &match_id, bundle, kind).await;
            notify_match_data(state, &match_id, "match-data-update", &stored, data.get("_timestamp").cloned(), Some(conn_id)).await;
        }
        "subscribe-match" => {
            let Some(match_id) = match_id else {
                send_error(tx, "bad-request", "subscribe-match needs matchId", None);
                return;
            };
            state.subs.lock().await.entry(match_id.clone()).or_default().insert(conn_id);
            let device = data.get("device").or_else(|| data.get("role")).and_then(|v| v.as_str());
            let team = data.get("team").and_then(|v| v.as_str()).filter(|t| matches!(*t, "home" | "away"));
            if let Some(m) = state.conn_meta.lock().await.get_mut(&conn_id) {
                if let Some(role) = device.filter(|r| matches!(*r, "referee" | "bench" | "livescore")) {
                    m.role = role.to_string();
                }
                if let Some(team) = team {
                    m.team = Some(team.to_string());
                }
            }
            let stored = state.matches.lock().await.get(&match_id).cloned();
            offer_pin(state, conn_id, tx, &match_id, data.get("pin"), stored.as_ref()).await;
            if let Some(bundle) = stored {
                let full = has_access(state, conn_id, &match_id, Some(&bundle)).await;
                let msg = bundle_message_access("match-full-data", &match_id, &bundle, None, full);
                let _ = tx.send(Message::Text(msg.to_string()));
            }
        }
        "unsubscribe-match" => {
            if let Some(match_id) = match_id {
                let mut subs = state.subs.lock().await;
                if let Some(set) = subs.get_mut(&match_id) {
                    set.remove(&conn_id);
                    if set.is_empty() {
                        subs.remove(&match_id);
                    }
                }
            }
        }
        "match-action" | "live-state-update" | "delete-match" => {
            let Some(match_id) = resolve_key(state, conn_id, match_id).await else {
                send_error(tx, "bad-request", "matchId required", None);
                return;
            };
            if !is_owner(state, conn_id, &match_id).await {
                send_error(tx, "not-match-owner", "Only the match's scoreboard may send this", Some(&match_id));
                return;
            }
            match msg_type {
                "match-action" => {
                    let Some(action) = data.get("action").and_then(|v| v.as_str()) else { return };
                    let now = now_ms();
                    // Scoreboard sends the payload as `data`; `actionData` is the legacy name.
                    let payload = match data.get("data") {
                        Some(d) => d.clone(),
                        None => data.get("actionData").cloned().unwrap_or(Value::Null),
                    };
                    let sb_ts = data
                        .get("_timestamp")
                        .or_else(|| data.get("timestamp"))
                        .cloned()
                        .unwrap_or(json!(now));
                    let msg = json!({
                        "type": "match-action",
                        "matchId": match_id,
                        "action": action,
                        "data": payload,
                        "timestamp": data.get("timestamp").cloned().unwrap_or(Value::Null),
                        "_timestamp": now,
                        "_scoreboardTimestamp": sb_ts,
                    });
                    // Only to connections with access: actions carry players and sanctions
                    notify_access_only(state, &match_id, &msg, Some(conn_id)).await;
                }
                "live-state-update" => {
                    let Some(live) = data.get("liveState").filter(|v| v.is_object()).cloned() else { return };
                    if let Some(bundle) = state.matches.lock().await.get_mut(&match_id) {
                        bundle["liveState"] = live.clone();
                    }
                    let msg = json!({ "type": "live-state-update", "matchId": match_id, "liveState": live });
                    notify_subscribers(state, &match_id, &msg, Some(conn_id)).await;
                }
                _ => delete_match(state, &match_id).await,
            }
        }
        "clear-all-matches" => {
            let owned: Vec<String> = state
                .owners
                .lock()
                .await
                .get(&conn_id)
                .map(|o| o.iter().cloned().collect())
                .unwrap_or_default();
            if owned.is_empty() {
                send_error(tx, "not-scoreboard", "Only a scoreboard that synced its match may clear matches", None);
                return;
            }
            let keep = resolve_key(state, conn_id, norm_id(data.get("keepMatchId"))).await;
            for id in owned {
                if keep.as_deref() == Some(id.as_str()) {
                    continue;
                }
                // Another live socket still drives this match: just drop our claim.
                let mut owners = state.owners.lock().await;
                let co_owned = owners.iter().any(|(other, o)| *other != conn_id && o.contains(&id));
                if co_owned {
                    if let Some(o) = owners.get_mut(&conn_id) {
                        o.remove(&id);
                    }
                } else {
                    drop(owners);
                    delete_match(state, &id).await;
                }
            }
        }
        "match-data-response" | "game-number-response" | "match-update-response" => {
            on_response(state, conn_id, msg_type, &data).await;
        }
        // The relay validates PINs itself, so pin-validation-response is ignored,
        // and there is no catch-all rebroadcast of unknown types.
        _ => {}
    }
}

/// Resolve a pending relay request — only from a scoreboard that was asked.
async fn on_response(state: &Arc<AppState>, conn_id: u64, msg_type: &str, data: &Value) {
    let Some(rid) = data.get("requestId").and_then(|v| v.as_str()) else { return };
    let expected_match = {
        let pending = state.pending.lock().await;
        match pending.get(rid) {
            Some(p) if p.response_type == msg_type && p.targets.contains(&conn_id) => p.match_id.clone(),
            _ => return,
        }
    };
    let success = data.get("success").and_then(|v| v.as_bool()) == Some(true);
    let match_id = norm_id(data.get("matchId")).or_else(|| expected_match.clone());

    let mut result: Option<Value> = None;
    if success {
        if msg_type == "game-number-response" {
            if let (Some(m), Some(id)) = (data.get("match"), &match_id) {
                if is_owner(state, conn_id, id).await {
                    result = Some(json!({ "match": m.clone(), "matchId": id }));
                }
            }
        } else {
            // match-data-response (App.jsx sends `matchData`, Scoreboard.jsx `data`)
            // and match-update-response carry a full bundle. Stored only under its
            // room key (seed_key), and only when that is the id asked for: a Dexie
            // id must not open a second, frozen room.
            let payload = data.get("data").or_else(|| data.get("matchData")).cloned().unwrap_or(Value::Null);
            match (bundle_from(&payload), &match_id) {
                (Some(bundle), Some(id))
                    if Some(id) == expected_match.as_ref()
                        && relay_key_of(Some(id.clone()), bundle.get("match")).as_deref() == Some(id.as_str()) =>
                {
                    if let Ok(kind) = claim(state, conn_id, id, bundle.get("match")).await {
                        let stored = store_bundle(state, id, bundle, kind).await;
                        if msg_type == "match-update-response" {
                            notify_match_data(state, id, "match-data-update", &stored, None, Some(conn_id)).await;
                            result = Some(json!({ "data": stored }));
                        } else {
                            result = Some(stored);
                        }
                    }
                }
                (None, _) if msg_type == "match-update-response" => {
                    result = Some(json!({ "data": Value::Null }));
                }
                _ => {}
            }
        }
    }

    let mut pending = state.pending.lock().await;
    match result {
        Some(v) => {
            if let Some(p) = pending.remove(rid) {
                let _ = p.tx.send(v);
            }
        }
        None => {
            // This scoreboard declined; give up once every asked one has.
            let exhausted = match pending.get_mut(rid) {
                Some(p) => {
                    p.targets.remove(&conn_id);
                    p.targets.is_empty()
                }
                None => false,
            };
            if exhausted {
                pending.remove(rid);
            }
        }
    }
}

// --- PIN-proved access -------------------------------------------------------

async fn pin_blocked(state: &Arc<AppState>, conn_id: u64, ip: IpAddr) -> bool {
    let limits = state.limits.lock().await;
    window_count(&limits, &format!("pinfail:ip:{}", canonical_ip(ip))) >= PIN_FAILURE_LIMIT
        || window_count(&limits, &format!("pinfail:ws:{conn_id}")) >= PIN_FAILURE_LIMIT
}

async fn count_pin_failure(state: &Arc<AppState>, conn_id: u64, ip: IpAddr) {
    let mut limits = state.limits.lock().await;
    window_bump(&mut limits, &format!("pinfail:ip:{}", canonical_ip(ip)));
    window_bump(&mut limits, &format!("pinfail:ws:{conn_id}"));
}

/// subscribe-match `pin`: checked now when the relay holds the match (wrong:
/// 'pin-invalid', counted), else once the match arrives.
async fn offer_pin(state: &Arc<AppState>, conn_id: u64, tx: &Tx, match_id: &str, raw: Option<&Value>, stored: Option<&Value>) {
    let offered: String = match raw {
        Some(Value::String(s)) => s.trim().chars().take(32).collect(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    };
    if offered.is_empty() {
        return;
    }
    let Some(ip) = state.conn_meta.lock().await.get(&conn_id).map(|m| m.ip) else { return };
    if pin_blocked(state, conn_id, ip).await {
        send_error(tx, "rate-limited", "Too many wrong PINs. Wait a minute.", Some(match_id));
        return;
    }
    let m = stored.and_then(|b| b.get("match"));
    if m.is_some() && !pin_grants_access(m, &offered) {
        count_pin_failure(state, conn_id, ip).await;
        send_error(tx, "pin-invalid", "Wrong PIN for this match", Some(match_id));
        return;
    }
    if let Some(meta) = state.conn_meta.lock().await.get_mut(&conn_id) {
        meta.access.remove(match_id);
        if meta.access.len() >= MAX_ACCESS_KEYS {
            if let Some(k) = meta.access.keys().next().cloned() {
                meta.access.remove(&k);
            }
        }
        meta.access.insert(match_id.to_string(), (offered, m.is_some()));
    }
}

/// May this connection get the bundle and match actions (not just the summary)?
async fn has_access(state: &Arc<AppState>, conn_id: u64, match_id: &str, bundle: Option<&Value>) -> bool {
    if is_owner(state, conn_id, match_id).await {
        return true;
    }
    let (offered, verified, ip) = {
        let meta = state.conn_meta.lock().await;
        match meta.get(&conn_id).and_then(|m| m.access.get(match_id).map(|(p, v)| (p.clone(), *v, m.ip))) {
            Some(x) => x,
            None => return false,
        }
    };
    let Some(m) = bundle.and_then(|b| b.get("match")) else { return false };
    if pin_grants_access(Some(m), &offered) {
        if let Some(meta) = state.conn_meta.lock().await.get_mut(&conn_id) {
            if let Some(a) = meta.access.get_mut(match_id) {
                a.1 = true;
            }
        }
        return true;
    }
    // Offered before the match reached the relay: checked once
    if !verified {
        if let Some(meta) = state.conn_meta.lock().await.get_mut(&conn_id) {
            meta.access.remove(match_id);
        }
        count_pin_failure(state, conn_id, ip).await;
    }
    false
}

async fn subscriber_ids(state: &Arc<AppState>, match_id: &str, exclude: Option<u64>) -> Vec<u64> {
    state
        .subs
        .lock()
        .await
        .get(match_id)
        .map(|s| s.iter().copied().filter(|id| Some(*id) != exclude).collect())
        .unwrap_or_default()
}

/// match-full-data / match-data-update to a match's subscribers: full or summary each.
async fn notify_match_data(
    state: &Arc<AppState>,
    match_id: &str,
    msg_type: &str,
    bundle: &Value,
    sb_ts: Option<Value>,
    exclude: Option<u64>,
) {
    let mut full_ids = Vec::new();
    let mut summary_ids = Vec::new();
    for id in subscriber_ids(state, match_id, exclude).await {
        if has_access(state, id, match_id, Some(bundle)).await {
            full_ids.push(id);
        } else {
            summary_ids.push(id);
        }
    }
    let full = (!full_ids.is_empty())
        .then(|| bundle_message_access(msg_type, match_id, bundle, sb_ts.clone(), true).to_string());
    let summary = (!summary_ids.is_empty())
        .then(|| bundle_message_access(msg_type, match_id, bundle, sb_ts.clone(), false).to_string());
    let clients = state.clients.lock().await;
    for (ids, text) in [(full_ids, full), (summary_ids, summary)] {
        let Some(text) = text else { continue };
        for id in ids {
            if let Some(tx) = clients.get(&id) {
                let _ = tx.send(Message::Text(text.clone()));
            }
        }
    }
}

/// A message only for the subscribers with access to the match.
async fn notify_access_only(state: &Arc<AppState>, match_id: &str, msg: &Value, exclude: Option<u64>) {
    let bundle = state.matches.lock().await.get(match_id).cloned();
    let mut ids = Vec::new();
    for id in subscriber_ids(state, match_id, exclude).await {
        if has_access(state, id, match_id, bundle.as_ref()).await {
            ids.push(id);
        }
    }
    if ids.is_empty() {
        return;
    }
    let text = msg.to_string();
    let clients = state.clients.lock().await;
    for id in ids {
        if let Some(tx) = clients.get(&id) {
            let _ = tx.send(Message::Text(text.clone()));
        }
    }
}

async fn notify_subscribers(state: &Arc<AppState>, match_id: &str, msg: &Value, exclude: Option<u64>) {
    let sub_ids: Vec<u64> = state
        .subs
        .lock()
        .await
        .get(match_id)
        .map(|s| s.iter().copied().collect())
        .unwrap_or_default();
    if sub_ids.is_empty() {
        return;
    }
    let text = msg.to_string();
    let clients = state.clients.lock().await;
    for id in sub_ids {
        if Some(id) == exclude {
            continue;
        }
        if let Some(tx) = clients.get(&id) {
            let _ = tx.send(Message::Text(text.clone()));
        }
    }
}

// ---------------------------------------------------------------------------
// Tests: the protocol rules shared with lanRelayCore (the full wire scenario
// runs from vitest against a built binary, see lanRelayProtocol.test.js).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tablets_are_the_other_machines() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        let own = [ip("192.168.1.10"), ip("10.42.0.1")];
        let conns = [
            ip("127.0.0.1"),          // the scoretable window
            ip("::1"),
            ip("192.168.1.10"),       // the scoretable on its LAN address
            ip("::ffff:10.42.0.1"),   // same, IPv4-mapped
            ip("192.168.1.20"),       // a tablet
            ip("::ffff:10.42.0.57"),  // a tablet on the laptop's Wi-Fi
        ];
        assert_eq!(count_remote(&conns, &own), 2);
        assert_eq!(count_remote(&[], &own), 0);
    }

    fn bundle(id: u64, pin: &str, status: &str) -> Value {
        json!({
            "match": { "id": id, "status": status, "gamePin": pin, "refereePin": "314159" },
            "homeTeam": null, "awayTeam": null, "homePlayers": [], "awayPlayers": [], "sets": [], "events": [],
        })
    }

    async fn connect(state: &Arc<AppState>, id: u64, ip: &str) {
        state.conn_meta.lock().await.insert(
            id,
            ConnMeta {
                ip: ip.parse().unwrap(),
                role: "subscriber".into(),
                team: None,
                aliases: HashMap::new(),
                pin_keys: Vec::new(),
                access: HashMap::new(),
                connected_at: iso_now(),
            },
        );
    }

    async fn sync(state: &Arc<AppState>, conn: u64, id: &str, b: Value) -> Result<ClaimKind, &'static str> {
        let kind = claim(state, conn, id, b.get("match")).await?;
        store_bundle(state, id, b, kind).await;
        Ok(kind)
    }

    /// The owner of `id` disconnects `ago` ago.
    async fn leave(state: &Arc<AppState>, conn: u64, id: &str, ago: Duration) {
        state.owners.lock().await.remove(&conn);
        let when = std::time::Instant::now().checked_sub(ago).unwrap();
        state.orphaned_since.lock().await.insert(id.to_string(), when);
    }

    #[tokio::test]
    async fn guessing_the_game_pin_is_cut_off_without_an_oracle() {
        let state = new_state(0, 0);
        connect(&state, 1, "192.168.1.10").await;
        connect(&state, 2, "192.168.1.66").await;
        assert!(sync(&state, 1, "7", bundle(7, "987654", "live")).await.is_ok());
        for i in 0..CLAIM_FAILURE_LIMIT {
            let wrong = format!("{}", 100000 + i);
            assert_eq!(sync(&state, 2, "7", bundle(7, &wrong, "live")).await.err(), Some("not-match-owner"));
        }
        // The right PIN is refused exactly like a wrong one now
        assert_eq!(sync(&state, 2, "7", bundle(7, "987654", "live")).await.err(), Some("rate-limited"));
        // The proven scoreboard is unaffected
        assert!(matches!(sync(&state, 1, "7", bundle(7, "987654", "live")).await, Ok(ClaimKind::Owner)));
    }

    #[tokio::test]
    async fn an_unfinished_match_is_kept_for_its_scorer_and_can_be_reclaimed() {
        let state = new_state(0, 0);
        connect(&state, 1, "192.168.1.10").await;
        connect(&state, 2, "192.168.1.66").await;
        connect(&state, 3, "192.168.1.10").await;
        sync(&state, 1, "1", bundle(1, "111111", "live")).await.unwrap();
        state.matches.lock().await.get_mut("1").unwrap()["liveState"] = json!({ "sets_won_a": 2 });

        // Asleep through a set break: not claimable yet
        leave(&state, 1, "1", Duration::from_secs(120)).await;
        assert_eq!(sync(&state, 2, "1", bundle(1, "666666", "live")).await.err(), Some("not-match-owner"));

        // Gone for longer than STALE_TAKEOVER: another scorer may reuse the id,
        // without the old match's live-state
        leave(&state, 1, "1", STALE_TAKEOVER + Duration::from_secs(1)).await;
        assert!(matches!(sync(&state, 2, "1", bundle(1, "666666", "live")).await, Ok(ClaimKind::Takeover)));
        assert!(state.matches.lock().await.get("1").unwrap().get("liveState").is_none());

        // The original game PIN takes it back once
        assert!(matches!(sync(&state, 3, "1", bundle(1, "111111", "live")).await, Ok(ClaimKind::Reclaim)));
        assert!(!is_owner(&state, 2, "1").await);
        assert_eq!(sync(&state, 2, "1", bundle(1, "666666", "live")).await.err(), Some("not-match-owner"));
    }

    #[tokio::test]
    async fn a_finished_match_id_is_reusable_after_a_minute_without_reclaim() {
        let state = new_state(0, 0);
        connect(&state, 1, "192.168.1.10").await;
        connect(&state, 2, "192.168.1.11").await;
        sync(&state, 1, "1", bundle(1, "111111", "final")).await.unwrap();
        leave(&state, 1, "1", ORPHAN_TAKEOVER + Duration::from_secs(1)).await;
        assert!(matches!(sync(&state, 2, "1", bundle(1, "222222", "live")).await, Ok(ClaimKind::Takeover)));
        connect(&state, 3, "192.168.1.10").await;
        assert_eq!(sync(&state, 3, "1", bundle(1, "111111", "final")).await.err(), Some("not-match-owner"));
    }

    #[tokio::test]
    async fn live_state_is_kept_only_for_the_same_game_pin() {
        let state = new_state(0, 0);
        connect(&state, 1, "192.168.1.10").await;
        connect(&state, 2, "192.168.1.10").await;
        sync(&state, 1, "7", bundle(7, "987654", "live")).await.unwrap();
        state.matches.lock().await.get_mut("7").unwrap()["liveState"] = json!({ "points_a": 5 });
        // Reconnected scorer (new connection, same PIN) keeps it
        assert!(matches!(sync(&state, 2, "7", bundle(7, "987654", "live")).await, Ok(ClaimKind::Proved)));
        let stored = state.matches.lock().await.get("7").cloned().unwrap();
        assert_eq!(stored["liveState"], json!({ "points_a": 5 }));

        // ...and every match message mirrors it for the LedBox bridge, PIN-free
        let msg = bundle_message("match-full-data", "7", &stored, None);
        assert_eq!(msg["data"], json!({ "liveState": { "points_a": 5 } }));
        assert_eq!(msg["liveState"], json!({ "points_a": 5 }));
        let text = msg.to_string();
        assert!(!text.contains("987654") && !text.contains("314159"));
    }

    #[test]
    fn match_messages_carry_no_personal_data() {
        let mut b = bundle(7, "987654", "live");
        b["match"]["officials"] = json!([{ "role": "1st referee", "lastName": "Ref", "dob": "1980-01-01" }]);
        b["match"]["homeCoachSignature"] = json!("data:image/png;base64,SIG");
        b["match"]["signatures"] = json!({ "home_coach": "data:image/png;base64,SIG" });
        b["match"]["pendingHomeRoster"] = json!({ "players": [] });
        b["match"]["bench_home"] = json!([{ "role": "Coach", "lastName": "Coach", "dob": "1970-02-02" }]);
        b["homePlayers"] = json!([{ "number": 7, "lastName": "Player", "dob": "2000-03-03", "country": "SUI" }]);
        let msg = bundle_message("match-data-update", "7", &b, None);
        let text = msg.to_string();
        for secret in ["1980-01-01", "1970-02-02", "2000-03-03", "SUI", "base64,SIG", "pendingHomeRoster", "officials"] {
            assert!(!text.contains(secret), "{secret} leaked: {text}");
        }
        assert_eq!(msg["homePlayers"][0]["number"], json!(7));
        assert_eq!(msg["match"]["bench_home"][0]["role"], json!("Coach"));
        assert_eq!(msg["match"]["status"], json!("live"));
    }

    #[tokio::test]
    async fn a_lan_device_cannot_squat_on_many_ids() {
        let state = new_state(0, 0);
        connect(&state, 1, "192.168.1.66").await;
        for id in 1..=MAX_OWNED_PER_IP as u64 {
            assert!(sync(&state, 1, &id.to_string(), bundle(id, "000000", "live")).await.is_ok());
        }
        let next = (MAX_OWNED_PER_IP + 1).to_string();
        assert_eq!(sync(&state, 1, &next, bundle(9, "000000", "live")).await.err(), Some("too-many-matches"));
        // The scoretable machine itself is exempt
        connect(&state, 2, "127.0.0.1").await;
        for id in 20..30u64 {
            assert!(sync(&state, 2, &id.to_string(), bundle(id, "000000", "live")).await.is_ok());
        }
    }

    #[tokio::test]
    async fn the_seed_key_is_the_room_and_pins_may_be_left_out() {
        let state = new_state(0, 0);
        connect(&state, 1, "192.168.1.50").await;
        connect(&state, 2, "192.168.1.51").await;
        let seed = "match_1791215210058_aaaaaa";
        let (tx, _rx) = mpsc::unbounded_channel::<Message>();
        let mut m = bundle(1, "111111", "live");
        m["match"]["seed_key"] = json!(seed);
        m["match"]["refereePin"] = json!("314159");
        let sync = json!({ "type": "sync-match-data", "matchId": 1, "match": m["match"].clone() });
        handle_ws_message(&state, 1, &tx, &sync.to_string()).await;
        assert!(state.matches.lock().await.contains_key(seed));
        assert!(!state.matches.lock().await.contains_key("1"));
        // The Dexie id is an alias on that connection only
        assert_eq!(resolve_key(&state, 1, Some("1".into())).await.as_deref(), Some(seed));
        assert_eq!(resolve_key(&state, 2, Some("1".into())).await.as_deref(), Some("1"));
        // PINs left out are kept
        let mut no_pins = m["match"].clone();
        for k in MATCH_SECRET_FIELDS {
            no_pins.as_object_mut().unwrap().remove(*k);
        }
        let sync2 = json!({ "type": "sync-match-data", "matchId": 1, "match": no_pins.clone() });
        handle_ws_message(&state, 1, &tx, &sync2.to_string()).await;
        let stored = state.matches.lock().await.get(seed).cloned().unwrap();
        assert_eq!(stored["match"]["refereePin"], json!("314159"));
        assert_eq!(game_pin_of(stored.get("match")).as_deref(), Some("111111"));
        // ...but a connection that never proved the match must bring the game
        // PIN: it is asked for it, never counted as a failed claim
        for _ in 0..(CLAIM_FAILURE_LIMIT + 2) {
            assert_eq!(claim(&state, 2, seed, Some(&no_pins)).await.err(), Some("pins-required"));
        }
        assert!(matches!(claim(&state, 2, seed, m.get("match")).await, Ok(ClaimKind::Proved)));
    }

    #[tokio::test]
    async fn a_claim_without_a_pin_is_no_guess() {
        let state = new_state(0, 0);
        connect(&state, 1, "192.168.1.50").await;
        connect(&state, 2, "192.168.1.50").await;
        let full = bundle(1, "111111", "live")["match"].clone();
        assert!(claim(&state, 1, "1", Some(&full)).await.is_ok());
        store_bundle(&state, "1", bundle(1, "111111", "live"), ClaimKind::New).await;
        let mut null_pin = full.clone();
        null_pin["gamePin"] = Value::Null;
        for _ in 0..(CLAIM_FAILURE_LIMIT + 1) {
            assert_eq!(claim(&state, 2, "1", Some(&null_pin)).await.err(), Some("not-match-owner"));
        }
        // Not rate limited: the right PIN still proves the match
        assert!(matches!(claim(&state, 2, "1", Some(&full)).await, Ok(ClaimKind::Proved)));
    }

    #[tokio::test]
    async fn a_pinless_sync_of_a_lost_match_asks_for_the_pins() {
        let state = new_state(0, 0);
        connect(&state, 1, "192.168.1.50").await;
        let seed = "match_1791215210058_bbbbbb";
        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
        let mut m = bundle(1, "111111", "live")["match"].clone();
        m["seed_key"] = json!(seed);
        handle_ws_message(&state, 1, &tx, &json!({ "type": "sync-match-data", "matchId": 1, "match": m.clone() }).to_string()).await;
        assert!(state.matches.lock().await.contains_key(seed));
        // The relay loses the match (deleted / expired) while the socket stays
        delete_match(&state, seed).await;
        while rx.try_recv().is_ok() {}
        let mut no_pins = m.clone();
        for k in MATCH_SECRET_FIELDS {
            no_pins.as_object_mut().unwrap().remove(*k);
        }
        handle_ws_message(&state, 1, &tx, &json!({ "type": "sync-match-data", "matchId": 1, "match": no_pins }).to_string()).await;
        assert!(!state.matches.lock().await.contains_key(seed), "no PIN-less room");
        let Ok(Message::Text(err)) = rx.try_recv() else { panic!("expected an error") };
        let err: Value = serde_json::from_str(&err).unwrap();
        assert_eq!(err["code"], json!("pins-required"));
        assert_eq!(err["matchId"], json!(seed));
        // With the PINs it is accepted again
        handle_ws_message(&state, 1, &tx, &json!({ "type": "sync-match-data", "matchId": 1, "match": m }).to_string()).await;
        let stored = state.matches.lock().await.get(seed).cloned().unwrap();
        assert_eq!(game_pin_of(stored.get("match")).as_deref(), Some("111111"));
    }

    #[tokio::test]
    async fn a_match_asked_for_by_its_dexie_id_opens_no_second_room() {
        let state = new_state(0, 0);
        connect(&state, 1, "192.168.1.50").await;
        let seed = "match_1791215210058_cccccc";
        let mut b = bundle(1, "111111", "live");
        b["match"]["seed_key"] = json!(seed);
        let ask = |rid: &str, id: &str| {
            let (tx, rx) = oneshot::channel::<Value>();
            let p = Pending {
                tx,
                response_type: "match-data-response".into(),
                match_id: Some(id.into()),
                targets: HashSet::from([1u64]),
            };
            (rid.to_string(), p, rx)
        };
        // GET /api/match/1: the scoreboard answers with its seed-keyed match
        let (rid, p, mut rx) = ask("r1", "1");
        state.pending.lock().await.insert(rid, p);
        on_response(&state, 1, "match-data-response",
            &json!({ "requestId": "r1", "matchId": "1", "success": true, "data": b.clone() })).await;
        assert!(!state.matches.lock().await.contains_key("1"), "no room under the Dexie id");
        assert!(!state.pending.lock().await.contains_key("r1"), "declined, request settled");
        assert!(rx.try_recv().is_err());
        // Asked by the seed key it is stored there
        let (rid, p, mut rx) = ask("r2", seed);
        state.pending.lock().await.insert(rid, p);
        on_response(&state, 1, "match-data-response",
            &json!({ "requestId": "r2", "matchId": seed, "success": true, "data": b })).await;
        assert!(state.matches.lock().await.contains_key(seed));
        assert!(rx.try_recv().is_ok());
    }

    #[tokio::test]
    async fn the_bundle_only_after_a_pin_of_the_match() {
        let state = new_state(0, 0);
        connect(&state, 1, "192.168.1.50").await;
        connect(&state, 2, "192.168.1.60").await;
        connect(&state, 3, "192.168.1.61").await;
        let (tx1, _rx1) = mpsc::unbounded_channel::<Message>();
        let (tx2, mut rx2) = mpsc::unbounded_channel::<Message>();
        let (tx3, mut rx3) = mpsc::unbounded_channel::<Message>();
        state.clients.lock().await.insert(2, tx2.clone());
        state.clients.lock().await.insert(3, tx3.clone());
        let mut m = bundle(1, "111111", "live")["match"].clone();
        m["refereeConnectionEnabled"] = json!(true);
        let players = json!([{ "number": 7, "lastName": "Player" }]);
        handle_ws_message(&state, 1, &tx1, &json!({ "type": "sync-match-data", "matchId": "7", "match": m, "homePlayers": players }).to_string()).await;
        let next = |rx: &mut mpsc::UnboundedReceiver<Message>| -> Value {
            let Ok(Message::Text(t)) = rx.try_recv() else { panic!("expected a message") };
            serde_json::from_str(&t).unwrap()
        };
        // No PIN: the summary, no roster
        handle_ws_message(&state, 2, &tx2, &json!({ "type": "subscribe-match", "matchId": "7" }).to_string()).await;
        let s = next(&mut rx2);
        assert_eq!(s["type"], json!("match-full-data"));
        assert_eq!(s["access"], json!("summary"));
        assert_eq!(s["homePlayers"], json!([]));
        assert_eq!(s["match"]["status"], json!("live"));
        // The referee PIN: the bundle
        handle_ws_message(&state, 3, &tx3, &json!({ "type": "subscribe-match", "matchId": "7", "pin": "314159" }).to_string()).await;
        let f = next(&mut rx3);
        assert_eq!(f["access"], json!("full"));
        assert_eq!(f["homePlayers"][0]["number"], json!(7));
        assert!(!f.to_string().contains("314159"));
        // Actions reach only the referee
        handle_ws_message(&state, 1, &tx1, &json!({ "type": "match-action", "matchId": "7", "action": "timeout", "data": { "team": "home" } }).to_string()).await;
        assert_eq!(next(&mut rx3)["type"], json!("match-action"));
        assert!(rx2.try_recv().is_err());
        // A wrong PIN is refused and counted; past the limit nothing is compared
        let (tx4, mut rx4) = mpsc::unbounded_channel::<Message>();
        connect(&state, 4, "192.168.1.62").await;
        for _ in 0..PIN_FAILURE_LIMIT {
            handle_ws_message(&state, 4, &tx4, &json!({ "type": "subscribe-match", "matchId": "7", "pin": "000000" }).to_string()).await;
            assert_eq!(next(&mut rx4)["code"], json!("pin-invalid"));
            assert_eq!(next(&mut rx4)["access"], json!("summary"));
        }
        handle_ws_message(&state, 4, &tx4, &json!({ "type": "subscribe-match", "matchId": "7", "pin": "314159" }).to_string()).await;
        assert_eq!(next(&mut rx4)["code"], json!("rate-limited"));
        assert_eq!(next(&mut rx4)["access"], json!("summary"));
        // With the referee connection off the referee PIN grants nothing; the game PIN still does
        let mut off = m.clone();
        off["refereeConnectionEnabled"] = json!(false);
        assert!(!pin_grants_access(Some(&off), "314159"));
        assert!(pin_grants_access(Some(&off), "111111"));
        assert!(!pin_grants_access(Some(&json!({ "status": "live" })), ""));
    }

    /// The livescore on the laptop's Wi-Fi / Bluetooth (utils/relayLivescore):
    /// subscribe-match without a PIN, then the summary and every live state.
    #[tokio::test]
    async fn a_livescore_viewer_follows_the_score_without_a_pin() {
        let state = new_state(0, 0);
        connect(&state, 1, "192.168.1.50").await;
        connect(&state, 2, "192.168.1.60").await;
        let (tx1, _rx1) = mpsc::unbounded_channel::<Message>();
        let (tx2, mut rx2) = mpsc::unbounded_channel::<Message>();
        state.clients.lock().await.insert(2, tx2.clone());
        let mut m = bundle(1, "111111", "live")["match"].clone();
        m["seed_key"] = json!("seed-1");
        m["officials"] = json!([{ "lastName": "Ref", "dob": "1980-01-01" }]);
        let players = json!([{ "number": 7, "lastName": "Player", "dob": "2001-04-17" }]);
        let sets = json!([{ "index": 1, "homePoints": 25, "awayPoints": 20, "finished": true, "matchId": 1 }]);
        let sync_msg = json!({ "type": "sync-match-data", "matchId": 1, "match": m, "homePlayers": players, "sets": sets, "homeTeam": { "name": "Home VC", "color": "#e2001a", "coach": "Cora" } });
        handle_ws_message(&state, 1, &tx1, &sync_msg.to_string()).await;
        let next = |rx: &mut mpsc::UnboundedReceiver<Message>| -> Value {
            let Ok(Message::Text(t)) = rx.try_recv() else { panic!("expected a message") };
            serde_json::from_str(&t).unwrap()
        };
        handle_ws_message(&state, 2, &tx2, &json!({ "type": "subscribe-match", "matchId": "seed-1", "device": "livescore" }).to_string()).await;
        let s = next(&mut rx2);
        assert_eq!(s["access"], json!("summary"));
        assert_eq!(s["sets"], json!([{ "index": 1, "homePoints": 25, "awayPoints": 20, "finished": true }]));
        assert_eq!(s["homeTeam"], json!({ "name": "Home VC", "color": "#e2001a" }));
        let live = json!({ "points_a": 3, "points_b": 1, "serving_team": "left", "timeouts_a": 1, "match_status": "live" });
        handle_ws_message(&state, 1, &tx1, &json!({ "type": "live-state-update", "matchId": 1, "liveState": live }).to_string()).await;
        let l = next(&mut rx2);
        assert_eq!((l["type"].clone(), l["matchId"].clone(), l["liveState"].clone()), (json!("live-state-update"), json!("seed-1"), live.clone()));
        handle_ws_message(&state, 1, &tx1, &sync_msg.to_string()).await;
        let u = next(&mut rx2);
        assert_eq!((u["type"].clone(), u["access"].clone(), u["liveState"].clone()), (json!("match-data-update"), json!("summary"), live));
        let text = format!("{s}{l}{u}");
        for secret in ["111111", "314159", "dob", "lastName", "Cora", "officials", "coach"] {
            assert!(!text.contains(secret), "{secret} in {text}");
        }
    }

    #[tokio::test]
    async fn the_match_list_shows_every_published_match_for_display_devices() {
        let state = new_state(0, 0);
        for (conn, ip) in [(1, "192.168.1.10"), (2, "192.168.1.11"), (3, "192.168.1.12"), (4, "192.168.1.13")] {
            connect(&state, conn, ip).await;
        }
        let mut a = bundle(1, "111111", "scheduled");
        a["match"]["refereeConnectionEnabled"] = json!(false);
        a["match"]["scheduledAt"] = json!("2026-10-05T17:00:00.000Z");
        a["match"]["gameNumber"] = json!(4242);
        a["match"]["homeTeamConnectionEnabled"] = json!(true);
        a["match"]["officials"] = json!([{ "lastName": "Ref", "dob": "1980-01-01" }]);
        a["homeTeam"] = json!({ "name": "Home VC" });
        a["awayTeam"] = json!({ "name": "Away VC" });
        a["homePlayers"] = json!([{ "number": 7, "lastName": "Player", "dob": "2001-04-17" }]);
        let mut b = bundle(1, "222222", "live");
        b["match"]["scheduledAt"] = json!("2026-10-05T19:00:00.000Z");
        let mut t = json!({ "match": { "id": 1, "status": "live", "test": true }, "homeTeam": null, "awayTeam": null });
        t["homePlayers"] = json!([]);
        sync(&state, 1, "seed-a", a).await.unwrap();
        sync(&state, 2, "seed-b", b).await.unwrap();
        sync(&state, 3, "test-seed", t).await.unwrap();
        sync(&state, 4, "seed-d", bundle(1, "444444", "final")).await.unwrap();

        let rows = match_list_rows(&state, false).await;
        let ids: Vec<&str> = rows.iter().map(|r| r["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["seed-b", "seed-a", "test-seed"]);
        assert_eq!(rows[1], json!({
            "id": "seed-a", "gameNumber": 4242, "homeTeam": "Home VC", "awayTeam": "Away VC",
            "scheduledAt": "2026-10-05T17:00:00.000Z", "dateTime": null, "status": "scheduled", "sportType": "indoor", "test": false,
            "refereeConnectionEnabled": false, "homeTeamConnectionEnabled": true, "awayTeamConnectionEnabled": false,
        }));
        assert_eq!(rows[2]["test"], json!(true));
        let text = Value::Array(rows).to_string();
        for secret in ["111111", "222222", "314159", "dob", "Player", "Ref"] {
            assert!(!text.contains(secret), "{secret} in {text}");
        }

        // The livescore (?finished=1) lists the finished one too, same row shape
        let all = match_list_rows(&state, true).await;
        let ids: Vec<&str> = all.iter().map(|r| r["id"].as_str().unwrap()).collect();
        assert_eq!(ids.len(), 4);
        assert!(ids.contains(&"seed-d"));
        let done = all.iter().find(|r| r["id"] == json!("seed-d")).unwrap();
        assert_eq!(done["status"], json!("final"));
        assert_eq!(done.as_object().unwrap().len(), 12);
        assert!(!Value::Array(all.clone()).to_string().contains("444444"));
        assert_eq!(match_list_entry("x", &bundle(1, "1", "ended"), false), None);
        assert!(match_list_entry("x", &bundle(1, "1", "ended"), true).is_some());

        // A scorer gone for longer than the relay holds its match drops out
        leave(&state, 2, "seed-b", Duration::from_secs(120)).await;
        assert_eq!(match_list_rows(&state, false).await.len(), 3);
        leave(&state, 2, "seed-b", STALE_TAKEOVER + Duration::from_secs(1)).await;
        assert_eq!(match_list_rows(&state, false).await.len(), 2);
    }

    #[test]
    fn openbeach_teams_are_the_home_and_away_team() {
        let b = bundle_from(&json!({
            "match": { "id": 1, "status": "live" },
            "team1Team": { "name": "Muster / Meier", "color": "#e2001a" },
            "team2Team": { "name": "Rossi / Bianchi" },
        }))
        .unwrap();
        let row = match_list_entry("beach-1", &b, false).unwrap();
        assert_eq!(row["homeTeam"], json!("Muster / Meier"));
        assert_eq!(row["awayTeam"], json!("Rossi / Bianchi"));
        // The list row names the sport (openbeach lists only its own matches)
        assert_eq!(row["sportType"], json!("beach"));
        let summary = summary_bundle(&b);
        assert_eq!(summary["homeTeam"], json!({ "name": "Muster / Meier", "color": "#e2001a" }));
        // Its periodic sync names them team1 / team2; homeTeam wins when both are sent
        let p = bundle_from(&json!({ "match": { "id": 1 }, "team1": { "name": "A" }, "homeTeam": { "name": "H" }, "team2": "B" })).unwrap();
        let row = match_list_entry("beach-2", &p, false).unwrap();
        assert_eq!((row["homeTeam"].clone(), row["awayTeam"].clone(), row["status"].clone()), (json!("H"), json!("B"), json!("scheduled")));
        // The home/away wire shape naming its sport is beach too; none is indoor
        let wire = bundle_from(&json!({ "match": { "id": 1, "sport_type": "beach" }, "homeTeam": { "name": "A" } })).unwrap();
        assert_eq!(match_list_entry("beach-3", &wire, false).unwrap()["sportType"], json!("beach"));
        let indoor = bundle_from(&json!({ "match": { "id": 1 }, "homeTeam": { "name": "A" } })).unwrap();
        assert_eq!(match_list_entry("indoor-1", &indoor, false).unwrap()["sportType"], json!("indoor"));
    }

    /// An openbeach court as it syncs today: team1 / team2 names, its own PINs.
    fn beach_sync(seed: &str) -> Value {
        json!({
            "type": "sync-match-data",
            "matchId": 1,
            "match": {
                "id": 1, "seed_key": seed, "status": "live",
                "refereeConnectionEnabled": true,
                "team1TeamConnectionEnabled": true,
                "team2TeamConnectionEnabled": false,
                "gamePin": "259730", "refereePin": "360841",
                "team1Pin": "471952", "team2Pin": "582063",
                "team1UploadPin": "693174", "team2UploadPin": "704285",
                "team1TeamUploadPin": "693175", "team2TeamUploadPin": "704286",
                "team1TeamPin": "471953", "team2TeamPin": "582064",
                "matchPin": "815396",
            },
            "team1Team": { "name": "Keller / Huber" },
            "team2Team": { "name": "Weber / Frei" },
            "team1Players": [{ "number": 1, "lastName": "Keller", "dob": "1999-03-14" }],
            "team2Players": [{ "number": 1, "lastName": "Weber", "dob": "1999-03-14" }],
        })
    }

    async fn body_json(r: Response) -> (StatusCode, Value) {
        let status = r.status();
        let bytes = axum::body::to_bytes(r.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    #[test]
    fn openbeach_pins_never_go_out_and_its_bench_pins_grant_the_match() {
        let b = bundle_from(&beach_sync("beach-court-2")).unwrap();
        assert_eq!(bundle_sport(&b), "beach");
        assert_eq!(b["homePlayers"][0]["lastName"], json!("Keller"));
        assert_eq!(b["awayPlayers"][0]["lastName"], json!("Weber"));
        // The referee and the team1 bench (connection on) get in; team2 (off),
        // the upload PINs and openbeach's match-protect PIN do not
        let m = b.get("match");
        assert!(pin_grants_access(m, "360841"));
        assert!(pin_grants_access(m, "471952"));
        assert!(pin_grants_access(m, "259730"));
        for pin in ["582063", "693174", "815396", "000000"] {
            assert!(!pin_grants_access(m, pin), "{pin}");
        }
        // Older builds: team1TeamPin when team1Pin is empty
        let mut old = b.clone();
        old["match"]["team1Pin"] = json!("");
        assert!(pin_grants_access(old.get("match"), "471953"));
        // Nothing the referee gets names a PIN (or the relay's sport note)
        let full = bundle_message_access("match-full-data", "beach-court-2", &b, None, true);
        let text = full.to_string();
        for secret in ["259730", "360841", "471952", "582063", "693174", "704285", "693175", "704286", "471953", "582064", "815396", "Pin\"", "sportType", "1999-03-14"] {
            assert!(!text.contains(secret), "{secret} in {text}");
        }
        assert_eq!(full["homePlayers"][0]["lastName"], json!("Keller"));
        assert!(!summary_bundle(&b).to_string().contains("sportType"));
        // The home/away wire shape with sport_type is beach too; indoor is not
        let wire = bundle_from(&json!({ "match": { "id": 1, "sport_type": "beach" }, "homeTeam": { "name": "A" } })).unwrap();
        assert_eq!(bundle_sport(&wire), "beach");
        assert_eq!(bundle_sport(&bundle(7, "987654", "live")), "indoor");
    }

    #[tokio::test]
    async fn a_scorer_s_team_less_sync_keeps_its_sport() {
        let state = new_state(0, 0);
        connect(&state, 1, "192.168.1.31").await;
        let first = bundle_from(&beach_sync("beach-court-1")).unwrap();
        sync(&state, 1, "beach-court-1", first).await.unwrap();
        let mut periodic = beach_sync("beach-court-1");
        let obj = periodic.as_object_mut().unwrap();
        for k in ["team1Team", "team2Team", "team1Players", "team2Players"] {
            obj.remove(k);
        }
        obj.insert("team1".into(), json!({ "name": "Keller / Huber" }));
        sync(&state, 1, "beach-court-1", bundle_from(&periodic).unwrap()).await.unwrap();
        assert_eq!(bundle_sport(state.matches.lock().await.get("beach-court-1").unwrap()), "beach");
        // and its match list row still names it a beach court
        assert_eq!(match_list_rows(&state, false).await[0]["sportType"], json!("beach"));
    }

    #[tokio::test]
    async fn validate_pin_finds_matches_of_the_asking_sport_only() {
        let state = new_state(0, 0);
        connect(&state, 1, "192.168.1.31").await;
        connect(&state, 2, "192.168.1.32").await;
        sync(&state, 1, "beach-court-2", bundle_from(&beach_sync("beach-court-2")).unwrap()).await.unwrap();
        let mut indoor = bundle(7, "987654", "live");
        indoor["match"]["refereeConnectionEnabled"] = json!(true);
        sync(&state, 2, "7", indoor).await.unwrap();
        let addr: SocketAddr = "192.168.1.40:5000".parse().unwrap();
        let ask = |body: Value| validate_pin(ConnectInfo(addr), State(state.clone()), Json(body));

        let (status, body) = body_json(ask(json!({ "pin": "360841", "type": "referee", "sport": "beach" })).await).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["match"]["id"], json!("beach-court-2"));
        assert_eq!(body["match"]["sportType"], json!("beach"));
        let text = body.to_string();
        for secret in ["259730", "471952", "582063", "693174", "815396", "Pin\""] {
            assert!(!text.contains(secret), "{secret} in {text}");
        }
        // No sport: indoor only (the beach court is not found), and the reverse
        assert_eq!(body_json(ask(json!({ "pin": "360841", "type": "referee" })).await).await.0, StatusCode::NOT_FOUND);
        assert_eq!(body_json(ask(json!({ "pin": "314159", "type": "referee", "sport": "beach" })).await).await.0, StatusCode::NOT_FOUND);
        let (status, body) = body_json(ask(json!({ "pin": "314159", "type": "referee" })).await).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["match"]["id"], json!(7));
        assert!(body["match"].get("sportType").is_none());
        assert_eq!(body_json(ask(json!({ "pin": "314159", "sport": "snow" })).await).await.0, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn the_page_lock_lets_a_browser_score_another_court() {
        let state = new_state(0, 0);
        *state.main_instance.lock().await = Some("desk".into());
        let tablet: SocketAddr = "192.168.1.50:40000".parse().unwrap();
        let page = |headers: HeaderMap, uri: &str| {
            static_handler(ConnectInfo(tablet), State(state.clone()), headers, uri.parse::<Uri>().unwrap())
        };
        // Locked: the "already running" page, with the other-court link
        let r = page(HeaderMap::new(), "/").await;
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
        let html = axum::body::to_bytes(r.into_body(), usize::MAX).await.unwrap();
        assert!(String::from_utf8_lossy(&html).contains("/?court=other"));
        // The link sets the opt-in cookie and goes back to "/"
        let r = page(HeaderMap::new(), "/?court=other").await;
        assert_eq!(r.status(), StatusCode::FOUND);
        assert_eq!(r.headers().get("location").unwrap(), "/");
        let cookie = r.headers().get("set-cookie").unwrap().to_str().unwrap().to_string();
        assert!(cookie.starts_with("ov_other_court=1;"), "{cookie}");
        // With it the tablet gets the scoresheet (reloads included)
        let mut with_cookie = HeaderMap::new();
        with_cookie.insert("cookie", HeaderValue::from_static("theme=light; ov_other_court=1"));
        assert_ne!(page(with_cookie, "/").await.status(), StatusCode::FORBIDDEN);
        // A look-alike cookie does not count, and other pages were never locked
        let mut other = HeaderMap::new();
        other.insert("cookie", HeaderValue::from_static("ov_other_court=10"));
        assert_eq!(page(other, "/").await.status(), StatusCode::FORBIDDEN);
        assert_ne!(page(HeaderMap::new(), "/referee").await.status(), StatusCode::FORBIDDEN);
        assert!(is_other_court_query("x=1&court=other") && !is_other_court_query("court=others"));
    }

    /// The links the relay hands to tablets (/referee, /livescore) open the
    /// role pages of the app it runs: openbeach builds flat *_beach.html
    /// files, so /referee missed both folder lookups and fell back to the
    /// scoretable. A role page the app lacks is a 404, never the scoretable.
    #[test]
    fn role_paths_open_the_role_pages_never_the_scoretable() {
        use crate::flavour::{BEACH, OPENVOLLEY};
        const BEACH_DIST: &[&str] = &[
            "index.html", "referee_beach.html", "livescore_beach.html", "scoreboard_beach.html",
            "scoresheet_beach.html", "assets/main-x.js",
        ];
        let has = |files: &'static [&'static str]| move |p: &str| files.contains(&p);
        let beach = has(BEACH_DIST);
        let r = |path: &str| resolve_asset(path, &BEACH, &beach);
        for path in ["/referee", "/referee/", "/referee.html", "/referee_beach.html"] {
            assert_eq!(r(path).as_deref(), Some("referee_beach.html"), "{path}");
        }
        assert_eq!(r("/livescore").as_deref(), Some("livescore_beach.html"));
        assert_eq!(r("/scoreboard").as_deref(), Some("scoreboard_beach.html"));
        assert_eq!(r("/scoresheet/").as_deref(), Some("scoresheet_beach.html"));
        assert_eq!(r("/bench"), None, "openbeach has no bench page");
        assert_eq!(r("/upload_roster"), None);
        assert_eq!(r("/").as_deref(), Some("index.html"));
        assert_eq!(r("/assets/main-x.js").as_deref(), Some("assets/main-x.js"));
        assert_eq!(r("/some/app/route").as_deref(), Some("index.html"), "SPA fallback for other paths");
        // openbeach's scoretable may also be index_beach.html
        let only_beach_index = has(&["index_beach.html", "referee_beach.html"]);
        assert_eq!(resolve_asset("/", &BEACH, &only_beach_index).as_deref(), Some("index_beach.html"));
        assert_eq!(resolve_asset("/livescore", &BEACH, &only_beach_index), None);

        // OpenVolley: its folder pages, as before
        const OV_DIST: &[&str] = &[
            "index.html", "referee/index.html", "bench/index.html", "livescore/index.html",
            "scoresheet/index.html", "upload_roster/index.html",
        ];
        let ov = has(OV_DIST);
        let o = |path: &str| resolve_asset(path, &OPENVOLLEY, &ov);
        for path in ["/referee", "/referee/", "/referee.html"] {
            assert_eq!(o(path).as_deref(), Some("referee/index.html"), "{path}");
        }
        assert_eq!(o("/bench").as_deref(), Some("bench/index.html"));
        assert_eq!(o("/scoresheet/").as_deref(), Some("scoresheet/index.html"));
        assert_eq!(o("/upload_roster").as_deref(), Some("upload_roster/index.html"));
        assert_eq!(o("/scoreboard"), None);
        assert_eq!(o("/").as_deref(), Some("index.html"));
        assert_eq!(o("/match/7").as_deref(), Some("index.html"));
        // a build without the page (dev, partial dist): 404, not the scoretable
        let bare = has(&["index.html"]);
        assert_eq!(resolve_asset("/referee", &OPENVOLLEY, &bare), None);
    }

    /// The same through the handler, on the embedded build of this app.
    #[tokio::test]
    async fn the_referee_link_never_serves_the_scoretable() {
        let state = new_state(0, 0);
        let tablet: SocketAddr = "192.168.1.50:40000".parse().unwrap();
        let body = |uri: &'static str| {
            let state = state.clone();
            async move {
                let r = static_handler(ConnectInfo(tablet), State(state), HeaderMap::new(), uri.parse::<Uri>().unwrap()).await;
                let status = r.status();
                (status, axum::body::to_bytes(r.into_body(), usize::MAX).await.unwrap())
            }
        };
        let (index_status, index) = body("/").await;
        for uri in ["/referee", "/livescore"] {
            let (status, page) = body(uri).await;
            if index_status == StatusCode::OK {
                assert_ne!(page, index, "{uri} served the scoretable");
            }
            let own = crate::flavour::CURRENT.role_pages.iter().find(|(r, _)| format!("/{r}") == uri).map(|(_, f)| *f).unwrap();
            assert_eq!(status == StatusCode::OK, Assets::get(own).is_some(), "{uri}: {own}");
        }
        let html = main_instance_page(crate::flavour::CURRENT);
        assert!(html.contains("href=\"/referee\"") && html.contains("href=\"/livescore\""));
        assert_eq!(html.contains("href=\"/bench\""), crate::flavour::CURRENT.key == "openvolley");
    }

    #[test]
    fn helpers() {
        assert_eq!(path_match_id(" 7 ".into()).as_deref(), Some("7"));
        assert!(path_match_id("".into()).is_none());
        assert!(path_match_id("x".repeat(MAX_MATCH_ID_LEN + 1)).is_none());
        let iso = iso_now();
        assert_eq!(iso.len(), 24, "{iso}");
        assert!(iso.ends_with('Z') && iso.as_bytes()[10] == b'T');
        assert_eq!(canonical_ip("::ffff:127.0.0.1".parse().unwrap()), "127.0.0.1".parse::<IpAddr>().unwrap());
        assert!(is_local(&"127.0.0.1:1".parse().unwrap()));
        assert!(!is_local(&"203.0.113.9:1".parse().unwrap()));
    }
}
