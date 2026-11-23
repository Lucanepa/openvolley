-- 055_beach_ownership.sql: co-manager invitations of a beach tournament
-- (audit round 3: PERM-18)
--
-- public.beach_tournament_invites: a co-manager is invited by address and
-- becomes one only when that beach competition manager accepts
-- (lib/beachTournaments.js). Before, the address was looked up at once and
-- only a beach competition manager's appeared in the managers list: the
-- list told which addresses held such an account (PERM-18).
--   email        the address the editor typed, lower case
--   invited_by   who invited (SET NULL with the account)
--   invited_at   open INVITE_TTL_DAYS (30) days from then; expired ones
--                are deleted by the next invitation or invitations list
-- No account id: an invitation names an address, never whether an account
-- has it. Deleted with its tournament. DML for ov_app (granted here when the
-- role exists, and by roles.sql, as db/014's tables).
--
-- Safe while the old backend serves: a new table nothing of it reads.
-- Idempotent; one transaction (scripts/migrate.mjs); waits at most
-- lock_timeout for its tables. By hand:
--   docker exec -i ov-postgres psql -X -U ov_owner -d openvolley -v ON_ERROR_STOP=1 < db/055_beach_ownership.sql
BEGIN;
SET LOCAL lock_timeout = '5s';

-- co-manager invitations ---------------------------------------------------------
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

COMMIT;
