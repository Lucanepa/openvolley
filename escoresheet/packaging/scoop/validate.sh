#!/usr/bin/env bash
# Check the Scoop manifests here (needs Docker and network):
#   1. against Scoop's own JSON schema (ScoopInstaller/Scoop, schema.json);
#   2. the installer/uninstaller scripts parse as PowerShell (pwsh container);
#   3. checkver's regex finds the version in the manifest among the
#      GitHub releases, and the manifest's URL is its autoupdate URL;
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
        cache[cv["url"]] = urllib.request.urlopen(cv["url"], timeout=30).read().decode()
    found = re.search(cv["regex"], cache[cv["url"]])
    latest = found.group(1) if found else None
    want_url = m["autoupdate"]["architecture"]["64bit"]["url"].replace("$version", m["version"])
    ok_url = m["architecture"]["64bit"]["url"] == want_url
    name = f.rsplit("/", 1)[-1]
    print(f"{'ok  ' if latest and ok_url else 'BAD '} {name}: manifest {m['version']}, newest release {latest}"
          + ("" if ok_url else f", url is not the autoupdate url {want_url}"))
    bad += not (latest and ok_url)
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
