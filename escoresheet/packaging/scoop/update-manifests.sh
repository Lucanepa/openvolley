#!/usr/bin/env bash
# Point a Scoop manifest at a new version: version, installer URL (from the
# manifest's own autoupdate URL) and SHA-256.
#
#   escoresheet/packaging/scoop/update-manifests.sh openvolley 2.4.0
#   escoresheet/packaging/scoop/update-manifests.sh openbeach  2.0.1 --file OpenBeach_2.0.1_x64-setup.exe
#
#   --file PATH    hash a local copy of the setup .exe, with PATH.sig next to
#                  it (default: download both from the GitHub release, ~7 MB)
#
# The hash is written only for an installer whose signature (<exe>.sig, the
# updater key, made by publish-pkgs.sh --desktop, bound to the version and
# the file name) verifies: ../lib/release-asset.sh, fails closed. So run it
# after publish-pkgs.sh --desktop VERSION.
#
# Scoop's own `checkver.ps1 -u` (Windows, from a Scoop checkout) does the same
# from the manifests' checkver/autoupdate blocks.
# Then: escoresheet/packaging/scoop/validate.sh
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
die() { echo "update-manifests: $*" >&2; exit 1; }
# shellcheck source=SCRIPTDIR/../lib/release-asset.sh
. "$HERE/../lib/release-asset.sh"

[ $# -ge 2 ] || die "usage: $0 openvolley|openbeach VERSION [--file PATH]"
app=$1 version=$2
shift 2
file=''
while [ $# -gt 0 ]; do
  case $1 in
    --file) file=${2:?}; shift 2 ;;
    *) die "unknown option $1" ;;
  esac
done
case $app in openvolley|openbeach) ;; beach) app=openbeach ;; *) die "app must be openvolley or openbeach" ;; esac
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must look like 2.4.0, got '$version'"
manifest=$HERE/$app.json

url=$(python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); print(m["autoupdate"]["architecture"]["64bit"]["url"].replace("$version", sys.argv[2]))' "$manifest" "$version")

if [ -z "$file" ]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  file=$(release_asset_fetch "$app" "$version" "$url" "$tmp")
else
  [ "$(basename "$file")" = "$(basename "${url%%#*}")" ] || die "--file $file: expected the release's $(basename "${url%%#*}")"
  release_asset_verify "$app" "$version" "$file"
fi
sha=$(sha256sum "$file" | cut -d' ' -f1)
[[ $sha =~ ^[0-9a-f]{64}$ ]] || die "not a SHA-256: $sha"

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
