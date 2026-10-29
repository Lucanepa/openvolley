-- 020_club_managers.sql: club managers, and a contact address per club.
--
-- Owner decisions 2026-10-29 (~/ov-ops/club-manager-home-email-PLAN.md, step 2):
--   a. a club manager manages one club or a few, never every club: an admin
--      names them per club (the Clubs tab), as OpenBeach names a tournament's
--      co-managers (db/014 beach_tournament_managers);
--   b. for its own clubs a club manager makes invite codes (scorer or referee,
--      the club fixed, capped uses and lifetime), revokes them, sees the
--      club's members and removes one from the club: only the club link goes,
--      the account and its roles stay (it no longer scores that club's games);
--   c. the club's contact address (clubs.contact_email) gets the final
--      scoresheet of the club's games (step 4); the club manager keeps it up
--      to date.
--
-- No global role: profiles.roles is unchanged, so a club manager is no admin
-- anywhere else. account_clubs keeps meaning "scores for this club".
--
-- roles.sql: no change (ov_app's table grants cover new tables); run
-- apply-roles.sh after this file as with every migration all the same.
-- Not on the /api/db allowlist (server.js ALLOWED_TABLES): only lib/clubs.js
-- reads and writes it.
--
-- Idempotent. Deploy: 020, apply-roles.sh, the backend image, the manager.
BEGIN;

CREATE TABLE IF NOT EXISTS public.club_managers (
  club_id     uuid        NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  added_by    uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, user_id)
);
CREATE INDEX IF NOT EXISTS club_managers_user_idx ON public.club_managers (user_id);

ALTER TABLE public.clubs ADD COLUMN IF NOT EXISTS contact_email text
  CHECK (contact_email IS NULL OR (length(contact_email) BETWEEN 3 AND 254 AND contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'));

COMMENT ON TABLE public.club_managers IS 'Accounts that manage a club: its invite codes, members and contact (db/020).';
COMMENT ON COLUMN public.clubs.contact_email IS 'Where the final scoresheets of the club''s games go (db/020).';

COMMIT;
