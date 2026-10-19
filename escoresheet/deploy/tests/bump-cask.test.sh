#!/usr/bin/env bash
# Offline tests for homebrew/bump-cask.sh: the casks it writes into a tap
# checkout, and what it refuses. Never downloads (OV_CASK_DMG), never pushes.
#
#   escoresheet/deploy/tests/bump-cask.test.sh
set -euo pipefail
KIT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
T=$(mktemp -d "${TMPDIR:-/tmp}/ov-bump-cask.XXXXXX")
trap 'rm -rf "$T"' EXIT
PASS=0
ok() { PASS=$((PASS + 1)); echo "ok   $*"; }
bad() { echo "FAIL $*" >&2; exit 1; }
expect_fail() {
  local want=$1 rc out
  shift
  set +e; "$@" > "$T/out" 2>&1; rc=$?; set -e
  out=$(<"$T/out")
  (( rc != 0 )) || bad "expected failure ($want): $*"
  [[ "$out" == *"$want"* ]] || bad "expected \"$want\" from $*, got: $out"
  ok "refuses: $want"
}
bump() { "$KIT_DIR/homebrew/bump-cask.sh" "$@"; }

# a fake UDIF image: data, then the 512-byte trailer starting with "koly"
{ head -c 100000 /dev/urandom; printf 'koly'; head -c 508 /dev/zero; } > "$T/app.dmg"
SHA=$(sha256sum "$T/app.dmg" | awk '{print $1}')
mkdir -p "$T/tap"
export OV_CASK_DMG="$T/app.dmg"

bump 2.4.0 "$T/tap" > /dev/null
C="$T/tap/Casks/openvolley.rb"
grep -qx '  version "2.4.0"' "$C" && grep -qx "  sha256 \"$SHA\"" "$C" || bad "openvolley: version / sha256"
grep -qF 'releases/download/desktop-v#{version}/OpenVolley.eScoresheet_#{version}_universal.dmg' "$C" || bad "openvolley: url"
grep -qx '  app "OpenVolley eScoresheet.app"' "$C" && grep -qx '  auto_updates true' "$C" || bad "openvolley: app / auto_updates"
grep -qF 'url "https://get.openvolley.app/desktop/latest.json"' "$C" || bad "openvolley: livecheck"
head -n1 "$C" | grep -qx 'cask "openvolley" do' || bad "openvolley: the template comment must not reach the tap"
! grep -q '@[A-Z0-9_]*@' "$C" || bad "openvolley: placeholders left"
! grep -qF 'Application Support/OpenVolley"' "$C" || bad "openvolley: zap must keep the match backups"
ok "openvolley.rb: version, sha256, url, app, livecheck, backups kept"

bump --app beach v2.1.0 "$T/tap" > /dev/null
B="$T/tap/Casks/openbeach.rb"
grep -qx '  version "2.1.0"' "$B" && grep -qx "  sha256 \"$SHA\"" "$B" || bad "openbeach: version / sha256"
grep -qF 'releases/download/beach-desktop-v#{version}/OpenBeach_#{version}_universal.dmg' "$B" || bad "openbeach: url"
grep -qx '  app "OpenBeach.app"' "$B" && grep -qF 'desktop/beach/latest.json' "$B" || bad "openbeach: app / livecheck"
grep -qx '  version "2.4.0"' "$C" || bad "bumping openbeach touched openvolley.rb"
ok "openbeach.rb: its own release, dmg, app and livecheck; openvolley.rb untouched"

bump 2.4.1 "$T/tap" > /dev/null
grep -qx '  version "2.4.1"' "$C" && [[ $(grep -c '^  version ' "$C") == 1 ]] || bad "bump: version not replaced"
ok "a bump rewrites the cask for the new version"

printf 'not a disk image' > "$T/bad.dmg"
# Point Hub: two images (arm64, x64), one sha256 each, the bundle's name from
# the images (here OV_CASK_APP_INFO stands in for their Info.plist)
{ head -c 100000 /dev/urandom; printf 'koly'; head -c 508 /dev/zero; } > "$T/x64.dmg"
SHA_X64=$(sha256sum "$T/x64.dmg" | awk '{print $1}')
OV_CASK_DMG_ARM64="$T/app.dmg" OV_CASK_DMG_X64="$T/x64.dmg" OV_CASK_APP_INFO="point-hub.app|ch.kscw.pointhub|1.1.0" \
  bump --app point-hub 1.1.0 "$T/tap" > /dev/null
P="$T/tap/Casks/point-hub.rb"
head -n1 "$P" | grep -qx 'cask "point-hub" do' || bad "point-hub: the template comment must not reach the tap"
grep -qx '  version "1.1.0"' "$P" && grep -qx "  sha256 arm:   \"$SHA\"," "$P" && grep -qx "         intel: \"$SHA_X64\"" "$P" ||
  bad "point-hub: version / per-architecture sha256"
grep -qF 'url "https://github.com/Lucanepa/point-hub/releases/download/desktop-v#{version}/Point-Hub-#{version}-macos-#{arch}.dmg",' "$P" &&
  grep -qx '  arch arm: "arm64", intel: "x64"' "$P" || bad "point-hub: url / arch"
grep -qx '  app "point-hub.app"' "$P" && grep -qF 'xattr -dr com.apple.quarantine "/Applications/point-hub.app"' "$P" || bad "point-hub: app name from the image"
! grep -qE '^ *auto_updates' "$P" || bad "point-hub: no auto_updates (no updater)"
! grep -qF 'Application Support/Point Hub"' "$P" || bad "point-hub: zap must keep the settings and backups"
! grep -q '@[A-Z0-9_]*@' "$P" || bad "point-hub: placeholders left"
grep -qx '  version "2.4.1"' "$C" || bad "bumping point-hub touched openvolley.rb"
ok "point-hub.rb: its own release, both images' sha256, the bundle name from the images, no auto_updates"
OV_CASK_APP_INFO="Point Hub.app|ch.kscw.pointhub|1.1.0" OV_CASK_DMG="$T/app.dmg" bump --app point-hub 1.1.0 "$T/tap" > /dev/null
grep -qx '  app "Point Hub.app"' "$P" || bad "point-hub: a bundle name with a space"
ok "point-hub.rb: a bundle name with a space (Point Hub.app) is taken as it is"
OV_CASK_APP_INFO="point-hub.app|ch.kscw.other|1.1.0" OV_CASK_DMG="$T/app.dmg" expect_fail "expected <Name>.app ch.kscw.pointhub 1.1.0" bump --app point-hub 1.1.0 "$T/tap"
OV_CASK_APP_INFO="point-hub.app|ch.kscw.pointhub|1.0.9" OV_CASK_DMG="$T/app.dmg" expect_fail "the bundle is 'point-hub.app|ch.kscw.pointhub|1.0.9'" bump --app point-hub 1.1.0 "$T/tap"
OV_CASK_APP_INFO="point-hub.app|ch.kscw.pointhub|1.1.0" OV_CASK_DMG_ARM64="$T/app.dmg" OV_CASK_DMG_X64="$T/bad.dmg" \
  expect_fail "Point-Hub-1.1.0-macos-x64.dmg is not a disk image" bump --app point-hub 1.1.0 "$T/tap"
grep -qx '  app "Point Hub.app"' "$P" || bad "a refused point-hub bump changed the cask"
# a real image (OV_TEST_POINTHUB_DMG, e.g. point-hub's CI artifact): the name read with 7z
if [[ -n "${OV_TEST_POINTHUB_DMG:-}" ]] && command -v 7z >/dev/null; then
  OV_CASK_DMG="$OV_TEST_POINTHUB_DMG" bump --app point-hub "$(7z e -so "$OV_TEST_POINTHUB_DMG" "$(7z l -slt -ba "$OV_TEST_POINTHUB_DMG" | sed -n 's/^Path = //p' | grep -E '^[^/]+/[^/]+\.app/Contents/Info\.plist$')" 2>/dev/null |
    python3 -c 'import plistlib, sys; print(plistlib.loads(sys.stdin.buffer.read())["CFBundleShortVersionString"])')" "$T/tap" > "$T/real.out"
  grep -q '^wrote .*: point-hub [0-9.]*, [^,]*\.app, sha256' "$T/real.out" || bad "point-hub with a real image: $(cat "$T/real.out")"
  ok "point-hub.rb from a real disk image: $(sed -n 's/^wrote [^:]*: //p' "$T/real.out" | cut -d, -f1-2)"
fi

OV_CASK_DMG="$T/bad.dmg" expect_fail "is not a disk image" bump 2.4.2 "$T/tap"
grep -qx '  version "2.4.1"' "$C" || bad "a refused bump changed the cask"
expect_fail "not a version like 2.4.0" bump 2.4 "$T/tap"
expect_fail "no such directory" bump 2.4.2 "$T/nope"
expect_fail "--app volley: expected openvolley, beach or point-hub" bump --app volley 2.4.2 "$T/tap"
expect_fail "usage: bump-cask.sh" bump 2.4.2
echo "all $PASS checks passed"
