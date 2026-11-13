#!/usr/bin/env bash
# Offline tests for deploy.sh: the order of its steps (dump, migrations of the
# new image, roles.sql, schema check as the owner, switch, /health,
# check-schema), the rollback to the previous image, and what it refuses.
# docker, systemctl and date are stubs in a scratch PATH; nothing touches a
# real container or host.
#
#   escoresheet/deploy/tests/deploy.test.sh
set -euo pipefail
KIT_SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
T=$(mktemp -d "${TMPDIR:-/tmp}/ov-deploy-test.XXXXXX")
trap 'rm -rf -- "$T"' EXIT
PASS=0
ok() { PASS=$((PASS + 1)); echo "ok   $*"; }
bad() { echo "FAIL $*" >&2; [[ -f "$T/out" ]] && sed 's/^/     /' "$T/out" >&2; exit 1; }

mkdir -p "$T/bin" "$T/kit"
cp "$KIT_SRC/deploy.sh" "$T/kit/deploy.sh"
cat >"$T/kit/compose.yaml" <<'EOF'
services:
  ov-backend:
    image: ${OV_BACKEND_IMAGE:?}
    environment:
      DATABASE_URL: postgres://ov_app:${OV_APP_PW:?}@ov-postgres:5432/openvolley
EOF
cat >"$T/kit/apply-roles.sh" <<'EOF'
#!/usr/bin/env bash
cat >"$CALLS.roles"
echo "roles" >>"$CALLS"
EOF
chmod +x "$T/kit/deploy.sh" "$T/kit/apply-roles.sh"

# docker: answers from the scratch .env and FAKE_* settings, logs each call
cat >"$T/bin/docker" <<'EOF'
#!/usr/bin/env bash
img() { sed -n 's/^OV_BACKEND_IMAGE=//p' "$KIT/.env"; }
has() { [[ " $1 " == *" $2 "* ]]; }
case "$1" in
  image) has "$FAKE_IMAGES" "$3" ;;
  ps) echo pg0 ;;
  run)
    for a in "$@"; do [[ "$a" != *"$FAKE_OWNER_PW"* ]] || { echo "password on the command line" >>"$CALLS"; exit 9; }; done
    if [[ " $* " == *" --entrypoint cat "* ]]; then echo "-- roles.sql of ${*: -2:1}"; exit 0; fi
    shift; while [[ "$1" != --entrypoint ]]; do shift; done; image=$3; shift 3
    if [[ "$1" == scripts/check-schema.mjs ]]; then
      echo "owner-check $image pw=${PGPASSWORD:-} url=${DATABASE_URL:-}" >>"$CALLS"
      exit "${FAKE_OWNER_CHECK_RC:-0}"
    fi
    echo "migrate $image $* pw=${PGPASSWORD:-} url=${OV_MIGRATE_DATABASE_URL:-}" >>"$CALLS"
    exit "${FAKE_MIGRATE_RC:-0}" ;;
  compose)
    shift 3
    case "$*" in
      "config -q") exit 0 ;;
      "config --images") img ;;
      up\ -d\ --wait*) echo "up $(img)" >>"$CALLS"; ! has "${FAKE_UNHEALTHY:-}" "$(img)" ;;
      "exec -T ov-backend node -e"*)
        n=$(( $(cat "$CALLS.health" 2>/dev/null || echo 0) + 1 )); echo "$n" >"$CALLS.health"
        rooms=${FAKE_ROOMS:-0}; (( n == 1 )) || rooms=${FAKE_ROOMS_LATER:-$rooms}
        if has "${FAKE_BAD_HEALTH:-}" "$(img)"; then echo '503 {"status":"degraded"}'; exit 1; fi
        echo "200 {\"status\":\"ok\",\"activeRooms\":${rooms}}" ;;
      "exec -T ov-backend node scripts/check-schema.mjs")
        echo "check-schema $(img)" >>"$CALLS"; ! has "${FAKE_BAD_SCHEMA:-}" "$(img)" ;;
      *) echo "unexpected: docker compose $*" >>"$CALLS"; exit 1 ;;
    esac ;;
  *) echo "unexpected: docker $*" >>"$CALLS"; exit 1 ;;
esac
EOF
cat >"$T/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
[[ "$1" == cat ]] && exit 0
if [[ "$1" == show ]]; then
  case "$3" in
    ConditionResult) echo "${FAKE_BACKUP_CONDITION:-yes}" ;;
    Result) echo success ;;
  esac
  exit 0
fi
echo "backup $2" >>"$CALLS"
exit "${FAKE_BACKUP_RC:-0}"
EOF
cat >"$T/bin/date" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  +%u) echo "${FAKE_DOW:-2}" ;;
  +%H%M) echo "${FAKE_HM:-1000}" ;;
  *) exec /bin/date "$@" ;;
esac
EOF
chmod +x "$T/bin/"*

export PATH="$T/bin:$PATH" KIT="$T/kit" CALLS="$T/calls" OV_DEPLOY_LOCK="$T/deploy.lock"
export FAKE_IMAGES="openvolley-backend:old1 openvolley-backend:new2" FAKE_OWNER_PW=0wnerSecret0123456789
reset() {
  printf 'OV_BACKEND_IMAGE=openvolley-backend:old1\nOV_OWNER_PW=%s\nOV_APP_PW=app\n' "$FAKE_OWNER_PW" >"$KIT/.env"
  rm -f -- "$CALLS" "$CALLS.roles" "$CALLS.health" "$KIT/DEPLOYED.log"
  : >"$CALLS"
}
deploy() { "$KIT/deploy.sh" "$@" >"$T/out" 2>&1; }
image_now() { sed -n 's/^OV_BACKEND_IMAGE=//p' "$KIT/.env"; }
expect_fail() {  # TEXT CMD...: fails, and its output has TEXT
  local want=$1 rc
  shift
  set +e; "$@"; rc=$?; set -e
  (( rc != 0 )) || bad "expected failure ($want): $*"
  grep -qF -- "$want" "$T/out" || bad "expected \"$want\" from $*"
}

# 1. the whole release, in order
reset
deploy new2 || bad "deploy new2"
want=$'backup openvolley-backup.service\nmigrate openvolley-backend:new2 scripts/migrate.mjs pw=0wnerSecret0123456789 url=postgres://ov_owner@127.0.0.1:5432/openvolley\nroles\nowner-check openvolley-backend:new2 pw=0wnerSecret0123456789 url=postgres://ov_owner@127.0.0.1:5432/openvolley\nup openvolley-backend:new2\ncheck-schema openvolley-backend:new2'
[[ "$(cat "$CALLS")" == "$want" ]] || { diff <(echo "$want") "$CALLS" >&2 || true; bad "steps or their order"; }
[[ "$(image_now)" == openvolley-backend:new2 ]] || bad ".env not switched"
grep -qx -- '-- roles.sql of openvolley-backend:new2' "$CALLS.roles" || bad "roles.sql must come from the new image"
grep -q 'running OV_BACKEND_IMAGE=openvolley-backend:old1 before deploying openvolley-backend:new2' "$KIT/DEPLOYED.log" &&
  grep -q 'deployed openvolley-backend:new2 (previous openvolley-backend:old1)' "$KIT/DEPLOYED.log" || bad "DEPLOYED.log"
ok "dump, migrations of the new image (owner password by environment only), roles.sql, schema check as the owner, switch, check-schema, logged"

# 2. a failed migration switches nothing
reset
expect_fail "migrations failed" env FAKE_MIGRATE_RC=1 "$KIT/deploy.sh" new2 >"$T/out" 2>&1
! grep -q '^up \|^roles' "$CALLS" || bad "switched or ran roles.sql after a failed migration"
[[ "$(image_now)" == openvolley-backend:old1 ]] || bad ".env changed after a failed migration"
ok "a failed migration: no roles.sql, no switch, .env unchanged"

# 3. the new image fails its schema check: the previous one comes back
reset
expect_fail "rolled back to openvolley-backend:old1" env FAKE_BAD_SCHEMA=openvolley-backend:new2 "$KIT/deploy.sh" new2 >"$T/out" 2>&1
tail -n2 "$CALLS" | head -n1 | grep -qx 'check-schema openvolley-backend:new2' && tail -n1 "$CALLS" | grep -qx 'up openvolley-backend:old1' || bad "rollback steps"
[[ "$(image_now)" == openvolley-backend:old1 ]] || bad ".env not rolled back"
grep -q 'failed (check-schema.mjs); rolled back to openvolley-backend:old1' "$KIT/DEPLOYED.log" || bad "rollback not logged"
ok "check-schema fails after the switch: previous image back in .env and started, logged"

# 4. not healthy at all, and /health not 200
reset
expect_fail "rolled back" env FAKE_UNHEALTHY=openvolley-backend:new2 "$KIT/deploy.sh" new2 >"$T/out" 2>&1
[[ "$(image_now)" == openvolley-backend:old1 ]] || bad "unhealthy: .env not rolled back"
reset
expect_fail "rolled back" env FAKE_BAD_HEALTH=openvolley-backend:new2 OV_READY_TIMEOUT=1 "$KIT/deploy.sh" new2 >"$T/out" 2>&1
[[ "$(image_now)" == openvolley-backend:old1 ]] || bad "/health 503: .env not rolled back"
ok "unhealthy container or /health 503 after the switch: rolled back"

# 5. refusals before anything happens
reset
expect_fail "match-day freeze" env FAKE_DOW=6 "$KIT/deploy.sh" new2 >"$T/out" 2>&1
expect_fail "match-day freeze" env FAKE_DOW=5 FAKE_HM=1700 "$KIT/deploy.sh" new2 >"$T/out" 2>&1
[[ ! -s "$CALLS" ]] || bad "freeze: something ran"
FAKE_DOW=5 FAKE_HM=1659 deploy --migrate-only new2 || bad "Friday 16:59 is outside the freeze"
reset
FAKE_DOW=7 deploy --any-time --migrate-only new2 || bad "--any-time"
ok "freeze window Friday 17:00 to Sunday, --any-time overrides"
reset
expect_fail "2 live relay room(s)" env FAKE_ROOMS=2 "$KIT/deploy.sh" new2 >"$T/out" 2>&1
[[ ! -s "$CALLS" ]] || bad "live rooms: something ran"
ok "live relay rooms: refused"
reset
expect_fail "OV_BACKEND_IMAGE" env OV_BACKEND_IMAGE=openvolley-backend:new2 "$KIT/deploy.sh" new2 >"$T/out" 2>&1
expect_fail "not loaded" "$KIT/deploy.sh" missing3 >"$T/out" 2>&1
expect_fail "the backup" env FAKE_BACKUP_RC=1 "$KIT/deploy.sh" new2 >"$T/out" 2>&1
! grep -q '^migrate' "$CALLS" || bad "migrated after a failed backup"
expect_fail "not a migration number" "$KIT/deploy.sh" --rerun x new2 >"$T/out" 2>&1
ok "refused: an exported compose variable, an image not loaded, a failed dump, a bad --rerun"

# 6. --baseline before the switch, --rerun after it
reset
deploy --baseline 031 --rerun 032 new2 || bad "deploy --baseline --rerun"
grep -n '^migrate\|^up' "$CALLS" | sed 's/ pw=.*//' >"$T/order"
want=$'2:migrate openvolley-backend:new2 scripts/migrate.mjs --baseline 031\n5:up openvolley-backend:new2\n7:migrate openvolley-backend:new2 scripts/migrate.mjs --rerun 032'
[[ "$(cat "$T/order")" == "$want" ]] || { diff <(echo "$want") "$T/order" >&2 || true; bad "--baseline / --rerun order"; }
ok "--baseline goes to the migration run, --rerun runs after the switch"

# 7. the schema check as the owner fails before the switch: no container changes
reset
expect_fail "the schema check of openvolley-backend:new2 fails" env FAKE_OWNER_CHECK_RC=1 "$KIT/deploy.sh" new2 >"$T/out" 2>&1
grep -q '^owner-check' "$CALLS" && ! grep -q '^up' "$CALLS" || bad "switched after a failed schema check"
[[ "$(image_now)" == openvolley-backend:old1 ]] || bad ".env changed after a failed schema check"
ok "schema check of the new image as the owner fails: no switch, .env unchanged"

# 8. a relay room opened during the dump and the migrations: no switch
reset
expect_fail "1 live relay room(s)" env FAKE_ROOMS_LATER=1 "$KIT/deploy.sh" new2 >"$T/out" 2>&1
grep -q "checked again before the switch" "$T/out" && grep -q '^migrate' "$CALLS" && ! grep -q '^up' "$CALLS" || bad "switched with a room opened meanwhile"
[[ "$(image_now)" == openvolley-backend:old1 ]] || bad ".env changed with a room opened meanwhile"
reset
FAKE_ROOMS_LATER=1 deploy --any-time new2 || bad "--any-time with a room opened meanwhile"
ok "live rooms checked again right before the switch (--any-time overrides)"

# 9. the backup unit's condition fails: systemctl start says 0, nothing ran
reset
expect_fail "did not run" env FAKE_BACKUP_CONDITION=no "$KIT/deploy.sh" new2 >"$T/out" 2>&1
! grep -q '^migrate' "$CALLS" || bad "migrated without a fresh dump"
ok "a backup unit that skipped its run (condition not met): refused"

# 10. --migrate-only: the reruns, then the schema check, no switch
reset
deploy --migrate-only --rerun 007 new2 || bad "deploy --migrate-only --rerun"
grep '^migrate\|^owner-check\|^up' "$CALLS" | sed 's/ pw=.*//' >"$T/order"
want=$'migrate openvolley-backend:new2 scripts/migrate.mjs\nmigrate openvolley-backend:new2 scripts/migrate.mjs --rerun 007\nowner-check openvolley-backend:new2'
[[ "$(cat "$T/order")" == "$want" ]] || { diff <(echo "$want") "$T/order" >&2 || true; bad "--migrate-only order"; }
reset
expect_fail "schema check of openvolley-backend:new2 fails" env FAKE_OWNER_CHECK_RC=1 "$KIT/deploy.sh" --migrate-only new2 >"$T/out" 2>&1
ok "--migrate-only: reruns, then the schema check as the owner; no switch"

echo "deploy.sh: ${PASS} passed"
