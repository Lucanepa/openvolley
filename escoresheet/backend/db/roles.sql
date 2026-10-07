-- roles.sql: database roles and grants of the self-hosted OpenVolley backend.
--
-- Re-runnable; run after EVERY restore and after every migration that adds a
-- table (production load, restore-db.sh, the weekly restore-test.sh, a standby
-- drill). Run as ov_owner, the cluster superuser, with the app password as the
-- psql variable ov_app_pw:
--
--   ./apply-roles.sh < roles.sql                       (server; reads OV_APP_PW from .env)
--   psql -X -U ov_owner -d openvolley -v ON_ERROR_STOP=1 -v ov_app_pw="$APP_PW" < roles.sql
--
-- Without ov_app_pw the grants are refreshed and the password is left alone.
-- One transaction: the running backend never sees a half-applied state.
--
-- Roles
--   ov_owner  owns every object; superuser in the compose stack (POSTGRES_USER).
--             Used only through `docker exec` for restores, migrations, this
--             file and backup-openvolley.sh's pg_dump (there is no separate
--             backup role). Never changed here; created NOLOGIN if absent.
--             Objects in public/auth owned by anyone else are handed to it.
--   ov_app    what the backend connects as (DATABASE_URL). No superuser, no DDL,
--             no CREATE anywhere, no TRUNCATE/REFERENCES/TRIGGER, no function
--             EXECUTE, 10 s statement timeout. Gets:
--               public  DML on every table (svrz_games/svrz_sync_log too:
--                       lib/vmSync.js runs inside the backend on its pool),
--                       USAGE+SELECT on sequences (no setval), and the same on
--                       future tables/sequences created by ov_owner; which
--                       tables clients may reach is decided by the allowlist
--                       in lib/pgQuery.js, these grants are the floor.
--               auth    exactly what lib/auth.js needs:
--                       auth.users         SELECT (to_jsonb of the whole row),
--                                          INSERT (sign-up), DELETE
--                                          (delete-account), UPDATE of
--                                          encrypted_password, updated_at,
--                                          email_confirmed_at, last_sign_in_at only
--                       auth.app_sessions  SELECT, INSERT, UPDATE, DELETE
--                       auth.app_tokens    SELECT, INSERT, UPDATE, DELETE
--                                          (db/010; skipped when absent)
--                       auth.app_memberships SELECT, INSERT, DELETE
--                                          (db/012, lib/accounts.js; skipped
--                                          when absent)

\set ON_ERROR_STOP on
BEGIN;

DO $$
BEGIN
  IF to_regclass('auth.users') IS NULL OR to_regclass('auth.app_sessions') IS NULL THEN
    RAISE EXCEPTION 'auth.users / auth.app_sessions missing: run db/000_prelude.sql and db/002_app_sessions.sql (or restore a full dump) before roles.sql';
  END IF;
END $$;

-- Roles ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ov_owner') THEN
    CREATE ROLE ov_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ov_app') THEN
    CREATE ROLE ov_app LOGIN;
  END IF;
END $$;
-- Re-asserted every run, in case someone changed them by hand.
ALTER ROLE ov_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
DO $$
DECLARE r record;
BEGIN
  -- ov_app inherits nothing: drop any role membership it was given.
  FOR r IN SELECT g.rolname FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
            WHERE m.member = 'ov_app'::regrole LOOP
    EXECUTE format('REVOKE %I FROM ov_app', r.rolname);
    RAISE NOTICE 'revoked membership of ov_app in %', r.rolname;
  END LOOP;
END $$;

\if :{?ov_app_pw}
-- Keep every statement that carries the password out of the server log,
-- whatever log_statement / log_min_duration_statement the cluster runs with
-- and even if one fails. Superuser-only settings: this file runs as ov_owner.
SET LOCAL log_statement = 'none';
SET LOCAL log_min_duration_statement = -1;
SET LOCAL log_min_error_statement = panic;
SELECT length(:'ov_app_pw') >= 16 AS ov_pw_ok \gset
\if :ov_pw_ok
ALTER ROLE ov_app PASSWORD :'ov_app_pw';
\else
DO $$ BEGIN RAISE EXCEPTION 'ov_app_pw is shorter than 16 characters (generate it with: openssl rand -hex 32)'; END $$;
\endif
RESET log_statement;
RESET log_min_duration_statement;
RESET log_min_error_statement;
\else
\warn 'roles.sql: ov_app_pw not set; the password of ov_app is unchanged'
\endif

ALTER ROLE ov_app SET statement_timeout = '10s';
-- pgQuery's transactions are short; a leaked client must not hold locks forever.
ALTER ROLE ov_app SET idle_in_transaction_session_timeout = '60s';

-- Ownership: every table, sequence, view, function, type and the auth schema
-- belong to ov_owner, whoever created them (a restore or migration run as
-- another superuser, e.g. `postgres` in a local container). No-op normally.
DO $$
DECLARE r record;
BEGIN
  -- Tables (with their OWNED BY / identity sequences), views, matviews, foreign tables.
  FOR r IN SELECT c.oid::regclass AS rel
             FROM pg_class c
            WHERE c.relnamespace IN ('public'::regnamespace, 'auth'::regnamespace)
              AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
              AND c.relowner <> 'ov_owner'::regrole
              AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
                                 AND d.objid = c.oid AND d.deptype = 'e') LOOP
    EXECUTE format('ALTER TABLE %s OWNER TO ov_owner', r.rel);
  END LOOP;
  -- Free-standing sequences (the linked ones moved with their table above).
  FOR r IN SELECT c.oid::regclass AS rel
             FROM pg_class c
            WHERE c.relnamespace IN ('public'::regnamespace, 'auth'::regnamespace)
              AND c.relkind = 'S'
              AND c.relowner <> 'ov_owner'::regrole
              AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
                                 AND d.objid = c.oid AND d.deptype = 'e') LOOP
    EXECUTE format('ALTER SEQUENCE %s OWNER TO ov_owner', r.rel);
  END LOOP;
  -- Functions, procedures, aggregates; not members of an extension.
  FOR r IN SELECT p.oid::regprocedure AS fn
             FROM pg_proc p
            WHERE p.pronamespace IN ('public'::regnamespace, 'auth'::regnamespace)
              AND p.proowner <> 'ov_owner'::regrole
              AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass
                                 AND d.objid = p.oid AND d.deptype = 'e') LOOP
    EXECUTE format('ALTER ROUTINE %s OWNER TO ov_owner', r.fn);
  END LOOP;
  -- Enums, ranges, standalone composite types, domains; not row types of
  -- tables, not array/multirange types, not extension members.
  FOR r IN SELECT t.oid::regtype AS typ, t.typtype
             FROM pg_type t
            WHERE t.typnamespace IN ('public'::regnamespace, 'auth'::regnamespace)
              AND t.typtype IN ('e', 'd', 'c', 'r')
              AND (t.typrelid = 0 OR (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = 'c')
              AND t.typowner <> 'ov_owner'::regrole
              AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass
                                 AND d.objid = t.oid AND d.deptype = 'e') LOOP
    EXECUTE format('ALTER %s %s OWNER TO ov_owner', CASE r.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END, r.typ);
  END LOOP;
  IF (SELECT nspowner FROM pg_namespace WHERE nspname = 'auth') <> 'ov_owner'::regrole THEN
    ALTER SCHEMA auth OWNER TO ov_owner;
  END IF;
END $$;

-- Database ------------------------------------------------------------------------------
SELECT format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'UTC') \gexec
-- Only ov_app (and superusers) may connect; nobody gets TEMP.
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database()) \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM ov_app', current_database()) \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO ov_app', current_database()) \gexec
-- The cluster's maintenance databases are for superusers only.
SELECT format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', datname)
  FROM pg_database WHERE datname IN ('postgres', 'template1') AND datname <> current_database() \gexec

-- Schemas -------------------------------------------------------------------------------
SELECT 'CREATE SCHEMA auth AUTHORIZATION ov_owner' WHERE to_regnamespace('auth') IS NULL \gexec
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA auth FROM PUBLIC;
REVOKE ALL ON SCHEMA public, auth FROM ov_app;
GRANT USAGE ON SCHEMA public, auth TO ov_app;

-- public: start from nothing, then grant ------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, ov_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, ov_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ov_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ov_app;

-- No public table is held back: the daily VolleyManager sync (lib/vmSync.js,
-- scheduled by the backend in cloud mode) writes svrz_games and svrz_sync_log
-- (INSERT ... RETURNING id, so it needs svrz_sync_log_id_seq too) as ov_app.

-- Functions: nobody but the owner may call them. The restored Supabase
-- functions include SECURITY DEFINER ones (delete_user, reset_test_match,
-- handle_new_user) that would run as the superuser owner. Triggers still fire:
-- EXECUTE is checked when a trigger is created, not when it runs.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, ov_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA auth FROM PUBLIC, ov_app;

-- Future objects created by ov_owner (migrations) follow the same rules.
ALTER DEFAULT PRIVILEGES FOR ROLE ov_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ov_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ov_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ov_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ov_owner
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- auth: exactly what lib/auth.js uses -------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA auth FROM PUBLIC, ov_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA auth FROM PUBLIC, ov_app;
-- Column-level grants survive a table-level REVOKE; clear them on auth.users.
DO $$
DECLARE cols text;
BEGIN
  SELECT string_agg(quote_ident(attname), ', ') INTO cols
    FROM pg_attribute WHERE attrelid = 'auth.users'::regclass AND attnum > 0 AND NOT attisdropped;
  EXECUTE format('REVOKE ALL (%s) ON auth.users FROM ov_app', cols);
END $$;
GRANT SELECT, INSERT, DELETE ON auth.users TO ov_app;
GRANT UPDATE (encrypted_password, updated_at, email_confirmed_at, last_sign_in_at) ON auth.users TO ov_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.app_sessions TO ov_app;
-- db/010: one-time email links (reset / confirm). Optional: on a database
-- without 010 there is no such table (lib/auth.js then answers 503).
SELECT 'GRANT SELECT, INSERT, UPDATE, DELETE ON auth.app_tokens TO ov_app'
 WHERE to_regclass('auth.app_tokens') IS NOT NULL \gexec
-- db/012: which app (OpenVolley / OpenBeach) an account has joined. Optional
-- like app_tokens; account deletion removes the rows through the FK cascade.
SELECT 'GRANT SELECT, INSERT, DELETE ON auth.app_memberships TO ov_app'
 WHERE to_regclass('auth.app_memberships') IS NOT NULL \gexec

COMMIT;
