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
`DATABASE_URL` is set (not wired into `server.js` yet). Both modules are plain
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

### Wiring notes for `server.js`

- `restoreByPin(body, { limitKey })`: pass the client IP (the Cloudflare /
  Traefik client address, not the socket peer). Without it every caller shares
  one bucket of 20 failed attempts per 10 min.
- Internal PIN validation that scans matches (`status` in setup/live) must pass
  `maxRows` (e.g. 20000) or order by `scheduled_at` desc, or better filter by the
  match id the client sends: the default cap is 1000 rows, as on Supabase.
- Accepted until match ownership (plan Phase 7): any signed-in session can
  restore any match by `external_id`, and a non-empty `game_pin` in the backup
  replaces the stored PIN. Record this next to the other §9 trade-offs.

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
