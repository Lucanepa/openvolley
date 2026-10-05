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

## Self-hosted storage (`lib/storage.js`)

Replaces Supabase Storage behind `POST /api/storage/upload`, `/download` and `/list` (buckets `scoresheets` and `backup`). Objects live at `{STORAGE_DIR}/{bucket}/{path}`. The request and response shapes are the ones `apiStorage` in `frontend/src/lib/apiClient.js` already uses; `signed-url` is gone (404, it had no caller).

| Variable | Description | Default |
| --- | --- | --- |
| `STORAGE_DIR` | Storage root. Must contain the sentinel file `.ovdata`, or every write is refused with 503 (protects against an unmounted volume). | `/data/storage` |
| `STORAGE_BACKUP_MIN_FREE_MB` | `backup/` writes are refused (507) when free space would drop below this. `scoresheets/` writes still pass. | `2048` |
| `STORAGE_MAX_FILE_MB` | Per-object size cap (413 above it). | `5` |
| `STORAGE_OWNER_SCOPE` | `off`, `require` (first path segment must be the caller's user id) or `prefix` (user id prepended transparently). For the Phase 7 security release; leave off until then. | `off` |

Guarantees: paths are NFC-normalised and validated (no `..`, no absolute paths, no backslashes, no control/bidi/zero-width characters, no dot-names, no look-alikes that NFKC-normalise to `.` or `/`); every directory on the way is checked with `lstat`, so symlinks are never followed; writes go to `{STORAGE_DIR}/.tmp` and are renamed into place (`upsert:false` uses `link()` so it is atomic too); only `application/json`, `text/plain` and `application/pdf` are accepted. A per-user write quota hook (`checkQuota`, with a ready-made `createWriteQuota()`) and `sweep()` for the 30-day `backup/backups/` retention are included.

Preparing a root by hand (dev, staging):

```bash
mkdir -p ~/ov-storage && touch ~/ov-storage/.ovdata
STORAGE_DIR=~/ov-storage node server.js
```

Tests: `npm test` (or `node --test tests/storage.test.js`). They use a temp directory only, no Postgres and no Docker.

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
