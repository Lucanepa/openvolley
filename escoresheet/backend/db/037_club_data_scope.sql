-- 037_club_data_scope.sql: a club's licence lists per season, and a row id
-- for each person of a list (docs/club-licences-spec.md).
--
-- Until now a list stayed until the next upload: people who left the club
-- stayed readable by its team managers and on its scoring tablets for as
-- long as nobody uploaded a new export. And the manager's page of a person
-- was keyed by the licence number, which then stayed in the browser's
-- history of a shared laptop.
--
-- club_licences.season  the season (its first year: July to June, Europe/Zurich,
--                       as lib/officialGame.js seasonOf) of the upload or the
--                       hand-added row. lib/licences.js serves the rows of the
--                       current season only, and its sweep (server.js, daily)
--                       deletes the rows of past seasons. The rows of before
--                       take the season of their imported_at; the default is
--                       the season of now(), so a backend of before this file
--                       still writes rows of the current season.
-- club_licences.id      a row id: My club's page of a person and the delete of
--                       one hand-added row (DELETE /api/club/:id/licences/rows/:id)
--                       use it, never the licence number.
--
-- roles.sql: no change (table-level grants cover new columns); run
-- apply-roles.sh after this file as with every migration all the same.
-- Still not on the /api/db allowlist, never public, never anonymous.
--
-- Idempotent and safe on a database with data (each step skips what is
-- there). Deploy: the migration runner (deploy.sh) before the backend image.
-- A backend of before 037 works on it (both columns have defaults; it reads
-- every season). The backend of 037 on a database without it reads every
-- row as one of the current season.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.club_licences ADD COLUMN IF NOT EXISTS season integer;
UPDATE public.club_licences
   SET season = extract(year FROM (imported_at AT TIME ZONE 'Europe/Zurich'))::int
                - CASE WHEN extract(month FROM (imported_at AT TIME ZONE 'Europe/Zurich')) < 7 THEN 1 ELSE 0 END
 WHERE season IS NULL;
ALTER TABLE public.club_licences
  ALTER COLUMN season SET DEFAULT (extract(year FROM (now() AT TIME ZONE 'Europe/Zurich'))::int
                                   - CASE WHEN extract(month FROM (now() AT TIME ZONE 'Europe/Zurich')) < 7 THEN 1 ELSE 0 END),
  ALTER COLUMN season SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'club_licences_season_check' AND conrelid = 'public.club_licences'::regclass) THEN
    ALTER TABLE public.club_licences ADD CONSTRAINT club_licences_season_check CHECK (season BETWEEN 2000 AND 2100);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS club_licences_season_idx ON public.club_licences (season);

ALTER TABLE public.club_licences ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid();
UPDATE public.club_licences SET id = gen_random_uuid() WHERE id IS NULL;
ALTER TABLE public.club_licences ALTER COLUMN id SET DEFAULT gen_random_uuid(), ALTER COLUMN id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS club_licences_id_uidx ON public.club_licences (id);

COMMENT ON COLUMN public.club_licences.season IS 'The season (first year, July to June) of the upload or hand-added row; only the current season is served, past seasons are deleted daily (db/037).';
COMMENT ON COLUMN public.club_licences.id IS 'Row id: the manager''s person page and the delete of one hand-added row, never the licence number (db/037).';

COMMIT;
