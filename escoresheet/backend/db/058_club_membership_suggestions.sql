-- 058_club_membership_suggestions.sql: where a club membership came from (a
-- removed club manager leaves the club again), and roster suggestions for
-- another club's team (audit 2611: PERM-12, PERM-04).
--
-- 1. account_clubs.granted_via (PERM-12): 'manager' when the trigger below
--    added the membership for a new club manager who was no member before;
--    NULL for every other way in (a club's scorer code, an admin, an
--    approved request) and for every row of before (not rewritten: such a
--    membership stays when its manager row goes, as until now). When the
--    club_managers row goes (a manager taken off the list), the trigger
--    takes a 'manager' membership away again, audited account.clubs
--    { removed, reason 'club_manager_removed' } (no audit when the account
--    or the club is being deleted: the cascade takes the row anyway). A club
--    code the account redeems later makes the membership its own
--    (lib/accounts.js sets granted_via to NULL).
-- 2. roster_suggestions (PERM-04, owner decision 2026-11-23 no. 2): an
--    official match saves back only once it is closed (approved / final),
--    and only to the team of a club its writer (matches.closed_by, else
--    created_by) is a member of (lib/rosterSaveBack.js; a team of no club:
--    add-only, review CR-2, and no row here). The other side of the match,
--    another club's team, gets a suggestion instead, one row per (match, side), which
--    whoever may manage that team (its club's managers, its team managers,
--    admins: lib/teams.js mayManage) confirms or rejects in the manager.
--    Confirming merges the match's roster then, as the writer's own club's
--    side is merged at once. No personal data here: the roster stays the
--    match's (players_* / bench_*, read when the suggestion is shown or
--    confirmed), so the redaction, the retention and the match's own rules
--    cover it; `payload` holds counts only (never a name or a licence).
--    The row goes with its match (ON DELETE CASCADE: a deleted match's
--    suggestions are gone, and a deleted match is never a team's "latest").
--    team_name is the schedule's (svrz_games) name of the side's team;
--    club_id / team_id the team's club and club team when it was made (the
--    manager's list finds a team by its name).
--
-- current_definitions.sql carries the new ov_manager_rows_changed().
-- roles.sql: no change (ov_app's default privileges cover new tables; the
-- grant below holds until roles.sql runs again). Not on the /api/db
-- allowlist (lib/pgQuery.js): only lib/rosterSaveBack.js reads and writes it.
--
-- Safe while the old backend serves: a nullable column without a default (no
-- rewrite), a new table nothing of it reads, and a trigger function that
-- behaves as before for every membership of before. Idempotent, one
-- transaction (scripts/migrate.mjs); waits at most lock_timeout for
-- account_clubs and matches (the foreign key). By hand:
--   docker exec -i ov-postgres psql -X -U ov_owner -d openvolley -v ON_ERROR_STOP=1 < db/058_club_membership_suggestions.sql
BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1. where a membership came from
ALTER TABLE public.account_clubs ADD COLUMN IF NOT EXISTS granted_via text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.account_clubs'::regclass AND conname = 'account_clubs_granted_via_check') THEN
    ALTER TABLE public.account_clubs ADD CONSTRAINT account_clubs_granted_via_check
      CHECK (granted_via IS NULL OR granted_via IN ('manager')) NOT VALID;
    ALTER TABLE public.account_clubs VALIDATE CONSTRAINT account_clubs_granted_via_check;
  END IF;
END $$;
COMMENT ON COLUMN public.account_clubs.granted_via IS
  '''manager'': joined only as a club manager (db/058), taken away again when that club_managers row goes; NULL: a membership of its own (a code, an admin, a request) or of before db/058.';

-- db/036's function, with the membership of a new club manager marked, and
-- taken away again when the manager row goes (PERM-12)
CREATE OR REPLACE FUNCTION public.ov_manager_rows_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  left_club boolean := false;
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM public.ov_sync_manager_roles(NEW.user_id);
    -- a new club manager joins the club, marked 'manager' (db/058); one that
    -- was a member before keeps its own membership; a team manager joins no
    -- club (db/036: it reads through its team, lib/teams.js mayManage)
    IF TG_TABLE_NAME = 'club_managers' THEN
      INSERT INTO public.account_clubs (user_id, club_id, granted_by, granted_via)
      VALUES (NEW.user_id, NEW.club_id, NEW.added_by, 'manager')
      ON CONFLICT (user_id, club_id) DO NOTHING;
    END IF;
  END IF;
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    PERFORM public.ov_sync_manager_roles(OLD.user_id);
    -- db/058 (PERM-12): a club manager taken off leaves the club the trigger
    -- made it join; a membership of its own stays
    -- (nested: a team_managers row has no club_id to name)
    IF TG_TABLE_NAME = 'club_managers' THEN
      IF TG_OP = 'DELETE' THEN
        left_club := true;
      ELSE
        left_club := NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.club_id IS DISTINCT FROM OLD.club_id;
      END IF;
      IF left_club AND NOT EXISTS (SELECT 1 FROM public.club_managers cm WHERE cm.club_id = OLD.club_id AND cm.user_id = OLD.user_id) THEN
        WITH gone AS (
          DELETE FROM public.account_clubs ac
           WHERE ac.user_id = OLD.user_id AND ac.club_id = OLD.club_id AND ac.granted_via = 'manager'
          RETURNING ac.user_id, ac.club_id
        )
        INSERT INTO public.audit_log (action, target_user_id, details)
        SELECT 'account.clubs', g.user_id, jsonb_build_object('removed', g.club_id, 'reason', 'club_manager_removed', 'by', 'db/058')
          FROM gone g
         -- not while the account or the club is being deleted (the cascade)
         WHERE EXISTS (SELECT 1 FROM auth.users u WHERE u.id = g.user_id)
           AND EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = g.club_id);
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- 2. roster suggestions for the other club's team
CREATE TABLE IF NOT EXISTS public.roster_suggestions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id    uuid        NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  side        text        NOT NULL CHECK (side IN ('home', 'away')),
  team_name   text        NOT NULL CHECK (length(btrim(team_name)) BETWEEN 1 AND 200),
  club_id     uuid        REFERENCES public.clubs(id) ON DELETE SET NULL,
  team_id     uuid        REFERENCES public.club_teams(id) ON DELETE SET NULL,
  season      integer     NOT NULL CHECK (season BETWEEN 2000 AND 2100),
  payload     jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  status      text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'confirmed', 'rejected')),
  actor_id    uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  decided_by  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at  timestamptz,
  CONSTRAINT roster_suggestions_decided_check CHECK ((status = 'open') = (decided_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS roster_suggestions_match_side_uidx ON public.roster_suggestions (match_id, side);
CREATE INDEX IF NOT EXISTS roster_suggestions_team_idx ON public.roster_suggestions (lower(btrim(team_name)), season);
CREATE INDEX IF NOT EXISTS roster_suggestions_club_idx ON public.roster_suggestions (club_id) WHERE club_id IS NOT NULL;
COMMENT ON TABLE public.roster_suggestions IS
  'An official match''s roster of a side whose team is not of its writer''s clubs, for that team''s managers to confirm or reject (db/058, lib/rosterSaveBack.js). No personal data: the roster is the match''s; payload holds counts only.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ov_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.roster_suggestions TO ov_app;
  END IF;
END $$;

COMMIT;
