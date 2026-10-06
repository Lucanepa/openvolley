-- 005_match_ownership.sql: who may write a match (Phase 7 security release)
--
-- matches.created_by  the account whose session inserted the row first. The
--                     backend sets it (pgQuery ownership guard); a client
--                     value is dropped (WRITE_DENYLIST). NULL for every row
--                     that existed before this file ran: their owner is not
--                     known (user_matches links are written by the client for
--                     any external_id, so they prove nothing), and such rows
--                     are read-only for everyone but an admin
--                     (profiles.roles contains 'admin' or 'super_admin').
-- match_editors       further accounts that may write a match: added by the
--                     backend only, when a signed-in caller proves the
--                     match's game PIN (POST /api/match/claim, or
--                     /api/match/restore-by-pin with a session).
--
-- Writes to matches, sets, events and match_live_state (and /api/match/restore)
-- need the creator, an editor or an admin; everyone else gets 403
-- OV_NOT_MATCH_OWNER. Reads are unchanged.
--
-- An account deleted later leaves its matches without an owner (ON DELETE SET
-- NULL): read-only except for admins and editors, like the legacy rows.
--
-- Run as ov_owner after 004 (restore.sh runs every db/NNN_*.sql with NNN >= 003
-- in numeric order), then roles.sql (ov_app gets DML on match_editors through
-- the schema-wide grant). Idempotent.

ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS created_by uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'matches_created_by_fkey' AND conrelid = 'public.matches'::regclass
  ) THEN
    ALTER TABLE public.matches
      ADD CONSTRAINT matches_created_by_fkey FOREIGN KEY (created_by)
      REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS matches_created_by_idx ON public.matches (created_by);

CREATE TABLE IF NOT EXISTS public.match_editors (
  match_id uuid NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  granted_via text NOT NULL DEFAULT 'game_pin',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, user_id)
);

CREATE INDEX IF NOT EXISTS match_editors_user_idx ON public.match_editors (user_id);
