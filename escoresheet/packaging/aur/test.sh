#!/usr/bin/env bash
# Builds and installs an AUR package in a clean archlinux Docker container,
# the way an AUR helper would (makepkg as a non-root user), then checks it:
#   - namcap on the PKGBUILD and on the built package
#   - no missing shared libraries (ldd) and the tray library is there
#   - the desktop file validates, the icons are in place
#   - the in-app updater is off: the bundle-type stamp is "unknown" and the
#     package-manager marker file is there
#   - the app starts under Xvfb, stays up, serves its LAN page, and its log
#     says it does not update itself
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

docker run -d --name "$name" -v "$here/$pkg-bin:/in:ro" archlinux:latest sleep infinity >/dev/null

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

step "files"
pacman -Ql "$PKG-bin"

step "ldd"
missing=$(ldd "/usr/bin/$PKG" | grep 'not found' || true)
[[ -z $missing ]] || { echo "missing libraries:"; echo "$missing"; exit 1; }
ldd "/usr/bin/$PKG" | grep -E 'webkit2gtk|gtk-3|soup'
ls /usr/lib/libayatana-appindicator3.so.1 # loaded at run time for the tray

step "desktop file"
desktop-file-validate "/usr/share/applications/$PKG.desktop" && echo valid
for s in 32x32 128x128 256x256; do test -f "/usr/share/icons/hicolor/$s/apps/$PKG.png"; done
echo icons ok

step "bundle-type stamp"
LC_ALL=C grep -ao '__TAURI_BUNDLE_TYPE_VAR_[A-Z]*' "/usr/bin/$PKG" | tr '\n' ' '; echo
LC_ALL=C grep -aq '__TAURI_BUNDLE_TYPE_VAR_UNK' "/usr/bin/$PKG"
echo "marker: $(cat "/usr/lib/$PKG/package-manager")"
[[ $(cat "/usr/lib/$PKG/package-manager") == aur ]]

step "run under Xvfb"
runuser -u builder -- bash -c '
  cd ~
  export WEBKIT_DISABLE_DMABUF_RENDERER=1 LIBGL_ALWAYS_SOFTWARE=1
  dbus-run-session -- xvfb-run -a -s "-screen 0 1280x800x24" "/usr/bin/'"$PKG"'" > run.log 2>&1 &
  echo $! > run.pid
'
sleep 25
if ! pgrep -x "${PKG:0:15}" >/dev/null; then
  echo "the app is not running:"; cat /home/builder/run.log; exit 1
fi
echo "running: $(pgrep -ax "${PKG:0:15}")"
echo "listening:"; ss -ltn | tail -n +2
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)
echo "LAN page http://127.0.0.1:$PORT/ -> $code"
[[ $code == 200 ]]
echo "app output (update lines, panics, errors):"
grep -E '\[update\]|panic|ERROR' /home/builder/run.log | head -n 20 || true
if grep -q panicked /home/builder/run.log; then exit 1; fi
# An updater that runs logs "<version> <Kind>: checking after the page
# loaded". 2.3.0 / OpenBeach 2.0.0 (unstamped bundle type, Kind::Unsupported)
# say "no automatic updates" instead; releases with Kind::Managed (the marker
# file) may say "installed by aur" or nothing.
if grep -q 'checking after the page loaded' /home/builder/run.log; then
  echo "the in-app updater is running"; exit 1
fi
echo "updater off: ok"
echo "PASS $PKG-bin"
EOF
