#!/usr/bin/env bash
# CI half of the pre-commit hook: scans the commits a push or pull request
# adds with .gitleaks.toml (credentials and the match-data-* personal-data
# rules). The hook only runs where core.hooksPath is set; this catches clones
# without it and files uploaded on the web. Run by
# .github/workflows/leak-scan.yml.
#
# The CI log of a public repo is public, so findings are listed by rule, file,
# line and commit only, never with the matched text.
#
# Usage: .githooks/ci-leak-scan.sh <base> <head> [default-branch]
#   <base>: the pull request's base commit, or the push's "before" commit (all
#   zeros for a new branch). When it is not in the history (new branch,
#   force-push), the commits not on the default branch are scanned, or the
#   head commit alone when it is already there.
# Exit 0 = no leaks, 1 = leaks found or gitleaks failed, 2 = no gitleaks.
set -euo pipefail

base="${1:-}"
head="${2:?usage: ci-leak-scan.sh <base> <head> [default-branch]}"
default="${3:-main}"
cd "$(dirname "$0")/.."
command -v gitleaks >/dev/null 2>&1 || { echo "ERROR: gitleaks not on PATH, nothing was scanned" >&2; exit 2; }

if [[ -n "$base" && ! "$base" =~ ^0+$ ]] && git cat-file -e "$base^{commit}" 2>/dev/null; then
  range="$base..$head"
elif git rev-parse -q --verify "origin/$default^{commit}" >/dev/null &&
     ! git merge-base --is-ancestor "$head" "origin/$default"; then
  range="origin/$default..$head"
else
  range="-1 $head"
fi
echo "Leak scan: git log $range ($(git rev-list --count $range) commits)"

report="$(mktemp)"
trap 'rm -f "$report"' EXIT
LEAKS_FOUND=42
rc=0
gitleaks git --log-opts="$range" --config .gitleaks.toml --redact --no-banner \
  --log-level warn --report-format json --report-path "$report" \
  --exit-code "$LEAKS_FOUND" . || rc=$?

if (( rc == LEAKS_FOUND )); then
  python3 -I - "$report" <<'EOF'
import json, sys
seen = {}
for f in json.load(open(sys.argv[1])):
    key = (f["Commit"][:12], f["File"], f["RuleID"])
    seen.setdefault(key, [f["StartLine"], 0])[1] += 1
for (commit, path, rule), (line, n) in sorted(seen.items()):
    print(f"::error file={path},line={line}::{rule}: {n} finding(s) in commit {commit}")
EOF
  echo
  echo "Leak scan: FAILED. A commit adds a credential or personal data (rule and file above)."
  echo "  Credential: rotate it now, then remove it from the branch."
  echo "  Personal data (match-data-*): remove the file or data from the branch before"
  echo "  merging; if it reached a public branch, tell the owner: it stays in the"
  echo "  history until purged."
  echo "  False positive? Add an allowlist entry to .gitleaks.toml."
  exit 1
elif (( rc != 0 )); then
  echo "Leak scan: gitleaks failed to run (exit $rc), nothing was scanned." >&2
  exit 1
fi
echo "Leak scan: no leaks found."
