#!/usr/bin/env bash
# Offline test of ov-postgres's archive_command (compose.yaml), run by sh as
# Postgres runs it: a new segment is copied; a retry of a segment already
# archived with the same content succeeds (Postgres stopped before it noted
# the copy); a different file of that name, or no archive directory, fails.
#
#   escoresheet/deploy/tests/archive-command.test.sh
set -euo pipefail
KIT_SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
T=$(mktemp -d "${TMPDIR:-/tmp}/ov-archive-test.XXXXXX")
trap 'rm -rf -- "$T"' EXIT
PASS=0
ok() { PASS=$((PASS + 1)); echo "ok   $*"; }
bad() { echo "FAIL $*" >&2; exit 1; }

CMD=$(sed -n 's/^ *- archive_command=//p' "$KIT_SRC/compose.yaml")
[[ -n "$CMD" ]] || bad "no archive_command in compose.yaml"
mkdir -p "$T/wal" "$T/arch"
seg=000000010000000000000007
printf 'segment-a' >"$T/wal/$seg"
archive() { # dir, file name
  local c=${CMD//\/ovpg\/walarchive/$1}
  c=${c//%p/$T/wal/$2}; c=${c//%f/$2}
  sh -c "$c"
}

archive "$T/arch" "$seg" || bad "a new segment is not archived"
cmp -s "$T/wal/$seg" "$T/arch/$seg" || bad "the archived copy differs"
[[ -z "$(find "$T/arch" -name '.*')" ]] || bad "a temp file is left"
ok "a new segment is copied"

archive "$T/arch" "$seg" || bad "a retry of an archived segment fails"
ok "a retry of the same segment succeeds"

printf 'segment-b' >"$T/wal/$seg"
if archive "$T/arch" "$seg"; then bad "a different file of that name was accepted"; fi
[[ "$(cat "$T/arch/$seg")" == segment-a ]] || bad "the archived copy was overwritten"
ok "a different file of that name fails and stays"

if archive "$T/missing" "$seg"; then bad "a missing archive directory was accepted"; fi
ok "a missing archive directory fails"

echo "archive-command.test.sh: $PASS passed"
