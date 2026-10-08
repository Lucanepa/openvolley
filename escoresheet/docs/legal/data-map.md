# OpenVolley / OpenBeach: data map (internal)

Internal working document behind the privacy policy and the legal notice
(Impressum). Not published, not legal advice. **Before the texts go live, have
them and this map reviewed by a Swiss lawyer and checked against the FDPIC
(EDÖB) guidance for private operators.** Written from the code, not from
memory. Where the code and an earlier list of "known facts" disagree, the code
wins, and the difference is noted.

Code read (2026-10-07):

| Repo | Worktree | Commit |
|---|---|---|
| openvolley (backend, frontend, desktop, Android, deploy) | `wt-legal` | `0399609b` |
| openbeach (read-only) | `wt-ob-release` | `009d458` |
| openvolley_home (openvolley.app) | `wt-home-legal` | `71306b2` |
| point-hub / LedBox bridge (read-only) | `~/repos/point-hub` | `0e70a23` |

Paths below are relative to `escoresheet/` in the openvolley repo unless they
say otherwise.

---

## 1. Controller and legal frame

- **Controller (operator):** Luca Canepa, private person, Switzerland,
  `[ADRESSE / ADDRESS]` (to be filled in once, in one place per language).
  Contact: support@openvolley.app.
- **Law:** Swiss revFADP (nDSG, in force since 2023-09-01) applies. The GDPR
  may also apply (Art. 3(2)): the apps are open to anyone, beach tournaments
  carry foreign players, and the server is in Germany. The texts should meet
  both. For the GDPR, Art. 27 may require an EU representative. The usual
  exemption for occasional processing that is not large-scale probably does
  not cover dates of birth of minors. **Lawyer to confirm.**
- **Open question for the lawyer: who is the controller of the match records?**
  Clubs and Swiss Volley run the matches. The scorer (a club volunteer) types
  the rosters in. OpenVolley hosts the records. Two readings:
  (a) the operator is the controller of everything on the platform, or
  (b) for official scoresheets the clubs or the association are controllers
  and the operator is their processor. Then a short data processing agreement
  or terms of use would be needed.
  The texts below assume (a) with plain-language notes for players. Settle
  this before go-live.
- **Binding language:** German; EN/FR/IT are translations.

## 2. Systems and where data lives

| System | What runs there | Location | Who operates it |
|---|---|---|---|
| Backend VM | Node backend (`backend/server.js`), Postgres 17, file storage (`STORAGE_ROOT`), Caddy for `get.openvolley.app` | Hetzner Cloud, Germany (`fsn1`/`nbg1`: `deploy/RUNBOOK-move-to-own-vm.md`; confirm the actual location in the Hetzner console) | Hetzner Online GmbH (DE), processor |
| Cloudflare | DNS; Pages for the static sites (`openvolley.app`, `app.`, `referee.`, `bench.`, `livescore.`, `roster.`, `scoresheet.`, `manager.`, `manager-beach.`, `beach.`, `referee-beach.`, `livescore-beach.`, `scoresheet-beach.`, `readvolley.`); a Cloudflare Tunnel in front of `backend.openvolley.app` and `get.openvolley.app` | Global edge; Cloudflare Inc. (US) | Processor. **TLS ends at Cloudflare** (`deploy/cloudflared/config.yml`: "TLS ends at Cloudflare"), so every API request and answer, rosters and dates of birth included, passes Cloudflare unencrypted at the edge |
| Mail | SMTP via Migadu for `noreply@` (account mails) and `support@` (inbox) | Migadu (CH company; confirm where the mail servers are) | Processor |
| Resend (only if configured) | `POST /api/match/send-info` sends through `api.resend.com` when `RESEND_API_KEY` is set (`backend/server.js:675`) | Resend Inc. (US) | Processor **if the key is set**. Check `/opt/openvolley/.env` on the VM |
| Backups | Encrypted (GPG public key only on the VM) dumps on the VM, pulled nightly to the NAS; restore-tested weekly on lenovoserver (holds the private key) | VM (DE), NAS at home (CH), lenovoserver (owner's machine, CH; confirm) | Operator's own machines, no processor. Transport over Tailscale (WireGuard, end-to-end; Tailscale sees no content) |
| VolleyManager | Daily sync of the official game schedule and referee assignments into `svrz_games` (`backend/lib/vmSync.js`) and the public iCal feeds (`/api/official-matches`) | volleymanager.volleyball.ch (Swiss Volley) | Source (Swiss Volley is its own controller). The sync **logs in with credentials** (`VM_USERNAME`/`VM_PASSWORD`) and reads the referee-game search. This is login-protected data, **not just public data** (see F6) |
| GitHub | Source code, desktop release files, desktop updater fallback (`src-tauri/tauri.conf.json` endpoints), release list fetched by the browser on `app.openvolley.app` (`frontend/src/components/pages/HomePage.jsx:13`) | GitHub Inc. (US) | Own controller for its downloads. Visitors' IPs reach GitHub |
| F-Droid | Self-hosted repo at `get.openvolley.app/fdroid/repo`; f-droid.org catalogue once accepted | VM (DE) / F-Droid (own controller) | |
| User devices | Browser IndexedDB/localStorage, desktop app (Tauri), Android app (Capacitor), LAN relay at venues | The user's own device | The user. Stored on the server only when signed in and synced; but see F23: the browser and Android apps publish a created match to the cloud relay's memory **without** a sign-in |
| LedBox bridge (point-hub) | Mirrors the live score of a match onto a hall LED board | Venue hardware (e.g. the Pi box) | Reads only the PIN-free summary: team names, scores, set results (`lib/publicColumns.js` `relaySummaryBundle`). No player data. Stores nothing beyond the running state |

What there is **not** (verified): no analytics, no tracking, no ads, no
cookies (no `Set-Cookie`, no `document.cookie` in backend or frontend), no
third-party fonts or CDNs (fonts are self-hosted in `frontend/public/fonts`; a
test forbids CDN workers), no Sentry or similar error reporting. Two pieces of
dead code would call third parties if ever wired up (F18). Cloudflare can
inject Web Analytics at the edge, and the code cannot show that: **check in
the Cloudflare dashboard that Web Analytics / RUM is off for every Pages
project and the zone.**

The openvolley.app landing page (`openvolley_home/index.html`) and the
`get.openvolley.app` page (`deploy/pkgs/index.html`) are static. They have no
forms, no external scripts and no tracking, only outbound links. Caddy for
`get.openvolley.app` has **no access log** (`deploy/pkgs/Caddyfile` has no
`log` directive).

## 3. Who the data is about

| Data subject | How they meet OpenVolley |
|---|---|
| Account holders: scorers, referees, competition managers, admins | Sign up on `manager.` / `manager-beach.`; use the scorer apps signed in |
| Players | Named on rosters by the scorer, a team manager (`roster.` upload) or a competition manager (saved teams). They never use the app themselves. **Often minors** (youth leagues, U23 and below) |
| Team staff | Coach, assistant coaches, physio, medic: on rosters and saved teams |
| Match officials | 1st/2nd referee, scorer, line judges: on the scoresheet, in the referee directory, in the VolleyManager sync, in approvals |
| Viewers | Anyone opening livescore, the public scoresheet archive, a public beach tournament page, the LED board |
| Tablet users at a venue | Referee/bench tablets on the LAN relay or the cloud relay (PIN) |
| Support requesters | Support/feedback form, or mail to support@ |
| Downloaders | `get.openvolley.app`, GitHub releases, F-Droid, desktop/Android update checks |

## 4. Data categories

Legal bases are given as candidates (GDPR Art. 6(1); for the revFADP the same
grounds work as justification under Art. 31). **(b)** = contract or service the
user asked for. **(f)** = legitimate interest. **(a)** = consent.

### 4.1 Accounts (cloud)

| | |
|---|---|
| **Data** | Email; password as bcrypt hash (`auth.users.encrypted_password`); first and last name, country (default `CHE`), date of birth (optional field, empty by default: `frontend/src/components/auth/SignUpForm.jsx`), roles (`profiles.roles`), app memberships (indoor/beach, `auth.app_memberships`), created / updated / last sign-in / email-confirmed times; `banned_until` / `deleted_at` on accounts imported from Supabase. The sign-up form data is also kept as a raw copy in `auth.users.raw_user_meta_data` (F15) |
| **Whose** | Account holder |
| **Purpose** | Sign-in; showing the role-based features; pre-filling the scorer's own entry (name, country, DOB) in the officials block of a scoresheet (`MatchSetup.jsx:1439`) |
| **Basis** | (b); DOB: (a) (optional field) or (b) where it fills the official scoresheet |
| **Stored** | Postgres on the VM (DE); backups (DE, CH); the browser keeps a copy of the profile (`localStorage.cachedProfile`) |
| **Who sees it** | The account holder; admins (the admin Accounts list searches email and names: `lib/accounts.js:509`). `profiles` and `user_matches` are owner-scoped over `/api/db` (`server.js:376`) |
| **Retention as built** | Until the account is deleted. **No expiry for dormant or never-confirmed accounts** (F10) |
| **Delete path** | Self-service "Delete account" (`lib/auth.js:1303` `deleteAccount`). It hard-deletes `auth.users`, `profiles`, `user_matches`, `match_editors`, sessions, tokens, memberships, approval PIN and invite redemptions (FK cascade) and the user's own `backup/` files. It sets `created_by` / `closed_by` / approval user columns to NULL on records that stay (matches, approvals, competitions, tournaments, invites). What stays is listed in 4.6, 4.8 and 4.9 |

### 4.2 Sessions, email links, sign-in protection

| | |
|---|---|
| **Data** | Session token as SHA-256 hash, user id, created / expires / last-seen time (`auth.app_sessions`, `db/002`). Email-link tokens (password reset, email confirmation) as SHA-256 (`auth.app_tokens`, `db/010`). Per-IP and per-email rate-limit and lockout counters **in memory only** (IPv6 keyed on the /64) |
| **Purpose** | Keeping the user signed in; account security |
| **Basis** | (b), (f) security |
| **Stored** | VM. The session token itself sits in the browser (`localStorage.api_auth_token`) |
| **Retention as built** | Session: 30 days sliding, 90 days maximum, removed on sign-out, password change and account deletion; swept hourly (`server.js:4497`). Reset link 60 min, confirmation link 24 h, rows deleted 7 days after use or expiry (`lib/auth.js` `tokenRetentionSec`). Counters: process memory, gone on restart |
| **IPs** | The backend does **not** log client IPs (`lib/opsLog.js`: "never receives ... client IPs"). Per-IP limits live in memory. Cloudflare sees every IP (its own logs) |

### 4.3 Account emails

| | |
|---|---|
| **Data** | Recipient address; name of the approving scorer and game text in approval notices; the language |
| **Kinds** | Reset link, confirmation link, "password changed", "your result was approved with your PIN", "approval PIN locked" (`lib/mailer.js` `MAIL_KINDS`) |
| **Processor** | Migadu (SMTP, TLS required) |
| **Basis** | (b); approval notices (f) (security of the official's approval) |
| **Logs** | Recipients only masked (`maskEmail`). No tracking pixels, no remote images |

### 4.4 Approval PIN and match approvals

| | |
|---|---|
| **Data** | Approval PIN as HMAC-SHA256 with a secret kept outside the database, salt, failure counter, lock and disable times, last use (`auth.approval_pins`, `db/011`). Per approval (`public.match_approvals`): match, slot (referee1/referee2/scorer), official's account id, **display name snapshot**, time, requesting account, **IP hash and device hash** (HMAC, pseudonymous), match status, canonical result and its hash, revocation fields |
| **Whose** | Officials (referees, scorer) |
| **Purpose** | A verifiable sign-off of the result next to the drawn signatures; detecting misuse |
| **Basis** | (f) integrity of official results; (b) for the account holder |
| **Who sees it** | The official (own approvals), the match's scorer, admins (`/api/admin/approvals`, shows `ip_hash8` / `device_hash8`) |
| **Retention as built** | PIN: until removed or the account is deleted. Approvals: **indefinitely**, as part of the match record. Append-only, and they survive account deletion with the name snapshot (user ids set NULL) |

### 4.5 Invite codes

`public.invite_codes`: code as SHA-256 plus the last 4 characters, label,
club, role, sport, limits, creator. `public.invite_redemptions`: who redeemed
which code and when (deleted with the account). Basis (b)/(f). Retention: until
an admin deletes them. Revoked or expired codes are kept.

### 4.6 Audit log

| | |
|---|---|
| **Data** | `public.audit_log` (`db/007`): time, actor id, action, target user id, match id, details (JSON), app. The details hold, among others: **the email address of an account added as match editor** (`lib/accounts.js:801`), role changes (before/after), invite labels, **beach pair names** of created or deleted entries (`lib/beachTournaments.js:702,744`), tournament titles, game numbers |
| **Purpose** | Accountability for role changes, approvals, closing/reopening matches |
| **Basis** | (f) |
| **Who sees it** | Admins (`/api/admin/audit`) |
| **Retention as built** | **Indefinitely. No sweep.** Actor and target ids are set NULL when an account goes, but **email addresses and names in `details` stay** (F5) |

### 4.7 Match records in the cloud (indoor and beach)

| | |
|---|---|
| **Data** | `public.matches`: game number, teams (name, short name, colour), **rosters: players with number, first and last name, date of birth, libero/captain flags; bench staff with role, name, DOB**, officials (names, country, DOB), **signatures (PNG images of captains, coaches, referees, scorer: `SignaturePad.jsx`, `CoinToss.jsx`)**, coin toss, sanctions, results, manual changes, **remarks** (the scoresheet's REMARKS box as free text, `remarks`, db/017: scorer notes, injury / exceptional substitution / forfeit lines, "Actual start time"; can name a player and an injury; never public, never in the activity log or the sync console lines, which keep its length only), pending rosters uploaded by team managers (with DOB), game PIN and connection PINs (HMAC with `OV_PIN_SECRET`), venue (hall, city), creator and closer account. `public.sets`. `public.events` with payloads and full state snapshots (line-ups, sanctions by player number). `public.match_live_state` (score, line-ups by number). Beach matches use `team1_data` / `players_team1` etc. Match rosters do **not** carry licence numbers (those live in saved teams and beach entries) |
| **Whose** | Players, staff, officials (third parties); the scorer |
| **Purpose** | Electronic scoresheet of an official match: live scoring, the official record, livescore |
| **Basis** | (f) of the clubs, the association and the officials in a correct official record (and the scorer's (b)); DOB: (f) eligibility and age-category checks on the official scoresheet. Signatures: (f) the record's integrity |
| **Stored** | VM (DE); backups (DE, CH); the scorer's device (4.11) |
| **Who sees it** | Full rows: the creating account, accounts that proved the game PIN (`match_editors`), admins. Referee/bench tablets after a PIN: rosters with names and numbers, **without DOB, country, signatures, officials, approvals or pending rosters** (`lib/publicColumns.js` `publicRelayMatch`). Public (no session): see 4.8 |
| **Retention as built** | **Indefinitely.** Once a match is approved/final it is **closed and read-only**, even for its creator (`db/007` `ov_matches_guard`). Only an admin can reopen it. Account deletion keeps the matches (creator set NULL) |
| **Delete path** | Open matches: the owner can delete over `/api/db`. Closed matches: **no endpoint deletes or anonymises personal data**. It takes a manual SQL session with `ov.allow_closed = 'on'`, and the copies in `events.state_snapshot`, `backup/` files, scoresheet files and the backups (F2) |

### 4.8 What is public (no account, no PIN)

| Where | Fields |
|---|---|
| Livescore, live sockets (`LIVE_COLUMNS`) | Team names, short names and colours, scores, sets, serving team, server number, line-ups **by player number**, sanctions and substitutions **by number**, timeouts, venue fields of `match_info`, league, gender, game number. **Beach team names are usually the players' surnames**, so for beach the player names are public |
| `/api/db` without a session (`ANON_DB_COLUMNS`) | Matches as above plus the connection flags. Rosters (names, numbers, flags, bench roles; no DOB) **only for the match whose PIN the caller proved**. `referee_database`: first and last name, country, sport (no DOB). `svrz_games`: game data **including referee and line-judge names and the convocation list** (no DOB) |
| Relay match list / summary | Teams, status, scores; a match's room id only to the referee-enabled ones or to the venue's own IP (`cloudListsMatch`) |
| Public beach tournament page (`/api/public/beach/t/:slug`) | Only tournaments marked public and not drafts: pair names, **player first and last names and countries**, seeds, ranks, schedule, courts. Never licence numbers |
| LED board | Team names and scores |

### 4.9 Saved teams (competition manager) and beach tournaments

| | |
|---|---|
| **Data** | `competitions`, `competition_teams` (name, club, VolleyManager team name). `competition_players`: number, first and last name, **DOB, licence number**, libero/captain flags, beach country. `competition_staff`: role, name, **DOB, licence number**. Beach: `beach_tournaments` (title, venue, city, dates, public flag), `beach_entries.player1/2` = {first, last, **licence**, country}, `beach_tmatches.referee` / `.scorer` (free-text names), results, `beach_tournament_managers` |
| **Whose** | Players, staff, referees (third parties); the manager |
| **Purpose** | Re-using rosters; running beach tournaments; matching imports by licence number |
| **Basis** | (f) of the club or organiser |
| **Who sees it** | Accounts with the manager or scorer role of that sport (`lib/manageApi.js`); the public page for public tournaments (4.8). Scorers' devices cache saved teams with DOB and licence (`frontend/src/db/savedTeams.js`), cleared on sign-out or account switch |
| **Retention as built** | Until a manager deletes them (delete endpoints exist for teams, players, entries, draws and tournaments). **Account deletion keeps them** with `created_by` NULL (F21). Archived competitions are kept |

### 4.10 Reference data: referee directory and the VolleyManager sync

| | |
|---|---|
| **`referee_database`** | First and last name, country, **DOB**, sport. A shared directory: **any account may add a referee** from Match Setup (`server.js:191`); changes and deletes are for admins. Names and country are public (4.8). **The full row with DOB goes to any signed-in account**, and any visitor can create an account (F1) |
| **`svrz_games`** | Every official game in the window (today −1 to +14 days, `VM_SYNC_DAYS_*`), from VolleyManager: teams, hall and address, league, **1st/2nd referee name and DOB, line judges, convocations**, supervision flags. Read-only for clients. Names are public; **DOBs go to any signed-in account** (F1). `svrz_sync_log` logs each run (counts, redacted errors) |
| **Purpose** | Suggesting officials; loading an official match with its officials |
| **Basis** | (f). Source: Swiss Volley (check the terms of the VolleyManager account used: F6) |
| **Retention as built** | Directory: until an admin deletes a row. `svrz_games`: **indefinitely**; a row is overwritten only when its game number comes back in a later season (`db/007` comment). No sweep. Sync log: indefinitely (no personal data) |

### 4.11 On the user's device (web, desktop, Android)

| | |
|---|---|
| **IndexedDB `escoresheet` (Dexie)** | Matches, teams, players (with DOB), sets, events with state snapshots, sync queue, officials and scorers lists, interaction logs, saved-teams cache. Written first, synced when online and signed in. **No automatic expiry for matches** (deleted by the user or by clearing app data). Sent sync jobs are pruned after 7 days (`hooks/useSyncQueue.js:110`) |
| **localStorage** | Session token (`api_auth_token`), cached profile, UI settings (language, display, key bindings), on referee tablets **the referee PIN and match id** (`refereePin`, `refereeMatchId`: F19), the unsent console-log lines (for the same account only; dropped on sign-out and account deletion), log upload cursor |
| **Local logs** | Console lines in memory and localStorage; interaction logs in IndexedDB (`utils/comprehensiveLogger.js`), downloadable by the user. Uploaded only when signed in (4.12) |
| **Desktop app (Tauri)** | Same web data in the app's webview profile. **Automatic match backups** as JSON files in `~/.local/share/OpenVolley/backups` (Linux) or `%APPDATA%\OpenVolley\backups` (Windows), mode 0700/0600 (`src-tauri/src/backup.rs`). They hold names and DOBs, **without PINs** (`utils/nativeBackup/redact.js`). Rotation: 30 days, at most 500 files and 64 MB per match (`utils/nativeBackup/rotation.js`) |
| **Android app (Capacitor)** | Same web data. Native backups go to the **public Documents folder** (fallback: app external or private folder). They **survive an uninstall** and on Android 10 and older **other apps can read them** (F9). `android:allowBackup="true"`, so Android may copy app data (IndexedDB with rosters) into the user's Google backup (F9) |
| **LAN relay (desktop app at a venue)** | Rust relay (`src-tauri/src/relay.rs`, port of `electron/lanRelayCore.cjs`) serving tablets on the local network or the laptop's own hotspot/Bluetooth network. Match data **in memory only**; full bundle (names, no DOB/signatures/officials) only to tablets that proved a PIN. Hotspot name and password are random, generated per run on the device (`netshare/creds.rs`). Nothing leaves the LAN except the cloud sync when the scorer is signed in |
| **Firewall / hotspot** | The Windows installer adds one inbound rule (this program, TCP, local subnet only) (`src-tauri/src/firewall.rs`). Linux hotspot profiles are volatile (`netshare/linux.rs`). No personal data involved |

### 4.12 Uploads to cloud storage (`STORAGE_ROOT` on the VM)

| Bucket / path | Content | Who can read | Retention as built |
|---|---|---|---|
| `backup/{userId}/backups/backup_g{n}/...json` | Full match backup from the scorer's device: rosters with DOB, signatures, events (`utils/logger.js:553`) | The uploading account | **30 days**, daily sweep (`server.js:4501`), paused while the host backup is stale. Deleted with the account |
| `backup/{userId}/logs/game_{n}/logs_*.txt` | The scorer app's console lines (may contain names, game numbers, errors) (`utils/logger.js:474`) | The uploading account | **No expiry**: the sweep covers only `backups/` (F4). Deleted with the account |
| `scoresheets/{date}/game{n}_{key}[_final].json/.pdf` | The finished scoresheet (rosters with DOB, signatures, officials, events) (`utils/scoresheetUploader.js`) | The uploading account only (owner records under `.owners/`) | **No expiry.** On account deletion the file **stays** and nobody can read it until an operator grants access (`lib/storage.js:710`, F3) |

### 4.13 Support and the legacy mail routes

| | |
|---|---|
| **`POST /api/contact`** (support/feedback form in both apps) | Type, area, severity, comments, optional email, page URL, user agent. The **email and the first 100 characters of the comment go to the container log** (`server.js:2117`). It is mailed to `CONTACT_EMAIL` (default support@openvolley.app) **only when `SMTP_LEGACY_ROUTES=1`**. That is off by default, and then the form answers "Feedback received" although the message exists **only in the log** (F12) |
| **`POST /api/match/send-info`** | Sends the game number, **game PIN**, teams, date and venue to an address the scorer types in, via Resend (US) or legacy SMTP. Logs the **full recipient address** (`server.js:2324`) |
| **Mail to support@** | Migadu mailbox. Kept as long as the operator keeps the mail (no rule yet: decide one, e.g. 2 years) |
| **Basis** | (b) / (f) |

### 4.14 Logs on the VM

| Log | Content | Retention |
|---|---|---|
| Backend stdout (Docker `json-file`) | Value-free request logs (status, error code, table, request id; `lib/opsLog.js`), connection counts, sweep and sync results, the contact/send-info lines above, masked mail recipients | Size-based rotation: 5 × 10 MB per container (`deploy/compose.yaml`). Time span depends on traffic (days to weeks) |
| Postgres log | Statements slower than 500 ms (`log_min_duration_statement=500`) **with their bind parameters** (Postgres default `log_parameter_max_length=-1`), which can contain names, emails or rosters (F11) | Same 5 × 10 MB rotation |
| cloudflared, Caddy | Tunnel status; Caddy has no access log | Same rotation |
| Cloudflare (edge) | IPs, URLs, user agents of every request | Cloudflare's own retention (processor terms) |

### 4.15 Backups

| Stage | What | Retention as built |
|---|---|---|
| VM (DE) `backup-openvolley.sh` | Hourly `pg_dump` of the whole database; nightly tar of `storage/scoresheets` and of `storage/backup` files changed in the last ~26 h. GPG-encrypted to a public key; the private key is never on the VM | DB dumps 48 h (`OV_DB_KEEP_MIN=2880`), file tars 7 days (`OV_FILES_KEEP_DAYS`) |
| NAS at home (CH) `nas-pull.sh` | Pulls the encrypted files nightly over Tailscale (read-only key) | DB dumps 30 days, file tars 90 days; **plus btrfs snapshots 7 daily / 4 weekly / 6 monthly** (`nas-pull.sh:10`) |
| lenovoserver (CH) `restore-test.sh` | Weekly: decrypts the newest dump into `/dev/shm`, restores into a throwaway Postgres, checks, tears down | Nothing kept but a row-count floor file |

So **a record deleted from the live database can stay in the encrypted backups
for up to about 6 months** (the monthly NAS snapshot that still holds a 90-day
file tar). The policy must say so (F8).

### 4.16 Downloads and update checks

| | |
|---|---|
| `get.openvolley.app` | Static (APT repo, F-Droid repo, install page, desktop `latest.json`). Via Cloudflare Tunnel to Caddy on the VM, no access log |
| Desktop updater | Fetches `https://get.openvolley.app/desktop/latest.json`, falling back to GitHub. 60 s after start, every 6 h, at sign-in, on demand; never during a live match (`src-tauri/src/updater.rs`). Sends nothing beyond the HTTP request (IP, user agent) |
| Android | Installed from an F-Droid client: never checks on its own. Sideloaded: asks once (default off). Only with **yes** does it read `get.openvolley.app/fdroid/repo/index-v2.json` at most every 24 h (`utils/androidUpdate.js`). This is consent (a) |
| `app.openvolley.app` home page | On a desktop OS (outside the desktop app) the browser fetches `api.github.com/repos/Lucanepa/openvolley/releases` to link the newest installer (F14) |

### 4.17 Activity log and event history (2.4.0; db/015, db/016)

| | |
|---|---|
| **Event history** (`event_history` in IndexedDB; `events.voided_*` + `event_revisions` on the server) | Every undo, delete, edit and restore of a match event: the event row before (and after) **without** the state snapshot, the reason (undo, decision change, manual adjustment, forfeit reversal, reopen set, roster reopen), time, random device id, app version, account id. Server: an undone event is marked voided, never deleted; the revision rows are append-only for the app (`db/roles.sql`) and live as long as the match (part of the match record). Owner / editors write them (`lib/eventRevisions.js`); admins read them (`GET /api/admin/matches/:id/revisions`). Account deletion clears `voided_by` / `actor_id` |
| **Activity log** (`activity_log` in IndexedDB and on the server) | One entry per scoring action, correction, set start/end, match status, signature (role only), approval (role and method, **never the PIN**), remarks (**length only**), manual change (sensitive fields such as DOB as "changed"), roster change (number only), sync error (HTTP status, code, request id), app start/update/quit, app error (message, top 5 `file:line` frames), backup error, sign-in/out. Each with random device id (`ov.deviceId`), app version, platform, account id. Sanitized twice (allowlist per kind, key denylist, no data URLs/JWTs, 4 KB): `domain/activitySummary.js`, `lib/activitySanitize.js` |
| **Who reads it** | The match's owner and editors (`GET /api/activity?match=`, only what the match's scorers uploaded); admins (console tab Activity, CSV/NDJSON export). Not reachable through `/api/db` |
| **Retention as built** | Device: uploaded rows 180 days and at most 100,000 rows; rows still to upload kept below 200,000 (`utils/activity/writer.js`). Daily files `OpenVolley/logs/activity-YYYY-MM-DD.jsonl` (desktop: `src-tauri/src/activity.rs`, Android: Documents, **survive uninstall** like the backups): 30 files, 50 MB. Server: match entries 24 months after the event, or deleted with the match (trigger); entries without a match 90 days (`purgeActivity`, daily). Delete on request: `DELETE /api/admin/activity?match=|account=` (audited `activity.delete`). Account deletion: entries without a match deleted, match entries kept with `account_id` / `uploader_id` cleared |
| **Interaction (click/key) log** | `interaction_logs` in IndexedDB only, **never uploaded**; password and PIN fields are never recorded; 30 days, 50,000 rows; exported by the user (options → diagnostic log, match-end ZIP). The scoreboard's debug lines are in it too (category `debug`) |
| **Desktop log** | `desktop.log` in the same folder (tauri-plugin-log): app start, updates, popups (URLs without query), tablet count changes; never PINs, tokens or hotspot credentials. 5 MB × 5 files |
| **Basis** | (f) integrity of the official match record and troubleshooting; (b) for the scorer's own account |

## 5. Processors and transfers

| Recipient | Role | Country | Transfer basis to cite | Action |
|---|---|---|---|---|
| Hetzner Online GmbH | Hosting (VM, disks) | DE | EU, recognised as adequate by Switzerland | Sign the DPA (AVV) in the Hetzner console |
| Cloudflare Inc. | CDN/Pages, DNS, Tunnel, TLS termination | US (global edge) | Swiss-U.S. DPF (Cloudflare is certified; check) and/or SCCs in Cloudflare's DPA | The DPA is part of Cloudflare's self-serve terms; keep a copy |
| Migadu | Email | CH (check the server location) | — | Check their DPA / terms |
| Resend Inc. | Email for send-info, **only if `RESEND_API_KEY` is set** | US | DPF/SCCs | Either remove the key and code (preferred; F13) or list it |
| GitHub Inc. | Downloads, release list | US | Own controller (visitors go to GitHub) | Mention it as a third party with its own privacy statement |
| F-Droid | App catalogue | Own controller | — | Mention it |
| Swiss Volley (VolleyManager) | Source of schedule and referee data | CH | — | Check the account's terms (F6) |
| Tailscale | Network for the backup pull; sees no content (WireGuard end-to-end, files are GPG-encrypted) | US | No personal data | No mention needed |
| Uptime Kuma pushes | Status only | Operator's own | No personal data | — |

Not in use (code present but not configured in `deploy/compose.yaml`):
PocketBase (legacy relay backup), Supabase (left in 2026-10).

## 6. Retention as built: summary

| Data | Kept |
|---|---|
| Account, profile | Until deleted by the user; no inactivity limit |
| Sessions | 30 days sliding, max 90 days |
| Reset / confirmation links | 60 min / 24 h, rows gone 7 days later |
| Rate-limit / lockout counters | Memory only |
| Approval PIN | Until removed or account deleted |
| Approvals (with IP/device hash, name snapshot) | Indefinitely, with the match |
| Audit log | Indefinitely |
| Event history (undone / corrected events) | With the match (part of the record) |
| Activity log (server) | Match entries 24 months or with the match; others 90 days; delete on request |
| Activity log (device) | Uploaded rows 180 days / 100,000 rows; daily files 30 days / 50 MB |
| Interaction (click) log (device only) | 30 days / 50,000 rows |
| Match records (cloud) | Indefinitely; closed matches read-only |
| Saved teams, beach tournaments | Until deleted by a manager (kept after the creator's account is deleted) |
| Referee directory | Until an admin deletes a row |
| `svrz_games` | Indefinitely (overwritten per game number) |
| `backup/…/backups/` files | 30 days |
| `backup/…/logs/` files | Indefinitely (until account deletion) |
| Scoresheet files | Indefinitely (kept unreadable after account deletion) |
| Container logs | 5 × 10 MB per container (size-based) |
| Backups | 48 h / 7 days on the VM; 30 / 90 days on the NAS + snapshots up to ~6 months |
| Device: IndexedDB matches | Until the user deletes them |
| Device: desktop/Android backup files | 30 days, ≤ 500 files and 64 MB per match |
| Relay (cloud and LAN) | Memory; cloud rooms dropped 24 h after the last activity (`server.js:835`) |

## 7. Findings (gaps between the code and "as long as needed, delete on request")

| # | Severity | Finding | Where | Suggested fix |
|---|---|---|---|---|
| F1 | High | **Referees' dates of birth go to any signed-in account.** Sign-up is open to anyone and gives no role, yet a session is enough to read full `referee_database` and `svrz_games` rows with DOBs | `backend/server.js:2815-2825`, `lib/publicColumns.js` (comments "dates of birth only with a session") | Require a scorer/admin role for the DOB columns (or drop DOBs from `svrz_games` if unused) |
| F2 | High | **No delete or anonymise path for personal data in closed matches.** "Delete on request" today needs manual SQL with `ov.allow_closed`, plus the copies in `events.state_snapshot`, `storage/backup`, `storage/scoresheets` and the backups | `db/007` `ov_matches_guard`; no admin endpoint | Admin endpoint or script "redact person X in match Y" (rosters, snapshots, files) with an audit entry; a runbook for requests; state the backup lag |
| F3 | Medium | Scoresheet files are kept forever. After the uploader's account is deleted they stay on disk and **nobody can read them** (no purpose left) | `lib/storage.js:710` `deleteUserData`, no sweep of `scoresheets/` | Delete files left without an owner, or set a season-based retention (e.g. season + N years) and document it |
| F4 | Medium | Uploaded console logs (`backup/{user}/logs/`) are never swept | `server.js:4501` sweeps `backup/backups` only; `utils/logger.js:474` | Sweep `logs/` too (e.g. 30–90 days) |
| F5 | Medium | The audit log keeps email addresses (`match.editor_add`) and beach pair names in `details`, forever and past account deletion | `lib/accounts.js:801`, `lib/beachTournaments.js:702,744` | Store user ids instead of emails; retention of e.g. 2 years; scrub `details` on account deletion |
| F6 | Medium | `svrz_games` holds referee/line-judge names, DOBs and convocations from a **login-protected** VolleyManager search. Kept forever, names public without a session | `lib/vmSync.js`, `lib/publicColumns.js` `SVRZ_GAMES_COLUMNS` | Check the VolleyManager account's terms; drop names from the anonymous projection unless needed; delete rows of past seasons |
| F7 | Medium | Referee directory: any account can add third parties (names, country, DOB). Names and country are public; only admins can delete | `server.js:191-195` | Make DOB optional and not public, add a removal path, mention it in the policy |
| F8 | Medium | Deleted data stays up to ~6 months in NAS snapshots (beyond the 30/90-day file retention) | `deploy/nas-pull.sh:10,25-26` | Say so in the policy, or shorten the snapshot plan |
| F9 | Medium | Android: backup files with names and DOBs in the public Documents folder, kept after uninstall, readable by other apps on Android ≤ 10; `allowBackup="true"` lets Google backup copy app data. Same in OpenBeach | `frontend/src/utils/nativeBackup/platform.js:89`, `android/app/src/main/AndroidManifest.xml` (both repos) | Prefer the app's own folder, or tell the user clearly; `allowBackup="false"` or data-extraction rules |
| F10 | Low | Dormant and never-confirmed accounts are never removed | `lib/auth.js` | E.g. delete unconfirmed accounts after 30 days, warn and delete after N years of inactivity |
| F11 | Low | Postgres logs slow statements with full bind parameters | `deploy/compose.yaml` (`log_min_duration_statement=500`) | Add `-c log_parameter_max_length=0` |
| F12 | Medium | The support form says "Feedback received" but, with `SMTP_LEGACY_ROUTES` unset (the default), the message is only logged (email + first 100 characters) and never delivered. `send-info` logs full recipient addresses | `server.js:2060-2228`, `server.js:2324` | Deliver to support@ (a fixed recipient is not an open relay), or say "not sent"; mask addresses in logs |
| F13 | Low | Resend (US) is still wired up for `send-info` | `server.js:675`, `deploy/env.example:51` | Check `.env`; remove it if unused, otherwise list it as a processor |
| F14 | Low | The `app.openvolley.app` home page sends visitors' IPs to GitHub (`api.github.com`) | `frontend/src/components/pages/HomePage.jsx:13,60` | Serve the release info from `get.openvolley.app/desktop/latest.json`, or name GitHub in the policy |
| F15 | Low | The sign-up data (names, country, DOB) is kept twice: `profiles` and `auth.users.raw_user_meta_data`; profile edits leave the raw copy stale | `lib/auth.js:1193` | Do not store the raw copy, or clear it after creating the profile |
| F16 | Info | TLS ends at Cloudflare: all API traffic, rosters and DOBs included, is visible to Cloudflare | `deploy/cloudflared/config.yml` | Name it in the policy (processor, US transfer) |
| F17 | Low | OpenBeach shows `luca.canepa@gmail.com` as support and its support-form fallback mails `volleyball@lucanepa.com` | openbeach `HomeOptionsModal_beach.jsx:410`, `SupportFeedbackModal_beach.jsx:201` | Use support@openvolley.app (Appendix A) |
| F18 | Info | Dead code calling third parties: flag images from `flagcdn.com` (`DashboardOptionsMenu.jsx`, used only by a test) and QR codes from `api.qrserver.com` (`utils/networkInfo.js:118`, unused) | frontend | Delete, so they can never ship |
| F19 | Low | Referee tablets keep the referee PIN in localStorage (shared devices) | `refereePin` | Session storage or clear at match end |
| F20 | Info | Approvals keep a pseudonymous IP hash and device hash forever | `db/011` | Mention in the policy; consider dropping them after the season |
| F21 | Low | Saved teams and beach tournaments made by a deleted account stay (third parties' DOBs and licence numbers) with no owner | `lib/auth.js` `detachedColumns`; `db/007`, `db/014` | Decide: hand them over to the club or admin, or delete orphaned ones |
| F22 | Info | Many players are minors; the apps hold their DOBs | rosters, saved teams | Address minors in the policy (who supplies the data: the club/scorer; how parents can ask for deletion) |
| F23 | Medium | **The browser and Android scorer apps publish every created match to the cloud relay without a sign-in** (`sync-match-data` with teams, `homePlayers`/`awayPlayers` straight from IndexedDB, sets, events). The relay accepts unauthenticated scoreboards and keeps the room in memory until 24 h after the last activity; tablets get the PIN-gated projection. The desktop app uses its LAN relay instead. The first draft said "data stays on your device until you sign in": corrected in privacy (In short, 3, 5, 9) | `frontend/src/App.jsx:1056-1145`, `utils/backendConfig.js` `getRelayWebSocketUrl` (static deployment -> `backend.openvolley.app`), `backend/server.js` `handleSyncMatchData` | Decide whether the scorer should send DOBs to the relay at all (strip `dob` in `relayMatchPayload`, the tablets never get it), or publish only when a tablet connection is on |
| F24 | Info | IP addresses: the backend keeps client IPs in memory for rate limits, connection caps and the relay's same-venue check (`cloudListsMatch`); never logged or stored, except the HMAC'd `ip_hash` of an approval. Now stated in privacy 14 | `backend/server.js` `getClientIp`, `ipBucketKey` | — |

## 8. What the policy can truthfully say (checklist for the texts)

- Operator, contact, `[ADRESSE / ADDRESS]`; no data protection officer
  (not required for a private operator); FDPIC (and, for EU residents, their
  authority) as the supervisor.
- No cookies, no analytics, no ads, no tracking. Local storage only for
  offline scoring, settings and the sign-in token (necessary).
- The apps work offline; data stays on the device unless the user signs in and
  syncs.
- Accounts: the data in 4.1. DOB is optional. The user can delete the account
  at any time in the app; what stays (official match records, approvals,
  scoresheets) and why.
- Match records: what they contain, who enters them (scorer, team managers,
  competition managers, VolleyManager), who sees what (4.8: public score and
  team names, PIN-gated names, never public DOBs or signatures), kept as
  official records as long as needed (season plus archive); deletion or
  redaction on request where the record does not need the data (state the
  backup lag of up to ~6 months).
- Beach: pair names, player names and countries are public on public
  tournaments; licence numbers and DOBs never.
- Officials: referee directory, VolleyManager sync, approvals with PIN, the
  pseudonymous IP/device hash.
- Processors and transfers (section 5), including Cloudflare seeing the
  traffic and Cloudflare/GitHub being US companies.
- Backups: encrypted, in Germany and Switzerland, retention as in 4.15.
- Logs: no IP logging by the backend; Cloudflare edge logs; container logs
  rotate by size.
- Update checks: desktop (automatic, no personal data beyond the request),
  Android (only with consent, or never for F-Droid installs).
- Rights: access, correction, deletion, objection, data portability
  (export: the app's backup/scoresheet download), via support@. Answer within
  30 days.
- LAN relay and hotspot: data stays inside the venue's network.

Fix F1, F2 and F12 (or describe them accurately) before claiming "delete on
request" and "we answer your message".

## 9. Open questions for the owner

1. Is `RESEND_API_KEY` set on the VM? Is `SMTP_LEGACY_ROUTES` set?
2. Hetzner location (fsn1 / nbg1 / other) and whether the DPA is signed.
3. Where does Migadu store mail? Which Migadu plan?
4. Whose VolleyManager account does the sync use, and do its terms allow
   storing and showing referee data?
5. Retention for the support@ mailbox and for finished match records
   (e.g. "season + 10 years"?).
6. Is Cloudflare Web Analytics on anywhere?
7. Where is lenovoserver (home, CH)?
8. Controller question in section 1 (clubs vs operator) for the lawyer.

---

## Appendix A: OpenBeach (read-only here: changes it needs)

Another job is changing `wt-ob-release`; these are for that job.

1. `escoresheet/frontend/src_beach/components_beach/options/HomeOptionsModal_beach.jsx`
   - Line ~410: replace `luca.canepa@gmail.com` with `support@openvolley.app`.
   - In the "App version" section (line ~376, next to the icon credits):
     add links "Privacy policy" and "Legal notice" to the published pages.
     Use the URLs the openvolley_home job publishes (e.g.
     `https://openvolley.app/privacy/` and `https://openvolley.app/impressum/`),
     with the language picked from the app language (DE/EN/FR/IT).
2. `escoresheet/frontend/src_beach/components_beach/SupportFeedbackModal_beach.jsx:201`:
   the mailto fallback goes to `volleyball@lucanepa.com`. Use
   `support@openvolley.app`. Add a one-line notice near the email field
   ("We use your address only to answer you. Privacy policy").
3. `escoresheet/frontend/src_beach/components_beach/auth/LoginModal_beach.jsx` (~105,
   "Create account"): a "Privacy policy" link next to it. The sign-up itself
   is on `manager-beach.openvolley.app` (openvolley repo).
4. Public pages without a menu (`livescore_beach.html` / `LivescoreApp_beach.jsx`,
   `scoresheet_archive_beach.html`, the public tournament view): a small
   footer link to the privacy policy and the legal notice.
5. i18n: the new labels in `src_beach/i18n_beach` for de/en/fr/it.
6. `android/app/src/main/AndroidManifest.xml`: `allowBackup` (F9), and the
   public Documents backup folder (F9). Same decision as for OpenVolley.
7. F-Droid / fastlane metadata (`fastlane/`): add the privacy policy URL
   once it exists.
