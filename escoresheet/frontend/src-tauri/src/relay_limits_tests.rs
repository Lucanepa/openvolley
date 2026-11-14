//! Desktop relay limits and parity with lanRelayCore: Origin / Host rule,
//! socket and queue caps, room budgets, PIN budgets, the claim file, the
//! relay host's rooms, by-game-number, roster upload, validate-pin and the
//! connections list.
use super::*;

fn conn_meta(ip: &str) -> ConnMeta {
    ConnMeta {
        ip: ip.parse().unwrap(),
        role: "subscriber".into(),
        team: None,
        aliases: HashMap::new(),
        pin_keys: Vec::new(),
        access: HashMap::new(),
        connected_at: iso_now(),
        scorer_device: None,
    }
}

async fn connect(state: &Arc<AppState>, id: u64, ip: &str) -> mpsc::UnboundedReceiver<Message> {
    let (tx, rx) = tx_pair();
    state.clients.lock().await.insert(id, tx);
    state.conn_meta.lock().await.insert(id, conn_meta(ip));
    rx
}

fn seed_bundle(seed: &str, pin: &str) -> Value {
    json!({
        "match": { "id": 1, "seed_key": seed, "status": "live", "gamePin": pin, "refereePin": "314159",
                   "refereeConnectionEnabled": true, "gameNumber": "4242", "homeTeamUploadPin": "777111",
                   "bench_home": [{ "firstName": "Kim", "role": "coach", "dob": "1990-01-01" }],
                   "remarks": "home #3 left the court injured" },
        "homeTeam": { "name": "Lakeside" }, "awayTeam": { "name": "Hillview" },
        "homePlayers": [], "awayPlayers": [], "sets": [],
        "events": [{ "type": "point", "stateSnapshot": { "big": 1 }, "stateBefore": { "big": 2 } }],
    })
}

async fn sync_as(state: &Arc<AppState>, conn: u64, id: &str, b: Value) -> Result<ClaimKind, &'static str> {
    let ip = state.conn_meta.lock().await.get(&conn).map(|m| m.ip).unwrap();
    if let Some(code) = room_budget_denied(state, Some(ip), id, b.to_string().len()).await {
        return Err(code);
    }
    let kind = claim(state, conn, id, b.get("match")).await?;
    note_room(state, id, ip, b.to_string().len()).await;
    store_bundle(state, id, b, kind).await;
    Ok(kind)
}

async fn call(state: &Arc<AppState>, method: &str, uri: &str, addr: &str, headers: &[(&str, &str)], body: Option<Value>) -> (StatusCode, HeaderMap, Value) {
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    let mut b = Request::builder().method(method).uri(uri).header("content-type", "application/json");
    for (k, v) in headers {
        b = b.header(*k, *v);
    }
    let mut req = b.body(body.map_or(Body::empty(), |v| Body::from(v.to_string()))).unwrap();
    req.extensions_mut().insert(ConnectInfo(addr.parse::<SocketAddr>().unwrap()));
    let res = http_router(state.clone()).oneshot(req).await.unwrap();
    let (status, headers) = (res.status(), res.headers().clone());
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (status, headers, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

#[test]
fn the_origin_rule_parses_addresses_and_takes_exact_names() {
    let ok = |o: &str| is_trusted_relay_origin(Some(o), Some("192.168.1.10:5173"));
    for o in ["http://192.168.1.20:5173", "http://10.0.0.4", "http://172.20.1.1:8080", "http://localhost:5173",
              "tauri://localhost", "https://app.openvolley.app", "http://scorer.local", "http://[fe80::1]:5173"] {
        assert!(ok(o), "{o}");
    }
    for o in ["http://10.example.net", "http://192.168.evil.example", "http://172.16.example.com", "https://openvolley.app.example",
              "http://evil.openvolley.app", "http://8.8.8.8", "ftp://10.0.0.4", "http://10.0.0.4/x", "null"] {
        assert!(!ok(o), "{o}");
    }
    let mut h = HeaderMap::new();
    h.insert("host", HeaderValue::from_static("rebind.example.com:8080"));
    assert_eq!(relay_request_refusal(&h), Some("host-not-allowed"));
    h.insert("host", HeaderValue::from_static("192.168.1.10:8080"));
    h.insert("origin", HeaderValue::from_static("http://10.example.net"));
    assert_eq!(relay_request_refusal(&h), Some("origin-not-allowed"));
    h.insert("origin", HeaderValue::from_static("http://192.168.1.10:5173"));
    assert_eq!(relay_request_refusal(&h), None);
}

#[tokio::test]
async fn main_instance_endpoints_take_post_only_and_foreign_pages_are_refused() {
    let state = new_state(0, 0);
    assert_eq!(call(&state, "GET", "/api/server/unregister-main", "127.0.0.1:1", &[], None).await.0, StatusCode::METHOD_NOT_ALLOWED);
    let foreign = [("origin", "http://10.example.net")];
    assert_eq!(call(&state, "POST", "/api/server/unregister-main", "127.0.0.1:1", &foreign, None).await.0, StatusCode::FORBIDDEN);
    let (_, headers, _) = call(&state, "GET", "/api/match/list", "192.168.1.5:1", &foreign, None).await;
    assert!(headers.get("access-control-allow-origin").is_none());
    assert_eq!(call(&state, "POST", "/api/server/unregister-main", "127.0.0.1:1", &[], None).await.0, StatusCode::OK);
}

#[tokio::test]
async fn sockets_are_capped_per_address_and_given_back() {
    let state = new_state(0, 0);
    let ip: IpAddr = "192.168.1.50".parse().unwrap();
    let slots: Vec<_> = (0..MAX_SOCKETS_PER_IP).map(|_| SocketSlot::take(&state, ip).unwrap()).collect();
    assert!(SocketSlot::take(&state, ip).is_none());
    assert!(SocketSlot::take(&state, "192.168.1.51".parse().unwrap()).is_some());
    drop(slots);
    assert!(SocketSlot::take(&state, ip).is_some());
}

#[test]
fn a_client_that_stops_reading_is_cut_not_buffered_for() {
    let (tx, _rx) = tx_pair();
    let big = "x".repeat(MAX_QUEUED_BYTES / 4 + 1);
    for _ in 0..3 {
        assert!(tx.send(Message::Text(big.clone().into())).is_ok());
    }
    assert!(tx.send(Message::Text(big.into())).is_err());
    // the connection loop is woken to end the connection
    let cut = tx.cut.clone();
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    rt.block_on(async { tokio::time::timeout(Duration::from_millis(100), cut.notified()).await.expect("cut") });
}

#[tokio::test]
async fn a_lan_device_holds_a_bounded_number_of_rooms_across_reconnects() {
    let state = new_state(0, 0);
    for i in 0..MAX_ROOMS_PER_IP as u64 {
        let _rx = connect(&state, 100 + i, "192.168.1.60").await;
        assert!(sync_as(&state, 100 + i, &format!("room-{i}"), seed_bundle(&format!("room-{i}"), "123456")).await.is_ok());
        state.owners.lock().await.remove(&(100 + i)); // the socket closed
        state.limits.lock().await.clear(); // (new ids per minute: another limit)
    }
    let _rx = connect(&state, 200, "192.168.1.60").await;
    state.limits.lock().await.clear();
    assert_eq!(sync_as(&state, 200, "room-x", seed_bundle("room-x", "123456")).await, Err("too-many-matches"));
    // the relay host is not limited per address
    let _rx = connect(&state, 201, "127.0.0.1").await;
    assert!(sync_as(&state, 201, "room-y", seed_bundle("room-y", "123456")).await.is_ok());
    // an idle room of a LAN device goes after ROOM_IDLE_EVICT
    idle_rooms(&state).await;
    for r in state.rooms.lock().await.values_mut() {
        if r.idle_since.is_some() {
            r.idle_since = std::time::Instant::now().checked_sub(ROOM_IDLE_EVICT);
        }
    }
    assert!(sync_as(&state, 200, "room-x", seed_bundle("room-x", "123456")).await.is_ok());
    assert!(!state.matches.lock().await.contains_key("room-0"));
    assert!(state.matches.lock().await.contains_key("room-y"));
}

#[tokio::test]
async fn parked_pin_guesses_are_counted_and_the_match_budget_holds_across_addresses() {
    let state = new_state(0, 0);
    // offers for a match the relay does not hold yet: counted when stored
    let mut refused = 0;
    for c in 1..=8u64 {
        let _rx = connect(&state, c, "192.168.1.70").await;
        let (tx, mut rx) = tx_pair();
        offer_pin(&state, c, &tx, "seed-a", Some(&json!(format!("{:06}", 100000 + c))), None).await;
        if let Ok(Message::Text(t)) = rx.try_recv() {
            assert!(t.contains("rate-limited"));
            refused += 1;
        }
    }
    assert_eq!(refused, 8 - PIN_FAILURE_LIMIT as usize);
    // wrong PINs from ever new addresses: the match's budget ends the guessing
    let _rx = connect(&state, 50, "127.0.0.1").await;
    sync_as(&state, 50, "seed-b", seed_bundle("seed-b", "123456")).await.unwrap();
    let stored = state.matches.lock().await.get("seed-b").cloned();
    for c in 0..MATCH_PIN_FAILURE_LIMIT as u64 {
        let _rx = connect(&state, 300 + c, &format!("10.0.{}.{}", c / 200, c % 200 + 1)).await;
        let (tx, _r) = tx_pair();
        offer_pin(&state, 300 + c, &tx, "seed-b", Some(&json!("999999")), stored.as_ref()).await;
    }
    let _rx = connect(&state, 400, "10.9.9.9").await;
    let (tx, mut rx) = tx_pair();
    offer_pin(&state, 400, &tx, "seed-b", Some(&json!("314159")), stored.as_ref()).await;
    let Ok(Message::Text(t)) = rx.try_recv() else { panic!("no answer") };
    assert!(t.contains("rate-limited"), "{t}");
}

#[tokio::test]
async fn after_a_restart_a_room_s_game_pin_still_decides_and_the_relay_host_wins_its_rooms() {
    let dir = std::env::temp_dir().join(format!("ov-claims-{}", now_ms()));
    let path = dir.join("claims.json");
    let state = new_state(0, 0);
    *state.claims.lock().unwrap() = ClaimFile::load(Some(path.clone()));
    let _rx = connect(&state, 1, "127.0.0.1").await;
    sync_as(&state, 1, "seed-c", seed_bundle("seed-c", "123456")).await.unwrap();
    // restart: a LAN device is first, with another PIN
    let state = new_state(0, 0);
    *state.claims.lock().unwrap() = ClaimFile::load(Some(path.clone()));
    let _rx = connect(&state, 2, "192.168.1.80").await;
    assert_eq!(sync_as(&state, 2, "seed-c", seed_bundle("seed-c", "654321")).await, Err("not-match-owner"));
    assert_eq!(sync_as(&state, 2, "seed-c", seed_bundle("seed-c", "123456")).await, Ok(ClaimKind::Proved));
    // the desktop app wins back the room it published, now held by the LAN device
    let _rx = connect(&state, 4, "127.0.0.1").await;
    assert_eq!(sync_as(&state, 4, "seed-c", seed_bundle("seed-c", "222222")).await, Ok(ClaimKind::Takeover));
    assert!(!state.owners.lock().await.get(&2).map_or(false, |o| o.contains("seed-c")));
    // a room a LAN device published first stays with its scorer
    let _rx = connect(&state, 3, "192.168.1.81").await;
    sync_as(&state, 3, "seed-d", seed_bundle("seed-d", "111111")).await.unwrap();
    assert_eq!(sync_as(&state, 4, "seed-d", seed_bundle("seed-d", "333333")).await, Err("not-match-owner"));
    assert!(state.owners.lock().await.get(&3).map_or(false, |o| o.contains("seed-d")));
    assert_eq!(sync_as(&state, 3, "seed-d", seed_bundle("seed-d", "111111")).await, Ok(ClaimKind::Owner));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn stored_events_carry_no_undo_snapshots() {
    let state = new_state(0, 0);
    let _rx = connect(&state, 1, "127.0.0.1").await;
    sync_as(&state, 1, "seed-e", seed_bundle("seed-e", "123456")).await.unwrap();
    let stored = state.matches.lock().await.get("seed-e").cloned().unwrap();
    assert_eq!(stored["events"][0], json!({ "type": "point" }));
}

#[tokio::test]
async fn by_game_number_gives_the_summary_without_a_pin() {
    let state = new_state(0, 0);
    let _rx = connect(&state, 1, "127.0.0.1").await;
    sync_as(&state, 1, "seed-f", seed_bundle("seed-f", "123456")).await.unwrap();
    let (status, _, body) = call(&state, "GET", "/api/match/by-game-number?gameNumber=4242", "192.168.1.90:1", &[], None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["access"], json!("summary"));
    assert_eq!(body["matchId"], json!("seed-f"));
    let text = body.to_string();
    for private in ["Kim", "injured", "Pin"] {
        assert!(!text.contains(private), "{private} in {text}");
    }
    let (_, _, body) = call(&state, "GET", "/api/match/by-game-number?gameNumber=4242", "192.168.1.90:1", &[("x-ov-match-pin", "777111")], None).await;
    assert_eq!(body["access"], json!("full"));
    assert_eq!(body["match"]["bench_home"][0]["firstName"], json!("Kim"));
    assert!(body["match"]["bench_home"][0].get("dob").is_none());
}

#[tokio::test]
async fn by_game_number_compares_no_pin_once_the_match_budget_is_spent() {
    let state = new_state(0, 0);
    let _rx = connect(&state, 1, "127.0.0.1").await;
    sync_as(&state, 1, "seed-f", seed_bundle("seed-f", "123456")).await.unwrap();
    for _ in 0..MATCH_PIN_FAILURE_LIMIT {
        spend_match_budget(&state, "seed-f").await;
    }
    let (status, _, body) = call(&state, "GET", "/api/match/by-game-number?gameNumber=4242", "192.168.1.91:1", &[("x-ov-match-pin", "777111")], None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["access"], json!("summary"));
    assert!(!body.to_string().contains("Kim"));
}

#[tokio::test]
async fn a_roster_upload_needs_the_team_s_upload_pin_and_goes_to_the_match_s_scoreboard_only() {
    let state = new_state(0, 0);
    let mut owner = connect(&state, 1, "127.0.0.1").await;
    sync_as(&state, 1, "seed-g", seed_bundle("seed-g", "123456")).await.unwrap();
    let mut other = connect(&state, 2, "192.168.1.91").await;
    sync_as(&state, 2, "seed-h", seed_bundle("seed-h", "333333")).await.unwrap();
    let roster = json!({ "pendingHomeRoster": { "players": [] } });
    let at = "192.168.1.92:1";
    assert_eq!(call(&state, "PATCH", "/api/match/seed-g", at, &[], Some(roster.clone())).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(call(&state, "PATCH", "/api/match/seed-g", at, &[("x-ov-match-pin", "314159")], Some(roster.clone())).await.0, StatusCode::FORBIDDEN);
    assert_eq!(call(&state, "PATCH", "/api/match/seed-g", at, &[("x-ov-match-pin", "777111")], Some(json!({ "status": "final" }))).await.0, StatusCode::BAD_REQUEST);
    // the right PIN: asked of seed-g's scoreboard only; a bare success is no answer
    let st = state.clone();
    let req = tokio::spawn(async move { call(&st, "PATCH", "/api/match/seed-g", at, &[("x-ov-match-pin", "777111")], Some(roster)).await.0 });
    let rid = loop {
        if let Ok(Message::Text(t)) = owner.try_recv() {
            let v: Value = serde_json::from_str(&t).unwrap();
            if v["type"] == "match-update-request" {
                break v["requestId"].as_str().unwrap().to_string();
            }
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    };
    while let Ok(Message::Text(t)) = other.try_recv() {
        assert!(!t.contains("match-update-request"));
    }
    on_response(&state, 1, "match-update-response", &json!({ "requestId": rid, "success": true, "matchId": "seed-g" })).await;
    assert_eq!(req.await.unwrap(), StatusCode::INTERNAL_SERVER_ERROR);
}

#[tokio::test]
async fn validate_pin_takes_six_digits_and_limits_wrong_ones_only() {
    let state = new_state(0, 0);
    let _rx = connect(&state, 1, "127.0.0.1").await;
    sync_as(&state, 1, "seed-i", seed_bundle("seed-i", "123456")).await.unwrap();
    let ask = |pin: &str| json!({ "pin": pin, "type": "referee" });
    let at = "192.168.1.93:1";
    assert_eq!(call(&state, "POST", "/api/match/validate-pin", at, &[], Some(ask("ab12cd"))).await.0, StatusCode::BAD_REQUEST);
    for _ in 0..20 {
        assert_eq!(call(&state, "POST", "/api/match/validate-pin", at, &[], Some(ask("314159"))).await.0, StatusCode::OK);
    }
    for _ in 0..VALIDATE_PIN_FAILURES {
        assert_eq!(call(&state, "POST", "/api/match/validate-pin", at, &[], Some(ask("000000"))).await.0, StatusCode::NOT_FOUND);
    }
    let (status, headers, _) = call(&state, "POST", "/api/match/validate-pin", at, &[], Some(ask("314159"))).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert!(headers.get("retry-after").is_some());
}

#[tokio::test]
async fn the_connections_list_and_main_instance_id_are_for_the_relay_host() {
    let state = new_state(0, 0);
    let _rx = connect(&state, 1, "127.0.0.1").await;
    sync_as(&state, 1, "seed-j", seed_bundle("seed-j", "123456")).await.unwrap();
    let _rx = connect(&state, 2, "192.168.1.94").await;
    state.subs.lock().await.entry("seed-j".into()).or_default().insert(2);
    *state.main_instance.lock().await = Some("instance-7".into());
    let (_, _, body) = call(&state, "GET", "/api/server/connections", "192.168.1.95:1", &[], None).await;
    assert_eq!(body["dashboardClients"], json!(1));
    assert_eq!(body["clients"], json!([]));
    assert!(!body.to_string().contains("192.168.1.94"));
    let (_, _, body) = call(&state, "GET", "/api/server/connections?matchId=seed-j", "192.168.1.95:1", &[("x-ov-match-pin", "314159")], None).await;
    assert_eq!(body["clients"][0]["ip"], json!("192.168.1.94"));
    let (_, _, body) = call(&state, "GET", "/api/server/connections", "127.0.0.1:1", &[], None).await;
    assert_eq!(body["clients"][0]["ip"], json!("192.168.1.94"));
    let (_, _, body) = call(&state, "GET", "/api/server/status", "192.168.1.95:1", &[], None).await;
    assert_eq!(body["mainInstanceId"], Value::Null);
    let (_, _, body) = call(&state, "GET", "/api/server/status", "127.0.0.1:1", &[], None).await;
    assert_eq!(body["mainInstanceId"], json!("instance-7"));
}

#[tokio::test]
async fn unknown_match_ids_are_not_asked_for_again_at_once() {
    let state = new_state(0, 0);
    let mut sb = connect(&state, 1, "127.0.0.1").await;
    sync_as(&state, 1, "seed-k", seed_bundle("seed-k", "123456")).await.unwrap();
    let st = state.clone();
    let first = tokio::spawn(async move { call(&st, "GET", "/api/match/nope-1", "192.168.1.96:1", &[], None).await.0 });
    let mut asked = 0;
    let start = std::time::Instant::now();
    while !first.is_finished() && start.elapsed() < Duration::from_secs(7) {
        while let Ok(Message::Text(t)) = sb.try_recv() {
            if t.contains("match-data-request") {
                asked += 1;
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(first.await.unwrap(), StatusCode::NOT_FOUND);
    assert_eq!(call(&state, "GET", "/api/match/nope-1", "192.168.1.96:1", &[], None).await.0, StatusCode::NOT_FOUND);
    while let Ok(Message::Text(t)) = sb.try_recv() {
        if t.contains("match-data-request") {
            asked += 1;
        }
    }
    assert_eq!(asked, 1);
}
