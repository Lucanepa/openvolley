-- 055_beach_ownership.sql: who owns a beach competition, and co-manager
-- invitations (audit round 3: PERM-09, PERM-18; owner decision 5)
--
-- 1. competitions.created_by (db/007 already has the column and sets it at
--    every creation; it is made sure of here): owner decision 5, a beach
--    competition manager changes or deletes only the beach competitions it
--    owns (lib/manageApi.js, lib/savedTeams.js mayManageCompetition); the
--    admins every one; indoor stays as it is. A beach competition without an
--    owner (its creator's account deleted, ON DELETE SET NULL, or rows from
--    before db/007) is backfilled once:
--      a. the account of the latest saved-teams entry of the audit log that
--         names the competition (saved_teams.roster / team_delete,
--         details.competition_id), if it still holds beach:competition_manager
--         (the creation itself is not audited: created_by records it);
--      b. else the creator of its oldest team, if it holds the role.
--    The NOTICEs count them, and the beach competitions left without an
--    owner; those stay open to every beach competition manager (as before)
--    unless the owner decides they are the admins' only.
-- 2. public.beach_tournament_invites: a co-manager is invited by address and
--    becomes one only when that beach competition manager accepts
--    (lib/beachTournaments.js). Before, the address was looked up at once and
--    only a beach competition manager's appeared in the managers list: the
--    list told which addresses held such an account (PERM-18).
--      email        the address the editor typed, lower case
--      invited_by   who invited (SET NULL with the account)
--      invited_at   open INVITE_TTL_DAYS (30) days from then; expired ones
--                   are deleted by the next invitation or invitations list
--    No account id: an invitation names an address, never whether an
--    account has it. Deleted with its tournament. DML for ov_app (granted
--    here when the role exists, and by roles.sql, as db/014's tables).
-- 3. An index for the beach scorers' own tournaments (lib/savedTeams.js
--    ownBeachTeams): the tournament matches a scorer claimed (db/014, phase T3).
--
-- Safe while the old backend serves: one column made sure of (already there),
-- a backfill of the few beach competitions without an owner (the old
-- backend's rights do not read it), a new table and an index on a small
-- table. Idempotent; one transaction (scripts/migrate.mjs); waits at most
-- lock_timeout for its tables. By hand:
--   docker exec -i ov-postgres psql -X -U ov_owner -d openvolley -v ON_ERROR_STOP=1 < db/055_beach_ownership.sql
BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1. the owner of a competition --------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'competitions' AND column_name = 'created_by') THEN
    ALTER TABLE public.competitions ADD COLUMN created_by uuid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                   JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
                  WHERE c.conrelid = 'public.competitions'::regclass AND c.contype = 'f' AND a.attname = 'created_by') THEN
    ALTER TABLE public.competitions
      ADD CONSTRAINT competitions_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMENT ON COLUMN public.competitions.created_by IS
  'The account that created the competition (SET NULL with it). Beach: its owner, the one beach competition manager who changes or deletes it besides the admins (db/055, owner decision 5).';

DO $$
DECLARE
  from_audit int := 0;
  from_teams int := 0;
  without    int := 0;
  total      int := 0;
BEGIN
  -- a. the latest saved-teams entry of the audit log naming the competition
  WITH beach_cm AS (
    SELECT p.user_id FROM public.profiles p
     WHERE EXISTS (SELECT 1 FROM unnest(coalesce(p.roles, '{}'::text[])) r(role) WHERE lower(trim(r.role)) = 'beach:competition_manager')
  ), last_edit AS (
    SELECT DISTINCT ON (c.id) c.id, a.actor_id
      FROM public.competitions c
      JOIN public.audit_log a ON a.action LIKE 'saved_teams.%' AND a.details ->> 'competition_id' = c.id::text
     WHERE c.sport = 'beach' AND c.created_by IS NULL
       AND a.actor_id IN (SELECT user_id FROM beach_cm)
     ORDER BY c.id, a.at DESC, a.id DESC
  )
  UPDATE public.competitions c SET created_by = l.actor_id
    FROM last_edit l WHERE c.id = l.id AND c.created_by IS NULL;
  GET DIAGNOSTICS from_audit = ROW_COUNT;

  -- b. else the creator of its oldest team
  WITH beach_cm AS (
    SELECT p.user_id FROM public.profiles p
     WHERE EXISTS (SELECT 1 FROM unnest(coalesce(p.roles, '{}'::text[])) r(role) WHERE lower(trim(r.role)) = 'beach:competition_manager')
  ), first_team AS (
    SELECT DISTINCT ON (c.id) c.id, t.created_by
      FROM public.competitions c
      JOIN public.competition_teams t ON t.competition_id = c.id
     WHERE c.sport = 'beach' AND c.created_by IS NULL
       AND t.created_by IN (SELECT user_id FROM beach_cm)
     ORDER BY c.id, t.created_at, t.id
  )
  UPDATE public.competitions c SET created_by = f.created_by
    FROM first_team f WHERE c.id = f.id AND c.created_by IS NULL;
  GET DIAGNOSTICS from_teams = ROW_COUNT;

  SELECT count(*) FILTER (WHERE created_by IS NULL), count(*) INTO without, total
    FROM public.competitions WHERE sport = 'beach';
  RAISE NOTICE 'db/055: % beach competition(s); owner from the audit log: %, from the first team: %, still without an owner: %',
    total, from_audit, from_teams, without;
END $$;

-- 2. co-manager invitations ------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.beach_tournament_invites (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid        NOT NULL REFERENCES public.beach_tournaments(id) ON DELETE CASCADE,
  email         text        NOT NULL CONSTRAINT beach_tournament_invites_email_check
                            CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  invited_by    uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  invited_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT beach_tournament_invites_once UNIQUE (tournament_id, email)
);
CREATE INDEX IF NOT EXISTS beach_tournament_invites_email_idx ON public.beach_tournament_invites (email, invited_at DESC);

COMMENT ON TABLE public.beach_tournament_invites IS
  'Open co-manager invitations of a beach tournament, by address (db/055, PERM-18): the invited beach competition manager accepts and only then is a co-manager (beach_tournament_managers). Open 30 days.';

-- the backend's DML (roles.sql's default privileges grant it too, and every
-- table at its next run)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ov_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.beach_tournament_invites TO ov_app;
  END IF;
END $$;

-- 3. the tournament matches a scorer claimed ------------------------------------
CREATE INDEX IF NOT EXISTS beach_tmatches_claimed_by_idx ON public.beach_tmatches (claimed_by) WHERE claimed_by IS NOT NULL;

COMMIT;
