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
//!   - PINs are validated by the relay from its own store, never by a WS client.

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
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

#[derive(RustEmbed)]
#[folder = "../dist"]
struct Assets;

/// PIN/secret fields that must never be returned to a client.
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
];

/// Same cap as the Node relays / cloud relay.
const WS_MAX_MESSAGE: usize = 10 * 1024 * 1024;
const MAX_MATCH_ID_LEN: usize = 128;

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

pub struct AppState {
    /// matchId -> bundle { match, homeTeam, awayTeam, homePlayers, awayPlayers, sets, events, liveState? }
    matches: Mutex<HashMap<String, Value>>,
    main_instance: Mutex<Option<String>>,
    clients: Mutex<HashMap<u64, Tx>>,
    subs: Mutex<HashMap<String, HashSet<u64>>>,
    /// connection id -> match ids it proved the scoreboard role for
    owners: Mutex<HashMap<u64, HashSet<String>>>,
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
        pending: Mutex::new(HashMap::new()),
        next_id: AtomicU64::new(1),
        http_port,
        ws_port,
    })
}

pub fn local_ip_string() -> String {
    local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string())
}

fn is_loopback(addr: &SocketAddr) -> bool {
    addr.ip().is_loopback()
}

fn strip_secrets(m: &mut Value) {
    if let Some(obj) = m.as_object_mut() {
        for k in MATCH_SECRET_FIELDS {
            obj.remove(*k);
        }
    }
}

fn strip_bundle_secrets(bundle: &Value) -> Value {
    let mut b = bundle.clone();
    if let Some(m) = b.get_mut("match") {
        strip_secrets(m);
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

/// Build the stored bundle from a sync (flat or `{ matchData }`) or response payload.
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
    Some(json!({
        "match": m.clone(),
        "homeTeam": src.get("homeTeam").cloned().unwrap_or(Value::Null),
        "awayTeam": src.get("awayTeam").cloned().unwrap_or(Value::Null),
        "homePlayers": arr("homePlayers"),
        "awayPlayers": arr("awayPlayers"),
        "sets": arr("sets"),
        "events": arr("events"),
    }))
}

/// A flat, PIN-free match message: `{ type, matchId, match, homeTeam, ..., liveState? }`.
fn bundle_message(msg_type: &str, match_id: &str, bundle: &Value, sb_ts: Option<Value>) -> Value {
    let mut out = strip_bundle_secrets(bundle);
    if let Some(obj) = out.as_object_mut() {
        let now = now_ms();
        obj.insert("type".into(), json!(msg_type));
        obj.insert("matchId".into(), json!(match_id));
        obj.insert("_timestamp".into(), json!(now));
        obj.insert("_scoreboardTimestamp".into(), sb_ts.unwrap_or(json!(now)));
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
    let ws_fut = axum::serve(ws, ws_app.into_make_service());

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
        .route("/api/server/register-main", get(register_main))
        .route("/api/server/unregister-main", get(unregister_main))
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
        HeaderValue::from_static("Content-Type, X-Instance-ID"),
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
    let ip = local_ip_string();
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

async fn register_main(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    let instance_id = headers
        .get("x-instance-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("instance-{}", state.next_id.fetch_add(1, Ordering::Relaxed)));

    let mut main = state.main_instance.lock().await;
    if main.is_none() || is_loopback(&addr) {
        *main = Some(instance_id.clone());
        json_response(StatusCode::OK, json!({ "success": true, "instanceId": instance_id }))
    } else {
        json_response(
            StatusCode::CONFLICT,
            json!({ "success": false, "error": "Main instance already registered", "existingInstanceId": *main }),
        )
    }
}

async fn unregister_main(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    let instance_id = headers
        .get("x-instance-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let mut main = state.main_instance.lock().await;
    if *main == instance_id || is_loopback(&addr) {
        *main = None;
        json_response(StatusCode::OK, json!({ "success": true }))
    } else {
        json_response(
            StatusCode::FORBIDDEN,
            json!({ "success": false, "error": "Not the registered instance" }),
        )
    }
}

async fn validate_pin(State(state): State<Arc<AppState>>, Json(body): Json<Value>) -> Response {
    let pin = match body.get("pin") {
        Some(Value::String(p)) => p.trim().to_string(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    };
    let typ = body.get("type").and_then(|v| v.as_str()).unwrap_or("referee").to_string();
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
            }
            return json_response(StatusCode::OK, json!({ "success": true, "match": found }));
        }
    }
    json_response(
        StatusCode::NOT_FOUND,
        json!({ "success": false, "error": "No match found with this PIN. Make sure the main scoresheet is running and connected." }),
    )
}

async fn match_get(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    {
        let matches = state.matches.lock().await;
        if let Some(bundle) = matches.get(&id) {
            let clean = strip_bundle_secrets(bundle);
            let mut out = clean;
            if let Some(obj) = out.as_object_mut() {
                obj.insert("success".to_string(), json!(true));
            }
            return json_response(StatusCode::OK, out);
        }
    }
    let rid = format!("match-data-request-{}", state.next_id.fetch_add(1, Ordering::Relaxed));
    let req_msg = json!({ "type": "match-data-request", "requestId": rid, "matchId": id });
    // The WS side validates the answer (proven scoreboard, game PIN) and stores it.
    match ws_roundtrip(&state, req_msg, &rid, "match-data-response", Some(id.clone())).await {
        Some(data) => {
            let mut out = strip_bundle_secrets(&data);
            if let Some(obj) = out.as_object_mut() {
                obj.insert("success".to_string(), json!(true));
            }
            json_response(StatusCode::OK, out)
        }
        _ => json_response(
            StatusCode::NOT_FOUND,
            json!({ "success": false, "error": "Match data not found. Make sure the main scoresheet is running and connected." }),
        ),
    }
}

async fn match_list(State(state): State<Arc<AppState>>) -> Response {
    let matches = state.matches.lock().await;
    let mut list: Vec<Value> = Vec::new();
    for (id, bundle) in matches.iter() {
        let m = bundle.get("match").unwrap_or(bundle);
        let enabled = m.get("refereeConnectionEnabled").and_then(|v| v.as_bool()).unwrap_or(false);
        let status = m.get("status").and_then(|v| v.as_str()).unwrap_or("");
        if !enabled || status == "final" || (status != "scheduled" && status != "live") {
            continue;
        }
        let home = bundle
            .get("homeTeam").and_then(|t| t.get("name")).and_then(|v| v.as_str())
            .or_else(|| m.get("homeTeamName").and_then(|v| v.as_str()))
            .unwrap_or("Home");
        let away = bundle
            .get("awayTeam").and_then(|t| t.get("name")).and_then(|v| v.as_str())
            .or_else(|| m.get("awayTeamName").and_then(|v| v.as_str()))
            .unwrap_or("Away");
        list.push(json!({
            "id": public_id(id),
            "gameNumber": m.get("gameNumber").cloned().or_else(|| m.get("game_n").cloned()).unwrap_or_else(|| json!(id)),
            "homeTeam": home,
            "awayTeam": away,
            "scheduledAt": m.get("scheduledAt").cloned().unwrap_or(Value::Null),
            "status": status,
            "refereeConnectionEnabled": true,
        }));
    }
    // Only return the most recent open match (ISO dates sort lexically).
    list.sort_by(|a, b| {
        let ka = a.get("scheduledAt").and_then(|v| v.as_str()).unwrap_or("");
        let kb = b.get("scheduledAt").and_then(|v| v.as_str()).unwrap_or("");
        kb.cmp(ka)
    });
    let active: Vec<Value> = list.into_iter().take(1).collect();
    json_response(StatusCode::OK, json!({ "success": true, "matches": active }))
}

async fn by_game_number(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let game_number = params.get("gameNumber").cloned().unwrap_or_default();
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

async fn server_connections(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let filter = params.get("matchId").cloned();
    let mut clients: Vec<Value> = Vec::new();
    let mut counts = serde_json::Map::new();
    {
        let owners = state.owners.lock().await;
        let subs = state.subs.lock().await;
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
                clients.push(json!({ "id": format!("c{conn}"), "ip": Value::Null, "role": "subscriber", "team": Value::Null, "matchId": match_id }));
            }
        }
    }
    let total = state.clients.lock().await.len();
    json_response(
        StatusCode::OK,
        json!({
            "totalClients": total,
            "dashboardClients": clients.len(),
            "referees": 0,
            "benches": 0,
            "clients": clients,
            "matchSubscriptions": counts,
        }),
    )
}

// ---------------------------------------------------------------------------
// Static file serving (embedded dist) with SPA fallback + main-instance gate
// ---------------------------------------------------------------------------

async fn static_handler(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
    uri: Uri,
) -> Response {
    let path = uri.path();

    // Unknown API routes get JSON, not the SPA's index.html with a 200.
    if path.starts_with("/api/") {
        return json_response(StatusCode::NOT_FOUND, json!({ "success": false, "error": "Not found" }));
    }

    // Single main-instance gate — skipped for the loopback desktop window.
    if (path == "/" || path == "/index.html") && !is_loopback(&addr) {
        if state.main_instance.lock().await.is_some() {
            return (
                StatusCode::FORBIDDEN,
                [("content-type", "text/html")],
                "<!DOCTYPE html><html><head><title>Main Instance Already Running</title></head><body>\
                 <h1>Main Scoresheet Already Running</h1>\
                 <p>Another scoretable is active. You can still open:</p>\
                 <ul><li><a href=\"/referee\">Referee</a></li>\
                 <li><a href=\"/bench\">Bench</a></li>\
                 <li><a href=\"/livescore\">Livescore</a></li></ul></body></html>",
            )
                .into_response();
        }
    }

    serve_asset(path)
}

fn serve_asset(req_path: &str) -> Response {
    let p = req_path.trim_start_matches('/');
    let p = if p.is_empty() { "index.html".to_string() } else { p.to_string() };

    if let Some(r) = try_file(&p) {
        return r;
    }
    if p.ends_with('/') {
        if let Some(r) = try_file(&format!("{}index.html", p)) {
            return r;
        }
    } else if !p.contains('.') {
        if let Some(r) = try_file(&format!("{}.html", p)) {
            return r;
        }
        if let Some(r) = try_file(&format!("{}/index.html", p)) {
            return r;
        }
    } else if let Some(stem) = p.strip_suffix(".html") {
        // Legacy /referee.html links: Vite builds folder pages (referee/index.html).
        if let Some(r) = try_file(&format!("{}/index.html", stem)) {
            return r;
        }
    }
    // SPA fallback
    if let Some(r) = try_file("index.html") {
        return r;
    }
    (StatusCode::NOT_FOUND, "Not Found").into_response()
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

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> Response {
    ws.max_message_size(WS_MAX_MESSAGE)
        .on_upgrade(move |socket| handle_socket(socket, state))
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

async fn handle_socket(socket: WebSocket, state: Arc<AppState>) {
    let (mut sink, mut stream) = socket.split();
    let conn_id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    state.clients.lock().await.insert(conn_id, tx.clone());

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
    state.owners.lock().await.remove(&conn_id);
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

/// Prove the scoreboard role for `match_id` with the match's own game PIN:
/// a match new to the relay is claimed by its first scoreboard; a stored match
/// with a game PIN needs the same PIN; a stored match without one (test match)
/// may be written by anyone, but only an existing owner may attach a PIN to it.
async fn claim(state: &Arc<AppState>, conn_id: u64, match_id: &str, incoming: Option<&Value>) -> bool {
    let stored_pin = {
        let matches = state.matches.lock().await;
        matches.get(match_id).map(|b| game_pin_of(b.get("match")))
    };
    let mut owners = state.owners.lock().await;
    let owned = owners.entry(conn_id).or_default();
    if let Some(stored) = stored_pin {
        let incoming_pin = game_pin_of(incoming);
        match stored {
            Some(p) => {
                if incoming_pin.as_deref() != Some(p.as_str()) {
                    return false;
                }
            }
            None => {
                if incoming_pin.is_some() && !owned.contains(match_id) {
                    return false;
                }
            }
        }
    }
    owned.insert(match_id.to_string());
    true
}

/// Store a bundle, keeping the last pushed liveState (syncs don't carry one).
async fn store_bundle(state: &Arc<AppState>, match_id: &str, mut bundle: Value) -> Value {
    let mut matches = state.matches.lock().await;
    if let Some(prev_live) = matches.get(match_id).and_then(|p| p.get("liveState")).cloned() {
        if bundle.get("liveState").is_none() {
            bundle["liveState"] = prev_live;
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
            let (Some(match_id), Some(bundle)) = (match_id, bundle_from(&data)) else {
                send_error(tx, "bad-request", "sync-match-data needs matchId and match", None);
                return;
            };
            if !claim(state, conn_id, &match_id, bundle.get("match")).await {
                send_error(tx, "not-match-owner", "Match is owned by another scoreboard (game PIN mismatch)", Some(&match_id));
                return;
            }
            let stored = store_bundle(state, &match_id, bundle).await;
            let update = bundle_message("match-data-update", &match_id, &stored, data.get("_timestamp").cloned());
            notify_subscribers(state, &match_id, &update, Some(conn_id)).await;
        }
        "subscribe-match" => {
            let Some(match_id) = match_id else {
                send_error(tx, "bad-request", "subscribe-match needs matchId", None);
                return;
            };
            state.subs.lock().await.entry(match_id.clone()).or_default().insert(conn_id);
            let stored = state.matches.lock().await.get(&match_id).cloned();
            if let Some(bundle) = stored {
                let full = bundle_message("match-full-data", &match_id, &bundle, None);
                let _ = tx.send(Message::Text(full.to_string()));
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
            let Some(match_id) = match_id else {
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
                    notify_subscribers(state, &match_id, &msg, Some(conn_id)).await;
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
            let keep = norm_id(data.get("keepMatchId"));
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
            // and match-update-response carry a full bundle.
            let payload = data.get("data").or_else(|| data.get("matchData")).cloned().unwrap_or(Value::Null);
            match (bundle_from(&payload), &match_id) {
                (Some(bundle), Some(id)) if Some(id) == expected_match.as_ref() => {
                    if claim(state, conn_id, id, bundle.get("match")).await {
                        let stored = store_bundle(state, id, bundle).await;
                        if msg_type == "match-update-response" {
                            let update = bundle_message("match-data-update", id, &stored, None);
                            notify_subscribers(state, id, &update, Some(conn_id)).await;
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
