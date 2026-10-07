-- 010_auth_tokens.sql: one-time email links of lib/auth.js (password reset,
-- email confirmation).
--
-- Run as ov_owner after 009 (restore.sh runs every db/NNN_*.sql with
-- NNN >= 003 in numeric order), then roles.sql. Idempotent. One transaction.
-- Safe under the running 2.2.0 backend: a new table only, nothing existing is
-- touched.
--
-- A token is 32 random bytes sent once, in the link of the email; only its
-- SHA-256 is stored (like auth.app_sessions). Rules live in lib/auth.js:
--   reset    60 minutes, single use; issuing a new one and every password
--            change mark all older unused reset tokens of the user used
--   confirm  24 hours, single use; a new one replaces the older ones
-- Rows go with the account (FK cascade) and are swept a week after they
-- expired or were used.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS auth.app_tokens (
  hash        bytea       PRIMARY KEY CHECK (octet_length(hash) = 32),
  purpose     text        NOT NULL CHECK (purpose IN ('reset', 'confirm')),
  user_id     uuid        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  CHECK (expires_at > created_at)
);

-- "the open tokens of this user for this purpose" (invalidation on re-issue
-- and on password change), and the sweep.
CREATE INDEX IF NOT EXISTS app_tokens_user_open_idx ON auth.app_tokens (user_id, purpose) WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS app_tokens_expires_at_idx ON auth.app_tokens (expires_at);

-- The app role needs DML here. roles.sql grants it too; this covers running
-- the migration after roles.sql.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ov_app') THEN
    GRANT USAGE ON SCHEMA auth TO ov_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON auth.app_tokens TO ov_app;
  END IF;
END $$;

COMMIT;
