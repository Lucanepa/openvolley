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

### Two runtime modes

| Mode | Start | What it serves |
| --- | --- | --- |
| **LAN / desktop relay** (no `DATABASE_URL`, or `--local`) | `node server.js --local` | WebSocket relay, static frontend, email, iCal. `/api/db`, `/api/auth/*`, `/api/storage/*`, `/api/match/restore*` and `/api/match/validate-connection-pin` answer 503. Unchanged from before the migration. |
| **Self-hosted cloud** (`DATABASE_URL` set) | `node server.js` | Everything above plus the data layer on its own Postgres (`lib/pgQuery.js`, `lib/matchRestore.js`, `lib/auth.js`) and filesystem storage (`lib/storage.js`), and realtime (`?purpose=live` sockets, `lib/realtimeHub.js`). No Supabase client or key anywhere. |

The data-layer modules (and `pg`) are loaded with a dynamic `import()` at
startup in cloud mode only; loading does not connect. A database that is down
makes `/health` answer 503 and data requests 503 until it is back; a
configuration error (bad `TRUST_PROXY`, `STORAGE_OWNER_SCOPE` or `STORAGE_*_MB`)
stops the process.

HTTP and WebSocket share **one port** (`PORT`): `server.on('upgrade')` routes
`?purpose=live` upgrades to the realtime hub and every other upgrade to the
role-socket relay. There is no separate WS port, so one tunnel/router entry
covers both.

### Verify a deployment

```bash
curl -fsS https://backend.openvolley.app/health/live   # process up (no DB)
curl -fsS https://backend.openvolley.app/health        # db, catalog, sentinel, floor, backup age
```

Cloud-mode `/health` (HTTP 200 only when `db`, `catalog`, `sentinel` and `floor` are ok, else 503; cached 2 s):

```json
{
  "status": "ok",
  "mode": "cloud",
  "uptime": 123.45,
  "db": "ok",
  "catalog": { "ok": true, "tables": 9, "loadedAt": "2026-10-05T12:00:00.000Z" },
  "sentinel": "ok",
  "storageWritable": true,
  "diskFreeMB": 14211,
  "floor": "ok",
  "lastBackupAt": "2026-10-05T11:05:00.000Z",
  "lastBackupAgeMin": 55,
  "connections": { "role": 4, "live": 61 },
  "activeRooms": 3,
  "realtime": { "sockets": 61, "ips": 2, "channels": 70, "...": "hub counters" }
}
```

`db` is `ok|down`, `sentinel` is `ok|missing`, `floor` is `ok|low|unknown`.
`lastBackupAt`/`lastBackupAgeMin` are `null` when `$STATUS_DIR/last_backup`
is missing or unreadable (reported only, never a 503). LAN `/health` keeps the
old shape (`status: healthy`, `mode: local`, always 200).

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
| `PORT` | HTTP **and** WebSocket port (upgrades on the same port) | `8080` |
| `DATABASE_URL` | Postgres connection string. Set: self-hosted cloud mode. Unset (or `--local` on the command line): LAN relay mode, no database. | - |
| `STORAGE_ROOT` | Object storage root (`{root}/{bucket}/{path}`), must contain the `.ovdata` sentinel or every write gets 503. `STORAGE_DIR` is accepted as the older name. | `/data/storage` |
| `STATUS_DIR` | Read-only directory with `last_backup` (a UTC timestamp, e.g. `date -u +%FT%TZ`) reported by `/health`. | `/var/lib/openvolley-status` |
| `PUBLIC_ORIGINS` | Extra trusted browser origins, comma separated (CORS with credentials, CSP connect-src), on top of `https://*.openvolley.app` and the built-in list. | - |
| `TRUST_PROXY` | `cloudflare`: the client IP is `cf-connecting-ip` (only valid when the origin is reachable through Cloudflare only). Unset: the socket peer address. Any other value stops the server. | - |
| `IS_CLOUD` | Strict cloud CORS/HSTS/CSP without a database (relay-only cloud). Implied by `DATABASE_URL`. | - |
| `PG_POOL_MAX` | Max Postgres connections of the one shared pool (pgQuery + auth). | `5` |
| `CONTACT_EMAIL` | Contact form recipient; also named in the "password reset unavailable" message | `volleyball@lucanepa.com` |
| `STORAGE_BACKUP_MIN_FREE_MB`, `STORAGE_SCORESHEETS_MIN_FREE_MB`, `STORAGE_MAX_FILE_MB`, `STORAGE_OWNER_SCOPE` | See "Self-hosted storage" below | |
| `RENDER` | Auto-set by Render (legacy) | - |
| `RESEND_API_KEY` | Resend API key for email (recommended) | - |
| `RESEND_FROM` | Sender address for Resend | `eScoresheet <escoresheet@openvolley.app>` |
| `SMTP_HOST` | SMTP server hostname (alternative to Resend) | - |
| `SMTP_PORT` | SMTP port | `587` |
| `SMTP_USER` | SMTP username | - |
| `SMTP_PASS` | SMTP password | - |
| `POCKETBASE_URL`, `POCKETBASE_ADMIN_EMAIL`, `POCKETBASE_ADMIN_PASSWORD` | Optional relay snapshot backup (unchanged) | - |

`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are no longer read.

Rate limits in cloud mode (per minute unless noted; sized for a venue NAT):
`/api/db` reads 600 per IP, writes 600 per user (and 1200 per IP before the
token lookup); `/api/storage/*` 600 per IP plus the per-user write quota of
`lib/storage.js`; `validate-connection-pin` 60 per IP and 20 per IP + PIN type;
`/api/match/restore` 30 per user; `/api/match/restore-by-pin` 60 per IP plus the
attempt limiter (20 failed per caller / 5 per caller and game in 10 min); auth
buckets live in `lib/auth.js`. Role sockets: 200 per IP in cloud mode (50 on
the LAN), 2000 in total; `?purpose=live` sockets: 500 per IP, 3000 in total.
Writes (`/api/db` insert/update/upsert/delete and `/api/match/restore`) need
the request header `X-OV-Proto: 2` (426 `OV_CLIENT_TOO_OLD` otherwise); CORS
allows that header.

Email sending requires either `RESEND_API_KEY` (recommended -- uses HTTPS, works on all cloud platforms) or SMTP credentials.

## Self-hosted storage (`lib/storage.js`)

Replaces Supabase Storage behind `POST /api/storage/upload`, `/download` and `/list` (buckets `scoresheets` and `backup`). Objects live at `{STORAGE_DIR}/{bucket}/{path}`. The request and response shapes are the ones `apiStorage` in `frontend/src/lib/apiClient.js` already uses; `signed-url` is gone (404, it had no caller).

| Variable | Description | Default |
| --- | --- | --- |
| `STORAGE_DIR` | Storage root. Must contain the sentinel file `.ovdata`, or every write is refused with 503 (protects against an unmounted volume). | `/data/storage` |
| `STORAGE_BACKUP_MIN_FREE_MB` | `backup/` writes are refused (507) when free space would drop below this, so the space above the scoresheets floor stays for scoresheets. | `2048` |
| `STORAGE_SCORESHEETS_MIN_FREE_MB` | Smaller floor for `scoresheets/` writes, so the volume never reaches ENOSPC. | `256` |
| `STORAGE_MAX_FILE_MB` | Per-object size cap (413 above it). server.js must read the body with `storage.maxBodyBytes` (base64 + 64 KiB) for this to hold. | `5` |
| `STORAGE_OWNER_SCOPE` | `off`, `require` (first path segment must be the caller's user id) or `prefix` (user id prepended transparently). For the Phase 7 security release; leave off until then. Any other value stops the server at startup. | `off` |

Guarantees: paths are NFC-normalised and validated (no `..`, no absolute paths, no backslashes, no C0/C1 control, bidi, zero-width or line-separator characters, no dot-names, no look-alikes that NFKC-normalise to `.` or `/`, no slash look-alikes such as U+2215; and, so the same data works on the Windows desktop app, no `:` `<` `>` `"` `|` `?` `*`, no trailing dot or space, no device names such as `CON` or `nul.json`); every directory on the way is checked with `lstat`, so symlinks are never followed; writes go to `{STORAGE_DIR}/.tmp` and are renamed into place (`upsert:false` uses `link()` so it is atomic too); only `application/json`, `text/plain` and `application/pdf` are accepted. A per-user write quota hook (`checkQuota`, with a ready-made `createWriteQuota()`) and `sweep()` for the 30-day `backup/backups/` retention are included. The quota is charged only for writes that would otherwise succeed; approved scoresheets (`{YYYY-MM-DD}/game{n}_final.json` in `scoresheets/`) skip the write count but still count against a byte budget. An `ownerScope` function returns `true` (allow as is), a path string (use that path), or anything else (403).

Wired in server.js (cloud mode): one `/api/storage/*` block, session required,
the body read with `storage.maxBodyBytes`, an oversized body answered with
`storage.bodyTooLarge()` (413; the request is drained, not destroyed, so the
answer arrives), then `storage.handle(action, body, { userId })`. `STORAGE_ROOT`
(or `STORAGE_DIR`) is the root. `sweep()` runs 5 min after start and then daily.

Preparing a root by hand (dev, staging):

```bash
mkdir -p ~/ov-storage && touch ~/ov-storage/.ovdata
STORAGE_DIR=~/ov-storage node server.js
```

Tests: `npm test` (or `node --test tests/storage.test.js`). They use a temp directory only, no Postgres and no Docker.

## API Endpoints

### `GET /health/live`

Liveness for the container healthcheck: `{"status":"ok","uptime":...}`, always 200, never touches the database.

### `GET /health`

Health check. In cloud mode see "Verify a deployment" above (503 when db, catalog, sentinel or floor is not ok). LAN mode:

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

## Auth module (`lib/auth.js`, self-hosted Postgres)

Replaces Supabase GoTrue behind `/api/auth/*` once the backend runs against its own Postgres (`DATABASE_URL`). Users stay in `auth.users` with their Supabase UUIDs and bcrypt hashes (`$2a$`/`$2b$`/`$2y$`), so old passwords keep working. Sessions are opaque 32-byte tokens; only `SHA-256(token)` is stored, in `auth.app_sessions`.

**Database.** Run `db/002_app_sessions.sql` as the owner role after `000_prelude.sql` and before `roles.sql`. It is idempotent. It stops with a clear error if restored `auth.users` rows have emails that differ only in case, or if an index named `users_email_lower` exists that is not unique on `lower(email)`; sign-up depends on that unique index to detect concurrent duplicates.

**Endpoints** (all `POST /api/auth/<action>`, JSON in, `{data, error:{message, code}}` out):

| Action | Behaviour |
|---|---|
| `sign-in` `{email, password}` | 200 `{user, session:{access_token, token_type, expires_in, expires_at, user}}`; 400 `invalid_credentials`; 429 `account_locked` / `rate_limited` |
| `sign-up` `{email, password, metadata}` | Creates `auth.users` + `profiles` in one transaction (the `handle_new_user` mapping; client `roles` are dropped). 200 `{user}`, no session; 422 on duplicates or bad input |
| `get-user` `{access_token}` | 200 `{user, session:{expires_at, expires_in}}`; **401 `invalid_token`** when unknown, expired or revoked |
| `sign-out` `{access_token}` | Deletes the session; always 200 |
| `delete-account` `{access_token}` | Deletes the user, profile, user_matches and sessions |
| `profile` `{access_token}` | Read-only; `updates` is ignored |
| `update-user` | 501 (email change returns in Phase 7) |
| `reset-password` | 503 "temporarily unavailable", until Phase 7 |

Sessions last 30 days, slide forward when fewer than 15 days remain, and never live past `created_at + 90 days`. A database failure is a **503** `auth_unavailable`, never a 401, so clients keep their session.

**Protected routes** call `await auth.requireUser(req, res)` (writes the 401/503 itself) or `await auth.verifyToken(req)` (returns the user or `null`, throws on database errors).

**Limits** (in-memory, per process): sign-in 60/min per IP, 10 per 15 min per email, 5/s for all sign-ins together, and a lock for 15 min after 10 failures per email (attempts still being checked count towards it, so parallel requests cannot overshoot); sign-up 5/hour per IP; session checks 300/min per IP. Per-IP buckets key IPv6 clients on their /64 (`ipBucketKey`), so pass the raw client IP. Override with `createAuth({ limits, lockout, ipKey })`.

**CPU guard.** bcryptjs runs on the main event loop, which also serves the live-scoring relay. At most `bcryptMaxConcurrent` (2) bcrypt operations run at once and `bcryptMaxQueue` (16) wait; beyond that, and when the global sign-in bucket is empty, the answer is **503 `auth_busy`** with `Retry-After`, never a queued request. Existing sessions are unaffected.

**Unconfirmed emails.** Users whose `email_confirmed_at` is NULL (possible in a Supabase import) cannot sign in, as under GoTrue. The owner can confirm one with `set-password.mjs <email> --confirm-email`; `createAuth({ requireConfirmedEmail: false })` turns the check off.

**Contact address** in the reset-password message: `contactEmail` option, else `CONTACT_EMAIL`, else the same fallback as server.js.

**Owner CLI.** Set a password and revoke all sessions (the password comes from a hidden prompt, or from stdin when piped, never from argv):

```bash
DATABASE_URL=postgres://ov_owner@.../openvolley node scripts/set-password.mjs someone@example.com
node scripts/set-password.mjs someone@example.com --generate     # prints a random password once
node scripts/set-password.mjs someone@example.com --revoke-only  # sign out everywhere
node scripts/set-password.mjs someone@example.com --confirm-email  # also mark the email confirmed
```

**Tests.** `npm test` runs the unit tests; the Postgres suite in `tests/auth.test.js` skips unless `PG_TEST_URL` is set. It creates and drops its own database, so the URL needs a role that may `CREATE DATABASE`:

```bash
docker run -d --rm --name ov-test-auth -e POSTGRES_PASSWORD=test -p 127.0.0.1:0:5432 postgres:17-alpine
PORT=$(docker port ov-test-auth 5432/tcp | head -1 | cut -d: -f2)
PG_TEST_URL=postgres://postgres:test@127.0.0.1:$PORT/postgres npm test
docker stop ov-test-auth
```

`tests/fixtures/synthetic_schema.sql` stands in for the real Supabase dump until it is available.

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

## Postgres data layer (`lib/pgQuery.js`, `lib/matchRestore.js`)

Replacement for the Supabase/PostgREST calls behind `/api/db`, used when
`DATABASE_URL` is set (wired into `server.js`). Both modules are plain
ESM with no side effects at import time. The catalog is read lazily from
`information_schema` on first use and retried with backoff while the database
is down.

- `createPgQuery(options)` returns `{ runQuery, execute, withTransaction, ensureCatalog, catalogStatus, ping, close, ... }`.
  `runQuery({table, action, params}, opts)` takes exactly what `apiClient.js` sends and
  returns `{ status, body: { data, error, count }, changes? }`. It never throws.
- `createMatchRestore(db)` returns `{ restoreMatch, restoreByPin }` for
  `POST /api/match/restore` and `POST /api/match/restore-by-pin`.

Error codes in `body.error.code`:

| Code | HTTP | Meaning |
|---|---|---|
| `OV_CLIENT_TOO_OLD` | 426 | write without `X-OV-Proto: 2` |
| `OV_SECRET_FILTER` | 400 | filter, order or onConflict on a secret column (also through an alias, cast or JSON path) |
| `OV_UNSCOPED_EXTERNAL_ID` | 400 | set/event `external_id` does not start with its match's `external_id` plus `:` or `_` |
| `OV_UNSCOPED_WRITE` | 400 | set/event update/delete without `eq` on `match_id` or on a non-numeric `external_id`; set/event upsert whose conflicting row belongs to another match (nothing is written) |
| `OV_UNFILTERED_WRITE` | 400 | update/delete without a filter |
| `OV_TABLE_NOT_ALLOWED`, `OV_INVALID_*` | 400 | request outside the contract |
| `PGRST204` | 400 | unknown column |
| `PGRST116` | 406 | `single`/`maybeSingle` row-count mismatch (writes are rolled back) |
| `OV_TOO_MANY_ATTEMPTS` | 429 | restore-by-pin: more than 20 failed attempts per caller in 10 min, or 5 per caller and game |
| `OV_DB_UNAVAILABLE` | 503 | database down or catalog not loaded yet (`retryable: true`) |
| `40001`, `40P01`, `55P03`, `57P0x`, `53300`, `08xxx` | 503 | serialization failure, deadlock, lock timeout, shutdown, connection trouble (`retryable: true`) |
| `57014` | 504 | statement timeout (`retryable: true`) |
| other SQLSTATEs (`22P02`, `23505`, `42P01`, ...) | 400 | Postgres error; the text stays in the server log |

5xx answers carry `error.retryable: true`; the sync queue keeps those jobs
queued. `23505` stays a 400: in a restore it means the payload collides with a
row of another match (or repeats an id), which a retry does not fix.

`POST /api/match/restore` drops keys that are not columns and lists them in
`data.dropped` (old backups and bundles send extra keys; backupManager's live
state `status` is renamed to `match_status`). Sets and events without
`sport_type` get the match's, else `indoor`. A null or empty `game_pin` /
`connection_pins` keeps the stored value, and `connection_pins` is merged into
the stored object. `changes` lists the old children as `DELETE` (keys only)
before the new rows.

### How `server.js` uses it

- `restoreByPin(body, { limitKey })` gets the client IP (`cf-connecting-ip`
  with `TRUST_PROXY=cloudflare`), IPv6 keyed by /64.
- `validate-connection-pin` scans setup/live indoor matches with
  `{ internal: true, maxRows: 20000 }`, newest `scheduled_at` first.
- Successful writes publish their `changes` to `?purpose=live` subscribers.
- Accepted until match ownership (plan Phase 7): any signed-in session can
  restore any match by `external_id`, and a non-empty `game_pin` in the backup
  replaces the stored PIN.

### Running the Postgres tests

The suites in `tests/pgQuery.test.js`, `tests/matchRestore.test.js` and
`tests/pgQuery.leastPrivilege.test.js` need a throwaway Postgres. Without
`PG_TEST_URL` they are skipped; the `Backend tests` workflow sets it with a
`postgres:17-alpine` service. Each test file creates its own database from
`tests/fixtures/synthetic_schema.sql` and drops it. The least-privilege suite
also creates (and drops) a role with only DML grants.

```bash
docker run -d --rm --name ov-test-pg -e POSTGRES_PASSWORD=test -p 127.0.0.1:0:5432 postgres:17-alpine
docker port ov-test-pg 5432          # e.g. 127.0.0.1:32768
PG_TEST_URL=postgres://postgres:test@127.0.0.1:32768/postgres npm test
docker stop ov-test-pg
```

The synthetic schema mirrors the 2026-10 inventory, not the real dump. Once
`schema_public.sql` exists, run the suites against a scrubbed copy of it too.

`tests/server.e2e.test.js` boots `server.js` itself with `DATABASE_URL`, a temp
`STORAGE_ROOT` and `STATUS_DIR` on a random port, and drives sign-up/sign-in,
`/api/db` writes with namespaced set/event ids, a `?purpose=live` subscriber,
secret redaction, PIN validation, both restore endpoints, storage and
`/health`. It uses `PG_TEST_URL` like the other suites, or starts (and always
stops) its own `postgres:17-alpine` container with `OV_E2E_DOCKER=1`:

```bash
OV_E2E_DOCKER=1 node --test tests/server.e2e.test.js
```

Its second suite boots `server.js --local` without a database and needs neither.
