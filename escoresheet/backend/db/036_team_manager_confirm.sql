-- 036_team_manager_confirm.sql: team managers confirmed by their club, no
-- club membership for team managers, club manager links bound to their
-- address, codes of a deleted club dead.
--
-- 1. Owner decision 3 (rollout audit, var-roleless-reads-2): a team manager
--    may say yes to a team manager request of its team, but that yes is a
--    proposal; the role comes only with the yes of a manager of the team's
--    club or an admin (lib/accountRequests.js decide). A proposed part stays
--    in account_requests with proposed_by / proposed_at until then; the
--    club's managers get a notice (notifications kind
--    'team_manager_proposal', lib/signupNotices.js proposal).
-- 2. A team manager no longer joins the team's club (var-roleless-reads-1):
--    everything it reads goes through its team (lib/teams.js mayManage), and
--    a membership (account_clubs) opened the club's games of the day, its
--    licence lists to any scorer role and the club rule, and stayed after the
--    team manager was removed. The trigger of db/030 adds the club for a club
--    manager only. The memberships db/030 gave team managers go, where
--    nothing else explains them: a membership older than the account's first
--    team (or team link, or approved team manager request) of the club stays,
--    and so does one a club code, an admin, an approved scorer or club
--    manager request or a club manager row (now or before, audit
--    club.managers) gave. Each one removed is audited (account.clubs,
--    reason 'team_manager').
-- 3. A club manager link (db/029, lib/clubs.js inviteManager) works for the
--    address it was mailed to only (delta-fe-manage-3): invite_codes
--    .invited_email, filled in for the links made before from their label
--    ("Club manager · <address>").
-- 4. A club's open codes are revoked when the club is deleted
--    (be-clubs-teams-8, lib/clubs.js remove); the codes of clubs deleted
--    before are revoked here (invite.create named the club; audited
--    invite.revoke, reason 'club_deleted').
--
-- db/current_definitions.sql carries the new ov_manager_rows_changed().
-- roles.sql: no change (ov_app writes account_requests, notifications,
-- invite_codes, account_clubs and audit_log already).
-- Idempotent, one transaction (scripts/migrate.mjs). Deploy: scripts/migrate.mjs
-- (or deploy/deploy.sh), then the backend image, then the manager. An older
-- backend on this schema grants a team manager's yes at once (as before) and
-- binds no club manager link to an address.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1. proposals
ALTER TABLE public.account_requests ADD COLUMN IF NOT EXISTS proposed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.account_requests ADD COLUMN IF NOT EXISTS proposed_at timestamptz;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_requests_proposal_check' AND conrelid = 'public.account_requests'::regclass) THEN
    -- only a team manager part is proposed
    ALTER TABLE public.account_requests ADD CONSTRAINT account_requests_proposal_check
      CHECK (proposed_at IS NULL OR kind = 'team_manager');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'notifications_kind_check' AND conrelid = 'public.notifications'::regclass
                    AND pg_get_constraintdef(oid) LIKE '%team_manager_proposal%') THEN
    ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
    ALTER TABLE public.notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('signup', 'team_manager_proposal'));
  END IF;
END $$;

-- 2. a new club manager joins the club; a team manager joins nothing
CREATE OR REPLACE FUNCTION public.ov_manager_rows_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM public.ov_sync_manager_roles(NEW.user_id);
    -- a new club manager joins the club; a team manager no club (db/036:
    -- it reads through its team, lib/teams.js mayManage)
    IF TG_TABLE_NAME = 'club_managers' THEN
      INSERT INTO public.account_clubs (user_id, club_id, granted_by)
      VALUES (NEW.user_id, NEW.club_id, NEW.added_by)
      ON CONFLICT (user_id, club_id) DO NOTHING;
    END IF;
  END IF;
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    PERFORM public.ov_sync_manager_roles(OLD.user_id);
  END IF;
  RETURN NULL;
END $$;

-- the memberships db/030 gave team managers, where nothing else explains them
WITH team_since AS (
  SELECT x.user_id, x.club_id, min(x.at) AS since
    FROM (SELECT tm.user_id, ct.club_id, tm.added_at AS at
            FROM public.team_managers tm JOIN public.club_teams ct ON ct.id = tm.team_id
          UNION ALL
          SELECT r.user_id, i.club_id, r.redeemed_at
            FROM public.invite_redemptions r JOIN public.invite_codes i ON i.id = r.invite_id
           WHERE i.role = 'team_manager' AND i.club_id IS NOT NULL
          UNION ALL
          SELECT a.target_user_id,
                 CASE WHEN a.details ->> 'club_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                      THEN (a.details ->> 'club_id')::uuid END,
                 a.at
            FROM public.audit_log a
           WHERE a.target_user_id IS NOT NULL
             AND ((a.action = 'account.request_approve' AND a.details ->> 'kind' = 'team_manager')
               -- a team link redeemed, also of a team taken off the club since
               OR (a.action = 'invite.redeem' AND a.details ->> 'role' = 'team_manager'))) x
   WHERE x.user_id IS NOT NULL AND x.club_id IS NOT NULL
   GROUP BY x.user_id, x.club_id
), gone AS (
  DELETE FROM public.account_clubs ac
   USING team_since s
   WHERE ac.user_id = s.user_id AND ac.club_id = s.club_id
     AND ac.granted_at >= s.since
     AND NOT EXISTS (SELECT 1 FROM public.club_managers cm WHERE cm.club_id = ac.club_id AND cm.user_id = ac.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.invite_redemptions r JOIN public.invite_codes i ON i.id = r.invite_id
                      WHERE r.user_id = ac.user_id AND i.club_id = ac.club_id AND i.role <> 'team_manager')
     AND NOT EXISTS (SELECT 1 FROM public.audit_log a
                      WHERE a.target_user_id = ac.user_id
                        AND ((a.action = 'account.clubs'
                              AND (a.details ->> 'joined' = ac.club_id::text OR coalesce(a.details -> 'after', '[]'::jsonb) ? ac.club_id::text))
                          OR (a.action = 'account.request_approve' AND a.details ->> 'kind' IN ('scorer', 'club_manager')
                              AND a.details ->> 'club_id' = ac.club_id::text)
                          OR (a.action = 'invite.redeem' AND a.details ->> 'role' IS DISTINCT FROM 'team_manager'
                              AND a.details ->> 'club_id' = ac.club_id::text)))
     AND NOT EXISTS (SELECT 1 FROM public.audit_log a
                      WHERE a.action = 'club.managers' AND a.details ->> 'club_id' = ac.club_id::text
                        AND coalesce(a.details -> 'after', '[]'::jsonb) ? ac.user_id::text)
  RETURNING ac.user_id, ac.club_id
)
INSERT INTO public.audit_log (action, target_user_id, details)
SELECT 'account.clubs', g.user_id, jsonb_build_object('removed', g.club_id, 'reason', 'team_manager', 'by', 'db/036')
  FROM gone g;

-- 3. a club manager link names its address
ALTER TABLE public.invite_codes ADD COLUMN IF NOT EXISTS invited_email text
  CHECK (invited_email IS NULL OR length(invited_email) BETWEEN 3 AND 254);
UPDATE public.invite_codes
   SET invited_email = lower(btrim(substr(label, length('Club manager · ') + 1)))
 WHERE role = 'club_manager' AND invited_email IS NULL
   AND label LIKE 'Club manager · %' AND length(label) < 120
   AND btrim(substr(label, length('Club manager · ') + 1)) ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$';

-- 4. the open codes of clubs deleted before
WITH dead AS (
  UPDATE public.invite_codes i
     SET revoked_at = now()
   WHERE i.revoked_at IS NULL AND i.club_id IS NULL
     AND EXISTS (SELECT 1 FROM public.audit_log a
                  WHERE a.action = 'invite.create' AND a.details ->> 'invite_id' = i.id::text
                    AND a.details ->> 'club_id' IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id::text = a.details ->> 'club_id'))
  RETURNING i.id, i.label, i.sport
)
INSERT INTO public.audit_log (action, details, app)
SELECT 'invite.revoke', jsonb_build_object('invite_id', d.id, 'label', d.label, 'reason', 'club_deleted', 'by', 'db/036'),
       CASE WHEN d.sport = 'beach' THEN 'beach' END
  FROM dead d;

COMMIT;
