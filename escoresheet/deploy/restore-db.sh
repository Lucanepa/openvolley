#!/usr/bin/env bash
# restore-db.sh [--counts FILE] [--drop-previous] DUMP | -
#
# Restores a DECRYPTED `pg_dump -Fc` archive (a file, or `-` for stdin) into a
# FRESH `openvolley` database inside ov-postgres. Used for the data-corruption
# rollback (RUNBOOK-hetzner.md) and for the move to another VM
# (RUNBOOK-move-to-own-vm.md, steps 5 and 8).
#
#   1. refuses while ov-backend or ov-tunnel run, or while the backup timers are
#      active; holds the backup lock for the whole run, so no dump or rotation
#      can interleave
#   2. renames the current database to openvolley_pre_restore_<UTC>
#   3. CREATE DATABASE openvolley (from template0), then pg_restore
#      --exit-on-error --single-transaction --no-owner --no-privileges.
#      A fresh database instead of `--clean`: nothing from the old database can
#      survive (objects or rows missing from the dump), and the single
#      transaction means a truncated stream or any error leaves no half state.
#   4. with --counts: matches / events / auth.users must be within
#      OV_RESTORE_SLACK_PCT (default 1) of the dump's .counts file
#   5. touches <backups>/counts.reset, so the next backup accepts the restored
#      counts as its new baseline instead of tripping the count-drop guard
#   Any failure in 3-4 drops the new database and renames the old one back:
#   the cluster is exactly as before. On success the old database is kept for
#   comparison (drop it later to free space) unless --drop-previous is given.
#
# Next steps (printed at the end): apply-roles.sh < roles.sql, docker compose
# up -d, re-enable the backup timers.
#
# Settings: /etc/openvolley/backup.conf (OV_PROJECT, OV_BACKUP_DIR) and/or the
# environment; OV_LOCK_FILE (default /run/lock/openvolley-backup.lock).
set -euo pipefail
umask 077

CONF=${OV_BACKUP_CONF:-/etc/openvolley/backup.conf}
if [[ -f "$CONF" ]]; then
  # shellcheck source=/dev/null
  . "$CONF"
fi
OV_PROJECT=${OV_PROJECT:-openvolley}
OV_DB_NAME=${OV_DB_NAME:-openvolley}
OV_BACKUP_DIR=${OV_BACKUP_DIR:-/data/openvolley/backups}
OV_LOCK_FILE=${OV_LOCK_FILE:-/run/lock/openvolley-backup.lock}
OV_RESTORE_SLACK_PCT=${OV_RESTORE_SLACK_PCT:-1}

COUNTS=""
DROP_PREV=0
SRC=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --counts) COUNTS=${2:?--counts needs a file}; shift 2 ;;
    --drop-previous) DROP_PREV=1; shift ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    -) SRC=-; shift ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) SRC=$1; shift ;;
  esac
done
[[ -n "$SRC" ]] || { echo "usage: $0 [--counts FILE] [--drop-previous] DUMP|-" >&2; exit 2; }

TS=$(date -u +%Y%m%dT%H%M%SZ)
OLD="${OV_DB_NAME}_pre_restore_${TS}"
STATE=start   # start -> renamed -> created | created-fresh -> finished

log() { printf '[restore-db] %s\n' "$*"; }

container() {  # service -> running container id(s)
  docker ps -q --filter "label=com.docker.compose.project=${OV_PROJECT}" \
               --filter "label=com.docker.compose.service=$1"
}

psql_admin() {  # SQL (-c) on the maintenance db `postgres`, as ov_owner over the socket.
  # No -i and stdin from /dev/null: with `-` the dump arrives on OUR stdin and
  # must reach pg_restore untouched.
  docker exec "$PG" psql -X -q -At -U ov_owner -d postgres -v ON_ERROR_STOP=1 "$@" </dev/null
}

undo() {
  case "$STATE" in
    created)
      log "rolling back: dropping the new ${OV_DB_NAME}, renaming ${OLD} back"
      psql_admin -c "DROP DATABASE IF EXISTS \"${OV_DB_NAME}\" WITH (FORCE)" || true
      psql_admin -c "ALTER DATABASE \"${OLD}\" RENAME TO \"${OV_DB_NAME}\"" \
        || log "ROLLBACK INCOMPLETE: rename ${OLD} back to ${OV_DB_NAME} by hand"
      ;;
    created-fresh)
      log "rolling back: dropping the new ${OV_DB_NAME} (there was no previous one)"
      psql_admin -c "DROP DATABASE IF EXISTS \"${OV_DB_NAME}\" WITH (FORCE)" || true
      ;;
    renamed)
      psql_admin -c "ALTER DATABASE \"${OLD}\" RENAME TO \"${OV_DB_NAME}\"" \
        || log "ROLLBACK INCOMPLETE: rename ${OLD} back to ${OV_DB_NAME} by hand"
      ;;
  esac
}

fail() {
  printf '[restore-db] FAILED: %s\n' "$1" >&2
  undo
  STATE=failed
  exit 1
}
on_exit() {  # unexpected exit (set -e, signal) after a change: put it back
  local rc=$?
  if [[ $rc -ne 0 && "$STATE" != failed && "$STATE" != finished ]]; then undo; fi
}
trap on_exit EXIT
trap 'exit 143' TERM INT HUP

# --- 1. preconditions ----------------------------------------------------------------
if [[ "$SRC" != - ]]; then
  [[ -f "$SRC" && -s "$SRC" ]] || fail "no such dump file (or empty): $SRC"
  [[ "$(head -c 5 "$SRC")" == PGDMP ]] \
    || fail "$SRC is not a pg_dump custom-format archive (still GPG-encrypted? decrypt it on lenovoserver)"
fi
if [[ -n "$COUNTS" ]]; then
  [[ -f "$COUNTS" ]] || fail "no such counts file: $COUNTS"
  read -r CM CE CU <"$COUNTS" || true
  [[ "${CM:-}" =~ ^[0-9]+$ && "${CE:-}" =~ ^[0-9]+$ && "${CU:-}" =~ ^[0-9]+$ ]] || fail "unreadable counts file: $COUNTS"
fi

mapfile -t ids < <(container ov-postgres)
(( ${#ids[@]} == 1 )) || fail "expected one running ov-postgres of project ${OV_PROJECT}, found ${#ids[@]}"
PG=${ids[0]}
for s in ov-backend ov-tunnel; do
  [[ -z "$(container "$s")" ]] || fail "${s} is running; first: docker compose stop ov-tunnel ov-backend"
done
if command -v systemctl >/dev/null 2>&1; then
  for t in openvolley-backup.timer openvolley-backup-files.timer; do
    if systemctl is-active --quiet "$t" 2>/dev/null; then
      fail "${t} is active; first: systemctl stop openvolley-backup.timer openvolley-backup-files.timer"
    fi
  done
fi
exec 9>"$OV_LOCK_FILE"
flock -n 9 || fail "a backup run holds ${OV_LOCK_FILE}; wait for it to finish"

others=$(psql_admin -c "select count(*) from pg_stat_activity where datname = '${OV_DB_NAME}' and pid <> pg_backend_pid()") \
  || fail "cannot query ov-postgres"
[[ "$others" == 0 ]] || fail "${others} session(s) still connected to ${OV_DB_NAME}; close them first (see pg_stat_activity)"

if [[ "$SRC" != - ]]; then
  docker exec -i "$PG" pg_restore -l <"$SRC" >/dev/null || fail "pg_restore cannot read the archive's table of contents"
fi

# --- 2. move the current database aside ----------------------------------------------
exists=$(psql_admin -c "select count(*) from pg_database where datname = '${OV_DB_NAME}'")
if [[ "$exists" == 1 ]]; then
  psql_admin -c "ALTER DATABASE \"${OV_DB_NAME}\" RENAME TO \"${OLD}\"" || fail "rename ${OV_DB_NAME} -> ${OLD}"
  STATE=renamed
  log "current database kept as ${OLD}"
fi

# --- 3. fresh database + all-or-nothing restore ----------------------------------------
psql_admin -c "CREATE DATABASE \"${OV_DB_NAME}\" TEMPLATE template0" || fail "create database"
if [[ "$STATE" == renamed ]]; then STATE=created; else STATE=created-fresh; fi

log "pg_restore (single transaction) from ${SRC/#-/stdin}"
if [[ "$SRC" == - ]]; then
  docker exec -i "$PG" pg_restore -U ov_owner -d "$OV_DB_NAME" \
    --no-owner --no-privileges --exit-on-error --single-transaction \
    || fail "pg_restore (nothing was committed)"
else
  docker exec -i "$PG" pg_restore -U ov_owner -d "$OV_DB_NAME" \
    --no-owner --no-privileges --exit-on-error --single-transaction <"$SRC" \
    || fail "pg_restore (nothing was committed)"
fi
docker exec "$PG" psql -X -q -U ov_owner -d "$OV_DB_NAME" -c 'ANALYZE' </dev/null >/dev/null || true

# --- 4. counts -----------------------------------------------------------------------------
counts=$(docker exec "$PG" psql -X -U ov_owner -d "$OV_DB_NAME" -At -F' ' -v ON_ERROR_STOP=1 -c \
  "select (select count(*) from public.matches),(select count(*) from public.events),(select count(*) from auth.users)" </dev/null) \
  || fail "count query on the restored database"
read -r M E U <<<"$counts"
log "restored counts: matches=$M events=$E users=$U"
within() {  # actual expected slack-pct
  local a=$1 e=$2 s=$3 d
  d=$(( a > e ? a - e : e - a ))
  (( d * 100 <= e * s ))
}
if [[ -n "$COUNTS" ]]; then
  if ! { within "$M" "$CM" "$OV_RESTORE_SLACK_PCT" && within "$E" "$CE" "$OV_RESTORE_SLACK_PCT" && within "$U" "$CU" "$OV_RESTORE_SLACK_PCT"; }; then
    fail "restored ${M}/${E}/${U} differ from the dump's counts ${CM}/${CE}/${CU} by more than ${OV_RESTORE_SLACK_PCT}%"
  fi
  log "counts match ${COUNTS} (${CM}/${CE}/${CU})"
fi
STATE=finished

# --- 5. after success ----------------------------------------------------------------------
if [[ -d "$OV_BACKUP_DIR" ]]; then
  : >"$OV_BACKUP_DIR/counts.reset"
  log "touched ${OV_BACKUP_DIR}/counts.reset (next backup takes the restored counts as baseline)"
fi
if [[ "$exists" == 1 ]]; then
  if (( DROP_PREV )); then
    psql_admin -c "DROP DATABASE \"${OLD}\"" && log "dropped ${OLD}"
  else
    log "previous database kept as ${OLD}; when satisfied:"
    log "  docker compose exec -T ov-postgres psql -U ov_owner -d postgres -c 'DROP DATABASE \"${OLD}\"'"
  fi
fi
log "OK. Next: ./apply-roles.sh < roles.sql; docker compose up -d; systemctl start openvolley-backup.service;"
log "    systemctl enable --now openvolley-backup.timer openvolley-backup-files.timer"
