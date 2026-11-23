-- 056_referee_directory_owner.sql: who added a referee, and who may hear that a match was deleted
--
-- Audit 2611.
--
-- 1. PERM-07: any approved scorer could add any number of rows to the
--    league-wide referee directory (referee_database) through /api/db, and
--    past 200,000 rows every scorer's referee picker was empty. The backend
--    (server.js refereeDirectoryInsert) now takes 1 to 5 rows per insert from
--    a non-admin, refuses a referee already there (the same first and last
--    name, a sport in common) and at most REFEREE_DIRECTORY_DAILY_MAX new
--    rows per account in 24 hours. For that it records who added a row:
--      referee_database.created_by  uuid NULL, the account (auth.users,
--                                   ON DELETE SET NULL; lib/auth.js detaches
--                                   it as well); NULL for the rows already there
--      referee_database.created_at  timestamptz, default now(): the restored
--                                   table has it; added where it lacks it
--                                   (NULL for the rows already there)
--    and an index of the rows that have an account (the daily count).
--
-- 2. PERM-17: POST /api/match/known (and /api/db's 404 for an update of one
--    match) told any account whether any match had been deleted. The backend
--    says "deleted" only to the accounts that could write the match when it
--    went (its creator and its editors) and to admins; anyone else hears
--    "unknown", as of a match never stored (a stored match is public anyway).
--    For that, db/043's record keeps them:
--      deleted_matches.owners  uuid[] NULL: the creator and the editors at the
--                              delete; NULL for the matches deleted before
--                              this file (their state stays as it was)
--    filled by a BEFORE DELETE trigger on matches (db/043's AFTER trigger
--    comes too late: match_editors' rows go with the match, ON DELETE
--    CASCADE, before it runs), and an account deleted later is taken out of
--    every list (AFTER DELETE on auth.users).
--
-- Safe while the old backend serves: nullable columns without a volatile
-- default (no table rewrite), which it neither reads nor writes; the
-- triggers fill owners for its deletes too. Idempotent; one transaction
-- (scripts/migrate.mjs); each lock waits at most lock_timeout.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1. referee_database ---------------------------------------------------------
DO $$
DECLARE
  typ text;
BEGIN
  IF to_regclass('public.referee_database') IS NULL THEN
    RETURN;
  END IF;
  ALTER TABLE public.referee_database ADD COLUMN IF NOT EXISTS created_by uuid;
  ALTER TABLE public.referee_database ADD COLUMN IF NOT EXISTS created_at timestamptz;
  SELECT format_type(a.atttypid, a.atttypmod) INTO typ
    FROM pg_attribute a WHERE a.attrelid = 'public.referee_database'::regclass AND a.attname = 'created_at' AND NOT a.attisdropped;
  IF typ = 'timestamp with time zone' AND NOT EXISTS (
       SELECT 1 FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
        WHERE d.adrelid = 'public.referee_database'::regclass AND a.attname = 'created_at') THEN
    ALTER TABLE public.referee_database ALTER COLUMN created_at SET DEFAULT now();
  END IF;
  IF to_regclass('auth.users') IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conrelid = 'public.referee_database'::regclass AND conname = 'referee_database_created_by_fkey') THEN
    ALTER TABLE public.referee_database ADD CONSTRAINT referee_database_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
  COMMENT ON COLUMN public.referee_database.created_by IS
    'The account that added the referee (db/056, server.js refereeDirectoryInsert: its daily cap); NULL for the rows added before.';
END $$;

CREATE INDEX IF NOT EXISTS referee_database_created_by_idx
  ON public.referee_database (created_by, created_at) WHERE created_by IS NOT NULL;

-- 2. deleted_matches.owners -----------------------------------------------------
ALTER TABLE public.deleted_matches ADD COLUMN IF NOT EXISTS owners uuid[];
COMMENT ON COLUMN public.deleted_matches.owners IS
  'The accounts that could write the match when it was deleted: its creator and editors (db/056). POST /api/match/known says "deleted" to them and admins only. NULL: deleted before db/056.';

CREATE OR REPLACE FUNCTION public.ov_matches_deleted_owners()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.external_id IS NOT NULL THEN
    INSERT INTO public.deleted_matches (external_id, owners)
    VALUES (OLD.external_id, ARRAY(
      SELECT DISTINCT o.user_id FROM (
        SELECT OLD.created_by AS user_id
        UNION ALL
        SELECT e.user_id FROM public.match_editors e WHERE e.match_id = OLD.id
      ) o WHERE o.user_id IS NOT NULL ORDER BY o.user_id))
    ON CONFLICT (external_id) DO UPDATE SET owners = EXCLUDED.owners, deleted_at = now();
  END IF;
  RETURN OLD;
END
$$;
DROP TRIGGER IF EXISTS matches_deleted_owners ON public.matches;
CREATE TRIGGER matches_deleted_owners
  BEFORE DELETE ON public.matches
  FOR EACH ROW EXECUTE FUNCTION public.ov_matches_deleted_owners();

-- An account that goes leaves no trace in the lists (lib/auth.js deleteAccount
-- deletes the auth.users row, as ov_app)
CREATE OR REPLACE FUNCTION public.ov_deleted_matches_forget_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.deleted_matches SET owners = array_remove(owners, OLD.id) WHERE owners @> ARRAY[OLD.id];
  RETURN NULL;
END
$$;
DO $$
BEGIN
  IF to_regclass('auth.users') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS users_forget_deleted_match_owner ON auth.users;
    CREATE TRIGGER users_forget_deleted_match_owner
      AFTER DELETE ON auth.users
      FOR EACH ROW EXECUTE FUNCTION public.ov_deleted_matches_forget_owner();
  END IF;
END $$;

COMMIT;
