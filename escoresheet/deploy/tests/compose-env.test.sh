#!/usr/bin/env bash
# Offline test: every setting env.example documents reaches a container.
# docker compose passes a container only what compose.yaml names in its
# environment, so a key that is in .env but not interpolated there is
# silently ignored (SEC-55: five of the seven MAIL_BUDGET_* budgets never
# reached the backend, so changing one during a mail incident did nothing).
#
#   1. each uncommented KEY= of env.example is interpolated in compose.yaml
#      (${KEY...}), apart from the few that compose itself or a host script
#      reads (EXCEPT below, each checked to still be read there);
#   2. each mail budget of backend/lib/mailer.js BUDGET_ENV is passed to the
#      backend (KEY: ${KEY:-}).
#
#   escoresheet/deploy/tests/compose-env.test.sh
# CE_COMPOSE / CE_ENV_EXAMPLE / CE_MAILER point it at other files (to see it fail).
set -euo pipefail
KIT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
COMPOSE=${CE_COMPOSE:-$KIT_DIR/compose.yaml}
ENV_EXAMPLE=${CE_ENV_EXAMPLE:-$KIT_DIR/env.example}
MAILER=${CE_MAILER:-$KIT_DIR/../backend/lib/mailer.js}
PASS=0
FAILS=0
ok() { PASS=$((PASS + 1)); echo "ok   $*"; }
bad() { FAILS=$((FAILS + 1)); echo "FAIL $*" >&2; }

# key -> the file that reads it instead of a container (path relative to the kit)
declare -A EXCEPT=(
  [COMPOSE_PROFILES]='compose itself (profiles); never a container setting'
  [OV_READONLY_PW]='apply-roles.sh db-browse.sh'
)

interpolated() { grep -qE "\\\$\\{$1([:?}-]|\\})" "$COMPOSE"; }

keys=$(grep -oE '^[A-Z][A-Z0-9_]*=' "$ENV_EXAMPLE" | tr -d '=' | sort -u)
[[ -n "$keys" ]] || { echo "FAIL no KEY= lines in $ENV_EXAMPLE" >&2; exit 1; }
n=0
for k in $keys; do
  n=$((n + 1))
  if [[ -n "${EXCEPT[$k]:-}" ]]; then
    if [[ "$k" == COMPOSE_PROFILES ]]; then
      grep -q 'profiles:' "$COMPOSE" || bad "$k is excepted for compose profiles, but compose.yaml has none"
    else
      for f in ${EXCEPT[$k]}; do
        grep -q "$k" "$KIT_DIR/$f" || bad "$k is excepted as read by $f, which no longer reads it"
      done
    fi
    continue
  fi
  interpolated "$k" || bad "env.example documents $k, but compose.yaml never passes it (\${$k:-})"
done
(( FAILS == 0 )) && ok "all $n env.example keys reach compose.yaml (or a named host script)"

budgets=$(grep -oE "'MAIL_BUDGET_[A-Z_]+'" "$MAILER" | tr -d "'" | sort -u)
[[ $(wc -w <<<"$budgets") -ge 7 ]] || bad "expected the 7 mail budgets in $MAILER BUDGET_ENV, found: $budgets"
before=$FAILS
for b in $budgets; do
  grep -qE "^ +$b: \\\$\\{$b:-\\}$" "$COMPOSE" || bad "mail budget $b (lib/mailer.js) is not passed to the backend in compose.yaml"
  grep -qE "^$b=" "$ENV_EXAMPLE" || bad "mail budget $b is not documented in env.example"
done
(( FAILS == before )) && ok "every mail budget of lib/mailer.js is in env.example and passed to the backend"

if (( FAILS > 0 )); then echo "compose-env.test.sh: $FAILS failed" >&2; exit 1; fi
echo "compose-env.test.sh: $PASS passed"
