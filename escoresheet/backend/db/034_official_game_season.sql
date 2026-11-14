-- 034_official_game_season.sql: the season of the one-match-per-official-game
-- key comes from the server, and the club rule is on unless an admin switched
-- it off.
--
-- 1. Season. db/007's matches_official_game_uidx keyed an official indoor
-- match on (game_n, season of coalesce(scheduled_at, created_at)), and
-- scheduled_at is the client's: a second scorer that gave its match a
-- kick-off in another season filed a second official match of the same game
-- (both closed, both mailed as the game's result). Now the season is a column
-- the server sets, matches.official_season (ov_matches_derive_official_season,
-- a BEFORE trigger; a client value is never kept):
--   - a new match, and a match whose game_n or sport changes: the season of
--     VolleyManager's kick-off of that game number (the newest svrz_games
--     row, as db/018's club rule reads the home team), else of the server's
--     clock;
--   - any other update keeps the stored season.
-- Rows stored before this file keep the key they had: official_season is
-- filled with the season of coalesce(scheduled_at, created_at), so the index
-- built on it holds exactly the rows it held before (no row is refused or
-- freed by this file). lib/officialGame.js findClaim compares the same column
-- (the friendly pre-check of /api/db and the restore), with the season a new
-- match gets from officialSeasonOf (the trigger's twin).
-- The trigger sorts before matches_guard (db/007), which compares a closed
-- match's whole row: a client value for the column is gone before that.
--
-- 2. Club rule (db/018). It was off until an admin turned it on, so any
-- approved scorer could take another club's official game first. It is now
-- on unless an admin switched it off: the column default is true, a missing
-- row is put back on, and the row 018 created that no admin ever changed
-- (changed_at NULL) is turned on. A rule an admin switched off stays off (the
-- manager's Clubs tab warns while it is off).
--
-- roles.sql: no change (ov_app reads svrz_games already; the trigger runs as
-- the writer). Run apply-roles.sh after this file as with every migration.
--
-- Idempotent and safe on a database with data. Deploy: deploy/deploy.sh
-- (scripts/migrate.mjs) before the new backend; the matches table is locked
-- briefly while the column is filled and the index rebuilt. With part 2 the
-- club rule is ON after this file unless an admin set it: every scorer
-- without a club, and every game not in the VolleyManager schedule, is then
-- refused for official games. Check the clubs and their scorers first, or
-- switch the rule off in the manager before the deploy (it then stays off).
BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1. The official-game season ---------------------------------------------------------
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS official_season integer;

COMMENT ON COLUMN public.matches.official_season IS
  'Season of the official-game key (db/034): set by the server (VolleyManager''s kick-off of game_n, else the server clock), never the client.';

-- The season (an integer year: 2026-07 .. 2027-06 is 2026) a new match, or
-- one moved to another game number or sport, gets: VolleyManager's kick-off of
-- that game (the newest svrz_games row; a time without a zone is a
-- Europe/Zurich wall-clock time, lib/vmSync.js), else the server's clock; a
-- kick-off Postgres cannot read counts as none. lib/officialGame.js
-- officialSeasonOf is its twin. Self-contained: the app role may call no
-- function (roles.sql), a trigger function runs all the same.
CREATE OR REPLACE FUNCTION public.ov_matches_derive_official_season()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  vm text;
  local_ts timestamp;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.game_n IS NOT DISTINCT FROM OLD.game_n
     AND NEW.sport_type IS NOT DISTINCT FROM OLD.sport_type THEN
    NEW.official_season := OLD.official_season; -- the key stays (also a row from before this file)
    RETURN NEW;
  END IF;
  IF NEW.game_n IS NOT NULL AND NEW.game_n > 0 AND NEW.sport_type IS DISTINCT FROM 'beach'
     AND to_regclass('public.svrz_games') IS NOT NULL THEN
    EXECUTE 'SELECT g.datetime::text FROM public.svrz_games g WHERE g.game_number = $1 AND g.datetime IS NOT NULL ORDER BY g.id DESC LIMIT 1'
      INTO vm USING NEW.game_n::text;
    -- lib/vmSync.js VM_DATETIME_RE
    IF vm ~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-](0\d|1[0-4])(:?[0-5]\d)?)?$' THEN
      BEGIN
        local_ts := CASE WHEN vm ~ '(Z|[+-](0\d|1[0-4])(:?[0-5]\d)?)$'
                         THEN vm::timestamptz AT TIME ZONE 'Europe/Zurich'
                         ELSE vm::timestamp END;
      EXCEPTION WHEN others THEN
        local_ts := NULL; -- 2026-02-30T..: no kick-off
      END;
    END IF;
  END IF;
  local_ts := coalesce(local_ts, now() AT TIME ZONE 'Europe/Zurich');
  NEW.official_season := date_part('year', local_ts)::int - CASE WHEN date_part('month', local_ts) < 7 THEN 1 ELSE 0 END;
  RETURN NEW;
END
$$;

-- The rows stored before: the season their key had (db/007's expression).
-- The other triggers are off meanwhile (no updated_at, closed-match guard or
-- audit for this bookkeeping), as in db/007.
ALTER TABLE public.matches DISABLE TRIGGER USER;
UPDATE public.matches
   SET official_season = date_part('year', (coalesce(scheduled_at, created_at) AT TIME ZONE 'Europe/Zurich'))::int
         - CASE WHEN date_part('month', (coalesce(scheduled_at, created_at) AT TIME ZONE 'Europe/Zurich')) < 7 THEN 1 ELSE 0 END
 WHERE official_season IS NULL AND coalesce(scheduled_at, created_at) IS NOT NULL;
ALTER TABLE public.matches ENABLE TRIGGER USER;

DROP TRIGGER IF EXISTS matches_derive_official_season ON public.matches;
CREATE TRIGGER matches_derive_official_season
  BEFORE INSERT OR UPDATE ON public.matches
  FOR EACH ROW EXECUTE FUNCTION public.ov_matches_derive_official_season();

-- The index on the server's season (db/013's predicate). Built in this
-- transaction: the old one stays in force until the new one commits.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
              WHERE c.relname = 'matches_official_game_uidx' AND i.indrelid = 'public.matches'::regclass
                AND pg_get_indexdef(i.indexrelid) LIKE '%official_season%') THEN
    RAISE NOTICE '034: matches_official_game_uidx already keys on official_season';
    RETURN;
  END IF;
  DROP INDEX IF EXISTS public.matches_official_game_uidx;
  CREATE UNIQUE INDEX matches_official_game_uidx ON public.matches (
    (sport_type IS NOT DISTINCT FROM 'beach'),
    game_n,
    official_season
  ) WHERE test IS NOT TRUE AND game_n IS NOT NULL AND game_n > 0 AND NOT official_game_exempt
      AND sport_type IS DISTINCT FROM 'beach';
END $$;

-- 2. The club rule is on unless switched off ----------------------------------------
ALTER TABLE public.club_rule ALTER COLUMN enabled SET DEFAULT true;
INSERT INTO public.club_rule (id, enabled) VALUES (true, true) ON CONFLICT (id) DO NOTHING;
UPDATE public.club_rule SET enabled = true WHERE id AND NOT enabled AND changed_at IS NULL;

COMMIT;
