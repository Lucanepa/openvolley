# LedBox Appliance — design blueprint

Status: **Phase A (manual control UI) + Phase B (LAN link) BUILT & tested on the Pi 5.**
Cloud/Supabase source is a stub; polish (auth, persistence, status WS) remains. This
doc stays as the reference/roadmap. Run it with `npm run appliance` (see README).

## Goal
Plug in the Pi, open its web page from any phone/browser (venue LAN or Tailscale),
and either **LINK** the LedBox to a live match (online *or* offline) or drive it
**MANUALLY**. No hardcoded `MATCH_ID`, no dependency on a laptop.

## Already built — reuse as-is
- `src/volleyballMapper.js` — `liveState` → LedBox sections (points, team names+colours, sets, **T** timeouts, **S** subs, serve). ✅
- `src/ledboxClient.js` / `src/ledboxProtocol.js` — TCP/gzip client + codec (Init→SetLayout→SetSections, auto-reconnect). ✅
- `src/relaySubscriber.js` — LAN-relay live-state subscriber (offline path). ✅
- `src/mockLedbox.js` — mock device for hardware-free testing. ✅
- App side — Scoreboard emits `live-state-update` to the relay; `server.js` fans it out. ✅
- `test/e2e-live.mjs` — real relay + real bridge + scripted scoreboard + mock LedBox. ✅

Everything downstream of a `liveState` is done. The appliance is a new **front end**
(match selection + manual entry) on top of that engine.

## New components
1. **Source manager** — exactly one active source produces a `liveState` stream →
   mapper → LedboxClient. Runtime-switchable (no restart). Sources:
   - `lan` — `RelaySubscriber` (offline). ✅ engine exists
   - `cloud` — Supabase realtime on `match_live_state` (online). ✨ new
   - `manual` — the UI sets `liveState` directly. ✨ new
2. **Match discovery**
   - LAN: `GET http://<relay>:5173/api/match/list` (already exists in `server.js`).
   - Cloud: Supabase query for live matches (needs URL + anon key + internet).
   - Merge, label by source, present in the picker.
3. **HTTP server + control API** on the Pi (e.g. `:8890`):
   - `GET  /api/status`   → `{ mode, source, matchId, ledbox:{connected}, lastState }`
   - `GET  /api/matches`  → `[{ source:'lan'|'cloud', id, label, teams, live }]`
   - `POST /api/link`     `{ source, matchId }` → attach to that live match
   - `POST /api/manual`   → switch to manual mode
   - `POST /api/state`    `{ …partial liveState | action }` → manual: set/patch/±point
   - `POST /api/blank`    → clear the LedBox
   - (optional) `WS /ws`  → push status/state to the UI live
4. **Web UI** — one self-contained page (recommend plain HTML/JS, zero build → simplest
   on an offline Pi), phone-friendly:
   - Header: LedBox status 🟢/🔴, current mode/source.
   - **Link** tab: list of matches (LAN + cloud, labelled) → tap to link.
   - **Manual** tab: mini-scoreboard — team names + colour, which side is left,
     ±points per side, set ±, timeout ±, sub ±, serve toggle → posts to `/api/state`.

```
 Pi — one Node service + a web page
 ┌───────────────────────────────────────────────────────────────┐
 │  Control UI (Link │ Manual │ status)                           │
 │      │  control API (HTTP/WS)                                  │
 │  Source manager ─ pick one ─▶ liveState ─▶ mapper ─▶ LedboxClient ─▶ 📟
 │   ├─ lan    (RelaySubscriber)   offline   ✅                    │
 │   ├─ cloud  (Supabase RT)       online    ✨                    │
 │   └─ manual (UI sets state)               ✨                    │
 └───────────────────────────────────────────────────────────────┘
```

## `liveState` contract (mapper input — manual mode builds this directly)
`side_a` ('left'|'right'), `team_a_short`/`_name`/`_color`, `team_b_*`,
`points_a`/`_b`, `sets_won_a`/`_b`, `timeouts_a`/`_b` (array|number),
`subs_a`/`_b` (array|number), `serving_team` ('left'|'right').

## Deployment
- One systemd service (extends the current bridge). Env: `LEDBOX_HOST`/`PORT`,
  `CONTROL_PORT`, optional `SUPABASE_URL`/`SUPABASE_ANON_KEY` for cloud mode.
- Access: `http://<pi-lan-ip>:8890` on the venue LAN; `http://<tailscale-ip>:8890`
  (device `openvolley`) remotely.
- Persist last mode/match to disk so it survives restarts.

## Build order
- **Phase A — Manual mode + UI.** Self-contained; also the ideal first real-hardware
  test tool (drive the board by hand to confirm layout/sections).
- **Phase B — Link to LAN match.** Picker from `/api/match/list` + `RelaySubscriber`.
- **Phase C — Link to cloud match.** Supabase realtime source.
- **Phase D — Polish.** Status WS, persistence, PIN auth, custom-layout upload for hw.

## Open decisions (resolve at build time)
- **UI stack:** plain HTML/JS (zero build, offline-friendly — recommended) vs small vite build.
- **Manual granularity:** server holds the manual `liveState`; UI sends actions/patches (±point, timeout+, etc.) — recommended over the UI sending the whole object.
- **Auth:** the control page can change the board — anyone on venue wifi could too.
  Recommend a simple PIN gate on mutating actions.
- **Match ids:** LAN uses local numeric ids, cloud uses Supabase UUIDs — picker must
  label the source clearly.
- **Real hardware:** confirm the LedBox `volleyball_matchscore` section names
  (`sub1`/`sub2`, team-name fields); upload a custom layout via TCP :12345 if they differ.

## Testing
- Keep `MockLedbox` as the target for the whole appliance (`LEDBOX` via mock).
- Manual: drive via the API → assert the mock panel.
- Link: `test/e2e-live.mjs` already proves the LAN path against the real relay.
