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
#   PKG=point-hub bash check-installed.sh
#
# point-hub (Point Hub, not the Tauri app: jpackage's bundle in /opt/point-hub,
# no updater) gets its own checks: every ELF file of the bundle finds its
# system libraries, the command and menu entry, and it starts under Xvfb with
# Chromium's helper processes and its settings and cache in the XDG folders.
#
# Used by test.sh (after makepkg -si) and ../pacman/test.sh (after
# pacman -S from the signed repo). Installs the tools it needs (Xvfb, curl ...)
# and a user "builder" when missing.
set -euo pipefail
: "${PKG:?PKG=openvolley-escoresheet, openbeach-escoresheet or point-hub}"
[[ $PKG == point-hub ]] || : "${PORT:?PORT=5173 or 5174}"
MARKER=${MARKER:-aur}
step() { printf '\n== %s\n' "$*"; }

pacman -S --noconfirm --needed desktop-file-utils xorg-server-xvfb xorg-xauth dbus curl \
  iproute2 procps-ng >/dev/null
id builder >/dev/null 2>&1 || useradd -m builder

if [[ $PKG == point-hub ]]; then
  step "files"
  pacman -Ql point-hub-bin | grep -v '^point-hub-bin /opt/point-hub/lib/' | awk 'NR <= 20'
  [[ "$(readlink -f /usr/bin/point-hub)" == /opt/point-hub/bin/point-hub ]]
  echo "/usr/bin/point-hub -> /opt/point-hub/bin/point-hub"

  step "ldd (every ELF file of the bundle)"
  # The JVM and JCEF find the bundle's own libraries at run time (no rpath):
  # ldd gets those directories, so only system libraries can be missing.
  LD_LIBRARY_PATH=$(find /opt/point-hub -name '*.so*' -printf '%h\n' | sort -u | paste -sd:)
  missing=$(find /opt/point-hub -type f \( -name '*.so*' -o -perm -u+x \) | while read -r f; do
    head -c 4 "$f" | grep -q ELF || continue
    LD_LIBRARY_PATH=$LD_LIBRARY_PATH ldd "$f" 2>/dev/null | grep 'not found' | sed "s|^|$f: |" || true
  done | sort -u)
  [[ -z $missing ]] || { echo "missing libraries:"; echo "$missing"; exit 1; }
  echo "all resolve"

  step "desktop file"
  desktop-file-validate /usr/share/applications/point-hub.desktop && echo valid
  test -f /usr/share/icons/hicolor/512x512/apps/point-hub.png
  echo icon ok

  step "run under Xvfb"
  log=/home/builder/run-point-hub.log
  runuser -u builder -- bash -c '
    cd ~
    exec dbus-run-session -- xvfb-run -a -s "-screen 0 1280x800x24" /usr/bin/point-hub > "'"$log"'" 2>&1
  ' &
  runner=$!
  up=0
  for _ in $(seq 40); do
    sleep 1
    if pgrep -f /opt/point-hub/lib/runtime/lib/jcef_helper >/dev/null; then up=1; break; fi
  done
  sleep 5
  pgrep -u builder -x point-hub >/dev/null || { echo "the app is not running:"; cat "$log"; exit 1; }
  (( up )) || { echo "Chromium (jcef_helper) did not start:"; cat "$log"; exit 1; }
  if grep -E 'hs_err_pid|Exception in thread|SIGSEGV' "$log"; then echo "the JVM failed"; exit 1; fi
  test -d /home/builder/.config/point-hub && test -d /home/builder/.local/share/point-hub/browser
  echo "running: Chromium helpers up, settings in ~/.config/point-hub, cache in ~/.local/share/point-hub"
  pkill -u builder -f /opt/point-hub || true
  wait "$runner" 2>/dev/null || true
  echo "PASS point-hub-bin"
  exit 0
fi

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
