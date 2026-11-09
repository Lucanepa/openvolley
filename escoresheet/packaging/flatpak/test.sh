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
#
#   escoresheet/packaging/flatpak/test.sh [openvolley|beach|both]   (default both)
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
  both) apps="openvolley beach" ;;
  *) echo "usage: $0 [openvolley|beach|both]" >&2; exit 2 ;;
esac

name=ov-flatpak-test-$$
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

docker run -d --name "$name" --privileged \
  -v "${OV_FLATPAK_TEST_CACHE:-ov-flatpak-test-cache}:/cache" \
  -v "$here:/in:ro" debian:trixie sleep infinity >/dev/null

docker exec -i -e APPS="$apps" "$name" bash -s <<'EOF'
set -euo pipefail
step() { printf '\n== %s\n' "$*"; }
export FLATPAK_USER_DIR=/cache/flatpak DISPLAY=:99

step "toolchain"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq flatpak flatpak-builder ostree gnupg git \
  appstream desktop-file-utils python3 xvfb dbus curl ca-certificates dpkg >/dev/null
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
  esac
  ver=$(python3 /src/flatpak-meta.py version "/src/$id.json")
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
  flatpak run --branch=test --command=sh "$id" -c "
    set -e
    ! ldd /app/bin/$cmd | grep 'not found'
    ls /app/lib/libayatana-appindicator3.so.1
    LC_ALL=C grep -aq __TAURI_BUNDLE_TYPE_VAR_UNK /app/bin/$cmd
    echo 'links, tray library present, bundle type unknown'"

  step "$id: run under Xvfb"
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
  flatpak kill "$id"
  sleep 2
  flatpak uninstall --user -y --noninteractive "$id//test" >/dev/null

  step "$id: publish-flatpak.sh with a throwaway key"
  export OV_PKGS_HOME=/tmp/pkgs OV_FLATPAK_CACHE=/cache/publish
  [[ -d /tmp/pkgs/flatpak-gpg ]] || /src/publish-flatpak.sh --init-key | head -1
  deb="/tmp/$cmd.deb"
  url=$(python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); print([s["url"] for mod in m["modules"] if isinstance(mod, dict) for s in mod["sources"] if s.get("dest-filename", "").endswith(".deb")][0])' "/src/$id.json")
  curl -fsSL -o "$deb" "$url"
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
