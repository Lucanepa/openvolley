#!/usr/bin/env bash
# Builds and installs an AUR package in a clean archlinux Docker container,
# the way an AUR helper would (makepkg as a non-root user), then checks it:
#   - namcap on the PKGBUILD and on the built package
#   - check-installed.sh: no missing shared libraries, the desktop file and
#     icons, the in-app updater off (bundle-type stamp "unknown", the
#     package-manager marker file), and the app starts under Xvfb, serves its
#     LAN page and its log says it does not update itself
#
#   escoresheet/packaging/aur/test.sh openvolley
#   escoresheet/packaging/aur/test.sh openbeach
#   escoresheet/packaging/aur/test.sh point-hub
#
# Before a release is published (Point Hub's first: its PKGBUILD has the
# @SHA256@ placeholder), OV_AUR_TEST_DEB=FILE and OV_AUR_TEST_LICENSE=FILE
# build the container's copy from those files instead of the release: they go
# next to the PKGBUILD under its source names and its sha256sums become theirs
# (the committed PKGBUILD is not changed).
#
# The container is removed at the end (also on Ctrl-C).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
case ${1:-} in
  openvolley) pkg=openvolley-escoresheet port=5173 ;;
  openbeach)  pkg=openbeach-escoresheet  port=5174 ;;
  point-hub)  pkg=point-hub              port= ;;
  *) echo "usage: $0 <openvolley|openbeach|point-hub>" >&2; exit 2 ;;
esac
local_src=()
if [[ -n "${OV_AUR_TEST_DEB:-}" || -n "${OV_AUR_TEST_LICENSE:-}" ]]; then
  [[ -f "${OV_AUR_TEST_DEB:-}" && -f "${OV_AUR_TEST_LICENSE:-}" ]] ||
    { echo "OV_AUR_TEST_DEB and OV_AUR_TEST_LICENSE: both files are needed" >&2; exit 2; }
  local_src=(-v "$(realpath "$OV_AUR_TEST_DEB"):/src/app.deb:ro" -v "$(realpath "$OV_AUR_TEST_LICENSE"):/src/LICENSE:ro")
fi

name=ov-aur-test-$pkg-$$
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

# (Chromium, in point-hub, wants more than Docker's default 64 MB /dev/shm)
docker run -d --name "$name" --shm-size=512m -v "$here/$pkg-bin:/in:ro" ${local_src[@]+"${local_src[@]}"} \
  -v "$here/check-installed.sh:/check-installed.sh:ro" archlinux:latest sleep infinity >/dev/null

docker exec -i -e PKG="$pkg" -e PORT="$port" "$name" bash -s <<'EOF'
set -euo pipefail
step() { printf '\n== %s\n' "$*"; }

step "toolchain"
pacman -Syu --noconfirm --needed base-devel namcap desktop-file-utils \
  xorg-server-xvfb xorg-xauth dbus curl >/dev/null
useradd -m builder
echo 'builder ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/builder
cp -r /in /home/builder/pkg
if [[ -f /src/app.deb ]]; then
  # a release not published yet: its files, under the PKGBUILD's source names
  ver=$(sed -n 's/^pkgver=//p' /home/builder/pkg/PKGBUILD)
  cp /src/app.deb "/home/builder/pkg/$PKG-$ver-amd64.deb"
  cp /src/LICENSE "/home/builder/pkg/LICENSE-$ver"
  sed -i -e "s/^sha256sums=.*/sha256sums=('$(sha256sum /src/LICENSE | cut -d' ' -f1)')/" \
    -e "s/^sha256sums_x86_64=.*/sha256sums_x86_64=('$(sha256sum /src/app.deb | cut -d' ' -f1)')/" /home/builder/pkg/PKGBUILD
  echo "building from the given .deb and LICENSE (not the release's)"
fi
chown -R builder: /home/builder/pkg

step "namcap PKGBUILD"
cd /home/builder/pkg
runuser -u builder -- namcap PKGBUILD

step "makepkg -si (as builder)"
runuser -u builder -- makepkg -si --noconfirm 2>&1 | tail -n 25

step "namcap package"
runuser -u builder -- namcap "$(ls -1 ./*.pkg.tar.zst | head -n1)"

step "installed package"
PKG="$PKG" PORT="$PORT" bash /check-installed.sh
EOF
