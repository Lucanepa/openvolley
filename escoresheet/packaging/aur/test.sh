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
#
# The container is removed at the end (also on Ctrl-C).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
case ${1:-} in
  openvolley) pkg=openvolley-escoresheet port=5173 ;;
  openbeach)  pkg=openbeach-escoresheet  port=5174 ;;
  *) echo "usage: $0 <openvolley|openbeach>" >&2; exit 2 ;;
esac

name=ov-aur-test-$pkg-$$
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

docker run -d --name "$name" -v "$here/$pkg-bin:/in:ro" \
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
