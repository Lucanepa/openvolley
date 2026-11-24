//! Bench requests: a team's bench tablet sends the starting line-up of a set,
//! a time-out request or a prepared substitution to the scorer, who accepts or
//! declines. The rules of the cloud relay's backend/lib/benchRequests.js and of
//! electron/lanRelayCore.cjs, ported: the relay checks who may send what, keeps
//! the open (and recently answered) requests per match in memory and hands each
//! message to the right connections (relay.rs). The wire scenario every relay
//! passes is backend/tests/helpers/benchRequestContract.js (run against a built
//! binary with OV_TAURI_RELAY_BIN, see lanRelayProtocol.test.js).
//!
//! Pure: no sockets, no locks; the caller passes `now`.

use serde_json::{json, Map, Value};
use std::time::{Duration, Instant};

pub const BENCH_REQUESTS_PER_MINUTE: u32 = 30;
pub const MAX_BENCH_REASON: usize = 200;
pub const MAX_BENCH_PAIRS: usize = 6;
pub const MAX_REQUESTS_PER_TEAM: usize = 12;
pub const BENCH_REQUEST_TTL: Duration = Duration::from_secs(30 * 60);
const LINEUP_KEYS: [&str; 6] = ["I", "II", "III", "IV", "V", "VI"];

// Names every plain JS object has: a scoreboard keys its cards by the id
const OBJECT_PROTO_NAMES: [&str; 12] = [
    "constructor", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toString", "valueOf",
    "toLocaleString", "__proto__", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
];

fn valid_id(v: Option<&Value>) -> Option<String> {
    let s = v?.as_str()?;
    (!s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        && !OBJECT_PROTO_NAMES.contains(&s))
        .then(|| s.to_string())
}

/// A shirt number 1..=99 (an integer, or a string of one or two digits).
fn shirt(v: Option<&Value>) -> Option<i64> {
    let n = match v? {
        Value::Number(n) => n.as_i64()?,
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() || t.len() > 2 || !t.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            t.parse().ok()?
        }
        _ => return None,
    };
    (1..=99).contains(&n).then_some(n)
}

/// A bench-request's request, checked and copied to the known fields only
/// (`Err` is the refusal reason, the same words as the JS relays).
pub fn normalize_request(raw: Option<&Value>) -> Result<Value, &'static str> {
    let Some(raw) = raw.filter(|v| v.is_object()) else { return Err("bad-request") };
    let Some(id) = valid_id(raw.get("id")) else { return Err("bad-id") };
    let kind = raw.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    if !matches!(kind, "lineup" | "timeout" | "substitution" | "cancel") {
        return Err("bad-kind");
    }
    let set_index = raw.get("setIndex").and_then(|v| v.as_i64()).filter(|i| (1..=5).contains(i)).ok_or("bad-set")?;
    let mut out = Map::new();
    out.insert("id".into(), json!(id));
    out.insert("kind".into(), json!(kind));
    out.insert("setIndex".into(), json!(set_index));
    match kind {
        "cancel" => {
            let cancel_id = valid_id(raw.get("cancelId")).ok_or("bad-cancel")?;
            out.insert("cancelId".into(), json!(cancel_id));
        }
        "lineup" => {
            let lu = raw.get("lineup").filter(|v| v.is_object()).ok_or("bad-lineup")?;
            let mut lineup = Map::new();
            let mut seen = Vec::new();
            for k in LINEUP_KEYS {
                let n = shirt(lu.get(k)).ok_or("bad-lineup")?;
                if seen.contains(&n) {
                    return Err("bad-lineup");
                }
                seen.push(n);
                lineup.insert(k.into(), json!(n));
            }
            out.insert("lineup".into(), Value::Object(lineup));
            if let Some(gc) = raw.get("gameCaptain").filter(|v| !v.is_null()) {
                let gc = shirt(Some(gc)).filter(|n| seen.contains(n)).ok_or("bad-captain")?;
                out.insert("gameCaptain".into(), json!(gc));
            }
        }
        "substitution" => {
            let pairs = raw
                .get("pairs")
                .and_then(|v| v.as_array())
                .filter(|a| !a.is_empty() && a.len() <= MAX_BENCH_PAIRS)
                .ok_or("bad-pairs")?;
            let (mut outs, mut ins, mut list) = (Vec::new(), Vec::new(), Vec::new());
            for p in pairs {
                let o = shirt(p.get("out")).ok_or("bad-pairs")?;
                let i = shirt(p.get("in")).ok_or("bad-pairs")?;
                if o == i || outs.contains(&o) || ins.contains(&i) || outs.contains(&i) || ins.contains(&o) {
                    return Err("bad-pairs");
                }
                outs.push(o);
                ins.push(i);
                list.push(json!({ "out": o, "in": i }));
            }
            out.insert("pairs".into(), Value::Array(list));
            if let Some(gc) = raw.get("gameCaptain").filter(|v| !v.is_null()) {
                let gc = shirt(Some(gc)).filter(|n| !outs.contains(n)).ok_or("bad-captain")?;
                out.insert("gameCaptain".into(), json!(gc));
            }
        }
        _ => {}
    }
    Ok(Value::Object(out))
}

/// A bench-response: (id, status, reason).
pub fn normalize_response(raw: &Value) -> Result<(String, String, Option<String>), &'static str> {
    let id = valid_id(raw.get("id")).ok_or("bad-id")?;
    let status = raw.get("status").and_then(|v| v.as_str()).unwrap_or("");
    if !matches!(status, "accepted" | "declined" | "seen") {
        return Err("bad-status");
    }
    let reason = raw
        .get("reason")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(MAX_BENCH_REASON).collect::<String>());
    Ok((id, status.to_string(), reason))
}

/// The set the match is in: the lowest unfinished relayed set, else after the last.
pub fn current_set_of_bundle(bundle: &Value) -> i64 {
    let mut open: Option<i64> = None;
    let mut last = 0;
    for s in bundle.get("sets").and_then(|v| v.as_array()).into_iter().flatten() {
        let Some(i) = s.get("index").and_then(|v| v.as_i64()) else { continue };
        last = last.max(i);
        let finished = s.get("finished").and_then(|v| v.as_bool()) == Some(true);
        if !finished && open.is_none_or(|o| i < o) {
            open = Some(i);
        }
    }
    open.unwrap_or(if last > 0 { last + 1 } else { 1 })
}

fn text(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

fn ct_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Which role a PIN proves for the match: "home" / "away" (that bench's PIN
/// while its connection is on), "referee", else None. The game PIN (the
/// scorer's own devices) proves no bench.
pub fn pin_role_of(m: Option<&Value>, pin: &str) -> Option<&'static str> {
    let m = m.filter(|m| m.is_object())?;
    let p = pin.trim();
    if p.is_empty() {
        return None;
    }
    let on = |k: &str| m.get(k).and_then(|v| v.as_bool()) == Some(true);
    let same = |k: &str| text(m.get(k)).is_some_and(|s| ct_eq(&s, p));
    if on("homeTeamConnectionEnabled") && same("homeTeamPin") {
        return Some("home");
    }
    if on("awayTeamConnectionEnabled") && same("awayTeamPin") {
        return Some("away");
    }
    if on("refereeConnectionEnabled") && same("refereePin") {
        return Some("referee");
    }
    None
}

#[derive(Clone, Debug)]
pub struct BenchEntry {
    pub team: String,
    pub request: Value,
    pub status: String,
    pub reason: Option<String>,
    pub at: Instant,
    /// the relay's clock (ms) when it was kept, for the messages
    pub at_ms: u64,
}

impl BenchEntry {
    pub fn id(&self) -> &str {
        self.request.get("id").and_then(|v| v.as_str()).unwrap_or("")
    }
    pub fn kind(&self) -> &str {
        self.request.get("kind").and_then(|v| v.as_str()).unwrap_or("")
    }
    pub fn set_index(&self) -> i64 {
        self.request.get("setIndex").and_then(|v| v.as_i64()).unwrap_or(0)
    }
    pub fn is_open(&self) -> bool {
        self.status == "pending" || self.status == "seen"
    }
}

pub struct Added {
    pub entry: Option<BenchEntry>,
    pub superseded: Vec<BenchEntry>,
    pub cancelled: Option<BenchEntry>,
}

/// Keep a request in the match's list (oldest first). A new line-up of a team
/// replaces its open line-up of that set, a time-out / substitution request
/// the team's open one of the same kind; an accepted line-up locks the set.
/// cancel drops the team's open request cancelId.
pub fn add(list: &mut Vec<BenchEntry>, team: &str, request: Value, now: Instant, now_ms: u64) -> Result<Added, &'static str> {
    if !matches!(team, "home" | "away") {
        return Err("bad-team");
    }
    let kind = request.get("kind").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let id = request.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let set_index = request.get("setIndex").and_then(|v| v.as_i64()).unwrap_or(0);
    if kind == "cancel" {
        let target = request.get("cancelId").and_then(|v| v.as_str()).unwrap_or("");
        let pos = list.iter().position(|e| e.id() == target && e.team == team && e.is_open()).ok_or("nothing-to-cancel")?;
        let cancelled = list.remove(pos);
        return Ok(Added { entry: None, superseded: Vec::new(), cancelled: Some(cancelled) });
    }
    if let Some(prev) = list.iter().find(|e| e.id() == id) {
        if prev.team != team || !prev.is_open() {
            return Err("duplicate-id");
        }
    }
    if kind == "lineup" && list.iter().any(|e| e.team == team && e.kind() == "lineup" && e.set_index() == set_index && e.status == "accepted") {
        return Err("lineup-locked");
    }
    let mut superseded = Vec::new();
    let mut kept = Vec::with_capacity(list.len() + 1);
    for e in list.drain(..) {
        if e.id() == id {
            continue;
        }
        let same_kind = e.team == team && e.is_open() && e.kind() == kind && (kind != "lineup" || e.set_index() == set_index);
        if same_kind {
            superseded.push(e);
        } else {
            kept.push(e);
        }
    }
    let entry = BenchEntry { team: team.to_string(), request, status: "pending".into(), reason: None, at: now, at_ms: now_ms };
    kept.push(entry.clone());
    *list = kept;
    // Room per team: the oldest answered ones go first, then the oldest
    while list.iter().filter(|e| e.team == team).count() > MAX_REQUESTS_PER_TEAM {
        let victim = list
            .iter()
            .position(|e| e.team == team && !e.is_open())
            .or_else(|| list.iter().position(|e| e.team == team))
            .unwrap();
        list.remove(victim);
    }
    Ok(Added { entry: Some(entry), superseded, cancelled: None })
}

/// The scorer's answer; None when the team has no such open request.
pub fn answer(list: &mut [BenchEntry], team: &str, id: &str, status: &str, reason: Option<String>) -> Option<BenchEntry> {
    let e = list.iter_mut().find(|e| e.id() == id)?;
    if e.team != team || !e.is_open() {
        return None;
    }
    e.status = status.to_string();
    if status != "seen" {
        e.reason = reason;
    }
    Some(e.clone())
}

/// Drop what belongs to a set that is over, and what is older than the TTL.
pub fn prune(list: &mut Vec<BenchEntry>, current_set: i64, now: Instant) {
    list.retain(|e| e.set_index() >= current_set && now.duration_since(e.at) <= BENCH_REQUEST_TTL);
}

/// What the bench is told about one of its requests.
pub fn bench_view(e: &BenchEntry) -> Value {
    let mut v = json!({ "id": e.id(), "kind": e.kind(), "setIndex": e.set_index(), "status": e.status });
    if let Some(r) = &e.reason {
        v["reason"] = json!(r);
    }
    v
}

/// What a referee sees of a time-out / substitution request (never a line-up).
pub fn referee_info(match_id: &str, e: &BenchEntry, status: &str) -> Value {
    let mut v = json!({
        "type": "bench-request-info", "matchId": match_id, "team": e.team, "id": e.id(),
        "kind": e.kind(), "setIndex": e.set_index(), "status": status,
    });
    if let Some(p) = e.request.get("pairs") {
        v["pairs"] = p.clone();
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lineup() -> Value {
        json!({ "I": 1, "II": 2, "III": 3, "IV": 4, "V": 5, "VI": 6 })
    }

    #[test]
    fn an_id_that_every_js_object_has_is_refused() {
        for id in ["constructor", "__proto__", "toString"] {
            assert_eq!(normalize_request(Some(&json!({ "id": id, "kind": "timeout", "setIndex": 1 }))), Err("bad-id"));
        }
        assert!(normalize_request(Some(&json!({ "id": "br-0123456789abcdef01234567", "kind": "timeout", "setIndex": 1 }))).is_ok());
    }

    #[test]
    fn a_line_up_is_six_different_shirts_and_a_captain_among_them() {
        let ok = normalize_request(Some(&json!({ "id": "a-1", "kind": "lineup", "setIndex": 2, "lineup": { "I": "1", "II": 2, "III": 3, "IV": 4, "V": 5, "VI": 6 }, "gameCaptain": 4, "pin": "123456" }))).unwrap();
        assert_eq!(ok, json!({ "id": "a-1", "kind": "lineup", "setIndex": 2, "lineup": lineup(), "gameCaptain": 4 }));
        let with = |lu: Value, gc: Value| normalize_request(Some(&json!({ "id": "a", "kind": "lineup", "setIndex": 1, "lineup": lu, "gameCaptain": gc })));
        assert_eq!(with(json!({ "I": 1, "II": 2, "III": 3, "IV": 4, "V": 5 }), Value::Null), Err("bad-lineup"));
        assert_eq!(with(json!({ "I": 1, "II": 2, "III": 3, "IV": 4, "V": 5, "VI": 1 }), Value::Null), Err("bad-lineup"));
        assert_eq!(with(json!({ "I": 1, "II": 2, "III": 3, "IV": 4, "V": 5, "VI": 100 }), Value::Null), Err("bad-lineup"));
        assert_eq!(with(json!({ "I": 1, "II": 2, "III": 3, "IV": 4, "V": 5, "VI": 2.5 }), Value::Null), Err("bad-lineup"));
        assert_eq!(with(lineup(), json!(9)), Err("bad-captain"));
    }

    #[test]
    fn ids_kinds_sets_and_pairs_are_checked() {
        let r = |v: Value| normalize_request(Some(&v));
        assert_eq!(normalize_request(None), Err("bad-request"));
        assert_eq!(r(json!({ "id": "a b", "kind": "timeout", "setIndex": 1 })), Err("bad-id"));
        assert_eq!(r(json!({ "id": "x".repeat(65), "kind": "timeout", "setIndex": 1 })), Err("bad-id"));
        assert_eq!(r(json!({ "id": "a", "kind": "challenge", "setIndex": 1 })), Err("bad-kind"));
        assert_eq!(r(json!({ "id": "a", "kind": "timeout", "setIndex": 6 })), Err("bad-set"));
        assert_eq!(r(json!({ "id": "a", "kind": "timeout", "setIndex": "1" })), Err("bad-set"));
        assert_eq!(r(json!({ "id": "a", "kind": "timeout", "setIndex": 1, "pairs": [] })).unwrap(), json!({ "id": "a", "kind": "timeout", "setIndex": 1 }));
        assert_eq!(r(json!({ "id": "a", "kind": "cancel", "setIndex": 1 })), Err("bad-cancel"));
        let sub = |pairs: Value| r(json!({ "id": "s", "kind": "substitution", "setIndex": 1, "pairs": pairs }));
        assert!(sub(json!([{ "out": 1, "in": 7 }, { "out": 2, "in": 8 }])).is_ok());
        for bad in [json!([]), json!([{ "out": 1, "in": 1 }]), json!([{ "out": 1, "in": 7 }, { "out": 1, "in": 8 }]), json!([{ "out": 1, "in": 7 }, { "out": 7, "in": 8 }])] {
            assert_eq!(sub(bad.clone()), Err("bad-pairs"), "{bad}");
        }
        assert_eq!(r(json!({ "id": "s", "kind": "substitution", "setIndex": 1, "pairs": [{ "out": 1, "in": 7 }], "gameCaptain": 1 })), Err("bad-captain"));
        let (id, status, reason) = normalize_response(&json!({ "id": "a", "status": "declined", "reason": format!("  {}", "r".repeat(300)) })).unwrap();
        assert_eq!((id.as_str(), status.as_str(), reason.map(|r| r.chars().count())), ("a", "declined", Some(200)));
        assert_eq!(normalize_response(&json!({ "id": "a", "status": "maybe" })), Err("bad-status"));
    }

    #[test]
    fn the_store_replaces_locks_cancels_and_prunes() {
        let now = Instant::now();
        let lu = |id: &str, set: i64| json!({ "id": id, "kind": "lineup", "setIndex": set, "lineup": lineup() });
        let mut list = Vec::new();
        add(&mut list, "home", lu("a", 1), now, 0).unwrap();
        let b = add(&mut list, "home", lu("b", 1), now, 0).unwrap();
        assert_eq!(b.superseded.iter().map(|e| e.id().to_string()).collect::<Vec<_>>(), vec!["a"]);
        assert!(add(&mut list, "home", lu("c", 2), now, 0).unwrap().superseded.is_empty());
        assert!(add(&mut list, "away", lu("d", 1), now, 0).unwrap().superseded.is_empty());
        assert!(answer(&mut list, "home", "b", "accepted", None).is_some());
        assert_eq!(add(&mut list, "home", lu("e", 1), now, 0).err(), Some("lineup-locked"));
        assert!(answer(&mut list, "home", "b", "declined", None).is_none());
        assert!(answer(&mut list, "away", "c", "accepted", None).is_none());
        add(&mut list, "away", json!({ "id": "t", "kind": "timeout", "setIndex": 1 }), now, 0).unwrap();
        assert!(answer(&mut list, "away", "t", "seen", None).is_some());
        assert_eq!(add(&mut list, "home", json!({ "id": "x", "kind": "cancel", "setIndex": 1, "cancelId": "t" }), now, 0).err(), Some("nothing-to-cancel"));
        let c = add(&mut list, "away", json!({ "id": "x", "kind": "cancel", "setIndex": 1, "cancelId": "t" }), now, 0).unwrap();
        assert_eq!(c.cancelled.unwrap().id(), "t");
        assert_eq!(list.iter().filter(|e| e.is_open()).map(|e| e.id().to_string()).collect::<Vec<_>>(), vec!["c", "d"]);
        prune(&mut list, 2, now);
        assert_eq!(list.iter().map(|e| e.id().to_string()).collect::<Vec<_>>(), vec!["c"]);
        prune(&mut list, 2, now + BENCH_REQUEST_TTL + Duration::from_secs(1));
        assert!(list.is_empty());
    }

    #[test]
    fn pins_prove_a_bench_only_while_it_is_on_and_the_game_pin_none() {
        let m = json!({ "homeTeamPin": "111111", "awayTeamPin": 222222, "refereePin": "333333", "gamePin": "444444",
            "homeTeamConnectionEnabled": true, "awayTeamConnectionEnabled": false, "refereeConnectionEnabled": true });
        assert_eq!(pin_role_of(Some(&m), "111111"), Some("home"));
        assert_eq!(pin_role_of(Some(&m), "222222"), None);
        assert_eq!(pin_role_of(Some(&m), "333333"), Some("referee"));
        assert_eq!(pin_role_of(Some(&m), "444444"), None);
        assert_eq!(current_set_of_bundle(&json!({ "sets": [] })), 1);
        assert_eq!(current_set_of_bundle(&json!({ "sets": [{ "index": 1, "finished": true }, { "index": 2 }] })), 2);
        assert_eq!(current_set_of_bundle(&json!({ "sets": [{ "index": 1, "finished": true }] })), 2);
    }
}
