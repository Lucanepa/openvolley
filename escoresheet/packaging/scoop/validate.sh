#!/usr/bin/env bash
# Check the Scoop manifests here (needs Docker and network):
#   1. against Scoop's own JSON schema (ScoopInstaller/Scoop, schema.json);
#   2. the installer/uninstaller scripts parse as PowerShell (pwsh container);
#   3. checkver finds the manifest's version in the app's latest.json on
#      get.openvolley.app (the version the desktop updater announces), and
#      the manifest's URL is its autoupdate URL;
#   4. with --urls: the URL downloads and its SHA-256 is the manifest's.
#
#   escoresheet/packaging/scoop/validate.sh [--urls]
#
# On Windows the real test is `scoop install .\openvolley.json`.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
CACHE=${XDG_CACHE_HOME:-$HOME/.cache}/openvolley/scoop-schema
mkdir -p "$CACHE"
[ -s "$CACHE/schema.json" ] || curl -fsSL --retry 3 -o "$CACHE/schema.json" \
  https://raw.githubusercontent.com/ScoopInstaller/Scoop/master/schema.json

echo "== schema"
docker run --rm -v "$HERE:/w:ro" -v "$CACHE:/s:ro" python:3.13-slim sh -c '
  pip install -q --disable-pip-version-check --root-user-action=ignore jsonschema >/dev/null && python - <<EOF
import json, glob, sys, jsonschema
schema = json.load(open("/s/schema.json"))
v = jsonschema.Draft7Validator(schema)
bad = 0
for f in sorted(glob.glob("/w/*.json")):
    errs = list(v.iter_errors(json.load(open(f))))
    for e in errs:
        print(f, list(e.path), e.message)
    bad += len(errs)
    print(("ok   " if not errs else "BAD  ") + f.split("/")[-1])
sys.exit(1 if bad else 0)
EOF'

echo "== PowerShell syntax"
docker run --rm -v "$HERE:/w:ro" mcr.microsoft.com/powershell:latest pwsh -NoProfile -Command '
  $bad = 0
  foreach ($f in Get-ChildItem /w/*.json) {
    $m = Get-Content $f -Raw | ConvertFrom-Json
    foreach ($hook in "installer", "uninstaller") {
      $code = $m.$hook.script -join "`r`n"
      $errors = $null
      [void][System.Management.Automation.Language.Parser]::ParseInput($code, [ref]$null, [ref]$errors)
      if ($errors) { $bad++; $errors | ForEach-Object { Write-Host "BAD  $($f.Name) $hook : $($_.Message)" } }
      else { Write-Host "ok   $($f.Name) $hook" }
    }
  }
  exit $bad'

echo "== checkver / autoupdate"
python3 - "$HERE" <<'EOF'
import json, glob, re, sys, urllib.request
bad = 0
cache = {}
for f in sorted(glob.glob(sys.argv[1] + "/*.json")):
    m = json.load(open(f))
    cv = m["checkver"]
    if cv["url"] not in cache:
        # Scoop's own user agent: get.openvolley.app (Cloudflare) refuses Python's
        req = urllib.request.Request(cv["url"], headers={"User-Agent": "Scoop/1.0 (+http://scoop.sh/) PowerShell/7.4 (Windows NT 10.0; Win64; x64; Core)"})
        cache[cv["url"]] = urllib.request.urlopen(req, timeout=30).read().decode()
    if "jsonpath" in cv:
        # "$.version": the GitHub release list is no use here, it puts
        # desktop-v2.4.9 before desktop-v2.4.10
        node = json.loads(cache[cv["url"]])
        for key in cv["jsonpath"].split(".")[1:]:
            node = node.get(key) if isinstance(node, dict) else None
        latest = node if isinstance(node, str) else None
    else:
        found = re.search(cv["regex"], cache[cv["url"]])
        latest = found.group(1) if found else None
    want_url = m["autoupdate"]["architecture"]["64bit"]["url"].replace("$version", m["version"])
    ok_url = m["architecture"]["64bit"]["url"] == want_url
    name = f.rsplit("/", 1)[-1]
    ok_ver = latest == m["version"]
    print(f"{'ok  ' if ok_ver and ok_url else 'BAD '} {name}: manifest {m['version']}, newest release {latest}"
          + ("" if ok_url else f", url is not the autoupdate url {want_url}"))
    bad += not (ok_ver and ok_url)
sys.exit(1 if bad else 0)
EOF

if [ "${1:-}" = --urls ]; then
  echo "== downloads"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  fail=0
  for f in "$HERE"/*.json; do
    read -r url want < <(python3 -c 'import json,sys; a=json.load(open(sys.argv[1]))["architecture"]["64bit"]; print(a["url"].split("#")[0], a["hash"])' "$f")
    curl -fsSL --retry 3 -o "$tmp/s.exe" "$url"
    got=$(sha256sum "$tmp/s.exe" | cut -d' ' -f1)
    if [ "$got" = "$want" ]; then echo "ok   $url"; else echo "BAD  $url: $got, manifest says $want"; fail=1; fi
  done
  exit $fail
fi
