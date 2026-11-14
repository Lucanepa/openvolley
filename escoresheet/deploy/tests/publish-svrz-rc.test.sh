#!/usr/bin/env bash
# End-to-end test of publish-pkgs.sh with svrz-rc (SVRZ Referee Coaching), with
# THROWAWAY keys, into a scratch OV_PKGS_HOME, --no-sync, never GitHub:
#   1. a production-like state: OpenVolley 2.2.0 announced by desktop/latest.json,
#      2.2.1 in the pool on staging (held back), the OpenVolley APK published;
#   2. publish-pkgs.sh SVRZ.RC_V_amd64.deb (as the release names it, with the
#      .sig its release build made; a throwaway svrz-rc key here): svrz-rc
#      is listed by APT at once (no hold-back, no latest.json), OpenVolley's hold
#      stays, the index is signed and expires (Valid-Until), nothing is
#      written to desktop/, install.sh offers svrz-rc;
#   3. refused: the .deb without its .sig or with another key's, a different
#      .deb under a published version, a .deb without /usr/bin/svrz-rc; a
#      second run with the same .deb changes nothing;
#   4. --resign (the weekly timer): signs the same index again with a new
#      Valid-Until and syncs apt/dists/ only; refuses with a dirty checkout,
#      a HEAD not on the reviewed ref, a pool that would change the index,
#      or anything to publish; pushes up / down to a (stubbed) Kuma URL.
#
#   escoresheet/deploy/tests/publish-svrz-rc.test.sh
#
# Inputs (environment):
#   OV_TEST_OV_APK    an OpenVolley APK (the page needs one); default: the newest
#                     from get.openvolley.app (downloaded once)
#   OV_TEST_SVRZ_DEB  a real svrz-rc .deb (default: a small fake one)
# Needs dpkg-dev, apt-utils, gpg, fdroidserver, rsync, node, tauri-cli
# (OV_TAURI_CLI, default escoresheet/frontend/node_modules/.bin/tauri) and the
# Android build-tools (ANDROID_HOME, default ~/Android/Sdk). Scratch files go
# to $TMPDIR.
set -euo pipefail
umask 022

REPO_KIT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
T=$(mktemp -d "${TMPDIR:-/tmp}/ov-publish-svrz-rc.XXXXXX")
CLI=ov-svrz-apt-client-$$
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
export OV_BEACH_CERT_FILE="$T/no-beach-cert"
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
for t in dpkg-deb dpkg-scanpackages apt-ftparchive gpg gpgv fdroid rsync python3 curl node; do
  command -v "$t" >/dev/null || { echo "skip: $t not installed" >&2; exit 0; }
done
TAURI=${OV_TAURI_CLI:-$REPO_KIT/../frontend/node_modules/.bin/tauri}
[[ -x "$TAURI" ]] || { echo "skip: no tauri CLI at $TAURI" >&2; exit 0; }

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
SV_DEB_IN=${OV_TEST_SVRZ_DEB:-}
SV_V=1.4.3
# The release names its .deb "SVRZ.RC_V_amd64.deb"; the pool goes by the package.
if [[ -n "$SV_DEB_IN" ]]; then
  SV_V=$(dpkg-deb -f "$SV_DEB_IN" Version)
  cp "$SV_DEB_IN" "$T/release/SVRZ.RC_${SV_V}_amd64.deb"
else
  # A fake laid out like Tauri's .deb: the binary in /usr/bin under the package's name.
  r="$T/svroot"
  mkdir -p "$r/DEBIAN" "$r/usr/bin"
  printf 'Package: svrz-rc\nVersion: %s\nArchitecture: amd64\nMaintainer: test <test@example.invalid>\nDescription: test package\n' "$SV_V" > "$r/DEBIAN/control"
  printf '#!/bin/sh\necho svrz-rc\n' > "$r/usr/bin/svrz-rc"; chmod 755 "$r/usr/bin/svrz-rc"
  dpkg-deb --root-owner-group -b "$r" "$T/release/SVRZ.RC_${SV_V}_amd64.deb" >/dev/null
fi
SV_DEB="$T/release/SVRZ.RC_${SV_V}_amd64.deb"
# The svrz-rc release build signs its .deb with that project's updater key
# (the Tauri bundler: no version in the signature). A throwaway one here.
"$TAURI" signer generate --ci -p sv -w "$T/svrz.key" </dev/null >/dev/null 2>&1
"$TAURI" signer generate --ci -p ot -w "$T/other.key" </dev/null >/dev/null 2>&1
export OV_SVRZ_RC_PUBKEY
OV_SVRZ_RC_PUBKEY=$(tr -d '\n' < "$T/svrz.key.pub")
# svrz_sign FILE [KEY PASSWORD]
svrz_sign() {
  TAURI_SIGNING_PRIVATE_KEY_PATH="${2:-$T/svrz.key}" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${3:-sv}" \
    "$TAURI" signer sign "$1" </dev/null >/dev/null 2>&1
}
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
mkdir -p "$T/kit/escoresheet"
cp -r "$REPO_KIT" "$T/kit/escoresheet/deploy"
cp "$REPO_KIT/../../README.md" "$T/kit/README.md"
KIT="$T/kit/escoresheet/deploy"
sed -i "s/^APT_SIGNER_FPR=.*/APT_SIGNER_FPR=$FPR/" "$KIT/publish-pkgs.sh"
sed -i "s/^FPR=.*/FPR=$FPR/" "$KIT/pkgs/install.sh"
# (its README line follows the changed script)
sed -i "s/^install\.sh SHA-256: .*/install.sh SHA-256: \`$(sha256sum "$KIT/pkgs/install.sh" | cut -d' ' -f1)\`/" "$T/kit/README.md"
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
ok "run 0: OpenVolley 2.2.0 + APK published, 2.2.1 waiting on staging"

# --- 2. publish svrz-rc, its .deb given by hand ---------------------------------------
cp -a "$PUB/desktop" "$T/desktop-before-svrz"
expect_fail "no SVRZ.RC_${SV_V}_amd64.deb.sig next to it" pp "$SV_DEB"
svrz_sign "$SV_DEB" "$T/other.key" ot
expect_fail "its .sig does not verify against the svrz-rc updater key" pp "$SV_DEB"
[[ ! -e "$POOL/svrz-rc_${SV_V}_amd64.deb" ]] || bad "an svrz-rc .deb without its own release signature reached the pool"
svrz_sign "$SV_DEB"
cp "$SV_DEB.sig" "$T/sv.sig"
pp "$SV_DEB" > "$T/run1.log" 2>&1 || { cat "$T/run1.log"; bad "run 1 (svrz-rc $SV_V by hand)"; }
P=$PUB/apt/dists/stable/main/binary-amd64/Packages
listed() { awk -v want="$1" '/^Package:/ { p = $2 } /^Version:/ && p == want { print $2 }' "$P" | sort -V | xargs; }
[[ "$(listed svrz-rc)" == "$SV_V" ]] || bad "APT: svrz-rc not listed: $(listed svrz-rc)"
[[ "$(listed openvolley-escoresheet)" == 2.2.0 ]] || bad "APT: OpenVolley's hold-back changed: $(listed openvolley-escoresheet)"
grep -q 'held back from APT: openvolley-escoresheet 2.2.1 (desktop/latest.json announces 2.2.0)' "$T/run1.log" || bad "the run did not report OpenVolley's hold"
if grep -q 'held back from APT: svrz-rc' "$T/run1.log"; then bad "svrz-rc was held back"; fi
cmp -s "$SV_DEB" "$POOL/svrz-rc_${SV_V}_amd64.deb" || bad "the pool's svrz-rc .deb is not the given one"
gpgv --keyring "$PUB/apt/openvolley.gpg" "$PUB/apt/dists/stable/InRelease" 2>/dev/null &&
  gpgv --keyring "$PUB/apt/openvolley.gpg" "$PUB/apt/dists/stable/Release.gpg" "$PUB/apt/dists/stable/Release" 2>/dev/null ||
  bad "APT index signatures"
grep -q "  apt     Package: svrz-rc	Version: $SV_V" "$T/run1.log" || bad "summary: no svrz-rc line"
grep -q 'svrz-rc '"$SV_V"': signature by the svrz-rc release key verifies' "$T/run1.log" || bad "the run did not check svrz-rc's signature"
ok "APT: svrz-rc $SV_V listed at once (no hold-back), OpenVolley 2.2.1 still held, index signed, pool file = the given .deb"
vu=$(sed -n 's/^Valid-Until: //p' "$PUB/apt/dists/stable/Release")
left=$(( $(date -d "$vu" +%s) - $(date +%s) ))
(( left > 29 * 86400 && left <= 30 * 86400 )) || bad "Release Valid-Until: $vu"
grep -q "^Valid-Until: $vu$" "$PUB/apt/dists/stable/InRelease" || bad "InRelease has no Valid-Until"
ok "APT: the signed Release expires in 30 days ($vu)"
diff -r "$T/desktop-before-svrz" "$PUB/desktop" >/dev/null || bad "desktop/ changed: an svrz-rc run must write no updater manifest"
cmp -s "$SV_DEB.sig" "$T/sv.sig" || bad "the svrz-rc .deb was signed here"
if find "$PUB" -name '*svrz*.sig' | grep -q .; then bad "an svrz-rc .sig in the public tree"; fi
ok "no updater manifest and no .sig of ours for svrz-rc (desktop/ untouched)"
grep -q '^PACKAGES=".* svrz-rc"$' "$PUB/install.sh" || bad "install.sh: svrz-rc is not one of its packages"
ok "install.sh offers svrz-rc"

# --- 3. refusals and a repeat ----------------------------------------------------------
r="$T/svroot-other"
mkdir -p "$r/DEBIAN" "$r/usr/bin"
printf 'Package: svrz-rc\nVersion: %s\nArchitecture: amd64\nMaintainer: test <test@example.invalid>\nDescription: another build\n' "$SV_V" > "$r/DEBIAN/control"
printf '#!/bin/sh\necho other\n' > "$r/usr/bin/svrz-rc"; chmod 755 "$r/usr/bin/svrz-rc"
dpkg-deb --root-owner-group -b "$r" "$T/in/svrz-rc-other.deb" >/dev/null
svrz_sign "$T/in/svrz-rc-other.deb"
expect_fail "exists with different content; bump the version instead" pp "$T/in/svrz-rc-other.deb"
r="$T/svroot-nobin"
mkdir -p "$r/DEBIAN" "$r/opt/svrz"
printf 'Package: svrz-rc\nVersion: 9.9.9\nArchitecture: amd64\nMaintainer: test <test@example.invalid>\nDescription: no command\n' > "$r/DEBIAN/control"
printf 'x\n' > "$r/opt/svrz/x"
dpkg-deb --root-owner-group -b "$r" "$T/in/svrz-rc-nobin.deb" >/dev/null
svrz_sign "$T/in/svrz-rc-nobin.deb"
expect_fail "no /usr/bin/svrz-rc in the package" pp "$T/in/svrz-rc-nobin.deb"
cp "$P" "$T/Packages-before"
pp "$SV_DEB" > "$T/run2.log" 2>&1 || { cat "$T/run2.log"; bad "run 2 (the same .deb again)"; }
cmp -s "$T/Packages-before" "$P" || bad "a second run with the same .deb changed the index"
ok "the same .deb again changes nothing"

# --- 4. --resign ---------------------------------------------------------------------
command -v git >/dev/null || { skip "--resign: git not installed"; echo "all $PASS checks passed"; exit 0; }
G=(git -C "$T/kit" -c user.name=test -c user.email=test@example.invalid -c commit.gpgsign=false)
"${G[@]}" init -q -b main
"${G[@]}" add -A && "${G[@]}" commit -qm kit
export OV_PKGS_RESIGN_REF=main
# A stand-in curl that only notes the Kuma pushes (no request leaves here).
mkdir -p "$T/stub"
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s"\n' "$T/kuma.log" > "$T/stub/curl"; chmod 755 "$T/stub/curl"
rs() { PATH="$T/stub:$PATH" OV_PKGS_KUMA_PUSH_URL=https://kuma.example.invalid/api/push/test "$KIT/publish-pkgs.sh" --resign "$@"; }
D=$PUB/apt/dists/stable
cp "$D/InRelease" "$T/InRelease-before"; cp "$P" "$T/Packages-before"
cp "$PUB/install.sh" "$T/install-before.sh"
echo '# changed' >> "$KIT/pkgs/install.sh"; "${G[@]}" commit -qam 'install.sh changed'
sleep 1
rm -rf "$T/dest"; mkdir -p "$T/dest"; echo old > "$T/dest/index.html"
rs > "$T/resign.log" 2>&1 || { cat "$T/resign.log"; bad "--resign"; }
cmp -s "$T/Packages-before" "$P" || bad "--resign changed the Packages index"
! cmp -s "$T/InRelease-before" "$D/InRelease" || bad "--resign did not sign InRelease again"
gpgv --keyring "$PUB/apt/openvolley.gpg" "$D/InRelease" 2>/dev/null &&
  gpgv --keyring "$PUB/apt/openvolley.gpg" "$D/Release.gpg" "$D/Release" 2>/dev/null || bad "--resign: signatures"
grep -q '^Valid-Until: ' "$D/Release" || bad "--resign: no Valid-Until"
cmp -s "$T/install-before.sh" "$PUB/install.sh" || bad "--resign published install.sh"
grep -q 'APT index signed again, valid until ' "$T/resign.log" || bad "--resign: no summary"
ok "--resign: same Packages, InRelease and Release.gpg signed anew, install.sh not touched"
[[ -f "$T/dest/apt/dists/stable/InRelease" ]] && cmp -s "$D/InRelease" "$T/dest/apt/dists/stable/InRelease" || bad "--resign: dists not synced"
left=$(find "$T/dest" -type f ! -path "$T/dest/apt/dists/*" ! -path "$T/dest/index.html" | head -3)
[[ -z "$left" ]] || bad "--resign synced more than apt/dists/: $left"
[[ "$(cat "$T/dest/index.html")" == old ]] || bad "--resign touched the rest of the served tree"
grep -q 'status=up' "$T/kuma.log" || bad "--resign: no Kuma up push"
ok "--resign: syncs apt/dists/ only, pushes up"
: > "$T/kuma.log"
expect_fail "--resign goes only with --no-sync" rs --no-sync "$SV_DEB"
expect_fail "--resign goes only with --no-sync" rs --no-sync --desktop 2.2.0
grep -q 'status=down' "$T/kuma.log" || bad "a refusal did not push down"
ok "a refusal pushes down"
touch "$KIT/stray.sh"
expect_fail "has local changes" rs --no-sync
rm "$KIT/stray.sh"
echo '# local edit' >> "$KIT/lib/publish-lib.sh"
expect_fail "has local changes" rs --no-sync
"${G[@]}" checkout -q -- escoresheet/deploy/lib/publish-lib.sh
"${G[@]}" checkout -qb side
echo '# unreviewed' >> "$KIT/publish-pkgs.sh"; "${G[@]}" commit -qam unreviewed
expect_fail "is not on main" rs --no-sync
"${G[@]}" checkout -q main
"${G[@]}" checkout -q --detach HEAD~1   # an earlier commit of main is fine
rs --no-sync > "$T/resign2.log" 2>&1 || { cat "$T/resign2.log"; bad "--resign from an earlier commit of main"; }
"${G[@]}" checkout -q main
ok "--resign runs from main (or an earlier commit of it) only"
make_ov_deb "$POOL/openvolley-escoresheet_2.1.0_amd64.deb" 2.1.0
cp "$D/InRelease" "$T/InRelease-before"
expect_fail "no longer gives the published index" rs --no-sync
cmp -s "$T/Packages-before" "$P" && cmp -s "$T/InRelease-before" "$D/InRelease" || bad "a refused --resign changed the index"
rm "$POOL/openvolley-escoresheet_2.1.0_amd64.deb"
ok "--resign leaves the index as it was when the pool changed"

echo "all $PASS checks passed"
