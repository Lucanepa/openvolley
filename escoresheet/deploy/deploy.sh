#!/usr/bin/env bash
# deploy.sh [options] <image>      e.g.  deploy.sh openvolley-backend:abc1234   (or just abc1234)
#
# A backend release on the production host, in one step (RUNBOOK-hetzner.md,
# "Apply a new db migration"). The image must be loaded already
# (build-image.sh --ship).
#
#   0. checks: the image is there, compose.yaml is valid and none of its
#      variables is exported in this shell, one deploy at a time; outside the
#      match-day freeze (Friday 17:00 to Sunday 23:59, Europe/Zurich) and no
#      live relay room in the running backend (/health activeRooms), unless
#      --any-time
#   1. a fresh dump: openvolley-backup.service (stops here when its
#      count-drop guard trips)
#   2. the migrations of the NEW image: scripts/migrate.mjs as ov_owner, in a
#      one-off container in ov-postgres's network namespace (the owner
#      password never reaches the backend); the running backend keeps
#      serving meanwhile (every migration is written to be safe for it)
#   3. roles.sql of the new image, through apply-roles.sh
#   4. the switch: the previous OV_BACKEND_IMAGE into DEPLOYED.log, the new
#      one into .env, docker compose up -d --wait ov-backend
#   5. the new backend's /health answers 200 and scripts/check-schema.mjs
#      passes in its container (every migration of the image recorded, guard
#      triggers, unique indexes and trigger functions in place)
#   A failure in 0-3 changes no container (migrations that already ran stay:
#   each is one transaction, and the old backend works with them). A failure
#   in 4-5 puts the previous image back into .env and starts it again.
#
# Options:
#   --any-time        deploy inside the freeze window or while relay rooms are live
#   --baseline NNN    the first run of the migration record (migrate.mjs --baseline):
#                     the last db/ file this database got by hand
#   --rerun NNN       run db/NNN once more after the switch (a file whose header
#                     asks for a second run, e.g. 032); repeatable
#   --migrate-only    steps 0-3 only (and --rerun at once): no switch
#
# Settings (environment): OV_ENV_FILE (default .env next to this script),
# OV_PROJECT (default openvolley), OV_DB_NAME (default openvolley),
# OV_BACKUP_UNIT (default openvolley-backup.service), OV_HEALTH_TIMEOUT
# (seconds for --wait, default 180), OV_READY_TIMEOUT (seconds until /health
# answers 200 after that, default 60), OV_DEPLOY_LOCK (default
# /run/lock/openvolley-deploy.lock).
set -euo pipefail
umask 077

KIT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
OV_ENV_FILE=${OV_ENV_FILE:-$KIT_DIR/.env}
OV_PROJECT=${OV_PROJECT:-openvolley}
OV_DB_NAME=${OV_DB_NAME:-openvolley}
OV_BACKUP_UNIT=${OV_BACKUP_UNIT:-openvolley-backup.service}
OV_HEALTH_TIMEOUT=${OV_HEALTH_TIMEOUT:-180}
OV_READY_TIMEOUT=${OV_READY_TIMEOUT:-60}
OV_DEPLOY_LOCK=${OV_DEPLOY_LOCK:-/run/lock/openvolley-deploy.lock}
LOG_FILE="$KIT_DIR/DEPLOYED.log"

log() { printf '[deploy] %s\n' "$*" >&2; }
die() { printf '[deploy] FATAL: %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; }

ANY_TIME=0
MIGRATE_ONLY=0
BASELINE=""
RERUN=()
POS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --any-time) ANY_TIME=1; shift ;;
    --migrate-only) MIGRATE_ONLY=1; shift ;;
    --baseline) BASELINE=${2:?--baseline needs a migration number}; shift 2 ;;
    --rerun) RERUN+=("${2:?--rerun needs a migration number}"); shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown option: $1 (see --help)" ;;
    *) POS+=("$1"); shift ;;
  esac
done
(( ${#POS[@]} == 1 )) || { usage >&2; exit 2; }
NEW=${POS[0]}
[[ "$NEW" == *:* ]] || NEW="openvolley-backend:$NEW"
[[ "$NEW" =~ ^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9._-]{1,128}$ ]] || die "not an image name: $NEW"
for n in "$BASELINE" ${RERUN[@]+"${RERUN[@]}"}; do
  [[ -z "$n" || "$n" =~ ^[0-9]{1,3}$ ]] || die "not a migration number: $n"
done

compose() { docker compose --project-directory "$KIT_DIR" "$@"; }
env_value() {  # NAME: its value in .env, quotes and CR stripped (nothing is exported)
  local v
  v=$(sed -n "s/^$1=//p" "$OV_ENV_FILE" | tail -n1)
  v=${v%$'\r'}
  if [[ ${#v} -ge 2 && ( ( "$v" == \'*\' ) || ( "$v" == \"*\" ) ) ]]; then v=${v:1:${#v}-2}; fi
  printf '%s' "$v"
}
set_image() {  # TAG: OV_BACKEND_IMAGE in .env, then check that compose sees it
  sed -i "s|^OV_BACKEND_IMAGE=.*|OV_BACKEND_IMAGE=$1|" "$OV_ENV_FILE"
  compose config --images | grep -qxF "$1" || die "after editing ${OV_ENV_FILE}, docker compose does not use $1"
}
backend_health() {  # prints "<status> <body>" of /health from inside the running ov-backend
  compose exec -T ov-backend node -e '
    fetch("http://127.0.0.1:8080/health", { signal: AbortSignal.timeout(10000) })
      .then(async (r) => { console.log(r.status + " " + await r.text()); process.exit(r.status === 200 ? 0 : 1) })
      .catch((e) => { console.log("000 " + e.message); process.exit(1) })'
}

# --- 0. checks -------------------------------------------------------------------------
[[ -r "$OV_ENV_FILE" && -w "$OV_ENV_FILE" ]] || die "cannot read and write ${OV_ENV_FILE} (run with sudo)"
[[ -f "$KIT_DIR/compose.yaml" && -x "$KIT_DIR/apply-roles.sh" ]] || die "run the copy in the kit directory (compose.yaml and apply-roles.sh next to it)"
command -v docker >/dev/null || die "docker not found"
exec 9>"$OV_DEPLOY_LOCK" || die "cannot open ${OV_DEPLOY_LOCK}"
flock -n 9 || die "another deploy.sh is running"

# Docker Compose prefers exported variables over .env: an exported
# OV_BACKEND_IMAGE would silently keep the old image (RUNBOOK "Shell hygiene").
exported=()
while read -r v; do
  [[ -n "$v" && -n "${!v+x}" ]] && exported+=("$v")
done < <(grep -o '\${[A-Z_][A-Z0-9_]*' "$KIT_DIR/compose.yaml" | cut -c3- | sort -u)
(( ${#exported[@]} == 0 )) || die "exported in this shell (compose would use them instead of .env): ${exported[*]}; open a fresh shell"
compose config -q || die "docker compose config failed"
docker image inspect "$NEW" >/dev/null 2>&1 || die "image $NEW is not loaded on this host (build-image.sh --ship)"
PREV=$(env_value OV_BACKEND_IMAGE)
[[ -n "$PREV" ]] || die "OV_BACKEND_IMAGE is empty in ${OV_ENV_FILE}"
OWNER_PW=$(env_value OV_OWNER_PW)
[[ -n "$OWNER_PW" ]] || die "OV_OWNER_PW is empty in ${OV_ENV_FILE}"
mapfile -t ids < <(docker ps -q \
  --filter "label=com.docker.compose.project=${OV_PROJECT}" \
  --filter "label=com.docker.compose.service=ov-postgres")
(( ${#ids[@]} == 1 )) || die "expected one running ov-postgres of project ${OV_PROJECT}, found ${#ids[@]}"
PG=${ids[0]}

if (( ! ANY_TIME )); then
  dow=$(TZ=Europe/Zurich date +%u)
  hm=$(TZ=Europe/Zurich date +%H%M)
  if (( dow == 6 || dow == 7 || (dow == 5 && 10#$hm >= 1700) )); then
    die "match-day freeze (Friday 17:00 to Sunday 23:59, Europe/Zurich): a restart drops every live relay room. --any-time overrides"
  fi
  if h=$(backend_health 2>/dev/null) || [[ "$h" == 503\ * ]]; then
    rooms=$(printf '%s' "${h#* }" | sed -n 's/.*"activeRooms":\([0-9][0-9]*\).*/\1/p')
    [[ "${rooms:-0}" == 0 ]] || die "${rooms} live relay room(s) in the running backend: a restart drops them. --any-time overrides"
  else
    log "running backend did not answer /health (${h:-no answer}); not checking for live rooms"
  fi
fi
log "deploying ${NEW} (running: ${PREV})"

# --- 1. fresh dump ---------------------------------------------------------------------
if command -v systemctl >/dev/null && systemctl cat "$OV_BACKUP_UNIT" >/dev/null 2>&1; then
  systemctl start "$OV_BACKUP_UNIT" || die "the backup (${OV_BACKUP_UNIT}) failed: journalctl -u ${OV_BACKUP_UNIT}; nothing was changed"
  log "fresh dump written (${OV_BACKUP_UNIT})"
else
  die "${OV_BACKUP_UNIT} is not installed (host-prep.sh): no deploy without a fresh dump"
fi

# --- 2. migrations ---------------------------------------------------------------------
migrate() {  # migrate.mjs of the new image, as ov_owner over ov-postgres's loopback
  OV_MIGRATE_DATABASE_URL="postgres://ov_owner@127.0.0.1:5432/${OV_DB_NAME}" PGPASSWORD="$OWNER_PW" \
    docker run --rm --network "container:${PG}" --read-only --tmpfs /tmp:size=16m --cap-drop ALL \
      --security-opt no-new-privileges:true --user node --pids-limit 64 --memory 256m \
      -e OV_MIGRATE_DATABASE_URL -e PGPASSWORD --entrypoint node "$NEW" scripts/migrate.mjs "$@"
}
margs=()
[[ -z "$BASELINE" ]] || margs+=(--baseline "$BASELINE")
migrate ${margs[@]+"${margs[@]}"} || die "migrations failed (see above); the running backend is unchanged. A file that failed changed nothing; the ones before it are applied and recorded"

# --- 3. roles.sql ----------------------------------------------------------------------
WORK=$(mktemp -d "${TMPDIR:-/tmp}/ov-deploy.XXXXXX")
trap 'rm -rf -- "$WORK"' EXIT
docker run --rm --entrypoint cat "$NEW" db/roles.sql >"$WORK/roles.sql" || die "cannot read db/roles.sql from $NEW"
[[ -s "$WORK/roles.sql" ]] || die "db/roles.sql of $NEW is empty"
OV_ENV_FILE="$OV_ENV_FILE" OV_PROJECT="$OV_PROJECT" OV_DB_NAME="$OV_DB_NAME" "$KIT_DIR/apply-roles.sh" <"$WORK/roles.sql" \
  || die "roles.sql failed; the running backend is unchanged"

rerun_all() {
  local n
  for n in ${RERUN[@]+"${RERUN[@]}"}; do
    migrate --rerun "$n" || return 1
  done
}

if (( MIGRATE_ONLY )); then
  rerun_all || die "--rerun failed (see above)"
  log "migrations and roles applied; no switch (--migrate-only)"
  exit 0
fi

# --- 4. switch ---------------------------------------------------------------------------
rollback() {
  log "FAILED: $1; putting ${PREV} back"
  set_image "$PREV"
  if compose up -d --wait --wait-timeout "$OV_HEALTH_TIMEOUT" ov-backend; then
    echo "$(date -u +%FT%TZ) deploy of ${NEW} failed ($1); rolled back to ${PREV}" >>"$LOG_FILE"
    die "rolled back to ${PREV} (the database keeps the migrations of ${NEW}: they are made for the older backend too)"
  fi
  echo "$(date -u +%FT%TZ) deploy of ${NEW} failed ($1); rollback to ${PREV} did not get healthy" >>"$LOG_FILE"
  die "the rollback to ${PREV} did not get healthy either: docker compose --project-directory ${KIT_DIR} ps; logs ov-backend"
}
echo "$(date -u +%FT%TZ) running OV_BACKEND_IMAGE=${PREV} before deploying ${NEW}" >>"$LOG_FILE"
set_image "$NEW"
compose up -d --wait --wait-timeout "$OV_HEALTH_TIMEOUT" ov-backend || rollback "ov-backend did not get healthy"

# --- 5. readiness ------------------------------------------------------------------------
deadline=$(( $(date +%s) + OV_READY_TIMEOUT ))
until h=$(backend_health 2>/dev/null); do
  if (( $(date +%s) >= deadline )); then
    log "/health of ${NEW}: ${h:-no answer}"
    rollback "/health answered ${h%% *}"
  fi
  sleep 3
done
compose exec -T ov-backend node scripts/check-schema.mjs || rollback "check-schema.mjs"
echo "$(date -u +%FT%TZ) deployed ${NEW} (previous ${PREV})" >>"$LOG_FILE"
log "deployed ${NEW}; /health 200, schema ready (previous ${PREV} in ${LOG_FILE})"

rerun_all || die "${NEW} is live, but --rerun failed (see above): run deploy.sh --migrate-only --rerun ... again"
