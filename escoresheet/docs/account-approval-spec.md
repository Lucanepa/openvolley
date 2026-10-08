# Approval with an account (referees and scorer): implementation spec

Status: implemented; the review fixes R1–R9 (end of section 0) are built. Branch `feat/account-approval`, from `main`
(b4068cb1). This document is the contract between the backend agent (owns
`escoresheet/backend/**`) and the frontend agent (owns `escoresheet/frontend/**`). They work in
parallel and neither one changes the other's tree. Section 3 is the interface. Its paths, methods,
bodies, responses and error codes are exact. The frontend can build against stubs until the
backend lands.

Production rules still apply. Never push, tag or deploy, and never touch production. Postgres
tests run only against a throwaway `postgres:17-alpine` container (tmpfs, `--rm`, random port,
unique name) with an `OV_PIN_SECRET` of at least 40 characters. Stop the container afterwards.
Never use `pkill -f` or `pgrep -f`. Never pass `--no-verify` (gitleaks). Stage paths explicitly
and never commit `node_modules`.

---

## 0. Owner decisions → design

Luca proposed "we could have referees and scorers approve via their password, or a pin or
whatever", then answered a structured question. These decisions are fixed:

| # | Decision | Design in one line |
|---|---|---|
| 1 | Account approval sits **next to** the drawn signatures | The signature pads stay as they are. They are the offline fallback and what the Swiss Volley Matchblatt expects. Each of the three slots is complete with **either** a drawn signature **or** an account approval. |
| 2 | Confirmation uses a **personal approval PIN** | 4–6 digits, set once in the profile. The account password is needed to set, change or remove it. It is not the match's referee connection PIN. |
| 3 | Only the **1st referee, 2nd referee and scorer** approve this way | "Only the scorer. Assistant signs only." The assistant scorer, captains and coaches keep signing by hand. |

Other design decisions made in this spec. Each one is flagged so the owner can overrule it:

- **D1** PIN storage uses HMAC-SHA256 with a key derived from `OV_PIN_SECRET`, plus a per-row salt. bcrypt is not used (justified in 1.1). Without `OV_PIN_SECRET` the feature is off (503) and never falls back to plaintext.
- **D2** The scorer slot needs the literal `scorer` role in `profiles.roles`. `admin` alone does not qualify, so an admin who scores adds the scorer role to their own account. The approver must also be the match's creator or an editor of it.
- **D3** ~~Approvals are indoor only for now.~~ Lifted for OpenBeach: `server.js` creates `lib/approvals.js` with `beachApprovals: true`, so beach matches are approved with beach accounts. (A module created without it still answers 409 `OV_APPROVAL_UNSUPPORTED` on a beach match.)
  - Every role check already uses the **sport of the match** (OpenBeach separation, db/012, plan 1.3):
    - a referee slot needs `referee` on an indoor match and `beach:referee` on a beach match;
    - the scorer slot needs `scorer` or `beach:scorer`;
    - the scoring table that sends the approval needs a scorer or referee role of that sport, or `admin`.
  - The audit entries of approvals, undos, PIN lockouts on a match and voids carry the match's app (`audit_log.app`).
  - With `beachApprovals: true` (the server's setting) the beach roles also make an account eligible for an approval PIN. A beach match's result key reads `team1_points` / `team2_points` (1.4).
- **D4** An approval is bound to the result it approved. A reopen voids it, and so does any change of the finished sets. The official approves again.
- **D5** The official is identified by **email** typed on the scoring device. There is no server-side list of referee accounts to pick from, because that list would expose every referee's address to every scorer.
- **D6** Test matches may be approved too, so officials can practise. A test match never closes, so its approvals stay undoable.

**As built after the review (2026-10-07).** These changes override the sections below where they differ:

- **R1 The scoring side never fills a referee slot.** A referee slot is refused with 403 `OV_APPROVAL_SCORER_NOT_REFEREE` when the approver is the match's creator, one of its editors, or the account that sends the request. A club volunteer with both roles can no longer approve as "1st referee" under a borrowed profile name.
- **R2 Only the scoring table sends approvals.** The caller needs the `scorer` or `referee` role, or admin. Otherwise the answer is 403 `OV_APPROVAL_CALLER_ROLE`, checked right after step 5, before any address or PIN is looked up. A pending self-registered account can no longer lock officials' PINs through its own test match. The app hides "Approve with account" for such accounts.
- **R3 Stronger PIN rule.** `isWeakPin` also refuses PINs with at most two different digits (1212, 1122, 1000, 121212), palindromes, 4-digit years 1940–2039 and dates DDMM/MMDD, 6-digit ABCABC, AABBCC and DDMMYY/MMDDYY/YYMMDD dates, and a list of keypad patterns and favourites (2580, 1357, 147258). The frontend copy is the same rule (a vitest compares both over every 4- and 5-digit PIN).
- **R4 Rolling failure count.** A right PIN no longer clears `failed_attempts`. The count restarts only after 30 days without a failure, so a guesser gets at most 9 tries per official per 30 days, however often the official approves. Every 5th failure locks for 15 minutes, the 10th disables, as before.
- **R5 No lock oracle.** A locked or disabled PIN answers 403 `OV_APPROVAL_PIN_INVALID`, exactly like a wrong PIN or an unknown address, and is not counted. 423 `OV_APPROVAL_PIN_LOCKED` is no longer sent. The owner sees the state in the profile and gets an email.
- **R6 A malformed PIN is refused, not counted.** A PIN that is not 4–6 digits answers 400 `OV_APPROVAL_PIN_FORMAT` at step 1, before any lookup. The dialog keeps "Approve" disabled until the PIN has 4–6 digits.
- **R7 The official is told.** With a mailer (SMTP configured), the official gets an email for every approval made with their PIN (match, result, slot, time, short ID, and who sent it) and when their PIN is locked or blocked. Mails go out after COMMIT, in the background, from the new `notify` budget (100 per hour). `GET /api/account/approvals` lists the caller's own approvals (active and revoked, newest first, with `requested_by_name` and the match). The profile shows them under "Your approvals", with undo while the match is open.
- **R8 Teams are part of what was approved.** The `matches_void_approvals` trigger also voids the approvals (reason `result_changed`) when the home or away team's name changes (trimmed, case-insensitive) while the status is ended, approved or final. Swapping the teams after an approval no longer leaves it valid.
- **R10 The PIN is always visible (owner feedback 2026-10-07).** A drawn signature no longer hides "Approve with PIN" (it was `!isSigned` in `SignatureBox`, so a sheet signed by hand showed no PIN at all). Next to each official's signature MatchEnd shows exactly one of: "Approve with PIN", the approved state with Undo, or one line saying why not (`pinApprovalState` in `src/domain/accountApproval.js`, keys `approval.why.*`: assistant scorer signs only, match approved or closed, beach, match not online, no cloud on this device, feature off on the server, signed out, account without the role, offline). Signed boxes get "Re-sign" and "Clear" (`src/domain/signatureEdits.js`); each change is written at once and queued as the match's whole `signatures` object. An approval is bound to the result, not to the image, so re-signing keeps it.
- **R9 Frontend.** Before "Confirm and approve", only the approvals that complete a slot are re-checked: no drawn signature in that slot, and a match with the current result. A stale record in a slot that was signed by hand never blocks, and drawing a signature drops it. "Reopen match" keeps the account approvals, as it keeps the drawn signatures: the result is unchanged and the server keeps them on approved → ended. The admin reopen, "Reopen last set" and a result or team change in Manual adjustments drop them. Manual adjustments now sends the corrected sets through the sync queue, so an approval can bind to them. When the result or a team name changes there, it also clears the post-match signatures and undoes the account approvals online. The admin lookup reads "ID 6F1C2A9B", "#6F1C2A9B" and "#4711" as the bare ID or game number, both in the client and on the server.

---

## 1. Database: `db/011_account_approvals.sql`

Run it as ov_owner after 010. restore.sh runs every `db/NNN_*.sql` with NNN >= 003 in numeric
order, and `roles.sql` runs after it. The migration is idempotent and runs in one transaction
(`BEGIN; SET LOCAL lock_timeout = '5s'; … COMMIT;`). The running backend is safe while it runs:
it only adds new tables, new triggers and one new function. No existing row or column changes.

### 1.1 Approval PIN storage: `auth.approval_pins`

**KDF choice (D1).** A 4–6 digit PIN has only 10^4 to 10^6 values. With a database dump or a
leaked backup in hand:

- bcryptjs at cost 10 (~60–150 ms per guess, the same as passwords) falls in about 13 CPU-minutes for 4 digits and about 1 CPU-day for 6. Both run trivially in parallel on a GPU. It also costs main-thread CPU on every attempt, and it would queue behind sign-ins in the shared bcrypt gate (`auth.bcryptGate`, max 2 concurrent). A wrong-PIN flood would then slow down sign-in.
- An HMAC keyed with a secret that is **not in the database** makes a dump alone worthless. This is the reason `lib/pinHash.js` uses the same approach for match PINs. Online guessing is bounded by the lockout in 1.2. The cost is negligible, so no gate is needed.
- If the database and the secret leak together, any scheme over a 10^6 space falls. bcrypt on top would only stretch that from seconds to hours, which does not justify the event-loop cost.

The scheme, implemented in the new pure module `lib/approvalPin.js` (node:crypto only):

```
pinKey = HKDF-SHA256(ikm = utf8(OV_PIN_SECRET), salt = <empty>, info = "ov-approval-pin-v1", L = 32)
mac    = HMAC-SHA256(pinKey, salt16 || utf8(lower(user_id)) || 0x00 || utf8(pin))
```

- `salt16` is 16 bytes from `crypto.randomBytes`, new on every set or change.
- `user_id` is in the input, so a row copied to another user does not verify.
- Comparison uses `crypto.timingSafeEqual` on the 32-byte values.
- `key_id = 1` names the secret generation. A later rotation bumps it, and rows with an older `key_id` read as "not set". The user sets a new PIN with their password.
- The HKDF subkey keeps these MACs separate from the `h1:` match-PIN HMACs, which use the raw secret.
- `OV_PIN_SECRET` must already be at least 32 characters (`pinHash.MIN_SECRET_LENGTH`). Tests use 40 or more.

**Test vector.** Both the pure test and the pg test assert it:

The secret is `'x'.repeat(40)`: 40 times the letter x. The rest of the vector:

```
HKDF output   221f185ca88913fc317852cebe6db11e0f2f2babbdfe8b6627ae64252ea37599
salt16        000102030405060708090a0b0c0d0e0f
user_id       00000000-0000-4000-8000-000000000001
pin           "482917"
mac           d08eed15f4699da574c7903c6fa92901d53d9fd0e218d33a0b40b1812509203d
```

```sql
CREATE TABLE IF NOT EXISTS auth.approval_pins (
  user_id          uuid        PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  key_id           smallint    NOT NULL DEFAULT 1 CHECK (key_id BETWEEN 1 AND 1000),
  salt             bytea       NOT NULL CHECK (octet_length(salt) = 16),
  mac              bytea       NOT NULL CHECK (octet_length(mac) = 32),
  set_at           timestamptz NOT NULL DEFAULT now(),
  failed_attempts  integer     NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  last_failed_at   timestamptz,
  locked_until     timestamptz,
  disabled_at      timestamptz,          -- too many failures: only a new PIN (password) clears it
  last_used_at     timestamptz
);
```

The table lives in the `auth` schema, as `app_tokens` does. It is therefore never reachable
through `/api/db`, whose allowlist covers `public` tables only. Grants follow the pattern of 010:

```sql
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ov_app') THEN
    GRANT USAGE ON SCHEMA auth TO ov_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON auth.approval_pins TO ov_app;
  END IF;
END $$;
```

`roles.sql` also gets this grant, next to `auth.app_tokens`, guarded by
`to_regclass('auth.approval_pins') IS NOT NULL`. Update the header comment that lists what
`ov_app` has in `auth`.

### 1.2 Failure counter and lockout (per approver, in the database)

The counter is kept per approver account, so it survives restarts and works across processes.
All of its writes happen on the row locked `FOR UPDATE` inside the approve transaction, so
parallel attempts serialise and none can skip the counter.

| Event | Effect |
|---|---|
| Wrong PIN | `failed_attempts += 1` (back to 1 when `last_failed_at` is more than 30 days old), `last_failed_at = now()`. If the new value is a multiple of 5, `locked_until = now() + 15 min`. If it is ≥ 10, `disabled_at = now()`. |
| Correct PIN | `last_used_at = now()`. The failure count stays (R4). |
| PIN set or changed | New salt and MAC, `set_at = now()`, every counter reset (`failed_attempts = 0`, `locked_until`, `disabled_at`, `last_failed_at` NULL). |
| `locked_until > now()` | 403 `OV_APPROVAL_PIN_INVALID`, the same answer as a wrong PIN (R5). The attempt is not counted. |
| `disabled_at IS NOT NULL` | 403 `OV_APPROVAL_PIN_INVALID` (R5). The owner must set a new PIN with their password. |

When a failure causes a lock or a disable, the same transaction writes an audit row
`approval_pin.locked` (actor = caller, target = approver, `match_id`, details
`{ failures, locked_until, disabled }`). The failure update and that audit row are **committed**:
the handler returns the 403 or 423 after COMMIT. It does not abort and roll back.

Known trade-off: an account with the scorer or referee role (R2) can lock an official's PIN on
purpose by typing wrong PINs on a match it scores. The official then signs by hand, which is the
fallback, gets an email (R7) and sees the lock in the profile. A locked or disabled PIN answers
exactly like a wrong PIN or an unknown address (R5), so the answers never tell which addresses
belong to officials with a PIN. Each lock writes an audit row with the sender as actor.

### 1.3 `public.match_approvals`

```sql
CREATE TABLE IF NOT EXISTS public.match_approvals (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id        uuid        NOT NULL REFERENCES public.matches (id) ON DELETE CASCADE,
  slot            text        NOT NULL CHECK (slot IN ('referee1', 'referee2', 'scorer')),
  user_id         uuid        REFERENCES auth.users (id) ON DELETE SET NULL,   -- the official
  display_name    text        NOT NULL CHECK (length(display_name) BETWEEN 1 AND 160),
  approved_at     timestamptz NOT NULL DEFAULT now(),
  requested_by    uuid        REFERENCES auth.users (id) ON DELETE SET NULL,   -- the session that sent it
  ip_hash         bytea       CHECK (ip_hash IS NULL OR octet_length(ip_hash) = 32),
  device_hash     bytea       CHECK (device_hash IS NULL OR octet_length(device_hash) = 32),
  match_status    text        NOT NULL,                                       -- matches.status at approval
  result_key      text        NOT NULL CHECK (length(result_key) <= 400),     -- canonical result, 1.4
  result_hash     bytea       NOT NULL CHECK (octet_length(result_hash) = 32),-- sha256(result_key)
  revoked_at      timestamptz,
  revoked_by      uuid        REFERENCES auth.users (id) ON DELETE SET NULL,
  revoked_reason  text        CHECK (revoked_reason IN ('undo', 'match_reopened', 'result_changed')),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
-- One active approval per slot, one active slot per account (per match)
CREATE UNIQUE INDEX IF NOT EXISTS match_approvals_slot_uidx ON public.match_approvals (match_id, slot) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS match_approvals_user_uidx ON public.match_approvals (match_id, user_id) WHERE revoked_at IS NULL AND user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS match_approvals_user_idx ON public.match_approvals (user_id);
CREATE INDEX IF NOT EXISTS match_approvals_match_idx ON public.match_approvals (match_id, approved_at DESC);
```

- **Hashes.** `ip_hash = HMAC-SHA256(HKDF(OV_PIN_SECRET, info "ov-approval-ip-v1"), ipBucketKey(clientIp))`. With the 1.1 secret and IP `203.0.113.7` the result is `95eef55bcfc176347ee83e195b4b67d6919c3d60684254dc30d46f4a1969cfc1`. `device_hash = sha256("ov-device:" + device_id)` when the client sends a `device_id`, otherwise NULL. Neither is ever returned to a client except admins, and admins get only the first 8 hex characters of each.
- **Short ID.** The short ID printed on the PDF is the first 8 hex characters of `id`, in upper case (`3F9A2C1B`). It is computed, never stored.
- **Revoked rows** stay as history. A deleted account leaves its approvals in place with the name snapshot, because they are club records, as `matches.created_by` is. Add `{ table: 'public.match_approvals', column: 'user_id' }`, `requested_by` and `revoked_by` to `detachedColumns` in `lib/auth.js`.
- **Not reachable through `/api/db`.** `match_approvals` is **not** added to `ALLOWED_TABLES` and never goes to realtime, so `/api/db` and live sockets cannot reach it. `roles.sql`'s schema-wide public DML grant covers it, and 011 grants `SELECT, INSERT, UPDATE, DELETE` explicitly as 007 does.

### 1.4 Canonical result (`result_key`)

The key is built from `public.sets` of the match with `finished IS TRUE`, ordered by `index`:

```
result_key  = "ov-result-v1|" + join(",", "<index>:<home_points>:<away_points>" for each finished set)
result_hash = sha256(utf8(result_key))
```

Test vector: sets `[[1,25,20],[2,23,25],[3,25,18],[4,25,22]]` give
`ov-result-v1|1:25:20,2:23:25,3:25:18,4:25:22`, whose sha256 is
`50cc98ab59081eaafcd703ce412ee1b82c9505e7af7cea8693a2c6143e1fa123`.

The frontend builds the same string from its Dexie sets (`finished`, `index`, `homePoints`,
`awayPoints`) in `src/domain/accountApproval.js` `resultKey(sets)`. It needs no hashing, because
it compares strings. A missing points value counts as 0.

A **beach** match (`matches.sport_type = 'beach'`) stores its points in `team1_points` /
`team2_points`; its `home_points` / `away_points` keep the column default 0. The server then reads
team 1 in the home place and team 2 in the away place (`<index>:<team1_points>:<team2_points>`),
chosen by the sport of the match, never a `coalesce` of the two pairs. OpenBeach builds the same
string in `src_beach/utils_beach/accountApproval_beach.js` `resultKey(sets)`.

### 1.5 Triggers

1. **Closed-match lock.** Reuse 007's function, which reads `match_id` from OLD and NEW:
   ```sql
   DROP TRIGGER IF EXISTS match_approvals_closed_guard ON public.match_approvals;
   CREATE TRIGGER match_approvals_closed_guard BEFORE INSERT OR UPDATE OR DELETE ON public.match_approvals
     FOR EACH ROW EXECUTE FUNCTION public.ov_match_children_guard();
   ```
   A closed match therefore has frozen approvals (SQLSTATE `OVC01`, which maps to 409 `OV_MATCH_CLOSED`). The admin reopen runs with `ov.allow_closed = on`.
   As built: the UPDATE trigger (`match_approvals_closed_guard_update`) has a `WHEN` clause that skips updates which only set `user_id`, `requested_by` or `revoked_by` to NULL. Without it, deleting an account that approved a closed match would fail on the `ON DELETE SET NULL`.
2. **Approvals are append-only.** New function `public.ov_match_approvals_immutable()`, run as a BEFORE UPDATE trigger. An UPDATE may only:
   - set `revoked_at`, `revoked_by` and `revoked_reason` once, from NULL;
   - set `user_id`, `requested_by` or `revoked_by` to NULL (the FK `ON DELETE SET NULL`).

   Anything else raises `'approval is immutable' USING ERRCODE = 'OVA01'`. Add `OVA01` to pgQuery's error map as 409 `OV_APPROVAL_IMMUTABLE`. Only a bug can reach it.
3. **Voiding on reopen.** New function `public.ov_matches_void_approvals()`, run as an AFTER UPDATE trigger `matches_void_approvals` on `public.matches`. Condition:
   ```
   (OLD.closed_at IS NOT NULL AND NEW.closed_at IS NULL)
   OR (OLD.status IN ('ended','approved','final') AND NEW.status IS DISTINCT FROM OLD.status
       AND NEW.status NOT IN ('ended','approved','final'))
   ```
   When it holds, the trigger runs `UPDATE public.match_approvals SET revoked_at = now(), revoked_reason = 'match_reopened', revoked_by = nullif(current_setting('ov.user_id', true), '')::uuid WHERE match_id = NEW.id AND revoked_at IS NULL`. If at least one row changed, it inserts one `audit_log` row `match.approval_void` with details `{ count, reason: 'match_reopened', external_id, game_n }`. This covers the admin reopen and the scorer's "Reopen last set" (status `live`), which syncs through `/api/db`.

Result changes that leave the status alone are **not** caught by a trigger. A trigger on `sets`
would fire on every rally. These changes are detected when the approval is read instead
(`result_matches` in 3.2). A new approval on a slot whose active approval no longer matches the
result revokes the old one with `result_changed` (3.2).

### 1.6 Migration test points (`tests/migration011.pg.test.js`)

Build the database from the 005 schema plus files 006–010, as `migration009.pg.test.js` does,
then run 011 **twice**. Assert:

- Tables, indexes, triggers and CHECKs are present.
- The app role (DML at table level, like `ov_app` after `roles.sql`) can read and write both tables, and cannot `TRUNCATE`.
- A second active approval for the same `(match, slot)` or `(match, user)` fails with 23505.
- Inserting an approval into a closed match fails with OVC01. With `ov.allow_closed = on` the insert is allowed.
- Any UPDATE other than revocation or nulling fails with OVA01. Revoking twice fails.
- The void trigger fires on admin reopen (`closed_at` to NULL) and on `ended` → `live`. It does not fire on `ended` → `approved` or `approved` → `final`, and it writes one audit row.
- Deleting a user (FK) nulls `user_id` and keeps the row.
- Closing a match does not void its approvals.

---

## 2. Backend modules

| File | What changes |
|---|---|
| `lib/approvalPin.js` (new, pure) | `PIN_RE = /^\d{4,6}$/`. `isWeakPin(pin)` is true for one repeated digit (`0000`, `111111`) and for strictly ascending or descending runs (`1234`, `0123`, `123456`, `4321`, `987654`). Also `deriveKeys(secret)` → `{ pinKey, ipKey }`, `macPin(pinKey, salt, userId, pin)`, `verifyPin(pinKey, row, userId, pin)` (constant time, see below), `resultKey(sets)`, `resultHash(key)`, `ipHash(ipKey, ip)`, `deviceHash(id)`, `shortId(uuid)`. |
| `lib/approvals.js` (new) | `createApprovals({ pool, db, access, auth, secret, logger })` returns `{ getPinStatus, setPin, removePin, approve, listForMatch, revoke, adminSearch, approvalsForMatches }`. Handlers return `{ status, body }` and never throw, the same contract as `lib/accounts.js` (`ok`, `fail`, `guarded`, `withTx` and `audit` are reused or imported from there). |
| `lib/accounts.js` | `AUDIT_ACTIONS` adds `'approval_pin.set'`, `'approval_pin.remove'`, `'approval_pin.locked'`, `'match.approve'`, `'match.approval_revoke'` and `'match.approval_void'` (the trigger writes the last one). `listMatches` and `listOfficialGames` attach `approvals` (3.3). |
| `lib/auth.js` | New `auth.verifyPassword(userId, password)` returns `{ ok: true } \| { ok: false } \| { locked: true, retryAfterSec }`. It loads `encrypted_password` and the email by id, runs `checkPassword` (bcrypt gate, dummy hash on a miss) and counts in the **sign-in lockout keyed by that email** (`begin`, `fail`, `succeed`, `release`). It throws `AUTH_BUSY` on a full gate, which the caller answers as 503 `auth_busy`. Add `match_approvals` to `detachedColumns` (1.3). |
| `lib/manageApi.js` + `server.js` `manageFamilyOf` (both copies) | New families: `'/api/account/approval-pin'` and `'/api/account/approval-pin/remove'` → `'approvalPin'`; `'/api/approvals'` or anything starting with `'/api/approvals/'` → `'approvals'`. New routes are in section 3. `/api/admin/approvals` belongs to the existing `admin` family. The prefix is `/api/approvals`, **not** `/api/match/approvals`, because the relay's catch-all `GET /api/match/:id` (server.js ~1857) would answer the latter first. |
| `server.js` | Load `approvalPin.js` and `approvals.js` in `getDataLayer()`. If `pins.enabled` is false, `approvals` is created with `secret = null` and every handler answers 503 `OV_APPROVAL_UNAVAILABLE`, except GET approval-pin, which answers `available: false`. Rate limits are in 3.0. Pass `clientIp` into the route context (`ctx.ip`). |
| `db/roles.sql` | Grant on `auth.approval_pins` (1.1). |
| `backend/README.md` | Short "Approval PINs" section: OV_PIN_SECRET is required, what a secret rotation does, and that an admin cannot read or reset a PIN. |

**Constant-time verification.** `verifyPin` always computes exactly one HMAC. When there is no
user, no PIN row, or a row with an old `key_id`, it computes the MAC with a fixed dummy salt and
the dummy user id `00000000-0000-0000-0000-000000000000`, compares it with a dummy 32-byte value
(`timingSafeEqual`) and returns false. The user lookup and the PIN-row lookup always both run,
whether or not the email exists.

**Never logged.** No handler, log line, audit entry or error `details` ever contains `pin`,
`password`, the MAC, the salt or the approver's email (the email appears only in admin audit
reads, through the `target_user_id` join). `[manage] error:` lines print only `err.message`. The
body is never stringified into a log. A test enforces this (6.1).

---

## 3. API (the contract)

Every response has the shape `{ data, error }`, with `error = { message, code, details? }` and
`Cache-Control: no-store`. Every call needs a session (`Authorization: Bearer`). 401 means "not
signed in" only and is never used for a wrong PIN or password, because the client treats 401 as
an expired session. A database error answers 503 `OV_DB_UNAVAILABLE` with `retryable: true`.
Without a database (LAN or desktop relay) every call answers 503 `OV_DB_NOT_CONFIGURED`.

### 3.0 Rate limits (server.js, before the body is read)

| Bucket | Limit |
|---|---|
| `approvalPin` family, per user (`isRateLimited(user.id, 30, 'approvalPin')`) | 30/min |
| Failed passwords on set/remove PIN: `approvalPasswordLimiter = createAttemptLimiter({ max: 5, windowMs: 15 min })`, keys `u:<id>`, `ip:<ip64>` | 5 per 15 min, refunded on any answer that is not 403 `OV_PASSWORD_INVALID`. The auth email lockout counts as well. |
| `approvals` family, per user (`isRateLimited(user.id, 60, 'approvals')`) | 60/min |
| Wrong PINs on approve: `approvalPinFailLimiter = createAttemptLimiter({ max: 10, windowMs: 10 min })`, keys `u:<caller>`, `ip:<ip64>` | 10 per 10 min, refunded on any answer that is not 403 `OV_APPROVAL_PIN_INVALID` |

A limited request answers 429 `OV_TOO_MANY_ATTEMPTS` (message "Too many attempts. Please wait a
few minutes.") with a `Retry-After` header (600 or 900 seconds, or 60 for the per-minute buckets
with the existing `TOO_MANY` body).

### 3.1 Approval PIN (any signed-in account; eligibility is enforced where stated)

**`GET /api/account/approval-pin`** → 200
```json
{ "available": true, "eligible": true, "set": true, "set_at": "2026-10-07T10:00:00.000Z",
  "locked_until": null, "disabled": false }
```
- `available` is false when there is no `OV_PIN_SECRET`. All other fields are then false or null.
- `eligible` means the account holds `referee` or `scorer` and its email is confirmed. As built, "confirmed" here and in 3.1 step 5 and 3.2 step 10 means `email_confirmed_at` is set, whenever the users table has that column.
- A row with an old `key_id` reads as `set: false`.

**`POST /api/account/approval-pin`** with body `{ "password": "…", "pin": "482917" }` sets or changes the PIN. The checks run in this order:
1. A non-string `pin` or `password` (a number PIN is refused, because leading zeros matter), or a password longer than 72 bytes: 400 `OV_INVALID_REQUEST`.
2. No `OV_PIN_SECRET`: 503 `OV_APPROVAL_UNAVAILABLE`.
3. `pin` does not match `PIN_RE`: 400 `OV_APPROVAL_PIN_FORMAT`.
4. `isWeakPin`: 400 `OV_APPROVAL_PIN_WEAK`.
5. The email is not confirmed: 409 `OV_EMAIL_UNCONFIRMED`.
6. Neither the `referee` nor the `scorer` role: 403 `OV_APPROVAL_ROLE_REQUIRED` `{ details: { roles: ['referee','scorer'] } }`.
7. `auth.verifyPassword`. Locked: 429 `OV_TOO_MANY_ATTEMPTS`. Wrong: 403 `OV_PASSWORD_INVALID`. Busy: 503 `auth_busy`.
8. UPSERT the row with a new salt and MAC and reset the counters. Audit `approval_pin.set` (actor and target are the user, details `{ changed: <bool> }`).

The response is 200 `{ "set": true, "set_at": "…" }`.

**`POST /api/account/approval-pin/remove`** with body `{ "password": "…" }`. Steps 1, 2 and 7
above apply, then `DELETE` the row and audit `approval_pin.remove`. The response is 200
`{ "set": false }`, and it is the same when no PIN was set (idempotent).

### 3.2 Approvals

Slots are `referee1`, `referee2` and `scorer`. The matching match-end roles are `ref1`, `ref2`
and `scorer`.

An **approval record** is what the owner, editors and the approver see:
```json
{ "id": "6f1c…uuid", "short_id": "6F1C2A9B", "slot": "referee1", "name": "Muster Anna",
  "approved_at": "2026-10-07T19:42:10.000Z", "result_key": "ov-result-v1|1:25:20,2:23:25,3:25:18",
  "result_matches": true, "mine": false }
```
- It never contains user ids, emails, IP or device hashes.
- `name` is the snapshot of `profiles.last_name + ' ' + first_name`, trimmed. This matches the PDF's "Last First" name column.
- `result_matches` compares `result_hash` with the hash of the current sets.
- `mine` is true when the caller is the approver.

**`POST /api/approvals`** approves a slot. The body:
```json
{ "external_id": "<match seed_key>", "slot": "referee1", "email": "anna@example.ch", "pin": "482917",
  "result": { "sets": [[1,25,20],[2,23,25],[3,25,18]] }, "device_id": "<optional uuid>" }
```
The order of the checks is part of the contract:

1. Body validation:
   - `external_id` must be a string of 1–200 characters.
   - `slot` must be in the list.
   - `email` must match the auth email regex and be at most 254 characters. It is lower-cased.
   - `pin` must be a string of 4 to 6 digits. A string of another shape answers 400 `OV_APPROVAL_PIN_FORMAT` here and is never counted (R6).
   - `result.sets` must be an array of at most 5 triples of integers (0–99 for the points, 1–5 for the index).
   - `device_id`, when present, must be a uuid.

   Failure: 400 `OV_INVALID_REQUEST`.
2. No secret: 503 `OV_APPROVAL_UNAVAILABLE`.
3. In one transaction, run `SELECT … FROM public.matches WHERE external_id = $1 FOR UPDATE`. This serialises all approvals of a match. No row: 404 `OV_NOT_FOUND`.
4. `sport_type = 'beach'` on a module without `beachApprovals`: 409 `OV_APPROVAL_UNSUPPORTED` (the server enables beach approvals; then the checks below use the beach roles).
5. The caller may write the match (`created_by = caller`, a `match_editors` row, or `access.isAdmin`). If not: 403 `OV_NOT_MATCH_OWNER`.
5b. The caller holds `scorer` or `referee`, or is an admin. Otherwise 403 `OV_APPROVAL_CALLER_ROLE` `{ details: { roles: ['scorer','referee'] } }` (R2).
6. `closed_at IS NOT NULL`: 409 `OV_MATCH_CLOSED`.
7. `status <> 'ended'`: 409 `OV_MATCH_NOT_ENDED` `{ details: { status } }`.
8. `resultKey(server sets)` differs from `resultKey(body.result.sets)`, or the server has no finished set at all: 409 `OV_RESULT_NOT_SYNCED` `{ details: { server: [[i,h,a],…] } }`. The client syncs and retries.
9. Look up the approver with `auth.users` by `lower(email)`. Deleted, banned or blocked users count as unknown. Then `SELECT … FROM auth.approval_pins WHERE user_id = $1 FOR UPDATE`, which is skipped for an unknown user, but `verifyPin` still runs once with the dummy inputs:
   - Disabled or locked: 403 `OV_APPROVAL_PIN_INVALID`, like a wrong PIN. Not counted (R5).
   - Wrong PIN, unknown email, no PIN or old `key_id`: 403 `OV_APPROVAL_PIN_INVALID` (message "Email or PIN not accepted", no details). When a row exists, the failure is counted (1.2) and **committed**. A failure that locks or disables mails the official (R7).
   - Correct: `last_used_at` is set (also committed). The failure count stays (R4).
10. Eligibility, checked only after a correct PIN, so details are never revealed to someone without the PIN. Each failure returns after COMMIT, which keeps the counter reset:
    - Email unconfirmed: 409 `OV_EMAIL_UNCONFIRMED`.
    - Referee slots need the `referee` role. The scorer slot needs the `scorer` role (D2). Otherwise 403 `OV_APPROVAL_ROLE_REQUIRED` `{ details: { role: 'referee' \| 'scorer' } }`.
    - The scorer slot also needs the approver to be `created_by` or an editor of the match. Otherwise 403 `OV_APPROVAL_NOT_MATCH_SCORER`.
    - A referee slot needs an approver who is **not** `created_by`, not an editor and not the caller. Otherwise 403 `OV_APPROVAL_SCORER_NOT_REFEREE` (R1).
    - The profile name is empty: 409 `OV_APPROVAL_NAME_REQUIRED`.
11. Slot and account checks against the active rows of this match:
    - The same user, the same slot and `result_matches`: 200 with the existing record and `already: true`. No new row and no audit entry (idempotent retry).
    - The user holds a **different** active slot: 409 `OV_APPROVAL_ONE_SLOT` `{ details: { slot } }`.
    - The slot is held by someone else and `result_matches`: 409 `OV_APPROVAL_SLOT_TAKEN` `{ details: { name, approved_at } }`.
    - The slot is held (by anyone) but the result no longer matches: revoke that row (`result_changed`, `revoked_by = caller`) and continue. The user's own stale rows in other slots are revoked the same way first.
12. `set_config('ov.user_id', caller, true)`, then INSERT the row with `match_status = 'ended'`, `requested_by = caller`, `ip_hash` and `device_hash`. Audit `match.approve` (actor = caller, target = approver, `match_id`, details `{ slot, short_id, external_id, game_n, result_key }`). A unique violation (23505), which is not expected under the row lock, answers 409 `OV_APPROVAL_SLOT_TAKEN`.

The response is 200 `{ "approval": <record>, "already": false }`.

**`GET /api/approvals?external_id=<seed_key>`** returns 200:
```json
{ "match": { "status": "ended", "closed_at": null, "result_key": "ov-result-v1|…" },
  "approvals": [<record>, …] }
```
- It lists active approvals only, ordered by slot (`referee1`, `referee2`, `scorer`).
- Allowed: the owner, editors and admins, plus any account with an active approval on the match (its own record only).
- Otherwise 403 `OV_FORBIDDEN`. An unknown match is 404 `OV_NOT_FOUND`. A beach match gives `approvals: []`.

**`DELETE /api/approvals/:id`** (undo; no body) runs in one transaction that locks the approval and its match:
- Unknown id: 404 `OV_NOT_FOUND`.
- Allowed callers: the approver themself (`user_id = caller`) or anyone who may write the match (owner, editor or admin). Otherwise 403 `OV_FORBIDDEN`.
- Match closed: 409 `OV_MATCH_CLOSED`.
- Already revoked: 200 `{ "approval": <record with revoked fields>, "already": true }`.
- Otherwise set `revoked_at = now()`, `revoked_by = caller`, `revoked_reason = 'undo'`, audit `match.approval_revoke` with `{ slot, short_id, external_id, reason: 'undo' }`, and answer 200 `{ "approval": <record>, "already": false }`.

### 3.3 Admin (family `admin`, `isAdmin`)

**`GET /api/admin/approvals?q=&include_revoked=0|1&limit=1..200` (default 50)**
- `q` may be an 8-character hex short id (matched with `id::text ILIKE q || '%'`), a game number (`m.game_n`), or an `external_id`.
- Admin records add `user_id`, `email`, `requested_by_name`, `ip_hash8` and `device_hash8` (the first 8 hex characters), `revoked_at`, `revoked_reason`, `revoked_by_name`, and `match: { id, external_id, game_n, home_name, away_name, status, closed_at }`.
- This lookup is how an admin checks the "ID" printed on a PDF.

**`listMatches`** (`GET /api/admin/matches`) and **`listOfficialGames`** (`claim`) gain:
```json
"approvals": [{ "slot": "referee1", "name": "Muster Anna", "approved_at": "…", "short_id": "6F1C2A9B", "result_matches": true }]
```
These are active approvals only, fetched in one extra query per page, with `WHERE match_id = ANY($1)`.

**`GET /api/admin/audit`** is unchanged. The new actions appear with their details.

### 3.4 Error codes (new ones in bold)

| Status | Code | When |
|---|---|---|
| 400 | `OV_INVALID_REQUEST` | Bad body or query |
| 400 | **`OV_APPROVAL_PIN_FORMAT`** | The PIN to set, or the PIN sent to approve, is not 4–6 digits |
| 400 | **`OV_APPROVAL_PIN_WEAK`** | The PIN to set is too easy to guess (R3) |
| 403 | **`OV_PASSWORD_INVALID`** | Wrong password on set or remove PIN |
| 403 | **`OV_APPROVAL_PIN_INVALID`** | Email or PIN not accepted (uniform) |
| 403 | **`OV_APPROVAL_ROLE_REQUIRED`** | The approver lacks the slot's role, or the PIN setter has neither role |
| 403 | **`OV_APPROVAL_NOT_MATCH_SCORER`** | Scorer slot, but the approver is not the owner or an editor |
| 403 | **`OV_APPROVAL_SCORER_NOT_REFEREE`** | Referee slot, but the approver is the owner, an editor or the caller (R1) |
| 403 | **`OV_APPROVAL_CALLER_ROLE`** | The caller has neither the scorer nor the referee role and is not an admin (R2) |
| 403 | `OV_NOT_MATCH_OWNER` | The caller may not write this match |
| 403 | `OV_FORBIDDEN` | GET or undo by someone else |
| 404 | `OV_NOT_FOUND` | Unknown match or approval |
| 409 | `OV_MATCH_CLOSED` | The match is closed |
| 409 | **`OV_MATCH_NOT_ENDED`** | The server's status is not `ended` |
| 409 | **`OV_RESULT_NOT_SYNCED`** | The server's sets differ from the client's |
| 409 | `OV_EMAIL_UNCONFIRMED` | The approver or setter has not confirmed their address |
| 409 | **`OV_APPROVAL_NAME_REQUIRED`** | The approver's profile has no name |
| 409 | **`OV_APPROVAL_ONE_SLOT`** | The approver already holds another slot of this match |
| 409 | **`OV_APPROVAL_SLOT_TAKEN`** | The slot already has a valid approval by someone else |
| 409 | **`OV_APPROVAL_UNSUPPORTED`** | Beach match, on a module without `beachApprovals` (not the server) |
| 423 | ~~`OV_APPROVAL_PIN_LOCKED`~~ | No longer sent (R5) |
| 429 | `OV_TOO_MANY_ATTEMPTS` | Limiter or password lockout |
| 503 | **`OV_APPROVAL_UNAVAILABLE`** | No `OV_PIN_SECRET` |
| 503 | `OV_DB_UNAVAILABLE`, `OV_DB_NOT_CONFIGURED`, `auth_busy` | As today |

---

## 4. Frontend

Follow the volleyui design language (`~/.claude/skills/volleyui/SKILL.md`): the `src/ui` kit,
sentence case, h-11 courtside targets, the emerald done state as in `SignatureBox`.

- Use `askConfirm` and `askText` (never `window.confirm` or `window.prompt`). Never use `askText` for a password or PIN.
- Every new overlay uses `backdropDismiss` (`src/ui/__tests__/backdropGuard.test.js` enforces it).
- Every string goes into `en`, `de`, `de-CH`, `fr` and `it`, checked by `npm run check:i18n`. de-CH follows the surrounding section: `matchEnd.*` and `auth.*` are in dialect ("Underschrifte", "Profil speichere"), while `manage.*` is standard German.
- A PIN value is never passed to `cLogger`, `console`, `comprehensiveLogger`, Dexie, `localStorage` or `sessionStorage`. Clear it from state as soon as the request settles.

### 4.1 API client: `src/lib/accountApi.js`

```js
export const approvalPinApi = {
  status()                    { return apiRequest('GET',  '/api/account/approval-pin') },
  set({ password, pin })      { return apiRequest('POST', '/api/account/approval-pin', { password, pin }) },
  remove({ password })        { return apiRequest('POST', '/api/account/approval-pin/remove', { password }) }
}
export const approvalsApi = {
  approve({ external_id, slot, email, pin, result, device_id }) { return apiRequest('POST', '/api/approvals', { external_id, slot, email, pin, result, device_id }) },
  list(external_id)           { return apiRequest('GET', `/api/approvals?external_id=${enc(external_id)}`) },
  undo(id)                    { return apiRequest('DELETE', `/api/approvals/${enc(id)}`) }
}
// admin.listApprovals({ q, include_revoked, limit }) -> GET /api/admin/approvals
```

`errorKeyOf` maps every new code in 3.4 to `approval.errors.<camelCase>`, for example
`OV_APPROVAL_PIN_INVALID` → `approval.errors.pinInvalid`. `OV_PASSWORD_INVALID` maps to
`approval.errors.passwordInvalid`. The map comes before the generic 401/403 fallback.

### 4.2 Pure domain: `src/domain/accountApproval.js` (tested without React)

- `ROLE_TO_SLOT = { ref1: 'referee1', ref2: 'referee2', scorer: 'scorer' }` and `APPROVAL_ROLES = ['scorer', 'ref2', 'ref1']`.
- `resultKey(sets)` is the exact 1.4 string, from finished sets sorted by `index`.
- `approvalFor(match, role)` returns `match.accountApprovals?.[ROLE_TO_SLOT[role]] ?? null`.
- `isApprovalValid(approval, sets)` is true when `approval.result_key === resultKey(sets)`.
- `slotComplete(match, role, sets)` is true when the drawn signature field exists or `isApprovalValid(approvalFor(match, role), sets)`. For `asst-scorer` and the captains it is the signature only.
- `formatApprovalStamp(approval, { timeZone = 'Europe/Zurich' })` returns `"Approved electronically · <name> · dd.mm.yyyy hh:mm · ID <short_id>"`. The text is English because the PDF sheet is English, and the time is 24 h.
- `isWeakPin(pin)` and `PIN_RE` mirror the server, for inline validation.
- `deviceId()` reads or creates `localStorage['ov.deviceId']` (a uuid, try/catch). It returns null when storage is unavailable.
- `rememberApprovalEmail(officialName, email)` and `recallApprovalEmail(officialName)` keep a per-device map in `localStorage['ov.approvalEmails']`, keyed by the lower-cased "last first" name, at most 50 entries, LRU, try/catch. This is a convenience only. **Never** write emails into `match.officials`: officials sync to `matches.officials`, which referee and bench tokens can read.

`clearedPostMatchSignatures()` in `src/domain/matchEnd.js` also returns `accountApprovals: null`,
so every reopen path clears them locally. The server voids them through the trigger in 1.5.

### 4.3 Dexie

Add the field `accountApprovals` on the `matches` row:
`{ referee1?: Record, referee2?: Record, scorer?: Record }`, where `Record` is the 3.2 record. It
is not indexed, so there is **no new Dexie version**. Because the field lives on the match row,
it survives reloads. Backups (`backupManager`) carry it unchanged, and it holds no secrets.

**Sync model.** An approval is an online action, and the server row is the truth.

1. On MatchEnd mount, and on every `online` event while unapproved, when the match has a `seed_key`, the user is signed in and the browser is online: call `approvalsApi.list(seed_key)` and **replace** `accountApprovals` with the server's active records, keyed by slot. The failures:
   - 404 or 403: leave the field alone.
   - 503 `OV_APPROVAL_UNAVAILABLE` or `OV_DB_NOT_CONFIGURED`: hide the feature for this session.
   - Network error: keep the local copy.
2. After a successful approve or undo, write the returned record (or remove it) in Dexie at once.
3. In `handleApprove`, the `approval` JSON in the sync-queue payload gains `accounts: { ref1, ref2, scorer }`. Each entry is `{ short_id, name, approved_at }` or null. No user ids or emails go in, and the signature images stay as they are.
4. Before `handleApprove` runs while online with at least one account approval: call `list()` once more. If an approval was voided or no longer matches the result, show `approval.revalidateFailed` and stop. Offline, the local copy is trusted, because the approvals were made online and the server will reject nothing at close time.

### 4.4 Profile: "Approval PIN" section (`src/components/auth/ApprovalPinSection.jsx`)

The section goes in `ProfileModal.jsx` between "Role" and the personal info. It is shown only
when `access.roles` includes `referee` or `scorer`, the app is in cloud mode, and
`approvalPinApi.status()` returns `available: true`. It loads status on open. Offline it shows
the cached status with a "Needs internet" hint and disabled buttons.

- **Title** `approval.pin.title` ("Approval PIN"). **Explainer** `approval.pin.explainer`: "Approve match results with your account instead of a drawn signature. Your personal PIN, not a match PIN. Never share it."
- **Status line**:
  - `approval.pin.notSet` ("Not set")
  - `approval.pin.setOn` ("Set on {{date}}")
  - `approval.pin.lockedUntil` ("Locked until {{time}}", amber)
  - `approval.pin.disabled` ("Blocked after too many wrong PINs. Set a new one.", red)
  - `approval.pin.ineligible` when `eligible` is false ("Confirm your email address first" or "Needs the referee or scorer role")
- **Buttons**: "Set PIN" or "Change PIN" (primary) and "Remove PIN" (secondary, only when set).
- **Dialog** (ui `Modal`, `backdropDismiss`):
  - **Set or change:** fields current password (`type=password`, `autocomplete=current-password`), new PIN and repeat PIN. Both PIN fields use `type=password`, `inputMode=numeric`, `pattern="[0-9]*"`, `maxLength=6` and `autocomplete=off`.
  - **Remove:** only the password field, then `askConfirm` (tone danger) before sending.
  - Inline validation uses `PIN_RE`, `isWeakPin` and a match check.
  - Server errors appear inline through `errorKeyOf`.
  - On success, show a toast `approval.pin.saved` or `approval.pin.removed`, close the dialog and refresh the status.

### 4.5 MatchEnd

Only `scorer`, `ref2` and `ref1` change. Captains and the assistant scorer stay as they are.

- **`SignatureBox`.** When `approvalFor(match, role)` exists:
  - **Valid:** the emerald done state with a check icon. Line 1 reads `approval.done` ("Approved electronically"). Line 2 reads `name · dd.mm.yyyy hh:mm · ID XXXXXXXX`. The tap-to-sign does nothing. An "Undo" `RowTool` uses `askConfirm` (`approval.undoConfirm`, tone danger), then `approvalsApi.undo(id)`. Undo needs the server, so it is disabled offline with the tooltip `approval.needsInternet`.
  - **Stale** (`!isApprovalValid`): an amber box `approval.stale` ("Result changed. Approve again or sign"). The slot is incomplete, and both actions are available. Approving again replaces the stale row on the server (3.2 step 11).
- **"Approve with account" action.** It sits under each of the three boxes (ui `Button` `variant="secondary"`, h-11, full width of the box column):
  - **Hidden** when: a drawn signature exists; there is no `seed_key`, no session, or the feature is unavailable; or the match is beach.
  - **Disabled** under the same gating as drawing (`disabled` prop of the box).
  - **Disabled offline**, labelled `approval.needsInternetSignByHand` ("Needs internet: sign by hand").
  - **Re-enabled** on the `online` event.
- **Approve dialog** (`src/components/AccountApprovalDialog.jsx`, ui `Modal` + `backdropDismiss`):
  - **Title:** `approval.dialogTitle` ("Approve as {{role}}").
  - **Name hint:** the name entered for that official in `match.officials`.
  - **Email field** (`type=email`, `autocomplete=off`, `autoCapitalize=none`). It is prefilled, in order, from:
    1. the official entry's `email` (forward-compatible; nothing writes one today);
    2. for the scorer slot, the signed-in user's email;
    3. `recallApprovalEmail(official name)`;
    4. otherwise empty.
  - **PIN field** with the same attributes as 4.4. The hint `approval.pinHint` reads "The official types their own approval PIN. It is set in their profile."
  - **Submit:** `approval.approve` ("Approve"). Nothing auto-submits.
  - **On submit:**
    1. If `db.sync_queue` has jobs for this match that are not done, show `approval.syncing` ("Sending the result…"), dispatch `sync-queue-write` and wait until the jobs are done, for at most 10 s. After that, show the `approval.errors.resultNotSynced` text and stop.
    2. Send `{ external_id: seed_key, slot, email, pin, result: { sets: finished sets as [index, homePoints, awayPoints] }, device_id: deviceId() }`.
    3. On 200: write Dexie, call `rememberApprovalEmail` (not for the scorer slot), show the toast `approval.approved`, close the dialog and clear the PIN.
    4. On `OV_RESULT_NOT_SYNCED`: retry steps 1–2 once, then show the error.
    5. (Removed by R5: a locked PIN reads as `approval.errors.pinInvalid`, whose text says that the PIN pauses after several wrong tries.)
    6. Other errors appear inline through `errorKeyOf`. Clear the PIN field on every error.
  - **Name mismatch:** if the account's `name` in the response differs from the officials entry (case- and accent-insensitive, order-insensitive), show a non-blocking notice `approval.nameDiffers` ("Account name {{account}} differs from the official entered ({{entered}})").
- **Gating and order.** `scorerSigned`, `ref2Signed`, `ref1Signed` and therefore `currentStep` and `allSignaturesDone` use `slotComplete(...)`. The signing order (captains → assistant scorer → scorer → 2nd referee → 1st referee) is unchanged and applies to both methods. The server does not enforce the order.
- **Reopen paths** (reopen last set, admin reopen; "Reopen match" keeps them, R9) clear `accountApprovals` through `clearedPostMatchSignatures()`. When the match is not closed and the app is online, they also call `undo` on each local approval, best effort. Otherwise the server trigger voids them once the status change syncs.

### 4.6 PDF (`scoresheet_pdf/components/FooterSection.tsx` `Approvals`)

In the signature cell for "1st Referee", "2nd Referee" and "Scorer":

- If a drawn signature image exists, show it, exactly as today.
- Otherwise, if `isApprovalValid(match.accountApprovals?.[slot], sets)`, show the text `formatApprovalStamp(record)`: no image, `text-[6px] leading-[7px] text-black`, left-aligned, at most two lines (the browser may wrap at " · "), clipped by `overflow-hidden` inside the 20 px cell.
- Otherwise the cell stays empty.

The "Assistant Scorer" row and the captain boxes do not change. The sets come from the PDF's
existing data (sessionStorage `scoresheetData` or Dexie), so a stale approval never prints.

### 4.7 Manager console

- **`ClosedMatchesPanel` and `OfficialGamesPanel`.** For each row with `approvals`, add one `Chip` per approval: "`<slot label>` · `<name>`" (`manage.approvals.chip`), plus a tooltip with the time and "ID". A stale one (`result_matches: false`) uses the amber tone and a "Result changed" suffix.
- **`AuditPanel`.** Action labels go under `manage.audit.actions`: `approval_pin_set`, `approval_pin_remove`, `approval_pin_locked`, `match_approve`, `match_approval_revoke` and `match_approval_void`. The detail line for the `match.approv*` actions is "`<slot label>` · ID `<short_id>`" plus the reason when present. For `approval_pin_locked` it is "`{{failures}}` wrong PINs" plus "blocked" when disabled.
- **"Approvals" lookup.** A small search field sits at the top of `ClosedMatchesPanel` (`manage.approvals.lookup`, placeholder "Approval ID or game number"). It calls `admin.listApprovals` and lists the admin records in a `RowList`: slot, name, email, time, match, revoked state and the hash prefixes. No new tab.

### 4.8 i18n keys (all five locales)

- New namespace `approval`: `pin.*`, `dialogTitle`, `pinHint`, `approve`, `approved`, `done`, `stale`, `undo`, `undoConfirm`, `undone`, `needsInternet`, `needsInternetSignByHand`, `syncing`, `nameDiffers` and `revalidateFailed`. Errors live under `errors.*`: `pinInvalid`, `pinLocked`, `pinDisabled`, `pinFormat`, `pinWeak`, `passwordInvalid`, `roleRequired`, `notMatchScorer`, `nameRequired`, `oneSlot`, `slotTaken`, `matchClosed`, `matchNotEnded`, `resultNotSynced`, `unsupported`, `unavailable` and `emailUnconfirmed`.
- Additions to existing namespaces: `manage.approvals.*` and `manage.audit.actions.*` (4.7).
- The `approval.*` strings use dialect in de-CH, like `matchEnd`. The `manage.*` strings use standard German, like the rest of `manage`.

---

## 5. Implementation order and ownership

| Step | Backend agent | Frontend agent |
|---|---|---|
| 1 | `db/011`, `roles.sql`, `lib/approvalPin.js` with its unit tests | `domain/accountApproval.js` with tests, and the `accountApi.js` additions (stubbed against 3.x) |
| 2 | `lib/approvals.js`, `auth.verifyPassword`, the manage routes, `server.js` families and limits | ProfileModal section, `AccountApprovalDialog`, MatchEnd wiring |
| 3 | `listMatches`/`listOfficialGames` attachments, `/api/admin/approvals`, the audit actions | PDF stamp, manager chips, lookup, audit labels, i18n |
| 4 | pg and e2e tests (6.1) | vitest (6.2), `npm run check:i18n`, `npm run build` |

Neither agent edits the other's tree. Any change to section 3 needs an edit of this document,
committed before the code that depends on it. Each agent commits its own paths only, and every
commit message ends with:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Tf9Me5uXmbq7Y9pLyiVvbq
```

## 6. Tests

### 6.1 Backend (`node --test`, pg tests against the throwaway container, `OV_PIN_SECRET` ≥ 40 characters)

- **`tests/approvalPin.test.js`** (pure):
  - Both test vectors (1.1 and 1.4) and the IP hash vector (1.3).
  - `isWeakPin` truth table: weak `0000`, `1234`, `0123`, `9876`, `123456`, `111111`, and since R3 `1212`, `1984`, `1004`, `2580`, `123123`, `150390`; fine `482917`, `4738`.
  - `PIN_RE` rejects `123`, `1234567`, `12a4` and ` 1234`.
  - `verifyPin` is true only for the right PIN and user, and false with a changed salt, a different user id or an old `key_id`.
  - The unknown-user path calls the HMAC exactly once (spy).
- **`tests/migration011.pg.test.js`**: everything in 1.6.
- **`tests/approvals.pg.test.js`** (handler level, against a real pool):
  - Set, change and remove PIN: password required, wrong password gives 403 and counts in the email lockout, format and weak checks, the unconfirmed and role gates, idempotent remove, and the audit rows.
  - Approve, happy path, for all three slots. The record shape has no `user_id` or email keys (assert on the JSON keys).
  - Every error in the 3.2 order, including that a wrong PIN for an ineligible account answers `PIN_INVALID`, not `ROLE_REQUIRED`, and that an unknown email gives the same answer as a wrong PIN.
  - Lockout: after 5 wrong PINs the PIN is locked; the answer stays 403 `OV_APPROVAL_PIN_INVALID` (R5) and the 6th attempt is not counted. After the lock expires (move the clock with `UPDATE locked_until`), 5 more wrong PINs set `disabled`. A correct PIN keeps the count; 30 quiet days restart it (R4). The counter persists even though the handler returned an error (committed). The `approval_pin.locked` audit row exists.
  - One slot per user; slot taken; an idempotent retry returns `already: true` with no second audit row.
  - Stale replacement: change the set points with `UPDATE sets`, approve again, and check that the old row has `result_changed`.
  - `OV_RESULT_NOT_SYNCED` with the server sets in `details`.
  - Scorer slot by a non-editor gives 403 `OV_APPROVAL_NOT_MATCH_SCORER`. By an editor added through `match_editors` it works.
  - Closed match: approve and undo both give 409.
  - Admin reopen voids the approvals, and the reopened match takes new ones.
  - Undo by the approver, by the owner and by a stranger (403). Undo twice gives `already: true`.
  - GET visibility for the owner, editor, admin, the approver (own record only) and a stranger (403).
  - Parallel approves of the same slot by two users (`Promise.all`): exactly one 200 and one 409.
  - Deleting the approver account keeps the row with its name and `user_id` NULL. Account deletion still succeeds.
- **`tests/accountApproval.e2e.test.js`** (real server, `OV_E2E_DOCKER=1`):
  - Full HTTP flow with the rate limits: the 11th wrong PIN from one caller gets 429, and a success refunds.
  - `GET /api/approvals?…` is not swallowed by the relay route.
  - `/api/db` cannot select `match_approvals` (not allowlisted) and live sockets never carry it.
  - **Secret hygiene:** run a set-PIN, a wrong-PIN approve and a successful approve with marker values (PIN `804613`, password `Pw-marker-7c1e`), collect the server's stdout and stderr, and assert that neither marker appears. The audit `details` contain neither marker either.
  - Without `OV_PIN_SECRET` every endpoint answers 503 `OV_APPROVAL_UNAVAILABLE` and GET status gives `available: false`.
- Extend `tests/accounts.pg.test.js`: `listMatches` and `listOfficialGames` carry `approvals`, and `AUDIT_ACTIONS` has the new entries.

### 6.2 Frontend (vitest)

- **`src/domain/__tests__/accountApproval.test.js`**: the `resultKey` vector from 1.4 with unsorted and unfinished sets, `slotComplete` (signature only, approval only, stale approval, both), `formatApprovalStamp` in Europe/Zurich (summer and winter), `isWeakPin` parity with the server table, and the email-memory LRU when storage throws.
- **`matchEnd.test.js`**: `clearedPostMatchSignatures()` includes `accountApprovals: null`.
- **`src/components/__tests__/MatchEndAccountApproval.test.jsx`**, with `approvalsApi` mocked:
  - The action is shown only on scorer, ref2 and ref1, and is hidden when a drawn signature exists.
  - Offline, the button is disabled with the sign-by-hand label, and it re-enables on `online`.
  - A successful approve writes Dexie, and the Confirm button enables once all slots are complete (mixing a drawn ref2 with an account ref1).
  - The PIN never reaches `cLogger` or `console` (spy), and the field clears after an error.
  - A stale approval shows the amber state and blocks Confirm.
  - Undo uses `askConfirm`.
  - On mount, `list()` replaces the local approvals.
- **`ProfileApprovalPin.test.jsx`**: visibility by role and availability, set, change and remove with mocked errors, and that the password is required.
- **`scoresheet_pdf/__tests__`**: the Approvals cell prints the stamp for a valid approval, the image when both exist, and nothing for a stale one.
- Manage panel tests: the chips render and the lookup calls `admin.listApprovals`.
- `backdropGuard.test.js` and `noNativeDialogs.test.jsx` pass without exceptions, `npm run check:i18n` passes, and `npm run build` completes.

## 7. Deploy notes (for the owner; not part of this branch's work)

1. Back up the database, then run `db/011_account_approvals.sql` and `roles.sql` as ov_owner. The backend version that ships the endpoints can come later. 011 is safe under the running backend.
2. `OV_PIN_SECRET` must already be set (it is, for match PINs). Rotating it invalidates every approval PIN. Users then set new ones with their password, and the existing approvals stay valid, because the PIN only gates new approvals.
3. Nothing changes for matches without account approvals. Drawn signatures work as before, offline included.
