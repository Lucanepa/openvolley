-- 001_post_restore.sql: one-off fix-ups after pg_restore of the Supabase
-- `public` dump. Run as the cluster superuser (ov_owner), by
-- scripts/migrate/restore.sh, after 000_prelude.sql, the auth_users.csv load
-- into auth.users_import and pg_restore; before 002_app_sessions.sql, 003+ and
-- roles.sql. One transaction: it either completes or changes nothing.
--
--   1. RLS remnants: drop every policy in public, disable (and un-force) RLS.
--      The TOC filter already keeps them out; this is the safety net. With
--      RLS on and no policies, the non-owner ov_app would see zero rows.
--   2. auth.users_import -> auth.users (emails lower-cased; every row kept,
--      lib/auth.js refuses banned and deleted users). Stops on a missing id or
--      email, a duplicate id, or emails that differ only in case.
--   3. Foreign keys to auth.users, which restore.sh keeps out of the TOC
--      because auth.users is empty while pg_restore runs. Re-created under
--      their production names after an orphan check. created_by / claimed_by
--      on beach_competition_matches get ON DELETE SET NULL (production: NO
--      ACTION): lib/auth.js delete-account deletes the user row, and NO ACTION
--      would make that fail with a 500 for anyone who ever created or claimed
--      a beach competition match.
--
-- Re-runnable: each step is a no-op once done.

\set ON_ERROR_STOP on
BEGIN;
SET LOCAL timezone TO 'UTC';

DO $$
BEGIN
  IF to_regclass('public.matches') IS NULL THEN
    RAISE EXCEPTION 'public.matches does not exist: run pg_restore of public.dump before 001_post_restore.sql';
  END IF;
  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'auth.users does not exist: run 000_prelude.sql first';
  END IF;
END $$;

-- 1. RLS remnants ----------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT schemaname, tablename, policyname FROM pg_policies WHERE schemaname = 'public' LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
    RAISE NOTICE 'dropped policy % on %.%', r.policyname, r.schemaname, r.tablename;
  END LOOP;
  FOR r IN SELECT c.oid::regclass AS rel, c.relrowsecurity, c.relforcerowsecurity
             FROM pg_class c
            WHERE c.relnamespace IN ('public'::regnamespace, 'auth'::regnamespace)
              AND c.relkind IN ('r', 'p')
              AND (c.relrowsecurity OR c.relforcerowsecurity) LOOP
    EXECUTE format('ALTER TABLE %s DISABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY', r.rel);
    RAISE NOTICE 'disabled row level security on %', r.rel;
  END LOOP;
END $$;

-- 2. users ------------------------------------------------------------------------
DO $$
DECLARE
  n_import bigint;
  bad      text;
  stats    record;
BEGIN
  IF to_regclass('auth.users_import') IS NULL THEN
    RAISE NOTICE 'auth.users_import absent: auth.users left as it is (% rows)', (SELECT count(*) FROM auth.users);
    RETURN;
  END IF;
  SELECT count(*) INTO n_import FROM auth.users_import;

  SELECT count(*)::text INTO bad FROM auth.users_import WHERE id IS NULL OR email IS NULL OR btrim(email) = '';
  IF bad <> '0' THEN
    RAISE EXCEPTION 'auth_users.csv: % row(s) without id or email', bad;
  END IF;
  SELECT string_agg(id::text, ', ') INTO bad
    FROM (SELECT id FROM auth.users_import GROUP BY id HAVING count(*) > 1 ORDER BY id LIMIT 10) d;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'auth_users.csv: duplicate ids: %', bad;
  END IF;
  SELECT string_agg(e, ', ' ORDER BY e) INTO bad
    FROM (SELECT lower(email) AS e FROM (SELECT email FROM auth.users_import UNION ALL SELECT email FROM auth.users) a
           GROUP BY 1 HAVING count(*) > 1 ORDER BY 1 LIMIT 20) d;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'auth.users: emails that differ only in case (or already present): %', bad
      USING HINT = 'Decide per account which one stays (fix auth_users.csv), then run restore.sh again.';
  END IF;

  INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at,
                          last_sign_in_at, raw_user_meta_data, raw_app_meta_data, banned_until, deleted_at)
  SELECT id, lower(btrim(email)), nullif(encrypted_password, ''), email_confirmed_at,
         coalesce(created_at, now()), coalesce(updated_at, created_at, now()), last_sign_in_at,
         coalesce(raw_user_meta_data, '{}'::jsonb), coalesce(raw_app_meta_data, '{}'::jsonb),
         banned_until, deleted_at
    FROM auth.users_import;
  DROP TABLE auth.users_import;

  SELECT count(*) AS total,
         count(*) FILTER (WHERE encrypted_password IS NULL OR encrypted_password !~ '^\$2[aby]\$[0-9]{2}\$') AS no_hash,
         count(*) FILTER (WHERE email_confirmed_at IS NULL) AS unconfirmed,
         count(*) FILTER (WHERE banned_until > now()) AS banned,
         count(*) FILTER (WHERE deleted_at IS NOT NULL) AS deleted
    INTO stats FROM auth.users;
  RAISE NOTICE 'auth.users: % loaded from auth_users.csv; % total, % without a bcrypt hash, % unconfirmed, % banned, % deleted (the last four cannot sign in)',
    n_import, stats.total, stats.no_hash, stats.unconfirmed, stats.banned, stats.deleted;
END $$;

-- 3. foreign keys to auth.users -------------------------------------------------------
DO $$
DECLARE
  fk      record;
  orphans bigint;
  def     text;
BEGIN
  FOR fk IN SELECT * FROM (VALUES
      ('profiles',                  'user_id',    'profiles_user_id_fkey',                     'CASCADE'),
      ('user_matches',              'user_id',    'user_matches_user_id_fkey',                 'CASCADE'),
      ('beach_competition_matches', 'created_by', 'beach_competition_matches_created_by_fkey', 'SET NULL'),
      ('beach_competition_matches', 'claimed_by', 'beach_competition_matches_claimed_by_fkey', 'SET NULL')
    ) AS v(tbl, col, conname, on_delete) LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = fk.tbl AND column_name = fk.col) THEN
      RAISE NOTICE 'public.%.% does not exist: no foreign key %', fk.tbl, fk.col, fk.conname;
      CONTINUE;
    END IF;
    EXECUTE format('SELECT count(*) FROM public.%I t WHERE t.%I IS NOT NULL
                      AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = t.%I)', fk.tbl, fk.col, fk.col)
      INTO orphans;
    IF orphans > 0 THEN
      RAISE EXCEPTION 'public.%.%: % row(s) reference users missing from auth_users.csv', fk.tbl, fk.col, orphans
        USING HINT = 'Was auth_users.csv exported from the same project and at the same time as public.dump?';
    END IF;
    def := format('FOREIGN KEY (%I) REFERENCES auth.users(id) ON DELETE %s', fk.col, fk.on_delete);
    IF EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = format('public.%I', fk.tbl)::regclass AND conname = fk.conname
                  AND pg_get_constraintdef(oid) = def) THEN
      CONTINUE;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = format('public.%I', fk.tbl)::regclass AND conname = fk.conname) THEN
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', fk.tbl, fk.conname);
    END IF;
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I %s', fk.tbl, fk.conname, def);
    RAISE NOTICE 'foreign key %: %', fk.conname, def;
  END LOOP;
END $$;

COMMIT;
