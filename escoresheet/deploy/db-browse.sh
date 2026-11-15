#!/usr/bin/env bash
# db-browse.sh: read the production database without being able to change it.
#
#   ./db-browse.sh psql              psql as ov_readonly (the container's local
#                                    socket, no password needed)
#   ./db-browse.sh web [PORT]        pgweb, a SQL browser in the browser, on
#                                    127.0.0.1:PORT of this host (default 8091)
#                                    until Ctrl-C; reach it through SSH:
#                                      ssh -N -L 8091:127.0.0.1:8091 <this host>
#                                      open http://localhost:8091
#
# Both connect as ov_readonly (backend/db/roles.sql): SELECT on the tables of
# public without their secret columns (game PINs, token and code hashes, ...),
# nothing of auth, read-only transactions, 15 s per statement, 3 connections.
# The role exists once roles.sql ran (apply-roles.sh); `web` also needs its
# password: OV_READONLY_PW in .env (openssl rand -hex 32), then apply-roles.sh
# once more.
#
# `web` publishes nothing to the network: the port is bound to 127.0.0.1 only
# and asks for a basic-auth password made for this run (printed below). The
# pgweb container and its network exist only while the script runs; Ctrl-C
# removes both. The database stays on ov-internal (no egress); pgweb joins it
# and a bridge network of its own for the loopback port.
#
# Changing data is the manager's Data tab (super admins, audited), never here.
#
# Settings: OV_ENV_FILE (default: .env next to this script), OV_PROJECT
# (default openvolley), OV_DB_NAME (default openvolley), OV_PGWEB_IMAGE.
set -euo pipefail

KIT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
OV_ENV_FILE=${OV_ENV_FILE:-$KIT_DIR/.env}
OV_PROJECT=${OV_PROJECT:-openvolley}
OV_DB_NAME=${OV_DB_NAME:-openvolley}
OV_PGWEB_IMAGE=${OV_PGWEB_IMAGE:-sosedoff/pgweb:0.17.0}
NAME=ov-dbbrowse

die() { printf '[db-browse] FATAL: %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2; }

mode=${1:-}
[[ "$mode" == psql || "$mode" == web ]] || usage

mapfile -t ids < <(docker ps -q \
  --filter "label=com.docker.compose.project=${OV_PROJECT}" \
  --filter "label=com.docker.compose.service=ov-postgres")
(( ${#ids[@]} == 1 )) || die "expected one running ov-postgres of project ${OV_PROJECT}, found ${#ids[@]}"
PG=${ids[0]}

docker exec "$PG" psql -X -U ov_owner -d "$OV_DB_NAME" -At \
  -c "select 1 from pg_roles where rolname = 'ov_readonly' and rolcanlogin" | grep -qx 1 \
  || die "ov_readonly is missing: run ./apply-roles.sh < roles.sql first"

if [[ "$mode" == psql ]]; then
  exec docker exec -it "$PG" psql -X -U ov_readonly -d "$OV_DB_NAME"
fi

port=${2:-8091}
[[ "$port" =~ ^[0-9]{2,5}$ ]] || die "port: a number"

[[ -r "$OV_ENV_FILE" ]] || die "cannot read ${OV_ENV_FILE}"
pw=$(sed -n 's/^OV_READONLY_PW=//p' "$OV_ENV_FILE" | tail -n1)
pw=${pw%$'\r'}
if [[ ${#pw} -ge 2 && ( ( "$pw" == \'*\' ) || ( "$pw" == \"*\" ) ) ]]; then pw=${pw:1:${#pw}-2}; fi
[[ -n "$pw" ]] || die "OV_READONLY_PW is not set in ${OV_ENV_FILE}: add it (openssl rand -hex 32), then ./apply-roles.sh < roles.sql"
[[ "$pw" =~ ^[A-Za-z0-9._~-]+$ ]] || die "OV_READONLY_PW must be URL-safe (generate with: openssl rand -hex 32)"

internal=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' "$PG" | grep -E 'ov-internal$' | head -n1)
[[ -n "$internal" ]] || die "ov-postgres is on no *ov-internal network"

docker container inspect "$NAME" >/dev/null 2>&1 && die "a container ${NAME} exists already (another db-browse.sh running?)"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker network rm "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

docker network inspect "$NAME" >/dev/null 2>&1 || docker network create "$NAME" >/dev/null

auth=$(openssl rand -hex 12)
# The secrets travel as environment variables (not in the host's process list)
PGWEB_DATABASE_URL="postgres://ov_readonly:${pw}@ov-postgres:5432/${OV_DB_NAME}?sslmode=disable" \
PGWEB_AUTH_USER=ov PGWEB_AUTH_PASS="$auth" \
docker create --rm --name "$NAME" \
  --network "$NAME" -p "127.0.0.1:${port}:8081" \
  --read-only --tmpfs /tmp:size=16m --cap-drop ALL --security-opt no-new-privileges \
  --memory 256m --pids-limit 64 \
  -e PGWEB_DATABASE_URL -e PGWEB_AUTH_USER -e PGWEB_AUTH_PASS \
  "$OV_PGWEB_IMAGE" \
  --bind 0.0.0.0 --listen 8081 --readonly --lock-session --no-ssh --query-timeout 15 --open-retry 5 >/dev/null
docker network connect "$internal" "$NAME"

host=$(hostname -s)
cat <<EOF
[db-browse] pgweb (read-only, ov_readonly) on 127.0.0.1:${port} of ${host}
  on your computer:  ssh -N -L ${port}:127.0.0.1:${port} <this host>
  then open:         http://localhost:${port}
  user / password:   ov / ${auth}   (this run only)
  Ctrl-C here stops it and removes the container.
EOF
# in the background, so a signal (Ctrl-C, a closed SSH session) runs the
# cleanup at once instead of after pgweb
docker start -a "$NAME" &
wait $!
