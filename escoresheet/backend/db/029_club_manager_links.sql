-- 029_club_manager_links.sql: a club manager link, an invite code that makes
-- whoever redeems it a manager of one club (lib/accounts.js redeemClubLink).
--
-- Owner, 2026-11-11: "in clubs settings: managers can be picked from members
-- of that club, and if not, send a link to sign up on the manager. So no
-- random emails only". An admin picks a club's managers from the accounts
-- linked to the club (its scorers, its team managers, its managers); anyone
-- else gets this link by mail (lib/clubs.js inviteManager).
--
-- invite_codes: role 'club_manager' with its club_id, no team, indoor only,
-- next to db/023's team_manager. The role CHECK of db/023 is replaced by one
-- that also allows it (same name).
--
-- roles.sql: no change; run apply-roles.sh after this file as with every
-- migration all the same. Idempotent. Deploy: 029, apply-roles.sh, the
-- backend image, the manager. A backend without this file refuses to make a
-- club manager link (the CHECK), everything else works as before.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'invite_codes_role_team_check' AND conrelid = 'public.invite_codes'::regclass
                    AND pg_get_constraintdef(oid) LIKE '%club_manager%') THEN
    ALTER TABLE public.invite_codes DROP CONSTRAINT IF EXISTS invite_codes_role_team_check;
    ALTER TABLE public.invite_codes ADD CONSTRAINT invite_codes_role_team_check CHECK (
      (role IN ('scorer', 'referee', 'competition_manager') AND team_id IS NULL)
      OR (role = 'team_manager' AND team_id IS NOT NULL AND sport = 'indoor')
      OR (role = 'club_manager' AND team_id IS NULL AND club_id IS NOT NULL AND sport = 'indoor'));
  END IF;
END $$;

COMMIT;
