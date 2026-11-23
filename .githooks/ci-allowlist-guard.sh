#!/usr/bin/env bash
# CI guard next to ci-leak-scan.sh: fails when the change up to <head> edits
# what the leak scan lets through:
#   - an allowlist of .gitleaks.toml (the global [[allowlists]] / [allowlist]
#     and every rule's allowlists, by rule id);
#   - its [extend] table (e.g. disabledRules, or useDefault);
#   - .gitleaksignore (fingerprints gitleaks skips).
# "The change" is what <head> edits since it left <trusted> (the base branch):
# their merge-base against <head>. The base branch's own allowlist changes
# since then are not the change's (a branch made before one passes, merged
# with main or not); with no common history <head> is compared with <trusted>.
# leak-scan.yml scans with the trusted branch's scanner and rules, so an
# allowlist entry added in a pull request never hides that pull request's own
# data; this guard makes such a change visible instead of silently ineffective:
# it goes in a change of its own, reviewed by a code owner (CODEOWNERS), and
# applies from the next scan after it is merged.
#
# Usage: .githooks/ci-allowlist-guard.sh <trusted-commit> <head-commit>
# Exit 0 = unchanged, 1 = changed (listed), 2 = cannot compare.
set -euo pipefail

trusted="${1:?usage: ci-allowlist-guard.sh <trusted-commit> <head-commit>}"
head="${2:?usage: ci-allowlist-guard.sh <trusted-commit> <head-commit>}"
cd "$(dirname "$0")/.."
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 not on PATH, nothing was compared" >&2; exit 2; }
for c in "$trusted" "$head"; do
  git cat-file -e "$c^{commit}" 2>/dev/null || { echo "ERROR: $c is not a commit here" >&2; exit 2; }
done
# where the change left the base branch (no common history: the base itself)
since=$(git merge-base "$trusted" "$head" 2>/dev/null) || since=$(git rev-parse "$trusted^{commit}")
echo "Allowlist guard: $(git rev-parse --short "$since")..$(git rev-parse --short "$head^{commit}") (base branch at $(git rev-parse --short "$trusted^{commit}"))"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for side in since head; do
  c=${!side}
  git show "$c:.gitleaks.toml" > "$tmp/$side.toml" 2>/dev/null || : > "$tmp/$side.toml"
  git show "$c:.gitleaksignore" > "$tmp/$side.ignore" 2>/dev/null || : > "$tmp/$side.ignore"
done

python3 -I - "$tmp" <<'EOF'
import json, sys, tomllib
d = sys.argv[1]

def scope(path):
    raw = open(path, "rb").read()
    if not raw.strip():
        return {}
    cfg = tomllib.loads(raw.decode())
    out = {}
    for key in ("allowlist", "allowlists"):
        if key in cfg:
            out[f"global {key}"] = cfg[key]
    if "extend" in cfg:
        out["[extend]"] = cfg["extend"]
    for i, rule in enumerate(cfg.get("rules", [])):
        rid = rule.get("id", f"#{i}")
        for key in ("allowlist", "allowlists"):
            if key in rule:
                out[f"rule {rid} {key}"] = rule[key]
    return {k: json.dumps(v, sort_keys=True) for k, v in out.items()}

try:
    t, h = scope(f"{d}/since.toml"), scope(f"{d}/head.toml")
except tomllib.TOMLDecodeError as e:
    print(f"ERROR: .gitleaks.toml does not parse: {e}", file=sys.stderr)
    sys.exit(2)
changed = sorted(k for k in set(t) | set(h) if t.get(k) != h.get(k))
if open(f"{d}/since.ignore", "rb").read() != open(f"{d}/head.ignore", "rb").read():
    changed.append(".gitleaksignore")
if changed:
    for k in changed:
        print(f"::error file=.gitleaks.toml::allowlist changed: {k}")
    print()
    print("Leak scan: this change edits what the scan lets through (above). The scan runs")
    print("with the base branch's rules, so the entry does not apply to this change itself.")
    print("  Personal data: remove it from the branch; an allowlist entry is not the fix.")
    print("  A real false positive: put the allowlist entry in a pull request of its own,")
    print("  reviewed by a code owner (CODEOWNERS); it applies once merged.")
    sys.exit(1)
print("Allowlist guard: this change leaves the allowlists as they were.")
EOF
