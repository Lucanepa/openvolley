#!/usr/bin/env bash
# Point a snap at a released .deb: sets `version:`, the .deb URL and its
# sha256 in <snap>/snap/snapcraft.yaml.
#
#   ./bump.sh openvolley 2.4.0     # desktop-v2.4.0 -> openvolley-escoresheet
#   ./bump.sh openbeach 2.0.1      # beach-desktop-v2.0.1 -> openbeach-escoresheet
#
# The .deb is downloaded from the GitHub release and checked before its hash
# is written down: its minisign signature (<deb>.sig, the updater key in
# tauri.conf.json / tauri.beach.conf.json) when `minisign` is installed, and
# the version in its control file. The hash then pins exactly that file: the
# snap build fails if the release asset ever changes.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
tauri="$here/../../frontend/src-tauri"

case "${1:-}" in
  openvolley) snap=openvolley-escoresheet; tag=desktop-v; conf=tauri.conf.json ;;
  openbeach) snap=openbeach-escoresheet; tag=beach-desktop-v; conf=tauri.beach.conf.json ;;
  *) echo "usage: $0 openvolley|openbeach VERSION" >&2; exit 2 ;;
esac
version=${2:?usage: $0 openvolley|openbeach VERSION}
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must be X.Y.Z, got $version" >&2; exit 2; }

yaml="$here/$snap/snap/snapcraft.yaml"
deb="${snap}_${version}_amd64.deb"
url="https://github.com/Lucanepa/openvolley/releases/download/${tag}${version}/$deb"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "downloading $url"
curl -fsSL -o "$tmp/$deb" "$url"
curl -fsSL -o "$tmp/$deb.sig" "$url.sig"

if command -v minisign >/dev/null; then
  jq -r .plugins.updater.pubkey "$tauri/$conf" | base64 -d > "$tmp/key.pub"
  base64 -d "$tmp/$deb.sig" > "$tmp/$deb.minisig"
  minisign -Vq -p "$tmp/key.pub" -x "$tmp/$deb.minisig" -m "$tmp/$deb"
  echo "signature OK (updater key in $conf)"
else
  echo "WARNING: minisign not installed, the .deb's signature was NOT checked" >&2
fi

command -v dpkg-deb >/dev/null || { echo "dpkg-deb is needed to check the .deb" >&2; exit 1; }
got=$(dpkg-deb -f "$tmp/$deb" Version)
[ "$got" = "$version" ] || { echo "the .deb says version $got, not $version" >&2; exit 1; }

# The binary must know it runs in a snap (updater.rs `managed_by`: SNAP_NAME ->
# Kind::Managed), or it checks get.openvolley.app and offers updates the snap
# cannot install. Releases before that switch lack it (OpenVolley 2.4.0 and
# earlier, OpenBeach 2.0.0 and earlier). ALLOW_SELF_UPDATING=1 skips this
# check, for a local test build only.
mkdir "$tmp/x"
dpkg-deb -x "$tmp/$deb" "$tmp/x"
[ -f "$tmp/x/usr/bin/$snap" ] || { echo "no usr/bin/$snap in $deb" >&2; exit 1; }
cp "$tmp/x/usr/bin/$snap" "$tmp/bin"
if ! grep -qa SNAP_NAME "$tmp/bin"; then
  if [ "${ALLOW_SELF_UPDATING:-}" = 1 ]; then
    echo "WARNING: $version has no package-manager switch: the snap would update itself; do not publish it" >&2
  else
    echo "$version has no package-manager switch (no SNAP_NAME in usr/bin/$snap): its own updater would run inside the snap. Use a later release (ALLOW_SELF_UPDATING=1 for a local test only)." >&2
    exit 1
  fi
fi

sum=$(sha256sum "$tmp/$deb" | cut -d' ' -f1)
sed -i \
  -e "s|^version: .*|version: '$version'|" \
  -e "s|^\(    source: \)https://github.com/Lucanepa/openvolley/releases/download/.*\.deb$|\1$url|" \
  -e "s|^\(    source-checksum: sha256/\).*|\1$sum|" \
  "$yaml"

grep -q "^version: '$version'$" "$yaml" && grep -qF "$url" "$yaml" && grep -qF "sha256/$sum" "$yaml" \
  || { echo "could not update $yaml" >&2; exit 1; }
echo "$snap -> $version ($sum)"
