#!/usr/bin/env bash
# restore.sh [options] <container> <export-dir>
#
# Loads the Phase-0 Supabase export into a self-hosted postgres:17 container
# (the compose ov-postgres on the server, or any local container):
#
#   <export-dir>/public.dump     pg_dump -Fc -n public --no-owner --no-privileges
#   <export-dir>/auth_users.csv  \copy (select id, email, encrypted_password,
#                                email_confirmed_at, created_at, updated_at,
#                                last_sign_in_at, raw_user_meta_data,
#                                raw_app_meta_data, banned_until, deleted_at
#                                from auth.users) ... csv header
#   <export-dir>/toc.keep        optional: a hand-edited restore list, used
#                                instead of the generated one (start from
#                                `restore.sh --print-toc ...`, and write the
#                                reason for every change next to it)
#
# Steps (all through `docker exec`, as the cluster superuser):
#   0. checks: container up, archive readable, CSV header exact
#   1. restore list: `pg_restore -l` minus POLICY, ROW SECURITY, PUBLICATION
#      (TABLE), ACL, the public schema itself, and the foreign keys that point
#      at auth.users (re-created by 001 once the users are loaded). Every
#      TABLE DATA entry of the archive must be on the list (a hand-edited
#      toc.keep that drops one fails here, unless --allow-missing-data).
#   2. target database: REFUSES when any table in public or auth holds a row,
#      unless --force. Exception: a database still marked as an unfinished
#      restore.sh run whose data the app never touched (auth.app_sessions
#      empty, no matches.updated_at, svrz_sync_log.started_at,
#      svrz_games.synced_at or auth.users.last_sign_in_at after the mark) is
#      dropped and loaded again. With --force the old database is RENAMED to
#      <db>_pre_restore_<UTC> (drop it by hand once the new one is good),
#      never dropped. Refuses while client sessions are connected (stop
#      ov-backend first). Then creates the database fresh (template0).
#   3. db/000_prelude.sql (auth schema, auth.users, staging table)
#   4. auth_users.csv -> auth.users_import (streamed on stdin, HEADER MATCH)
#   5. pg_restore --single-transaction --exit-on-error -L <restore list>
#   6. db/001_post_restore.sql (RLS remnants, users, ownership, auth FKs)
#      [--scrub-except: rehearsal scrub of every other account]
#   7. db/002_app_sessions.sql, then every db/NNN_*.sql with NNN >= 003, in order
#   8. db/roles.sql (with the ov_app password when one was given)
#   9. ANALYZE and verification: per-table row counts (compared with
#      --expect-counts when given), users vs CSV rows, the auth foreign keys and
#      match_live_state_match_id_fkey_cascade exist, no RLS/policies, sequences
#      ahead of their columns, ov_app grants (incl. DML on svrz_sync_log for the
#      in-backend vm-sync), and an ov_app login over TCP when the password is
#      known
#
# Options:
#   --force                 replace a database whose tables hold data; the old
#                           one is renamed to <db>_pre_restore_<UTC>, not dropped
#   --expect-counts FILE    per-table row counts the restore must reproduce
#                           (plan §6: the counts from introspect.txt). One table
#                           per line, "<table> <count>" or psql's aligned
#                           "<table> | <count>"; other lines are ignored. Every
#                           public table must be listed and match.
#   --allow-missing-data    accept a toc.keep that leaves out TABLE DATA entries
#                           (those tables are restored EMPTY)
#   --db-name NAME          target database (default openvolley; env OV_DB_NAME)
#   --db-user USER          superuser to run as inside the container
#                           (default ov_owner; env OV_DB_USER). A local
#                           `postgres:17` container started with the default
#                           POSTGRES_USER needs --db-user postgres.
#   --env-file FILE         take OV_APP_PW from FILE (e.g. /opt/openvolley/.env;
#                           only that line is read, nothing is exported) and set
#                           it as ov_app's password. Alternatively export
#                           OV_APP_PW. Without either, ov_app's password is left
#                           unchanged: run deploy/apply-roles.sh afterwards.
#   --sql-dir DIR           where 000_prelude.sql ... roles.sql are (default:
#                           this script's directory when 000_prelude.sql is
#                           there, else ../../db from it (the repository
#                           layout), else <export-dir>; the choice is logged)
#   --scrub-except EMAIL    rehearsal copies only: every other account gets
#                           email user-<n>@rehearsal.invalid, the bcrypt hash of
#                           OV_REHEARSAL_PW (env, required), empty metadata and
#                           a neutral profile name. Match data is NOT scrubbed.
#   --print-toc             print the filtered restore list and exit (no changes)
#
# Passwords never appear on a command line: they reach psql on stdin (\set),
# and PGPASSWORD is handed to `docker exec -e PGPASSWORD` by name only.
#
# Examples:
#   local:  restore.sh --db-user postgres ov-rehearsal /dev/shm/ov-export/2026-10-05
#   server: bash /data/openvolley/pg/import/restore.sh --env-file /opt/openvolley/.env \
#             "$(docker compose -f /opt/openvolley/compose.yaml ps -q ov-postgres)" /data/openvolley/pg/import
set -euo pipefail
umask 077

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
DB_NAME=${OV_DB_NAME:-openvolley}
DB_USER=${OV_DB_USER:-ov_owner}
FORCE=0
ALLOW_MISSING_DATA=0
EXPECT_COUNTS=""
PRINT_TOC=0
ENV_FILE=""
SQL_DIR=""
SCRUB_EMAIL=""
CSV_COLUMNS='id,email,encrypted_password,email_confirmed_at,created_at,updated_at,last_sign_in_at,raw_user_meta_data,raw_app_meta_data,banned_until,deleted_at'
MARK_RUNNING='ov-restore: in progress'
MARK_DONE='ov-restore: complete'

log() { printf '[restore] %s\n' "$*" >&2; }
die() { printf '[restore] FATAL: %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; }

POS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --allow-missing-data) ALLOW_MISSING_DATA=1; shift ;;
    --expect-counts) EXPECT_COUNTS=${2:?--expect-counts needs a file}; shift 2 ;;
    --print-toc) PRINT_TOC=1; shift ;;
    --db-name) DB_NAME=${2:?--db-name needs a value}; shift 2 ;;
    --db-user) DB_USER=${2:?--db-user needs a value}; shift 2 ;;
    --env-file) ENV_FILE=${2:?--env-file needs a file}; shift 2 ;;
    --sql-dir) SQL_DIR=${2:?--sql-dir needs a directory}; shift 2 ;;
    --scrub-except) SCRUB_EMAIL=${2:?--scrub-except needs an email}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    --) shift; POS+=("$@"); break ;;
    -*) die "unknown option: $1 (see --help)" ;;
    *) POS+=("$1"); shift ;;
  esac
done
(( ${#POS[@]} == 2 )) || { usage >&2; exit 2; }
C=${POS[0]}
EXPORT_DIR=${POS[1]}

IDENT_RE='^[a-z_][a-z0-9_]{0,62}$'
[[ "$DB_NAME" =~ $IDENT_RE ]] || die "--db-name must match ${IDENT_RE}"
[[ "$DB_USER" =~ $IDENT_RE ]] || die "--db-user must match ${IDENT_RE}"
case "$DB_NAME" in postgres|template0|template1) die "refusing to restore into the ${DB_NAME} database" ;; esac

DUMP="$EXPORT_DIR/public.dump"
CSV="$EXPORT_DIR/auth_users.csv"
[[ -d "$EXPORT_DIR" ]] || die "no such export directory: $EXPORT_DIR"
[[ -f "$DUMP" && -s "$DUMP" ]] || die "missing or empty: $DUMP"
[[ "$(head -c 5 "$DUMP")" == PGDMP ]] || die "$DUMP is not a pg_dump custom-format archive (still encrypted?)"

if [[ -z "$SQL_DIR" ]]; then
  # The copy next to the script first: on the server that is the set copied
  # together with it, whatever else lies around.
  for d in "$SCRIPT_DIR" "$SCRIPT_DIR/../../db" "$EXPORT_DIR"; do
    if [[ -f "$d/000_prelude.sql" ]]; then SQL_DIR=$(cd "$d" && pwd -P); break; fi
  done
fi
[[ -n "$SQL_DIR" ]] || die "cannot find 000_prelude.sql (use --sql-dir)"
SQL_DIR=$(cd "$SQL_DIR" && pwd -P)
for f in 000_prelude.sql 001_post_restore.sql 002_app_sessions.sql roles.sql; do
  [[ -f "$SQL_DIR/$f" ]] || die "missing $SQL_DIR/$f"
done
# Migrations run in name order; two files with the same number would run in an
# order nobody chose.
dup_nums=$(cd "$SQL_DIR" && ls -1 | sed -n 's/^\([0-9][0-9][0-9]\)_.*\.sql$/\1/p' | sort | uniq -d | tr '\n' ' ')
[[ -z "$dup_nums" ]] || die "$SQL_DIR has more than one migration numbered: ${dup_nums}(renumber them)"
[[ -z "$EXPECT_COUNTS" || -r "$EXPECT_COUNTS" ]] || die "cannot read $EXPECT_COUNTS"
log "SQL files from ${SQL_DIR}"

# --- passwords (never printed, never on a command line) ----------------------------
APP_PW=""
if [[ -n "$ENV_FILE" ]]; then
  [[ -r "$ENV_FILE" ]] || die "cannot read $ENV_FILE"
  APP_PW=$(sed -n 's/^OV_APP_PW=//p' "$ENV_FILE" | tail -n1)
  APP_PW=${APP_PW%$'\r'}
  if [[ ${#APP_PW} -ge 2 && ( ( "$APP_PW" == \'*\' ) || ( "$APP_PW" == \"*\" ) ) ]]; then APP_PW=${APP_PW:1:${#APP_PW}-2}; fi
  [[ -n "$APP_PW" ]] || die "OV_APP_PW is empty in $ENV_FILE"
elif [[ -n "${OV_APP_PW:-}" ]]; then
  APP_PW=$OV_APP_PW
fi
if [[ -n "$APP_PW" ]]; then
  # DATABASE_URL embeds it unescaped, and the \set line quotes it with '.
  [[ "$APP_PW" =~ ^[A-Za-z0-9._~-]{16,}$ ]] || die "OV_APP_PW must be URL-safe and at least 16 characters (openssl rand -hex 32)"
fi
SCRUB_PW=""
if [[ -n "$SCRUB_EMAIL" ]]; then
  SCRUB_PW=${OV_REHEARSAL_PW:-}
  [[ "$SCRUB_PW" =~ ^[A-Za-z0-9._~-]{8,72}$ ]] || die "--scrub-except needs OV_REHEARSAL_PW (8-72 chars of A-Za-z0-9._~-) in the environment"
  [[ "$SCRUB_EMAIL" =~ ^[^\'\\[:space:]]+@[^\'\\[:space:]]+$ ]] || die "--scrub-except: not an email address"
fi

# --- docker helpers ----------------------------------------------------------------
command -v docker >/dev/null || die "docker not found"
[[ "$(docker inspect -f '{{.State.Running}}' "$C" 2>/dev/null)" == true ]] || die "container ${C} is not running"

CREATED=0
OLD_DB=""
WORK=$(mktemp -d "${TMPDIR:-/tmp}/ov-restore.XXXXXX")
CTOC="/tmp/ov-restore-$$-$RANDOM.toc"
cleanup() {
  local rc=$?
  rm -rf -- "$WORK"
  docker exec "$C" rm -f "$CTOC" </dev/null >/dev/null 2>&1 || true
  if (( rc != 0 && CREATED )); then
    log "FAILED (exit ${rc}). ${DB_NAME} is marked '${MARK_RUNNING}': fix the cause and run restore.sh again, it replaces that database without --force as long as the app has not used it."
  fi
  if (( rc != 0 )) && [[ -n "$OLD_DB" ]]; then
    log "The previous database is kept as \"${OLD_DB}\" (to go back: drop ${DB_NAME}, then ALTER DATABASE \"${OLD_DB}\" RENAME TO ${DB_NAME})."
  fi
  return "$rc"
}
trap cleanup EXIT
trap 'exit 143' TERM INT HUP

# psql on the target database. SQL arrives on stdin (or -c); output quiet.
psql_db() { docker exec -i "$C" psql -X -q -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 "$@"; }
# One value (or rows) from the target database; stdin is never read.
query_db() { docker exec "$C" psql -X -q -At -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -c "$1" </dev/null; }
# Same on the maintenance database `postgres`.
query_admin() { docker exec "$C" psql -X -q -At -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 -c "$1" </dev/null; }
# A SQL file (or stdin) run with a psql variable prepended as a \set line.
psql_db_with() {  # name value file
  { printf "\\\\set %s '%s'\n" "$1" "$2"; cat "$3"; } | psql_db
}

docker exec "$C" pg_isready -q -U "$DB_USER" -d postgres </dev/null || die "postgres in ${C} is not ready"
is_super=$(query_admin "select rolsuper from pg_roles where rolname = current_user") || die "cannot connect as ${DB_USER} (use --db-user)"
[[ "$is_super" == t ]] || die "${DB_USER} is not a superuser in ${C}"
server_major=$(query_admin "show server_version_num"); server_major=${server_major:0:2}
[[ "$server_major" == 17 ]] || log "WARNING: server is PostgreSQL ${server_major}, the dump and these scripts target 17"

# --- 0. archive and CSV -------------------------------------------------------------------
docker exec -i "$C" pg_restore -l <"$DUMP" >"$WORK/toc.full" || die "pg_restore cannot read the table of contents of $DUMP"
grep -q ' TABLE public matches ' "$WORK/toc.full" || die "$DUMP has no table public.matches: wrong archive?"
if (( ! PRINT_TOC )); then
  [[ -f "$CSV" ]] || die "missing: $CSV"
  header=$(head -n1 "$CSV" | tr -d '\r"')
  [[ "$header" == "$CSV_COLUMNS" ]] || die "unexpected header in $CSV (want: $CSV_COLUMNS)"
fi

# --- 1. restore list ------------------------------------------------------------------------
# Foreign keys to auth.*: from the post-data DDL (the TOC line does not say
# what a constraint references). Output: "<table> <constraint>" per line.
docker exec -i "$C" pg_restore -s --section=post-data -f - <"$DUMP" \
  | awk '
      /^ALTER TABLE / { t = $NF; sub(/^public\./, "", t); next }
      /ADD CONSTRAINT .* FOREIGN KEY .* REFERENCES auth\./ {
        for (i = 1; i <= NF; i++) if ($i == "CONSTRAINT") { print t, $(i + 1); break }
      }' >"$WORK/auth_fks" || die "cannot read the post-data section of $DUMP"

if [[ -f "$EXPORT_DIR/toc.keep" ]]; then
  log "using the hand-edited restore list $EXPORT_DIR/toc.keep"
  cp -- "$EXPORT_DIR/toc.keep" "$WORK/toc.keep"
else
  # Entry lines: "<id>; <catalog oid> <oid> <TYPE ...> <schema> <name> <owner>".
  grep -vE '^[0-9]+; [0-9]+ [0-9]+ (POLICY|ROW SECURITY|PUBLICATION|PUBLICATION TABLE|PUBLICATION TABLES IN SCHEMA|ACL|DEFAULT ACL) ' "$WORK/toc.full" \
    | grep -vE '^[0-9]+; [0-9]+ [0-9]+ (SCHEMA - public|COMMENT - SCHEMA public) ' \
    | grep -vE '^[0-9]+; [0-9]+ [0-9]+ COMMENT - EXTENSION ' >"$WORK/toc.step"
  cp -- "$WORK/toc.step" "$WORK/toc.keep"
  while read -r tbl con; do
    [[ -n "$tbl" ]] || continue
    grep -vF " FK CONSTRAINT public ${tbl} ${con} " "$WORK/toc.keep" >"$WORK/toc.tmp" || true
    mv -f "$WORK/toc.tmp" "$WORK/toc.keep"
  done <"$WORK/auth_fks"
fi
if (( PRINT_TOC )); then
  cat "$WORK/toc.keep"
  printf ';\n; dropped from %s:\n' "$(basename "$DUMP")"
  { diff <(grep -v '^;' "$WORK/toc.full") <(grep -v '^;' "$WORK/toc.keep") || true; } | sed -n 's/^< /; /p'
  exit 0
fi
# Table data the list leaves out would restore that table empty, and every
# later check would still pass.
toc_data() { sed -nE 's/^[0-9]+; [0-9]+ [0-9]+ TABLE DATA public ([^ ]+) .*/\1/p' "$1" | sort -u; }
missing_data=$(comm -23 <(toc_data "$WORK/toc.full") <(toc_data "$WORK/toc.keep") | tr '\n' ' ')
if [[ -n "$missing_data" ]]; then
  if (( ALLOW_MISSING_DATA )); then
    log "WARNING: --allow-missing-data: these tables are restored EMPTY: ${missing_data}"
  else
    die "the restore list leaves out the data of: ${missing_data}(fix toc.keep, or --allow-missing-data if that is intended)"
  fi
fi
dropped=$(( $(grep -vc '^;' "$WORK/toc.full") - $(grep -vc '^;' "$WORK/toc.keep") ))
log "restore list: $(grep -vc '^;' "$WORK/toc.keep") entries kept, ${dropped} dropped (policies/RLS/publications/ACLs/public schema, $(wc -l <"$WORK/auth_fks") FK(s) to auth re-created by 001)"

# --- 2. target database ---------------------------------------------------------------------
# A value later than the mark in <schema.table>.<column> means the app ran on
# the database. Prints true/false, or nothing when that column does not exist.
newer_than() {  # table column timestamp
  query_db "select (xpath('/row/x/text()', query_to_xml(format('select exists (select 1 from %s where %I > %L::timestamptz) as x', '$1', '$2', '$3'), false, true, '')))[1]::text
              from information_schema.columns
             where table_schema || '.' || table_name = '$1' and column_name = '$2'"
}
exists=$(query_admin "select count(*) from pg_database where datname = '${DB_NAME}'")
if [[ "$exists" == 1 ]]; then
  mark=$(query_admin "select coalesce(shobj_description(oid, 'pg_database'), '') from pg_database where datname = '${DB_NAME}'")
  with_data=$(query_db "select coalesce(string_agg(c.oid::regclass::text, ' ' order by c.oid::regclass::text), '')
      from pg_class c
     where c.relnamespace in (select oid from pg_namespace where nspname in ('public', 'auth'))
       and c.relkind in ('r', 'p')
       and (xpath('/row/x/text()', query_to_xml(format('select exists (select 1 from %s) as x', c.oid::regclass), false, true, '')))[1]::text = 'true'")
  replace=drop
  if [[ -n "$with_data" ]]; then
    # The comment alone is not enough: after a failed verification someone may
    # have fixed the database by hand and put it into service.
    used=""
    if [[ "$mark" =~ ^"${MARK_RUNNING}"\ since\ ([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z)$ ]]; then
      since=${BASH_REMATCH[1]}
      [[ " ${with_data} " != *" auth.app_sessions "* ]] || used+="auth.app_sessions has rows; "
      for tc in "public.matches updated_at" "public.svrz_sync_log started_at" "public.svrz_games synced_at" "auth.users last_sign_in_at"; do
        read -r t col <<<"$tc"
        newer=$(newer_than "$t" "$col" "$since") || die "cannot check ${t}.${col} of ${DB_NAME}"
        [[ "$newer" != true ]] || used+="${t}.${col} after ${since}; "
      done
    else
      used="not marked as an unfinished restore.sh run"
    fi
    if [[ -z "$used" ]]; then
      log "${DB_NAME} holds rows from an unfinished restore.sh run (${mark}) that the app never used; replacing it"
    elif (( FORCE )); then
      log "WARNING: --force: replacing ${DB_NAME}, whose tables hold data: ${with_data}"
      replace=rename
    else
      die "${DB_NAME} already holds data (${with_data})${mark:+; marked '${mark}'}; ${used%; }. Refusing; --force keeps it as ${DB_NAME}_pre_restore_<UTC> and loads a fresh one."
    fi
  fi
  # Client sessions only: autovacuum workers and the like do not count (DROP
  # and RENAME stop those themselves). A client that connects after this check
  # makes the DROP/RENAME below fail, which stops the script.
  others=$(query_admin "select count(*) from pg_stat_activity where datname = '${DB_NAME}' and backend_type = 'client backend' and pid <> pg_backend_pid()")
  [[ "$others" == 0 ]] || die "${others} client session(s) connected to ${DB_NAME}; stop ov-backend (docker compose stop ov-tunnel ov-backend) first"
  if [[ "$replace" == rename ]]; then
    # Same name as deploy/restore-db.sh uses (quoted: it has capitals).
    OLD_DB="${DB_NAME:0:34}_pre_restore_$(date -u +%Y%m%dT%H%M%SZ)"
    query_admin "alter database \"${DB_NAME}\" rename to \"${OLD_DB}\"" >/dev/null || die "rename ${DB_NAME} -> ${OLD_DB}"
    log "previous ${DB_NAME} kept as ${OLD_DB}"
  else
    query_admin "drop database \"${DB_NAME}\"" >/dev/null || die "drop database ${DB_NAME}"
  fi
fi
query_admin "create database \"${DB_NAME}\" template template0" >/dev/null || die "create database ${DB_NAME}"
CREATED=1
query_admin "comment on database \"${DB_NAME}\" is '${MARK_RUNNING} since $(date -u +%FT%TZ)'" >/dev/null
log "database ${DB_NAME} created fresh in ${C}"

# --- 3. prelude ---------------------------------------------------------------------------------
psql_db <"$SQL_DIR/000_prelude.sql" >/dev/null || die "000_prelude.sql"
log "000_prelude.sql ok"

# --- 4. users CSV ---------------------------------------------------------------------------------
psql_db -c '\copy auth.users_import from pstdin with (format csv, header match)' <"$CSV" >/dev/null \
  || die "loading $CSV into auth.users_import"
csv_rows=$(query_db "select count(*) from auth.users_import")
log "auth_users.csv: ${csv_rows} rows staged"

# --- 5. pg_restore ------------------------------------------------------------------------------------
docker exec -i "$C" sh -c 'umask 077; cat > "$1"' sh "$CTOC" <"$WORK/toc.keep" || die "cannot write the restore list into ${C}:${CTOC}"
docker exec -i "$C" pg_restore -U "$DB_USER" -d "$DB_NAME" --no-owner --no-privileges \
  --exit-on-error --single-transaction -L "$CTOC" <"$DUMP" \
  || die "pg_restore (nothing of the dump was committed). Adjust the list: restore.sh --print-toc ... > ${EXPORT_DIR}/toc.keep"
log "pg_restore ok"

# --- 6. post-restore (+ scrub) --------------------------------------------------------------------------
psql_db <"$SQL_DIR/001_post_restore.sql" >/dev/null || die "001_post_restore.sql"
log "001_post_restore.sql ok"

if [[ -n "$SCRUB_EMAIL" ]]; then
  cat >"$WORK/scrub.sql" <<'SQL'
\set ON_ERROR_STOP on
BEGIN;
-- The rehearsal password travels in these statements: keep them out of the log.
SET LOCAL log_statement = 'none';
SET LOCAL log_min_duration_statement = -1;
SET LOCAL log_min_error_statement = panic;
SELECT count(*) = 1 AS keep_ok FROM auth.users WHERE email = lower(:'keep_email') \gset
\if :keep_ok
\else
DO $$ BEGIN RAISE EXCEPTION '--scrub-except: no account with that email'; END $$;
\endif
SELECT set_config('ov.keep_id', (SELECT id::text FROM auth.users WHERE email = lower(:'keep_email')), true);
CREATE SCHEMA ov_scrub;
CREATE EXTENSION pgcrypto WITH SCHEMA ov_scrub;
SELECT set_config('ov.scrub_hash', ov_scrub.crypt(:'scrub_pw', ov_scrub.gen_salt('bf', 10)), true);
DROP EXTENSION pgcrypto;
DROP SCHEMA ov_scrub;
DO $$
DECLARE
  keep uuid := current_setting('ov.keep_id')::uuid;
  n    bigint;
BEGIN
  CREATE TEMP TABLE scrub_n ON COMMIT DROP AS
    SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn FROM auth.users WHERE id <> keep;
  UPDATE auth.users u
     SET email = format('user-%s@rehearsal.invalid', s.rn),
         encrypted_password = current_setting('ov.scrub_hash'),
         raw_user_meta_data = '{}'::jsonb,
         email_confirmed_at = coalesce(u.email_confirmed_at, now())
    FROM scrub_n s WHERE u.id = s.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF to_regclass('public.profiles') IS NOT NULL THEN
    UPDATE public.profiles p SET first_name = 'Rehearsal', last_name = format('User %s', s.rn), dob = NULL
      FROM scrub_n s WHERE p.user_id = s.id;
  END IF;
  RAISE NOTICE 'scrubbed % account(s); kept %', n, keep;
END $$;
COMMIT;
SQL
  { printf "\\\\set keep_email '%s'\n\\\\set scrub_pw '%s'\n" "$SCRUB_EMAIL" "$SCRUB_PW"; cat "$WORK/scrub.sql"; } \
    | psql_db >/dev/null || die "scrub"
  log "scrubbed every account except the one given to --scrub-except"
fi

# --- 7. migrations ---------------------------------------------------------------------------------------
psql_db <"$SQL_DIR/002_app_sessions.sql" >/dev/null || die "002_app_sessions.sql"
log "002_app_sessions.sql ok"
shopt -s nullglob
for f in "$SQL_DIR"/[0-9][0-9][0-9]_*.sql; do
  n=$(basename "$f"); n=${n%%_*}
  (( 10#$n >= 3 )) || continue
  psql_db <"$f" >/dev/null || die "$(basename "$f")"
  log "$(basename "$f") ok"
done
shopt -u nullglob

# --- 8. roles ------------------------------------------------------------------------------------------
if [[ -n "$APP_PW" ]]; then
  psql_db_with ov_app_pw "$APP_PW" "$SQL_DIR/roles.sql" >/dev/null 2>"$WORK/roles.err" \
    || { cat "$WORK/roles.err" >&2; die "roles.sql"; }
  log "roles.sql ok (ov_app password set)"
else
  psql_db <"$SQL_DIR/roles.sql" >/dev/null 2>"$WORK/roles.err" || { cat "$WORK/roles.err" >&2; die "roles.sql"; }
  log "roles.sql ok (ov_app password NOT set: run deploy/apply-roles.sh < roles.sql before starting the backend)"
fi

# --- 9. verification --------------------------------------------------------------------------------------
psql_db -c 'ANALYZE' >/dev/null </dev/null
problems=()

while read -r tbl con; do
  [[ -n "$tbl" ]] || continue
  ok=$(query_db "select count(*) from pg_constraint where conname = '${con}' and conrelid = to_regclass('public.${tbl}') and contype = 'f' and confrelid = 'auth.users'::regclass")
  [[ "$ok" == 1 ]] || problems+=("foreign key public.${tbl}.${con} -> auth.users was left out of the restore list but not re-created (add it to 001_post_restore.sql)")
done <"$WORK/auth_fks"

ok=$(query_db "select count(*) from pg_constraint where conname = 'match_live_state_match_id_fkey_cascade' and conrelid = to_regclass('public.match_live_state') and confrelid = to_regclass('public.matches') and contype = 'f'")
[[ "$ok" == 1 ]] || problems+=("match_live_state_match_id_fkey_cascade (match_live_state.match_id -> matches.id) is missing: pgQuery's livescore embed is named after it")

rls=$(query_db "select coalesce(string_agg(oid::regclass::text, ' '), '') from pg_class where relnamespace in ('public'::regnamespace, 'auth'::regnamespace) and (relrowsecurity or relforcerowsecurity)")
[[ -z "$rls" ]] || problems+=("row level security still enabled on: ${rls}")
pol=$(query_db "select count(*) from pg_policies where schemaname in ('public', 'auth')")
[[ "$pol" == 0 ]] || problems+=("${pol} policies left in public/auth")

# Every column-owned / identity sequence must be ahead of its column's max.
seqs=$(query_db "select coalesce(string_agg(format('%s(%s.%s)', s.seq, s.tbl, s.col), ' '), '')
  from (select d.objid::regclass as seq, d.refobjid::regclass as tbl, a.attname as col
          from pg_depend d
          join pg_class sc on sc.oid = d.objid and sc.relkind = 'S'
          join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
         where d.classid = 'pg_class'::regclass and d.refclassid = 'pg_class'::regclass
           and d.deptype in ('a', 'i') and sc.relnamespace in ('public'::regnamespace, 'auth'::regnamespace)) s
 where (xpath('/row/m/text()', query_to_xml(format('select coalesce(max(%I), 0) as m from %s', s.col, s.tbl), false, true, '')))[1]::text::numeric
       > (select coalesce(last_value, 0) from pg_sequences where format('%I.%I', schemaname, sequencename)::regclass = s.seq)")
[[ -z "$seqs" ]] || problems+=("sequences behind their column (setval needed): ${seqs}")

own=$(query_db "select concat_ws(' ',
    (select string_agg(oid::regclass::text, ' ') from pg_class
      where relnamespace in ('public'::regnamespace, 'auth'::regnamespace) and relkind in ('r', 'p', 'v', 'm', 'f', 'S')
        and relowner <> 'ov_owner'::regrole),
    (select string_agg(oid::regprocedure::text, ' ') from pg_proc
      where pronamespace in ('public'::regnamespace, 'auth'::regnamespace) and proowner <> 'ov_owner'::regrole),
    (select string_agg(oid::regtype::text, ' ') from pg_type
      where typnamespace in ('public'::regnamespace, 'auth'::regnamespace) and typtype = 'e' and typowner <> 'ov_owner'::regrole))")
[[ -z "$own" ]] || problems+=("not owned by ov_owner: ${own}")

enum=$(query_db "select coalesce(string_agg(enumlabel, ',' order by enumsortorder), '') from pg_enum where enumtypid = to_regtype('public.sport_type')")
[[ -n "$enum" ]] || problems+=("enum public.sport_type is missing")
best_of=$(query_db "select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'match_live_state' and column_name = 'best_of'")
[[ "$best_of" == 1 ]] || problems+=("match_live_state.best_of is missing")

users=$(query_db "select count(*) from auth.users")
[[ "$users" == "$csv_rows" ]] || problems+=("auth.users has ${users} rows, auth_users.csv had ${csv_rows}")

grants=$(query_db "select concat_ws(' ',
    case when not has_table_privilege('ov_app', 'public.matches', 'SELECT, INSERT, UPDATE, DELETE') then 'no-DML-on-matches' end,
    case when not has_table_privilege('ov_app', 'auth.app_sessions', 'SELECT, INSERT, UPDATE, DELETE') then 'no-DML-on-app_sessions' end,
    case when to_regclass('auth.app_tokens') is not null and not has_table_privilege('ov_app', 'auth.app_tokens', 'SELECT, INSERT, UPDATE, DELETE') then 'no-DML-on-app_tokens' end,
    case when not has_column_privilege('ov_app', 'auth.users', 'last_sign_in_at', 'UPDATE') then 'no-update-last_sign_in_at' end,
    case when has_column_privilege('ov_app', 'auth.users', 'email', 'UPDATE') then 'can-update-users.email' end,
    case when has_schema_privilege('ov_app', 'public', 'CREATE') or has_schema_privilege('ov_app', 'auth', 'CREATE') then 'can-CREATE' end,
    case when has_table_privilege('ov_app', 'public.matches', 'TRUNCATE') then 'can-TRUNCATE' end,
    case when to_regclass('public.svrz_sync_log') is not null and not has_table_privilege('ov_app', 'public.svrz_sync_log', 'SELECT, INSERT, UPDATE') then 'no-DML-on-svrz_sync_log' end,
    case when to_regclass('public.svrz_sync_log_id_seq') is not null and not has_sequence_privilege('ov_app', 'public.svrz_sync_log_id_seq', 'USAGE') then 'no-USAGE-on-svrz_sync_log_id_seq' end,
    case when to_regclass('public.svrz_games') is not null and not has_table_privilege('ov_app', 'public.svrz_games', 'SELECT, INSERT, UPDATE') then 'no-DML-on-svrz_games' end,
    case when exists (select 1 from pg_roles where rolname = 'ov_app' and (rolsuper or rolcreaterole or rolcreatedb or rolbypassrls)) then 'privileged-role' end)")
[[ -z "$grants" ]] || problems+=("ov_app grants wrong: ${grants}")

if [[ -n "$APP_PW" ]]; then
  if ! PGPASSWORD="$APP_PW" docker exec -e PGPASSWORD "$C" \
        psql -X -h 127.0.0.1 -U ov_app -d "$DB_NAME" -At -c 'select count(*) from public.matches' </dev/null >/dev/null 2>&1; then
    problems+=("ov_app cannot log in over TCP or read public.matches")
  fi
fi

if [[ -n "$EXPECT_COUNTS" ]]; then
  declare -A want=()
  while IFS= read -r line; do
    if [[ "$line" =~ ^[[:space:]]*(public\.)?([a-z_][a-z0-9_]*)([[:space:]]*\|[[:space:]]*|[[:space:]]+)([0-9]+)[[:space:]]*$ ]]; then
      t=${BASH_REMATCH[2]} v=${BASH_REMATCH[4]}
      [[ -z "${want[$t]:-}" || "${want[$t]}" == "$v" ]] || problems+=("${EXPECT_COUNTS} lists ${t} twice (${want[$t]} and ${v})")
      want[$t]=$v
    fi
  done <"$EXPECT_COUNTS"
  actual=$(query_db "select format('%s %s', c.relname, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %s', c.oid::regclass), false, true, '')))[1]::text)
                       from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') order by 1")
  while read -r t v; do
    [[ -n "$t" ]] || continue
    if [[ -z "${want[$t]:-}" ]]; then problems+=("${EXPECT_COUNTS} has no count for public.${t} (restored ${v})")
    elif [[ "${want[$t]}" != "$v" ]]; then problems+=("public.${t} has ${v} rows, ${EXPECT_COUNTS} expects ${want[$t]}")
    fi
  done <<<"$actual"
fi

log "row counts (${DB_NAME} in ${C}):"
query_db "select format('%-36s %s', s.t, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %s', s.t), false, true, '')))[1]::text)
            from (select c.oid::regclass::text as t from pg_class c
                   where c.relnamespace in ('public'::regnamespace, 'auth'::regnamespace) and c.relkind in ('r', 'p')) s
           order by s.t" | sed 's/^/[restore]   /' >&2
log "sport_type enum: ${enum}"

if (( ${#problems[@]} )); then
  for p in "${problems[@]}"; do printf '[restore] CHECK FAILED: %s\n' "$p" >&2; done
  die "${#problems[@]} verification check(s) failed; the database stays marked '${MARK_RUNNING}'"
fi

# "(rehearsal, scrubbed)" is what tests/helpers/pgTestDb.js looks for before it
# copies a database for PG_TEST_TEMPLATE.
query_admin "comment on database \"${DB_NAME}\" is '${MARK_DONE} $(date -u +%FT%TZ) from $(basename "$DUMP") sha256:$(sha256sum <"$DUMP" | cut -c1-16)${SCRUB_EMAIL:+ (rehearsal, scrubbed)}'" >/dev/null
matches=$(query_db "select count(*) from public.matches")
log "OK: ${DB_NAME} restored and verified (matches=${matches}, users=${users})."
log "    /health floor: OV_MIN_MATCHES=$(( matches * 9 / 10 ))"
[[ -z "$OLD_DB" ]] || log "    The previous database is kept as \"${OLD_DB}\": DROP DATABASE it once this one is in service."
[[ -n "$APP_PW" ]] || log "    Next: deploy/apply-roles.sh < roles.sql (sets the ov_app password), then start the backend."
