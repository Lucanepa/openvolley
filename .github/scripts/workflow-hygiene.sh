#!/usr/bin/env bash
# Static check of the GitHub workflows (audit SEC-23: ios.yml had brought back
# what desktop.yml and release.yml had been fixed for). Every workflow:
#   - pins every action to a full commit SHA (local ./ actions excepted);
#   - has a top-level permissions block;
#   - checks out with persist-credentials: false (no token left in .git/config);
#   - has no pull_request_target / workflow_run trigger (they run with secrets
#     on code a pull request controls).
# Every job that reads a secret other than GITHUB_TOKEN (the signing and
# upload keys):
#   - runs in a GitHub environment (secrets scoped to it, deployment rules);
#   - installs or runs no package (npm, npx, yarn, pnpm, cargo, pip) and uses
#     no action but actions/checkout, actions/download-artifact and
#     actions/upload-artifact: no third-party code next to the keys;
#   - never lets /usr/bin/security use an imported key without a prompt
#     (security import -T /usr/bin/security).
#
# Usage: .github/scripts/workflow-hygiene.sh [workflows-dir]   (exit 0 = clean)
set -euo pipefail
dir="${1:-$(cd "$(dirname "$0")/.." && pwd)/workflows}"
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 not on PATH, nothing was checked" >&2; exit 2; }
exec python3 -I - "$dir" <<'EOF'
import glob, os, re, sys

d = sys.argv[1]
files = sorted(glob.glob(os.path.join(d, "*.yml")) + glob.glob(os.path.join(d, "*.yaml")))
if not files:
    print(f"ERROR: no workflows in {d}", file=sys.stderr)
    sys.exit(2)

PKG = re.compile(r"(^|[\s;&|(])(npm|npx|yarn|pnpm|cargo|pip3?|bun)\s")
ALLOWED_IN_SIGNING = ("actions/checkout@", "actions/download-artifact@", "actions/upload-artifact@")
problems = []

def strip_comment(line):
    # good enough for workflows: a # after whitespace starts a comment
    return re.sub(r"\s+#.*$", "", line) if not line.lstrip().startswith("#") else ""

for path in files:
    name = os.path.basename(path)
    lines = open(path, encoding="utf-8").read().split("\n")
    code = [strip_comment(l) for l in lines]
    text = "\n".join(code)

    for i, l in enumerate(code, 1):
        m = re.match(r"^\s*-?\s*uses:\s*['\"]?([^'\"\s]+)", l)
        if not m:
            continue
        ref = m.group(1)
        if ref.startswith("./") or ref.startswith("docker://"):
            continue
        if not re.search(r"@[0-9a-f]{40}$", ref):
            problems.append(f"{name}:{i}: action not pinned to a commit SHA: {ref}")

    if not re.search(r"^permissions:", text, re.M):
        problems.append(f"{name}: no top-level permissions block")

    checkouts = [i for i, l in enumerate(code) if re.match(r"^\s*-?\s*uses:\s*actions/checkout@", l)]
    for i in checkouts:
        indent = len(code[i]) - len(code[i].lstrip(" -"))
        block = []
        for l in code[i + 1:]:
            if l.strip() == "":
                continue
            ind = len(l) - len(l.lstrip(" "))
            if ind < indent or re.match(r"^\s*- ", l) and ind <= indent:
                break
            block.append(l)
        if not any(re.match(r"^\s*persist-credentials:\s*false\s*$", l) for l in block):
            problems.append(f"{name}:{i + 1}: actions/checkout without persist-credentials: false")

    if re.search(r"^\s*(pull_request_target|workflow_run)\s*:", text, re.M) or re.search(r"^on:\s*\[?[^\n]*\b(pull_request_target|workflow_run)\b", text, re.M):
        problems.append(f"{name}: pull_request_target / workflow_run trigger")

    # jobs: two-space keys under the top-level jobs:
    try:
        start = next(i for i, l in enumerate(code) if re.match(r"^jobs:\s*$", l))
    except StopIteration:
        continue
    jobs, cur = {}, None
    for i in range(start + 1, len(code)):
        l = code[i]
        if re.match(r"^\S", l):
            break
        m = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", l)
        if m:
            cur = m.group(1)
            jobs[cur] = []
            continue
        if cur:
            jobs[cur].append((i + 1, l))
    for job, body in jobs.items():
        btext = "\n".join(l for _, l in body)
        secrets = sorted(set(re.findall(r"secrets\.([A-Za-z0-9_]+)", btext)) - {"GITHUB_TOKEN"})
        if not secrets:
            continue
        where = f"{name} job {job} (secrets {', '.join(secrets)})"
        if not re.search(r"^\s{4}environment:\s*\S", btext, re.M):
            problems.append(f"{where}: not in a GitHub environment")
        for n, l in body:
            if PKG.search(l) and not re.match(r"^\s*(name|description):", l):
                problems.append(f"{name}:{n}: job {job} has signing secrets and runs a package tool: {l.strip()}")
            m = re.match(r"^\s*-?\s*uses:\s*['\"]?([^'\"\s]+)", l)
            if m and not m.group(1).startswith(ALLOWED_IN_SIGNING):
                problems.append(f"{name}:{n}: job {job} has signing secrets and uses {m.group(1)}")
            if re.search(r"security\s+import\b.*-T\s+/usr/bin/security", l):
                problems.append(f"{name}:{n}: job {job} lets /usr/bin/security use the imported key")

for p in problems:
    print(f"::error::{p}")
if problems:
    print(f"workflow-hygiene: {len(problems)} problem(s) in {d}")
    sys.exit(1)
print(f"workflow-hygiene: {len(files)} workflows clean")
EOF
