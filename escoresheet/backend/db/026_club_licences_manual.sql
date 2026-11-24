-- 026_club_licences_manual.sql: people a team or club manager added to the
-- club's licence lists by hand (docs/club-licences-spec.md section 8).
--
-- Owner, 2026-11-10: "if I add somebody manually, when saving ask if I want
-- to save him/her in the club. Those from the club/recognized/linked -> green
-- shield. Those added manually -> gray shield, but can be linked later."
-- Decisions:
--   a. after a squad is saved, the manager is offered to add the people typed
--      in by hand (with a licence number) to the club's lists: the same five
--      fields as an import (licence number, names, date of birth, gender);
--   b. source 'manual' marks such a row; every other row is 'import' (the
--      VolleyManager upload, db/024);
--   c. an upload replaces the imported rows of its list and keeps the manual
--      ones; a manual row whose licence number is in an upload becomes an
--      imported row ("linked later"). Delete list (an empty upload) removes
--      both;
--   d. the privacy policy says so (privacy 1.12).
--
-- club_licences.source: 'import' (the default, every row of before) or
-- 'manual'. lib/licences.js addPeople writes 'manual' rows (never over an
-- existing row), putList 'import' rows.
--
-- roles.sql: no change (table-level grants, a new column is covered); run
-- apply-roles.sh after this file as with every migration all the same.
-- Still not on the /api/db allowlist, never public, never anonymous.
--
-- Idempotent. Deploy: 026, apply-roles.sh, the backend image, the manager.
-- A backend of before 026 works on it (the column has its default; its
-- upload replaces the manual rows of the list too). The backend of 026 on a
-- database without it reads every row as imported and answers 503 to an
-- upload and to the hand-added routes, so run 026 first.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.club_licences ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'import';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'club_licences_source_check' AND conrelid = 'public.club_licences'::regclass) THEN
    ALTER TABLE public.club_licences ADD CONSTRAINT club_licences_source_check CHECK (source IN ('import', 'manual'));
  END IF;
END $$;

COMMENT ON COLUMN public.club_licences.source IS 'import: from the VolleyManager upload of the list; manual: added by hand by a team or club manager from a roster, until an upload contains it (db/026).';
COMMENT ON TABLE public.club_licences IS 'A club''s licence lists from VolleyManager (players, scorers, coaches): licence number, names, date of birth, gender only; each upload replaces the imported rows of its list, rows added by hand stay (db/024, db/026).';

COMMIT;
