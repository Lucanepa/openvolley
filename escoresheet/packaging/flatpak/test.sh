#!/usr/bin/env bash
# Builds, installs and starts the Flatpaks in a clean Debian container, then
# runs publish-flatpak.sh with a throwaway key and installs from that repo
# over HTTP the way a user would (the .flatpakref):
#   - the AppStream metainfo and the desktop file validate
#   - flatpak-builder builds the manifest as committed (the release .deb by
#     URL and SHA-256, the tray library from source)
#   - the binary links inside the runtime (ldd), the tray library is there,
#     and the bundle-type stamp is "unknown" (the in-app updater is off)
#   - the app starts under Xvfb, stays up, serves its LAN page, and its log
#     says it does not update itself
#   - publish-flatpak.sh: signed commit and summary, .flatpakref installs,
#     the installed app is the release version
# Point Hub (ch.kscw.PointHub) is not the Tauri app, so instead of the stamp,
# the LAN page and the updater line: every library of its bundle resolves in
# the runtime, and it starts under Xvfb with Chromium's helper processes, its
# settings and cache inside the sandbox (~/.var/app/ch.kscw.PointHub).
#
#   escoresheet/packaging/flatpak/test.sh [openvolley|beach|point-hub|both|all]   (default both)
#
# OV_FLATPAK_TEST_DEB=FILE builds the one app given from FILE instead of the
# manifest's URL (a release that is not published yet: Point Hub's manifest
# carries the @SHA256@ placeholder until bump.sh fills it in).
#
# Needs Docker with --privileged (flatpak-builder and flatpak run use
# bubblewrap). The GNOME runtime and SDK (~1.5 GB) are kept between runs in
# the Docker volume ov-flatpak-test-cache (OV_FLATPAK_TEST_CACHE=DIR: a host
# directory instead). The container is removed at the end (also on Ctrl-C).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd -P)
case ${1:-both} in
  openvolley) apps="openvolley" ;;
  beach) apps="beach" ;;
  point-hub) apps="point-hub" ;;
  both) apps="openvolley beach" ;;
  all) apps="openvolley beach point-hub" ;;
  *) echo "usage: $0 [openvolley|beach|point-hub|both|all]" >&2; exit 2 ;;
esac
deb_args=()
if [[ -n "${OV_FLATPAK_TEST_DEB:-}" ]]; then
  [[ "$apps" != *" "* ]] || { echo "OV_FLATPAK_TEST_DEB goes with one app" >&2; exit 2; }
  deb_args=(-v "$(realpath "$OV_FLATPAK_TEST_DEB"):/deb/app.deb:ro" -e TEST_DEB=/deb/app.deb)
fi

name=ov-flatpak-test-$$
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

docker run -d --name "$name" --privileged --shm-size=512m \
  -v "${OV_FLATPAK_TEST_CACHE:-ov-flatpak-test-cache}:/cache" \
  -v "$here:/in:ro" ${deb_args[@]+"${deb_args[@]}"} debian:trixie sleep infinity >/dev/null

docker exec -i -e APPS="$apps" "$name" bash -s <<'EOF'
set -euo pipefail
step() { printf '\n== %s\n' "$*"; }
export FLATPAK_USER_DIR=/cache/flatpak DISPLAY=:99

step "toolchain"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq flatpak flatpak-builder ostree gnupg git \
  appstream desktop-file-utils python3 xvfb dbus curl ca-certificates dpkg procps >/dev/null
flatpak --version; flatpak-builder --version
flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
# remotes an earlier run left in the cache (another throwaway key)
for r in test openvolley; do flatpak remote-delete --user --force "$r" >/dev/null 2>&1 || true; done
cp -r /in /src
Xvfb :99 -screen 0 1366x800x24 >/tmp/xvfb.log 2>&1 &

for app in $APPS; do
  case $app in
    openvolley) id=com.openvolley.escoresheet cmd=openvolley-escoresheet port=5173 ;;
    beach) id=com.openvolley.beach cmd=openbeach-escoresheet port=5174 ;;
    point-hub) id=ch.kscw.PointHub cmd=point-hub port= ;;
  esac
  ver=$(python3 /src/flatpak-meta.py version "/src/$id.json")
  if [[ -n "${TEST_DEB:-}" ]]; then
    # a release not published yet: the given .deb instead of the manifest's URL
    [[ "$(dpkg-deb -f "$TEST_DEB" Package) $(dpkg-deb -f "$TEST_DEB" Version)" == "$cmd $ver" ]] ||
      { echo "OV_FLATPAK_TEST_DEB is not $cmd $ver"; exit 1; }
    python3 /src/flatpak-meta.py set-deb "/src/$id.json" --path "$TEST_DEB"
    echo "building $id from the given .deb (not the manifest's URL)"
  fi
  # a cache from an earlier run may still have it installed
  for ref in $(flatpak list --user --app --columns=ref | grep "^$id/" || true); do
    flatpak uninstall --user -y --noninteractive "$ref" >/dev/null
  done

  step "$id $ver: metainfo and desktop file"
  appstreamcli validate --no-net "/src/$id.metainfo.xml"
  desktop-file-validate "/src/$id.desktop" && echo "desktop file valid"

  step "$id: flatpak-builder (manifest as committed)"
  (cd /src && flatpak-builder --user --install-deps-from=flathub --disable-rofiles-fuse --force-clean \
    --state-dir=/cache/state --default-branch=test --repo=/tmp/repo "/cache/build-$id" "$id.json" > "/tmp/build-$id.log" 2>&1) ||
    { tail -40 "/tmp/build-$id.log"; exit 1; }
  rm -rf "/cache/build-$id"
  flatpak remote-add --user --if-not-exists --no-gpg-verify test /tmp/repo
  flatpak install --user -y --noninteractive --reinstall test "app/$id/x86_64/test" >/dev/null
  flatpak info --user "$id//test" | grep -E 'Version|Runtime'

  step "$id: inside the sandbox"
  if [[ $app == point-hub ]]; then
    # jpackage's bundle: the JVM and JCEF find their own libraries at run
    # time (no rpath), so ldd gets those directories and only runtime
    # libraries can be missing.
    flatpak run --branch=test --command=sh "$id" -c '
      set -e
      test -x /app/point-hub/bin/point-hub
      test "$(readlink -f /app/bin/point-hub)" = /app/point-hub/bin/point-hub
      test -x /app/point-hub/lib/runtime/lib/jcef_helper
      LD_LIBRARY_PATH=$(find /app/point-hub -name "*.so*" -printf "%h\n" | sort -u | paste -sd:); export LD_LIBRARY_PATH
      missing=$(find /app/point-hub -type f \( -name "*.so*" -o -perm -u+x \) | while read -r f; do
        head -c 4 "$f" | grep -q ELF || continue; ldd "$f" 2>/dev/null | grep "not found" | sed "s|^|$f: |"; done | sort -u)
      [ -z "$missing" ] || { echo "$missing"; exit 1; }
      echo "every library of the bundle resolves in the runtime; the Chromium helper is executable"'
  else
    flatpak run --branch=test --command=sh "$id" -c "
      set -e
      ! ldd /app/bin/$cmd | grep 'not found'
      ls /app/lib/libayatana-appindicator3.so.1
      LC_ALL=C grep -aq __TAURI_BUNDLE_TYPE_VAR_UNK /app/bin/$cmd
      echo 'links, tray library present, bundle type unknown'"
  fi

  step "$id: run under Xvfb"
  if [[ $app == point-hub ]]; then
    # No board here: it starts, brings up Chromium (Cef.start, before any
    # window) and keeps looking for the scoreboard.
    dbus-run-session -- flatpak run --branch=test "$id" > "/tmp/run-$id.log" 2>&1 &
    ok=0
    for _ in $(seq 60); do
      sleep 1
      if pgrep -f jcef_helper >/dev/null; then ok=1; break; fi
    done
    sleep 5
    flatpak ps | grep -q "$id" || { echo "the app is not running:"; cat "/tmp/run-$id.log"; exit 1; }
    (( ok )) || { echo "Chromium (jcef_helper) did not start"; cat "/tmp/run-$id.log"; exit 1; }
    if grep -E 'hs_err_pid|Exception in thread|SIGSEGV' "/tmp/run-$id.log"; then echo "the JVM failed"; exit 1; fi
    test -d "$HOME/.var/app/$id/config/point-hub" && test -d "$HOME/.var/app/$id/data/point-hub/browser" ||
      { echo "no settings / Chromium cache in ~/.var/app/$id"; ls -R "$HOME/.var/app/$id" | head -20; exit 1; }
    echo "running, Chromium helpers up; settings and cache in ~/.var/app/$id/{config,data}/point-hub"
  else
    dbus-run-session -- env WEBKIT_DISABLE_DMABUF_RENDERER=1 flatpak run --branch=test "$id" > "/tmp/run-$id.log" 2>&1 &
    ok=0
    for _ in $(seq 60); do
      sleep 1
      if curl -fs -o /dev/null "http://127.0.0.1:$port/"; then ok=1; break; fi
    done
    sleep 5
    flatpak ps | grep -q "$id" || { echo "the app is not running:"; cat "/tmp/run-$id.log"; exit 1; }
    (( ok )) || { echo "no LAN page on :$port"; cat "/tmp/run-$id.log"; exit 1; }
    echo "running, LAN page on :$port"
    grep -E '^\[update\] (not an installed copy|installed by flatpak)' "/tmp/run-$id.log"
  fi
  flatpak kill "$id"
  sleep 2
  flatpak uninstall --user -y --noninteractive "$id//test" >/dev/null

  step "$id: publish-flatpak.sh with a throwaway key"
  export OV_PKGS_HOME=/tmp/pkgs OV_FLATPAK_CACHE=/cache/publish
  [[ -d /tmp/pkgs/flatpak-gpg ]] || /src/publish-flatpak.sh --init-key | head -1
  deb="/tmp/$cmd.deb"
  if [[ -n "${TEST_DEB:-}" ]]; then
    cp "$TEST_DEB" "$deb"
  else
    url=$(python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); print([s["url"] for mod in m["modules"] if isinstance(mod, dict) for s in mod["sources"] if s.get("dest-filename", "").endswith(".deb")][0])' "/src/$id.json")
    curl -fsSL -o "$deb" "$url"
  fi
  /src/publish-flatpak.sh --app "$app" --deb "$deb" "$ver" > "/tmp/publish-$id.log" 2>&1 ||
    { tail -30 "/tmp/publish-$id.log"; exit 1; }
  grep '^published' "/tmp/publish-$id.log"

  step "$id: install from the .flatpakref over HTTP"
  python3 -m http.server 8765 --directory /tmp/pkgs/public >/dev/null 2>&1 &
  http_pid=$!
  sleep 1
  sed 's#https://get.openvolley.app/flatpak#http://127.0.0.1:8765/flatpak#' \
    "/tmp/pkgs/public/flatpak/$id.flatpakref" > "/tmp/$id.flatpakref"
  flatpak install --user -y --noninteractive "/tmp/$id.flatpakref" >/dev/null
  flatpak list --user --app --columns=application,version,origin,branch | grep -P "^$id\t$ver\topenvolley\tstable$"
  flatpak uninstall --user -y --noninteractive "$id" >/dev/null
  kill "$http_pid"
done
flatpak remote-delete --user --force test 2>/dev/null || true
flatpak remote-delete --user --force openvolley 2>/dev/null || true
step "all checks passed"
EOF
