#!/usr/bin/env bash
# Offline tests for publish-pkgs.sh --desktop (lib/publish-lib.sh and
# lib/desktop-updater.mjs): signing, verification, latest.json, the public
# desktop/ tree and the key-material guard, with a THROWAWAY updater key made
# here. It never reads the real key, never calls GitHub, never syncs.
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

# make_deb OUT VERSION [PACKAGE]
make_deb() {
  local out=$1 ver=$2 pkg=${3:-openvolley-escoresheet} root="$T/debroot"
  rm -rf "$root"
  mkdir -p "$root/DEBIAN" "$root/usr/bin"
  printf 'Package: %s\nVersion: %s\nArchitecture: amd64\nMaintainer: test <test@example.invalid>\nDescription: test package\n' \
    "$pkg" "$ver" > "$root/DEBIAN/control"
  printf '#!/bin/sh\necho %s\n' "$ver" > "$root/usr/bin/openvolley-escoresheet"
  chmod 755 "$root/usr/bin/openvolley-escoresheet"
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

# --- publish-pkgs.sh argument handling (dies before any key or network use) --
pp() { "$KIT_DIR/publish-pkgs.sh" "$@"; }
expect_fail "--staging needs --desktop VERSION" pp --staging --no-sync
expect_fail "--desktop needs a version" pp --no-sync --desktop
expect_fail "not a version like 2.2.0" pp --desktop banana --no-sync
expect_fail "--desktop given twice" pp --desktop 2.2.0 --desktop 2.2.1 --no-sync
expect_fail "OV_DESKTOP_RELEASE_DIR is for tests: use it with --no-sync" pp --desktop 2.2.0
expect_fail "no signing key in $OV_PKGS_HOME" pp --desktop v2.2.0 --staging --no-sync
pp --help | grep -q -- '--desktop VERSION \[--staging\]' && ok "--help documents --desktop"

if [[ -n "${OV_TEST_KEEP:-}" ]]; then
  # For a cross-check outside this script: the signed files, latest.json and the test pubkey.
  mkdir -p "$OV_TEST_KEEP"
  cp "$DESKTOP_EXE"* "$DESKTOP_APPIMAGE"* "$DESKTOP_DEB"* "$L" "$T/keys/updater.key.pub" "$OV_TEST_KEEP/"
  echo "kept in $OV_TEST_KEEP"
fi
echo "all $PASS checks passed"
