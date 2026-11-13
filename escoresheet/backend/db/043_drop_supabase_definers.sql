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
