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
//! The WS message protocol and the `/api/*` shapes MUST stay in sync with
//! `electron/relayServer.js` / `server.js` — clients talk to all of them
//! interchangeably.

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

type Tx = mpsc::UnboundedSender<Message>;

pub struct AppState {
    /// matchId -> bundle { match, homeTeam, awayTeam, homePlayers, awayPlayers, sets, events }
    matches: Mutex<HashMap<String, Value>>,
    main_instance: Mutex<Option<String>>,
    clients: Mutex<HashMap<u64, Tx>>,
    subs: Mutex<HashMap<String, HashSet<u64>>>,
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
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
    let pin = body.get("pin").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let typ = body.get("type").and_then(|v| v.as_str()).unwrap_or("referee").to_string();
    if pin.len() != 6 {
        return json_response(StatusCode::BAD_REQUEST, json!({ "success": false, "error": "Invalid PIN format" }));
    }

    // Search the local store first.
    {
        let matches = state.matches.lock().await;
        for (id, bundle) in matches.iter() {
            let m = bundle.get("match").unwrap_or(bundle);
            let (pin_field, enabled_field) = match typ.as_str() {
                "homeTeam" => ("homeTeamPin", "homeTeamConnectionEnabled"),
                "awayTeam" => ("awayTeamPin", "awayTeamConnectionEnabled"),
                _ => ("refereePin", "refereeConnectionEnabled"),
            };
            let match_pin = m.get(pin_field).and_then(|v| v.as_str()).map(|s| s.trim().to_string());
            let enabled = m.get(enabled_field).and_then(|v| v.as_bool()).unwrap_or(false);
            let status = m.get("status").and_then(|v| v.as_str()).unwrap_or("");
            if match_pin.as_deref() == Some(pin.as_str()) && enabled && status != "final" {
                let mut found = m.clone();
                if let Some(obj) = found.as_object_mut() {
                    obj.insert("id".to_string(), json!(id.parse::<i64>().unwrap_or(0)));
                }
                return json_response(StatusCode::OK, json!({ "success": true, "match": found }));
            }
        }
    }

    // Ask the main scoretable over WS.
    let rid = format!("pin-request-{}", state.next_id.fetch_add(1, Ordering::Relaxed));
    let req_msg = json!({ "type": "pin-validation-request", "requestId": rid, "pin": pin, "pinType": typ, "timestamp": 0 });
    match ws_roundtrip(&state, req_msg, &rid).await {
        Some(v) if v.get("success").and_then(|s| s.as_bool()) == Some(true) && v.get("match").is_some() => {
            let m = v.get("match").cloned().unwrap();
            // Cache for future requests.
            if let Some(id) = m.get("id") {
                let key = id.to_string().trim_matches('"').to_string();
                let bundle = v.get("fullData").cloned().unwrap_or_else(|| json!({ "match": m }));
                state.matches.lock().await.insert(key, bundle);
            }
            json_response(StatusCode::OK, json!({ "success": true, "match": m }))
        }
        Some(v) => json_response(
            StatusCode::NOT_FOUND,
            json!({ "success": false, "error": v.get("error").and_then(|e| e.as_str()).unwrap_or("No match found with this PIN") }),
        ),
        None => json_response(
            StatusCode::NOT_FOUND,
            json!({ "success": false, "error": "No match found with this PIN. Make sure the main scoresheet is running and connected." }),
        ),
    }
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
    match ws_roundtrip(&state, req_msg, &rid).await {
        Some(v) if v.get("success").and_then(|s| s.as_bool()) == Some(true) && v.get("data").is_some() => {
            let data = v.get("data").cloned().unwrap();
            state.matches.lock().await.insert(id.clone(), data.clone());
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
            "id": id.parse::<i64>().unwrap_or(0),
            "gameNumber": m.get("gameNumber").cloned().or_else(|| m.get("game_n").cloned()).unwrap_or_else(|| json!(id)),
            "homeTeam": home,
            "awayTeam": away,
            "scheduledAt": m.get("scheduledAt").cloned().unwrap_or(Value::Null),
            "status": status,
            "refereeConnectionEnabled": true,
        }));
    }
    // Only return the most recent open match.
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
    match ws_roundtrip(&state, req_msg, &rid).await {
        Some(v) if v.get("success").and_then(|s| s.as_bool()) == Some(true) && v.get("match").is_some() => {
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
    match ws_roundtrip(&state, req_msg, &rid).await {
        Some(v) if v.get("success").and_then(|s| s.as_bool()) == Some(true) => {
            if let Some(data) = v.get("data") {
                state.matches.lock().await.insert(id.clone(), data.clone());
            }
            let mut out = v.get("data").cloned().unwrap_or_else(|| json!({}));
            if let Some(obj) = out.as_object_mut() {
                obj.insert("success".to_string(), json!(true));
            }
            json_response(StatusCode::OK, out)
        }
        _ => json_response(StatusCode::INTERNAL_SERVER_ERROR, json!({ "success": false, "error": "Update request timeout. Make sure the main scoresheet is running." })),
    }
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
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn broadcast(state: &Arc<AppState>, msg: &Value, exclude: Option<u64>) {
    let text = msg.to_string();
    let clients = state.clients.lock().await;
    for (id, tx) in clients.iter() {
        if Some(*id) == exclude {
            continue;
        }
        let _ = tx.send(Message::Text(text.clone()));
    }
}

async fn ws_roundtrip(state: &Arc<AppState>, request_msg: Value, request_id: &str) -> Option<Value> {
    let (tx, rx) = oneshot::channel();
    state.pending.lock().await.insert(request_id.to_string(), tx);
    broadcast(state, &request_msg, None).await;
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
        json!({ "type": "connected", "message": "Connected to eScoresheet WebSocket server", "timestamp": 0 }).to_string(),
    ));

    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(t) => handle_ws_message(&state, conn_id, &tx, &t).await,
            Message::Close(_) => break,
            _ => {}
        }
    }

    state.clients.lock().await.remove(&conn_id);
    let mut subs = state.subs.lock().await;
    subs.retain(|_, set| {
        set.remove(&conn_id);
        !set.is_empty()
    });
    send_task.abort();
}

async fn handle_ws_message(state: &Arc<AppState>, conn_id: u64, tx: &Tx, text: &str) {
    let data: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return,
    };
    let msg_type = data.get("type").and_then(|v| v.as_str()).unwrap_or("");

    match msg_type {
        "ping" => {
            let _ = tx.send(Message::Text(json!({ "type": "pong", "timestamp": 0 }).to_string()));
        }
        "sync-match-data" => {
            let match_id = match data.get("matchId") {
                Some(v) => v.to_string().trim_matches('"').to_string(),
                None => return,
            };
            let bundle = if let Some(md) = data.get("matchData") {
                md.clone()
            } else if data.get("match").is_some() {
                json!({
                    "match": data.get("match").cloned().unwrap_or(Value::Null),
                    "homeTeam": data.get("homeTeam").cloned().unwrap_or(Value::Null),
                    "awayTeam": data.get("awayTeam").cloned().unwrap_or(Value::Null),
                    "homePlayers": data.get("homePlayers").cloned().unwrap_or_else(|| json!([])),
                    "awayPlayers": data.get("awayPlayers").cloned().unwrap_or_else(|| json!([])),
                    "sets": data.get("sets").cloned().unwrap_or_else(|| json!([])),
                    "events": data.get("events").cloned().unwrap_or_else(|| json!([])),
                })
            } else {
                return;
            };
            state.matches.lock().await.insert(match_id.clone(), bundle.clone());

            // Push to subscribers of this match.
            let sub_ids: Vec<u64> = state
                .subs
                .lock()
                .await
                .get(&match_id)
                .map(|s| s.iter().copied().collect())
                .unwrap_or_default();
            if !sub_ids.is_empty() {
                let update = json!({ "type": "match-data-update", "matchId": match_id, "data": bundle }).to_string();
                let clients = state.clients.lock().await;
                for id in sub_ids {
                    if id == conn_id {
                        continue;
                    }
                    if let Some(ctx) = clients.get(&id) {
                        let _ = ctx.send(Message::Text(update.clone()));
                    }
                }
            }
        }
        "delete-match" => {
            let match_id = data.get("matchId").map(|v| v.to_string().trim_matches('"').to_string()).unwrap_or_default();
            state.matches.lock().await.remove(&match_id);
            notify_subscribers(state, &match_id, &json!({ "type": "match-deleted", "matchId": match_id })).await;
            state.subs.lock().await.remove(&match_id);
        }
        "clear-all-matches" => {
            let keep = data.get("keepMatchId").map(|v| v.to_string().trim_matches('"').to_string());
            let ids: Vec<String> = state.matches.lock().await.keys().cloned().collect();
            for id in ids {
                if keep.as_deref() == Some(id.as_str()) {
                    continue;
                }
                notify_subscribers(state, &id, &json!({ "type": "match-deleted", "matchId": id })).await;
                state.matches.lock().await.remove(&id);
                state.subs.lock().await.remove(&id);
            }
        }
        "subscribe-match" => {
            let match_id = data.get("matchId").map(|v| v.to_string().trim_matches('"').to_string()).unwrap_or_default();
            state.subs.lock().await.entry(match_id.clone()).or_default().insert(conn_id);
            if let Some(bundle) = state.matches.lock().await.get(&match_id) {
                let _ = tx.send(Message::Text(
                    json!({ "type": "match-full-data", "matchId": match_id, "data": bundle }).to_string(),
                ));
            }
        }
        "pin-validation-response" | "match-data-response" | "game-number-response" | "match-update-response" => {
            if let Some(rid) = data.get("requestId").and_then(|v| v.as_str()) {
                if let Some(sender) = state.pending.lock().await.remove(rid) {
                    let _ = sender.send(data.clone());
                }
            }
        }
        _ => {
            broadcast(state, &data, Some(conn_id)).await;
        }
    }
}

async fn notify_subscribers(state: &Arc<AppState>, match_id: &str, msg: &Value) {
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
        if let Some(tx) = clients.get(&id) {
            let _ = tx.send(Message::Text(text.clone()));
        }
    }
}
