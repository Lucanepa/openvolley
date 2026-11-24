-- 013_beach_official_index.sql: beach matches leave the season-wide
-- official-game index (~/ov-ops/openbeach-separation-tournaments-PLAN.md,
-- section 1.2, phase T1).
--
-- db/007's matches_official_game_uidx keys a non-test match on (beach or not,
-- game_n, season). Beach game numbers restart at 1 with every tournament, and
-- the season splits in July, so game 1 of the second tournament of a summer
-- was refused with OV_GAME_TAKEN. For beach, "official" now means "linked to a
-- tournament match" (db/014): one scored match per tournament match
-- (matches.tournament_match_id, unique) and one game number per tournament
-- (beach_tmatches (tournament_id, game_n), unique). Indoor keeps the index
-- exactly as it was: the same key expression, the same predicate plus
-- "not beach".
--
-- lib/officialGame.js findClaim() answers "free" for beach from this
-- migration on (the friendly pre-check must not refuse what the index allows).
--
-- Run as ov_owner after 012 (restore.sh runs every db/NNN_*.sql with
-- NNN >= 003 in numeric order). Idempotent: a re-run leaves an index that
-- already excludes beach alone. One transaction: the old index stays in force
-- until the new one is built (the drop and the build commit together; writes
-- to matches wait for the build, which is short on this table).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE pred text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'matches' AND column_name = 'sport_type') THEN
    RAISE NOTICE '013: public.matches has no sport_type column; the official-game index is left alone';
    RETURN;
  END IF;
  -- the predicate (WHERE ...) of the index: 007's never names beach
  SELECT pg_get_expr(i.indpred, i.indrelid) INTO pred
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname = 'matches_official_game_uidx' AND i.indrelid = 'public.matches'::regclass;
  IF pred IS NOT NULL AND pred LIKE '%beach%' THEN
    RAISE NOTICE '013: matches_official_game_uidx already excludes beach';
    RETURN;
  END IF;
  DROP INDEX IF EXISTS public.matches_official_game_uidx;
  -- db/007's key, unchanged (indoor and NULL rows: the first column is false)
  CREATE UNIQUE INDEX matches_official_game_uidx ON public.matches (
    (sport_type IS NOT DISTINCT FROM 'beach'),
    game_n,
    ((date_part('year', (coalesce(scheduled_at, created_at) AT TIME ZONE 'Europe/Zurich'))::int
      - CASE WHEN date_part('month', (coalesce(scheduled_at, created_at) AT TIME ZONE 'Europe/Zurich')) < 7 THEN 1 ELSE 0 END))
  ) WHERE test IS NOT TRUE AND game_n IS NOT NULL AND game_n > 0 AND NOT official_game_exempt
      AND sport_type IS DISTINCT FROM 'beach';
END $$;

COMMIT;
