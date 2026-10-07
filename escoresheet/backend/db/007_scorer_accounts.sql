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
-- On a re-run after db/013 (whose index leaves beach out: beach game numbers
-- restart with every tournament) beach matches are not scanned either, so a
-- re-run never exempts a beach game 1 of a second tournament. The scan follows
-- the live index's predicate, read the way 013 reads it.
DO $$
DECLARE r record; n int := 0; pred text; skip_beach boolean;
BEGIN
  SELECT pg_get_expr(i.indpred, i.indrelid) INTO pred
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname = 'matches_official_game_uidx' AND i.indrelid = 'public.matches'::regclass;
  skip_beach := coalesce(pred LIKE '%beach%', false);
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
         AND NOT (skip_beach AND sport_type IS NOT DISTINCT FROM 'beach')
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
      -- An exemption (admin release-game, or a duplicate exempted above) holds
      -- for the official-game key it was given for: moving the match to
      -- another key puts it back under the unique index.
      -- (Key = the index's: beach or not, game_n, season; and test.)
      IF OLD.official_game_exempt AND NEW.official_game_exempt AND (
           NEW.game_n IS DISTINCT FROM OLD.game_n
           OR (NEW.test IS TRUE) IS DISTINCT FROM (OLD.test IS TRUE)
           OR (NEW.sport_type IS NOT DISTINCT FROM 'beach') IS DISTINCT FROM (OLD.sport_type IS NOT DISTINCT FROM 'beach')
           OR (date_part('year', (coalesce(NEW.scheduled_at, NEW.created_at) AT TIME ZONE 'Europe/Zurich'))::int
                 - CASE WHEN date_part('month', (coalesce(NEW.scheduled_at, NEW.created_at) AT TIME ZONE 'Europe/Zurich')) < 7 THEN 1 ELSE 0 END)
              IS DISTINCT FROM
              (date_part('year', (coalesce(OLD.scheduled_at, OLD.created_at) AT TIME ZONE 'Europe/Zurich'))::int
                 - CASE WHEN date_part('month', (coalesce(OLD.scheduled_at, OLD.created_at) AT TIME ZONE 'Europe/Zurich')) < 7 THEN 1 ELSE 0 END)) THEN
        NEW.official_game_exempt := false;
      END IF;
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
-- The stored live score of a closed match is frozen too (livescore reads it);
-- the admin reopen and restore run with ov.allow_closed or before the close.
DROP TRIGGER IF EXISTS match_live_state_closed_guard ON public.match_live_state;
CREATE TRIGGER match_live_state_closed_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.match_live_state
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
