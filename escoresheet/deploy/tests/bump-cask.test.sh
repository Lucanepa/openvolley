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
OV_CASK_DMG="$T/bad.dmg" expect_fail "is not a disk image" bump 2.4.2 "$T/tap"
grep -qx '  version "2.4.1"' "$C" || bad "a refused bump changed the cask"
expect_fail "not a version like 2.4.0" bump 2.4 "$T/tap"
expect_fail "no such directory" bump 2.4.2 "$T/nope"
expect_fail "--app volley: expected openvolley or beach" bump --app volley 2.4.2 "$T/tap"
expect_fail "usage: bump-cask.sh" bump 2.4.2
echo "all $PASS checks passed"
