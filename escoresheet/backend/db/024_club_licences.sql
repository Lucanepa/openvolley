-- 024_club_licences.sql: a club's licence lists from VolleyManager's club
-- administration (docs/club-licences-spec.md).
--
-- Owner decisions 2026-11-09:
--   a. club managers upload the XLSX exports of VolleyManager's club
--      administration (players, scorers, coaches); "just import dob, licence n,
--      name, last name, that's all we need", and the gender, "so we can divide
--      the players in genders and a player can't play in the wrong gender";
--   b. nothing else of the export is read, sent or stored: the file is read in
--      the browser (src/utils/vmLicenceExport.js) and only these five fields
--      reach the server;
--   c. team managers add players of the club to their rosters from it, and
--      the scorer's Match Setup too, from a copy on the tablet (offline first).
--
-- club_licences: one row per person of one list of one club. Each upload
-- replaces that list (lib/licences.js putList, one transaction); the rows go
-- with the club (ON DELETE CASCADE). imported_by is set NULL when that account
-- is deleted.
--
-- roles.sql: no change (ov_app's default privileges cover new tables); run
-- apply-roles.sh after this file as with every migration all the same.
-- Not on the /api/db allowlist (server.js ALLOWED_TABLES), never public, never
-- anonymous: only lib/licences.js and lib/teams.js read it.
--
-- Idempotent. Deploy: 024, apply-roles.sh, the backend image, the manager,
-- then the scorer apps. Old apps never ask for the club's licences.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.club_licences (
  club_id     uuid        NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  list        text        NOT NULL CHECK (list IN ('players', 'scorers', 'coaches')),
  sv_number   text        NOT NULL CHECK (sv_number ~ '^[0-9]{4,7}$'),
  last_name   text        NOT NULL CHECK (length(btrim(last_name)) BETWEEN 1 AND 100),
  first_name  text        CHECK (first_name IS NULL OR length(first_name) <= 100),
  dob         date,
  gender      text        CHECK (gender IS NULL OR gender IN ('m', 'f')),
  imported_at timestamptz NOT NULL DEFAULT now(),
  imported_by uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  PRIMARY KEY (club_id, list, sv_number)
);
CREATE INDEX IF NOT EXISTS club_licences_club_sv_idx ON public.club_licences (club_id, sv_number);

COMMENT ON TABLE public.club_licences IS 'A club''s licence lists from VolleyManager (players, scorers, coaches): licence number, names, date of birth, gender only; each upload replaces its list (db/024).';

COMMIT;
