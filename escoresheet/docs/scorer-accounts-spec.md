# Scorer accounts, official games, locked closing, admin and saved teams: implementation spec

Status: approved by the owner ("i approve, do all"). Branch `feat/scorer-accounts`, based on
`feat/selfhost-postgres`. This document is the contract between the backend agent (owns
`escoresheet/backend/**`, `escoresheet/deploy/**`) and the frontend agent (owns
`escoresheet/frontend/**`). They work in parallel. Neither changes the other's tree. The
API in section 5 is the interface: paths, methods, bodies, responses and error codes are
exact. The frontend can build against stubs until the backend lands.

The production rules still apply. Never write to production (Hetzner, Cloudflare, live URLs).
Don't push, tag or deploy. Run backend tests only against a throwaway `postgres:17` container
(tmpfs, `--rm`, random port).

---

## 0. Summary of the owner decisions → design

| # | Decision | Design in one line |
|---|---|---|
| 1 | Approved scorers only | New accounts get `roles = {}` (pending). Scorer via admin approval or invite code. pgQuery's ownership guard gains `testOnly`: a non-scorer may write only `test = true` matches and their children (403 `OV_SCORER_REQUIRED`). |
| 2 | One cloud match per official game | Partial unique **expression index** on `(beach?, game_n, season)` plus a friendly server pre-check that returns 409 `OV_GAME_TAKEN` with the claimant's display name and match status. Pre-existing duplicates are exempted and reported, not failed. |
| 3 | Closing is locked on the server | DB triggers stamp `closed_at`/`closed_by` when a non-test match first reaches `approved`/`final`. From then on, the match, its sets and its events are read-only (SQLSTATE `OVC01` → 409 `OV_MATCH_CLOSED`). Only `POST /api/admin/matches/:id/reopen` lifts it (audit-logged). The client reopen password is removed. |
| 4 | Admin page | One in-app `ManageConsole` (volleyui `ConsoleShell`) with tabs for accounts, invite codes, official games, closed matches, audit log and saved teams. Every action is enforced by `/api/admin/*`. |
| 5 | Competition manager / saved teams | New tables `competitions`, `competition_teams`, `competition_players`, `competition_staff`, served by `/api/saved-teams*` only. They are never on the `/api/db` allowlist and never anonymous. Scorers read; admins and `competition_manager` write. MatchSetup gets "Load saved team", automatic suggestions for schedule games, and "Save roster to team". There is an offline Dexie cache. |

---

## 1. Roles and access (shared definitions, both sides implement identically)

`profiles.roles` is `text[]`. Recognised values: `scorer`, `referee`, `competition_manager`,
`admin`, `super_admin`. Unknown values are kept but grant nothing. Values are normalised by
`String(r).trim().toLowerCase()`.

```
ADMIN_ROLES   = ['admin', 'super_admin']
isAdmin       = roles ∩ ADMIN_ROLES ≠ ∅
isSuperAdmin  = roles includes 'super_admin'
canScore      = isAdmin || roles includes 'scorer'            // may write NON-test matches
canManageTeams= isAdmin || roles includes 'competition_manager'
canReadTeams  = canScore || canManageTeams                    // GET /api/saved-teams
isPending     = no recognised role at all                     // "waiting for approval" UI
```

Rules:
- Roles never come from the client. Sign-up drops `roles`/`role` from the metadata (`strippedMetadataKeys`, unchanged), and `/api/db` drops `profiles.roles` (`WRITE_DENYLIST`, unchanged). The only writers are the admin roles endpoint, invite redemption and SQL.
- `lib/auth.js`: `DEFAULTS.defaultRoles` changes from `['scorer']` to `[]`. Migration 007 also sets the column default to `'{}'` and **does not touch any existing row's roles**.
- Admins and super_admins bypass the approval rule (1). The one-match-per-game rule (2) applies to everyone. It is data integrity, and admins resolve conflicts with "release game". The closed-match lock (3) applies to everyone, and admins lift it only through the reopen endpoint.
- Role changes through the API: an admin may add or remove `scorer`, `referee`, `competition_manager` and `admin`. `super_admin` is never granted or removed through the API (SQL only). Only a super_admin may change the roles of an account that holds `super_admin`. Nobody may remove `admin` from their own account (409 `OV_SELF_DEMOTE`).

---

## 2. The official-game identity key (decision 2)

**Key = (is beach, `game_n`, season)**, where
`season = year(kick-off in Europe/Zurich) − (month < 7 ? 1 : 0)`, and kick-off is
`coalesce(scheduled_at, created_at)`. The key applies to rows with `test IS NOT TRUE AND game_n > 0 AND NOT official_game_exempt`.

Why this key, from the code:
- `svrz_games.game_number` is `UNIQUE` and `lib/vmSync.js` upserts `ON CONFLICT (game_number)`. VolleyManager keeps one row per number, and next season's game with the same number overwrites it. Numbers are therefore unique within a season, not forever. **`game_n` alone would block a legitimate game in a later season**, so it is not used alone.
- `matches.external_id` is the device's `seed_key` (`match_<ts>_<rand>`). Every device and every new setup makes a new one, so it cannot identify a game. That is exactly the duplicate we want to stop.
- An exact `scheduled_at` or date is too narrow. A rescheduled game (VM moves the date, or the scorer types the date wrong) would then be claimable twice. The season bucket tolerates rescheduling but separates seasons.
- League text is not used. `match_info.league` is free text, blank for manually typed games, and a league's name can change. Game numbers are global within a season in VolleyManager.
- `sport_type` separates beach from indoor numbering. The production column is the enum `public.sport_type`, and a cast of an enum to text is not IMMUTABLE. The index therefore uses `(sport_type IS NOT DISTINCT FROM 'beach')`, with NULL counted as indoor.
- The season expression is **inlined in the index**. It is not a SQL function: verified on postgres:17 that a function in an index expression needs `EXECUTE` for `ov_app` at INSERT time, and `roles.sql` revokes `EXECUTE` on every function.
- Matches without `game_n` (friendlies) are not protected. That is accepted (risk R3).

The same expression is used in three places and must stay identical:
1. `db/007` (index plus duplicate scan).
2. `backend/lib/officialGame.js` exports `SEASON_SQL(expr)`, which returns the SQL text of the season of a `timestamptz` expression, and `seasonOf(dateLike) → int` in JS, computed with `Intl.DateTimeFormat('en-CH', { timeZone: 'Europe/Zurich', year: 'numeric', month: 'numeric' })`.
3. `frontend/src/domain/season.js` exports `seasonOf(dateLike)` and `seasonLabel(season)`. `seasonLabel(2026)` is `'2026/27'`, which matches `competitions.season`.

---

## 3. Migration `escoresheet/backend/db/007_scorer_accounts.sql` (exact text)

> **After review the file in the repository is the reference, not this copy.** It
> adds two things below: `ov_matches_guard` ends an exemption when the match's
> official-game key changes, and `match_live_state_closed_guard` locks the live
> state of a closed match.

Copy it verbatim. It was verified on postgres:17-alpine against `tests/fixtures/synthetic_schema.sql` + 005 + 006:
- It runs twice without errors.
- `roles.sql` runs afterwards fine.
- Duplicates are exempted with NOTICEs.
- `updated_at` of backfilled rows does not move.
- `ov_app` (no function EXECUTE) can insert and update, and the index rejects a second claim in the same season but accepts the next season.
- Closed rows refuse changes, children and deletes. Approved → final, no-op rewrites and account deletion (FK SET NULL of `created_by`/`closed_by`) pass.
- `ov.allow_closed` reopens.
- An upsert logs exactly one `match.close` audit row.

```sql
-- 007_scorer_accounts.sql: approved scorers, one cloud match per official
-- game, server-locked closing, invite codes, audit log, saved teams.
--
-- Run as ov_owner after 006 (restore.sh runs every db/NNN_*.sql with
-- NNN >= 003 in numeric order), then roles.sql. Idempotent. One transaction.
-- Never changes profiles.roles of an existing account.

BEGIN;
SET LOCAL timezone TO 'UTC';

-- 1. New accounts get no role -------------------------------------------------
-- lib/auth.js writes roles explicitly (defaultRoles: []); this only changes
-- the column default, no existing row is touched.
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'roles') = 'ARRAY' THEN
    ALTER TABLE public.profiles ALTER COLUMN roles SET DEFAULT '{}'::text[];
  ELSE
    RAISE NOTICE '007: public.profiles.roles is not text[]; its default was left alone';
  END IF;
END $$;

-- 2. matches: closing and official-game columns -------------------------------
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS closed_by uuid;
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS official_game_exempt boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'matches_closed_by_fkey' AND conrelid = 'public.matches'::regclass) THEN
    ALTER TABLE public.matches
      ADD CONSTRAINT matches_closed_by_fkey FOREIGN KEY (closed_by)
      REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Matches already approved/final are closed from now on (closed_by unknown:
-- the creator when there is one). The backfill and the duplicate exemption
-- below run with the user triggers of matches off (006's updated_at trigger,
-- and on a re-run the guard of step 5), so no row's updated_at moves.
ALTER TABLE public.matches DISABLE TRIGGER USER;
UPDATE public.matches
   SET closed_at = coalesce(updated_at, created_at, now()),
       closed_by = created_by
 WHERE closed_at IS NULL
   AND test IS NOT TRUE
   AND status IN ('approved', 'final');

-- 3. One cloud match per official game ----------------------------------------
-- Key: (beach or not, game number, season). (A cast of the sport_type enum
-- to text is not IMMUTABLE, so the index compares it with 'beach' instead;
-- NULL counts as indoor.) VolleyManager game numbers are only
-- unique within a season (svrz_games keeps one row per number and the next
-- season's game overwrites it), so game_n alone would block a later season.
-- Season = the Europe/Zurich year of the kick-off, minus one before July
-- (2026-08 .. 2027-06 is season 2026). A match without scheduled_at counts in
-- the season it was created in. The expression is inlined (no SQL function):
-- a function in an index expression needs EXECUTE for ov_app, which roles.sql
-- revokes from every function.
-- Pre-existing duplicates do not fail the migration: the first created match
-- of each key keeps the claim, the others get official_game_exempt = true and
-- are reported.
DO $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN
    WITH k AS (
      SELECT id, external_id, game_n, status, created_at,
             CASE WHEN sport_type IS NOT DISTINCT FROM 'beach' THEN 'beach' ELSE 'indoor' END AS sport,
             (date_part('year', (coalesce(scheduled_at, created_at) AT TIME ZONE 'Europe/Zurich'))::int
               - CASE WHEN date_part('month', (coalesce(scheduled_at, created_at) AT TIME ZONE 'Europe/Zurich')) < 7 THEN 1 ELSE 0 END) AS season,
             row_number() OVER (
               PARTITION BY (sport_type IS NOT DISTINCT FROM 'beach'), game_n,
                 (date_part('year', (coalesce(scheduled_at, created_at) AT TIME ZONE 'Europe/Zurich'))::int
                   - CASE WHEN date_part('month', (coalesce(scheduled_at, created_at) AT TIME ZONE 'Europe/Zurich')) < 7 THEN 1 ELSE 0 END)
               ORDER BY created_at NULLS LAST, id) AS rn
        FROM public.matches
       WHERE test IS NOT TRUE AND game_n IS NOT NULL AND game_n > 0 AND NOT official_game_exempt
    )
    SELECT * FROM k WHERE rn > 1
  LOOP
    UPDATE public.matches SET official_game_exempt = true WHERE id = r.id;
    n := n + 1;
    RAISE NOTICE '007: duplicate official game % (%, season %): match % (external_id %, status %) exempted, the first created match keeps the claim',
      r.game_n, r.sport, r.season, r.id, r.external_id, r.status;
  END LOOP;
  IF n > 0 THEN
    RAISE NOTICE '007: % duplicate official-game match(es) exempted; review them in the admin page (Official games)', n;
  END IF;
END $$;

ALTER TABLE public.matches ENABLE TRIGGER USER;

CREATE UNIQUE INDEX IF NOT EXISTS matches_official_game_uidx ON public.matches (
  (sport_type IS NOT DISTINCT FROM 'beach'),
  game_n,
  ((date_part('year', (coalesce(scheduled_at, created_at) AT TIME ZONE 'Europe/Zurich'))::int
    - CASE WHEN date_part('month', (coalesce(scheduled_at, created_at) AT TIME ZONE 'Europe/Zurich')) < 7 THEN 1 ELSE 0 END))
) WHERE test IS NOT TRUE AND game_n IS NOT NULL AND game_n > 0 AND NOT official_game_exempt;

-- 4. Audit log ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.audit_log (
  id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at             timestamptz NOT NULL DEFAULT now(),
  actor_id       uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  action         text        NOT NULL,
  target_user_id uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  match_id       uuid,       -- no FK: the entry outlives the match
  details        jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON public.audit_log (at DESC);
CREATE INDEX IF NOT EXISTS audit_log_action_at_idx ON public.audit_log (action, at DESC);

-- 5. Closed matches are read-only -----------------------------------------------
-- ov.user_id      the acting account (pgQuery/matchRestore set it with
--                 set_config(..., true) in the write's transaction)
-- ov.allow_closed 'on' only inside the admin reopen endpoint
-- SQLSTATE OVC01  -> lib/pgQuery.js maps it to 409 OV_MATCH_CLOSED
CREATE OR REPLACE FUNCTION public.ov_matches_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  allow boolean := coalesce(current_setting('ov.allow_closed', true), '') = 'on';
  actor uuid := nullif(current_setting('ov.user_id', true), '')::uuid;
  skip text[] := ARRAY['updated_at', 'status', 'created_by', 'closed_by'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.closed_at IS NOT NULL AND NOT allow THEN
      RAISE EXCEPTION 'match is closed' USING ERRCODE = 'OVC01';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.closed_at IS NOT NULL AND NOT allow THEN
      -- Allowed on a closed match: a no-op rewrite (a resent job), approved ->
      -- final, and the ON DELETE SET NULL of created_by / closed_by.
      IF (to_jsonb(NEW) - skip) IS DISTINCT FROM (to_jsonb(OLD) - skip)
         OR (NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'approved' AND NEW.status = 'final'))
         OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL)
         OR (NEW.closed_by IS DISTINCT FROM OLD.closed_by AND NEW.closed_by IS NOT NULL) THEN
        RAISE EXCEPTION 'match is closed' USING ERRCODE = 'OVC01';
      END IF;
      RETURN NEW;
    END IF;
    IF NOT allow THEN
      -- closed_at / closed_by are the server's (a client value is ignored)
      NEW.closed_at := OLD.closed_at;
      IF NEW.closed_by IS NOT NULL THEN NEW.closed_by := OLD.closed_by; END IF;
    END IF;
  ELSE -- INSERT
    IF NOT allow THEN
      NEW.closed_at := NULL;
      NEW.closed_by := NULL;
    END IF;
  END IF;

  -- Closing: the first write that puts a non-test match into approved/final.
  IF NEW.closed_at IS NULL AND NEW.test IS NOT TRUE AND NEW.status IN ('approved', 'final') THEN
    NEW.closed_at := now();
    NEW.closed_by := actor;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS matches_guard ON public.matches;
CREATE TRIGGER matches_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.matches
  FOR EACH ROW EXECUTE FUNCTION public.ov_matches_guard();

-- The audit entry of a close. AFTER, not in the BEFORE trigger: an upsert
-- fires BEFORE INSERT for its proposed row even when it ends as an UPDATE.
CREATE OR REPLACE FUNCTION public.ov_matches_close_audit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.closed_at IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.closed_at IS NULL) THEN
    INSERT INTO public.audit_log (actor_id, action, match_id, details)
    VALUES (NEW.closed_by, 'match.close', NEW.id,
            jsonb_build_object('external_id', NEW.external_id, 'game_n', NEW.game_n, 'status', NEW.status));
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS matches_close_audit ON public.matches;
CREATE TRIGGER matches_close_audit
  AFTER INSERT OR UPDATE ON public.matches
  FOR EACH ROW EXECUTE FUNCTION public.ov_matches_close_audit();

CREATE OR REPLACE FUNCTION public.ov_match_children_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF coalesce(current_setting('ov.allow_closed', true), '') = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF EXISTS (SELECT 1 FROM public.matches m
              WHERE m.closed_at IS NOT NULL
                AND m.id IN (CASE WHEN TG_OP <> 'INSERT' THEN OLD.match_id END,
                             CASE WHEN TG_OP <> 'DELETE' THEN NEW.match_id END)) THEN
    RAISE EXCEPTION 'match is closed' USING ERRCODE = 'OVC01';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

DROP TRIGGER IF EXISTS sets_closed_guard ON public.sets;
CREATE TRIGGER sets_closed_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.sets
  FOR EACH ROW EXECUTE FUNCTION public.ov_match_children_guard();
DROP TRIGGER IF EXISTS events_closed_guard ON public.events;
CREATE TRIGGER events_closed_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.ov_match_children_guard();

-- 6. Invite codes -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.invite_codes (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash   bytea       NOT NULL UNIQUE CHECK (octet_length(code_hash) = 32),
  code_hint   text        NOT NULL,                 -- last 4 characters, for the list
  label       text        NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  club        text        CHECK (club IS NULL OR length(club) <= 120),
  role        text        NOT NULL DEFAULT 'scorer' CHECK (role IN ('scorer', 'referee', 'competition_manager')),
  max_uses    integer     CHECK (max_uses IS NULL OR max_uses BETWEEN 1 AND 10000),
  uses        integer     NOT NULL DEFAULT 0 CHECK (uses >= 0),
  expires_at  timestamptz,
  revoked_at  timestamptz,
  created_by  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.invite_redemptions (
  invite_id   uuid        NOT NULL REFERENCES public.invite_codes(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  redeemed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (invite_id, user_id)
);
CREATE INDEX IF NOT EXISTS invite_redemptions_user_idx ON public.invite_redemptions (user_id);

-- 7. Saved teams (competition manager) ---------------------------------------------
CREATE TABLE IF NOT EXISTS public.competitions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  season      text        NOT NULL CHECK (season ~ '^\d{4}/\d{2}$'),        -- '2026/27'
  gender      text        CHECK (gender IN ('men', 'women', 'mixed')),
  category    text        CHECK (category IS NULL OR length(category) <= 60),
  vm_leagues  text[]      NOT NULL DEFAULT '{}',                             -- svrz_games.league values
  archived    boolean     NOT NULL DEFAULT false,
  created_by  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.competition_teams (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id  uuid        NOT NULL REFERENCES public.competitions(id) ON DELETE CASCADE,
  name            text        NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  short_name      text        CHECK (short_name IS NULL OR length(short_name) <= 20),
  club            text        CHECK (club IS NULL OR length(club) <= 120),
  color           text        CHECK (color IS NULL OR color ~ '^#[0-9a-fA-F]{6}$'),
  svrz_team_name  text        CHECK (svrz_team_name IS NULL OR length(svrz_team_name) <= 200),
  created_by      uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS competition_teams_name_uidx ON public.competition_teams (competition_id, lower(name));
CREATE INDEX IF NOT EXISTS competition_teams_svrz_idx ON public.competition_teams (lower(svrz_team_name));

CREATE TABLE IF NOT EXISTS public.competition_players (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id         uuid        NOT NULL REFERENCES public.competition_teams(id) ON DELETE CASCADE,
  number          integer     CHECK (number IS NULL OR number BETWEEN 0 AND 99),
  first_name      text        NOT NULL DEFAULT '' CHECK (length(first_name) <= 80),
  last_name       text        NOT NULL CHECK (length(last_name) BETWEEN 1 AND 80),
  dob             date,
  license_number  text        CHECK (license_number IS NULL OR length(license_number) <= 40),
  is_libero       boolean     NOT NULL DEFAULT false,
  is_captain      boolean     NOT NULL DEFAULT false,
  active          boolean     NOT NULL DEFAULT true,
  sort_order      integer     NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS competition_players_team_idx ON public.competition_players (team_id);

CREATE TABLE IF NOT EXISTS public.competition_staff (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id         uuid        NOT NULL REFERENCES public.competition_teams(id) ON DELETE CASCADE,
  role            text        NOT NULL CHECK (role IN ('Coach', 'Assistant Coach 1', 'Assistant Coach 2', 'Physiotherapist', 'Medic')),
  first_name      text        NOT NULL DEFAULT '' CHECK (length(first_name) <= 80),
  last_name       text        NOT NULL CHECK (length(last_name) BETWEEN 1 AND 80),
  dob             date,
  license_number  text        CHECK (license_number IS NULL OR length(license_number) <= 40),
  sort_order      integer     NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS competition_staff_team_idx ON public.competition_staff (team_id);

-- updated_at of competitions / teams follows every UPDATE (006's function)
DROP TRIGGER IF EXISTS competitions_touch_updated_at ON public.competitions;
CREATE TRIGGER competitions_touch_updated_at BEFORE UPDATE ON public.competitions
  FOR EACH ROW EXECUTE FUNCTION public.ov_touch_updated_at();
DROP TRIGGER IF EXISTS competition_teams_touch_updated_at ON public.competition_teams;
CREATE TRIGGER competition_teams_touch_updated_at BEFORE UPDATE ON public.competition_teams
  FOR EACH ROW EXECUTE FUNCTION public.ov_touch_updated_at();

-- Grants: roles.sql (run next) gives ov_app DML on every public table and
-- sequence; this covers running 007 after roles.sql.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ov_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.invite_codes, public.invite_redemptions, public.audit_log,
      public.competitions, public.competition_teams, public.competition_players, public.competition_staff TO ov_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ov_app;
  END IF;
END $$;

COMMIT;
```

Run order: `restore.sh` already runs every `db/NNN_*.sql` with NNN ≥ 003 in order, then `roles.sql`. Nothing else is needed (all new tables are in `public`, so `roles.sql` grants DML).
`tests/helpers/pgTestDb.js`: `MIGRATIONS_SQL` becomes `['005_match_ownership.sql', '006_matches_updated_at.sql', '007_scorer_accounts.sql']`. 007 depends on 006's `ov_touch_updated_at()`.

Session settings the triggers read:
- `ov.user_id`: set by pgQuery/matchRestore through `SELECT set_config('ov.user_id', $1, true)` in the write's transaction. The trigger records it as `closed_by`.
- `ov.allow_closed = 'on'`: set **only** by the admin reopen and release-game handlers, in their own transaction.

---

## 4. Backend enforcement points

### 4.1 New module `backend/lib/access.js`
```js
export const ADMIN_ROLES, KNOWN_ROLES, API_GRANTABLE_ROLES = ['scorer','referee','competition_manager','admin']
export function normalizeRoles(raw)            // text[] | JSON string | '{a,b}' string | null -> string[] (same parsing as server.js isAdminUser today)
export function accessFromRoles(roles)        // -> { roles, isAdmin, isSuperAdmin, canScore, canManageTeams, canReadTeams, isPending }
export function createAccessResolver({ pool, ttlMs = 30000, maxEntries = 5000 })
  // .get(userId) -> access  (SELECT roles FROM public.profiles WHERE user_id = $1 LIMIT 1; no row -> pending)
  //               THROWS on a DB error (callers answer 503, never "not a scorer")
  // .invalidate(userId), .clear()
```

### 4.2 `backend/lib/pgQuery.js`
1. **`opts.matchOwner.testOnly`** (boolean). `ownershipGuard` returns `testOnly: mo.testOnly === true && mo.admin !== true`. When it is set, the pre-check below runs **before** the ownership pre-checks, inside the same transaction. A refusal is `fail('OV_SCORER_REQUIRED', <details>, 403)`. The message is `'Your account is not approved for official matches yet'`.
   - `matches` insert/upsert: every row must have `test === true` (strict). For upsert, also count existing rows whose conflict key (`onConflict` columns, or the PK) matches a row and whose `test IS NOT TRUE`. More than zero means 403.
   - `matches` update: if `'test' in data && data.test !== true`, 403. Rows matched by the filters with `test IS NOT TRUE`: more than zero means 403.
   - `matches` delete: rows matched with `test IS NOT TRUE`: more than zero means 403.
   - children (`sets`, `events`, `match_live_state`) insert/upsert: any distinct `match_id` whose match has `test IS NOT TRUE` means 403. A missing match is left to the ownership check.
   - children update/delete: any matched row whose parent match has `test IS NOT TRUE` means 403. An update that moves `match_id` checks the new id too.
2. **`opts.actorId`** (UUID string; other values are ignored). For writes, the first statement in `run(client)` is `SELECT set_config('ov.user_id', $1, true)`.
3. **Error mapping.** Add a `cfg.errorMap`:
   ```js
   errorMap: {
     sqlstate:   { OVC01: { status: 409, code: 'OV_MATCH_CLOSED', message: 'This match is closed. Only an admin can reopen it.' } },
     constraint: { matches_official_game_uidx: { status: 409, code: 'OV_GAME_TAKEN', message: 'This official game is already scored by another account.' } }
   }
   ```
   In `errorResult`, check this before the generic `pg.DatabaseError` branch: an `err.code` in `sqlstate`, or `err.code === '23505' && constraint[err.constraint]`. The result is `{ status, body: { data: null, error: { message, code } } }`, with no `retryable` and no `details` (the 23505 DETAIL quotes key values).
4. Remove the stale `'teams'` from `DEFAULT_CONFIG.allowedTables` (server.js overrides it, but the name now invites confusion with saved teams).

### 4.3 `backend/lib/matchRestore.js`
- `restoreMatch(payload, { proto, matchOwner, actorId })`: inside `db.withTransaction`, if `actorId` is a UUID, first run `client.query("SELECT set_config('ov.user_id', $1, true)", [actorId])`. Pass `matchOwner` (now possibly `testOnly`) through unchanged.
- Add `serverOnlyColumns: ['created_by', 'closed_at', 'closed_by', 'official_game_exempt']` to `RESTORE_DEFAULTS` and delete all of them from `matchRow`. This generalises today's `created_by` deletion.
- `restoreByPin`: strip `created_by`, `closed_by` and `official_game_exempt` from the returned match (`closed_at` stays).
- No other change. A restore that touches a closed match fails at the events DELETE with 409 `OV_MATCH_CLOSED`, and the whole transaction rolls back.

### 4.4 `backend/lib/auth.js`
- `DEFAULTS.defaultRoles: []`. Update the comment and README "Auth module".

### 4.5 New module `backend/lib/officialGame.js`
```js
export const OFFICIAL_INDEX = 'matches_official_game_uidx'
export function SEASON_SQL(tsExpr)   // the exact season expression of db/007 around tsExpr
export function seasonOf(dateLike)    // JS twin; unit-tested against SEASON_SQL on a pg container
export function officialRowsOf(rows)  // rows with test !== true && Number.isInteger(+game_n) && +game_n > 0
/**
 * findClaim(client|pool, { gameN, scheduledAt, sportType, excludeExternalId, callerId })
 *   -> null | { match_id, game_n, season, sport: 'indoor'|'beach', status, scorer_name, mine, scheduled_at }
 * SQL: matches m LEFT JOIN profiles p ON p.user_id = m.created_by
 *   WHERE m.test IS NOT TRUE AND NOT m.official_game_exempt AND m.game_n = $n
 *     AND (m.sport_type IS NOT DISTINCT FROM 'beach') = ($sport = 'beach')
 *     AND SEASON_SQL(coalesce(m.scheduled_at, m.created_at)) = SEASON_SQL(coalesce($scheduled::timestamptz, now()))
 *     AND m.external_id IS DISTINCT FROM $exclude
 *   LIMIT 1
 * scorer_name = nullif(trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')), '')
 * mine = (m.created_by = callerId) OR callerId is an editor of m
 * NEVER returns PINs, emails, created_by, external_id.
 */
```

### 4.6 New module `backend/lib/accounts.js`
`createAccounts({ pool, db, restore, access, logger })`. Every handler returns `{ status, body }` and never throws (DB errors become 503 `OV_DB_UNAVAILABLE`, `retryable: true`).
- `audit(clientOrPool, { actorId, action, targetUserId?, matchId?, details? })` inserts into `public.audit_log`.
- `redeemInvite({ userId, code })`. In one transaction:
  1. Normalise the code: uppercase, drop spaces and `-`, map `O→0` and `I`/`L→1`, then check `^[0-9A-HJKMNP-TV-Z]{12}$`.
  2. `SELECT … FROM invite_codes WHERE code_hash = sha256('ov-invite:' || normalized) FOR UPDATE`.
  3. Checks: none or `revoked_at` → 404 `OV_INVITE_INVALID`. `expires_at <= now()` → 410 `OV_INVITE_EXPIRED`. A row in `invite_redemptions` for (invite, user) → 200 with `already_had: true` (idempotent, no increment). `max_uses` reached → 409 `OV_INVITE_USED_UP`.
  4. Insert the redemption, `uses = uses + 1`, then add the role to `profiles.roles` (upsert on `user_id`).
  5. Audit `invite.redeem` with `details { invite_id, label, role }`. Then `access.invalidate(userId)`.
- `createInvite`, `listInvites`, `revokeInvite`, `listAccounts`, `setRoles`, `listOfficialGames`, `listMatches`, `reopenMatch`, `addMatchEditor`, `releaseGame`, `listAudit` implement section 5.4.
- Code generation: 12 characters from `crypto.randomInt` over the Crockford alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (60 bits), shown as `XXXX-XXXX-XXXX`. Store `code_hash = sha256('ov-invite:' + normalized)` (32 bytes) and `code_hint` = the last 4 characters. **The plaintext is never stored or logged.**
- `reopenMatch` and `releaseGame` each run in one transaction:
  1. `set_config('ov.allow_closed','on',true)` and `set_config('ov.user_id', adminId, true)`.
  2. A `db.runQuery({ table:'matches', action:'update', … }, { internal: true, client, collectChanges: true })`.
  3. The audit insert.

  The server then calls `publishChanges(r.changes)`.

### 4.7 New module `backend/lib/savedTeams.js`
`createSavedTeams({ pool, logger })`. Handlers for section 5.5 return `{ status, body }`.
- `PUT …/roster` runs in one transaction:
  1. Validate.
  2. `DELETE … WHERE team_id = $1 AND id <> ALL($kept)`.
  3. Upsert each row by `id`. New rows get server UUIDs, and an `id` that belongs to another team gets 400.
  4. `UPDATE competition_teams SET updated_at = now()` (bumps the bundle version).
  5. Return the team with players and staff.
- `version` of the bundle = `max(updated_at)` over competitions and teams, as an ISO string (or `'0'` when empty).

### 4.8 `backend/server.js`
| Where | Change |
|---|---|
| `getDataLayer()` | Create `access = createAccessResolver({ pool: db.pool })`, `accounts = createAccounts({ pool: db.pool, db, restore, access })` and `savedTeams = createSavedTeams({ pool: db.pool })`, and add them to `dataLayer`. |
| `isAdminUser` | Delegates to `layer.access.get(userId).isAdmin`. Keep its catch-and-return-false behaviour for its current callers (referee directory, read paths). Remove the separate `adminCache`. |
| `matchOwnerFor(layer, user)` | `const a = await layer.access.get(user.id)` (**throws** on a DB error), then `a.isAdmin ? { userId, admin: true } : { userId, testOnly: !a.canScore }`. |
| `WRITE_DENYLIST.matches` | `['created_by', 'closed_at', 'closed_by', 'official_game_exempt', 'created_at']` (created_at added after review). |
| `/api/db` write path | (a) A throw from the access resolver gives 503 `OV_DB_UNAVAILABLE` `retryable: true` (not 500). (b) `runOpts.actorId = authUser.id` for writes. (c) **Official-game pre-check**: when `table === 'matches'`, the action is `insert`/`upsert` and `access.canScore` is true, run `findClaim` for each `officialRowsOf(p.data)` row (sport from the row, default `'indoor'`; `excludeExternalId` = the row's `external_id`). On a hit, answer 409 `{ data: null, error: { code: 'OV_GAME_TAKEN', message, claim } }` and audit `match.game_taken` (at most once per actor + game_n + season per 24 h; check the last entry first). Pending accounts skip the pre-check: pgQuery answers 403 first, so scorer names never reach them. (d) After `runQuery`, a 409 `OV_GAME_TAKEN` (race or update path) is enriched with `claim` when the payload carries `game_n`, else `claim: null`. (e) On 200, for every `changes` entry `{ table:'matches', eventType:'INSERT', row }` with `row.test !== true && row.game_n > 0`, audit `match.claim_game` with `{ external_id, game_n }`. |
| `claimByUpsertPin` | On success, audit `match.claim_pin` with `{ via: 'upsert-pin' }` per match. |
| `/api/match/restore` | Same access 503 rule, the same official pre-check on `body.match`, and `restoreMatch(body, { proto, matchOwner, actorId: user.id })`. |
| `/api/match/claim` | On 200, audit `match.claim_pin` with `{ via: 'claim', role }`. |
| `/api/match/restore-by-pin` | When `editorUserId` and `data.access === 'editor'`, audit `match.claim_pin` with `{ via: 'restore-by-pin' }`. |
| `/api/storage/upload` | When `body.bucket === 'scoresheets'` and `!access.canScore`, answer 403 `{ data:null, error:{ code:'OV_SCORER_REQUIRED', message } }`. Backups stay allowed. |
| `/api/verify-reopen-password` | **Removed** (falls through to the 404 handler). Remove the `REOPEN_PASSWORD_HASH` reads and fix the `AUTH_RATE_LIMIT_MAX` comment. |
| CORS | `Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS`. |
| New routes | Section 5. Place them in the DATA ENDPOINTS block (they need `DB_MODE`, else 503 `OV_DB_NOT_CONFIGURED`). They live under the prefixes `/api/account/`, `/api/admin/` and `/api/saved-teams`, plus `POST /api/match/official-check`. That one is a POST, so the GET-only `/api/match/:id` catcher does not take it, but add it to that block's exclusion list anyway. |
| `ALLOWED_TABLES` | **Unchanged.** The new tables are never reachable through `/api/db`. |

### 4.9 Deploy docs (backend agent; docs only, nothing deployed)
Remove `REOPEN_PASSWORD_HASH` from `deploy/compose.yaml`, `deploy/env.example`, `deploy/README.md` and `deploy/RUNBOOK-hetzner.md`, and note "replaced by admin reopen (db/007)". Update `backend/README.md` with: roles table, pending accounts, the closed-match lock, the official-game rule, and the new endpoints.

---

## 5. HTTP API (exact contract)

Conventions for every new endpoint:
- JSON envelope `{ "data": …, "error": null }`, or `{ "data": null, "error": { "message", "code", "details"? } }`. Field names are **snake_case**. `Cache-Control: no-store`.
- Auth: `Authorization: Bearer <token>` through `layer.auth.requireUser`. It answers 401 `missing_token`/`invalid_token` or 503 `auth_unavailable` itself.
- A role failure is 403 `OV_FORBIDDEN` (message `'You do not have access to this'`). A malformed body or query is 400 `OV_INVALID_REQUEST` with `details: '<field>: <reason>'`. An unknown id is 404 `OV_NOT_FOUND`. A database failure is 503 `OV_DB_UNAVAILABLE` with `retryable: true` and `Retry-After: 5`.
- Rate limits: `isRateLimited(user.id, 300, 'manage')` per minute for `/api/admin/*` and `/api/saved-teams*`, then 429 `OV_RATE_LIMITED`. Invite redemption uses `createAttemptLimiter({ max: 10, windowMs: 600000 })` keyed on the user id **and** on `ipBucketKey(ip)`. Only failed attempts count (refund on 200), and over the limit is 429 `OV_TOO_MANY_ATTEMPTS` with `Retry-After: 600`.
- `X-OV-Proto` is not required on these endpoints. The client sends it anyway.
- UUID path params must match `^[0-9a-f-]{36}$`, else 404 `OV_NOT_FOUND`.

### 5.1 Error codes (new)
| HTTP | code | When | Extra |
|---|---|---|---|
| 403 | `OV_SCORER_REQUIRED` | A pending or non-scorer account writes a non-test match or its children, uploads a scoresheet, or calls official-check | |
| 409 | `OV_GAME_TAKEN` | A second cloud match for an official game | `error.claim` (5.2) or `null` |
| 409 | `OV_MATCH_CLOSED` | Any write to a closed match, its sets or events (incl. restore) | |
| 409 | `OV_NOT_CLOSED` | Reopen of a match that is not closed | |
| 409 | `OV_SELF_DEMOTE` | An admin removes their own `admin` | |
| 409 | `OV_DUPLICATE` | Team name already in that competition (`competition_teams_name_uidx`) | |
| 404 | `OV_INVITE_INVALID` | Unknown or revoked invite code | |
| 410 | `OV_INVITE_EXPIRED` | Expired invite code | |
| 409 | `OV_INVITE_USED_UP` | `uses >= max_uses` | |
| 400 | `OV_INVALID_ROLE` | Role not in `API_GRANTABLE_ROLES` | |

The frontend sync queue already treats every 4xx with an `OV_*` code as "refused" (`failed`). Nothing new is retried as transient.

### 5.2 `OV_GAME_TAKEN` claim object
```json
{ "game_n": 12345, "season": 2026, "sport": "indoor", "status": "live",
  "scorer_name": "Anna Muster", "mine": false, "scheduled_at": "2026-10-10T16:00:00.000Z" }
```
`scorer_name` may be `null` (no profile name). `mine: true` means the caller created or edits that match (same account, other device). The object never contains PINs, emails, user ids or `external_id`. The second scorer joins with **game number + game PIN** through the existing `POST /api/match/restore-by-pin` (which also makes them an editor), or asks an admin.

### 5.3 Account and match
**`POST /api/account/redeem-invite`** (any signed-in account)
Body `{ "code": "ABCD-EFGH-JKMN" }` → 200 `{ "data": { "roles": ["scorer"], "role_granted": "scorer", "already_had": false } }`.
Errors: 400, 401, 404 `OV_INVITE_INVALID`, 410 `OV_INVITE_EXPIRED`, 409 `OV_INVITE_USED_UP`, 429 `OV_TOO_MANY_ATTEMPTS`, 503.

**`POST /api/match/official-check`** (`canScore`)
Body `{ "game_n": 12345, "scheduled_at": "2026-10-10T16:00:00.000Z" | null, "sport_type": "indoor" | "beach", "external_id": "match_…" | null }`
→ 200 `{ "data": { "taken": false } }` or 200 `{ "data": { "taken": true, "claim": { …5.2 } } }`.
Errors: 400, 401, 403 `OV_SCORER_REQUIRED`, 429, 503. Rate limit: `isRateLimited(user.id, 120, 'officialCheck')`.

### 5.4 Admin (`/api/admin/*`, every route requires `isAdmin`, else 403 `OV_FORBIDDEN`)
| Method, path | Body / query | 200 `data` |
|---|---|---|
| `GET /api/admin/accounts` | `?filter=pending\|all` (default `pending`), `&q=` (≤ 80 chars, ILIKE on email/first/last), `&limit=` (1–500, default 200) | `{ "accounts": [Account] }`, newest first |
| `POST /api/admin/accounts/:userId/roles` | `{ "add": [role], "remove": [role] }` (each ≤ 4, roles from `API_GRANTABLE_ROLES`) | `{ "id", "roles": [..] }`. Audit `account.roles` `{ added, removed, before, after }`, target = user. Errors 400 `OV_INVALID_ROLE`, 403 `OV_FORBIDDEN` (target is super_admin and caller is not), 404, 409 `OV_SELF_DEMOTE`. An account without a profile row gets one (`INSERT … ON CONFLICT (user_id) DO UPDATE`). Calls `access.invalidate(userId)`. |
| `GET /api/admin/invites` | none | `{ "invites": [Invite] }`, newest first |
| `POST /api/admin/invites` | `{ "label": str 1–120, "club"?: str ≤120, "role"?: "scorer"\|"referee"\|"competition_manager" (default scorer), "max_uses"?: int 1–10000 \| null (default 1), "expires_at"?: ISO \| null (default now + 30 days) }` | **201** `{ "invite": Invite, "code": "ABCD-EFGH-JKMN" }`. The only time the code is ever returned. Audit `invite.create` `{ invite_id, label, role }`. |
| `POST /api/admin/invites/:id/revoke` | none | `{ "invite": Invite }`. Idempotent. Audit `invite.revoke`. |
| `GET /api/admin/official-games` | `?from=YYYY-MM-DD&to=YYYY-MM-DD` (default Zurich today − 1 … today + 14, span ≤ 120 days), `&q=` | `{ "games": [Game] }` ordered by `datetime`. The `svrz_games` rows are those with `datetime >= from` and `< to + 1 day` (ISO text compare, as LoadOfficialMatchModal does). `claim` is matched in JS: non-test, non-exempt matches with `game_n = game_number::int` and `seasonOf(coalesce(scheduled_at, created_at)) === seasonOf(game.datetime)`. |
| `GET /api/admin/matches` | `?state=closed\|open\|all` (default `closed`), `&q=` (game number exact, or team name ILIKE on `home_team->>'name'`/`away_team->>'name'`), `&limit=` (1–500, default 100) | `{ "matches": [AdminMatch] }`. Non-test only, ordered by `coalesce(closed_at, updated_at) DESC`. |
| `POST /api/admin/matches/:matchId/reopen` | `{ "reason": str 3–500 }` | `{ "match": { "id", "external_id", "status": "ended", "closed_at": null } }`. Sets `status='ended', approval=NULL, closed_at=NULL, closed_by=NULL` (4.6), audit `match.reopen` `{ reason, from_status, external_id, game_n }`, publishes the change. 404, 409 `OV_NOT_CLOSED`. |
| `POST /api/admin/matches/:matchId/editors` | `{ "email": str }` | `{ "role": "editor" \| "creator" }` via `restore.addEditor(matchId, userId, 'admin')`. Audit `match.editor_add` `{ email }`, target = that user. 404 (no such match or account). |
| `POST /api/admin/matches/:matchId/release-game` | `{ "reason": str 3–500 }` | `{ "match": { "id", "official_game_exempt": true } }`. Uses `ov.allow_closed` so it also works on a closed match. Audit `match.release_game` `{ reason, game_n }`. |
| `GET /api/admin/audit` | `?limit=` (1–200, default 100), `&before=<id>`, `&action=<one of the actions>` | `{ "entries": [Audit], "next_before": <id> \| null }`, newest first |

Object shapes:
```
Account    { id, email, first_name, last_name, roles: string[], pending: bool, created_at, last_sign_in_at }
Invite     { id, code_hint, label, club, role, max_uses, uses, expires_at, revoked_at, created_at, created_by_name,
             state: 'active'|'expired'|'used_up'|'revoked' }
Game       { game_number, datetime, date, time, league, gender, team_home, team_away, hall, city,
             claim: null | { match_id, external_id, status, scorer_name, scorer_email, editors: int, closed_at, updated_at } }
AdminMatch { id, external_id, game_n, status, scheduled_at, home_name, away_name, league, scorer_name, scorer_email,
             editors: int, closed_at, closed_by_name, official_game_exempt, updated_at }
Audit      { id, at, action, actor_name, actor_email, target_name, target_email, match_id, details }
```
Audit `action` values (exhaustive): `account.roles`, `invite.create`, `invite.revoke`, `invite.redeem`,
`match.claim_game`, `match.claim_pin`, `match.game_taken`, `match.close` (written by the trigger),
`match.reopen`, `match.editor_add`, `match.release_game`.
Admins see emails (it is their job). No endpoint ever returns PINs, password hashes or invite plaintext after creation.

### 5.5 Saved teams (`/api/saved-teams*`)
GET needs `canReadTeams`, and writes need `canManageTeams` (else 403 `OV_FORBIDDEN`). Anonymous requests get 401. Pending accounts get 403.

| Method, path | Body | 200/201 `data` |
|---|---|---|
| `GET /api/saved-teams` | none | `Bundle` (below) |
| `POST /api/saved-teams/competitions` | `{ name, season: "2026/27", gender?: "men"\|"women"\|"mixed"\|null, category?: str\|null, vm_leagues?: str[] (≤ 20, each ≤ 60) }` | **201** `{ competition }` |
| `PATCH /api/saved-teams/competitions/:id` | Any subset of the above, plus `archived: bool` | `{ competition }` |
| `DELETE /api/saved-teams/competitions/:id` | none | `{ "deleted": true }` (cascades) |
| `POST /api/saved-teams/teams` | `{ competition_id, name, short_name?, club?, color?: "#rrggbb", svrz_team_name? }` | **201** `{ team }` (with `players: []`, `staff: []`). 409 `OV_DUPLICATE`. |
| `PATCH /api/saved-teams/teams/:id` | Any subset of the team fields (not `competition_id`) | `{ team }` |
| `DELETE /api/saved-teams/teams/:id` | none | `{ "deleted": true }` |
| `PUT /api/saved-teams/teams/:id/roster` | `{ players: [Player], staff: [Staff] }` | `{ team }` with the new roster |

Roster validation (400 `OV_INVALID_REQUEST`, `details` names the row index):
- ≤ 40 players and ≤ 10 staff.
- `last_name` is required.
- `number` is an int 0–99 or null, unique among `active` players.
- At most one `is_captain` among active players.
- `dob` is `YYYY-MM-DD` or null.
- Staff `role` is in the 5 MatchSetup bench roles.
- `sort_order` is the array index (the server sets it).

```
Bundle { version: string, fetched_at: ISO,
         competitions: [{ id, name, season, gender, category, vm_leagues: string[], archived, updated_at }],
         teams: [{ id, competition_id, name, short_name, club, color, svrz_team_name, updated_at,
                   players: [Player], staff: [Staff] }] }
Player { id?, number, first_name, last_name, dob, license_number, is_libero, is_captain, active, sort_order }
Staff  { id?, role: 'Coach'|'Assistant Coach 1'|'Assistant Coach 2'|'Physiotherapist'|'Medic',
         first_name, last_name, dob, license_number, sort_order }
```
The bundle includes archived competitions (with the flag). Pickers hide them.

---

## 6. Frontend

### 6.1 Shared logic (new)
- `src/lib/access.js`: the section 1 definitions (`ADMIN_ROLES`, `accessFromRoles(roles)`).
- `src/domain/season.js`: `seasonOf`, `seasonLabel`, matching section 2. Pure and tested.
- `src/domain/savedTeams.js`: pure and tested.
  - `savedTeamToRoster(team) → { roster, bench, meta, warnings }`. `roster` items are `{ number, firstName, lastName, dob: 'DD.MM.YYYY'|'', libero: ''|'libero1'|'libero2', isCaptain, isLfp: false }`. Only active players, ordered by `sort_order`. The first libero is `libero1`, the second `libero2`, and further ones get `''` plus the `tooManyLiberos` warning. Only one captain. `bench` is the staff mapped to `{ role, firstName, lastName, dob }`, always containing a `Coach` entry (`{role:'Coach', firstName:'', lastName:'', dob:''}` if none). `meta` is `{ name, shortName, color }`.
  - `rosterToSavedRoster(roster, bench, existingTeam)` builds the PUT body. It keeps `id` and `license_number` of an existing player when `number` and lower-cased `last_name` match, and of staff by `role` + `last_name`. DOB is converted to ISO with the same rules as MatchSetup's `formatDobForSync`.
  - `findSavedTeamSuggestions(teams, { home, away, league, gender, scheduledAt })` returns `{ home: team|null, away: team|null }`. Normalise as lowercase, trim and collapse spaces. Candidates are non-archived teams whose `svrz_team_name` or `name` equals the schedule team name. Rank: a competition whose `vm_leagues` includes `league` first, then a competition season equal to `seasonLabel(seasonOf(scheduledAt))`, then the most recent `updated_at`.

### 6.2 API client
- `src/lib/apiClient.js`: export `apiRequest(method, path, body?, { timeoutMs, fallbackError })` → `{ data, error, status }`. It uses `getAuthHeaders()` and `getCloudApiUrl(path)`, and sends no body for GET/DELETE. A network failure is `{ error: networkError(err), status: 0 }`. Keep `postJson` as is.
- `src/lib/accountApi.js` (new), one function per endpoint in section 5:
  - `redeemInvite(code)`, `officialCheck(body)`.
  - `admin.{listAccounts, setRoles, listInvites, createInvite, revokeInvite, listOfficialGames, listMatches, reopenMatch, addMatchEditor, releaseGame, listAudit}`.
  - `savedTeamsApi.{fetchBundle, createCompetition, updateCompetition, deleteCompetition, createTeam, updateTeam, deleteTeam, putRoster}`.

### 6.3 Auth and pending state
- `src/contexts/AuthContext.jsx`:
  - Expose `access = accessFromRoles(profile?.roles ?? getCachedProfile()?.roles ?? [])` and `redeemInvite(code)` (calls the API, then `fetchProfile`).
  - While `user && access.isPending`, refetch the profile every 60 s, on `focus` and on `online`.
  - When `canScore` turns true, or `canReadTeams` changes, dispatch `window` `CustomEvent('ov-access-changed', { detail: access })`.
  - On sign-out, and when the user id changes, call `clearSavedTeams()` (6.6).
  - Remove `roles` from the `signUp` metadata (the server drops it anyway).
- `src/components/auth/SignUpForm.jsx` (the manager site's `#signup` page; the sign-up dialog of the scorer apps is gone): drop `roles: ['scorer']`, and show `access.signUpPendingNote` under the form.
- `src/components/auth/UserButton.jsx`: replace the hard-coded "Scorer" chip with chips from `access` (pending is an amber chip). Add menu rows, in both the dropdown and `inline`:
  - "Admin" (`isAdmin`) → `openManage('accounts')`.
  - "Saved teams" (`canManageTeams`) → `openManage('teams')`.
  - "Enter invite code" (`isPending`) → `RedeemInviteModal`.
- `src/components/auth/ProfileModal.jsx`: show the role chips (stop defaulting to `['scorer']`). When pending, show `PendingApprovalBanner`.
- New `src/components/auth/PendingApprovalBanner.jsx`: volleyui amber `Banner` with title `access.pendingTitle`, body `access.pendingBody`, and an inline invite field (`Input` h-9 + `Button`, same height, monospace uppercase as the user types). The error shows inline (`text-red-600 text-xs font-medium`), and success shows `toast.success(access.redeemed)`. Rendered on `HomePage` (signed in + pending) and in `ProfileModal`.
- New `src/components/auth/RedeemInviteModal.jsx`: the same form in a `Modal`.

### 6.4 Manage console (admin and competition manager)
- New `src/utils/manageNav.js`: `openManage(tab)` dispatches `CustomEvent('ov-open-manage', { detail: { tab } })`, and `openRestore({ gameN })` dispatches `ov-open-restore`.
- `src/App.jsx`: state `manageTab` (null or a tab id) and a listener for `ov-open-manage`. While `manageTab` is set, render `<ManageConsole tab onTab onClose />` full screen instead of the main content. It is never shown while a match is open: if `matchId` is set, ignore the event. Also listen for `ov-open-restore`: `setRestoreMatchModal(true)` and prefill `restoreMatchIdInput` with `gameN`.
- New `src/components/manage/ManageConsole.jsx` (volleyui `ConsoleShell`, full width, eyebrow "Manage", header action "Back to the app" with `consoleHeaderBtn`). Tabs filtered by access:

| tab id | visible to | panel file | content |
|---|---|---|---|
| `accounts` | admin | `AccountsPanel.jsx` | `SegmentedControl` Pending / All (count badge on Pending), `SearchInput`, `RowList` of accounts (title = name or email, meta = email · created · last sign-in, role chips). Pending rows have the primary tool "Approve as scorer" (`setRoles {add:['scorer']}`). Every row has the tool "Roles" → modal with checkboxes scorer / referee / competition manager / admin (super_admin shown read-only), Save. Inline errors for `OV_SELF_DEMOTE` and `OV_FORBIDDEN`. |
| `invites` | admin | `InvitesPanel.jsx` | "New invite code" → modal form (label, club, role select, max uses number with an empty = unlimited hint, expiry `type=date` defaulting to +30 days). On 201 it shows the code once in a `ModalStrip` (`font-mono tracking-[0.3em]`), with a Copy button and the "shown only once" note. The list uses `RowList`: label, club chip, role chip, "uses / max", expiry, state pill (active = emerald, expired/used up = stone, revoked = red). The "Revoke" tool uses `confirmDialog` with `tone:'danger'`. |
| `games` | admin | `OfficialGamesPanel.jsx` | From/To date inputs and search. Rows use `DateRail` (Zurich date/time), title "Home vs Away", meta "#game · league · hall". Claimed games show a status pill plus "Scored by X" and "n editors", with the tools "Add editor" (email modal) and "Release game" (`confirmDialog` + reason). Unclaimed games show a stone "Not claimed". |
| `matches` | admin | `ClosedMatchesPanel.jsx` | `SegmentedControl` Closed / Open / All, search. Rows: game, teams, status pill, "Closed {date} by {name}". The "Reopen" tool opens a decision modal with a required reason `Textarea` and confirm label "Reopen". |
| `audit` | admin | `AuditPanel.jsx` | `RowList`, newest first, with the Zurich time, an action label (`manage.audit.actions.<action with . → _>`), actor, target and a short details line. "Load more" uses `next_before`. |
| `teams` | admin, competition_manager | `SavedTeamsPanel.jsx` + `TeamEditor.jsx` | Competition list with a season filter, "Show archived" switch and "New competition" (modal: name, season select ±1 around the current one, gender, category, VolleyManager leagues as chips picked from the distinct `svrz_games.league` of that gender via `apiFrom('svrz_games').select('league, gender')`, plus free text). Selecting a competition shows its teams with "New team". The team editor has fields name, short name, club, colour (`input type=color` + hex) and VolleyManager team name (`<datalist>` of `team_home`/`team_away` from `svrz_games` of the competition's leagues). The roster table has players (no., first, last, DOB `type=date`, licence, libero checkbox, captain radio, active switch, remove) and officials (role select, first, last, DOB, licence). "Save roster" uses the emerald positive button. "Delete team" uses `danger-outline` with `ml-auto` and a confirm. Refresh the Dexie cache after every successful write. |

UI rules: follow `/volleyui` (sentence case, `h-9` admin controls, one primary per surface, `confirmDialog` never `window.confirm`, skeleton rows while loading, toasts only after the write resolved, inline errors too). When offline, every panel shows `manage.errors.offline` in an amber banner and disables its actions. The UI hiding is cosmetic: every action is refused server-side without the role.

### 6.5 MatchSetup (`src/components/MatchSetup.jsx`)
1. **Load saved team.** In the home and away roster views (header button row, next to "Load test roster" around line 3851, and the away twin around line 4947), add `Button variant="secondary" size="xl"` "Load saved team", shown when `access.canReadTeams`. It opens the new `src/components/SavedTeamPickerModal.jsx`:
   - Competition `<select>` (default: the suggestion's competition, else "All competitions"), search, and a `RowList` of teams (name, club, "n players").
   - Data comes from the Dexie cache. Offline, a sky notice reads "Offline – showing saved teams from {date}".
   - On pick: if the roster or bench has content, `confirmDialog` (`savedTeams.replaceConfirm*`). Then `setHomeRoster(roster)` and `setBenchHome(bench)`, and fill name / short name / colour only where the field is empty. Toast `savedTeams.loaded`, plus the warnings. Everything stays editable. Same for away.
2. **Suggestions for schedule games.** At the end of `handleOfficialMatchSelect`, compute `findSavedTeamSuggestions(await getSavedTeams(), { home, away, league, gender: type2, scheduledAt })` and store it in state `savedSuggestion`. The main view shows a sky `Banner` "Saved rosters found" with "Home: X" and "Away: Y" and the buttons "Load home roster" / "Load away roster". They load as in step 1 (confirm only when non-empty). It never overwrites silently.
3. **Official-game pre-check.** When `access.canScore`, online and `gameN` is set:
   - after `handleOfficialMatchSelect`;
   - before the match-info confirm that queues the `insert` job (around line 2144).

   Call `officialCheck({ game_n, scheduled_at, sport_type:'indoor', external_id: matchSeedKey })`. If `taken && !claim.mine`:
   - after a load: an amber banner (`matchSetup.gameTakenTitle/Body`) with the button "Join with game PIN" → `openRestore({ gameN })`;
   - at confirm: `confirmDialog` with Cancel or "Continue on this device only". Continuing still queues the insert. The server will refuse it with 409, and 6.7 records it.

   If `claim.mine`, show `cloudBlock.gameTakenMine`. A network failure skips the check silently.
4. **Pending note.** When `access.isPending`, the match-info confirm shows a `Notice` with `access.officialMatchLocalOnly`. It does not block.
5. **Save roster to team** (`access.canManageTeams` and online). It sits in the roster views' button row and opens the new `src/components/SaveRosterToTeamModal.jsx`. Choose a competition, then an existing team (pre-selected by suggestion or name match) or "New team" (name, short name and colour prefilled from setup). Overwriting asks `confirmDialog`. It calls `createTeam` if needed, then `putRoster(rosterToSavedRoster(...))`, then refreshes the cache.

### 6.6 Dexie cache (offline-first)
- `src/db/db.js`: add `db.version(19).stores({ saved_teams: 'id, competitionId, nameKey, svrzKey', saved_teams_meta: 'key' })`. No upgrade function.
- New `src/db/savedTeams.js`:
  - `refreshSavedTeams({ force = false } = {})`: needs `canReadTeams` and a connection. It skips when `fetched_at` is under 10 min old and not `force`. It does GET `/api/saved-teams` and replaces both tables in one `rw` transaction. Rows are camelCase: `{ id, competitionId, competition:{id,name,season,gender,category,vmLeagues,archived}, name, shortName, club, color, svrzTeamName, nameKey, svrzKey, players, staff, updatedAt }`. Meta is `{ key:'bundle', version, fetchedAt, userId }`. On 403 it clears the cache.
  - `getSavedTeams()`: all cached rows. Returns `[]` when `meta.userId` is not the current user.
  - `clearSavedTeams()`.
  - Called: after the profile loads when `canReadTeams` (non-forced), when the picker opens, after `ov-access-changed`, and after every CM write (forced).
- The cached rows contain DOBs and licence numbers. They are cleared on sign-out and account switch, and never sent anywhere else.

### 6.7 Sync queue (`src/hooks/useSyncQueue.js`)
1. **Closing order.** A job with `resource === 'match' && action === 'update' && ['approved','final'].includes(payload?.status)` returns `null` (dependency wait, as the existing ones do) while an **older** (`id <`) job of the same match (`jobMatchKey`) with `resource` `set` or `event` is `queued`, `sending` or `error`. Old `failed` children do not hold it. Without this, `RESOURCE_ORDER` (match first) would close the match before its last set or events arrive.
2. **Cloud blocks.** When a job ends `PERMANENT_FAILURE` with code `OV_SCORER_REQUIRED`, `OV_GAME_TAKEN` or `OV_MATCH_CLOSED`, set `cloudBlock: { code, claim: error.claim ?? null, at }` on the local match (`findLocalMatchBySeed`) and dispatch `CustomEvent('ov-cloud-block', { detail: { seedKey, code } })`. Clear `cloudBlock` when a later job of that match is sent. `normalizeError` in `apiClient.js` already spreads the error object, so `error.claim` survives. Keep it on the error that `processJobInner` records.
3. **Access changes.** In `installAuthListener`, listen for `ov-access-changed`. When `detail.canScore` is true, call `resumeAfterSignIn()`, which requeues the `failed` jobs.
4. New `src/components/CloudBlockNotice.jsx`: an amber `Notice` reading `match.cloudBlock` with the text from `cloudBlock.*` (and "Join with game PIN" for `OV_GAME_TAKEN` → `openRestore`). Shown in the `HomePage` current-match card, in the MatchSetup main view and in MatchEnd.

### 6.8 MatchEnd reopen (`src/components/MatchEnd.jsx`), replacing the password
Remove all of the following:
- `VITE_REOPEN_PASSWORD_HASH` and `reopenUnlocked`;
- the `showUnlockModal` / `unlockPassword*` state, `handleUnlockSubmit` and the unlock modal JSX;
- the lock SVGs on the button;
- the `/api/verify-reopen-password` call;
- the `hashPassword` import (delete `hashPassword` from `utils/stringUtils.js` only if no other caller remains).

Update the `frontend/vite.config.js` comment that names the variable.

New `handleReopenMatchClick`:
1. `match.test` or no `match.seed_key` → **local path**: existing `handleReopenMatch()`, without queuing anything for test matches.
2. Non-test, and **no closing update ever reached the server**: no `sync_queue` job for this match with `resource:'match', action:'update', payload.status ∈ {approved, final}` has status `sent` or `sending`. Mark those queued, error or failed closing jobs `superseded`, then reopen locally **without** queuing `status:'ended'`. This is the only offline path. It never bypasses a server rule, because the server never saw the match closed.
3. Otherwise (the server has it closed, or may have) you need a connection. Offline → alert `matchEnd.reopenNeedsConnection`. Online:
   - Read `apiFrom('matches').select('id, status, closed_at').eq('external_id', seed_key).maybeSingle()`. The owner gets the full row through the existing `readOwner` path.
   - If `closed_at` is null (an admin already reopened it): local reopen without queuing.
   - Else if `access.isAdmin`: a decision modal (`matchEnd.reopenAdminTitle/Body`) with a required reason, then `admin.reopenMatch(row.id, { reason })`. On 200, local reopen without queuing.
   - Else: a modal `matchEnd.reopenAdminOnlyTitle/Body` with the game number.
   - A read failure → `matchEnd.reopenCheckFailed`.

"Reopen last set" (before approval) is unchanged: the match is not closed then. After "Close match" the local data is deleted. A scorer whose closed match was reopened by an admin restores it with game number + PIN (existing restore).

Old clients that keep the baked hash still unlock locally and queue `status:'ended'`. The server refuses it with 409 `OV_MATCH_CLOSED` and the job parks. That is acceptable.

### 6.9 i18n (all five files: `src/i18n/locales/en.json`, `de.json`, `de-CH.json`, `fr.json`, `it.json`)
Every key below must exist in **all five**. `de.json` currently lacks whole namespaces (e.g. `matchEnd`): add the new keys there too. German texts use `ss`, never `ß`, in both `de` and `de-CH`. Sentence case. Remove `matchEnd.unlockPasswordError`, `unlockPasswordPlaceholder`, `unlockPasswordRequired`, `unlockPasswordWrong`, `unlockReopen`, `unlockReopenDescription` (and `unlockTooManyAttempts` where present) from every file. English source texts:

```
access.pendingTitle            Your account is waiting for approval
access.pendingBody             You can score test matches. Official matches stay on this device until an admin approves your account or you enter an invite code from your club.
access.inviteCodeLabel         Invite code
access.inviteCodePlaceholder   XXXX-XXXX-XXXX
access.redeem                  Redeem code
access.redeeming               Checking…
access.redeemed                Code accepted. You can now score official matches.
access.errors.inviteInvalid    This invite code is not valid.
access.errors.inviteExpired    This invite code has expired.
access.errors.inviteUsedUp     This invite code has been used up.
access.errors.tooManyAttempts  Too many attempts. Please wait a few minutes.
access.errors.offline          Redeeming a code needs a connection.
access.roles.scorer            Scorer
access.roles.referee           Referee
access.roles.competition_manager Competition manager
access.roles.admin             Admin
access.roles.super_admin       Super admin
access.roles.pending           Pending approval
access.signUpPendingNote       New accounts need approval before official matches sync to the cloud. Ask your club for an invite code.
access.officialMatchLocalOnly  This match stays on this device until your account is approved.

manage.title                   Manage
manage.backToApp               Back to the app
manage.nav                     Manage sections
manage.menuAdmin               Admin
manage.menuSavedTeams          Saved teams
manage.menuInviteCode          Enter invite code
manage.tabs.accounts           Accounts
manage.tabs.invites            Invite codes
manage.tabs.games              Official games
manage.tabs.matches            Closed matches
manage.tabs.audit              Audit log
manage.tabs.teams              Saved teams
manage.status.setup            Set-up
manage.status.live             Live
manage.status.ended            Ended
manage.status.approved         Approved
manage.status.final            Closed
manage.errors.forbidden        You do not have access to this section.
manage.errors.generic          Something went wrong – please try again.
manage.errors.offline          This needs a connection to the server.
manage.accounts.filterPending  Pending
manage.accounts.filterAll      All
manage.accounts.search         Search name or email
manage.accounts.approve        Approve as scorer
manage.accounts.editRoles      Roles
manage.accounts.rolesTitle     Roles of {{name}}
manage.accounts.save           Save
manage.accounts.saved          Saved.
manage.accounts.empty          No accounts found.
manage.accounts.emptyPending   No accounts are waiting for approval.
manage.accounts.created        Created {{date}}
manage.accounts.lastSignIn     Last sign-in {{date}}
manage.accounts.neverSignedIn  Never signed in
manage.accounts.selfDemote     You cannot remove your own admin role.
manage.accounts.superAdminOnly Only a super admin can change this account.
manage.invites.new             New invite code
manage.invites.label           Label
manage.invites.labelHint       For example club and season
manage.invites.club            Club
manage.invites.role            Role
manage.invites.maxUses         Maximum uses
manage.invites.maxUsesHint     Leave empty for unlimited
manage.invites.expires         Expires on
manage.invites.create          Create code
manage.invites.createdTitle    Invite code created
manage.invites.createdOnce     Copy it now – it is shown only once.
manage.invites.copy            Copy
manage.invites.copied          Copied.
manage.invites.uses            {{uses}} / {{max}} used
manage.invites.usesUnlimited   {{uses}} used
manage.invites.revoke          Revoke
manage.invites.revokeConfirmTitle Revoke this invite code?
manage.invites.revokeConfirmBody  Nobody can redeem it afterwards. Accounts that already used it keep their role.
manage.invites.state.active    Active
manage.invites.state.expired   Expired
manage.invites.state.used_up   Used up
manage.invites.state.revoked   Revoked
manage.invites.empty           No invite codes yet.
manage.games.from              From
manage.games.to                To
manage.games.search            Search team or game number
manage.games.notClaimed        Not claimed
manage.games.scoredBy          Scored by {{name}}
manage.games.unknownScorer     Unknown scorer
manage.games.editors           {{count}} editors
manage.games.addEditor         Add editor
manage.games.addEditorTitle    Add an editor to game {{game}}
manage.games.editorEmail       Account email
manage.games.add               Add
manage.games.editorAdded       Editor added.
manage.games.releaseGame       Release game
manage.games.releaseConfirmTitle Release game {{game}}?
manage.games.releaseConfirmBody  The match stays, but another scorer can then create a new cloud match for this game.
manage.games.reason            Reason
manage.games.empty             No official games in this period.
manage.matches.filterClosed    Closed
manage.matches.filterOpen      Open
manage.matches.filterAll       All
manage.matches.search          Search team or game number
manage.matches.closedAt        Closed {{date}}
manage.matches.closedBy        by {{name}}
manage.matches.reopen          Reopen
manage.matches.reopenTitle     Reopen game {{game}}?
manage.matches.reopenBody      The match goes back to “ended”: the scorer can correct it and approve it again. This is recorded in the audit log.
manage.matches.reopenReason    Reason
manage.matches.reopened        Match reopened.
manage.matches.empty           No matches found.
manage.audit.loadMore          Load more
manage.audit.empty             No entries yet.
manage.audit.actions.account_roles       Roles changed
manage.audit.actions.invite_create       Invite code created
manage.audit.actions.invite_revoke       Invite code revoked
manage.audit.actions.invite_redeem       Invite code redeemed
manage.audit.actions.match_claim_game    Official game claimed
manage.audit.actions.match_claim_pin     Joined with game PIN
manage.audit.actions.match_game_taken    Second scorer refused
manage.audit.actions.match_close         Match closed
manage.audit.actions.match_reopen        Match reopened
manage.audit.actions.match_editor_add    Editor added by admin
manage.audit.actions.match_release_game  Game released

savedTeams.title               Saved teams
savedTeams.competitions        Competitions
savedTeams.newCompetition      New competition
savedTeams.competitionName     Name
savedTeams.season              Season
savedTeams.gender              Gender
savedTeams.genderMen           Men
savedTeams.genderWomen         Women
savedTeams.genderMixed         Mixed
savedTeams.category            Category
savedTeams.categoryHint        For example senior or U19
savedTeams.vmLeagues           VolleyManager leagues
savedTeams.vmLeaguesHint       Official games of these leagues suggest the saved teams
savedTeams.archived            Archived
savedTeams.showArchived        Show archived
savedTeams.teams               Teams
savedTeams.newTeam             New team
savedTeams.teamName            Team name
savedTeams.shortName           Short name
savedTeams.club                Club
savedTeams.color               Colour
savedTeams.svrzTeamName        VolleyManager team name
savedTeams.svrzTeamNameHint    Exactly as in the official schedule
savedTeams.players             Players
savedTeams.staff               Team officials
savedTeams.addPlayer           Add player
savedTeams.addStaff            Add official
savedTeams.number              No.
savedTeams.firstName           First name
savedTeams.lastName            Last name
savedTeams.dob                 Date of birth
savedTeams.license             Licence
savedTeams.libero              Libero
savedTeams.captain             Captain
savedTeams.active              Active
savedTeams.role                Role
savedTeams.saveRoster          Save roster
savedTeams.rosterSaved         Roster saved.
savedTeams.deleteTeam          Delete team
savedTeams.deleteTeamConfirmTitle Delete {{name}}?
savedTeams.deleteTeamConfirmBody  Its players and officials are deleted too.
savedTeams.deleteCompetition   Delete competition
savedTeams.deleteCompetitionConfirmTitle Delete {{name}}?
savedTeams.deleteCompetitionConfirmBody  All its teams, players and officials are deleted too.
savedTeams.duplicateTeam       A team with this name already exists in this competition.
savedTeams.emptyCompetitions   No competitions yet.
savedTeams.emptyTeams          No teams in this competition yet.
savedTeams.emptyRoster         No players yet.
savedTeams.errors.duplicateNumber Number {{number}} is used twice.
savedTeams.errors.twoCaptains     Only one captain per team.
savedTeams.errors.lastNameRequired Last name is required.
savedTeams.load                Load saved team
savedTeams.pickerTitle         Load a saved team
savedTeams.pickerSearch        Search team or club
savedTeams.pickerCompetition   Competition
savedTeams.pickerAll           All competitions
savedTeams.pickerPlayers       {{count}} players
savedTeams.pickerEmpty         No saved teams. Saved teams are available after one online load.
savedTeams.pickerOffline       Offline – showing saved teams from {{date}}.
savedTeams.replaceConfirmTitle Replace the roster?
savedTeams.replaceConfirmBody  The current players and team officials of {{team}} are replaced. You can still edit them afterwards.
savedTeams.replace             Replace
savedTeams.loaded              Roster of {{name}} loaded.
savedTeams.tooManyLiberos      {{name}} has more than two liberos – only the first two are marked.
savedTeams.suggestionTitle     Saved rosters found
savedTeams.suggestionHome      Home: {{name}}
savedTeams.suggestionAway      Away: {{name}}
savedTeams.loadHome            Load home roster
savedTeams.loadAway            Load away roster
savedTeams.saveToTeam          Save roster to team
savedTeams.saveTitle           Save roster to a saved team
savedTeams.saveExisting        Existing team
savedTeams.saveNew             New team
savedTeams.saveConfirmTitle    Overwrite the saved roster of {{name}}?
savedTeams.saveConfirmBody     The saved players and officials of this team are replaced by this roster.
savedTeams.saved               Saved to {{name}}.

cloudBlock.scorerRequired      Not synced: your account is waiting for approval. The match is safe on this device.
cloudBlock.gameTaken           Not synced: game {{game}} is already scored by {{name}} ({{status}}). Join that match with its game PIN or ask an admin.
cloudBlock.gameTakenMine       Not synced: you already score game {{game}} in another match. Open that match with its game PIN.
cloudBlock.gameTakenUnknown    Not synced: this official game is already scored by another account.
cloudBlock.matchClosed         Not synced: this match is closed on the server. Only an admin can reopen it.
cloudBlock.joinWithPin         Join with game PIN

matchSetup.gameTakenTitle      Game {{game}} is already being scored
matchSetup.gameTakenBody       {{name}} is scoring this game ({{status}}). Only one cloud match per official game is allowed: join it with its game PIN, or continue and keep this match on this device only.
matchSetup.continueLocalOnly   Continue on this device only

matchEnd.reopenAdminOnlyTitle  Only an admin can reopen this match
matchEnd.reopenAdminOnlyBody   Game {{game}} is closed on the server. Ask an admin to reopen it, then tap “Reopen match” again.
matchEnd.reopenNeedsConnection Reopening a closed match needs a connection to the server.
matchEnd.reopenAdminTitle      Reopen this closed match?
matchEnd.reopenAdminBody       It goes back to “ended” on the server and can be approved again. This is recorded in the audit log.
matchEnd.reopenReason          Reason
matchEnd.reopenCheckFailed     Could not check the match on the server – please try again.
```
Server error messages stay English: the UI maps them by `error.code`, and `{{status}}` uses `manage.status.*`.

---

## 7. Test plan

### Backend (`cd escoresheet/backend && PG_TEST_URL=… npm test`, throwaway container)
**Existing tests that must change** (new accounts have no role now):
- `auth.test.js` (≈ lines 763–811) and `server.e2e.test.js:349` expect `['scorer']` → expect `[]`.
- Every e2e or pg test that signs up a user and then writes a **non-test** match (`security.e2e`, `server.e2e`, `accountData.e2e`, `pgQuery.ownership`, `matchRestore`) needs that user made a scorer first. Add a helper `grantRoles(pool, userId, ['scorer'])` in `tests/helpers/` (direct SQL `UPDATE public.profiles SET roles = $2 WHERE user_id = $1`).
- `pgTestDb.js` `MIGRATIONS_SQL` += 006 and 007.

New suites:
1. `access.test.js` (unit): `normalizeRoles` (text[], JSON string, `{a,b}`, null), `accessFromRoles` matrix, resolver cache and invalidate, and the resolver throwing on a DB error.
2. `officialGame.pg.test.js`: `seasonOf` against `SEASON_SQL` for 2026-06-30T21:59Z / 22:00Z (Zurich midnight, DST), 2026-07-01, 2027-01-15 and null; `findClaim` (mine via creator, mine via editor, exempt ignored, test ignored, beach vs indoor, other season free, no PIN, email or id in the output).
3. `migration007.pg.test.js`:
   - On the synthetic schema plus seeded duplicates and approved/final matches: 007 runs twice, NOTICEs name the duplicates, the first created keeps the claim, `updated_at` is unchanged, roles of existing profiles are unchanged, and the `profiles.roles` default is `{}`.
   - As a non-superuser role without function EXECUTE (create `ov_app_test` as `pgTestDb` does): every guard case from section 3's verification list.
4. `pgQuery.scorerAccess.test.js`:
   - `testOnly`: insert of `test:false` → 403 `OV_SCORER_REQUIRED`, `test:true` → 200. Upsert onto an existing non-test row → 403. Update setting `test:false` → 403. Update or delete of a non-test match → 403. Children of a non-test match (insert, upsert, update, delete, moving `match_id`) → 403. Children of a test match → 200.
   - `actorId` → `closed_by`.
   - `OVC01` → 409 `OV_MATCH_CLOSED`.
   - 23505 on `matches_official_game_uidx` → 409 `OV_GAME_TAKEN`, with no `details`.
   - Other 23505s are unchanged.
5. `accounts.pg.test.js`:
   - Invites: the code is never stored (scan `invite_codes` for the plaintext), hint = last 4, normalisation (`o`/`i`/`l`, dashes, spaces), max uses, expiry 410, revoke 404, idempotent re-redeem, the role is added once, audit rows.
   - Roles: grant/revoke, `OV_INVALID_ROLE`, super_admin protection, `OV_SELF_DEMOTE`, missing profile row created, access cache invalidated.
   - Reopen (409 on open, clears `closed_*`, audit with reason, writes work after).
   - Release-game (closed match too, frees the key).
   - Editors by email.
   - Audit paging.
6. `savedTeams.pg.test.js`: CRUD, duplicate team name 409, cascade deletes, roster PUT (validation rows, keeps ids, removes missing, foreign id 400, bumps version), bundle shape.
7. `scorerAccounts.e2e.test.js` (boots `server.js`):
   - Pending flow: sign-up gives `roles = []`. `/api/db` non-test insert → 403 `OV_SCORER_REQUIRED`, test insert → 200. A scoresheet upload → 403, a backup upload → 200.
   - Redeem invite → the same insert → 200.
   - Two scorers: B's insert for A's game/season → 409 with `claim.scorer_name` = A's name, `mine:false` and no PIN, email or `external_id` in the body; audit `match.game_taken` written once. B `restore-by-pin` (gameN + PIN) → editor, then B can write A's match.
   - Closing: an approved update → `closed_at` set and audit `match.close` with the actor. A later set insert or event upsert → 409. `/api/match/restore` of that match → 409, and nothing changed. Approved → final → 200.
   - Admin: reopen → B can write again. A non-admin calling every `/api/admin/*` route → 403. An anonymous `GET /api/saved-teams` → 401, pending → 403, scorer → 200. A scorer's POST → 403, a competition_manager's → 201.
   - `/api/db` with `table: 'competitions'` (and the other new tables) → 400 `OV_INVALID_REQUEST` for select and write.
   - `/api/verify-reopen-password` → 404.
   - An `OPTIONS` preflight lists PATCH.

### Frontend (`cd escoresheet/frontend && npx vitest run`)
1. `src/lib/__tests__/access.test.js`, plus `src/domain/__tests__/season.test.js` (the same cases as the backend).
2. `src/domain/__tests__/savedTeams.test.js`: liberos (0/1/2/3), captain, inactive excluded, DOB conversion both ways, Coach ensured, licence and id preservation in `rosterToSavedRoster`, suggestion ranking (vm_leagues, then season, then updated_at; svrz name vs name; archived excluded).
3. `src/db/__tests__/savedTeamsCache.test.js` (fake-indexeddb): refresh replaces, the 10-min skip, the user switch clears, 403 clears, offline returns the cache.
4. `src/hooks/__tests__/useSyncQueue.test.js` additions:
   - The closing update is held while an older set or event is queued and released after.
   - `OV_GAME_TAKEN`, `OV_SCORER_REQUIRED` and `OV_MATCH_CLOSED` set `cloudBlock` (with `claim`), and a later success clears it.
   - `ov-access-changed {canScore:true}` requeues `failed`.
5. `src/components/__tests__/MatchEndReopen.test.jsx`: test match is local; never-synced approval → jobs superseded and nothing queued; closed + scorer → admin-only modal; closed + admin → `reopenMatch` called then local reopen; already reopened on the server → local; offline → needs-connection; no reference to `VITE_REOPEN_PASSWORD_HASH` remains (grep test).
6. `src/i18n/__tests__/localeKeys.test.js` (new, guards the known bug class): every key of the `access`, `manage`, `savedTeams` and `cloudBlock` namespaces, plus the new `matchSetup.*` and `matchEnd.*` keys listed in 6.9, exists as a non-empty string in all five locales. The removed `matchEnd.unlock*` keys exist in none. No German value contains `ß`.
7. Component smoke tests:
   - `ManageConsole`: tabs per access (admin sees 6, competition manager sees 1); the invite code is shown once and gone after closing.
   - `SavedTeamPickerModal`: offline notice; replace confirm only when the roster is non-empty.

---

## 8. Open risks and decisions to watch
- **R1 Game-number uniqueness.** The key assumes VolleyManager game numbers are unique within a season across all leagues, and that the season turns on 1 July (Zurich). If a number repeats inside a season, admins use "Release game". Confirm with real VM data before the next season.
- **R2 Wrong game number or date.** A scorer who types a wrong `game_n` claims somebody else's game. The second scorer sees the claimant's name. An admin resolves it (release game, add editor).
- **R3 Friendlies.** Matches without `game_n` are unconstrained (by design).
- **R4 Order of jobs from old clients.** Clients without the 6.7(1) fix may send the approval before the last sets or events (`RESOURCE_ORDER` is match first). The late children then get 409 and park as `failed`. Ship the frontend with or before the backend, and the admin can reopen and let the client resync. A server-side grace window was considered and rejected (it weakens the lock).
- **R5 `match_live_state` is not locked by closing.** It is ephemeral display data; only the approval rule applies to it. Say so in the README. *Superseded after review:* 007 locks it with `match_live_state_closed_guard` (livescore must not show a closed match as live), and the relay publishes nothing for a closed match. The relay itself stays PIN-gated (sockets carry no session), outside the approved-scorer rule; it stores nothing.
- **R6 (after review) the declared key.** The client declares the season through `scheduled_at`; `created_at` is server-only on `/api/db`. An exemption ends when the match's key changes (`ov_matches_guard`). For indoor games in `svrz_games` the server also checks VolleyManager's season for a new key. A match sent without `game_n` is not an official game for the server.
- **R6 Pending accounts' queued jobs** are refused and retried hourly (up to 24 times). After approval, `ov-access-changed` requeues them. A device that stays offline across the approval needs one profile refresh first.
- **R7 Personal data in Dexie** (DOB, licence) on shared venue tablets: cleared on sign-out and account switch only. Venue tablets should sign out after use (documented in the user guide).
- **R8 Production migration.** It needs the 4 existing matches checked. If any is `approved`/`final` it becomes closed (intended). Duplicates are only reported. Roles are untouched: the one admin and one scorer keep theirs. Do not run it on production as part of this work (owner runs it).
- **R9 Access cache is per process** (30 s). There is one backend process today. Role changes invalidate it immediately in the same process.
- **R10 Invite hashes are unsalted SHA-256 of 60-bit random codes.** That is acceptable for short-lived, use-limited codes. Revoke on suspicion.
- **R11 Admin approval is needed even for admins' own new test accounts**, which is intended.

## 9. Work split and order
- **Backend agent:** 007 (verbatim) → `access.js`, `officialGame.js` → pgQuery and matchRestore changes → `accounts.js`, `savedTeams.js` → server.js routes and wiring → tests → README and deploy docs. Commit per step (conventional messages, explicit paths, never `node_modules`).
- **Frontend agent:** `access.js`/`season.js`/`savedTeams` domain + tests → `apiRequest` + `accountApi.js` → Dexie v19 + cache → AuthContext / pending banner / UserButton → sync queue changes → MatchEnd reopen → MatchSetup (picker, suggestions, check, save) → ManageConsole panels → i18n (5 files) + key test.
- Both agents follow sections 1, 2 and 5 exactly. Anything not covered here gets the smallest change that fits the existing code, noted in the commit message.
