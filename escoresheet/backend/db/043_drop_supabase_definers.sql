-- 043_drop_supabase_definers.sql: the Supabase-era SECURITY DEFINER helpers
-- a restored dump brought along (restore.sh keeps every FUNCTION and TRIGGER
-- of the dump; roles.sql only revokes EXECUTE):
--
--   public.delete_user()       Supabase rpc('delete_user'); the backend
--                              deletes accounts itself (lib/auth.js)
--   public.reset_test_match()  Supabase rpc, no caller left
--   public.handle_new_user()   AFTER INSERT trigger on auth.users
--                              (on_auth_user_created); lib/auth.js creates
--                              the profile itself and skips an existing one
--
-- They ran as their superuser owner with the search_path the dump recorded,
-- and a later grant on all functions would have made them callable again.
-- Dropped with their triggers, by name, in any schema, whatever their
-- signature. No migration of this repository creates them. Idempotent: a
-- database without them (every fresh one) is left as it is.

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname IN ('delete_user', 'reset_test_match', 'handle_new_user')
       AND n.nspname IN ('public', 'auth')
  LOOP
    -- CASCADE: a trigger of another name calling one of them goes too
    EXECUTE format('DROP FUNCTION %s CASCADE', f.sig);
    RAISE NOTICE '043: dropped %', f.sig;
  END LOOP;
END $$;

-- Deleted matches (review 2026-11): an app that holds a match's sent jobs
-- sends the match again when the server lacks it (a database restored to an
-- earlier time, 404 OV_MATCH_UNKNOWN). A match deleted on purpose (by its
-- account on another device, by an admin) must not come back that way: its
-- external_id is kept here, and the server answers OV_MATCH_DELETED instead.
-- Written by a trigger, so every delete path records it; a later insert of
-- the same external_id (the match made again) removes the record.
CREATE TABLE IF NOT EXISTS public.deleted_matches (
  external_id text PRIMARY KEY,
  deleted_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.deleted_matches FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.ov_matches_deleted_record()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.external_id IS NOT NULL THEN
      INSERT INTO public.deleted_matches (external_id) VALUES (OLD.external_id)
      ON CONFLICT (external_id) DO UPDATE SET deleted_at = now();
    END IF;
  ELSIF NEW.external_id IS NOT NULL THEN
    DELETE FROM public.deleted_matches WHERE external_id = NEW.external_id;
  END IF;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS matches_deleted_record ON public.matches;
CREATE TRIGGER matches_deleted_record
  AFTER INSERT OR DELETE ON public.matches
  FOR EACH ROW EXECUTE FUNCTION public.ov_matches_deleted_record();
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ov_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.deleted_matches TO ov_app;
  END IF;
END
$$;
