-- 002_app_sessions.sql: session store for lib/auth.js (replaces GoTrue sessions).
--
-- Run as ov_owner after 000_prelude.sql (auth schema + auth.users) and before
-- roles.sql. Idempotent: safe to re-run after every restore.
--
--   docker exec -i ov-postgres psql -U ov_owner -d openvolley -v ON_ERROR_STOP=1 < db/002_app_sessions.sql
--
-- Tokens are 32 random bytes handed to the client once; only SHA-256(token)
-- is stored. Lifetime rules live in lib/auth.js (30-day sliding expiry,
-- 90-day absolute cap from created_at). Rows go away on sign-out, password
-- change, account deletion (FK cascade) and the periodic sweep.

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.app_sessions (
  token_hash   bytea       PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  user_id      uuid        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz
);

CREATE INDEX IF NOT EXISTS app_sessions_user_id_idx ON auth.app_sessions (user_id);
CREATE INDEX IF NOT EXISTS app_sessions_expires_at_idx ON auth.app_sessions (expires_at);

-- Sign-in looks users up by lower(email), and sign-up relies on this index
-- being UNIQUE to turn a concurrent duplicate into "user_already_exists".
-- 000_prelude.sql creates it under the same name; repeated here so it exists
-- either way. Fail loudly (instead of a bare unique-violation, or silently
-- keeping a different index of the same name) when the restored data or an
-- existing index does not fit.
DO $$
DECLARE
  dupes   text;
  idx_def text;
  idx_uni boolean;
BEGIN
  SELECT string_agg(e, ', ' ORDER BY e) INTO dupes
    FROM (SELECT lower(email) AS e FROM auth.users
           WHERE email IS NOT NULL
           GROUP BY 1 HAVING count(*) > 1
           ORDER BY 1 LIMIT 20) d;
  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION 'auth.users has emails that differ only in case: %', dupes
      USING HINT = 'Merge or rename these accounts, then re-run 002_app_sessions.sql.';
  END IF;

  SELECT pg_get_indexdef(i.indexrelid), i.indisunique INTO idx_def, idx_uni
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'auth' AND c.relname = 'users_email_lower';
  IF FOUND AND NOT (
       idx_uni
       AND idx_def ~ ' ON auth\.users '
       AND idx_def ~ '\(lower\(\(?email\)?(::text)?\)\)'
       AND idx_def !~ ' WHERE ') THEN
    RAISE EXCEPTION 'auth.users_email_lower exists but is not UNIQUE on lower(email): %', idx_def
      USING HINT = 'DROP INDEX auth.users_email_lower; then re-run 002_app_sessions.sql.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON auth.users (lower(email));

-- The app role (created by roles.sql) needs DML here. roles.sql grants it too;
-- this covers running the migration after roles.sql.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ov_app') THEN
    GRANT USAGE ON SCHEMA auth TO ov_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON auth.app_sessions TO ov_app;
  END IF;
END $$;
