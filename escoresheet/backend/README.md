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
curl -fsS https://backend.openvolley.app/health        # verdict: status, db, backup (full body from the status network)
```

Use `/health/live` for the Docker healthcheck (Traefik drops an unhealthy
container from routing, and the WebSocket relay with it) and `/health` only for
the monitor (Uptime Kuma).

Cloud-mode `/health` (HTTP 200 only when `db`, `catalog`, `sentinel`, `floor`
and `backup` are ok, else 503; cached 2 s). The full body below goes only to
direct callers from loopback or a private network (Kuma on the status network,
`docker exec ... curl`). A request that came through cloudflared or Traefik
(it carries `cf-connecting-ip` / `X-Forwarded-For`) gets the verdict only:
`{"status","mode","db","backup"}`.

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
  "backup": "ok",
  "connections": { "role": 4, "live": 61 },
  "activeRooms": 3,
  "realtime": { "sockets": 61, "ips": 2, "channels": 70, "...": "hub counters" }
}
```

`db` is `ok|down`, `sentinel` is `ok|missing`, `floor` is `ok|low|unknown`.
`lastBackupAt`/`lastBackupAgeMin` are `null` when `$STATUS_DIR/last_backup`
is missing or unreadable. `backup` is `ok` (younger than `BACKUP_MAX_AGE_HOURS`,
36 h), `stale`, `unknown` (no readable `last_backup`) or `unchecked`
(`BACKUP_MAX_AGE_HOURS=0`); `stale` and `unknown` make `/health` 503. While the
backup is `stale` or `unknown` the daily storage sweep also **keeps every file
under `backup/backups/`** (it logs `backup/ sweep PAUSED`), so the 30-day
rotation never deletes the only copies while the nightly snapshot is failing.
LAN `/health` keeps the old shape (`status: healthy`, `mode: local`, always 200).

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
| `TRUST_PROXY` | `cloudflare`: the client IP is `cf-connecting-ip` (only valid when the origin is reachable through Cloudflare only). Unset: the socket peer address. Any other value stops the server. **Required behind cloudflared/Traefik**: without it every per-IP limit (socket caps, PIN and restore buckets, `/api/db`, auth) keys on the proxy's address, i.e. one bucket for all clients (the server warns at startup). | - |
| `TRUST_PROXY_FROM` | Comma list of CIDRs (e.g. the tunnel/Traefik network `172.30.0.0/24`). With it, `cf-connecting-ip` is honored only when the socket peer is inside one of them, so a caller that reaches the origin port directly cannot forge its address. Needs `TRUST_PROXY=cloudflare`; a bad entry stops the server. Without it the origin port must be reachable through the proxy only (no published host port, own Docker network). | - |
| `BACKUP_MAX_AGE_HOURS` | Max age of `$STATUS_DIR/last_backup` before `/health` says `backup: stale` (503) and the `backup/` sweep pauses. `0` disables both (dev only). | `36` |
| `IS_CLOUD` | Strict cloud CORS/HSTS/CSP without a database (relay-only cloud). Implied by `DATABASE_URL`. | - |
| `PG_POOL_MAX` | Max Postgres connections of the one shared pool (pgQuery + auth). | `5` |
| `CONTACT_EMAIL` | Contact form recipient; also named in the "password reset unavailable" message | `volleyball@lucanepa.com` |
| `OV_PIN_SECRET` | Secret (at least 32 characters) for the PINs at rest: `game_pin` and every `connection_pins` value are stored as an HMAC with it (`lib/pinHash.js`). Unset: stored in plaintext as before (the server warns at startup). **Never change or lose it** while matches stored with it are in use (see "Security model"). | - |
| `OV_MATCH_TOKEN_SECRET` | Secret (at least 32 characters; a shorter one stops the start) for the match access tokens the PIN checks answer with (`lib/matchAccess.js`). Unset: derived from `OV_PIN_SECRET`; both unset: a random one per process (tokens end with a restart; the apps re-check their stored PIN on reload). | derived / random |
| `STORAGE_BACKUP_MIN_FREE_MB`, `STORAGE_SCORESHEETS_MIN_FREE_MB`, `STORAGE_MAX_FILE_MB`, `STORAGE_OWNER_SCOPE`, `STORAGE_OWNER_SCOPE_BUCKETS` | See "Self-hosted storage" below | |
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
`/api/db` 1200 per IP before the body is read, then reads 600 per IP, writes
600 per user (and 1200 per IP before the token lookup); `/api/storage/*` 600 per
IP plus the per-user write quota of `lib/storage.js`; `validate-connection-pin`
60 per IP and 20 per IP + PIN type, plus at most **20 failed guesses per IP in
10 minutes** (a success is refunded; 429 with `Retry-After: 600`);
`/api/match/restore` 30 per user, at most 2 bodies parsed at once per process
(4 queued, then 503 `OV_BUSY`); the PIN and `/api/db` buckets key IPv6 by /64; `/api/match/restore-by-pin` 60 per IP plus the
attempt limiter (20 failed per caller / 5 per caller and game in 10 min); auth
buckets live in `lib/auth.js`; `/api/match/claim` shares the restore-by-pin
buckets; `/api/match/upload-roster` shares the validate-connection-pin per-IP
and failed-guess buckets; a wrong `X-OV-Match-Pin` on `GET /api/match/:id`
counts as a failed guess too, and a wrong `subscribe-match` PIN 5 per socket /
20 per IP and minute. Role sockets: 200 per IP in cloud mode (50 on
the LAN), 2000 in total; `?purpose=live` sockets: 500 per IP, 3000 in total.
Writes (`/api/db` insert/update/upsert/delete and `/api/match/restore`) need
the request header `X-OV-Proto: 2` (426 `OV_CLIENT_TOO_OLD` otherwise); CORS
allows that header.

CORS in cloud mode trusts `https://*.openvolley.app`, `PUBLIC_ORIGINS`, and the
native shells: Capacitor (`https://localhost`, `capacitor://localhost`) and
Tauri (`tauri://localhost`, `http(s)://tauri.localhost`).

## Security model (Phase 7 security release)

What protects what, in cloud mode (`DATABASE_URL`) and on the LAN. Tests:
`tests/security.e2e.test.js` (the matrix below against a real Postgres and a
LAN relay), `tests/pgQuery.ownership.test.js`, `tests/matchAccess.test.js`,
`tests/hashPins.test.js`, the frontend's `lanRelayProtocol.test.js` (every relay
runtime; the Tauri one with `OV_TAURI_RELAY_BIN`).

### Who may write a match (cloud)

Writes to `matches`, `sets`, `events` and `match_live_state` (through `/api/db`)
and `/api/match/restore` need one of:

| Caller | How it is recognised |
|---|---|
| **Creator** | `matches.created_by`, set by the server to the session's user on the row's first insert (`db/005_match_ownership.sql`). A client value is dropped; an upsert never changes it; an `update` of it is refused. |
| **Editor** | a `match_editors` row, added only by the server when a signed-in caller proves the match's **game PIN**: `POST /api/match/claim {externalId, pin}`, or `POST /api/match/restore-by-pin` with a session (a new scoring device restoring the match). The scorer app calls `claim` itself when a write comes back `OV_NOT_MATCH_OWNER` (another account signed in on the scoring device), using the game PIN it holds. |
| **Admin** | `profiles.roles` contains `admin` or `super_admin`, read from the database (cached 30 s), never from the request. Writes any match (legacy ones included); a match an admin creates records it as creator. `roles` cannot be written through `/api/db` (denylist) or sign-up (dropped). |

Everyone else gets **403 `OV_NOT_MATCH_OWNER`** and nothing is written (a batch
with one foreign row is refused whole); no session is 401 as before.
`user_matches` ("My Matches") grants nothing: any account can write a link for
any `external_id`, and the scorer writes it before the match row exists, so it
proves nothing about who scored a match.

**Reads follow ownership too.** A signed-in caller reads full `matches` and
`events` rows only of the matches it created or edits (admins: all); rows of
other matches come back like an anonymous read (public columns, no rosters,
dates of birth, signatures, officials, approvals, pending rosters, event
payloads; the rosters of one match with its match token, see below), and a
filter or order on a non-public column only matches the caller's own rows, so
hidden values cannot be probed (`pgQuery` `opts.readOwner`). A referee or coach
whose My Matches lists someone else's match therefore sees that match like the
public scoresheet archive. Referee rows (`referee_database`) keep their full
read for accounts.

**Rows that existed before `005` have no owner** (`created_by` NULL): nobody
can tell who scored them, so they are **read-only for everyone except admins**
until a scorer proves the game PIN. That happens without the app's help: a
match insert/upsert through `/api/db` that is refused only for ownership and
carries the stored match's own `game_pin` makes the account an editor and is
retried at once (a counted PIN guess, like `claim`), so scorer apps that are
already open (cached PWA) keep syncing the matches running on deploy day.
Writes that carry no game PIN (sets, events, live state, plain updates) wait
until that first match upsert, or until the app's own `claim` (the sync queue,
and since this release the direct set-end / match-end syncs too, try it once a
minute per match and requeue the match's parked jobs). A deleted account leaves
its matches ownerless the same way (`ON DELETE SET NULL`; see "Deleting an
account").

**Reference tables:** `svrz_games` (the official schedule, written by the
server's vm-sync job) is read-only for every account but admins (403
`OV_READ_ONLY_TABLE`). In `referee_database` an account may add referees and
change `sport_type` of one row by id (Match Setup's referee history); any other
update, an upsert or a delete is for admins. `beach_competition_matches` is not
on the `/api/db` allowlist (no client uses it).

The **officials' devices** keep working: referee and bench tablets only read
(relay, live sockets, anonymous `/api/db`); the coaches' roster upload no longer
writes `matches` with a session but goes through
`POST /api/match/upload-roster {matchExternalId, team, pin, roster, coachSignature?, captainSignature?}`,
authorised by that team's upload PIN of that match, which writes only
`connections.pending_{home|away}_roster` and the team's coach/captain signatures,
and only while the match is in `setup` (409 after the coin toss). A second
scorer takes over with the game PIN as above.

### Match data before and after the PIN step (cloud and LAN)

Before a PIN is proved, every relay (this server in both modes,
`frontend/server.js`, the Electron and Vite relays through
`electron/lanRelayCore.cjs`, the Tauri `relay.rs`) and `GET /api/match/:id`
hand out the **public summary** only (`access: "summary"`: match id, status,
game number, team names/colours, set scores, live state; no rosters, no events,
no match actions). The bundle (`access: "full"`, still without PINs and personal
data) needs one of the match's PINs: the referee PIN while the referee
connection is on, a bench PIN while that bench is on, or the game PIN.

- Relay: `subscribe-match { matchId, pin }` (or `join_match` with a pin), or
  `{ token }` on this server. The `role` / `device` / `team` fields only label
  the socket; a role grants nothing. A PIN offered before the scorer synced the
  match is checked once it arrives. Wrong PINs: `{code:'pin-invalid'}`; over 5
  per socket and minute, or over the brute-force budget every PIN check of this
  server shares (`validate-connection-pin`, `validate-pin`, `GET /api/match/:id`
  with a PIN, the relay's subscribe PINs and scoreboard game-PIN claims, the
  PocketBase snapshot, the inline take-over: **20 wrong PINs per 10 minutes per
  address**, IPv6 by /64; right PINs are refunded), nothing is compared
  (`rate-limited`). The LAN relays keep their own per-socket/per-IP limits.
  `match-action` goes only to sockets with access; `live-state-update` to every
  subscriber (it is what Livescore shows anyway), and the summary keeps
  `data.liveState` for the LedBox bridge.
- Scoreboard claims (cloud): a socket syncing a room it does not own yet is
  checked against the database first. When the room key (`external_id`), or
  the row the synced match points at (`externalId` uuid / `seed_key`), is
  stored with a game PIN, the synced game PIN must be that one
  (`not-match-owner` otherwise, a counted guess); a correct one also takes the
  room back from a squatter. The relay's `live-state-update` -> `db-change`
  publishes to a row only when the synced game PIN is that row's, so a socket
  owning some room cannot speak for another match's Livescore or alarm.
- HTTP: `X-OV-Match-Pin` or `X-OV-Match-Token` on `GET /api/match/:id`.
- Tokens: `validate-pin` and `validate-connection-pin` answer `token`, an HMAC
  capability for that one match (`lib/matchAccess.js`, 6 h; none for the
  upload PINs). It is bound to the role it was issued for and carries a
  fingerprint of that role's PIN: it stops granting as soon as the role's
  connection is switched off or (on the relay, which holds the PINs) its PIN is
  regenerated, not only when it expires. On anonymous `/api/db` reads
  `X-OV-Match-Token` unlocks the **rosters of that match only** while the
  role's connection is on (the referee/bench fallback when the relay has no
  copy); without it anonymous `matches` reads have no roster columns, and
  anonymous `events` reads never carry payloads, lineups or state snapshots.
  The secret is `OV_MATCH_TOKEN_SECRET`, else derived from `OV_PIN_SECRET`, so
  tokens survive a restart without an extra setting.
- The apps remember the PIN and token of a successful PIN check in memory
  (`serverDataSync.rememberMatchAccess`) and send them with every subscribe and
  fetch of that match (the relay keeps the PIN next to a token, so an expired
  token falls back to the PIN). When the API fallback reads the match without
  its rosters (token expired), the app renews the token with the remembered PIN
  once a minute at most. On the LAN nothing needs setting up.

The game list stays anonymous and keeps `external_id`: the roster-upload app
needs it before the PIN step (its PIN check is bound to that match), the live
sockets publish it anyway, and since the relay no longer hands out the bundle
for a known key it is an identifier, not a capability.

### PINs at rest

- **Database:** with `OV_PIN_SECRET` set, `game_pin` and every
  `connection_pins` value written through `/api/db` or `/api/match/restore` is
  stored as `h1:` + HMAC-SHA256(secret, `kind:pin`) (`lib/pinHash.js`). The PIN
  checks (validate-connection-pin, upload-roster, restore-by-pin, claim) accept
  the hashed and the older plaintext form. Rewrite old rows once with
  `node scripts/hash-pins.mjs --apply` (dry run without `--apply`; idempotent).
  A plain or salted hash would not do: 6 digits are a million values, cracked in
  minutes from a dump; the HMAC secret is not in the database or its backups.
  Losing or changing the secret makes every stored hash unverifiable (referees,
  benches, roster uploads and restores by PIN fail for those matches until the
  scorer writes the PINs again), so keep it in the secret store with the
  database credentials.
- **What stays plaintext, and why:** the relay's in-memory copy of the
  scorer's match (it must compare typed PINs, on the LAN with no database at
  all); the scorer's own IndexedDB (it shows the PINs to hand them out); the
  optional PocketBase relay snapshot (`match_data`, legacy); and the database
  values until `OV_PIN_SECRET` is set and `hash-pins.mjs` ran.
- **Never returned or logged:** PIN columns are redacted from every `/api/db`
  answer, `db-change` and relay message and can never be filtered on; the PIN
  checks answer the match, never a PIN; the server logs no PIN (asserted by the
  e2e suites).

### Backups (`backup/` bucket)

Each account sees only its own backup objects: `STORAGE_OWNER_SCOPE=prefix`
with `STORAGE_OWNER_SCOPE_BUCKETS=backup` (the defaults) stores them under
`backup/{user id}/…` transparently, so list, download and restore work for the
uploader and show nothing to anyone else. Restore by game number + game PIN
(`/api/match/restore-by-pin`) is the PIN-gated path for everyone else: the
restore screen's cloud search (game number + game PIN) runs it next to the
backup list and offers the cloud match itself ("From Database"), so a
replacement tablet signed in with another account still restores the match
(and, signed in, becomes its editor). Restore in place from the scoreboard's
options lists the current account's backups only. Files
stored before this change (`backup/backups/…`, no user folder) are no longer
reachable through the API; the 30-day sweep still removes them (and sweeps
every account's `{user id}/backups`).

### Deleting an account

`POST /api/auth/delete-account` (Profile > Delete account) removes the
account's personal data on the server and keeps the match records, which
belong to the clubs and the federation, not to the scorer's account.

| Deleted | Where |
|---|---|
| the account (email, password hash) | `auth.users` |
| every session (all devices signed out) | `auth.app_sessions` |
| the profile (name, date of birth, licence, roles) | `public.profiles` |
| My Matches links | `public.user_matches` |
| editor rights on other accounts' matches | `public.match_editors` |
| match backups and interaction logs | storage `backup/{user id}/` (whole folder; the same for any other owner-scoped bucket, except the uploader-only `scoresheets`, whose files stay even with `STORAGE_OWNER_SCOPE_BUCKETS=all`) |
| the right to read the scoresheets it uploaded | the account's entry in every `.owners/scoresheets/*.json` record (a record left without owners is deleted) |

| Kept | Why |
|---|---|
| the matches it created (`matches`, `sets`, `events`, `match_live_state`), with `created_by` set NULL | official match records (results, rosters, officials, signatures) that the clubs and the league rely on; a match is not the scorer's personal data. Without an owner they are read-only except for admins and editors, like the rows that predate `005` (see "Who may write a match"). |
| the officials list of those matches, including the scorer's own name and date of birth | it is part of the match record, exactly as on the paper scoresheet |
| the scoresheet files it uploaded (`scoresheets/…`) | the approved scoresheet is the match's official record. With no owner left nobody can read it through the API; an operator can grant it to the club or federation account (`scripts/storage-owner.mjs grant`). |
| beach competition matches it created or claimed, with `created_by`/`claimed_by` NULL | competition records, same reasoning |
| anything on the user's devices (IndexedDB matches, cached profile) | not the server's to delete; the app clears the stored session and cached profile |
| copies in the host backups, until they expire (see below) | they exist to restore the service after a loss; they are GPG-encrypted to a key that is not on the server and cannot be edited row by row |

**Host backups still hold a deleted account until they rotate out.** The
account's rows (email, password hash, profile with date of birth, licence,
sessions, user_matches, match_editors) are in every database dump taken before
the deletion, and its `backup/{user id}/` files are in the nightly storage
snapshots (`deploy/backup-openvolley.sh`). Retention:

| Copy | Kept |
|---|---|
| hourly database dumps on the server (`db-*.dump.gpg`) | 48 h (`OV_DB_KEEP_MIN`) |
| nightly `scoresheets-*`/`snapshots-*.tar.gpg` on the server | 7 days (`OV_FILES_KEEP_DAYS`) |
| NAS pull (`deploy/nas-pull.sh`): dumps / file archives | 30 days (`NP_KEEP_DB_DAYS`) / 90 days (`NP_KEEP_FILES_DAYS`) |
| NAS btrfs snapshots of that folder (Synology Snapshot Replication) | 7 daily, 4 weekly, 6 monthly |

So the last copy is gone about 7 months after the deletion (a monthly NAS
snapshot taken up to a month later, still holding a dump from before it, is
kept 6 months). A restore from one of these backups brings the account back:
after restoring, delete it again (or re-run the deletion for every account
deleted since the dump was taken). The delete dialog says this in one line
(`auth.deleteAccountWhatGoes`).

Order (`lib/auth.js` `deleteAccount`): the files go first
(`storage.deleteUserData`); when that fails the answer is 503 and **no row is
deleted**, so the user can retry with the same session. Then one transaction
revokes the sessions, deletes the rows above, detaches the matches and deletes
`auth.users`. The file clean-up runs once more after the commit (an upload that
was in flight). Tests: `tests/accountData.e2e.test.js`, `tests/auth.test.js`,
`tests/storage.test.js`.

### Sign-up

Auto-confirmed (no email flow yet). Limits: 5 per hour per IP (/64), 3 per
hour per mailbox (across IPs; `name+tag@` counts as `name@`), and 300 created
accounts per hour in total (requests for existing addresses or that fail are
not counted, so nobody can use the budget up without creating that many
accounts); client `roles` in the metadata are dropped and `profiles.roles` is
never writable by a client.

### Still open (accepted, with impact)

- **A relay room that is not in the database** (LAN, or a cloud match the
  scorer has not synced over HTTP yet) is claimed by its first scoreboard and
  proved by its game PIN from then on, as before.
- **Session tokens stay in localStorage** (httpOnly cookies are a later change).
- **Rolling out:** deploy the cloud backend and the desktop/LAN relays outside
  match hours, and run `db/005_match_ownership.sql` before the new backend
  starts. Referee and bench tablets opened before the update run the old app:
  it sends no PIN on subscribe and does not know `access`, so the relay's next
  update (the summary) empties their lineups and rosters until the page is
  reloaded and the PIN entered again. Make sure those apps take the service
  worker update (UpdateBanner) before the next match.

### Cutover: frontend and backend ship together

This frontend and this backend only work with each other, in both directions:

- The frontend sends `X-OV-Proto` on every `/api/db`, `/api/storage/*` and
  `/api/match/*` call, reads included. The old Supabase-proxy backend allows
  only `Content-Type, Authorization` in CORS, so every cross-origin preflight
  fails: reads, writes, storage and restore all break. Its realtime shim
  (`supabaseClient.js` -> `?purpose=live` sockets) needs this backend's hub.
- This backend answers 426 to every write from a cached old PWA (no
  `X-OV-Proto: 2`) until the service worker updates it.

So the frontend deploy (auto-deploy on merge to `main`, if enabled) and the
switch of the backend URL to the `DATABASE_URL` backend are **one step**: do not
merge to `main`, or pause the frontend auto-deploy, until the new backend
answers at the same backend URL. Optional, to decouple the two: first ship a
backend-only change to the current production backend that adds `X-OV-Proto`
to `Access-Control-Allow-Headers`.

Email sending requires either `RESEND_API_KEY` (recommended -- uses HTTPS, works on all cloud platforms) or SMTP credentials.

## Self-hosted storage (`lib/storage.js`)

Replaces Supabase Storage behind `POST /api/storage/upload`, `/download`, `/list` and `/remove` (buckets `scoresheets` and `backup`). Objects live at `{STORAGE_DIR}/{bucket}/{path}`. The request and response shapes are the ones `apiStorage` in `frontend/src/lib/apiClient.js` already uses; `signed-url` is gone (404, it had no caller).

| Variable | Description | Default |
| --- | --- | --- |
| `STORAGE_DIR` | Storage root. Must contain the sentinel file `.ovdata`, or every write is refused with 503 (protects against an unmounted volume). | `/data/storage` |
| `STORAGE_BACKUP_MIN_FREE_MB` | `backup/` writes are refused (507) when free space would drop below this, so the space above the scoresheets floor stays for scoresheets. | `2048` |
| `STORAGE_SCORESHEETS_MIN_FREE_MB` | Smaller floor for `scoresheets/` writes, so the volume never reaches ENOSPC. | `256` |
| `STORAGE_MAX_FILE_MB` | Per-object size cap (413 above it). server.js must read the body with `storage.maxBodyBytes` (base64 + 64 KiB) for this to hold. | `5` |
| `STORAGE_OWNER_SCOPE` | `off`, `require` (first path segment must be the caller's user id) or `prefix` (user id prepended transparently), on the buckets of `STORAGE_OWNER_SCOPE_BUCKETS`. Any other value stops the server at startup. | `prefix` |
| `STORAGE_OWNER_SCOPE_BUCKETS` | Buckets the owner scope applies to: a comma list or `all`. With the default every account sees only its own `backup/` objects (see "Security model"). | `backup` |
| `STORAGE_UPLOADER_READ_BUCKETS` | Buckets whose objects only the account that created them may read, replace or list (see "Who can read a scoresheet" below); `none` turns it off. Any bucket other than `scoresheets`/`backup` stops the server at startup. | `scoresheets` |

Guarantees: paths are NFC-normalised and validated (no `..`, no absolute paths, no backslashes, no C0/C1 control, bidi, zero-width or line-separator characters, no dot-names, no look-alikes that NFKC-normalise to `.` or `/`, no slash look-alikes such as U+2215; and, so the same data works on the Windows desktop app, no `:` `<` `>` `"` `|` `?` `*`, no trailing dot or space, no device names such as `CON` or `nul.json`); every directory on the way is checked with `lstat`, so symlinks are never followed; writes go to `{STORAGE_DIR}/.tmp` and are renamed into place (`upsert:false` uses `link()` so it is atomic too); only `application/json`, `text/plain` and `application/pdf` are accepted. A per-user write quota hook (`checkQuota`, with a ready-made `createWriteQuota()`) and `sweep()` for the 30-day `backup/backups/` retention are included. The quota is charged only for writes that would otherwise succeed; approved scoresheets (`{YYYY-MM-DD}/game{n}_final.json` in `scoresheets/`) skip the write count but still count against a byte budget. An `ownerScope` function returns `true` (allow as is), a path string (use that path), or anything else (403).

A download of a missing object answers **200** `{ data: null, error: { code: 'OV_STORAGE_NOT_FOUND' } }` rather than 404: the scorer reads its log file / backups before the first write, and a 404 made every browser log a console error. `apiStorage` returns it as `{ data: null, error }` exactly as before.

### Who can read a scoresheet

Scoresheets (`scoresheets/{YYYY-MM-DD}/game{n}_{key}[_final].{json,pdf}`) carry players' and officials' names, dates of birth and signature images. **Only the signed-in account that created a file can read, replace or list it.** Everyone else gets 401 (no session) or 403 `OV_STORAGE_FORBIDDEN`. The bucket is never public, and there are no share links.

- **Ownership comes from creating the file, not from uploading to its path.** The first upload of a path records its account as the owner in `{STORAGE_DIR}/.owners/{bucket}/{sha256(path)}.json` (`{"key":"<path>","owners":["<user uuid>"]}`, written atomically). An upload to an existing file by anyone else is refused with 403 and changes nothing: there is no way to add yourself to someone else's file. Owner check, record and commit of one path run under one lock in the server process, so a download never sees a file under an older record. (One server process per `STORAGE_DIR`.)
- **The path cannot be claimed in advance.** Game numbers and dates are public (`/api/db` reads), so a key-less name could be squatted by anyone who uploads first. The scorer app therefore names the files with `{key}` = `k` + 128 random bits that it keeps on the scoring device (localStorage, never on the match record, which is synced and backed up). `n` is the game number, or the external id of a match without one (no shared `unknown` name).
- **Finding your own file.** `list` in an uploader-only bucket shows the caller only its own files (folders are always shown), so the random part never leaks. The viewer (`/scoresheet/?date=…&game=…`, opened from **My Matches**) lists the date folder and opens the caller's newest approved file of that game. The session lives in the browser per origin, so the standalone archive site (scoresheet subdomain, `frontend/src/ScoresheetApp.jsx`) has its own email/password sign-in: its View links ask for it and then open the scoresheet for its uploader; nobody else can open it there either.
- **Deleting.** `POST /api/storage/remove {bucket, paths:[…]}` (1-100 paths) deletes the caller's own objects only: in `scoresheets/` an owner of the object, in `backup/` the caller's own folder; any other bucket is 403. The object's owner record (`.owners/{bucket}/{sha256}.json`) is deleted with it, under the same lock. Answer `{data:[{name}]}` with the paths removed (missing ones are skipped). So the uploader of a scoresheet may withdraw it, just as it may already replace it with a new upload: "kept as the official record" (see "Deleting an account") means the server never deletes it on the uploader's behalf, not that the uploader cannot. No app screen calls `remove` today.
- **Clean-up.** `sweep()` (5 min after start, then daily, with the backup sweep) removes owner records whose file is gone (after a few minutes' grace, under the same lock), in every bucket's `.owners` folder, so a stale record can never hand rights to a file written later at the same path. That is also what clears records left by objects deleted outside the API (a test clean-up with `rm`): the server log line `[Storage] sweep {…"ownerRecordsRemoved":N}` counts them. Uploads only ever record one owner; the list is capped at 16 for operator grants.

Why not a share link: a link is a bearer secret that keeps working for whoever it is forwarded to and ends up in browser history, chat logs and referrers. Why not "the match's owner": rows written before `db/005_match_ownership.sql` have no server-verified owner, and any account can write a `user_matches` row for any match, so they cannot prove who scored a match.

**Files stored before this change** (`game{n}_final.json`, `game{n}.json`, `game{n}.pdf`) have no owner record and are readable by nobody through the API (nor replaceable). There is no trustworthy source to seed them from (see above), so an operator grants them one by one, after confirming out of band who scored the match:

```bash
# on hetzner: docker exec -it ov-backend <command>
node scripts/storage-owner.mjs unowned 2026-05-12          # files without an owner (optionally one folder)
psql "$DATABASE_URL" -c "SELECT id FROM auth.users WHERE email = lower('scorer@example.ch')"
node scripts/storage-owner.mjs grant 2026-05-12/game4711_final.json <user uuid>
node scripts/storage-owner.mjs show  2026-05-12/game4711_final.json
node scripts/storage-owner.mjs set   2026-05-12/game4711_final.json            # nobody again
```

The script uses `STORAGE_ROOT` / `STORAGE_DIR` like the server and can run while it does. The viewer finds a granted legacy file too (its name parses without the key).

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

Connected dashboard clients (referee, bench, livescore), for the scorer's
tablet status and the LAN server dashboard.

- **LAN relay:** the full list as before: `clients[]` with `id`, `ip`, `role`,
  `team`, `matchId`, `connectedAt`, and `matchSubscriptions` (watchers per
  room). Optional `matchId` filter.
- **Cloud** (`DATABASE_URL` or `IS_CLOUD`), anonymous: counts only.
  Without `matchId`: `{access:"counts", totalClients, dashboardClients,
  referees, benches, clients: []}`, no list of rooms. With `matchId`: the same
  counts for that match and one entry per watching tablet carrying only
  `{role, team, matchId}` (what the scorer's tablet status reads; no id, IP or
  connect time).
- **Cloud with proof:** `X-OV-Match-Pin` (a PIN of that match, as for
  `GET /api/match/:id`; a wrong one counts as a failed guess) or
  `X-OV-Match-Token` with `matchId`: `access:"detail"`, the entries of that
  match with `id` and `connectedAt` (`ip` stays null).

### `GET /api/match/list`

Every scheduled or live match a scorer currently publishes on this relay,
newest `scheduledAt` first, whatever its referee connection: display devices
(the point-hub LedBox bridge) pick their match here and need no PIN. Rows are
public: `{ id, gameNumber, homeTeam, awayTeam, scheduledAt, dateTime, status,
test, refereeConnectionEnabled, homeTeamConnectionEnabled,
awayTeamConnectionEnabled }`, never PINs or people (`dateTime` is a display
string, or `null` on the Tauri relay: clients format `scheduledAt`). Not
listed: a match whose scoreboard left more than 10 minutes ago, and on the
cloud a test (rehearsal) match, which belongs to the venue's relay (the cloud
also drops its `live-state-update`). Same rule on every LAN relay
(lanRelayCore, Tauri). The cloud lists a match whose referee connection is off
only to a caller on the same public address as its scoreboard (the venue's
own displays behind its NAT; needs `TRUST_PROXY=cloudflare` behind the proxy),
so the room keys of official matches are not handed out worldwide. The
referee and bench apps offer only the matches they can join
(`refereeConnectionEnabled`, `home`/`awayTeamConnectionEnabled`).
openbeach's `team1Team` / `team2Team` are taken as the home / away team.
`?finished=1` lists finished matches too (status `ended`, `final`,
`completed`, `finished`; same row): the livescore served by a venue relay
(frontend `src/utils/relayLivescore.js`) keeps a match that just ended. It
then subscribes to each match without a PIN and gets the public summary and
every `live-state-update`.

### `GET /api/match/:matchId`

The relay's copy of the match. Without a PIN: the public summary
(`access: "summary"`, no rosters or events). With `X-OV-Match-Pin` (a referee,
enabled bench or game PIN of the match) or `X-OV-Match-Token` (from a PIN
check): the bundle (`access: "full"`: match, teams, players, sets, events; never
PINs or personal data).

### `POST /api/match/validate-pin`

Validate a 6-digit PIN for referee/bench access against the relay's copy. The
answer carries the match (no PINs) and `token`, the match access token.

```json
{ "pin": "123456", "type": "referee|homeTeam|awayTeam", "sport": "indoor|beach" }
```

`sport` (default `indoor`) limits the search to rooms of that sport: a room is
`beach` when its scoreboard syncs `team1Team`/`team2Team`/`team1Players`/
`team2Players` (openbeach) or names `sportType`/`sport_type` `beach`. A beach
answer carries `match.sportType: "beach"`; the indoor answer is unchanged. Any
other `sport` is 400.

### `POST /api/match/claim` (cloud, session)

`{ "externalId": "match_…", "pin": "<game PIN>" }` -> 200 `{ data: { id, external_id, role: "creator"|"editor" } }`;
404 `OV_NOT_FOUND`; 429 `OV_TOO_MANY_ATTEMPTS`. The caller may write the match afterwards.

### `POST /api/match/upload-roster` (cloud, upload PIN)

`{ matchExternalId, team: "home"|"away", pin, roster, coachSignature?, captainSignature? }` ->
200 `{ success: true }`; 403 wrong PIN or match; 409 match no longer in setup.

The upload PINs reach the server with the match: Match Setup's Create match
sends the full `connection_pins` (referee, benches, both upload PINs) with the
match insert, and a regenerated upload PIN through the sync queue, stored as
HMACs ("PINs at rest"). The roster lands in `connections.pending_{team}_roster`
of the match row; the scorer reads it with "Search for roster" (its own match
row, by `external_id`), and Accept / Reject clears it on the server. The
Upload Roster app calls the relay's `PATCH /api/match/:id` only on a LAN
relay: this backend has no PATCH route.

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

**Database.** `scripts/migrate/restore.sh` runs the whole bootstrap (see "Database bootstrap" below). By hand: run `db/002_app_sessions.sql` as the owner role after `000_prelude.sql` and before `roles.sql`. It is idempotent. It stops with a clear error if restored `auth.users` rows have emails that differ only in case, or if an index named `users_email_lower` exists that is not unique on `lower(email)`; sign-up depends on that unique index to detect concurrent duplicates.

**Endpoints** (all `POST /api/auth/<action>`, JSON in, `{data, error:{message, code}}` out):

| Action | Behaviour |
|---|---|
| `sign-in` `{email, password}` | 200 `{user, session:{access_token, token_type, expires_in, expires_at, user}}`; 400 `invalid_credentials`; 429 `account_locked` / `rate_limited` |
| `sign-up` `{email, password, metadata}` | Creates `auth.users` + `profiles` in one transaction (the `handle_new_user` mapping; client `roles` are dropped). 200 `{user}`, no session; 422 on duplicates or bad input |
| `get-user` `{access_token}` | 200 `{user, session:{expires_at, expires_in}}`; **401 `invalid_token`** when unknown, expired or revoked |
| `sign-out` `{access_token}` | Deletes the session; always 200 |
| `delete-account` `{access_token}` | Deletes the account's personal data (user, sessions, profile, user_matches, match_editors, backups, scoresheet owner entries) and keeps its matches with `created_by` NULL; see "Deleting an account". 503 and nothing deleted when the files cannot be removed |
| `profile` `{access_token}` | Read-only; `updates` is ignored |
| `update-user` | 501 (email change returns in Phase 7) |
| `reset-password` | 503 "temporarily unavailable", until Phase 7 |

Sessions last 30 days, slide forward when fewer than 15 days remain, and never live past `created_at + 90 days`. A database failure is a **503** `auth_unavailable`, never a 401, so clients keep their session.

**Protected routes** call `await auth.requireUser(req, res)` (writes the 401/503 itself) or `await auth.verifyToken(req)` (returns the user or `null`, throws on database errors).

**Limits** (in-memory, per process): sign-in 60/min per IP, 10 per 15 min per email, 5/s for all sign-ins together, and a lock for 15 min after 10 failures per email (attempts still being checked count towards it, so parallel requests cannot overshoot); sign-up 5/hour per IP, 3/hour per mailbox (plus-tags removed), 300 created accounts/hour in total; session checks 300/min per IP. Per-IP buckets key IPv6 clients on their /64 (`ipBucketKey`), so pass the raw client IP. Override with `createAuth({ limits, lockout, ipKey })`.

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

`tests/fixtures/synthetic_schema.sql` stands in for the real Supabase dump. With `PG_TEST_TEMPLATE=<database>` (same server as `PG_TEST_URL`, nothing connected to it) every suite copies that database instead, and `tests/vmSync.pg.test.js` then runs the sync as a member of the restored `ov_app`. **Only in a rehearsal or throwaway container, never on the production cluster**: the suites create cluster-wide login roles with fixed passwords, add `pgcrypto`, copy the template's users and hashes into scratch databases, and need the template idle. The helper refuses a template whose comment does not end in `(rehearsal, scrubbed)`, which `restore.sh --scrub-except` sets (`PG_TEST_TEMPLATE_UNSCRUBBED=1` overrides it for a template built from synthetic data). Against the production schema 13 tests fail on purpose-built fixture shortcuts, not on the schema: they insert sets/events/live states without the columns production declares `NOT NULL` (`sets.index`, `events.set_index/type/payload`, `match_live_state.match_id`), expect the synthetic `matches.sport_type` default `'indoor'` (production has none), or add `auth.users.deleted_at/banned_until`, which the real table already has.

## Database bootstrap (self-hosted Postgres)

Files in `db/`, all run as `ov_owner` (the cluster superuser, `docker exec` only):

| File | When | What |
|---|---|---|
| `000_prelude.sql` | fresh database, before `pg_restore` | UTC, database owner, `auth` schema, `auth.users` (Supabase columns incl. `banned_until`/`deleted_at`), `users_email_lower`, staging table `auth.users_import`. No extensions and no Supabase roles are needed (checked against the production schema). |
| `001_post_restore.sql` | once, after `pg_restore` | drops RLS/policy remnants, moves `auth.users_import` into `auth.users` (lower-cased emails, stops on case duplicates), re-creates the 4 FKs to `auth.users` after an orphan check (`created_by`/`claimed_by` of `beach_competition_matches` now `ON DELETE SET NULL`, so delete-account works) |
| `002_app_sessions.sql` | after 001 | `auth.app_sessions` |
| `003_svrz_games_local_time.sql` | after 002 | one-off: `svrz_games.date/time` in Zurich time, closes stuck `svrz_sync_log` rows (vm-sync port) |
| `004_live_state_best_of.sql` | after 003 | `match_live_state.best_of` (written by the scoreboard, missing on Supabase) |
| `005_match_ownership.sql` | after 004 | `matches.created_by` (FK `auth.users`, `ON DELETE SET NULL`) and `match_editors` (see "Security model"). Existing rows stay without an owner. Without it every guarded write answers 503 `OV_OWNERSHIP_UNAVAILABLE` (retryable), never an unguarded write. |
| `006_matches_updated_at.sql` | after 005 | `BEFORE UPDATE` trigger: `matches.updated_at` (and `sets.updated_at` when the column exists) = `now()` on every update. Idempotent; the trigger function is `SECURITY INVOKER`, so `ov_app` needs no EXECUTE grant. Not on `match_live_state` (the realtime hub orders it by the scorer's `updated_at`). Without it, updates through `/api/db` still get a fresh `updated_at` (`lib/pgQuery.js` drops the client's value; the column keeps its old value only for writes that bypass the API). |
| `007_live_state_tto.sql` | after 006 | `match_live_state.tto_active` / `tto_started_at` (openbeach's technical timeout, missing on Supabase; without them every beach live-state write fails). Idempotent. |
| `roles.sql` | after **every** restore or migration | `ov_app` (backend login): DML on every public table (incl. `svrz_games`/`svrz_sync_log`, written by the in-backend vm-sync), sequences USAGE/SELECT, `auth.users` SELECT/INSERT/DELETE + UPDATE of 4 columns, `auth.app_sessions` DML, no DDL/TEMP/function EXECUTE, `statement_timeout=10s`; default privileges for future tables; ownership back to `ov_owner`. Password from psql variable `ov_app_pw` (unchanged when not set). |

**A database already running** gets a new `db/NNN_*.sql` file by hand, in number order, as `ov_owner`, then `roles.sql` (RUNBOOK-hetzner.md, "Apply a new db migration"). `restore.sh` only picks the files up on a restore. For `006`:

```bash
lenovo$ ssh hetzner 'cd /opt/openvolley && docker compose exec -T ov-postgres psql -U ov_owner -d openvolley -v ON_ERROR_STOP=1' \
          < escoresheet/backend/db/006_matches_updated_at.sql
lenovo$ ssh hetzner /opt/openvolley/apply-roles.sh < escoresheet/backend/db/roles.sql
```

`scripts/migrate/restore.sh [--force] [--expect-counts FILE] [--env-file FILE] [--db-user U] [--scrub-except EMAIL] <container> <export-dir>` loads the Phase-0 export (`public.dump`, `auth_users.csv`) through all of the above (every `db/NNN_*.sql` from 003 on, in order; two files with the same number stop it) with a filtered `pg_restore` list, then verifies (row counts, per table against `--expect-counts` when given, users vs CSV, FKs incl. `match_live_state_match_id_fkey_cascade`, no RLS, sequences, ownership, `ov_app` grants and TCP login). A restore list that leaves out a table's data is refused (`--allow-missing-data` overrides). It replaces the target database only when that is empty or left over from an unfinished run the app never used; otherwise it refuses unless `--force`, which renames the old database to `<db>_pre_restore_<UTC>` instead of dropping it. `--print-toc` shows the restore list. `--help` has the details.

```bash
# local rehearsal (a postgres:17 container with the default superuser)
OV_REHEARSAL_PW=... scripts/migrate/restore.sh --db-user postgres --scrub-except owner@example.com ov-rehearsal /dev/shm/ov-export/2026-10-05
# server (RUNBOOK-hetzner.md step 8), with the SQL files and restore.sh copied into the import directory
bash /data/openvolley/pg/import/restore.sh --env-file /opt/openvolley/.env \
  "$(docker compose -f /opt/openvolley/compose.yaml ps -q ov-postgres)" /data/openvolley/pg/import
```

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
  "device": "referee|bench|livescore",
  "pin": "123456",
  "token": "v1.…"
}
```

`pin` / `token` are optional: without one that grants the match the socket gets
the public summary and no match actions (see "Security model").

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
| `OV_NOT_MATCH_OWNER` | 403 | write to a match (or its sets/events/live state) the caller neither created nor edits; nothing written |
| `OV_OWNERSHIP_UNAVAILABLE` | 503 | `db/005_match_ownership.sql` has not run (`retryable: true`) |
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
  `{ internal: true, maxRows: 20000 }`, newest `scheduled_at` first. With
  `sport: 'beach'` (openbeach) it scans the beach matches instead: types
  `referee`, `bench_team1` / `bench_team2` (flags `team1_bench_enabled` /
  `team2_bench_enabled`, PIN keys `bench_team1` / `bench_team2`, the old
  `team1_data` / `team2_data` keys accepted), `upload_team1` / `upload_team2`;
  the answer names the teams `team1Team` / `team2Team` and carries
  `sportType: 'beach'`. A PIN never finds a match of the other sport
  (`lib/matchAccess.js` `CONNECTION_PIN_TYPES`).
- Successful writes publish their `changes` to `?purpose=live` subscribers.
- `/api/db` writes on matches/sets/events/match_live_state and
  `/api/match/restore` pass `matchOwner: { userId }` (omitted for admins):
  only the creator or an editor may write (see "Security model"). A restore
  never changes `created_by`, and the PINs it writes are stored hashed when
  `OV_PIN_SECRET` is set.

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
