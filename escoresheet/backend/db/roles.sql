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
--                       in lib/pgQuery.js, these grants are the floor. Less:
--                       the logs (append-only, below) and redacted_people
--                       (db/052, SELECT only: the sync reads it, only the
--                       owner's redact-person writes it)
--               auth    exactly what lib/auth.js needs:
--                       auth.users         SELECT (to_jsonb of the whole row),
--                                          INSERT (sign-up), DELETE
--                                          (delete-account), UPDATE of
--                                          encrypted_password, updated_at,
--                                          email_confirmed_at, last_sign_in_at,
--                                          banned_until (deactivate), email and
--                                          raw_app_meta_data (the admin's
--                                          address change) only
--                       auth.app_sessions  SELECT, INSERT, UPDATE, DELETE
--                       auth.app_tokens    SELECT, INSERT, UPDATE, DELETE
--                                          (db/010; skipped when absent)
--                       auth.approval_pins SELECT, INSERT, UPDATE, DELETE
--                                          (db/011, lib/approvals.js; skipped
--                                          when absent)
--                       auth.passkeys      SELECT, INSERT, UPDATE, DELETE
--                                          (db/022, lib/passkeys.js; skipped
--                                          when absent)
--                       auth.app_memberships SELECT, INSERT, DELETE
--                                          (db/012, lib/accounts.js; skipped
--                                          when absent)
--               ov_meta USAGE, and SELECT on schema_migrations (the
--                       migration record of scripts/migrate.mjs, read by
--                       lib/schemaVersion.js; skipped when absent)
--   ov_readonly the operator's SQL browser (deploy/db-browse.sh): reads the
--             views of schema ov_read (each table of public without its
--             secret columns), read-only transactions, 3 connections, 15 s
--             per statement; password :ov_readonly_pw
--             (OV_READONLY_PW in .env, optional: without it only the
--             container's local socket logs in). ov_app may SET ROLE to it
--             (no inherited rights): the SQL workspace's read mode. See the
--             end of this file.
--   ov_sql_writer the SQL workspace's write mode (lib/sqlWorkspace.js): NOLOGIN,
--             ov_app may SET ROLE to it (no inherited rights). ov_app's own
--             grants on public and ov_meta, copied, but SELECT only of the
--             columns that are not secret, and the views of schema ov_write
--             (each table of public with secret columns, by its name, without
--             them). See the end of this file.

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
  -- ov_app inherits nothing: drop any role membership it was given (but
  -- ov_readonly and ov_sql_writer, granted below with INHERIT FALSE: the SQL
  -- workspace's read and write mode).
  FOR r IN SELECT g.rolname FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
            WHERE m.member = 'ov_app'::regrole AND g.rolname NOT IN ('ov_readonly', 'ov_sql_writer') LOOP
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

-- Append-only for the app (db/015, db/016): the event history and the
-- activity log are written with INSERT and removed with DELETE (retention,
-- account deletion, delete on request), never rewritten. One exception:
-- lib/auth.js deleteAccount detaches the account (cfg.detachedColumns runs
-- UPDATE ... SET <account column> = NULL as ov_app), so ov_app keeps UPDATE
-- of those account columns only. Without it every account deletion fails
-- (the UPDATE privilege is checked even when no row matches). A table-level
-- REVOKE also drops column grants, so the column GRANT comes after it.
-- The other: event_revisions.applied, set when a revision stored before its
-- event is applied on its resend (lib/eventRevisions.js, db/039).
SELECT format('REVOKE UPDATE ON %s FROM ov_app', t)
  FROM unnest(ARRAY['public.event_revisions', 'public.activity_log']) AS t
 WHERE to_regclass(t) IS NOT NULL \gexec
-- The admin audit log (db/007) is insert-only for the app: never rewritten,
-- never deleted (its retention, if any, runs as ov_owner). The account
-- columns stay updatable for the detach (ON DELETE SET NULL, and any explicit
-- one like the tables above).
SELECT format('REVOKE UPDATE, DELETE ON %s FROM ov_app', t)
  FROM unnest(ARRAY['public.audit_log']) AS t
 WHERE to_regclass(t) IS NOT NULL \gexec
SELECT format('GRANT UPDATE (%s) ON %s TO ov_app', c, t)
  FROM (VALUES ('public.event_revisions', 'actor_id, applied'),
               ('public.activity_log', 'account_id, uploader_id'),
               ('public.audit_log', 'actor_id, target_user_id')) AS g(t, c)
 WHERE to_regclass(t) IS NOT NULL \gexec

-- The daily VolleyManager sync (lib/vmSync.js, scheduled by the backend in
-- cloud mode) writes svrz_games and svrz_sync_log (INSERT ... RETURNING id, so
-- it needs svrz_sync_log_id_seq too) as ov_app, and reads the register of
-- people erased on request (db/052), which only the owner role writes
-- (scripts/redact-person.mjs): the app could otherwise undo an erasure.
SELECT format('REVOKE INSERT, UPDATE, DELETE ON %s FROM ov_app', t)
  FROM unnest(ARRAY['public.redacted_people']) AS t
 WHERE to_regclass(t) IS NOT NULL \gexec

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
-- banned_until: lib/accounts.js setActive (deactivate / reactivate, db/027);
-- email, raw_app_meta_data: its updateProfile (an admin moves an account to a
-- new address, left unconfirmed until its owner confirms it).
GRANT UPDATE (encrypted_password, updated_at, email_confirmed_at, last_sign_in_at,
              banned_until, email, raw_app_meta_data) ON auth.users TO ov_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.app_sessions TO ov_app;
-- db/010: one-time email links (reset / confirm). Optional: on a database
-- without 010 there is no such table (lib/auth.js then answers 503).
SELECT 'GRANT SELECT, INSERT, UPDATE, DELETE ON auth.app_tokens TO ov_app'
 WHERE to_regclass('auth.app_tokens') IS NOT NULL \gexec
-- db/011: personal approval PINs (lib/approvals.js). Optional like app_tokens:
-- without the table the approval endpoints answer 503.
SELECT 'GRANT SELECT, INSERT, UPDATE, DELETE ON auth.approval_pins TO ov_app'
 WHERE to_regclass('auth.approval_pins') IS NOT NULL \gexec
-- db/012: which app (OpenVolley / OpenBeach) an account has joined. Optional
-- like app_tokens; account deletion removes the rows through the FK cascade.
SELECT 'GRANT SELECT, INSERT, DELETE ON auth.app_memberships TO ov_app'
 WHERE to_regclass('auth.app_memberships') IS NOT NULL \gexec
-- db/022: passkeys (lib/passkeys.js). Optional like app_tokens: without the
-- table the passkey actions answer 503; deletion cascades from auth.users.
SELECT 'GRANT SELECT, INSERT, UPDATE, DELETE ON auth.passkeys TO ov_app'
 WHERE to_regclass('auth.passkeys') IS NOT NULL \gexec

-- ov_meta: the migration record (scripts/migrate.mjs). The backend reads it
-- to tell whether the database is behind its image (lib/schemaVersion.js);
-- only ov_owner writes it. A restore without privileges (restore-db.sh,
-- restore-test.sh, scripts/migrate/restore.sh) drops these grants; they come
-- back here. Optional: absent until the runner's first run.
SELECT format('REVOKE ALL ON SCHEMA %s FROM PUBLIC, ov_app', s)
  FROM unnest(ARRAY['ov_meta']) AS s WHERE to_regnamespace(s) IS NOT NULL \gexec
SELECT format('GRANT USAGE ON SCHEMA %s TO ov_app', s)
  FROM unnest(ARRAY['ov_meta']) AS s WHERE to_regnamespace(s) IS NOT NULL \gexec
SELECT format('REVOKE ALL ON %s FROM PUBLIC, ov_app', t)
  FROM unnest(ARRAY['ov_meta.schema_migrations']) AS t WHERE to_regclass(t) IS NOT NULL \gexec
SELECT format('GRANT SELECT ON %s TO ov_app', t)
  FROM unnest(ARRAY['ov_meta.schema_migrations']) AS t WHERE to_regclass(t) IS NOT NULL \gexec

-- ov_readonly: the operator's SQL browser (deploy/db-browse.sh: psql or pgweb
-- through an SSH tunnel). It reads schema ov_read only: one view per table of
-- public with every column but the secret ones (the same pattern as
-- lib/dataAdmin.js SECRET_COLUMN_RE: game PINs, token and code hashes, ...),
-- so `select * from matches` works and never shows a PIN. Nothing of public,
-- auth or ov_meta directly. Read-only transactions, 15 s per statement, 3
-- connections. ov_read is dropped and rebuilt on every run: after a
-- migration it follows the new columns (this file runs after every
-- migration that adds a table). The views belong to ov_owner and nothing
-- depends on them. LOGIN: the container's local socket (docker exec psql)
-- needs no password; TCP (pgweb) needs :ov_readonly_pw (OV_READONLY_PW in .env).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ov_readonly') THEN
    CREATE ROLE ov_readonly LOGIN;
  END IF;
END $$;
ALTER ROLE ov_readonly WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 3;
ALTER ROLE ov_readonly SET default_transaction_read_only = on;
ALTER ROLE ov_readonly SET statement_timeout = '15s';
ALTER ROLE ov_readonly SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE ov_readonly SET search_path = ov_read;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT g.rolname FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
            WHERE m.member = 'ov_readonly'::regrole LOOP
    EXECUTE format('REVOKE %I FROM ov_readonly', r.rolname);
  END LOOP;
END $$;
\if :{?ov_readonly_pw}
SET LOCAL log_statement = 'none';
SET LOCAL log_min_duration_statement = -1;
SET LOCAL log_min_error_statement = panic;
SELECT length(:'ov_readonly_pw') >= 16 AS ov_ro_pw_ok \gset
\if :ov_ro_pw_ok
ALTER ROLE ov_readonly PASSWORD :'ov_readonly_pw';
\else
DO $$ BEGIN RAISE EXCEPTION 'ov_readonly_pw is shorter than 16 characters (generate it with: openssl rand -hex 32)'; END $$;
\endif
RESET log_statement;
RESET log_min_duration_statement;
RESET log_min_error_statement;
\endif
SELECT format('REVOKE ALL ON DATABASE %I FROM ov_readonly', current_database()) \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO ov_readonly', current_database()) \gexec
-- Nothing outside ov_read (a grant given by hand, column grants included)
REVOKE ALL ON SCHEMA public, auth FROM ov_readonly;
DO $$
BEGIN
  IF to_regnamespace('ov_meta') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON SCHEMA ov_meta FROM ov_readonly'; END IF;
END $$;
DO $$
DECLARE r record; cols text;
BEGIN
  FOR r IN SELECT c.oid, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname IN ('public', 'auth') AND c.relkind IN ('r', 'p', 'v', 'm', 'S') LOOP
    EXECUTE format('REVOKE ALL ON %s FROM ov_readonly', r.oid::regclass);
    CONTINUE WHEN r.relkind = 'S';
    SELECT string_agg(quote_ident(attname), ', ') INTO cols
      FROM pg_attribute WHERE attrelid = r.oid AND attnum > 0 AND NOT attisdropped;
    IF cols IS NOT NULL THEN
      EXECUTE format('REVOKE ALL (%s) ON %s FROM ov_readonly', cols, r.oid::regclass);
    END IF;
  END LOOP;
END $$;
SET LOCAL client_min_messages = warning;
DROP SCHEMA IF EXISTS ov_read CASCADE;
RESET client_min_messages;
CREATE SCHEMA ov_read AUTHORIZATION ov_owner;
REVOKE ALL ON SCHEMA ov_read FROM PUBLIC;
GRANT USAGE ON SCHEMA ov_read TO ov_readonly;
-- The SQL workspace (lib/sqlWorkspace.js) reads as ov_readonly: ov_app may
-- SET ROLE to it inside a read-only transaction, and inherits none of its
-- rights (PostgreSQL 16+ grant options). Revoked first so the options are
-- exactly these whatever was granted by hand.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'ov_readonly'::regrole AND m.member = 'ov_app'::regrole) THEN
    REVOKE ov_readonly FROM ov_app;
  END IF;
END $$;
GRANT ov_readonly TO ov_app WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
DO $$
DECLARE
  r record;
  secret_re constant text := '(^|_)(pin|pins|password|secret|token|salt|mac)(_|$)|(^|_)hash$';
  visible text;
BEGIN
  FOR r IN SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname LOOP
    SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO visible
      FROM pg_attribute WHERE attrelid = r.oid AND attnum > 0 AND NOT attisdropped AND attname !~ secret_re
       -- a Global match's device export and PDF (db/046): the summary is enough to browse
       AND NOT (r.relname = 'global_matches' AND attname IN ('bundle', 'pdf'));
    CONTINUE WHEN visible IS NULL;
    EXECUTE format('CREATE VIEW ov_read.%I AS SELECT %s FROM %s', r.relname, visible, r.oid::regclass);
    EXECUTE format('REVOKE ALL ON ov_read.%I FROM PUBLIC', r.relname);
    EXECUTE format('GRANT SELECT ON ov_read.%I TO ov_readonly', r.relname);
  END LOOP;
END $$;

-- ov_sql_writer: the SQL workspace's write mode (lib/sqlWorkspace.js). It ran
-- as ov_app, which reads every column: a check of the names refused
-- `game_pin`, but SELECT *, a whole row, a UNION or a recursive CTE gave the
-- secret columns back (audit SEC-40). Write mode now runs as this role (SET
-- LOCAL ROLE inside its transaction, as read mode does with ov_readonly), so
-- Postgres itself refuses whatever reads a secret column, by its name or
-- not: ov_app's grants on public and ov_meta are copied here, but SELECT of
-- a secret column (the pattern of ov_read above and of lib/dataAdmin.js
-- SECRET_COLUMN_RE). Nothing on auth. Its triggers fire as this role; they
-- read no secret column. Schema ov_write holds a view of every table of
-- public that has secret columns, by the table's name, with the other
-- columns (security_invoker: this role's grants on the table decide, the
-- append-only rules too). Write mode's search path finds it before public,
-- so SELECT * FROM matches, RETURNING * and INSERT / UPDATE / DELETE by the
-- plain name work as before, without the secret columns, and
-- `SELECT * FROM public.matches` is refused (42501). Rebuilt on every run,
-- like ov_read: it follows new tables and columns (a new table gets no
-- default grants here: this file runs after every migration).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ov_sql_writer') THEN
    CREATE ROLE ov_sql_writer NOLOGIN;
  END IF;
END $$;
ALTER ROLE ov_sql_writer WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT g.rolname FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
            WHERE m.member = 'ov_sql_writer'::regrole LOOP
    EXECUTE format('REVOKE %I FROM ov_sql_writer', r.rolname);
  END LOOP;
END $$;
SELECT format('REVOKE ALL ON DATABASE %I FROM ov_sql_writer', current_database()) \gexec
REVOKE ALL ON SCHEMA public, auth FROM ov_sql_writer;
GRANT USAGE ON SCHEMA public TO ov_sql_writer;
DO $$
BEGIN
  IF to_regnamespace('ov_meta') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON SCHEMA ov_meta FROM ov_sql_writer';
    IF has_schema_privilege('ov_app', 'ov_meta', 'USAGE') THEN
      EXECUTE 'GRANT USAGE ON SCHEMA ov_meta TO ov_sql_writer';
    END IF;
  END IF;
END $$;
DO $$
DECLARE
  r record;
  p record;
  cols text;
  visible text;
  secret_re constant text := '(^|_)(pin|pins|password|secret|token|salt|mac)(_|$)|(^|_)hash$';
BEGIN
  FOR r IN SELECT c.oid, c.relkind, n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname IN ('public', 'auth', 'ov_meta') AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') LOOP
    -- from nothing, column grants too (a grant given by hand)
    EXECUTE format('REVOKE ALL ON %s FROM ov_sql_writer', r.oid::regclass);
    IF r.relkind <> 'S' THEN
      SELECT string_agg(quote_ident(attname), ', ') INTO cols
        FROM pg_attribute WHERE attrelid = r.oid AND attnum > 0 AND NOT attisdropped;
      IF cols IS NOT NULL THEN
        EXECUTE format('REVOKE ALL (%s) ON %s FROM ov_sql_writer', cols, r.oid::regclass);
      END IF;
    END IF;
    CONTINUE WHEN r.nspname = 'auth';
    -- ov_app's privileges on the table or sequence ...
    FOR p IN SELECT DISTINCT a.privilege_type FROM pg_class c, aclexplode(c.relacl) a
              WHERE c.oid = r.oid AND a.grantee = 'ov_app'::regrole LOOP
      IF r.relkind = 'S' THEN
        EXECUTE format('GRANT %s ON SEQUENCE %s TO ov_sql_writer', p.privilege_type, r.oid::regclass);
      ELSIF p.privilege_type = 'SELECT' AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = r.oid AND attnum > 0
                                                       AND NOT attisdropped AND attname ~ secret_re) THEN
        SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO visible
          FROM pg_attribute WHERE attrelid = r.oid AND attnum > 0 AND NOT attisdropped AND attname !~ secret_re;
        IF visible IS NOT NULL THEN
          EXECUTE format('GRANT SELECT (%s) ON %s TO ov_sql_writer', visible, r.oid::regclass);
        END IF;
      ELSE
        EXECUTE format('GRANT %s ON %s TO ov_sql_writer', p.privilege_type, r.oid::regclass);
      END IF;
    END LOOP;
    -- ... and on its columns (the account columns of the append-only logs), SELECT of a secret one left out
    CONTINUE WHEN r.relkind = 'S';
    FOR p IN SELECT a.attname, x.privilege_type FROM pg_attribute a, aclexplode(a.attacl) x
              WHERE a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped AND x.grantee = 'ov_app'::regrole
                AND NOT (x.privilege_type = 'SELECT' AND a.attname ~ secret_re) LOOP
      EXECUTE format('GRANT %s (%I) ON %s TO ov_sql_writer', p.privilege_type, p.attname, r.oid::regclass);
    END LOOP;
  END LOOP;
END $$;
SET LOCAL client_min_messages = warning;
DROP SCHEMA IF EXISTS ov_write CASCADE;
RESET client_min_messages;
CREATE SCHEMA ov_write AUTHORIZATION ov_owner;
REVOKE ALL ON SCHEMA ov_write FROM PUBLIC;
GRANT USAGE ON SCHEMA ov_write TO ov_sql_writer;
DO $$
DECLARE
  r record;
  visible text;
  secret_re constant text := '(^|_)(pin|pins|password|secret|token|salt|mac)(_|$)|(^|_)hash$';
BEGIN
  FOR r IN SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
              AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0
                             AND NOT a.attisdropped AND a.attname ~ secret_re)
            ORDER BY c.relname LOOP
    SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO visible
      FROM pg_attribute WHERE attrelid = r.oid AND attnum > 0 AND NOT attisdropped AND attname !~ secret_re;
    CONTINUE WHEN visible IS NULL;
    EXECUTE format('CREATE VIEW ov_write.%I WITH (security_invoker = true) AS SELECT %s FROM public.%I', r.relname, visible, r.relname);
    EXECUTE format('REVOKE ALL ON ov_write.%I FROM PUBLIC', r.relname);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ov_write.%I TO ov_sql_writer', r.relname);
  END LOOP;
END $$;
-- ov_app may SET ROLE to it inside write mode's transaction and inherits none
-- of its rights. Revoked first so the options are exactly these.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'ov_sql_writer'::regrole AND m.member = 'ov_app'::regrole) THEN
    REVOKE ov_sql_writer FROM ov_app;
  END IF;
END $$;
GRANT ov_sql_writer TO ov_app WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;

COMMIT;
