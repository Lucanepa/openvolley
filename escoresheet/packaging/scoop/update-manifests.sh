#!/usr/bin/env bash
# Point a Scoop manifest at a new version: version, installer URL (from the
# manifest's own autoupdate URL) and SHA-256.
#
#   escoresheet/packaging/scoop/update-manifests.sh openvolley 2.4.0
#   escoresheet/packaging/scoop/update-manifests.sh openbeach  2.0.1 --file OpenBeach_2.0.1_x64-setup.exe
#
#   --file PATH    hash a local copy of the setup .exe (default: download it
#                  from the GitHub release, ~7 MB)
#   --sha256 HEX   use this hash, download nothing
#
# Scoop's own `checkver.ps1 -u` (Windows, from a Scoop checkout) does the same
# from the manifests' checkver/autoupdate blocks.
# Then: escoresheet/packaging/scoop/validate.sh
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
die() { echo "update-manifests: $*" >&2; exit 1; }

[ $# -ge 2 ] || die "usage: $0 openvolley|openbeach VERSION [--file PATH | --sha256 HEX]"
app=$1 version=$2
shift 2
file= sha=
while [ $# -gt 0 ]; do
  case $1 in
    --file) file=${2:?}; shift 2 ;;
    --sha256) sha=${2:?}; shift 2 ;;
    *) die "unknown option $1" ;;
  esac
done
case $app in openvolley|openbeach) ;; beach) app=openbeach ;; *) die "app must be openvolley or openbeach" ;; esac
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must look like 2.4.0, got '$version'"
manifest=$HERE/$app.json

url=$(python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); print(m["autoupdate"]["architecture"]["64bit"]["url"].replace("$version", sys.argv[2]))' "$manifest" "$version")

if [ -z "$sha" ]; then
  if [ -z "$file" ]; then
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    echo "downloading ${url%%#*}" >&2
    curl -fsSL --retry 3 -o "$tmp/setup.exe" "${url%%#*}" || die "could not download ${url%%#*} (pass --file / --sha256 before the release is published)"
    file=$tmp/setup.exe
  fi
  sha=$(sha256sum "$file" | cut -d' ' -f1)
fi
[[ $sha =~ ^[0-9a-fA-F]{64}$ ]] || die "not a SHA-256: $sha"
sha=$(printf '%s' "$sha" | tr 'A-F' 'a-f')

python3 - "$manifest" "$version" "$url" "$sha" <<'EOF'
import json, sys
path, version, url, sha = sys.argv[1:5]
with open(path, encoding="utf-8") as f:
    m = json.load(f)
m["version"] = version
m["architecture"]["64bit"]["url"] = url
m["architecture"]["64bit"]["hash"] = sha
with open(path, "w", encoding="utf-8") as f:
    json.dump(m, f, indent=4, ensure_ascii=False)
    f.write("\n")
EOF
echo "updated $app.json: $version, sha256 $sha"
