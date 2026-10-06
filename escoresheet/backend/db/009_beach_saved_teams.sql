-- 009_beach_saved_teams.sql: saved teams for beach volleyball (OpenBeach).
--
-- competitions.sport ('indoor' | 'beach'; every existing row is indoor), the
-- season format per sport (indoor '2026/27', beach '2026'), and
-- competition_players.country (3 letters, e.g. 'CHE'; beach only, the API
-- enforces that). The beach roster rules (a pair numbered 1 and 2, no libero
-- or captain, staff = at most one Coach) are lib/savedTeams.js's.
--
-- Run as ov_owner after 008 (restore.sh runs every db/NNN_*.sql with
-- NNN >= 003 in numeric order), then roles.sql. Idempotent. One transaction.
-- No new table, sequence or function: ov_app's table-level grants already
-- cover the new columns, so roles.sql is unchanged.
-- Safe on live data and under the running 2.1.0 backend: it names its
-- columns, inserts no sport (default 'indoor') and no country (NULL).

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1. competitions.sport (constant default: no table rewrite)
ALTER TABLE public.competitions ADD COLUMN IF NOT EXISTS sport text NOT NULL DEFAULT 'indoor';

DO $$
DECLARE r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'competitions_sport_check' AND conrelid = 'public.competitions'::regclass) THEN
    ALTER TABLE public.competitions
      ADD CONSTRAINT competitions_sport_check CHECK (sport IN ('indoor', 'beach'));
  END IF;

  -- 2. The season format per sport replaces 007's column CHECK (indoor only)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'competitions_season_sport_check' AND conrelid = 'public.competitions'::regclass) THEN
    ALTER TABLE public.competitions
      ADD CONSTRAINT competitions_season_sport_check CHECK (
        (sport = 'indoor' AND season ~ '^\d{4}/\d{2}$') OR (sport = 'beach' AND season ~ '^\d{4}$'));
  END IF;
  FOR r IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.competitions'::regclass AND contype = 'c'
              AND conname NOT IN ('competitions_sport_check', 'competitions_season_sport_check')
              AND pg_get_constraintdef(oid) LIKE '%season%' LOOP
    EXECUTE format('ALTER TABLE public.competitions DROP CONSTRAINT %I', r.conname);
    RAISE NOTICE '009: dropped the indoor-only season check %', r.conname;
  END LOOP;

  -- 3. competition_players.country
  ALTER TABLE public.competition_players ADD COLUMN IF NOT EXISTS country text;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'competition_players_country_check' AND conrelid = 'public.competition_players'::regclass) THEN
    ALTER TABLE public.competition_players
      ADD CONSTRAINT competition_players_country_check CHECK (country IS NULL OR country ~ '^[A-Z]{3}$');
  END IF;
END $$;

COMMIT;
