-- 051_referee_licences.sql: the referees' licence numbers in the schedule
--
-- Owner 2026-11-19/20: a Swiss sheet's value beside a name is the licence
-- number. VolleyManager's referee-game search (lib/vmSync.js, the same
-- endpoint svrz_rc's games sync reads) carries each convocation's person with
-- `associationId`, the Swiss Volley number (SV-Nr.; `externalId` holds the
-- same number). The sync now stores the first and second referee's:
--   svrz_games.referee_1_licence, referee_2_licence: text, 4 to 7 digits, or
--   NULL (no convocation, or a value that is not such a number).
-- Not public: /api/db answers them to the accounts that fill a sheet's
-- officials only (admins and indoor scorers; never anonymously,
-- lib/publicColumns.js keeps them out of ANON_DB_COLUMNS), and GET
-- /api/games/today to those accounts only. Match Setup's "Load official
-- match" fills referee 1 / 2's value with them.
--
-- Safe while the old backend serves: two NULL columns, nothing reads them
-- (its schedule sync does not name them). Idempotent; one transaction
-- (scripts/migrate.mjs); waits at most lock_timeout for svrz_games.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('public.svrz_games') IS NULL THEN
    RETURN;
  END IF;
  ALTER TABLE public.svrz_games
    ADD COLUMN IF NOT EXISTS referee_1_licence text,
    ADD COLUMN IF NOT EXISTS referee_2_licence text;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.svrz_games'::regclass AND conname = 'svrz_games_referee_1_licence_check') THEN
    ALTER TABLE public.svrz_games ADD CONSTRAINT svrz_games_referee_1_licence_check
      CHECK (referee_1_licence IS NULL OR referee_1_licence ~ '^[0-9]{4,7}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.svrz_games'::regclass AND conname = 'svrz_games_referee_2_licence_check') THEN
    ALTER TABLE public.svrz_games ADD CONSTRAINT svrz_games_referee_2_licence_check
      CHECK (referee_2_licence IS NULL OR referee_2_licence ~ '^[0-9]{4,7}$');
  END IF;
  COMMENT ON COLUMN public.svrz_games.referee_1_licence IS
    'The first referee''s licence number (VolleyManager person.associationId, 4 to 7 digits; db/051). Not public: scorers and admins only.';
  COMMENT ON COLUMN public.svrz_games.referee_2_licence IS
    'The second referee''s licence number (VolleyManager person.associationId, 4 to 7 digits; db/051). Not public: scorers and admins only.';
END $$;

COMMIT;
