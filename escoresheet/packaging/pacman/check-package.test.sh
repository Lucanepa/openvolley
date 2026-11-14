#!/usr/bin/env bash
# Offline test of check-package.py (publish-pacman.sh runs it on the signing
# host between the container build and the signature): a package that the
# committed PKGBUILD's own package() made from a .deb passes; one with an
# extra file, a changed byte, an install scriptlet, a link, a setuid bit, or
# built from a .deb the PKGBUILD does not pin, is refused. The package is
# made with the PKGBUILD's functions (its _unstamp_bundle_type and
# package()), without makepkg, Docker or the network.
#
#   escoresheet/packaging/pacman/check-package.test.sh
#
# Needs dpkg-deb, zstd, tar and python3.
set -euo pipefail
umask 022

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
CHECK="$HERE/check-package.py"
T=$(mktemp -d "${TMPDIR:-/tmp}/ov-check-package.XXXXXX")
trap 'rm -rf "$T"' EXIT
for t in dpkg-deb zstd tar python3 sha256sum; do command -v "$t" >/dev/null || { echo "skip: $t not installed" >&2; exit 0; }; done

PASS=0
ok() { PASS=$((PASS + 1)); echo "ok   $*"; }
bad() { echo "FAIL $*" >&2; exit 1; }
refused() {
  local want=$1 pkg=$2 deb=${3:-$T/release.deb}
  if python3 -I "$CHECK" "$pkg" "$deb" "$T/PKGBUILD" > "$T/out" 2>&1; then bad "accepted ($want): $(cat "$T/out")"; fi
  grep -qF -- "$want" "$T/out" || bad "expected \"$want\", got: $(cat "$T/out")"
  ok "refuses: $want"
}

B=openvolley-escoresheet
V=9.8.7
# --- a release .deb laid out like the Tauri bundler's -----------------------------
r="$T/debroot"
mkdir -p "$r/DEBIAN" "$r/usr/bin" "$r/usr/share/applications"
printf 'Package: %s\nVersion: %s\nArchitecture: amd64\nMaintainer: test <test@example.invalid>\nDescription: test\n' "$B" "$V" > "$r/DEBIAN/control"
python3 -I -c 'import os, sys
m = b"__TAURI_BUNDLE_TYPE_VAR_"
open(sys.argv[1], "wb").write(os.urandom(3000) + m + b"DEB" + os.urandom(500) + m + b"DEB" + m + b"RPM" + os.urandom(800))' "$r/usr/bin/$B"
chmod 755 "$r/usr/bin/$B"
printf '[Desktop Entry]\nName=Test\n' > "$r/usr/share/applications/$B.desktop"
for s in 32x32 128x128 256x256@2; do
  mkdir -p "$r/usr/share/icons/hicolor/$s/apps"
  head -c 300 /dev/urandom > "$r/usr/share/icons/hicolor/$s/apps/$B.png"
done
mkdir -p "$r/usr/libexec/$B"; printf '#!/bin/sh\n' > "$r/usr/libexec/$B/apt-upgrade"
dpkg-deb --root-owner-group -b "$r" "$T/release.deb" >/dev/null
printf 'GNU GENERAL PUBLIC LICENSE (test copy)\n' > "$T/LICENSE-$V"

# --- the committed PKGBUILD, pointed at these files -------------------------------------
sed -e "s/^pkgver=.*/pkgver=$V/" \
  -e "s/^sha256sums=.*/sha256sums=('$(sha256sum "$T/LICENSE-$V" | cut -d' ' -f1)')/" \
  -e "s/^sha256sums_x86_64=.*/sha256sums_x86_64=('$(sha256sum "$T/release.deb" | cut -d' ' -f1)')/" \
  "$HERE/../aur/$B-bin/PKGBUILD" > "$T/PKGBUILD"

# build_pkg OUT [EXTRA...]: the PKGBUILD's package() over the extracted .deb
# (what its prepare() does, without bsdtar), then pacman's .PKGINFO; EXTRA is
# run in the package root before it is packed.
build_pkg() {
  local out=$1
  shift
  rm -rf "$T/src" "$T/pkg"
  mkdir -p "$T/src/deb" "$T/pkg"
  dpkg-deb -x "$T/release.deb" "$T/src/deb"
  cp "$T/LICENSE-$V" "$T/src/"
  (
    cd "$T/src"
    # shellcheck disable=SC1091
    . "$T/PKGBUILD"
    _unstamp_bundle_type "deb/usr/bin/$_pkgname"
    pkgdir="$T/pkg" package
  )
  printf 'pkgname = %s-bin\npkgver = %s-1\n' "$B" "$V" > "$T/pkg/.PKGINFO"
  (cd "$T/pkg" && for c in "$@"; do eval "$c"; done)
  tar --zstd -cf "$out" -C "$T/pkg" .
}

build_pkg "$T/good.pkg.tar.zst"
python3 -I "$CHECK" "$T/good.pkg.tar.zst" "$T/release.deb" "$T/PKGBUILD" > "$T/out" 2>&1 || bad "the PKGBUILD's own package was refused: $(cat "$T/out")"
grep -q "its 7 files come from release.deb" "$T/out" || bad "unexpected: $(cat "$T/out")"
ok "a package the PKGBUILD made from the pinned .deb passes (binary unstamped, icon moved, LICENSE, marker)"

build_pkg "$T/x.pkg.tar.zst" 'printf "#!/bin/sh\n" > usr/bin/helper; chmod 755 usr/bin/helper'
refused "usr/bin/helper is not a file of" "$T/x.pkg.tar.zst"
build_pkg "$T/x.pkg.tar.zst" "python3 -I -c 'import sys; f = open(sys.argv[1], \"r+b\"); f.seek(100); f.write(b\"X\")' usr/bin/$B"
refused "usr/bin/$B is not a file of" "$T/x.pkg.tar.zst"
build_pkg "$T/x.pkg.tar.zst" 'printf "post_install() { :; }\n" > .INSTALL'
refused ".INSTALL: pacman metadata the PKGBUILD never makes" "$T/x.pkg.tar.zst"
build_pkg "$T/x.pkg.tar.zst" "ln -s /bin/sh usr/bin/sh-link"
refused "usr/bin/sh-link is not a regular file" "$T/x.pkg.tar.zst"
build_pkg "$T/x.pkg.tar.zst" "chmod 4755 usr/bin/$B"
refused "has a setuid/setgid bit" "$T/x.pkg.tar.zst"
build_pkg "$T/x.pkg.tar.zst" "echo pacman > usr/lib/$B/package-manager"
refused "usr/lib/$B/package-manager is not a file of" "$T/x.pkg.tar.zst"
cp "$T/release.deb" "$T/other.deb"; printf 'x' >> "$T/other.deb"
refused "the PKGBUILD pins" "$T/good.pkg.tar.zst" "$T/other.deb"

echo "all $PASS checks passed"
