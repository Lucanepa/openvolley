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

-- Sign-in looks users up by lower(email). 000_prelude.sql creates this index
-- under the same name; repeated here so the lookup is indexed either way.
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
