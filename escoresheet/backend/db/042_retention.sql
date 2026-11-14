-- 042_retention.sql: match records end (privacy policy section 16).
--
-- Before: matches with their events, event history and approvals, the stored
-- scoresheet files and VolleyManager's assignments (svrz_games, with the
-- referees' dates of birth) were kept without end; nothing removed them.
--
-- Now public.app_settings.retention_years (default 2): a match is kept for
-- its season and that many seasons after it, then lib/retention.js's daily
-- sweep removes it with its rows (ON DELETE CASCADE, the db/016 trigger), the
-- scoresheet files of those days and the svrz_games rows of games before the
-- same day. Season S runs from 1 July S to 30 June S+1: with 2 years the
-- season 2024 (2024/25) goes on 1 July 2027.
--   The number of years is the owner's (privacy policy section 16 names it):
--   UPDATE public.app_settings SET retention_years = <n> WHERE id;  (1 to 30)
--   The sweep reads it on every run; no restart needed.
-- matches_season_idx: the sweep's query, on the expression lib/retention.js
-- uses (MATCH_SEASON_SQL), so the daily run reads no whole table.
--
-- roles.sql: no change (ov_app's table grants cover the new column; the sweep
-- runs as ov_app with ov.allow_closed, as the admin reopen does). Run
-- apply-roles.sh after this file as with every migration all the same.
-- app_settings is not on the /api/db allowlist.
-- Idempotent; one transaction (scripts/migrate.mjs). Safe while the old
-- backend serves: it never reads the column, and nothing is removed before
-- the new backend's first sweep (15 minutes after its start).
BEGIN;
SET LOCAL lock_timeout = '5s';

-- db/021 creates the table; a database without it gets it here (same shape)
CREATE TABLE IF NOT EXISTS public.app_settings (
  id                boolean     PRIMARY KEY DEFAULT true CHECK (id),
  send_final_email  boolean     NOT NULL DEFAULT false,
  changed_by        uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  changed_at        timestamptz
);
INSERT INTO public.app_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS retention_years integer NOT NULL DEFAULT 2;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'app_settings_retention_years_check' AND conrelid = 'public.app_settings'::regclass) THEN
    ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_retention_years_check
      CHECK (retention_years BETWEEN 1 AND 30);
  END IF;
END $$;

COMMENT ON COLUMN public.app_settings.retention_years IS
  'Seasons a match record is kept after its own (db/042, lib/retention.js): matches, their rows, scoresheet files and svrz_games of older seasons are removed daily.';

-- The sweep's season of a match: official_season (db/034), else the season of
-- coalesce(scheduled_at, created_at) (db/007's expression)
CREATE INDEX IF NOT EXISTS matches_season_idx ON public.matches ((
  coalesce(official_season,
           (date_part('year', (coalesce(scheduled_at, created_at) AT TIME ZONE 'Europe/Zurich'))::int
            - CASE WHEN date_part('month', (coalesce(scheduled_at, created_at) AT TIME ZONE 'Europe/Zurich')) < 7 THEN 1 ELSE 0 END))
));

COMMIT;
