#!/usr/bin/env bash
# backup-openvolley.sh [--with-files]
#
# Hourly (systemd openvolley-backup.timer):
#   pg_dump -Fc of the whole `openvolley` database, run in the compose
#   service ov-backup (its own CPU quota, niced: never in ov-postgres's share),
#   encrypted to the openvolley-backup PUBLIC key (the private key is never on
#   this host), written atomically as db-<UTC>.dump.gpg plus a plain
#   db-<UTC>.counts file.
#   wal/<segment>.gpg          the WAL segments ov-postgres archived since the
#                              last run (compose.yaml archive_command), for a
#                              restore to a point in time (RUNBOOK-hetzner.md)
# Nightly with --with-files (openvolley-backup-files.timer), additionally:
#   base-<UTC>.tar.gpg         pg_basebackup: the starting point the WAL
#                              segments are replayed on
#   scoresheets-<UTC>.tar.gpg  every file under storage/scoresheets plus the
#                              owner records storage/.owners (who may read or
#                              replace each one)
#   snapshots-<UTC>.tar.gpg    storage/backup files changed in the last ~26 h
#                              (increments: restore-storage.sh unpacks them
#                              in order)
#   secrets-<UTC>.env.gpg      OV_PIN_SECRET and OV_MATCH_TOKEN_SECRET from
#                              OV_ENV_FILE: a dump's hashed PINs can be checked
#                              only with the secret it was written with
#
# Safety:
#   - refuses to run when the pg filesystem sentinel is missing (unmounted fs)
#   - count-drop guard: if matches, events or auth.users dropped by more than
#     OV_COUNT_DROP_PCT since the last good run, the dump is written under a
#     quarantine name (quarantine-db-<UTC>.dump.gpg, never rotated as a good
#     dump), no good dump is rotated, the storage tars still run, and the run
#     fails at its end: a wiped database can never push the good dumps out,
#     and a legitimate mass delete loses no backup while it waits.
#     After a legitimate mass delete: touch ${OV_BACKUP_DIR}/counts.reset
#   - before EVERY output (db dump, each tar) estimates its size and refuses
#     when writing it would leave less than OV_MIN_FREE_MB free on the backup
#     filesystem (shared with the other tenants of the disk) or push the backup
#     directory past OV_BACKUP_MAX_MB
#   - refuses to run while OV_GPG_FPR (the pinned key fingerprint) is unset
#   - rotation only after a successful dump
#   - status for /health, apart per run: the database part (dump + WAL) writes
#     ${OV_STATUS_DIR}/last_backup and pushes OV_KUMA_PUSH_URL, the files part
#     (--with-files) writes last_files_backup and pushes OV_KUMA_FILES_PUSH_URL,
#     each only when it succeeded: a failing nightly run is no longer hidden
#     by the next hourly one
#
# All settings come from ${OV_BACKUP_CONF:-/etc/openvolley/backup.conf}
# (written by host-prep.sh) and/or the environment; defaults below.
set -euo pipefail
umask 027

CONF=${OV_BACKUP_CONF:-/etc/openvolley/backup.conf}
if [[ -f "$CONF" ]]; then
  # shellcheck source=/dev/null
  . "$CONF"
fi

OV_PROJECT=${OV_PROJECT:-openvolley}
OV_PG_CONTAINER=${OV_PG_CONTAINER:-}
OV_DB_NAME=${OV_DB_NAME:-openvolley}
OV_DB_USER=${OV_DB_USER:-ov_owner}
OV_PG_MOUNT=${OV_PG_MOUNT:-/data/openvolley/pg}
OV_STORAGE_MOUNT=${OV_STORAGE_MOUNT:-/data/openvolley/storage}
OV_BACKUP_DIR=${OV_BACKUP_DIR:-/data/openvolley/backups}
OV_STATUS_DIR=${OV_STATUS_DIR:-/var/lib/openvolley-status}
OV_GPG_PUBKEY=${OV_GPG_PUBKEY:-/etc/openvolley/openvolley-backup.pub.asc}
OV_GPG_FPR=${OV_GPG_FPR:-}
OV_GPG_HOME=${OV_GPG_HOME:-/var/lib/openvolley-backup/gnupg}
OV_KUMA_PUSH_URL=${OV_KUMA_PUSH_URL:-}
OV_KUMA_FILES_PUSH_URL=${OV_KUMA_FILES_PUSH_URL:-}
# The compose project directory (its .env gives ov-backup the owner password);
# OV_DUMP_IN_PG=1 dumps via docker exec in ov-postgres (a kit without ov-backup)
OV_COMPOSE_DIR=${OV_COMPOSE_DIR:-/opt/openvolley}
OV_DUMP_IN_PG=${OV_DUMP_IN_PG:-0}
# Where ov-postgres's archive_command puts WAL segments (on the pg filesystem);
# OV_PITR=0 on a host without WAL archiving
OV_PITR=${OV_PITR:-1}
OV_WAL_ARCHIVE=${OV_WAL_ARCHIVE:-${OV_PG_MOUNT}/walarchive}
OV_DB_KEEP_MIN=${OV_DB_KEEP_MIN:-2880}          # 48 h of hourly dumps
OV_FILES_KEEP_DAYS=${OV_FILES_KEEP_DAYS:-7}
OV_SNAPSHOT_WINDOW_MIN=${OV_SNAPSHOT_WINDOW_MIN:-1600}
OV_MIN_FREE_MB=${OV_MIN_FREE_MB:-10240}
OV_BACKUP_MAX_MB=${OV_BACKUP_MAX_MB:-20480}
OV_COUNT_DROP_PCT=${OV_COUNT_DROP_PCT:-10}
OV_LOCK_FILE=${OV_LOCK_FILE:-/run/lock/openvolley-backup.lock}
OV_ENV_FILE=${OV_ENV_FILE:-/opt/openvolley/.env}

WITH_FILES=0
case "${1:-}" in
  --with-files) WITH_FILES=1 ;;
  "") ;;
  *) echo "usage: $0 [--with-files]" >&2; exit 2 ;;
esac

TS=$(date -u +%Y%m%dT%H%MZ)
OUT=$OV_BACKUP_DIR
PARTIALS=()

log() { printf '[backup-openvolley %s] %s\n' "$TS" "$*"; }

kuma() {  # url status msg
  [[ -n "$1" ]] || return 0
  curl -fsS -m 10 -G --data-urlencode "status=$2" --data-urlencode "msg=$3" "$1" >/dev/null || true
}

# A failure is pushed to the part it hit: the files part once the database
# part is done (PART_NOW), both before (nothing of this run is good then)
PART_NOW=db
fail() {
  printf '[backup-openvolley %s] FAILED: %s\n' "$TS" "$1" >&2
  if [[ $PART_NOW == files ]]; then
    kuma "$OV_KUMA_FILES_PUSH_URL" down "$1"
  else
    kuma "$OV_KUMA_PUSH_URL" down "$1"
    (( ! WITH_FILES )) || kuma "$OV_KUMA_FILES_PUSH_URL" down "$1"
  fi
  exit 1
}

# write_status <name>: the UTC time of a good part, readable by the backend (uid 1000)
write_status() {
  date -u +%FT%TZ >"${OV_STATUS_DIR}/.$1.tmp"
  chmod 0644 "${OV_STATUS_DIR}/.$1.tmp"
  mv -f "${OV_STATUS_DIR}/.$1.tmp" "${OV_STATUS_DIR}/$1"
}

cleanup() {
  local p
  for p in "${PARTIALS[@]}"; do rm -f -- "$p"; done
}
trap cleanup EXIT

# --- one run at a time (hourly and nightly may overlap) ------------------------
exec 9>"$OV_LOCK_FILE"
flock -w 900 9 || fail "lock-timeout"

# --- preconditions --------------------------------------------------------------
[[ -f "${OV_PG_MOUNT}/.ovdata" ]] || fail "no-pg-mount:${OV_PG_MOUNT}/.ovdata"
[[ -d "$OUT" ]] || fail "no-backup-dir:${OUT}"
[[ -d "$OV_STATUS_DIR" ]] || fail "no-status-dir:${OV_STATUS_DIR}"
[[ -f "$OV_GPG_PUBKEY" ]] || fail "no-gpg-pubkey:${OV_GPG_PUBKEY}"
command -v gpg >/dev/null || fail "gpg-missing"

# room_for <what> <estimated MB>: free-space floor and directory cap, checked
# right before each output is written (a single tar can be large).
room_for() {
  local what=$1 need=$2 avail used
  avail=$(df -P -m "$OUT" | awk 'NR==2 {print $4}')
  used=$(du -sm "$OUT" | awk '{print $1}')
  (( avail - need >= OV_MIN_FREE_MB )) || fail "low-disk:${what}:avail ${avail}MB - ~${need}MB < ${OV_MIN_FREE_MB}MB"
  (( used + need <= OV_BACKUP_MAX_MB )) || fail "backup-dir-cap:${what}:${used}MB + ~${need}MB > ${OV_BACKUP_MAX_MB}MB"
}
room_for start 0

if [[ -z "$OV_PG_CONTAINER" ]]; then
  mapfile -t ids < <(docker ps -q \
    --filter "label=com.docker.compose.project=${OV_PROJECT}" \
    --filter "label=com.docker.compose.service=ov-postgres")
  (( ${#ids[@]} == 1 )) || fail "pg-container:found-${#ids[@]}"
  OV_PG_CONTAINER=${ids[0]}
fi
docker exec "$OV_PG_CONTAINER" test -f /ovpg/.ovdata || fail "no-sentinel-in-container"

# --- GPG: encrypt to the public key file only; refuse anything else ------------
install -d -m 0700 "$OV_GPG_HOME"
if grep -q 'PRIVATE KEY BLOCK' "$OV_GPG_PUBKEY"; then
  fail "private-key-on-host:${OV_GPG_PUBKEY}"
fi
fprs=$(gpg --homedir "$OV_GPG_HOME" --batch --with-colons --import-options show-only \
         --import "$OV_GPG_PUBKEY" 2>/dev/null | awk -F: '$1=="fpr" {print $10}') || true
[[ -n "$fprs" ]] || fail "gpg-pubkey-unreadable"
[[ -n "${OV_GPG_FPR// /}" ]] || fail "gpg-fingerprint-unset:set OV_GPG_FPR in ${CONF}"
grep -qx "${OV_GPG_FPR// /}" <<<"$fprs" || fail "gpg-fingerprint-mismatch"
GPG=(gpg --homedir "$OV_GPG_HOME" --batch --yes --no-tty --quiet
     --trust-model always --recipient-file "$OV_GPG_PUBKEY" --encrypt)

# Outputs are written to a dot-prefixed .partial file (registered for cleanup
# in this shell, not in a pipeline subshell) and renamed only when complete,
# so the NAS pull never sees a half-written file.
PART=
begin_out() { PART="$(dirname "$1")/.$(basename "$1").partial"; PARTIALS+=("$PART"); }
end_out() {
  [[ -s "$PART" ]] || fail "empty-output:$(basename "$1")"
  mv -f -- "$PART" "$1"
}

psql_at() {
  docker exec "$OV_PG_CONTAINER" psql -X -U "$OV_DB_USER" -d "$OV_DB_NAME" -At -F' ' -v ON_ERROR_STOP=1 -c "$1"
}

# --- count-drop guard (before any dump or rotation) -----------------------------
# A drop does not stop the run: the dump goes under a quarantine name, nothing
# good is rotated, the storage tars run, and the run fails at its end.
QUARANTINE=
if [[ -f "$OUT/counts.reset" ]]; then
  log "counts.reset present: accepting current counts as the new baseline"
  rm -f -- "$OUT/counts.last" "$OUT/counts.reset"
fi
counts=$(psql_at "select (select count(*) from public.matches), (select count(*) from public.events), (select count(*) from auth.users)") \
  || fail "db-count-query"
read -r M E U <<<"$counts"
[[ "$M" =~ ^[0-9]+$ && "$E" =~ ^[0-9]+$ && "$U" =~ ^[0-9]+$ ]] || fail "db-count-parse:${counts}"
if [[ -f "$OUT/counts.last" ]]; then
  read -r PM PE PU <"$OUT/counts.last"
  keep=$((100 - OV_COUNT_DROP_PCT))
  if (( M * 100 < PM * keep || E * 100 < PE * keep || U * 100 < PU * keep )); then
    QUARANTINE="count-drop:matches ${PM}->${M},events ${PE}->${E},users ${PU}->${U}"
    printf '[backup-openvolley %s] COUNT DROP: %s (dump kept as quarantine-db-%s.dump.gpg; touch %s/counts.reset after a legitimate delete)\n' \
      "$TS" "$QUARANTINE" "$TS" "$OUT" >&2
  fi
fi

# --- database dump ----------------------------------------------------------------
# pg_database_size is an upper bound for a compressed -Fc dump.
# pg_dump runs in ov-backup (compose.yaml): its own CPU quota, nice 10, so the
# dump's compression never takes ov-postgres's share on a match day.
pg_dump_fc() {
  if (( OV_DUMP_IN_PG )); then
    docker exec "$OV_PG_CONTAINER" nice -n 10 pg_dump -U "$OV_DB_USER" -d "$OV_DB_NAME" -Fc
  else
    docker compose --project-directory "$OV_COMPOSE_DIR" -p "$OV_PROJECT" run --rm -T --no-deps ov-backup \
      pg_dump -U "$OV_DB_USER" -d "$OV_DB_NAME" -Fc
  fi
}
db_mb=$(psql_at "select pg_database_size(current_database()) / 1048576 + 1") || fail "db-size-query"
room_for db "$db_mb"
DUMP_NAME=db-${TS}.dump.gpg
[[ -z "$QUARANTINE" ]] || DUMP_NAME=quarantine-db-${TS}.dump.gpg
begin_out "$OUT/$DUMP_NAME"
pg_dump_fc | "${GPG[@]}" -o "$PART" || fail "pg_dump"
end_out "$OUT/$DUMP_NAME"
if [[ -z "$QUARANTINE" ]]; then
  printf '%s %s %s\n' "$M" "$E" "$U" >"$OUT/db-${TS}.counts"
  printf '%s %s %s\n' "$M" "$E" "$U" >"$OUT/.counts.last.tmp" && mv -f "$OUT/.counts.last.tmp" "$OUT/counts.last"
else
  printf '%s %s %s\n' "$M" "$E" "$U" >"$OUT/quarantine-db-${TS}.counts"
fi
log "db dump ok: ${DUMP_NAME} ($(stat -c %s "$OUT/$DUMP_NAME") bytes; matches=$M events=$E users=$U)"

# --- WAL segments since the last run (point-in-time recovery) -------------------
# Each archived segment is encrypted into wal/ (pulled off the host with the
# dumps) and removed from the archive directory only once its copy is complete.
if (( OV_PITR )); then
  [[ -d "$OV_WAL_ARCHIVE" ]] || fail "no-wal-archive:${OV_WAL_ARCHIVE} (host-prep.sh creates it; OV_PITR=0 without WAL archiving)"
  install -d -m 2750 "$OUT/wal"
  shipped=0
  while IFS= read -r -d '' seg; do
    name=$(basename "$seg")
    room_for wal $(( $(stat -c %s "$seg") / 1048576 + 1 ))
    begin_out "$OUT/wal/${name}.gpg"
    "${GPG[@]}" -o "$PART" "$seg" || fail "wal:${name}"
    end_out "$OUT/wal/${name}.gpg"
    rm -f -- "$seg"
    shipped=$((shipped + 1))
  done < <(find "$OV_WAL_ARCHIVE" -maxdepth 1 -type f ! -name '.*' -print0 | sort -z)
  log "wal ok: ${shipped} segment(s)"
fi

# --- status of the database part --------------------------------------------------
if [[ -z "$QUARANTINE" ]]; then
  find "$OUT" -maxdepth 1 -type f \( -name 'db-*.dump.gpg' -o -name 'db-*.counts' \) \
    -mmin "+${OV_DB_KEEP_MIN}" -delete
  write_status last_backup
  kuma "$OV_KUMA_PUSH_URL" up "$TS"
fi
find "$OUT" -maxdepth 1 -type f -name 'quarantine-db-*' -mmin "+${OV_DB_KEEP_MIN}" -delete
PART_NOW=files

# --- nightly storage snapshot --------------------------------------------------------
if (( WITH_FILES )); then
  [[ -f "${OV_STORAGE_MOUNT}/.ovdata" ]] || fail "no-storage-mount:${OV_STORAGE_MOUNT}/.ovdata"
  # the base backup the WAL segments start from (pg_basebackup in ov-postgres:
  # it needs the local replication connection; niced, at night)
  if (( OV_PITR )); then
    room_for base "$db_mb"
    begin_out "$OUT/base-${TS}.tar.gpg"
    docker exec "$OV_PG_CONTAINER" nice -n 10 pg_basebackup -h /var/run/postgresql -U "$OV_DB_USER" -D - -Ft -X none -c fast \
      | "${GPG[@]}" -o "$PART" || fail "pg_basebackup"
    end_out "$OUT/base-${TS}.tar.gpg"
    log "base backup ok"
  fi
  if [[ -d "${OV_STORAGE_MOUNT}/scoresheets" ]]; then
    # with the owner records (.owners): without them every restored
    # scoresheet is refused to its own scorer
    parts=(scoresheets)
    [[ ! -d "${OV_STORAGE_MOUNT}/.owners" ]] || parts+=(.owners)
    room_for scoresheets "$(cd "$OV_STORAGE_MOUNT" && du -smc "${parts[@]}" | awk 'END {print $1 + 1}')"
    begin_out "$OUT/scoresheets-${TS}.tar.gpg"
    tar -C "$OV_STORAGE_MOUNT" -cf - "${parts[@]}" | "${GPG[@]}" -o "$PART" || fail "tar-scoresheets"
    end_out "$OUT/scoresheets-${TS}.tar.gpg"
    log "scoresheets ok (${parts[*]})"
  else
    log "no scoresheets/ yet, skipped"
  fi
  if [[ -d "${OV_STORAGE_MOUNT}/backup" ]]; then
    room_for snapshots "$(cd "$OV_STORAGE_MOUNT" && find backup -type f -mmin "-${OV_SNAPSHOT_WINDOW_MIN}" -printf '%s\n' \
                          | awk '{s += $1} END {print int(s / 1048576) + 1}')"
    begin_out "$OUT/snapshots-${TS}.tar.gpg"
    (cd "$OV_STORAGE_MOUNT" && find backup -type f -mmin "-${OV_SNAPSHOT_WINDOW_MIN}" -print0 \
       | tar --null -T - -cf -) | "${GPG[@]}" -o "$PART" || fail "tar-snapshots"
    end_out "$OUT/snapshots-${TS}.tar.gpg"
    log "snapshots ok"
  else
    log "no backup/ yet, skipped"
  fi
  # the secrets the database's PIN hashes and match tokens need (encrypted like the dumps)
  if [[ -r "$OV_ENV_FILE" ]] && grep -q '^OV_PIN_SECRET=.' "$OV_ENV_FILE"; then
    begin_out "$OUT/secrets-${TS}.env.gpg"
    grep -E '^(OV_PIN_SECRET|OV_MATCH_TOKEN_SECRET)=' "$OV_ENV_FILE" | "${GPG[@]}" -o "$PART" || fail "secrets"
    end_out "$OUT/secrets-${TS}.env.gpg"
    log "secrets ok"
  else
    log "no OV_PIN_SECRET in ${OV_ENV_FILE}, secrets skipped"
  fi
  find "$OUT" -maxdepth 1 -type f \( -name 'scoresheets-*.tar.gpg' -o -name 'snapshots-*.tar.gpg' -o -name 'secrets-*.env.gpg' -o -name 'base-*.tar.gpg' \) \
    -mtime "+${OV_FILES_KEEP_DAYS}" -delete
  # WAL older than the oldest kept base backup cannot be replayed on anything
  [[ ! -d "$OUT/wal" ]] || find "$OUT/wal" -maxdepth 1 -type f -name '*.gpg' -mtime "+$((OV_FILES_KEEP_DAYS + 1))" -delete
  write_status last_files_backup
  kuma "$OV_KUMA_FILES_PUSH_URL" up "$TS"
fi

if [[ -n "$QUARANTINE" ]]; then
  PART_NOW=db
  WITH_FILES=0   # the files part is done and pushed
  fail "$QUARANTINE"
fi
log "done"
