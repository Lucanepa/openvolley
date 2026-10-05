#!/usr/bin/env bash
# apply-roles.sh < escoresheet/backend/db/roles.sql
#
# Runs roles.sql in ov-postgres as ov_owner, with :ov_app_pw set to OV_APP_PW
# from /opt/openvolley/.env, then checks that ov_app can log in over TCP (the
# backend's path) and read public.matches.
#
# Why a script: the alternative, `set -a; . .env` in the operator's shell, is
# harmful. Docker Compose prefers exported shell variables over .env, so every
# later `docker compose up` in that shell would silently keep the sourced
# OV_BACKEND_IMAGE / OV_MIN_MATCHES. This script reads the single value it
# needs and never exports anything.
#
# The password travels on psql's stdin (a \set line in front of the SQL), so it
# is not visible in the host's process list.
#
# Settings: OV_ENV_FILE (default: .env next to this script), OV_PROJECT
# (default openvolley), OV_DB_NAME (default openvolley).
set -euo pipefail

KIT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
OV_ENV_FILE=${OV_ENV_FILE:-$KIT_DIR/.env}
OV_PROJECT=${OV_PROJECT:-openvolley}
OV_DB_NAME=${OV_DB_NAME:-openvolley}

die() { printf '[apply-roles] FATAL: %s\n' "$*" >&2; exit 1; }

[[ -t 0 ]] && die "usage: $0 < roles.sql   (roles.sql is read from stdin)"
[[ -r "$OV_ENV_FILE" ]] || die "cannot read ${OV_ENV_FILE}"

pw=$(sed -n 's/^OV_APP_PW=//p' "$OV_ENV_FILE" | tail -n1)
pw=${pw%$'\r'}
if [[ ${#pw} -ge 2 && ( ( "$pw" == \'*\' ) || ( "$pw" == \"*\" ) ) ]]; then pw=${pw:1:${#pw}-2}; fi
[[ -n "$pw" ]] || die "OV_APP_PW is empty in ${OV_ENV_FILE}"
# DATABASE_URL embeds it unescaped, and the \set line below quotes it with '.
[[ "$pw" =~ ^[A-Za-z0-9._~-]+$ ]] || die "OV_APP_PW must be URL-safe (generate with: openssl rand -hex 32)"

mapfile -t ids < <(docker ps -q \
  --filter "label=com.docker.compose.project=${OV_PROJECT}" \
  --filter "label=com.docker.compose.service=ov-postgres")
(( ${#ids[@]} == 1 )) || die "expected one running ov-postgres of project ${OV_PROJECT}, found ${#ids[@]}"
PG=${ids[0]}

{ printf "\\\\set ov_app_pw '%s'\n" "$pw"; cat; } \
  | docker exec -i "$PG" psql -X -q -U ov_owner -d "$OV_DB_NAME" -v ON_ERROR_STOP=1 >/dev/null \
  || die "roles.sql failed (nothing after the failing statement ran)"

n=$(PGPASSWORD="$pw" docker exec -e PGPASSWORD "$PG" \
      psql -X -h 127.0.0.1 -U ov_app -d "$OV_DB_NAME" -At -c 'select count(*) from public.matches') \
  || die "roles applied, but ov_app cannot log in over TCP or read public.matches"
printf '[apply-roles] ok: ov_app logs in and sees %s matches\n' "$n"
