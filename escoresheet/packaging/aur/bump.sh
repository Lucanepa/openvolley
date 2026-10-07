#!/usr/bin/env bash
# Points an AUR package at a new release: pkgver, pkgrel, both sha256sums and
# .SRCINFO. Run it after the GitHub release is published (the .deb must be
# downloadable), then commit and run publish.sh.
#
#   escoresheet/packaging/aur/bump.sh openvolley 2.4.0
#   escoresheet/packaging/aur/bump.sh openbeach 2.1.0
#   escoresheet/packaging/aur/bump.sh openvolley 2.4.0 2   # pkgrel 2, same release
#
# .SRCINFO comes from `makepkg --printsrcinfo`: the local makepkg on Arch,
# otherwise an archlinux Docker container (non-root). Needs curl, sha256sum, sed.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)

usage() { echo "usage: $0 <openvolley|openbeach> <version> [pkgrel]" >&2; exit 2; }
[[ $# -ge 2 && $# -le 3 ]] || usage
app=$1 ver=$2 rel=${3:-1}
[[ $ver =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must be X.Y.Z, got '$ver'" >&2; exit 2; }
[[ $rel =~ ^[1-9][0-9]*$ ]] || { echo "pkgrel must be a positive number, got '$rel'" >&2; exit 2; }

case $app in
  openvolley) pkg=openvolley-escoresheet tag=desktop-v$ver ;;
  openbeach)  pkg=openbeach-escoresheet  tag=beach-desktop-v$ver ;;
  *) usage ;;
esac
dir=$here/$pkg-bin
deb_url=https://github.com/Lucanepa/openvolley/releases/download/$tag/${pkg}_${ver}_amd64.deb
lic_url=https://raw.githubusercontent.com/Lucanepa/openvolley/$tag/escoresheet/LICENSE

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "downloading $deb_url"
curl -fsSL --retry 3 -o "$tmp/pkg.deb" "$deb_url"
curl -fsSL --retry 3 -o "$tmp/LICENSE" "$lic_url"
deb_sum=$(sha256sum "$tmp/pkg.deb" | cut -d' ' -f1)
lic_sum=$(sha256sum "$tmp/LICENSE" | cut -d' ' -f1)

sed -i \
  -e "s/^pkgver=.*/pkgver=$ver/" \
  -e "s/^pkgrel=.*/pkgrel=$rel/" \
  -e "s/^sha256sums=.*/sha256sums=('$lic_sum')/" \
  -e "s/^sha256sums_x86_64=.*/sha256sums_x86_64=('$deb_sum')/" \
  "$dir/PKGBUILD"

if command -v makepkg >/dev/null 2>&1; then
  (cd "$dir" && makepkg --printsrcinfo) > "$tmp/SRCINFO"
else
  command -v docker >/dev/null 2>&1 || { echo "need makepkg or docker for .SRCINFO" >&2; exit 1; }
  docker run --rm -v "$dir/PKGBUILD:/in/PKGBUILD:ro" archlinux:latest bash -c '
    set -e
    mkdir /p && cp /in/PKGBUILD /p/ && chown -R nobody /p && cd /p
    runuser -u nobody -- makepkg --printsrcinfo' > "$tmp/SRCINFO"
fi
grep -q "pkgver = $ver" "$tmp/SRCINFO" || { echo ".SRCINFO looks wrong:" >&2; cat "$tmp/SRCINFO" >&2; exit 1; }
cp "$tmp/SRCINFO" "$dir/.SRCINFO"

echo "$pkg-bin -> $ver-$rel"
echo "  deb     $deb_sum"
echo "  LICENSE $lic_sum"
echo "next: test.sh $app (optional), commit, then publish.sh $app"
