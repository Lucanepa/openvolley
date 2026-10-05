#!/usr/bin/env bash
# backup-openvolley.sh [--with-files]
#
# Hourly (systemd openvolley-backup.timer):
#   pg_dump -Fc of the whole `openvolley` database via `docker exec`, encrypted
#   to the openvolley-backup PUBLIC key (the private key is never on this host),
#   written atomically as db-<UTC>.dump.gpg plus a plain db-<UTC>.counts file.
# Nightly with --with-files (openvolley-backup-files.timer), additionally:
#   scoresheets-<UTC>.tar.gpg  every file under storage/scoresheets
#   snapshots-<UTC>.tar.gpg    storage/backup files changed in the last ~26 h
#
# Safety:
#   - refuses to run when the pg filesystem sentinel is missing (unmounted fs)
#   - count-drop guard: if matches, events or auth.users dropped by more than
#     OV_COUNT_DROP_PCT since the last good run, it stops BEFORE dumping or
#     rotating, so a wiped database can never push the good dumps out.
#     After a legitimate mass delete: touch ${OV_BACKUP_DIR}/counts.reset
#   - refuses to write when the backup filesystem has less than OV_MIN_FREE_MB
#     free (protects the other tenants of the disk)
#   - rotation only after a successful dump
#   - on success writes ${OV_STATUS_DIR}/last_backup (read by /health)
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
OV_DB_KEEP_MIN=${OV_DB_KEEP_MIN:-2880}          # 48 h of hourly dumps
OV_FILES_KEEP_DAYS=${OV_FILES_KEEP_DAYS:-7}
OV_SNAPSHOT_WINDOW_MIN=${OV_SNAPSHOT_WINDOW_MIN:-1600}
OV_MIN_FREE_MB=${OV_MIN_FREE_MB:-10240}
OV_COUNT_DROP_PCT=${OV_COUNT_DROP_PCT:-10}
OV_LOCK_FILE=${OV_LOCK_FILE:-/run/lock/openvolley-backup.lock}

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

kuma() {  # status msg
  [[ -n "$OV_KUMA_PUSH_URL" ]] || return 0
  curl -fsS -m 10 -G --data-urlencode "status=$1" --data-urlencode "msg=$2" "$OV_KUMA_PUSH_URL" >/dev/null || true
}

fail() {
  printf '[backup-openvolley %s] FAILED: %s\n' "$TS" "$1" >&2
  kuma down "$1"
  exit 1
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

avail_mb=$(df -P -m "$OUT" | awk 'NR==2 {print $4}')
(( avail_mb >= OV_MIN_FREE_MB )) || fail "low-disk:${avail_mb}MB<${OV_MIN_FREE_MB}MB"

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
if [[ -n "$OV_GPG_FPR" ]] && ! grep -qx "${OV_GPG_FPR// /}" <<<"$fprs"; then
  fail "gpg-fingerprint-mismatch"
fi
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
    fail "count-drop:matches ${PM}->${M},events ${PE}->${E},users ${PU}->${U}"
  fi
fi

# --- database dump ----------------------------------------------------------------
begin_out "$OUT/db-${TS}.dump.gpg"
docker exec "$OV_PG_CONTAINER" pg_dump -U "$OV_DB_USER" -d "$OV_DB_NAME" -Fc \
  | "${GPG[@]}" -o "$PART" \
  || fail "pg_dump"
end_out "$OUT/db-${TS}.dump.gpg"
printf '%s %s %s\n' "$M" "$E" "$U" >"$OUT/db-${TS}.counts"
printf '%s %s %s\n' "$M" "$E" "$U" >"$OUT/.counts.last.tmp" && mv -f "$OUT/.counts.last.tmp" "$OUT/counts.last"
log "db dump ok: db-${TS}.dump.gpg ($(stat -c %s "$OUT/db-${TS}.dump.gpg") bytes; matches=$M events=$E users=$U)"

# --- nightly storage snapshot --------------------------------------------------------
if (( WITH_FILES )); then
  [[ -f "${OV_STORAGE_MOUNT}/.ovdata" ]] || fail "no-storage-mount:${OV_STORAGE_MOUNT}/.ovdata"
  if [[ -d "${OV_STORAGE_MOUNT}/scoresheets" ]]; then
    begin_out "$OUT/scoresheets-${TS}.tar.gpg"
    tar -C "$OV_STORAGE_MOUNT" -cf - scoresheets | "${GPG[@]}" -o "$PART" || fail "tar-scoresheets"
    end_out "$OUT/scoresheets-${TS}.tar.gpg"
    log "scoresheets ok"
  else
    log "no scoresheets/ yet, skipped"
  fi
  if [[ -d "${OV_STORAGE_MOUNT}/backup" ]]; then
    begin_out "$OUT/snapshots-${TS}.tar.gpg"
    (cd "$OV_STORAGE_MOUNT" && find backup -type f -mmin "-${OV_SNAPSHOT_WINDOW_MIN}" -print0 \
       | tar --null -T - -cf -) | "${GPG[@]}" -o "$PART" || fail "tar-snapshots"
    end_out "$OUT/snapshots-${TS}.tar.gpg"
    log "snapshots ok"
  else
    log "no backup/ yet, skipped"
  fi
  find "$OUT" -maxdepth 1 -type f \( -name 'scoresheets-*.tar.gpg' -o -name 'snapshots-*.tar.gpg' \) \
    -mtime "+${OV_FILES_KEEP_DAYS}" -delete
fi

# --- rotation (only reached after a good dump) -----------------------------------------
find "$OUT" -maxdepth 1 -type f \( -name 'db-*.dump.gpg' -o -name 'db-*.counts' \) \
  -mmin "+${OV_DB_KEEP_MIN}" -delete

# --- status for /health ---------------------------------------------------------------
date -u +%FT%TZ >"${OV_STATUS_DIR}/.last_backup.tmp"
chmod 0644 "${OV_STATUS_DIR}/.last_backup.tmp"   # the backend (uid 1000) must read it
mv -f "${OV_STATUS_DIR}/.last_backup.tmp" "${OV_STATUS_DIR}/last_backup"

kuma up "$TS"
log "done"
