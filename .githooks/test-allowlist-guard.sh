#!/usr/bin/env bash
# Regression test for SEC-56 in a throwaway repo: a change that adds personal
# data together with an allowlist entry for it passes the scanner and rules it
# carries itself, but not those of the base branch (as leak-scan.yml runs
# them, from a worktree of the base commit); ci-allowlist-guard.sh fails it,
# and a .gitleaksignore added by the change; rule edits without an allowlist
# change and an unchanged config pass; an inline gitleaks:allow comment does
# not exempt data.
#
# Usage: .githooks/test-allowlist-guard.sh   (exit 0 = all cases pass)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for tool in gitleaks python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: $tool not on PATH, nothing was tested" >&2; exit 2; }
done
TMP="$(mktemp -d)"
trap 'git -C "$TMP/repo" worktree prune 2>/dev/null || true; rm -rf "$TMP"' EXIT
fails=0
pass() { echo "ok   $*"; }
fail() { echo "FAIL $*"; fails=$((fails + 1)); }

repo="$TMP/repo"
mkdir -p "$repo/.githooks"
cp "$ROOT/.gitleaks.toml" "$repo/"
cp "$ROOT/.githooks/ci-leak-scan.sh" "$ROOT/.githooks/ci-allowlist-guard.sh" "$repo/.githooks/"
g() { git -C "$repo" -c user.name=Test -c user.email=test@example.org -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"; }
g init -q -b main
g add -A
g commit -q -m base
base=$(g rev-parse HEAD)
g update-ref refs/remotes/origin/main "$base"
roster='[{"firstName": "Anna", "lastName": "Muster", "dob": "01.02.2008"}]'

# A pull request: a roster export and the allowlist entry that hides it
g switch -q -c pr
printf '%s\n' "$roster" > "$repo/export.json"
cat >> "$repo/.gitleaks.toml" <<'EOF'

[[allowlists]]
description = "false positive (it is not)"
paths = ['''export\.json''']
EOF
g add -A
g commit -q -m "export and allowlist"
pr=$(g rev-parse HEAD)

rc=0; "$repo/.githooks/ci-leak-scan.sh" "$base" "$pr" >/dev/null 2>&1 || rc=$?
[[ "$rc" == 0 ]] && pass "the change's own scanner and rules let it through (the gap)" ||
  fail "the change's own rules should allowlist its data here (exit $rc): the test no longer shows the gap"

g worktree add -q --detach "$TMP/trusted" "$base"
rc=0; out=$("$TMP/trusted/.githooks/ci-leak-scan.sh" "$base" "$pr" 2>&1) || rc=$?
if [[ "$rc" == 1 ]] && grep -q 'match-data-birth-date' <<<"$out"; then pass "the base branch's scanner and rules catch it"
else fail "base branch's scan: want exit 1 naming match-data-birth-date, got $rc"; sed 's/^/       /' <<<"$out"; fi

# expect_guard <rc> <label> <trusted> <head>
expect_guard() {
  local want=$1 label=$2 rc=0 out
  out=$("$repo/.githooks/ci-allowlist-guard.sh" "$3" "$4" 2>&1) || rc=$?
  if [[ "$rc" == "$want" ]]; then pass "guard exit $want: $label"
  else fail "guard want exit $want, got $rc: $label"; sed 's/^/       /' <<<"$out"; fi
}
expect_guard 1 "a new global allowlist" "$base" "$pr"
expect_guard 0 "unchanged config" "$base" "$base"

# A rule's own allowlist edited
g switch -q -c rule-allow main
python3 -I - "$repo/.gitleaks.toml" <<'EOF'
import re, sys
p = sys.argv[1]
s = open(p).read()
s2, n = re.subn(r"allowlists = \[", "allowlists = [\n  { description = 'extra', paths = ['''x\\.json'''] },", s, count=1)
assert n == 1
open(p, "w").write(s2)
EOF
g commit -q -am "rule allowlist"
expect_guard 1 "a rule's allowlist widened" "$base" "$(g rev-parse HEAD)"

# A rule added (no allowlist), a description reworded: not an allowlist change
g switch -q -c rules main
cat >> "$repo/.gitleaks.toml" <<'EOF'

[[rules]]
id = "test-extra-rule"
description = "an extra rule"
regex = '''never-matches-[0-9]{40}'''
EOF
g commit -q -am "new rule"
expect_guard 0 "a new rule without allowlist" "$base" "$(g rev-parse HEAD)"

# .gitleaksignore
g switch -q -c ignorefile main
echo "0123456789abcdef:export.json:match-data-birth-date:1" > "$repo/.gitleaksignore"
g add .gitleaksignore
g commit -q -m "ignore file"
expect_guard 1 "a .gitleaksignore added" "$base" "$(g rev-parse HEAD)"

# [extend] disabledRules
g switch -q -c extend main
python3 -I - "$repo/.gitleaks.toml" <<'EOF'
import sys
p = sys.argv[1]
s = open(p).read()
assert "[extend]\n" in s
open(p, "w").write(s.replace("[extend]\n", "[extend]\ndisabledRules = ['match-data-birth-date']\n", 1))
EOF
g commit -q -am "disable a rule"
expect_guard 1 "a rule disabled through [extend]" "$base" "$(g rev-parse HEAD)"

# An inline gitleaks:allow does not exempt data
g switch -q -c inline main
printf '%s\n' "${roster%]} // gitleaks:allow]" > "$repo/notes.json"
g add notes.json
g commit -q -m "inline allow"
rc=0; "$TMP/trusted/.githooks/ci-leak-scan.sh" "$base" "$(g rev-parse HEAD)" >/dev/null 2>&1 || rc=$?
[[ "$rc" == 1 ]] && pass "an inline gitleaks:allow comment does not exempt the data" || fail "inline gitleaks:allow: want exit 1, got $rc"

# The guard judges what the branch itself edits (from its merge-base with the
# base branch), not how the base branch moved on since: a branch made before
# an allowlist change on main passes, before and after merging main; one that
# also edits an allowlist itself still fails. (Last: main moves on here.)
g switch -q -c before-main-allow main
echo "clean work" > "$repo/work.txt"
g add work.txt
g commit -q -m "clean work"
old=$(g rev-parse HEAD)
g switch -q main
cat >> "$repo/.gitleaks.toml" <<'EOF'

[[allowlists]]
description = "reviewed false positive, merged on main"
paths = ['''docs/sample\.json''']
EOF
g commit -q -am "main: an allowlist entry"
main2=$(g rev-parse HEAD)
expect_guard 0 "a branch made before an allowlist change on main" "$main2" "$old"
g switch -q before-main-allow
g merge -q --no-edit main
expect_guard 0 "that branch after merging main" "$main2" "$(g rev-parse HEAD)"
g switch -q -c before-main-own-allow "$old"
cat >> "$repo/.gitleaks.toml" <<'EOF'

[[allowlists]]
description = "the branch's own entry"
paths = ['''export\.json''']
EOF
g commit -q -am "own allowlist"
expect_guard 1 "a branch made before it that adds an allowlist itself" "$main2" "$(g rev-parse HEAD)"

if (( fails > 0 )); then
  echo "$fails case(s) failed"; exit 1
fi
echo "all cases passed"
