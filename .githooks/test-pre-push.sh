#!/usr/bin/env bash
# Regression test for .githooks/pre-push in a throwaway repo with a bare
# remote: a commit standing in for a purged one (its SHA-256 given through
# OV_PREPUSH_EXTRA_PURGED) is refused on a new branch, on an update, on a
# branch that merely descends from it and in `git push --all`; clean pushes,
# a delete and the python-less fallbacks pass; the real list holds the four
# B6 commits and none of them is in origin/main's history here.
#
# Usage: .githooks/test-pre-push.sh   (exit 0 = all cases pass)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$ROOT/.githooks/pre-push"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fails=0
pass() { echo "ok   $*"; }
fail() { echo "FAIL $*"; fails=$((fails + 1)); }

mkdir -p "$TMP/hooks"
cp "$HOOK" "$TMP/hooks/pre-push"
chmod +x "$TMP/hooks/pre-push"
git init -q --bare "$TMP/remote.git"
repo="$TMP/repo"
g() { git -C "$repo" -c user.name=Test -c user.email=test@example.org -c commit.gpgsign=false -c core.hooksPath="$TMP/hooks" "$@"; }
git init -q -b main "$repo"
g remote add origin "$TMP/remote.git"
commit() { printf '%s\n' "$1" > "$repo/f.txt"; g add f.txt; g commit -q -m "$1"; g rev-parse HEAD; }
sha256() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }

c0=$(commit base)
g push -q origin main 2>/dev/null || fail "first clean push of main"
g switch -q -c old
bad=$(commit "stands in for a purged commit")
after=$(commit "a later commit on the old history")
g switch -q main
export OV_PREPUSH_EXTRA_PURGED="$(sha256 "$bad") $(sha256 0000000000000000000000000000000000000001)"

# expect <ok|refused> <label> <git push args...>
expect() {
  local want=$1 label=$2 out rc=0
  shift 2
  out=$(g push "$@" 2>&1) || rc=$?
  if [[ "$want" == ok && "$rc" == 0 ]]; then pass "$label"
  elif [[ "$want" == refused && "$rc" != 0 ]] && grep -q 'pre-push: REFUSED' <<<"$out"; then
    if grep -qF "$bad" <<<"$out"; then fail "$label: the output names the purged commit"; else pass "$label"; fi
  else
    fail "$label (want $want, exit $rc)"; sed 's/^/       /' <<<"$out"
  fi
}

expect refused "new branch holding the purged commit"        origin old
expect refused "new branch that only descends from it"       origin "$after:refs/heads/later"
expect refused "push --all"                                  --all origin
c1=$(commit "clean work")
expect ok      "clean update of main"                         origin main
g switch -q -c topic
commit "topic work" >/dev/null
expect ok      "clean new branch"                            origin topic
g switch -q main
g merge -q --no-edit -s ours old
expect refused "update of main merging the old history"      origin main
g reset -q --hard "$c1"
expect ok      "delete of a branch"                          origin --delete topic
g tag -a -m old v-old "$bad"
expect refused "annotated tag on the purged commit"          origin v-old
# without python3: perl, then sha256sum
nopy="$TMP/nopy"; mkdir -p "$nopy"
for t in git perl sha256sum cut env bash cat; do ln -sf "$(command -v "$t")" "$nopy/$t"; done
out=$(printf 'refs/heads/old %s refs/heads/old %s\n' "$bad" 0000000000000000000000000000000000000000 |
  (cd "$repo" && PATH="$nopy" "$TMP/hooks/pre-push" origin x 2>&1)) && fail "perl fallback let the purged commit through" || pass "perl fallback refuses"
rm -f "$nopy/perl"
out=$(printf 'refs/heads/old %s refs/heads/old %s\n' "$bad" 0000000000000000000000000000000000000000 |
  (cd "$repo" && PATH="$nopy" "$TMP/hooks/pre-push" origin x 2>&1)) && fail "sha256sum fallback let the purged commit through" || pass "sha256sum fallback refuses"
out=$(printf 'refs/heads/main %s refs/heads/main %s\n' "$c1" "$c0" |
  (cd "$repo" && PATH="$nopy" "$TMP/hooks/pre-push" origin x 2>&1)) && pass "sha256sum fallback lets a clean push through" || fail "sha256sum fallback refused a clean push"

# The real list: the four B6 commits, none in origin/main's history here
unset OV_PREPUSH_EXTRA_PURGED
n=$(sed -n '/^PURGED_SHA256=(/,/^)/p' "$HOOK" | grep -cE '^ +[0-9a-f]{64}$')
[[ "$n" == 4 ]] && pass "the hook lists the 4 purged commits" || fail "the hook lists $n purged commits, expected 4"
if git -C "$ROOT" rev-parse -q --verify 'origin/main^{commit}' >/dev/null; then
  hits=$(git -C "$ROOT" rev-list origin/main | python3 -I -c '
import hashlib, re, sys
src = open(sys.argv[1]).read()
bad = set(re.findall(r"^ +([0-9a-f]{64})$", src, re.M))
print(sum(1 for l in sys.stdin if hashlib.sha256(l.strip().encode()).hexdigest() in bad))' "$HOOK")
  [[ "$hits" == 0 ]] && pass "origin/main holds none of them" || fail "origin/main holds $hits of the purged commits"
fi

if (( fails > 0 )); then
  echo "$fails case(s) failed"; exit 1
fi
echo "all cases passed"
