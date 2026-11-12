#!/usr/bin/env bash
# Regression test for ci-leak-scan.sh in a throwaway repo: a clean commit
# passes, a commit adding a (fictional) roster with dates of birth fails, the
# ranges for a new branch or a force-push fall back to a scan that still
# sees the commit, and the output never holds the matched text (the CI log is
# public).
#
# Usage: .githooks/test-ci-leak-scan.sh   (exit 0 = all cases pass)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for tool in gitleaks python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: $tool not on PATH, nothing was tested" >&2; exit 2; }
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fails=0
repo="$TMP/repo"
mkdir -p "$repo/.githooks"
cp "$ROOT/.gitleaks.toml" "$repo/"
cp "$ROOT/.githooks/ci-leak-scan.sh" "$repo/.githooks/"
g() { git -C "$repo" -c user.name=Test -c user.email=test@example.org -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"; }
g init -q -b work
commit() { printf '%s\n' "$2" > "$repo/$1"; g add -- "$1"; g commit -q -m "add $1"; g rev-parse HEAD; }

c0="$(commit README.md "scratch repo")"
c1="$(commit notes.md "nothing personal here")"
c2="$(commit export.json "[{\"firstName\": \"Anna\", \"lastName\": \"Muster\", \"dob\": \"01.02.2008\"}]")"

# expect <rc> <label> <base> <head>
expect() {
  local want="$1" label="$2" out rc=0
  out="$("$repo/.githooks/ci-leak-scan.sh" "$3" "$4" 2>&1)" || rc=$?
  if [[ "$rc" != "$want" ]]; then
    echo "FAIL want exit $want, got $rc: $label"; sed 's/^/       /' <<<"$out"; fails=$((fails + 1)); return
  fi
  if grep -qE 'Muster|01\.02\.2008' <<<"$out"; then
    echo "FAIL output holds the matched text: $label"; fails=$((fails + 1)); return
  fi
  if [[ "$want" == 1 ]] && ! grep -q 'match-data-birth-date' <<<"$out"; then
    echo "FAIL rule not named in the output: $label"; fails=$((fails + 1)); return
  fi
  echo "ok   exit $want $label"
}

ZERO=0000000000000000000000000000000000000000
expect 0 "clean push"                       "$c0" "$c1"
expect 1 "push adding a roster"             "$c1" "$c2"
expect 1 "range holding the roster commit"  "$c0" "$c2"
# No origin/main: the head commit alone.
expect 0 "new branch, clean head"           "$ZERO" "$c1"
expect 1 "new branch, roster head"          "$ZERO" "$c2"
expect 1 "manual run, no base"              "" "$c2"
# A new branch off main: the commits not on main.
g update-ref refs/remotes/origin/main "$c0"
expect 1 "new branch off main, roster commit" "$ZERO" "$c2"
expect 0 "new branch off main, clean"       "$ZERO" "$c1"
# A force-push to main (the old base is gone): the head commit alone.
g update-ref refs/remotes/origin/main "$c2"
expect 1 "force-push, base not in history"  "1111111111111111111111111111111111111111" "$c2"
expect 0 "force-push, clean head"           "1111111111111111111111111111111111111111" "$c1"

if (( fails > 0 )); then
  echo "$fails case(s) failed"; exit 1
fi
echo "all cases passed"
