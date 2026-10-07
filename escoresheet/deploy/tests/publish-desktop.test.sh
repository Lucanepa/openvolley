#!/usr/bin/env bash
# Offline tests for publish-pkgs.sh --desktop (lib/publish-lib.sh and
# lib/desktop-updater.mjs): signing, verification, latest.json, the public
# desktop/ tree and the key-material guard, with a THROWAWAY updater key made
# here, for OpenVolley and for OpenBeach (--app beach: its own tags, package,
# manifests and GitHub fallback), plus the multi-app parts: APT package names,
# the per-app hold-back, the Android certificate per app id, install.sh and
# the landing page. It never reads the real keys, never calls GitHub, never syncs.
#
#   escoresheet/deploy/tests/publish-desktop.test.sh
#
# Needs node, dpkg-deb and tauri-cli >= 2.12 (OV_TAURI_CLI, default
# escoresheet/frontend/node_modules/.bin/tauri). Scratch files go to
# $TMPDIR (default /tmp) and are removed at the end; OV_TEST_KEEP=DIR keeps
# the signed files, latest.json and the throwaway public key there.
set -euo pipefail
umask 022

KIT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
T=$(mktemp -d "${TMPDIR:-/tmp}/ov-publish-desktop.XXXXXX")
trap 'rm -rf "$T"' EXIT

# Isolation first: everything the library reads comes from $T.
export OV_DESKTOP_KEYS="$T/keys"
export OV_DESKTOP_TAURI_CONF="$T/tauri.conf.json"
export OV_BEACH_TAURI_CONF="$T/tauri.beach.conf.json"
export OV_BEACH_CERT_FILE="$T/beach-cert.sha256"
export OV_BEACH_CHANGELOGS="$T/beach-changelogs"
export OV_DESKTOP_RELEASE_DIR="$T/release"
export OV_PKGS_HOME="$T/pkgs-home"
export OV_PKGS_DEST="$T/dest/"
unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PATH TAURI_SIGNING_PRIVATE_KEY_PASSWORD

die() { echo "die: $*" >&2; exit 1; }
# shellcheck source=SCRIPTDIR/../lib/publish-lib.sh
. "$KIT_DIR/lib/publish-lib.sh"
[[ "$DESKTOP_KEYS" == "$T/keys" ]] || { echo "refusing: the test would use $DESKTOP_KEYS" >&2; exit 1; }
FASTLANE_CHANGELOGS="$T/changelogs"

PASS=0
ok() { PASS=$((PASS + 1)); echo "ok   $*"; }
bad() { echo "FAIL $*" >&2; exit 1; }
# expect_fail TEXT CMD...: CMD (in a subshell) fails and its output contains TEXT.
# Not inside if/&&/$(): bash ignores set -e there, also in subshells.
expect_fail() {
  local want=$1 rc out
  shift
  set +e
  (set -e; "$@") > "$T/expect.out" 2>&1
  rc=$?
  set -e
  out=$(<"$T/expect.out")
  (( rc != 0 )) || bad "expected failure ($want): $*"
  [[ "$out" == *"$want"* ]] || bad "expected \"$want\" from $*, got: $out"
  ok "refuses: $want"
}
updater_js() { node "$KIT_DIR/lib/desktop-updater.mjs" "$@"; }

V=2.2.0
GH="https://github.com/Lucanepa/openvolley/releases/download/desktop-v$V"

# --- throwaway keys and fake release ---------------------------------------
mkdir -p "$T/keys" "$T/other" "$T/release" "$T/changelogs"
PASSWORD="throwaway-$(head -c 12 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
"$TAURI_CLI" signer generate --ci -p "$PASSWORD" -w "$T/keys/updater.key" </dev/null >/dev/null 2>&1
printf '%s' "$PASSWORD" > "$T/keys/key-password"
chmod 600 "$T/keys/updater.key" "$T/keys/key-password"
"$TAURI_CLI" signer generate --ci -p other -w "$T/other/updater.key" </dev/null >/dev/null 2>&1
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ productName: "Openvolley eScoresheet",
  plugins: { updater: { pubkey: require("fs").readFileSync(process.argv[2], "utf8").trim() } } }, null, 2))' \
  "$OV_DESKTOP_TAURI_CONF" "$T/keys/updater.key.pub"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ productName: "OpenBeach", identifier: "com.openvolley.beach",
  plugins: { updater: { pubkey: require("fs").readFileSync(process.argv[2], "utf8").trim() } } }, null, 2))' \
  "$OV_BEACH_TAURI_CONF" "$T/keys/updater.key.pub"

# make_deb OUT VERSION [PACKAGE]
make_deb() {
  local out=$1 ver=$2 pkg=${3:-openvolley-escoresheet} root="$T/debroot"
  rm -rf "$root"
  mkdir -p "$root/DEBIAN" "$root/usr/bin"
  printf 'Package: %s\nVersion: %s\nArchitecture: amd64\nMaintainer: test <test@example.invalid>\nDescription: test package\n' \
    "$pkg" "$ver" > "$root/DEBIAN/control"
  printf '#!/bin/sh\necho %s\n' "$ver" > "$root/usr/bin/$pkg"
  chmod 755 "$root/usr/bin/$pkg"
  dpkg-deb --root-owner-group -b "$root" "$out" >/dev/null
}
{ printf 'MZ'; head -c 300000 /dev/urandom; } > "$T/release/Openvolley.eScoresheet_${V}_x64-setup.exe"
{ printf '\177ELF'; head -c 500000 /dev/urandom; } > "$T/release/openvolley-escoresheet_${V}_amd64.AppImage"
make_deb "$T/release/openvolley-escoresheet_${V}_amd64.deb" "$V"
printf 'OpenVolley 2.2.0\n- The app updates itself.\n- Second line.\n' > "$T/changelogs/20020000.txt"

# --- setup checks -----------------------------------------------------------
desktop_check_setup && ok "setup: tauri CLI $("$TAURI_CLI" --version | awk '{print $2}'), key files, trusted pubkey"
chmod 644 "$T/keys/key-password"
expect_fail "is mode 644; chmod 600 it" desktop_check_setup
chmod 600 "$T/keys/key-password"
cp "$OV_DESKTOP_TAURI_CONF" "$T/conf.bak"
echo '{"plugins":{}}' > "$OV_DESKTOP_TAURI_CONF"
expect_fail "no plugins.updater.pubkey" desktop_check_setup
cp "$T/conf.bak" "$OV_DESKTOP_TAURI_CONF"

# --- fetch -------------------------------------------------------------------
desktop_fetch "$V" "$T/work"
[[ "$DESKTOP_EXE" == "$T/work/Openvolley.eScoresheet_${V}_x64-setup.exe" &&
   "$DESKTOP_APPIMAGE" == "$T/work/openvolley-escoresheet_${V}_amd64.AppImage" &&
   "$DESKTOP_DEB" == "$T/work/openvolley-escoresheet_${V}_amd64.deb" ]] || bad "fetch picked the wrong files"
ok "fetch: one installer of each kind, version $V"

# fetch_variant NAME: a copy of the release dir to break in one way.
fetch_variant() { rm -rf "$T/rel-$1" "$T/w-$1"; cp -r "$T/release" "$T/rel-$1"; }
fetch_from() { OV_DESKTOP_RELEASE_DIR="$T/rel-$1"; DESKTOP_RELEASE_DIR="$T/rel-$1"; desktop_fetch "$V" "$T/w-$1"; }
fetch_variant two; cp "$T/release/Openvolley.eScoresheet_${V}_x64-setup.exe" "$T/rel-two/Other_${V}_x64-setup.exe"
expect_fail "expected one *-setup.exe, found 2" fetch_from two
fetch_variant name; mv "$T/rel-name/openvolley-escoresheet_${V}_amd64.AppImage" "$T/rel-name/openvolley-escoresheet_2.1.9_amd64.AppImage"
expect_fail "name does not carry version $V" fetch_from name
fetch_variant debver; make_deb "$T/rel-debver/openvolley-escoresheet_${V}_amd64.deb" 2.1.9
expect_fail "version 2.1.9, expected $V" fetch_from debver
fetch_variant debpkg; make_deb "$T/rel-debpkg/openvolley-escoresheet_${V}_amd64.deb" "$V" openvolley-e-scoresheet
expect_fail "package openvolley-e-scoresheet, expected openvolley-escoresheet" fetch_from debpkg
fetch_variant exe; printf 'not an exe' > "$T/rel-exe/Openvolley.eScoresheet_${V}_x64-setup.exe"
expect_fail "not a Windows executable" fetch_from exe

# --- sign and verify ---------------------------------------------------------
out=$(desktop_sign "$V" "$DESKTOP_EXE" "$DESKTOP_APPIMAGE" "$DESKTOP_DEB" 2>&1)
[[ "$out" != *"$PASSWORD"* ]] || bad "signing printed the password"
for f in "$DESKTOP_EXE" "$DESKTOP_APPIMAGE" "$DESKTOP_DEB"; do [[ -s "$f.sig" ]] || bad "no $f.sig"; done
ok "sign: three .sig files, password not printed"
desktop_verify "$V" "$DESKTOP_EXE" "$DESKTOP_APPIMAGE" "$DESKTOP_DEB" >/dev/null && ok "verify: against the pubkey in tauri.conf.json"
base64 -d "$DESKTOP_EXE.sig" | grep -q $'^trusted comment: timestamp:[0-9]*\tfile:Openvolley.eScoresheet_2.2.0_x64-setup.exe\tversion:2.2.0$' ||
  bad "the signature's trusted comment does not carry version:$V"
ok "sign: version bound into the trusted comment"

wrong_pw() { printf 'nope' > "$T/keys/key-password"; desktop_sign "$V" "$T/work/x.bin"; }
head -c 100 /dev/urandom > "$T/work/x.bin"
cp "$T/keys/key-password" "$T/pw.bak"
expect_fail "signing x.bin failed" wrong_pw
cp "$T/pw.bak" "$T/keys/key-password"; chmod 600 "$T/keys/key-password"

mkdir -p "$T/neg"
cp "$DESKTOP_APPIMAGE" "$T/neg/tampered.AppImage"; cp "$DESKTOP_APPIMAGE.sig" "$T/neg/tampered.AppImage.sig"
printf 'x' >> "$T/neg/tampered.AppImage"
expect_fail "signature does not match the file" desktop_verify "$V" "$T/neg/tampered.AppImage"
expect_fail "signed for version 2.2.0, announced 2.2.1" desktop_verify 2.2.1 "$DESKTOP_DEB"
cp "$DESKTOP_DEB" "$T/neg/otherkey.deb"
TAURI_SIGNING_PRIVATE_KEY_PATH="$T/other/updater.key" TAURI_SIGNING_PRIVATE_KEY_PASSWORD=other \
  "$TAURI_CLI" signer sign --app-version "$V" "$T/neg/otherkey.deb" </dev/null >/dev/null 2>&1
expect_fail "the app trusts" desktop_verify "$V" "$T/neg/otherkey.deb"
cp "$DESKTOP_DEB" "$T/neg/noversion.deb"
TAURI_SIGNING_PRIVATE_KEY_PATH="$T/keys/updater.key" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$PASSWORD" \
  "$TAURI_CLI" signer sign "$T/neg/noversion.deb" </dev/null >/dev/null 2>&1
expect_fail "no version in the signature" desktop_verify "$V" "$T/neg/noversion.deb"

# --- notes and latest.json ---------------------------------------------------
desktop_notes "$V" "$T/notes.txt"
[[ "$(cat "$T/notes.txt")" == $'- The app updates itself.\n- Second line.' ]] || bad "notes: $(cat "$T/notes.txt")"
printf 'OpenVolley 2.2.0\n- Rebuilt.\n' > "$T/changelogs/20020001.txt"
desktop_notes "$V-test1" "$T/notes.txt"
[[ "$(cat "$T/notes.txt")" == '- Rebuilt.' ]] || bad "notes: highest build should win"
rm "$T/changelogs/20020001.txt"
desktop_notes 9.9.9 "$T/notes.txt"
[[ ! -s "$T/notes.txt" ]] || bad "notes for a version without changelog should be empty"
ok "notes: fastlane changelog, title dropped, highest build, empty when missing"

desktop_manifest "$V" "$T/work" "$T/work/latest.json" >/dev/null
L="$T/work/latest.json"
node - "$L" "$V" "$GH" <<'EOF' || bad "latest.json content"
const [file, v, gh] = process.argv.slice(2)
const m = JSON.parse(require('fs').readFileSync(file, 'utf8'))
const assert = require('assert')
assert.deepStrictEqual(Object.keys(m), ['version', 'notes', 'pub_date', 'platforms'])
assert.strictEqual(m.version, v)
assert.strictEqual(m.notes, '- The app updates itself.\n- Second line.')
assert.match(m.pub_date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
const p = m.platforms
assert.deepStrictEqual(Object.keys(p).sort(), ['linux-x86_64', 'linux-x86_64-appimage', 'linux-x86_64-deb', 'windows-x86_64', 'windows-x86_64-nsis'])
assert.strictEqual(p['windows-x86_64-nsis'].url, `${gh}/Openvolley.eScoresheet_${v}_x64-setup.exe`)
assert.strictEqual(p['linux-x86_64-appimage'].url, `${gh}/openvolley-escoresheet_${v}_amd64.AppImage`)
assert.strictEqual(p['linux-x86_64-deb'].url, `https://get.openvolley.app/apt/pool/main/openvolley-escoresheet_${v}_amd64.deb`)
assert.deepStrictEqual(p['windows-x86_64'], p['windows-x86_64-nsis'])
assert.deepStrictEqual(p['linux-x86_64'], p['linux-x86_64-appimage'])
for (const e of Object.values(p)) assert.deepStrictEqual(Object.keys(e), ['url', 'signature'])
EOF
ok "latest.json: version, notes, pub_date, the five platform keys, URLs"
[[ "$(node -p "require('$L').platforms['windows-x86_64-nsis'].signature")" == "$(cat "$DESKTOP_EXE.sig")" ]] ||
  bad "signature field is not the .sig text"
ok "latest.json: signature = the .sig file text"
updater_js check --tauri-conf "$OV_DESKTOP_TAURI_CONF" --version "$V" --dir "$T/work" "$L" >/dev/null && ok "check: every signature matches its file"

# mutate NAME JS: a copy of latest.json changed by JS (m = the manifest).
mutate() { node -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync('$L','utf8')); $2; fs.writeFileSync('$T/m-$1.json', JSON.stringify(m))"; }
check_m() { updater_js check --tauri-conf "$OV_DESKTOP_TAURI_CONF" "$T/m-$1.json"; }
mutate nodeb "delete m.platforms['linux-x86_64-deb']";                 expect_fail "platform linux-x86_64-deb missing" check_m nodeb
mutate http "m.platforms['linux-x86_64-deb'].url = m.platforms['linux-x86_64-deb'].url.replace('https:', 'http:')"
expect_fail "url is not https" check_m http
mutate bump "m.version = '2.2.1'";                                     expect_fail "signed for version 2.2.0, announced 2.2.1" check_m bump
mutate extra "m.platforms['darwin-aarch64'] = m.platforms['linux-x86_64']"; expect_fail "unexpected platform darwin-aarch64" check_m extra
mutate split "m.platforms['windows-x86_64'] = m.platforms['linux-x86_64-deb']"; expect_fail "windows-x86_64 differs from windows-x86_64-nsis" check_m split
mutate date "m.pub_date = '6 Oct 2026'";                               expect_fail "pub_date is not RFC 3339" check_m date
mutate swap "m.platforms['linux-x86_64-deb'].signature = m.platforms['linux-x86_64-appimage'].signature"
check_m swap >/dev/null 2>&1 || bad "swap: metadata check should pass"
expect_fail "signature does not match the file" updater_js check --tauri-conf "$OV_DESKTOP_TAURI_CONF" --dir "$T/work" "$T/m-swap.json"

# --- public tree --------------------------------------------------------------
P="$T/public"
desktop_publish_tree "$V" 1 "$L" "$P" >/dev/null
[[ -f "$P/desktop/staging.json" && -f "$P/desktop/latest-$V.json" && ! -e "$P/desktop/latest.json" ]] || bad "staging run wrote latest.json"
ok "--staging: staging.json and latest-$V.json only"
desktop_publish_tree "$V" 0 "$L" "$P" >/dev/null
if ! cmp -s "$P/desktop/latest.json" "$L" || ! cmp -s "$P/desktop/staging.json" "$L"; then bad "release run"; fi
ok "release: latest.json = staging.json = latest-$V.json"
[[ "$(stat -c %a "$P/desktop/latest.json")" == 644 ]] || bad "latest.json mode"
older() {
  local m="$T/older.json"
  node -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync('$L','utf8')); m.version='2.1.9'; fs.writeFileSync('$m', JSON.stringify(m))"
  desktop_publish_tree 2.1.9 "$1" "$m" "$P"
}
expect_fail "desktop/staging.json announces $V, newer than 2.1.9" older 1
rm "$P/desktop/staging.json"
expect_fail "desktop/latest.json announces $V, newer than 2.1.9" older 0
desktop_publish_tree "$V" 0 "$L" "$P" >/dev/null && ok "re-publishing the same version is allowed"

# --- key-material guard ------------------------------------------------------
cp "$DESKTOP_EXE.sig" "$P/desktop/"
cp "$T/keys/updater.key.pub" "$P/desktop/updater.pub"
refuse_key_material "$P" && ok "guard: manifests, a .sig and the public key pass"
leak_test() { cp -r "$P" "$T/leak"; "$@"; refuse_key_material "$T/leak"; }
cleanup_leak() { rm -rf "$T/leak"; }
expect_fail "key material in the public tree" leak_test cp "$T/keys/updater.key" "$T/leak/desktop/updater.key"; cleanup_leak
expect_fail "key material in the public tree" leak_test cp "$T/keys/key-password" "$T/leak/key-password"; cleanup_leak
expect_fail "a private key is in the public tree" leak_test cp "$T/keys/updater.key" "$T/leak/desktop/notes.txt"; cleanup_leak
decoded() { base64 -d "$T/keys/updater.key" > "$T/leak/k.txt"; }
expect_fail "a private key is in the public tree" leak_test decoded; cleanup_leak
embedded() { node -e "console.log(JSON.stringify({k: require('fs').readFileSync('$T/keys/updater.key','utf8').trim()}))" > "$T/leak/desktop/x.json"; }
expect_fail "a private key is in the public tree" leak_test embedded; cleanup_leak
grep -rqF "$PASSWORD" "$P" "$T/work" && bad "the password is in a published or work file"
ok "the password appears in no output file"

# --- APT hold-back: the index never runs ahead of desktop/latest.json ----------
# The in-app .deb updater installs APT's newest version, so a staging .deb or a
# version the kill switch took out of latest.json must not be in Packages.
POOL="$T/apt/pool/main"
mkdir -p "$POOL"
for v in 2.1.1 2.2.0 2.2.1 2.2.2; do make_deb "$POOL/openvolley-escoresheet_${v}_amd64.deb" "$v"; done
make_deb "$POOL/other-tool_9.0.0_amd64.deb" 9.0.0 other-tool
scan() { (cd "$T/apt" && dpkg-scanpackages --multiversion --arch amd64 "$1" 2>/dev/null); }
scan pool/main > "$T/Packages.all"
# held_case NAME EXPECTED-VERSIONS PUBDIR [V STAGING]: Packages after the hold
# lists exactly EXPECTED-VERSIONS of the app (and other-tool, never held back),
# byte for byte what dpkg-scanpackages gives for a pool without the held files.
held_case() {
  local name=$1 want=$2 pub=$3 v got
  shift 3
  apt_hold_init "$pub" "$@"
  cp "$T/Packages.all" "$T/Packages.$name"
  apt_hold_packages "$T/Packages.$name" > "$T/held.$name"
  got=$(awk '/^Package: openvolley-escoresheet$/ { p = 1 } /^Version:/ && p { print $2; p = 0 }' "$T/Packages.$name" | sort -V | xargs)
  [[ "$got" == "$want" ]] || bad "hold $name: APT lists '$got', expected '$want'"
  grep -q '^Package: other-tool$' "$T/Packages.$name" || bad "hold $name: other-tool dropped"
  rm -rf "$T/apt/ref"; mkdir -p "$T/apt/ref"
  cp "$POOL/other-tool_9.0.0_amd64.deb" "$T/apt/ref/"
  for v in $want; do cp "$POOL/openvolley-escoresheet_${v}_amd64.deb" "$T/apt/ref/"; done
  scan ref | sed 's|^Filename: ref/|Filename: pool/main/|' | cmp -s - "$T/Packages.$name" ||
    bad "hold $name: filtered Packages differs from a scan of the kept files"
  ok "hold $name: APT lists $want"
}
HP="$T/hold-pub"
mkdir -p "$HP"
# manifest_at VERSION FILE: a desktop manifest announcing VERSION.
manifest_at() { node -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync('$L','utf8')); m.version='$1'; fs.writeFileSync('$2', JSON.stringify(m))"; }
held_case none "2.1.1 2.2.0 2.2.1 2.2.2" "$HP"
held_case first-staging "2.1.1" "$HP" 2.2.0 1
mkdir -p "$HP/desktop"; manifest_at 2.2.0 "$HP/desktop/staging.json"
held_case after-first-staging "2.1.1" "$HP"
held_case first-release "2.1.1 2.2.0" "$HP" 2.2.0 0
manifest_at 2.2.0 "$HP/desktop/latest.json"
held_case staging-2.2.1 "2.1.1 2.2.0" "$HP" 2.2.1 1
manifest_at 2.2.1 "$HP/desktop/staging.json"
held_case plain-run-while-staging "2.1.1 2.2.0" "$HP"
held_case release-2.2.1 "2.1.1 2.2.0 2.2.1" "$HP" 2.2.1 0
# Bad 2.2.2 went out; the kill switch puts latest-2.2.1.json back over
# latest.json and staging.json and runs publish-pkgs.sh: 2.2.2 leaves the index,
# so a 2.2.0 laptop's apt-get --only-upgrade gets 2.2.1, not 2.2.2.
manifest_at 2.2.1 "$HP/desktop/latest.json"; manifest_at 2.2.1 "$HP/desktop/staging.json"
held_case kill-switch "2.1.1 2.2.0 2.2.1" "$HP"
grep -q 'held back from APT: openvolley-escoresheet 2.2.2 (desktop/latest.json announces 2.2.1)' "$T/held.kill-switch" ||
  bad "hold: no held-back report"
ok "hold: reports what it leaves out"
apt_hold_init "$HP"
apt_held 2.2.1-1 && apt_held 2.2.2~rc1 && ! apt_held 2.2.1 && ! apt_held 2.2.1~rc1 ||
  bad "hold: dpkg version order (2.2.1-1, 2.2.2~rc1 held; 2.2.1, 2.2.1~rc1 not)"
ok "hold: compares in dpkg version order"

# publish-pkgs.sh refuses a hand-given .deb that the index would hold back.
# Fake key dirs get it past the setup checks; it dies before any key use.
mkdir -p "$OV_PKGS_HOME/gnupg" "$OV_PKGS_HOME/fdroid" "$OV_PKGS_HOME/public/desktop"
touch "$OV_PKGS_HOME/gpg-passphrase" "$OV_PKGS_HOME/fdroid/config.yml" "$OV_PKGS_HOME/fdroid/keystore.p12"
manifest_at 2.2.1 "$OV_PKGS_HOME/public/desktop/latest.json"
if command -v fdroid >/dev/null && command -v apt-ftparchive >/dev/null && command -v rsync >/dev/null; then
  expect_fail "version 2.2.2 is not announced by desktop/latest.json" \
    "$KIT_DIR/publish-pkgs.sh" --no-sync "$POOL/openvolley-escoresheet_2.2.2_amd64.deb"
  [[ ! -e "$OV_PKGS_HOME/public/apt/pool/main/openvolley-escoresheet_2.2.2_amd64.deb" ]] || bad "the refused .deb reached the pool"
  # OpenBeach's .deb against its own desktop/beach/latest.json
  mkdir -p "$OV_PKGS_HOME/public/desktop/beach"
  manifest_at 2.0.0 "$OV_PKGS_HOME/public/desktop/beach/latest.json"
  make_deb "$T/openbeach-escoresheet_2.0.1_amd64.deb" 2.0.1 openbeach-escoresheet
  expect_fail "version 2.0.1 is not announced by desktop/beach/latest.json, so APT would not list it; publish desktop releases with --desktop 2.0.1 --app beach" \
    "$KIT_DIR/publish-pkgs.sh" --no-sync "$T/openbeach-escoresheet_2.0.1_amd64.deb"
  # a package that is neither app (nor an OpenVolley old name)
  make_deb "$T/other-tool_9.0.0_amd64.deb" 9.0.0 other-tool
  expect_fail "package other-tool is not published here (openvolley-escoresheet openbeach-escoresheet)" \
    "$KIT_DIR/publish-pkgs.sh" --no-sync "$T/other-tool_9.0.0_amd64.deb"
  [[ -z "$(ls "$OV_PKGS_HOME/public/apt/pool/main/" 2>/dev/null)" ]] || bad "a refused .deb reached the pool"
else
  echo "skip publish-pkgs.sh hand-given .deb refusal (fdroid, apt-ftparchive or rsync not installed)"
fi
rm -rf "$OV_PKGS_HOME"

# --- desktop_upload: GitHub's "Latest" follows desktop/latest.json --------------
# gh stub: logs each call; `gh api .../releases/latest` answers $GH_LATEST.
GH_LOG="$T/gh.log"
gh() {
  echo "gh $*" >> "$GH_LOG"
  if [[ "$1" == api ]]; then echo "$GH_LATEST"; fi
}
upload_case() { : > "$GH_LOG"; GH_LATEST=$1; desktop_upload "$V" "$2" "$T/work" > "$T/upload.out" 2>&1; }
upload_case v1.3.0 0
grep -q "^gh release upload desktop-v$V .*latest.json" "$GH_LOG" || bad "upload: latest.json not uploaded"
grep -q "^gh release edit desktop-v$V --repo Lucanepa/openvolley --latest$" "$GH_LOG" || bad "upload: did not make desktop-v$V latest"
ok "upload: a server release that took \"Latest\" gives it back to desktop-v$V"
upload_case "desktop-v$V" 0
! grep -q '^gh release edit' "$GH_LOG" || bad "upload: edited a release that already was latest"
ok "upload: no edit when desktop-v$V already is latest"
upload_case v1.3.0 1
! grep -q 'latest' "$GH_LOG" || bad "upload: a staging run touched latest.json or GitHub's latest"
ok "upload: --staging neither uploads latest.json nor moves \"Latest\""
unset -f gh

# --- publish-pkgs.sh argument handling (dies before any key or network use) --
pp() { "$KIT_DIR/publish-pkgs.sh" "$@"; }
expect_fail "--staging needs --desktop VERSION" pp --staging --no-sync
expect_fail "--desktop needs a version" pp --no-sync --desktop
expect_fail "not a version like 2.2.0" pp --desktop banana --no-sync
expect_fail "--desktop given twice" pp --desktop 2.2.0 --desktop 2.2.1 --no-sync
expect_fail "OV_DESKTOP_RELEASE_DIR is for tests: use it with --no-sync" pp --desktop 2.2.0
expect_fail "no signing key in $OV_PKGS_HOME" pp --desktop v2.2.0 --staging --no-sync
pp --help | grep -q -- '--desktop VERSION \[--app beach\] \[--staging\]' && ok "--help documents --desktop and --app"
expect_fail "--app needs --desktop VERSION" pp --app beach --no-sync
expect_fail "--app volley: expected openvolley or beach" pp --desktop 2.0.0 --app volley --no-sync
expect_fail "--app given twice" pp --desktop 2.0.0 --app beach --app beach --no-sync
expect_fail "--app needs openvolley or beach" pp --desktop 2.0.0 --no-sync --app
expect_fail "--flatpak needs --desktop VERSION" pp --flatpak --no-sync
expect_fail "--flatpak cannot go with --staging" pp --desktop 2.2.0 --staging --flatpak --no-sync
pp --help | grep -q -- '--staging\] \[--flatpak\]' && ok "--help documents --flatpak"

if [[ -n "${OV_TEST_KEEP:-}" ]]; then
  # For a cross-check outside this script: the signed files, latest.json and the test pubkey.
  mkdir -p "$OV_TEST_KEEP"
  cp "$DESKTOP_EXE"* "$DESKTOP_APPIMAGE"* "$DESKTOP_DEB"* "$L" "$T/keys/updater.key.pub" "$OV_TEST_KEEP/"
  echo "kept in $OV_TEST_KEEP"
fi
# === OpenBeach (--app beach) and the multi-app parts ==========================
# The same steps for the second app: its own tag prefix, .deb, manifests dir,
# Tauri config (same throwaway key), changelogs and GitHub fallback release.
BV=2.0.0
BGH="https://github.com/Lucanepa/openvolley/releases/download/beach-desktop-v$BV"
desktop_app_select beach
[[ "$DESKTOP_TAG_PREFIX $DESKTOP_DEB_NAME $DESKTOP_DIR $DESKTOP_TAURI_CONF $DESKTOP_MAKE_LATEST $DESKTOP_FALLBACK_TAG" == \
   "beach-desktop-v openbeach-escoresheet desktop/beach $T/tauri.beach.conf.json 0 beach-desktop-latest" ]] ||
  bad "beach: app settings"
ok "beach: tag beach-desktop-v, package openbeach-escoresheet, desktop/beach/, its Tauri config, never Latest"
expect_fail "unknown app volley" desktop_app_select volley

mkdir -p "$T/beach-release" "$OV_BEACH_CHANGELOGS"
{ printf 'MZ'; head -c 300000 /dev/urandom; } > "$T/beach-release/OpenBeach_${BV}_x64-setup.exe"
{ printf '\177ELF'; head -c 500000 /dev/urandom; } > "$T/beach-release/openbeach-escoresheet_${BV}_amd64.AppImage"
make_deb "$T/beach-release/openbeach-escoresheet_${BV}_amd64.deb" "$BV" openbeach-escoresheet
printf 'OpenBeach 2.0.0\n- Beach courts on one relay.\n' > "$OV_BEACH_CHANGELOGS/20000000.txt"
desktop_check_setup && ok "beach: setup reads the updater key from tauri.beach.conf.json"

OV_DESKTOP_RELEASE_DIR="$T/beach-release"; DESKTOP_RELEASE_DIR="$T/beach-release"
desktop_fetch "$BV" "$T/bwork"
[[ "$DESKTOP_EXE" == "$T/bwork/OpenBeach_${BV}_x64-setup.exe" &&
   "$DESKTOP_APPIMAGE" == "$T/bwork/openbeach-escoresheet_${BV}_amd64.AppImage" &&
   "$DESKTOP_DEB" == "$T/bwork/openbeach-escoresheet_${BV}_amd64.deb" ]] || bad "beach: fetch picked the wrong files"
ok "beach: fetch, one installer of each kind, version $BV"
rm -rf "$T/rel-bpkg"; cp -r "$T/beach-release" "$T/rel-bpkg"
make_deb "$T/rel-bpkg/openbeach-escoresheet_${BV}_amd64.deb" "$BV" openvolley-escoresheet
bfetch_wrong() { OV_DESKTOP_RELEASE_DIR="$T/rel-bpkg"; DESKTOP_RELEASE_DIR="$T/rel-bpkg"; desktop_fetch "$BV" "$T/w-bpkg"; }
expect_fail "package openvolley-escoresheet, expected openbeach-escoresheet" bfetch_wrong

desktop_sign "$BV" "$DESKTOP_EXE" "$DESKTOP_APPIMAGE" "$DESKTOP_DEB" >/dev/null
desktop_verify "$BV" "$DESKTOP_EXE" "$DESKTOP_APPIMAGE" "$DESKTOP_DEB" >/dev/null && ok "beach: sign and verify"
desktop_notes "$BV" "$T/bnotes.txt"
[[ "$(cat "$T/bnotes.txt")" == '- Beach courts on one relay.' ]] || bad "beach notes: $(cat "$T/bnotes.txt")"
ok "beach: notes from openbeach's changelog, OpenBeach title dropped"
desktop_manifest "$BV" "$T/bwork" "$T/bwork/latest.json" >/dev/null
BL="$T/bwork/latest.json"
node - "$BL" "$BV" "$BGH" <<'JS' || bad "beach latest.json content"
const [file, v, gh] = process.argv.slice(2)
const m = JSON.parse(require('fs').readFileSync(file, 'utf8'))
const assert = require('assert')
assert.strictEqual(m.version, v)
assert.strictEqual(m.notes, '- Beach courts on one relay.')
const p = m.platforms
assert.strictEqual(p['windows-x86_64-nsis'].url, `${gh}/OpenBeach_${v}_x64-setup.exe`)
assert.strictEqual(p['linux-x86_64-appimage'].url, `${gh}/openbeach-escoresheet_${v}_amd64.AppImage`)
assert.strictEqual(p['linux-x86_64-deb'].url, `https://get.openvolley.app/apt/pool/main/openbeach-escoresheet_${v}_amd64.deb`)
JS
ok "beach latest.json: beach-desktop-v$BV assets, the openbeach-escoresheet pool .deb"

BP="$T/bpublic"
mkdir -p "$BP/desktop"; cp "$P/desktop/latest.json" "$BP/desktop/latest.json"
desktop_publish_tree "$BV" 1 "$BL" "$BP" >/dev/null
[[ -f "$BP/desktop/beach/staging.json" && -f "$BP/desktop/beach/latest-$BV.json" && ! -e "$BP/desktop/beach/latest.json" ]] ||
  bad "beach --staging tree"
desktop_publish_tree "$BV" 0 "$BL" "$BP" >/dev/null
cmp -s "$BP/desktop/beach/latest.json" "$BL" || bad "beach latest.json not published"
cmp -s "$BP/desktop/latest.json" "$P/desktop/latest.json" || bad "beach release touched OpenVolley's desktop/latest.json"
[[ ! -e "$BP/desktop/staging.json" ]] || bad "beach release wrote OpenVolley's staging.json"
ok "beach: desktop/beach/{staging,latest,latest-$BV}.json; OpenVolley's desktop/*.json untouched"
bolder() {
  node -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync('$BL','utf8')); m.version='1.9.9'; fs.writeFileSync('$T/bolder.json', JSON.stringify(m))"
  desktop_publish_tree 1.9.9 0 "$T/bolder.json" "$BP"
}
expect_fail "desktop/beach/staging.json announces $BV, newer than 1.9.9" bolder

# GitHub: the beach release never becomes "Latest"; latest.json goes to the
# beach-desktop-latest prerelease (made when missing).
GH_LOG="$T/gh.log"
GH_FALLBACK_EXISTS=0
gh() {
  echo "gh $*" >> "$GH_LOG"
  case "$1 $2" in
    "api "*) echo "$GH_LATEST" ;;
    "release view") [[ "$GH_FALLBACK_EXISTS" == 1 ]] ;;
  esac
}
bupload_case() { : > "$GH_LOG"; GH_LATEST=$1; GH_FALLBACK_EXISTS=$2; desktop_upload "$BV" "$3" "$T/bwork" > "$T/upload.out" 2>&1; }
bupload_case "desktop-v$V" 0 0
grep -q "^gh release upload beach-desktop-v$BV --repo Lucanepa/openvolley --clobber .*\.exe\.sig .*\.AppImage\.sig .*\.deb\.sig$" "$GH_LOG" || bad "beach upload: .sig files not on beach-desktop-v$BV"
# Never a latest.json on the beach-desktop-vV release itself: both apps trust
# one updater key, and OpenVolley's fallback reads whatever release is "Latest".
if grep -q "^gh release upload beach-desktop-v$BV .*latest.json" "$GH_LOG"; then bad "beach upload: latest.json on beach-desktop-v$BV"; fi
grep -q "^gh release create beach-desktop-latest --repo Lucanepa/openvolley --prerelease --latest=false " "$GH_LOG" || bad "beach upload: fallback prerelease not created"
grep -q "^gh release upload beach-desktop-latest --repo Lucanepa/openvolley --clobber .*/latest.json$" "$GH_LOG" || bad "beach upload: latest.json not on the fallback"
if grep -q -e '--latest$' -e 'release edit' "$GH_LOG"; then bad "beach upload: moved GitHub's Latest"; fi
ok "beach upload: .sig files to beach-desktop-v$BV, latest.json only to the beach-desktop-latest prerelease, Latest untouched"
bupload_case "desktop-v$V" 1 0
if grep -q '^gh release create' "$GH_LOG"; then bad "beach upload: re-created an existing fallback"; fi
grep -q "^gh release upload beach-desktop-latest " "$GH_LOG" || bad "beach upload: existing fallback not updated"
ok "beach upload: an existing fallback prerelease is only updated"
bupload_case "beach-desktop-v$BV" 1 0
grep -q "WARNING: GitHub's latest release is beach-desktop-v$BV" "$T/upload.out" || bad "beach upload: no warning when a beach release is Latest"
ok "beach upload: warns when a beach release took GitHub's Latest (OpenVolley's fallback)"
bupload_case "desktop-v$V" 1 1
if grep -q 'latest' "$GH_LOG"; then bad "beach upload: --staging touched latest.json"; fi
ok "beach upload: --staging uploads the .sig files only"
unset -f gh

# APT hold-back per package: each app against its own latest.json.
BPOOL="$T/bapt/pool/main"
mkdir -p "$BPOOL"
for v in 2.2.0 2.2.1; do make_deb "$BPOOL/openvolley-escoresheet_${v}_amd64.deb" "$v"; done
for v in 2.0.0 2.0.1; do make_deb "$BPOOL/openbeach-escoresheet_${v}_amd64.deb" "$v" openbeach-escoresheet; done
(cd "$T/bapt" && dpkg-scanpackages --multiversion --arch amd64 pool/main 2>/dev/null) > "$T/bPackages"
BHP="$T/bhold"; mkdir -p "$BHP/desktop/beach"
manifest_at 2.2.0 "$BHP/desktop/latest.json"
manifest_at 2.0.0 "$BHP/desktop/beach/latest.json"
listed() { awk -v want="$2" '/^Package:/ { p = $2 } /^Version:/ && p == want { print $2 }' "$1" | sort -V | xargs; }
apt_hold_init "$BHP"
cp "$T/bPackages" "$T/bP1"; apt_hold_packages "$T/bP1" > "$T/bheld1"
[[ "$(listed "$T/bP1" openvolley-escoresheet)|$(listed "$T/bP1" openbeach-escoresheet)" == "2.2.0|2.0.0" ]] || bad "hold per app: $(cat "$T/bheld1")"
grep -q 'held back from APT: openbeach-escoresheet 2.0.1 (desktop/beach/latest.json announces 2.0.0)' "$T/bheld1" || bad "hold per app: report"
ok "hold per app: each package held to its own latest.json"
apt_hold_init "$BHP" 2.0.1 0   # a --desktop 2.0.1 --app beach release run
cp "$T/bPackages" "$T/bP2"; apt_hold_packages "$T/bP2" >/dev/null
[[ "$(listed "$T/bP2" openvolley-escoresheet)|$(listed "$T/bP2" openbeach-escoresheet)" == "2.2.0|2.0.0 2.0.1" ]] || bad "hold per app: beach release run"
apt_held 2.2.1 openvolley-escoresheet && ! apt_held 2.0.1 && ! apt_held 2.0.1 openbeach-escoresheet || bad "hold per app: apt_held"
ok "hold per app: a beach release lists its version and leaves OpenVolley's hold as it was"
desktop_app_select openvolley
apt_hold_init "$BHP"
apt_held 2.2.1 && ! apt_held 2.0.1 || bad "hold: apt_held defaults to the selected app's package"
ok "hold: apt_held without a package is the selected app's"

# APT names and the Android certificate per app id.
apt_name_ok openvolley-escoresheet && apt_name_ok openbeach-escoresheet && ! apt_name_ok openbeach && ! apt_name_ok openvolley ||
  bad "apt_name_ok"
ok "APT names: openvolley-escoresheet and openbeach-escoresheet only"
[[ "$(app_cert_sha256 com.openvolley.escoresheet)" == 2c7f9db4da41f5475f36142403043e45452a3143baff764e3d511d686ddabe87 ]] || bad "OpenVolley cert"
expect_fail "no signing certificate for com.openvolley.beach: put its SHA-256 in $OV_BEACH_CERT_FILE" app_cert_sha256 com.openvolley.beach
BCERT=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
printf '%s\n' "$BCERT" | tr 'a-f' 'A-F' | sed 's/../&:/g; s/:$//' > "$OV_BEACH_CERT_FILE"
[[ "$(app_cert_sha256 com.openvolley.beach)" == "$BCERT" ]] || bad "beach cert from the file (upper case, colons)"
ok "Android: OpenBeach's certificate from its file, normalised"
printf '%s\n' 2c7f9db4da41f5475f36142403043e45452a3143baff764e3d511d686ddabe87 > "$OV_BEACH_CERT_FILE"
expect_fail "OpenBeach must have its own Android key" app_cert_sha256 com.openvolley.beach
printf 'abc\n' > "$OV_BEACH_CERT_FILE"
expect_fail "is not 64 hex digits" app_cert_sha256 com.openvolley.beach
rm -f "$OV_BEACH_CERT_FILE"
expect_fail "app id com.example.other is not published here" app_cert_sha256 com.example.other

# install.sh: pins the key, defaults to OpenVolley, takes OpenBeach by name.
check_install_sh "$KIT_DIR/pkgs/install.sh" AB469DA8DC3EC90F8057320D285B18D76C16B82C && ok "install.sh: key pinned, default and allowed packages"
sed 's/^PACKAGES=.*/PACKAGES="openvolley-escoresheet openbeach-escoresheet evil"/' "$KIT_DIR/pkgs/install.sh" > "$T/install-extra.sh"
expect_fail "does not allow exactly the packages" check_install_sh "$T/install-extra.sh" AB469DA8DC3EC90F8057320D285B18D76C16B82C
sed 's/^DEFAULT_PKG=.*/DEFAULT_PKG=openbeach-escoresheet/' "$KIT_DIR/pkgs/install.sh" > "$T/install-default.sh"
expect_fail "does not install openvolley-escoresheet by default" check_install_sh "$T/install-default.sh" AB469DA8DC3EC90F8057320D285B18D76C16B82C
expect_fail "does not pin the APT key" check_install_sh "$KIT_DIR/pkgs/install.sh" 0000000000000000000000000000000000000000
inst() { sh "$KIT_DIR/pkgs/install.sh" "$@"; }
expect_fail "unknown package 'openbeach'; this repository has: openvolley-escoresheet openbeach-escoresheet" inst openbeach
expect_fail "usage: install.sh [openvolley-escoresheet | openbeach-escoresheet]" inst a b
if [[ "$(id -u)" != 0 ]] && command -v apt-get >/dev/null && [[ "$(dpkg --print-architecture)" == amd64 ]]; then
  expect_fail "curl -fsSL https://get.openvolley.app/install.sh | sudo sh -s openbeach-escoresheet" inst openbeach-escoresheet
  out=$(inst 2>&1 || true)
  [[ "$out" == *"| sudo sh" && "$out" != *" -s "* ]] || bad "install.sh: default package hint: $out"
  ok "install.sh: the root hint repeats the package name only when it is not the default"
fi

# The landing page: OpenVolley's sections always, OpenBeach's once published.
github_setup_exe_url() { echo "https://github.com/Lucanepa/openvolley/releases/download/$1/Setup_x64-setup.exe"; }
fdroid_index() {
  node -e '
    const packages = {}
    for (const a of process.argv.slice(1)) {
      const [id, name, code, file] = a.split(",")
      packages[id] = { versions: { x: { manifest: { versionName: name, versionCode: +code }, file: { name: "/" + file } },
                                   y: { manifest: { versionName: "0.1", versionCode: 1 }, file: { name: "/old.apk" } } } }
    }
    console.log(JSON.stringify({ packages }))' "$@"
}
page() { landing_page "$KIT_DIR/pkgs/index.html" "$1" "$2" "$T/index.html"; }
awk 'BEGIN { RS = ""; ORS = "\n\n" } !/Package: openbeach-escoresheet/' "$T/bPackages" > "$T/ovPackages"
fdroid_index com.openvolley.escoresheet,2.2.1,22020010,com.openvolley.escoresheet_22020010.apk > "$T/index-ov.json"
page "$T/ovPackages" "$T/index-ov.json"
if grep -q 'id="openbeach"' "$T/index.html"; then bad "page: OpenBeach section without any OpenBeach package"; fi
grep -q 'releases/download/desktop-v2.2.1/Setup_x64-setup.exe' "$T/index.html" || bad "page: OpenVolley Windows link"
grep -q 'href="/fdroid/repo/com.openvolley.escoresheet_22020010.apk"' "$T/index.html" || bad "page: OpenVolley APK"
grep -q 'It installs for all users and asks once' "$T/index.html" || bad "page: per-machine block missing for 2.2.1"
ok "page: OpenVolley only until OpenBeach is published"
fdroid_index com.openvolley.escoresheet,2.2.1,22020010,ov.apk com.openvolley.beach,2.0.0,20000000,com.openvolley.beach_20000000.apk > "$T/index-both.json"
page "$T/ovPackages" "$T/index-both.json"
grep -q 'id="openbeach"' "$T/index.html" && grep -q 'href="/fdroid/repo/com.openvolley.beach_20000000.apk"' "$T/index.html" ||
  bad "page: OpenBeach Android part"
if grep -q 'sudo sh -s openbeach-escoresheet' "$T/index.html"; then bad "page: OpenBeach desktop part without its .deb"; fi
ok "page: OpenBeach's Android part once its APK is published"
page "$T/bPackages" "$T/index-ov.json"
grep -q 'sudo sh -s openbeach-escoresheet' "$T/index.html" &&
  grep -q 'releases/download/beach-desktop-v2.0.1/Setup_x64-setup.exe' "$T/index.html" &&
  grep -q 'releases/tag/beach-desktop-v2.0.1' "$T/index.html" || bad "page: OpenBeach desktop part"
if grep -q 'com.openvolley.beach_' "$T/index.html"; then bad "page: OpenBeach Android part without its APK"; fi
grep -q 'releases/download/desktop-v2.2.1/' "$T/index.html" || bad "page: OpenVolley's version must be its own newest"
ok "page: OpenBeach's desktop part once its .deb is published; each app its own newest version"
page "$T/bPackages" "$T/index-both.json"
if grep -q '@[A-Z_]*@' "$T/index.html"; then bad "page: placeholders left"; fi
ok "page: both apps, every placeholder filled"
if grep -qE 'flatpak install|href="/flatpak/"' "$T/index.html"; then bad "page: Flatpak parts without a published Flatpak"; fi
mkdir -p "$T/flatpak"
touch "$T/flatpak/com.openvolley.escoresheet.flatpakref"
page "$T/bPackages" "$T/index-both.json"
grep -q 'flatpak install --user https://get.openvolley.app/flatpak/com.openvolley.escoresheet.flatpakref' "$T/index.html" &&
  grep -q 'href="/flatpak/"' "$T/index.html" || bad "page: OpenVolley's Flatpak part"
if grep -q 'com.openvolley.beach.flatpakref' "$T/index.html"; then bad "page: OpenBeach's Flatpak part without its .flatpakref"; fi
touch "$T/flatpak/com.openvolley.beach.flatpakref"
page "$T/bPackages" "$T/index-both.json"
grep -q 'flatpak install --user https://get.openvolley.app/flatpak/com.openvolley.beach.flatpakref' "$T/index.html" ||
  bad "page: OpenBeach's Flatpak part"
rm -rf "$T/flatpak"
ok "page: each app's Flatpak part once its .flatpakref is published"
noov() { fdroid_index com.openvolley.beach,2.0.0,20000000,b.apk > "$T/index-b.json"; page "$T/bPackages" "$T/index-b.json"; }
expect_fail "need at least one openvolley-escoresheet .deb and one com.openvolley.escoresheet APK" noov

echo "all $PASS checks passed"
