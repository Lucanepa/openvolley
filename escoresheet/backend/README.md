# eScoresheet WebSocket Backend

Optional relay server for real-time communication between Scoreboard, Referee, and Bench devices. The app works fully offline without this server -- it only adds live multi-device sync.

## Features

- **Match Rooms**: Isolated WebSocket channels per match
- **Real-time Sync**: Instant updates between Scoreboard, Referee, and Bench
- **PIN Authentication**: Secure match access via 6-digit PINs
- **Email Notifications**: Send match info via Resend API or SMTP
- **Official Match Feeds**: iCal integration with Swiss VolleyManager
- **Dual Mode**: Local network (no internet) or cloud relay

## Architecture

```text
Scoreboard (Tablet 1)
    ↓ WebSocket
Backend Server (this service)
    ↓ Broadcast
Referee (Tablet 2) + Bench (Tablet 3) + Livescore (Display)
```

## Quick Start

### Local Development

```bash
cd escoresheet/backend
npm install
npm start
```

Server runs on `http://localhost:8080`.

### Deploy to Infomaniak

1. Deploy the `escoresheet/backend` directory to your Infomaniak Node.js hosting
2. Set **Start Command** to `node server.js`
3. Set environment variables: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY` (or SMTP vars)

### Verify Deployment

Test the health endpoint:

```bash
curl https://backend.openvolley.app/health
```

Expected response:

```json
{
  "status": "healthy",
  "mode": "cloud",
  "uptime": 123.45,
  "connections": 0,
  "activeRooms": 0
}
```

Test WebSocket (browser console):

```javascript
const ws = new WebSocket('wss://backend.openvolley.app')
ws.onopen = () => console.log('Connected!')
ws.onmessage = (e) => console.log('Message:', e.data)
```

### Configure Frontend

Set `VITE_BACKEND_URL` so the frontend knows where to find the backend:

**For local dev**: Create `.env` in `escoresheet/frontend/`:

```env
VITE_BACKEND_URL=http://localhost:8080
```

**For CI/CD**: Add `VITE_BACKEND_URL` as a GitHub repository secret, then rebuild.

## Deployment Options

| Option | Use Case | Internet | Latency | Cost |
| --- | --- | --- | --- | --- |
| **Local network** | Gymnasium WiFi, tablet hotspot | Not needed | Very low | Free |
| **Render (cloud)** | Remote referee, multiple locations | Required | ~50-200ms | Free tier |
| **Hybrid** | Primary local, cloud fallback | Optional | Low | Free |

### Local Network Setup

1. Run backend on a laptop connected to the same WiFi as the tablets
2. Find the laptop's local IP (e.g., `192.168.1.100`)
3. Set `VITE_BACKEND_URL=http://192.168.1.100:8080` in the frontend

### Hybrid Setup

Deploy to Render for cloud backup, also run locally when available. The frontend tries local first and falls back to cloud automatically.

## Environment Variables

| Variable | Description | Default |
| --- | --- | --- |
| `PORT` | Server port | `8080` |
| `RENDER` | Auto-set by Render (enables cloud mode) | - |
| `RESEND_API_KEY` | Resend API key for email (recommended) | - |
| `RESEND_FROM` | Sender address for Resend | `eScoresheet <escoresheet@openvolley.app>` |
| `SMTP_HOST` | SMTP server hostname (alternative to Resend) | - |
| `SMTP_PORT` | SMTP port | `587` |
| `SMTP_USER` | SMTP username | - |
| `SMTP_PASS` | SMTP password | - |
| `CONTACT_EMAIL` | Recipient for contact form submissions | `volleyball@lucanepa.com` |

Email sending requires either `RESEND_API_KEY` (recommended -- uses HTTPS, works on all cloud platforms) or SMTP credentials.

## API Endpoints

### `GET /health`

Health check. Also responds on `/`.

```json
{
  "status": "healthy",
  "mode": "local|cloud",
  "uptime": 123.45,
  "connections": 2,
  "activeRooms": 1
}
```

### `GET /api/server/status`

Detailed server status.

```json
{
  "status": "online",
  "mode": "local|cloud",
  "wsPort": 8080,
  "connections": 2,
  "matches": 1,
  "rooms": 1,
  "uptime": 123.45
}
```

### `GET /api/server/connections?matchId=abc`

Connected dashboard clients (referee, bench). Optional `matchId` filter.

### `GET /api/match/list`

List active matches with referee connections enabled.

### `GET /api/match/:matchId`

Get full match data (match, teams, players, sets, events) by ID.

### `POST /api/match/validate-pin`

Validate a 6-digit PIN for referee/bench access.

```json
{ "pin": "123456", "type": "referee|homeTeam|awayTeam" }
```

### `POST /api/match/send-info`

Send match info email to a specified address. Requires email configuration.

### `POST /api/contact`

Contact/support form submission. Accepts JSON or multipart form data.

### `GET /api/official-matches?federation=SV&league=1LD`

Fetch upcoming matches from Swiss VolleyManager iCal feeds. Cached for 5 minutes.

### `GET /api/official-matches/leagues`

List all available leagues across federations (SV, SVRZ).

## WebSocket Protocol

### Client to Server

#### Join Match

```json
{
  "type": "join_match",
  "matchId": "abc123",
  "role": "scoreboard|referee|bench",
  "team": "home|away"
}
```

#### Sync Match Data (Scoreboard)

```json
{
  "type": "sync-match-data",
  "matchId": "abc123",
  "match": {},
  "homeTeam": {},
  "awayTeam": {},
  "homePlayers": [],
  "awayPlayers": [],
  "sets": [],
  "events": []
}
```

#### Match Action (Scoreboard)

```json
{
  "type": "match-action",
  "matchId": "abc123",
  "action": "timeout|substitution|...",
  "actionData": {}
}
```

#### Subscribe to Match (Referee/Bench/Livescore)

```json
{
  "type": "subscribe-match",
  "matchId": "abc123",
  "role": "referee|bench|subscriber"
}
```

#### Leave Match

```json
{ "type": "leave_match" }
```

#### Ping (Heartbeat)

```json
{ "type": "ping" }
```

#### Clear / Delete Matches

```json
{ "type": "clear-all-matches", "keepMatchId": "abc123" }
```

```json
{ "type": "delete-match", "matchId": "abc123" }
```

### Server to Client

#### Connection Confirmed

```json
{
  "type": "connected",
  "clientId": "xyz789",
  "mode": "local|cloud",
  "timestamp": "2025-01-01T12:00:00Z"
}
```

#### Joined Match

```json
{
  "type": "joined_match",
  "matchId": "abc123",
  "role": "referee",
  "roomSize": 2
}
```

#### Match Data Update

```json
{
  "type": "match-data-update",
  "matchId": "abc123",
  "match": {},
  "homeTeam": {},
  "awayTeam": {},
  "homePlayers": [],
  "awayPlayers": [],
  "sets": [],
  "events": [],
  "timestamp": "2025-01-01T12:00:00Z"
}
```

#### Match Action Broadcast

```json
{
  "type": "match-action",
  "matchId": "abc123",
  "action": "timeout",
  "data": {},
  "timestamp": "2025-01-01T12:00:00Z",
  "from": "client123"
}
```

#### Client Joined/Left

```json
{
  "type": "client_joined|client_left",
  "clientId": "xyz789",
  "role": "referee",
  "roomSize": 3
}
```

#### Error

```json
{
  "type": "error",
  "message": "Error description"
}
```

#### Pong (Heartbeat Response)

```json
{
  "type": "pong",
  "timestamp": 1234567890
}
```

### Live sockets (`?purpose=live`, realtime database changes)

Replacement for Supabase Realtime, implemented in `lib/realtimeHub.js` (server)
and `frontend/src/lib/relayRealtime.js` (supabase-js style client). A socket
opened with `?purpose=live` is a separate pool (500 per IP, 3000 in total by
default) and may only send these three message types; anything else closes it
with 1008, a binary frame with 1003.

Live sockets are upgraded by the hub's own `WebSocketServer({ noServer: true,
maxPayload: 16384, perMessageDeflate: false })` (`hub.handleUpgrade`), not by the
role-socket server (10 MB frames, deflate). `ws` therefore refuses a frame above
16 KB while parsing it (close 1009) and no compression is negotiated, so an
anonymous client cannot make the server buffer or inflate megabytes per socket.
server.js must route upgrades itself (role wss as `noServer: true`):

```js
server.on('upgrade', (req, socket, head) => {
  if (isLiveRequest(req)) return realtimeHub.handleUpgrade(req, socket, head, { ip: getClientIp(req) })
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})
```

```jsonc
// client -> server
{ "type": "subscribe-db", "id": "7:livescore-all-games",
  "subs": [{ "table": "match_live_state", "event": "*", "column": "sport_type", "value": "indoor" }] }
{ "type": "unsubscribe-db", "id": "7:livescore-all-games" }
{ "type": "ping" }

// server -> client
{ "type": "connected", "mode": "live", "protocol": 1 }
{ "type": "subscribe-db-ack", "id": "7:livescore-all-games" }
{ "type": "subscribe-db-error", "id": "...", "code": "invalid_sub", "message": "..." }
{ "type": "db-change", "id": "7:livescore-all-games", "schema": "public",
  "table": "match_live_state", "eventType": "UPDATE", "new": { ... }, "old": {},
  "commit_timestamp": "2026-10-05T12:00:00.000Z" }
{ "type": "pong", "timestamp": 1234567890 }
```

- Tables: `matches`, `sets`, `events`, `match_live_state`. Filter columns:
  `match_id`, `external_id`, `sport_type` (equality only). Both lists are hub
  options. At most 10 channels per socket and 10 subs per channel.
- A row is sent once per socket. When several channels of that socket match,
  `db-change` carries `ids: [...]` (all of them; `id` is the first).
- The `connected` hello with `mode: "live"` is the capability flag: the client
  treats any other first frame (LAN relays answer `mode: "local"`) as "no
  realtime here" and stops trying that URL.
- Changes are published by the server after successful `/api/db` writes and
  for accepted `live-state-update` relay messages. Rows pass through
  `lib/secrets.js` `redactSecrets` (the same function `/api/db` uses) before
  filters are evaluated, so PIN columns are never sent and cannot be used as
  filters.
- Write-through needs the written rows: `RETURNING *` (pgQuery) and, for
  upserts, `(xmax = 0) AS __inserted` so INSERT and UPDATE can be told apart.
  supabase-js writes without `.select()` return no rows and publish nothing;
  with `.select()` every upsert is published as UPDATE.
- `match_live_state` is ordered by `updated_at` per `match_id`: a row strictly
  older than the newest one published is dropped, so the HTTP copy and the
  relay copy of the same point cannot roll the score back.
- A `matches` DELETE also publishes a `match_live_state` DELETE with
  `old = { match_id, sport_type }`, because the database cascade is not
  returned by `RETURNING`.
- `live-state-update` messages: `matchId` is the relay room key (the
  scoreboard's local Dexie id), never a database key. The relay takes the
  scoreboard's last `sync-match-data` match for that room and resolves it the
  way Scoreboard.jsx does (UUID `externalId` -> `matches.id`, else `seed_key`
  -> `matches.external_id`; no seed key -> refused). Only the socket that
  currently owns the synced match may publish. This is NOT authentication:
  anyone can still become the scoreboard of an unowned match until owner/PIN
  binding lands.
- The server pings every socket every 30 s and terminates sockets that do not
  answer (Cloudflare drops idle WebSockets after 100 s). Sockets with more than
  256 KB unsent are terminated when the next change is published.

Tests: `npm test` runs `tests/realtimeHub.test.js` with real `ws` sockets on a
random port; it needs no database.

## Monitoring

### Local

Server logs to console with prefixed icons for easy scanning:

- `[API]` -- HTTP endpoint activity
- `[iCal]` -- Official match feed fetches
- `[Email]` / `[Contact]` -- Email operations
- `[CORS]` -- Origin validation

## Hosting

Deployed on Infomaniak at `https://backend.openvolley.app`.

## Troubleshooting

### Connection refused

- Check firewall settings and ensure port 8080 is open
- Verify the server is running (`curl http://localhost:8080/health`)

### WebSocket connection fails

- Use `ws://` for HTTP, `wss://` for HTTPS
- Production requires `wss://`
- Local dev uses `ws://`

### CORS errors

- Check browser DevTools for the blocked origin
- Local mode allows all origins
- Cloud mode allows `*.openvolley.app` and localhost

### Deployment fails

1. Check logs in your Infomaniak hosting dashboard
2. Verify `package.json` exists in backend folder
3. Ensure environment variables are set correctly
