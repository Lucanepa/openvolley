-- 000_prelude.sql: run as the cluster superuser (ov_owner) on a FRESH database,
-- before pg_restore of the Supabase `public` dump. scripts/migrate/restore.sh
-- runs it; by hand:
--
--   docker exec -i ov-postgres psql -X -U ov_owner -d openvolley -v ON_ERROR_STOP=1 < db/000_prelude.sql
--
-- Idempotent. What it does NOT need to do, checked against the production
-- schema dump (schema_public.sql, 2026-10-05):
--   * extensions: every default uses gen_random_uuid() or nextval(), both core
--     in PostgreSQL 13+. No uuid-ossp, no pgcrypto, no `extensions.` schema.
--   * Supabase roles (anon, authenticated, service_role, ...): the dump was
--     taken with --no-owner --no-privileges, and restore.sh drops the policy,
--     RLS and publication entries from the TOC, so nothing names those roles.
--     They are deliberately not created: no stub role ever exists in the cluster.

\set ON_ERROR_STOP on

-- Timestamps are stored as timestamptz; UTC keeps text renderings stable.
SELECT format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'UTC') \gexec
SET timezone TO 'UTC';

-- ov_owner owns every schema object. On the server it is the image's
-- POSTGRES_USER (superuser, used only through `docker exec`); in a local
-- container started with another superuser it is created here, without login.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ov_owner') THEN
    CREATE ROLE ov_owner NOLOGIN;
  END IF;
END $$;
-- Database owner = ov_owner (no-op on the server, where it created the database).
SELECT format('ALTER DATABASE %I OWNER TO ov_owner', current_database())
 WHERE (SELECT datdba FROM pg_database WHERE datname = current_database()) <> 'ov_owner'::regrole \gexec

-- auth: the Supabase table name on purpose, so the dumped foreign keys
-- (profiles.user_id, user_matches.user_id, beach_competition_matches.created_by
-- and .claimed_by -> auth.users(id)) keep their meaning. Columns: the ones
-- lib/auth.js reads or writes, as exported by Phase 0 (auth_users.csv):
--   id, email, encrypted_password, email_confirmed_at, created_at, updated_at,
--   last_sign_in_at, raw_user_meta_data, raw_app_meta_data, banned_until, deleted_at
-- banned_until / deleted_at are kept (not filtered out at import): lib/auth.js
-- refuses sign-in for a banned or deleted user, and keeping the rows keeps the
-- foreign keys of their profiles and matches valid.
CREATE SCHEMA IF NOT EXISTS auth;
ALTER SCHEMA auth OWNER TO ov_owner;

CREATE TABLE IF NOT EXISTS auth.users (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text        NOT NULL,
  encrypted_password text,                       -- bcrypt ($2a$10$...)
  email_confirmed_at timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  last_sign_in_at    timestamptz,
  raw_user_meta_data jsonb       NOT NULL DEFAULT '{}'::jsonb,
  raw_app_meta_data  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  banned_until       timestamptz,
  deleted_at         timestamptz
);
ALTER TABLE auth.users OWNER TO ov_owner;

-- Sign-in looks users up by lower(email); sign-up relies on this index being
-- UNIQUE (002_app_sessions.sql checks it and creates it under the same name).
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON auth.users (lower(email));

-- Staging table for restore.sh: auth_users.csv is \copy'd here, then
-- 001_post_restore.sql moves the rows into auth.users and drops it.
-- Same column order as the CSV header.
CREATE TABLE IF NOT EXISTS auth.users_import (
  id                 uuid,
  email              text,
  encrypted_password text,
  email_confirmed_at timestamptz,
  created_at         timestamptz,
  updated_at         timestamptz,
  last_sign_in_at    timestamptz,
  raw_user_meta_data jsonb,
  raw_app_meta_data  jsonb,
  banned_until       timestamptz,
  deleted_at         timestamptz
);
ALTER TABLE auth.users_import OWNER TO ov_owner;
REVOKE ALL ON auth.users_import FROM PUBLIC;
