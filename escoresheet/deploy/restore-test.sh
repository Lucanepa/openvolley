#!/usr/bin/env bash
# restore-test.sh [path/to/db-<UTC>.dump.gpg]
#
# Weekly on lenovoserver (openvolley-restore-test.timer), which holds the
# openvolley-backup PRIVATE key. Proves the newest backup is restorable AND
# that the backend image boots against it:
#
#   1. pick the newest db-*.dump.gpg (+ .counts) from RT_SOURCE (NAS share via
#      ssh, or a local dir); refuse if it is older than RT_MAX_AGE_H
#   2. decrypt into a private dir under /dev/shm
#   0. one run at a time (flock); removes leftovers of a run that was killed
#      (containers/networks labelled openvolley.restore-test=1, ${RT_WORK_BASE}/ov-rt.*)
#   3. throwaway postgres (tmpfs PGDATA, internal network, no ports), pg_restore
#      --no-owner --no-privileges, then db/roles.sql (required)
#   4. row-count floors: restored counts within RT_SLACK_PCT of the dump's
#      .counts file, and not below RT_FLOOR_FILE (last passing run) minus
#      RT_FLOOR_SLACK_PCT
#   5. boot the backend image (read-only rootfs, same env shape as production)
#      against it, require /health/live 200 and /health 200 with db ok,
#      catalog ok, floor ok (when the image reports them)
#   6. tear everything down, update the floor file, push to Kuma
#
# Settings (env or ${RT_CONF:-~/.config/openvolley/restore-test.env}):
#   RT_SOURCE            nas:/volume1/backups/openvolley/hetzner | /local/dir
#   RT_BACKEND_IMAGE     default: the tag in RT_TAG_FILE (written by
#                        `build-image.sh --ship hetzner`); *-dirty / *-prewiring
#                        tags are refused unless RT_ALLOW_DEV_IMAGE=1
#   RT_TAG_FILE          ~/ov-ops/shipped-hetzner
#   RT_PG_IMAGE          postgres:17.11-alpine
#   RT_GNUPGHOME         default $GNUPGHOME or ~/.gnupg
#   RT_GPG_PASSPHRASE_FILE  default $CREDENTIALS_DIRECTORY/gpg-pass if present
#   RT_ROLES_SQL         default <repo>/escoresheet/backend/db/roles.sql; missing
#                        = failure, unless RT_ALLOW_BUILTIN_ROLES=1 (pre-wiring tests)
#   RT_PG_MEMORY (1g)    memory limit of the throwaway postgres; its tmpfs PGDATA
#   RT_PG_TMPFS (640m)   counts against it, so keep TMPFS well below MEMORY
#   RT_FLOOR_FILE        ~/ov-ops/restore-floor
#   RT_MAX_AGE_H (30)  RT_SLACK_PCT (1)  RT_FLOOR_SLACK_PCT (1)
#   RT_REQUIRE_DB_HEALTH (1; 0 only for images that predate the self-host wiring)
#   RT_KUMA_PUSH_URL     optional Uptime Kuma push URL
#   RT_KEEP=1            leave containers running for inspection (debug)
set -euo pipefail
umask 077

RT_CONF=${RT_CONF:-$HOME/.config/openvolley/restore-test.env}
if [[ -f "$RT_CONF" ]]; then
  # shellcheck source=/dev/null
  . "$RT_CONF"
fi

KIT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
RT_SOURCE=${RT_SOURCE:-nas:/volume1/backups/openvolley/hetzner}
RT_PG_IMAGE=${RT_PG_IMAGE:-postgres:17.11-alpine}
RT_BACKEND_IMAGE=${RT_BACKEND_IMAGE:-}
RT_GNUPGHOME=${RT_GNUPGHOME:-${GNUPGHOME:-$HOME/.gnupg}}
RT_GPG_PASSPHRASE_FILE=${RT_GPG_PASSPHRASE_FILE:-}
if [[ -z "$RT_GPG_PASSPHRASE_FILE" && -n "${CREDENTIALS_DIRECTORY:-}" && -f "${CREDENTIALS_DIRECTORY}/gpg-pass" ]]; then
  RT_GPG_PASSPHRASE_FILE="${CREDENTIALS_DIRECTORY}/gpg-pass"
fi
RT_ROLES_SQL=${RT_ROLES_SQL:-$KIT_DIR/../backend/db/roles.sql}
RT_ALLOW_BUILTIN_ROLES=${RT_ALLOW_BUILTIN_ROLES:-0}
RT_TAG_FILE=${RT_TAG_FILE:-$HOME/ov-ops/shipped-hetzner}
RT_ALLOW_DEV_IMAGE=${RT_ALLOW_DEV_IMAGE:-0}
RT_PG_MEMORY=${RT_PG_MEMORY:-1g}
RT_PG_TMPFS=${RT_PG_TMPFS:-640m}
RT_LOCK_FILE=${RT_LOCK_FILE:-${XDG_RUNTIME_DIR:-/tmp}/openvolley-restore-test.lock}
RT_FLOOR_FILE=${RT_FLOOR_FILE:-$HOME/ov-ops/restore-floor}
RT_MAX_AGE_H=${RT_MAX_AGE_H:-30}
RT_SLACK_PCT=${RT_SLACK_PCT:-1}
RT_FLOOR_SLACK_PCT=${RT_FLOOR_SLACK_PCT:-1}
RT_REQUIRE_DB_HEALTH=${RT_REQUIRE_DB_HEALTH:-1}
RT_KUMA_PUSH_URL=${RT_KUMA_PUSH_URL:-}
RT_KEEP=${RT_KEEP:-0}
RT_WORK_BASE=${RT_WORK_BASE:-/dev/shm}
RT_HEALTH_TIMEOUT=${RT_HEALTH_TIMEOUT:-120}

ID="ovrt-$$-$(date +%s)"
NET="${ID}-net"
PG="${ID}-pg"
BE="${ID}-be"
WORK=""

log() { printf '[restore-test] %s\n' "$*"; }
kuma() {
  [[ -n "$RT_KUMA_PUSH_URL" ]] || return 0
  curl -fsS -m 10 -G --data-urlencode "status=$1" --data-urlencode "msg=$2" "$RT_KUMA_PUSH_URL" >/dev/null || true
}
fail() { printf '[restore-test] FAILED: %s\n' "$1" >&2; kuma down "$1"; exit 1; }

cleanup() {
  local rc=$?
  if [[ "$RT_KEEP" == 1 ]]; then
    log "RT_KEEP=1: leaving ${PG} ${BE} ${NET} ${WORK} in place"
    return "$rc"
  fi
  docker rm -f -v "$BE" "$PG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  [[ -n "$WORK" && -d "$WORK" ]] && rm -rf -- "$WORK"
  return "$rc"
}
trap cleanup EXIT
# systemd's TimeoutStartSec sends SIGTERM: exit through the EXIT trap so the
# daemon-owned containers and the decrypted dump in /dev/shm are removed.
trap 'exit 143' TERM INT HUP

command -v gpg >/dev/null || fail "gpg missing"
docker version >/dev/null 2>&1 || fail "docker not reachable"

# --- 0. single instance + leftovers of a killed run --------------------------------
exec 8>"$RT_LOCK_FILE"
flock -n 8 || fail "another restore test is running (${RT_LOCK_FILE})"
stale=$(docker ps -aq --filter label=openvolley.restore-test=1)
if [[ -n "$stale" ]]; then
  log "removing leftover restore-test containers: $(echo "$stale" | tr '\n' ' ')"
  # shellcheck disable=SC2086
  docker rm -f -v $stale >/dev/null || true
fi
stale=$(docker network ls -q --filter label=openvolley.restore-test=1)
if [[ -n "$stale" ]]; then
  # shellcheck disable=SC2086
  docker network rm $stale >/dev/null || true
fi
find "${RT_WORK_BASE%/}" -maxdepth 1 -name 'ov-rt.*' -user "$(id -u)" -exec rm -rf -- {} + 2>/dev/null || true

if [[ -z "$RT_BACKEND_IMAGE" ]]; then
  [[ -s "$RT_TAG_FILE" ]] || fail "no ${RT_TAG_FILE} (written by build-image.sh --ship hetzner); set RT_BACKEND_IMAGE"
  RT_BACKEND_IMAGE=$(head -n1 "$RT_TAG_FILE")
fi
case "$RT_BACKEND_IMAGE" in
  *-dirty|*-prewiring)
    [[ "$RT_ALLOW_DEV_IMAGE" == 1 ]] || fail "refusing dev image ${RT_BACKEND_IMAGE} (not a deployable build); RT_ALLOW_DEV_IMAGE=1 for local tests" ;;
esac
docker image inspect "$RT_BACKEND_IMAGE" >/dev/null 2>&1 || fail "image ${RT_BACKEND_IMAGE} not present locally (rebuild that commit with build-image.sh)"
log "backend image ${RT_BACKEND_IMAGE}, postgres image ${RT_PG_IMAGE}"

WORK=$(mktemp -d "${RT_WORK_BASE%/}/ov-rt.XXXXXX")
chmod 0700 "$WORK"

# --- 1. fetch newest dump ----------------------------------------------------------
if [[ $# -ge 1 ]]; then
  SRC_FILE=$1
  [[ -f "$SRC_FILE" ]] || fail "no such file: $SRC_FILE"
  cp -p -- "$SRC_FILE" "$WORK/"
  [[ -f "${SRC_FILE%.dump.gpg}.counts" ]] && cp -p -- "${SRC_FILE%.dump.gpg}.counts" "$WORK/"
  DUMP_NAME=$(basename "$SRC_FILE")
elif [[ "$RT_SOURCE" == /* ]]; then
  DUMP_NAME=$(find "$RT_SOURCE" -maxdepth 1 -type f -name 'db-*.dump.gpg' -printf '%f\n' | sort | tail -n1)
  [[ -n "$DUMP_NAME" ]] || fail "no db-*.dump.gpg in ${RT_SOURCE}"
  cp -p -- "$RT_SOURCE/$DUMP_NAME" "$WORK/"
  [[ -f "$RT_SOURCE/${DUMP_NAME%.dump.gpg}.counts" ]] && cp -p -- "$RT_SOURCE/${DUMP_NAME%.dump.gpg}.counts" "$WORK/"
else
  RHOST=${RT_SOURCE%%:*}; RPATH=${RT_SOURCE#*:}
  # Names are db-YYYYmmddTHHMMZ.dump.gpg, so a lexical sort is chronological.
  # shellcheck disable=SC2029  # RPATH is expanded locally on purpose
  DUMP_NAME=$(ssh -o BatchMode=yes "$RHOST" "cd '$RPATH' && ls -1 db-*.dump.gpg | sort | tail -n1") \
    || fail "cannot list ${RT_SOURCE}"
  [[ "$DUMP_NAME" =~ ^db-[0-9]{8}T[0-9]{4}Z\.dump\.gpg$ ]] || fail "unexpected dump name '${DUMP_NAME}'"
  rsync -t -e 'ssh -o BatchMode=yes' "$RHOST:$RPATH/$DUMP_NAME" "$RHOST:$RPATH/${DUMP_NAME%.dump.gpg}.counts" "$WORK/" \
    || fail "rsync from ${RT_SOURCE}"
fi
DUMP="$WORK/$DUMP_NAME"
COUNTS_FILE="$WORK/${DUMP_NAME%.dump.gpg}.counts"
log "dump ${DUMP_NAME} ($(stat -c %s "$DUMP") bytes)"

# Age from the UTC timestamp in the name (mtime may be rewritten by copies).
stamp=${DUMP_NAME#db-}; stamp=${stamp%Z.dump.gpg}
dump_epoch=$(date -u -d "${stamp:0:4}-${stamp:4:2}-${stamp:6:2} ${stamp:9:2}:${stamp:11:2}" +%s) || fail "bad timestamp in ${DUMP_NAME}"
age_h=$(( ($(date +%s) - dump_epoch) / 3600 ))
(( age_h <= RT_MAX_AGE_H )) || fail "newest dump is ${age_h} h old (> ${RT_MAX_AGE_H} h): backups or the NAS pull have stopped"

# --- 2. decrypt ----------------------------------------------------------------------
GPG=(gpg --homedir "$RT_GNUPGHOME" --batch --yes --no-tty --quiet)
if [[ -n "$RT_GPG_PASSPHRASE_FILE" ]]; then
  GPG+=(--pinentry-mode loopback --passphrase-file "$RT_GPG_PASSPHRASE_FILE")
fi
"${GPG[@]}" -o "$WORK/db.dump" -d "$DUMP" || fail "gpg decrypt (key or passphrase)"
rm -f -- "$DUMP"

# --- 3. throwaway postgres + restore ------------------------------------------------
OWNER_PW=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
APP_PW=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
docker network create --internal --label openvolley.restore-test=1 "$NET" >/dev/null
# tmpfs pages count against the container's memory cgroup: TMPFS < MEMORY, so a
# large restore fails with "No space left on device" instead of an OOM kill.
docker run -d --name "$PG" --network "$NET" --network-alias ov-postgres \
  --memory "$RT_PG_MEMORY" --memory-swap "$RT_PG_MEMORY" --cpus 1 --pids-limit 128 \
  --tmpfs "/var/lib/postgresql/data:size=${RT_PG_TMPFS}" \
  -e POSTGRES_DB=openvolley -e POSTGRES_USER=ov_owner -e POSTGRES_PASSWORD="$OWNER_PW" \
  --label openvolley.restore-test=1 \
  "$RT_PG_IMAGE" postgres -c timezone=UTC -c max_connections=20 >/dev/null

for _ in $(seq 1 90); do
  docker exec "$PG" pg_isready -q -h 127.0.0.1 -U ov_owner -d openvolley && break
  sleep 1
done
docker exec "$PG" pg_isready -q -h 127.0.0.1 -U ov_owner -d openvolley || fail "postgres did not become ready"

psql_rt() { docker exec -i "$PG" psql -X -q -U ov_owner -d openvolley -v ON_ERROR_STOP=1 "$@"; }

docker exec -i "$PG" pg_restore -U ov_owner -d openvolley --no-owner --no-privileges --exit-on-error \
  <"$WORK/db.dump" || fail "pg_restore"
rm -f -- "$WORK/db.dump"
log "pg_restore ok"

if [[ -f "$RT_ROLES_SQL" ]]; then
  log "roles: ${RT_ROLES_SQL}"
  psql_rt -v ov_app_pw="$APP_PW" <"$RT_ROLES_SQL" >/dev/null || fail "roles.sql"
elif [[ "$RT_ALLOW_BUILTIN_ROLES" != 1 ]]; then
  fail "roles: ${RT_ROLES_SQL} not found (RT_ALLOW_BUILTIN_ROLES=1 only for pre-wiring tests)"
else
  log "WARNING: ${RT_ROLES_SQL} not found, using the built-in stand-in (RT_ALLOW_BUILTIN_ROLES=1)"
  psql_rt -v ov_app_pw="$APP_PW" >/dev/null <<'SQL' || fail "built-in roles"
DO $$ BEGIN CREATE ROLE ov_app LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER ROLE ov_app PASSWORD :'ov_app_pw';
ALTER ROLE ov_app SET statement_timeout = '10s';
GRANT USAGE ON SCHEMA public TO ov_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ov_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ov_app;
DO $$ BEGIN
  IF to_regnamespace('auth') IS NOT NULL THEN
    EXECUTE 'GRANT USAGE ON SCHEMA auth TO ov_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth TO ov_app';
  END IF;
END $$;
SQL
fi

# --- 4. row-count floors ---------------------------------------------------------------
read -r M E U < <(docker exec "$PG" psql -X -U ov_owner -d openvolley -At -F' ' -c \
  "select (select count(*) from public.matches),(select count(*) from public.events),(select count(*) from auth.users)") \
  || fail "count query"
log "restored counts: matches=$M events=$E users=$U"
# Same login path the backend uses: TCP + password as ov_app.
docker exec -e PGPASSWORD="$APP_PW" "$PG" psql -X -h 127.0.0.1 -U ov_app -d openvolley -At \
  -c 'select count(*) from public.matches' >/dev/null \
  || fail "ov_app cannot log in or read public.matches"

within() {  # actual expected slackpct -> 0 if |a-e| <= e*slack/100
  local a=$1 e=$2 s=$3 d
  d=$(( a > e ? a - e : e - a ))
  (( d * 100 <= e * s ))
}
if [[ -f "$COUNTS_FILE" ]]; then
  read -r CM CE CU <"$COUNTS_FILE"
  if ! { within "$M" "$CM" "$RT_SLACK_PCT" && within "$E" "$CE" "$RT_SLACK_PCT" && within "$U" "$CU" "$RT_SLACK_PCT"; }; then
    fail "restored counts ${M}/${E}/${U} differ from dump counts ${CM}/${CE}/${CU} by more than ${RT_SLACK_PCT}%"
  fi
else
  fail "no .counts file next to ${DUMP_NAME}"
fi
if [[ -f "$RT_FLOOR_FILE" ]]; then
  read -r FM FE FU <"$RT_FLOOR_FILE"
  keep=$((100 - RT_FLOOR_SLACK_PCT))
  (( M * 100 >= FM * keep && E * 100 >= FE * keep && U * 100 >= FU * keep )) \
    || fail "below last week's floor ${FM}/${FE}/${FU} (now ${M}/${E}/${U}); if a mass delete was legitimate, delete ${RT_FLOOR_FILE}"
fi

# --- 5. boot the backend against it -----------------------------------------------------
mkdir -p "$WORK/storage" "$WORK/status"
: >"$WORK/storage/.ovdata"
date -u +%FT%TZ >"$WORK/status/last_backup"
chmod 0755 "$WORK" "$WORK/status"
chmod 0644 "$WORK/storage/.ovdata" "$WORK/status/last_backup"
chmod 0770 "$WORK/storage"
if [[ $EUID -eq 0 ]]; then chown -R 1000:1000 "$WORK/storage"; fi

docker run -d --name "$BE" --network "$NET" \
  --read-only --tmpfs /tmp:size=64m --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 256m --memory-swap 256m --cpus 1 --pids-limit 256 --user node \
  -e DATABASE_URL="postgres://ov_app:${APP_PW}@ov-postgres:5432/openvolley" \
  -e STORAGE_ROOT=/data/storage -e STATUS_DIR=/var/lib/openvolley-status \
  -e PUBLIC_ORIGINS=https://restore-test.invalid -e TRUST_PROXY=cloudflare -e IS_CLOUD=1 \
  -e OV_MIN_MATCHES=$(( M * 9 / 10 )) \
  --mount "type=bind,source=$WORK/storage,target=/data/storage" \
  --mount "type=bind,source=$WORK/status,target=/var/lib/openvolley-status,readonly" \
  --label openvolley.restore-test=1 \
  "$RT_BACKEND_IMAGE" >/dev/null

# The check runs inside the backend container with its own node (no ports).
HEALTH_JS='
const req = process.env.REQ === "1";
const ok = (v) => v === true || v === "ok" || (v && typeof v === "object" && v.ok === true);
(async () => {
  const live = await fetch("http://127.0.0.1:" + (process.env.PORT || 8080) + "/health/live").catch(() => null);
  const r = await fetch("http://127.0.0.1:" + (process.env.PORT || 8080) + "/health");
  const body = await r.text();
  let j = {}; try { j = JSON.parse(body) } catch {}
  const problems = [];
  if (r.status !== 200) problems.push("HTTP " + r.status);
  if (live && live.status !== 200 && live.status !== 404) problems.push("/health/live HTTP " + live.status);
  if (!live || live.status === 404) { if (req) problems.push("/health/live missing"); }
  if ("db" in j) { if (!ok(j.db)) problems.push("db=" + JSON.stringify(j.db)); }
  else if (req) problems.push("no db field in /health");
  for (const k of ["catalog", "floor", "sentinel"]) if (k in j && !ok(j[k])) problems.push(k + "=" + JSON.stringify(j[k]));
  console.log(body);
  if (problems.length) { console.error(problems.join("; ")); process.exit(1); }
})().catch((e) => { console.error(String(e)); process.exit(2); });
'
deadline=$(( $(date +%s) + RT_HEALTH_TIMEOUT ))
until out=$(docker exec -e REQ="$RT_REQUIRE_DB_HEALTH" "$BE" node -e "$HEALTH_JS" 2>&1); do
  if (( $(date +%s) > deadline )); then
    docker logs --tail 50 "$BE" >&2 || true
    fail "backend /health not ok after ${RT_HEALTH_TIMEOUT}s: ${out}"
  fi
  [[ "$(docker inspect -f '{{.State.Running}}' "$BE" 2>/dev/null)" == true ]] || {
    docker logs --tail 50 "$BE" >&2 || true
    fail "backend container exited"
  }
  sleep 3
done
log "backend /health: ${out}"
if [[ "$RT_REQUIRE_DB_HEALTH" != 1 ]]; then
  log "WARNING: RT_REQUIRE_DB_HEALTH=0, db/catalog fields were not required (pre-wiring image)"
fi

# --- 6. success ----------------------------------------------------------------------------
mkdir -p "$(dirname "$RT_FLOOR_FILE")"
printf '%s %s %s\n' "$M" "$E" "$U" >"$RT_FLOOR_FILE.tmp" && mv -f "$RT_FLOOR_FILE.tmp" "$RT_FLOOR_FILE"
kuma up "${DUMP_NAME} m=${M} e=${E} u=${U}"
log "PASS ${DUMP_NAME}: matches=$M events=$E users=$U (floor file updated)"
