# @openvolley/ledbox-bridge

Mirrors an OpenVolley live match onto a **Tech4Sport LedBox** LED scoreboard.

```
 eScoresheet (Scoreboard)                 LedBox bridge (this service)            Tech4Sport LedBox
        │  computes liveState                       │                                    │
        └── live-state-update (WS) ─▶  LAN relay ──▶  RelaySubscriber                     │
                                                     │  data.liveState                    │
                                                     ▼                                    │
                                            volleyballMapper ── SetSections ──▶ LedboxClient ──gzip/TCP:8889──▶ 📟
```

Small Node service, **no production dependencies** (uses Node 22's built-in global
`WebSocket` for the relay client and `node:net` for the LedBox). It subscribes to the
LAN relay, maps the live match state onto the LedBox `volleyball_matchscore` layout,
and pushes it over TCP with the documented gzip/JSON protocol.

## Fields shown
points · team short names (in team colour) · sets won · timeouts (**T**) · substitutions (**S**) · serve indicator

## Configure
Copy `.env.example` → `.env`. Key vars: `RELAY_URL`, `MATCH_ID`, `LEDBOX_HOST`.

### Publishing the board to wiedisync (`/live`)
Optional. Set **both** of these and the appliance mirrors every score change to the
club's Directus, so members can follow the match at `wiedisync.kscw.ch/live`:

| Var | Value |
|---|---|
| `DIRECTUS_URL` | `https://directus.kscw.ch` (dev: `https://directus-dev.kscw.ch`) |
| `LIVE_PUBLISH_TOKEN` | static token of `ledbox-board@kscw.ch` — its policy can touch `live_scores` and nothing else |
| `LIVE_CHANNEL` | which row to write; default `kscw` (one board, one row) |

Leave either blank and the publisher is a **no-op** — the board behaves exactly as
it does without it. Every failure inside it (outage, bad token, slow network) is
swallowed, so it can never affect scoring. These are deliberately distinct from
`RELAY_URL`, which is the LAN relay the board *subscribes* to.

⚠️ Prod and dev have **different** tokens, and the dev one is replaced by the
nightly prod clone. Collection, permissions and setup:
`wiedisync/src/modules/live/DIRECTUS-SETUP.md`.

The publisher sends the active sport, so the app renders the right board — the
sport is fixed at boot (switching it restarts the appliance). Note that
`BasketballSource` carries team fouls in `subs_a`/`subs_b`; `livePush` translates
that to explicit `fouls_a`/`fouls_b` on the wire.

## Test / run
```bash
# unit test: mapper → client → mock LedBox (no deps, no hardware) — the on-Pi smoke test
npm run test:mapper

# integration test: mock relay → bridge → mock LedBox (needs devDeps)
npm install && npm run test:relay

# run for real against the built-in mock (no hardware):
MOCK=1 MATCH_ID=123 RELAY_URL=ws://127.0.0.1:8080 node src/bridge.js

# run against a real LedBox:
MATCH_ID=123 LEDBOX_HOST=172.24.1.1 node src/bridge.js
```

## Appliance — web control UI (manual + link)
Instead of the headless bridge, run the **appliance**: a phone-friendly control page
served by the Pi (`CONTROL_PORT`, default 8890) with two modes — **Manual** (drive the
board by hand: names, ±points, sets, timeouts, subs, serve, swap) and **Link** (list LAN
matches from the relay and mirror one live). Cloud/Supabase source is a stub.
```bash
npm run appliance                 # open http://<pi-ip>:8890  (or http://openvolley:8890 over Tailscale)
MOCK=1 npm run appliance          # in-process mock LedBox, no hardware
npm run test:appliance            # API → source → mapper → mock LedBox integration test
```
Architecture and the remaining phases (cloud source, auth, persistence) are in
[`DESIGN-appliance.md`](./DESIGN-appliance.md).

## Deploy on the Pi (systemd)
```bash
# on the Pi (reachable as `ssh openvolley`):
cd ~/ledbox-bridge
cp .env.example .env && nano .env        # set MATCH_ID, LEDBOX_HOST
sudo cp systemd/ledbox-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now ledbox-bridge
journalctl -u ledbox-bridge -f
```

## Status / open items
- **Validated:** mapper + protocol + TCP client + relay subscriber, on the Pi 5 against
  mocks (`npm test`).
- **Wired (app side):** the Scoreboard now also pushes its computed live-state over the
  LAN relay as a `live-state-update` message (`Scoreboard.jsx`); `server.js` merges it
  into the match store and fans it out to subscribers, and the bridge consumes it.
  Verified with mocks — still needs a live end-to-end run with a real scoreboard + relay.
- **Pending (hardware):** confirm the real LedBox's `volleyball_matchscore` section
  names — especially `sub1`/`sub2` and the team-name fields — and upload a custom
  layout via TCP :12345 if they differ.
