#!/usr/bin/env bash
# End-to-end test of publish-pkgs.sh with Point Hub, with THROWAWAY keys: a
# whole run (APT pool and index, F-Droid repo, install page, install.sh), as
# on lenovoserver but into a scratch OV_PKGS_HOME, --no-sync, never GitHub.
# publish-desktop.test.sh has the unit tests; this checks that the pieces work
# together on real packages:
#   1. a production-like state: OpenVolley 2.2.0 announced by desktop/latest.json,
#      2.2.1 in the pool on staging (held back), the OpenVolley APK published;
#   2. publish-pkgs.sh --point-hub 1.1.0 <Point Hub APK>: point-hub is listed by
#      APT at once (no hold-back, no latest.json), OpenVolley's hold stays, the
#      index is signed, the APK is in the F-Droid index under its app id, the
#      page has the Point Hub section, nothing was written to desktop/;
#   3. refused: an APK not signed with Point Hub's key, an APK without its F-Droid
#      metadata, a different .deb under a published version; a second run with
#      the same files changes nothing;
#   4. with Docker: a clean debian:trixie runs the published install.sh
#      (`sh -s point-hub`, served over HTTP from the scratch tree), point-hub
#      installs from the signed repo, every library of /opt/point-hub resolves,
#      and (a real .deb only) the app starts under Xvfb with Chromium's helpers.
#
#   escoresheet/deploy/tests/publish-point-hub.test.sh
#
# The APT key and the F-Droid repo key are made here. The kit is copied and the
# copy's APT key fingerprint (publish-pkgs.sh APT_SIGNER_FPR, install.sh FPR) is
# set to the throwaway key; everything else is the kit as committed, Android
# certificates included. Inputs (environment):
#   OV_TEST_OV_APK            an OpenVolley APK (the page needs one); default: the
#                             newest from get.openvolley.app (downloaded once)
#   OV_TEST_POINTHUB_APK      a ch.kscw.pointhub APK signed with Point Hub's
#                             release key (point-hub: android/dist/pointhub.apk)
#   OV_TEST_POINTHUB_BAD_APK  a ch.kscw.pointhub APK signed with another key
#                             (point-hub: the debug build, app-debug.apk)
#   OV_TEST_POINTHUB_DEB      a point-hub .deb (default: a small fake one; a real
#                             one is also started under Xvfb in step 4)
# Without the two Point Hub APKs their checks are skipped. Needs dpkg-dev,
# apt-utils, gpg, fdroidserver, rsync, the Android build-tools (ANDROID_HOME,
# default ~/Android/Sdk); Docker for step 4. Scratch files go to $TMPDIR.
set -euo pipefail
umask 022

REPO_KIT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
T=$(mktemp -d "${TMPDIR:-/tmp}/ov-publish-point-hub.XXXXXX")
CLI=ov-ph-apt-client-$$
SERVER_PID=
cleanup() {
  [[ -z "$SERVER_PID" ]] || kill "$SERVER_PID" 2>/dev/null || true
  docker rm -f "$CLI" >/dev/null 2>&1 || true
  gpgconf --homedir "$T/home/gnupg" --kill gpg-agent >/dev/null 2>&1 || true
  rm -rf "$T"
}
trap cleanup EXIT INT TERM

# Isolation first: no real key, no real tree, no GitHub, no sync target.
export OV_PKGS_HOME="$T/home" OV_PKGS_DEST="$T/dest/" OV_DESKTOP_KEYS="$T/no-desktop-keys"
export OV_BEACH_CERT_FILE="$T/no-beach-cert" OV_POINTHUB_RELEASE_DIR="$T/release"
export ANDROID_HOME=${ANDROID_HOME:-$HOME/Android/Sdk}
unset OV_DESKTOP_RELEASE_DIR GNUPGHOME
H=$OV_PKGS_HOME
PUB=$H/public
POOL=$PUB/apt/pool/main
FD=$H/fdroid

PASS=0
ok() { PASS=$((PASS + 1)); echo "ok   $*"; }
bad() { echo "FAIL $*" >&2; exit 1; }
skip() { echo "skip $*"; }
# expect_fail TEXT CMD...: CMD fails and its output contains TEXT.
expect_fail() {
  local want=$1 rc
  shift
  set +e
  "$@" > "$T/expect.out" 2>&1
  rc=$?
  set -e
  (( rc != 0 )) || bad "expected failure ($want): $*"
  grep -qF -- "$want" "$T/expect.out" || bad "expected \"$want\" from $*, got: $(tail -5 "$T/expect.out")"
  ok "refuses: $want"
}
for t in dpkg-deb dpkg-scanpackages apt-ftparchive gpg gpgv fdroid rsync python3 curl; do
  command -v "$t" >/dev/null || { echo "skip: $t not installed" >&2; exit 0; }
done

# --- inputs -------------------------------------------------------------------------
mkdir -p "$T/in" "$T/release"
OV_APK=${OV_TEST_OV_APK:-}
if [[ -z "$OV_APK" ]]; then
  name=$(curl -fsSL https://get.openvolley.app/fdroid/repo/index-v2.json | python3 -I -c '
import json, sys
p = json.load(sys.stdin)["packages"]["com.openvolley.escoresheet"]["versions"].values()
print(max(p, key=lambda v: v["manifest"]["versionCode"])["file"]["name"].lstrip("/"))') ||
    bad "no OV_TEST_OV_APK and get.openvolley.app cannot be read"
  curl -fsSL -o "$T/in/$name" "https://get.openvolley.app/fdroid/repo/$name"
  OV_APK="$T/in/$name"
fi
PH_APK=${OV_TEST_POINTHUB_APK:-}
PH_BAD_APK=${OV_TEST_POINTHUB_BAD_APK:-}
PH_DEB_IN=${OV_TEST_POINTHUB_DEB:-}
PH_V=1.1.0
REAL_DEB=0
if [[ -n "$PH_DEB_IN" ]]; then
  PH_V=$(dpkg-deb -f "$PH_DEB_IN" Version)
  cp "$PH_DEB_IN" "$T/release/point-hub_${PH_V}_amd64.deb"
  REAL_DEB=1
else
  # A fake laid out like jpackage's (and with point-hub CI's /usr/bin symlink).
  r="$T/phroot"
  mkdir -p "$r/DEBIAN" "$r/opt/point-hub/bin" "$r/usr/bin"
  printf 'Package: point-hub\nVersion: %s\nArchitecture: amd64\nMaintainer: test <test@example.invalid>\nDescription: test package\n' "$PH_V" > "$r/DEBIAN/control"
  printf '#!/bin/sh\necho point-hub\n' > "$r/opt/point-hub/bin/point-hub"
  chmod 755 "$r/opt/point-hub/bin/point-hub"
  ln -s /opt/point-hub/bin/point-hub "$r/usr/bin/point-hub"
  dpkg-deb --root-owner-group -b "$r" "$T/release/point-hub_${PH_V}_amd64.deb" >/dev/null
fi
PH_DEB="$T/release/point-hub_${PH_V}_amd64.deb"
apk_badging() { "$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)/aapt2" dump badging "$1" | sed -n '/^package:/p'; }
if [[ -n "$PH_APK" ]]; then
  PH_CODE=$(apk_badging "$PH_APK" | sed -E "s/.*versionCode='([0-9]+)'.*/\1/")
  PH_NAME=$(apk_badging "$PH_APK" | sed -E "s/.*versionName='([^']+)'.*/\1/")
fi
# make_ov_deb OUT VERSION: a stand-in OpenVolley .deb (only its index entry matters here)
make_ov_deb() {
  local r="$T/ovroot"
  rm -rf "$r"; mkdir -p "$r/DEBIAN" "$r/usr/bin"
  printf 'Package: openvolley-escoresheet\nVersion: %s\nArchitecture: amd64\nMaintainer: test <test@example.invalid>\nDescription: test package\n' "$2" > "$r/DEBIAN/control"
  printf '#!/bin/sh\n' > "$r/usr/bin/openvolley-escoresheet"; chmod 755 "$r/usr/bin/openvolley-escoresheet"
  dpkg-deb --root-owner-group -b "$r" "$1" >/dev/null
}

# --- throwaway keys and the kit copy --------------------------------------------------
mkdir -p "$H" && chmod 700 "$H"
install -d -m 700 "$H/gnupg"
head -c 24 /dev/urandom | base64 > "$H/gpg-passphrase"; chmod 600 "$H/gpg-passphrase"
gpg --homedir "$H/gnupg" --batch --pinentry-mode loopback --passphrase-file "$H/gpg-passphrase" \
  --quick-generate-key "Throwaway APT test key <test@example.invalid>" ed25519 sign never 2>/dev/null
FPR=$(gpg --homedir "$H/gnupg" --batch --with-colons --list-secret-keys 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }')
[[ "$FPR" =~ ^[0-9A-F]{40}$ && "$FPR" != AB469DA8DC3EC90F8057320D285B18D76C16B82C ]] || bad "throwaway APT key"
mkdir -p "$FD"
(cd "$FD" && fdroid init -q --keystore "$FD/keystore.p12" --repo-keyalias throwaway \
  --distinguished-name "CN=throwaway test, OU=F-Droid" > "$T/fdroid-init.log" 2>&1) || { cat "$T/fdroid-init.log"; bad "fdroid init"; }
[[ -f "$FD/config.yml" && -f "$FD/keystore.p12" ]] || bad "fdroid init made no config.yml / keystore.p12"
mkdir -p "$FD/metadata"
printf 'Categories:\n  - Sports & Health\nLicense: GPL-3.0-or-later\nName: OpenVolley eScoresheet\nSummary: test\n' > "$FD/metadata/com.openvolley.escoresheet.yml"
cp "$REPO_KIT/fdroid-metadata/ch.kscw.pointhub.yml" "$FD/metadata/"
mkdir -p "$T/kit/escoresheet"
cp -r "$REPO_KIT" "$T/kit/escoresheet/deploy"
KIT="$T/kit/escoresheet/deploy"
sed -i "s/^APT_SIGNER_FPR=.*/APT_SIGNER_FPR=$FPR/" "$KIT/publish-pkgs.sh"
sed -i "s/^FPR=.*/FPR=$FPR/" "$KIT/pkgs/install.sh"
grep -q "^APT_SIGNER_FPR=$FPR$" "$KIT/publish-pkgs.sh" && grep -q "^FPR=$FPR$" "$KIT/pkgs/install.sh" || bad "kit copy: key fingerprint not set"
cmp -s "$KIT/lib/publish-lib.sh" "$REPO_KIT/lib/publish-lib.sh" || bad "kit copy: the library must be the committed one"
ok "throwaway APT key $FPR and F-Droid repo key; kit copy differs only in that fingerprint"
pp() { "$KIT/publish-pkgs.sh" --no-sync "$@"; }

# --- 1. production-like state ---------------------------------------------------------
mkdir -p "$POOL" "$PUB/desktop"
make_ov_deb "$T/in/openvolley-escoresheet_2.2.0_amd64.deb" 2.2.0
python3 -I -c 'import json, sys; json.dump({"version": "2.2.0", "notes": "", "pub_date": "2026-10-01T00:00:00Z", "platforms": {}}, open(sys.argv[1], "w"))' "$PUB/desktop/latest.json"
cp -a "$PUB/desktop" "$T/desktop-before"
pp "$T/in/openvolley-escoresheet_2.2.0_amd64.deb" "$OV_APK" > "$T/run0.log" 2>&1 || { cat "$T/run0.log"; bad "run 0 (OpenVolley only)"; }
make_ov_deb "$POOL/openvolley-escoresheet_2.2.1_amd64.deb" 2.2.1   # a --staging release's .deb
if grep -q 'id="point-hub"' "$PUB/index.html"; then bad "page: Point Hub section before anything of it is published"; fi
ok "run 0: OpenVolley 2.2.0 + APK published, 2.2.1 waiting on staging; no Point Hub section yet"

# --- 2. publish Point Hub ----------------------------------------------------------------
args=(--point-hub "$PH_V")
[[ -z "$PH_APK" ]] || args+=("$PH_APK")
pp "${args[@]}" > "$T/run1.log" 2>&1 || { cat "$T/run1.log"; bad "run 1 (--point-hub $PH_V)"; }
P=$PUB/apt/dists/stable/main/binary-amd64/Packages
listed() { awk -v want="$1" '/^Package:/ { p = $2 } /^Version:/ && p == want { print $2 }' "$P" | sort -V | xargs; }
[[ "$(listed point-hub)" == "$PH_V" ]] || bad "APT: point-hub not listed: $(listed point-hub)"
[[ "$(listed openvolley-escoresheet)" == 2.2.0 ]] || bad "APT: OpenVolley's hold-back changed: $(listed openvolley-escoresheet)"
grep -q 'held back from APT: openvolley-escoresheet 2.2.1 (desktop/latest.json announces 2.2.0)' "$T/run1.log" || bad "the run did not report OpenVolley's hold"
if grep -q 'held back from APT: point-hub' "$T/run1.log"; then bad "point-hub was held back"; fi
cmp -s "$PH_DEB" "$POOL/point-hub_${PH_V}_amd64.deb" || bad "the pool's point-hub .deb is not the release's"
gpgv --keyring "$PUB/apt/openvolley.gpg" "$PUB/apt/dists/stable/InRelease" 2>/dev/null &&
  gpgv --keyring "$PUB/apt/openvolley.gpg" "$PUB/apt/dists/stable/Release.gpg" "$PUB/apt/dists/stable/Release" 2>/dev/null ||
  bad "APT index signatures"
grep -q "  apt     Package: point-hub	Version: $PH_V" "$T/run1.log" || bad "summary: no point-hub line"
ok "APT: point-hub $PH_V listed at once (no hold-back), OpenVolley 2.2.1 still held, index signed, pool file = release file"
diff -r "$T/desktop-before" "$PUB/desktop" >/dev/null || bad "desktop/ changed: a Point Hub run must write no updater manifest"
[[ ! -e "$T/release/point-hub_${PH_V}_amd64.deb.sig" ]] || bad "the Point Hub .deb was signed"
ok "no updater manifest and no .sig for Point Hub (desktop/ untouched)"
grep -q "^FPR=$FPR$" "$PUB/install.sh" && cmp -s "$PUB/install.sh" "$KIT/pkgs/install.sh" || bad "install.sh not published"
grep -q 'sudo sh -s point-hub</code>' "$PUB/index.html" &&
  grep -q "releases/download/desktop-v$PH_V/point-hub-$PH_V.msi" "$PUB/index.html" || bad "page: no Point Hub desktop part"
if grep -q '@[A-Z_]*@' "$PUB/index.html"; then bad "page: placeholders left"; fi
ok "install page: the Point Hub section with its desktop part; install.sh published"
if [[ -n "$PH_APK" ]]; then
  python3 -I - "$FD/repo/index-v2.json" "$PH_CODE" "$PH_NAME" <<'PY' || bad "F-Droid: ch.kscw.pointhub not in the index"
import json, sys
d = json.load(open(sys.argv[1]))
v = d["packages"]["ch.kscw.pointhub"]["versions"].values()
assert any(x["manifest"]["versionCode"] == int(sys.argv[2]) and x["manifest"]["versionName"] == sys.argv[3]
           and x["file"]["name"] == f"/ch.kscw.pointhub_{sys.argv[2]}.apk" for x in v), list(v)
assert "com.openvolley.escoresheet" in d["packages"]
PY
  [[ -f "$PUB/fdroid/repo/ch.kscw.pointhub_$PH_CODE.apk" ]] || bad "F-Droid: the APK is not in the public tree"
  grep -q "href=\"/fdroid/repo/ch.kscw.pointhub_$PH_CODE.apk\"" "$PUB/index.html" || bad "page: no Point Hub APK link"
  grep -q "  fdroid  ch.kscw.pointhub $PH_NAME ($PH_CODE)" "$T/run1.log" || bad "summary: no ch.kscw.pointhub line"
  ok "F-Droid: ch.kscw.pointhub $PH_NAME ($PH_CODE) in the signed index, accepted by its committed certificate; page links it"
else
  skip "F-Droid acceptance of a Point Hub APK (no OV_TEST_POINTHUB_APK)"
fi

# --- 3. refusals and a repeat run -----------------------------------------------------------
if [[ -n "$PH_BAD_APK" ]]; then
  expect_fail "ch.kscw.pointhub is not signed with its app key" pp "$PH_BAD_APK"
else
  skip "wrong-key refusal (no OV_TEST_POINTHUB_BAD_APK)"
fi
if [[ -n "$PH_APK" ]]; then
  mv "$FD/metadata/ch.kscw.pointhub.yml" "$T/ph-meta.yml"
  rm "$FD/repo/ch.kscw.pointhub_$PH_CODE.apk"
  expect_fail "no F-Droid metadata $FD/metadata/ch.kscw.pointhub.yml (fdroid update would leave ch.kscw.pointhub out of the index); copy" pp "$PH_APK"
  [[ ! -e "$FD/repo/ch.kscw.pointhub_$PH_CODE.apk" ]] || bad "the refused APK reached the repo"
  mv "$T/ph-meta.yml" "$FD/metadata/ch.kscw.pointhub.yml"
  cp "$PH_APK" "$FD/repo/ch.kscw.pointhub_$PH_CODE.apk"
fi
# the same version with one more file (gzip -1: only the bytes matter)
r="$T/otherroot"; rm -rf "$r"; dpkg-deb -R "$PH_DEB" "$r"; echo changed > "$r/opt/point-hub/changed.txt"
mkdir -p "$T/rel-other"; dpkg-deb --root-owner-group -Zgzip -z1 -b "$r" "$T/rel-other/point-hub_${PH_V}_amd64.deb" >/dev/null
rm -rf "$r"
expect_fail "point-hub_${PH_V}_amd64.deb exists with different content; bump the version instead" \
  env OV_POINTHUB_RELEASE_DIR="$T/rel-other" "$KIT/publish-pkgs.sh" --no-sync --point-hub "$PH_V"
sha_before=$(cd "$PUB" && find apt/pool fdroid/repo -type f -name '*.deb' -o -type f -name '*.apk' | sort | xargs sha256sum)
pp "${args[@]}" > "$T/run2.log" 2>&1 || { cat "$T/run2.log"; bad "run 2 (the same again)"; }
[[ "$(cd "$PUB" && find apt/pool fdroid/repo -type f -name '*.deb' -o -type f -name '*.apk' | sort | xargs sha256sum)" == "$sha_before" ]] ||
  bad "a repeat run changed the published packages"
[[ "$(listed point-hub)|$(listed openvolley-escoresheet)" == "$PH_V|2.2.0" ]] || bad "a repeat run changed the index"
ok "a repeat run with the same files publishes the same packages"

# --- 4. a clean Debian installs it with the published install.sh ------------------------------
if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  port=$(python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
  python3 -I -m http.server "$port" --bind 127.0.0.1 --directory "$PUB" > "$T/http.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 20); do curl -fs -o /dev/null "http://127.0.0.1:$port/install.sh" && break; sleep 0.3; done
  # (Chromium wants more than Docker's default 64 MB /dev/shm)
  docker run -d --name "$CLI" --network host --shm-size=512m debian:trixie sleep infinity >/dev/null
  # A desktop system, as Point Hub's users have: jpackage's postinst runs
  # `xdg-desktop-menu install`, which exits 3 ("No writable system menu
  # directory found") unless /usr/share/applications and
  # /usr/share/desktop-directories exist (a desktop environment's menu
  # packages make them; a bare debian image has neither, and the package then
  # fails to configure).
  docker exec "$CLI" mkdir -p /usr/share/applications /usr/share/desktop-directories
  docker exec -e OV_PKGS_BASE="http://127.0.0.1:$port" "$CLI" sh -c \
    "apt-get update -qq >/dev/null && apt-get install -y -qq curl ca-certificates gpg >/dev/null && curl -fsSL \$OV_PKGS_BASE/install.sh | sh -s point-hub" \
    > "$T/install.log" 2>&1 || { tail -30 "$T/install.log"; bad "install.sh point-hub in debian:trixie"; }
  grep -q "key fingerprint verified: $FPR" "$T/install.log" && grep -q "^Point Hub $PH_V is installed.$" "$T/install.log" ||
    { tail -20 "$T/install.log"; bad "install.sh output"; }
  if grep -q 'server-only\|Connect tablets' "$T/install.log"; then bad "install.sh: OpenVolley's tablet-server hints for Point Hub"; fi
  [[ "$(docker exec "$CLI" dpkg-query -W -f '${Version}' point-hub)" == "$PH_V" ]] || bad "dpkg: point-hub $PH_V not installed"
  [[ "$(docker exec "$CLI" readlink -f /usr/bin/point-hub)" == /opt/point-hub/bin/point-hub ]] || bad "/usr/bin/point-hub does not resolve"
  ok "debian:trixie: install.sh -s point-hub checked the key, added the repo and installed point-hub $PH_V"
  if (( REAL_DEB )); then
    # The bundle's own libraries (libjvm.so, libjawt.so, libcef.so ...) are found
    # at run time by the JVM and JCEF, not through an rpath: give ldd their
    # directories, so only system libraries can be "not found".
    missing=$(docker exec "$CLI" sh -c 'LD_LIBRARY_PATH=$(find /opt/point-hub -name "*.so*" -printf "%h\n" | sort -u | paste -sd:); export LD_LIBRARY_PATH
      find /opt/point-hub -type f \( -name "*.so*" -o -perm -u+x \) | while read -r f; do
      head -c 4 "$f" | grep -q ELF || continue; ldd "$f" 2>/dev/null | grep "not found" | sed "s|^|$f: |"; done | sort -u' || true)
    [[ -z "$missing" ]] || { echo "$missing" | head -20; bad "libraries missing after apt install"; }
    ok "every ELF file of /opt/point-hub finds its libraries (the .deb's Depends are complete)"
    docker exec -e DEBIAN_FRONTEND=noninteractive "$CLI" sh -c 'apt-get install -y -qq xvfb xauth dbus procps >/dev/null && useradd -m scorer' >/dev/null 2>&1
    docker exec -d "$CLI" su scorer -c 'cd ~ && dbus-run-session -- xvfb-run -a -s "-screen 0 1280x800x24" point-hub > /tmp/ph.log 2>&1'
    up=0
    for _ in $(seq 40); do
      sleep 1
      if docker exec "$CLI" pgrep -f jcef_helper >/dev/null; then up=1; break; fi
    done
    sleep 5
    docker exec "$CLI" pgrep -u scorer -f /opt/point-hub >/dev/null || { docker exec "$CLI" cat /tmp/ph.log | tail -30; bad "point-hub is not running"; }
    (( up )) || { docker exec "$CLI" cat /tmp/ph.log | tail -30; bad "Chromium (jcef_helper) did not start"; }
    if docker exec "$CLI" sh -c 'ls /home/scorer/hs_err_pid*.log 2>/dev/null | grep -q .'; then bad "the JVM crashed (hs_err file)"; fi
    docker exec "$CLI" test -d /home/scorer/.config/point-hub && docker exec "$CLI" test -d /home/scorer/.local/share/point-hub/browser ||
      bad "no settings / Chromium cache under XDG_CONFIG_HOME / XDG_DATA_HOME"
    ok "point-hub starts under Xvfb from the APT install: Chromium's helpers run, settings and cache in ~/.config/point-hub and ~/.local/share/point-hub"
  else
    skip "library and start checks (a fake .deb; OV_TEST_POINTHUB_DEB=<real .deb> runs them)"
  fi
else
  skip "Debian install from the published repo (no docker)"
fi

echo "all $PASS checks passed (throwaway APT key $FPR)"
