-- 035_game_rosters_scope.sql: a roster sent ahead (db/023) belongs to its
-- game, club and team, keeps who signed it ahead and on what, and expires.
--
-- 1. club_id / team_id: the sending team (lib/teams.js putRoster). Removing
--    the team or the club deletes its rosters (ON DELETE CASCADE). Rows
--    from before are filled in from club_teams by the team's name.
-- 2. used_match_id: the match that accepted the roster (lib/teams.js
--    markUsed). Accepting no longer empties the row; it goes at expires_at.
-- 3. coach_/captain_signed_hash, _signed_by: a signature made ahead holds a
--    hash of the players and staff it was made on and the account that sent
--    it. A signature re-sent with another roster is dropped (putRoster).
-- 4. expires_at: 14 days after the game day (56 days after the last change
--    without a kickoff); lib/teams.js sweep() deletes on it, on a timer.
--
-- Idempotent; safe on a database with data.

BEGIN;

ALTER TABLE public.game_rosters
  ADD COLUMN IF NOT EXISTS club_id uuid REFERENCES public.clubs(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES public.club_teams(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS used_match_id uuid REFERENCES public.matches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS coach_signed_hash text,
  ADD COLUMN IF NOT EXISTS captain_signed_hash text,
  ADD COLUMN IF NOT EXISTS coach_signed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS captain_signed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

UPDATE public.game_rosters r SET club_id = ct.club_id, team_id = ct.id
  FROM public.club_teams ct
 WHERE r.team_id IS NULL AND lower(btrim(ct.team_name)) = lower(btrim(r.team_name));

-- rows no team claims any more: their team is gone
DELETE FROM public.game_rosters WHERE team_id IS NULL;

-- signatures from before carry no hash: the sender is the last writer
UPDATE public.game_rosters SET coach_signed_by = updated_by WHERE coach_signature IS NOT NULL AND coach_signed_by IS NULL;
UPDATE public.game_rosters SET captain_signed_by = updated_by WHERE captain_signature IS NOT NULL AND captain_signed_by IS NULL;

UPDATE public.game_rosters
   SET expires_at = CASE WHEN kickoff ~ '^\d{4}-\d{2}-\d{2}'
                         THEN (left(kickoff, 10)::date + 15)::timestamp AT TIME ZONE 'Europe/Zurich'
                         ELSE updated_at + interval '56 days' END
 WHERE expires_at IS NULL;

CREATE INDEX IF NOT EXISTS game_rosters_expires_idx ON public.game_rosters (expires_at);
CREATE INDEX IF NOT EXISTS game_rosters_team_idx ON public.game_rosters (team_id);

COMMENT ON TABLE public.game_rosters IS 'A team''s roster of one game, sent before the match exists; read by the home club''s scorers, the match holder and the team; deleted at expires_at (db/023, db/035).';

COMMIT;
