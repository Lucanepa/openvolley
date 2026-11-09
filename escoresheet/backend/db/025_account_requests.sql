-- 025_account_requests.sql: what a new account asks for at sign-up, so that
-- an approver only approves (docs/account-approval-spec.md section 8).
--
-- Owner, 2026-11-09: "when somebody signs up -> scorer, referee, team/club
-- manager, what team(s) and clubs etc? so that i just approve rather than that
-- also add their roles and clubs". Decisions:
--   a. the admin approves everything, AND it cascades: the managers of a club
--      approve the requests of their own club (scorer, team manager of one of
--      its teams, club manager), the managers of a team the team manager
--      requests of their team; referee requests are the admin's only;
--   b. competition manager cannot be asked for at sign-up (admin-granted);
--   c. the privacy policy says so (privacy 1.11).
--
-- account_requests: one row per part of a request ("scorer for VBC
-- Musterdorf", "team manager of VBC Musterdorf H1", "referee"). Nothing is
-- granted at sign-up. Approving a part grants exactly what the admin tools
-- grant (lib/accountRequests.js): scorer = the scorer role and the club
-- (account_clubs, db/018), referee = the referee role, team_manager = a
-- team_managers row (db/023), club_manager = a club_managers row (db/020).
-- A row is deleted when it is approved or rejected, and with the account, the
-- club or the team (ON DELETE CASCADE). A team_manager row names the team and
-- that team's own club (the composite key below), so the club's managers see
-- it.
--
-- roles.sql: no change (ov_app's default privileges cover new tables); run
-- apply-roles.sh after this file as with every migration all the same.
-- Not on the /api/db allowlist (server.js ALLOWED_TABLES), never public:
-- only lib/accountRequests.js and lib/auth.js (sign-up) read and write it.
--
-- Idempotent. Deploy: 025, apply-roles.sh, the backend image, the manager.
-- A backend without this file stores no request (sign-up works as before).
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.account_requests (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind        text        NOT NULL CHECK (kind IN ('scorer', 'referee', 'team_manager', 'club_manager')),
  club_id     uuid        REFERENCES public.clubs(id) ON DELETE CASCADE,
  team_id     uuid        REFERENCES public.club_teams(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- referee: no club, no team; scorer and club manager: a club, no team;
  -- team manager: a team and its club
  CONSTRAINT account_requests_part_check CHECK (
    (kind = 'referee' AND club_id IS NULL AND team_id IS NULL)
    OR (kind IN ('scorer', 'club_manager') AND club_id IS NOT NULL AND team_id IS NULL)
    OR (kind = 'team_manager' AND club_id IS NOT NULL AND team_id IS NOT NULL))
);

-- A team manager request names the team's own club
CREATE UNIQUE INDEX IF NOT EXISTS club_teams_id_club_uidx ON public.club_teams (id, club_id);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_requests_team_club_fkey' AND conrelid = 'public.account_requests'::regclass) THEN
    ALTER TABLE public.account_requests ADD CONSTRAINT account_requests_team_club_fkey
      FOREIGN KEY (team_id, club_id) REFERENCES public.club_teams (id, club_id) ON DELETE CASCADE;
  END IF;
END $$;

-- One row per part
CREATE UNIQUE INDEX IF NOT EXISTS account_requests_part_uidx ON public.account_requests
  (user_id, kind, coalesce(club_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS account_requests_club_idx ON public.account_requests (club_id);
CREATE INDEX IF NOT EXISTS account_requests_team_idx ON public.account_requests (team_id);

COMMENT ON TABLE public.account_requests IS 'What an account asked for at sign-up (scorer, referee, team or club manager, with the club and team); deleted when approved or rejected (db/025).';

COMMIT;
