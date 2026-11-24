-- 030_manager_roles.sql: club and team managers as roles, and as members of
-- their club.
--
-- Owner, 2026-11-11: "Give club membership and add club manager and team
-- manager roles". A club manager (db/020 club_managers) and a team manager
-- (db/023 team_managers) are per club / per team; until now neither was in
-- profiles.roles, so such an account read as "without a role" and its team
-- link gave no club. Now:
--
--   1. profiles.roles holds 'club_manager' while the account manages at
--      least one club, and 'team_manager' while it manages at least one
--      team: kept in step by triggers on club_managers and team_managers,
--      whatever adds or removes the row (a club manager link, a team link,
--      an approved sign-up request, the admin's club page, a club or team
--      or account deleted). The roles are not granted by hand
--      (lib/access.js API_GRANTABLE_ROLES leaves them out).
--   2. A new club manager or team manager also joins that club
--      (account_clubs, db/018), as a scorer code of the club does. Leaving
--      the club or team does not take the membership away.
--   3. Every existing manager gets both now.
--
-- roles.sql: no change (ov_app writes profiles and account_clubs already);
-- run apply-roles.sh after this file as with every migration all the same.
-- Idempotent. Deploy: 030, apply-roles.sh, the backend image, the manager.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- The manager roles of one account, from the rows that exist now
CREATE OR REPLACE FUNCTION public.ov_sync_manager_roles(uid uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  want text[] := '{}';
BEGIN
  IF uid IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM public.club_managers WHERE user_id = uid) THEN want := array_append(want, 'club_manager'); END IF;
  IF EXISTS (SELECT 1 FROM public.team_managers WHERE user_id = uid) THEN want := array_append(want, 'team_manager'); END IF;
  -- the other roles in their order, then the manager roles that apply; written only when it changes
  UPDATE public.profiles p
     SET roles = n.next
    FROM (SELECT p2.ctid AS row_id,
                 (SELECT coalesce(array_agg(r ORDER BY o), '{}')
                    FROM unnest(coalesce(p2.roles, '{}')) WITH ORDINALITY AS x(r, o)
                   WHERE r NOT IN ('club_manager', 'team_manager')) || want AS next
            FROM public.profiles p2 WHERE p2.user_id = uid) n
   WHERE p.ctid = n.row_id AND p.roles IS DISTINCT FROM n.next;
END $$;

CREATE OR REPLACE FUNCTION public.ov_manager_rows_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  club uuid;
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM public.ov_sync_manager_roles(NEW.user_id);
    -- a new manager joins the club (of the team)
    IF TG_TABLE_NAME = 'club_managers' THEN
      club := NEW.club_id;
    ELSE
      SELECT ct.club_id INTO club FROM public.club_teams ct WHERE ct.id = NEW.team_id;
    END IF;
    IF club IS NOT NULL THEN
      INSERT INTO public.account_clubs (user_id, club_id, granted_by)
      VALUES (NEW.user_id, club, NEW.added_by)
      ON CONFLICT (user_id, club_id) DO NOTHING;
    END IF;
  END IF;
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    PERFORM public.ov_sync_manager_roles(OLD.user_id);
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS club_managers_roles ON public.club_managers;
CREATE TRIGGER club_managers_roles AFTER INSERT OR UPDATE OR DELETE ON public.club_managers
  FOR EACH ROW EXECUTE FUNCTION public.ov_manager_rows_changed();
DROP TRIGGER IF EXISTS team_managers_roles ON public.team_managers;
CREATE TRIGGER team_managers_roles AFTER INSERT OR UPDATE OR DELETE ON public.team_managers
  FOR EACH ROW EXECUTE FUNCTION public.ov_manager_rows_changed();

-- 3. the managers there are now
INSERT INTO public.account_clubs (user_id, club_id, granted_by)
SELECT cm.user_id, cm.club_id, cm.added_by FROM public.club_managers cm
ON CONFLICT (user_id, club_id) DO NOTHING;
INSERT INTO public.account_clubs (user_id, club_id, granted_by)
SELECT tm.user_id, ct.club_id, tm.added_by FROM public.team_managers tm JOIN public.club_teams ct ON ct.id = tm.team_id
ON CONFLICT (user_id, club_id) DO NOTHING;
SELECT public.ov_sync_manager_roles(u.user_id)
  FROM (SELECT user_id FROM public.club_managers UNION SELECT user_id FROM public.team_managers
        UNION SELECT user_id FROM public.profiles WHERE roles && ARRAY['club_manager', 'team_manager']) u;

COMMIT;
