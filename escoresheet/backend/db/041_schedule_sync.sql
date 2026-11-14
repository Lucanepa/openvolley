-- 041_schedule_sync.sql: what the VolleyManager schedule sync records
-- (lib/vmSync.js), and the saved-pair copy of a beach tournament entry
-- (lib/beachTournaments.js).
--
-- public.svrz_games (the official schedule):
--   league_category  VolleyManager's league category ("3. Liga", "U19
--                    Juniorinnen"). Recorded only: no rule reads it (owner
--                    decision 6, the same limits for every category).
--   junior_category  its isJuniorLeagueCategory; NULL when VolleyManager did
--                    not say. match_level ('junior' / 'senior') also takes an
--                    age class in the category's name (U13, U21, U23).
--   match_format     (unchanged column) from now on 3 for two_win_sets, 5 for
--                    three_win_sets and NULL for anything else: a format the
--                    sync does not know is never a silent best of 5.
-- public.svrz_games_removed: the games a complete sync run no longer got from
--   VolleyManager (cancelled, renumbered, or moved out of the sync window),
--   kicking off after the run. They leave svrz_games, so the club rule
--   (db/018 OVL03), today's home games and the schedule loader no longer
--   find them; the next run that gets them again puts them back. Only the
--   game's number, time, league, teams and hall: no referee data.
-- public.svrz_sync_log:
--   games_without_format  rows written with match_format NULL
--   games_removed         rows moved to svrz_games_removed
--
-- public.beach_entries:
--   pair_snapshot  {player1, player2} as copied from the entry's saved beach
--                  pair (db/009) when the entry was made. Drawing the bracket
--                  copies a player from the saved pair again only while the
--                  entry still holds this copy: a correction made on the entry
--                  (PATCH, an import, a player typed over the saved pair's)
--                  stays, and a saved pair without that player never empties
--                  it. NULL (entries made before this file, pairs linked by an
--                  import): never refreshed.
--
-- roles.sql: no change (ov_app's table grants cover the new table); run
-- apply-roles.sh after this file as with every migration all the same. Not on
-- the /api/db allowlist: only lib/vmSync.js reads and writes the new table.
--
-- Idempotent; adds nullable columns and one table, changes no row. The tables
-- of the schedule are guarded (a database without the sync has none of
-- them). Deploy as every migration (deploy.sh runs scripts/migrate.mjs): this
-- file before the backend that writes the columns; an older backend ignores
-- them. By hand:
--   docker exec -i ov-postgres psql -X -U ov_owner -d openvolley -v ON_ERROR_STOP=1 < db/041_schedule_sync.sql
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.svrz_games') IS NOT NULL THEN
    ALTER TABLE public.svrz_games ADD COLUMN IF NOT EXISTS league_category text;
    ALTER TABLE public.svrz_games ADD COLUMN IF NOT EXISTS junior_category boolean;
  END IF;
  IF to_regclass('public.svrz_sync_log') IS NOT NULL THEN
    ALTER TABLE public.svrz_sync_log ADD COLUMN IF NOT EXISTS games_without_format integer;
    ALTER TABLE public.svrz_sync_log ADD COLUMN IF NOT EXISTS games_removed integer;
  END IF;
  IF to_regclass('public.beach_entries') IS NOT NULL THEN
    ALTER TABLE public.beach_entries ADD COLUMN IF NOT EXISTS pair_snapshot jsonb;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.svrz_games_removed (
  game_number    text        PRIMARY KEY,
  datetime       text,
  league         text,
  team_home      text,
  team_away      text,
  hall           text,
  last_synced_at timestamptz,
  removed_at     timestamptz NOT NULL DEFAULT now(),
  sync_log_id    bigint
);

COMMENT ON TABLE public.svrz_games_removed IS 'Games a complete VolleyManager sync no longer returned (cancelled, renumbered or moved out of the window), out of svrz_games until a run returns them again (db/041).';

COMMIT;
