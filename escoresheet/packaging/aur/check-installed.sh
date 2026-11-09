#!/usr/bin/env bash
# Checks an installed openvolley-escoresheet-bin / openbeach-escoresheet-bin
# package inside an Arch container (run as root there):
#   - no missing shared libraries (ldd) and the tray library is there
#   - the desktop file validates, the icons are in place
#   - the in-app updater is off: the bundle-type stamp is "unknown" and the
#     package-manager marker file is there
#   - the app starts under Xvfb as a normal user, stays up, serves its LAN
#     page, and its log says it does not update itself (then it is stopped)
#
#   PKG=openvolley-escoresheet PORT=5173 bash check-installed.sh
#
# Used by test.sh (after makepkg -si) and ../pacman/test.sh (after
# pacman -S from the signed repo). Installs the tools it needs (Xvfb, curl ...)
# and a user "builder" when missing.
set -euo pipefail
: "${PKG:?PKG=openvolley-escoresheet or openbeach-escoresheet}" "${PORT:?PORT=5173 or 5174}"
MARKER=${MARKER:-aur}
step() { printf '\n== %s\n' "$*"; }

pacman -S --noconfirm --needed desktop-file-utils xorg-server-xvfb xorg-xauth dbus curl \
  iproute2 procps-ng >/dev/null
id builder >/dev/null 2>&1 || useradd -m builder

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
[[ $(cat "/usr/lib/$PKG/package-manager") == "$MARKER" ]]

step "run under Xvfb"
log=/home/builder/run-$PKG.log
runuser -u builder -- bash -c '
  cd ~
  export WEBKIT_DISABLE_DMABUF_RENDERER=1 LIBGL_ALWAYS_SOFTWARE=1
  exec dbus-run-session -- xvfb-run -a -s "-screen 0 1280x800x24" "/usr/bin/'"$PKG"'" > "'"$log"'" 2>&1
' &
runner=$!
sleep 25
if ! pgrep -x "${PKG:0:15}" >/dev/null; then
  echo "the app is not running:"; cat "$log"; exit 1
fi
echo "running: $(pgrep -ax "${PKG:0:15}")"
echo "listening:"; ss -ltn | tail -n +2
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)
echo "LAN page http://127.0.0.1:$PORT/ -> $code"
[[ $code == 200 ]]
echo "app output (update lines, panics, errors):"
grep -E '\[update\]|panic|ERROR' "$log" | head -n 20 || true
if grep -q panicked "$log"; then exit 1; fi
# An updater that runs logs "<version> <Kind>: checking after the page
# loaded". 2.3.0 / OpenBeach 2.0.0 (unstamped bundle type, Kind::Unsupported)
# say "no automatic updates" instead; releases with Kind::Managed (the marker
# file) may say "installed by aur" or nothing.
if grep -q 'checking after the page loaded' "$log"; then
  echo "the in-app updater is running"; exit 1
fi
echo "updater off: ok"
# Stop it (the next package's check may start the other app).
pkill -x "${PKG:0:15}" || true
wait "$runner" 2>/dev/null || true
echo "PASS $PKG-bin"
