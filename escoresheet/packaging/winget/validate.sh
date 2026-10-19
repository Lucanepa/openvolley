#!/usr/bin/env bash
# Validate the winget manifests here against the official JSON schemas of
# microsoft/winget-cli (schemas/JSON/manifests/v<ManifestVersion>), in a
# throwaway python container (needs Docker and network). With --urls it also
# downloads every InstallerUrl and compares its SHA-256 with the manifest.
#
#   escoresheet/packaging/winget/validate.sh [--urls]
#
# A manifest written before its app's first release (update-manifests.sh
# --placeholder, InstallerSha256 @SHA256@) passes as "pending" while its
# InstallerUrl is not published, and fails once it is (then regenerate it).
#
# On Windows, `winget validate --manifest <version folder>` is the same check
# done by winget itself, and `winget install --manifest <folder>` a real test
# (it needs `winget settings --enable LocalManifestFiles` once, as admin).
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
CACHE=${XDG_CACHE_HOME:-$HOME/.cache}/openvolley/winget-schemas
IMAGE=python:3.13-slim

versions=$(grep -rhoE '^ManifestVersion: [0-9.]+' "$HERE/manifests" | awk '{print $2}' | sort -u)
for v in $versions; do
  mkdir -p "$CACHE/$v"
  for t in version installer defaultLocale locale; do
    f=$CACHE/$v/manifest.$t.$v.json
    [ -s "$f" ] && continue
    curl -fsSL --retry 3 -o "$f" \
      "https://raw.githubusercontent.com/microsoft/winget-cli/master/schemas/JSON/manifests/v$v/manifest.$t.$v.json"
  done
done

docker run --rm \
  -v "$HERE:/w:ro" -v "$CACHE:/schemas:ro" \
  "$IMAGE" sh -c 'pip install -q --disable-pip-version-check --root-user-action=ignore pyyaml jsonschema >/dev/null \
    && for v in /schemas/*/; do cp "$v"*.json /tmp/; done \
    && python /w/validate.py /tmp /w/manifests'

pending_bad=0
while IFS= read -r f; do
  grep -Eq "^ *InstallerSha256: '?@SHA256@'?$" "$f" || continue
  url=$(sed -n 's/^ *InstallerUrl: *//p' "$f")
  if curl -fsIL --max-time 30 -o /dev/null "$url"; then
    echo "BAD  ${f#"$HERE"/}: $url is published, the manifest still has the @SHA256@ placeholder: run update-manifests.sh"
    pending_bad=1
  else
    echo "ok   ${f#"$HERE"/}: pending, $url is not published yet"
  fi
done < <(find "$HERE/manifests" -name '*.installer.yaml' | sort)
(( ! pending_bad )) || exit 1

if [ "${1:-}" = --urls ]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  fail=0
  while IFS= read -r f; do
    url=$(sed -n 's/^ *InstallerUrl: *//p' "$f")
    want=$(sed -n 's/^ *InstallerSha256: *//p' "$f")
    if [ "${want//\'/}" = @SHA256@ ]; then echo "skip $url: pending"; continue; fi
    curl -fsSL --retry 3 -o "$tmp/i.exe" "$url"
    got=$(sha256sum "$tmp/i.exe" | cut -d' ' -f1 | tr 'a-f' 'A-F')
    if [ "$got" = "$want" ]; then echo "ok   $url"; else echo "BAD  $url: $got, manifest says $want"; fail=1; fi
  done < <(find "$HERE/manifests" -name '*.installer.yaml' | sort)
  exit $fail
fi
