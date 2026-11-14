#!/usr/bin/env bash
# Offline test of the channel scripts that pin an installer's SHA-256
# (snap/bump.sh, aur/bump.sh, flatpak/bump.sh, scoop/update-manifests.sh,
# winget/update-manifests.sh, through lib/release-asset.sh): a hash is
# written only for a file whose .sig verifies against the updater key the app
# trusts, bound to the version and the file name, and every other case stops
# the script (no .sig, a replaced file, another version, another app's file,
# no node). With a THROWAWAY updater key; the scripts run on a copy of
# escoresheet/packaging, a fake curl serves the "GitHub release" from a
# folder, fake gh and makepkg answer the rest: no network, no Docker, the
# committed manifests are never touched.
#
#   escoresheet/packaging/lib/release-asset.test.sh
#
# Needs node, dpkg-deb, python3 and tauri-cli (OV_TAURI_CLI, default
# escoresheet/frontend/node_modules/.bin/tauri). OV_TEST_SRC=DIR runs the
# scripts of another checkout's escoresheet/ (to see the test fail on old code).
set -euo pipefail
umask 022

ESC=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
SRC=${OV_TEST_SRC:-$ESC}
TAURI=${OV_TAURI_CLI:-$ESC/frontend/node_modules/.bin/tauri}
T=$(mktemp -d "${TMPDIR:-/tmp}/ov-release-asset.XXXXXX")
trap 'rm -rf "$T"' EXIT

PASS=0
ok() { PASS=$((PASS + 1)); echo "ok   $*"; }
bad() { echo "FAIL $*" >&2; exit 1; }
# expect_fail TEXT CMD...: CMD fails, its output contains TEXT, and the
# manifests of the copy are unchanged.
expect_fail() {
  local want=$1 rc
  shift
  snapshot
  set +e
  "$@" > "$T/expect.out" 2>&1
  rc=$?
  set -e
  (( rc != 0 )) || { cat "$T/expect.out"; bad "expected failure ($want): $*"; }
  grep -qF -- "$want" "$T/expect.out" || bad "expected \"$want\" from $*, got: $(tail -5 "$T/expect.out")"
  unchanged || bad "a refused run changed a manifest: $*"
  ok "refuses: $want"
}
snapshot() { rm -rf "$T/before"; cp -a "$K/packaging" "$T/before"; }
unchanged() { diff -r "$T/before" "$K/packaging" >/dev/null; }
for t in node dpkg-deb python3 sha256sum; do command -v "$t" >/dev/null || { echo "skip: $t not installed" >&2; exit 0; }; done
[[ -x "$TAURI" ]] || { echo "skip: no tauri CLI at $TAURI (cd escoresheet/frontend && npm ci)" >&2; exit 0; }

# --- the copy, a throwaway key, a fake release ------------------------------------
K="$T/escoresheet"
mkdir -p "$K/deploy" "$K/frontend/src-tauri"
cp -r "$SRC/packaging" "$K/packaging"
cp -r "$SRC/deploy/lib" "$K/deploy/lib"
"$TAURI" signer generate --ci -p pw -w "$T/updater.key" </dev/null >/dev/null 2>&1
"$TAURI" signer generate --ci -p pw -w "$T/other.key" </dev/null >/dev/null 2>&1
for c in tauri.conf.json tauri.beach.conf.json; do
  node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ plugins: { updater: { pubkey: require("fs").readFileSync(process.argv[2], "utf8").trim() } } }))' \
    "$K/frontend/src-tauri/$c" "$T/updater.key.pub"
done
# (the committed configs are what the scripts trust; the copy holds the throwaway key)
export OV_DESKTOP_TAURI_CONF="$K/frontend/src-tauri/tauri.conf.json" OV_BEACH_TAURI_CONF="$K/frontend/src-tauri/tauri.beach.conf.json"

V=9.8.7
REL="$T/release"
mkdir -p "$REL"
# sign FILE [VERSION] [KEY]: FILE.sig as publish-pkgs.sh --desktop makes it.
sign() {
  rm -f "$1.sig"
  TAURI_SIGNING_PRIVATE_KEY_PATH="${3:-$T/updater.key}" TAURI_SIGNING_PRIVATE_KEY_PASSWORD=pw \
    "$TAURI" signer sign --app-version "${2:-$V}" "$1" </dev/null >/dev/null 2>&1
  [[ -s "$1.sig" ]] || bad "could not sign $1"
}
# make_deb OUT PACKAGE VERSION
make_deb() {
  local r="$T/debroot"
  rm -rf "$r"; mkdir -p "$r/DEBIAN" "$r/usr/bin"
  printf 'Package: %s\nVersion: %s\nArchitecture: amd64\nMaintainer: test <test@example.invalid>\nDescription: test\n' "$2" "$3" > "$r/DEBIAN/control"
  printf '#!/bin/sh\n# SNAP_NAME aware\n' > "$r/usr/bin/$2"; chmod 755 "$r/usr/bin/$2"
  dpkg-deb --root-owner-group -b "$r" "$1" >/dev/null
}
DEB=openvolley-escoresheet_${V}_amd64.deb
EXE=Openvolley.eScoresheet_${V}_x64-setup.exe
make_deb "$REL/$DEB" openvolley-escoresheet "$V"
{ printf 'MZ'; head -c 4000 /dev/urandom; } > "$REL/$EXE"
printf 'GPL\n' > "$REL/LICENSE"
sign "$REL/$DEB"; sign "$REL/$EXE"
cp -a "$REL" "$T/good"
restore() { rm -rf "$REL"; cp -a "$T/good" "$REL"; }

# Fake tools first on PATH: curl serves $REL by file name (any URL), gh and
# makepkg answer without the network or Arch.
mkdir -p "$T/bin"
cat > "$T/bin/curl" <<EOF
#!/usr/bin/env bash
out='' url=''
while (( \$# )); do
  case \$1 in -o) out=\$2; shift ;; -*) ;; *) url=\$1 ;; esac
  shift
done
url=\${url%%#*}
f="$REL/\${url##*/}"
[[ -f "\$f" ]] || { echo "curl: (22) 404 \$url" >&2; exit 22; }
if [[ -n "\$out" ]]; then cp "\$f" "\$out"; else cat "\$f"; fi
EOF
printf '#!/bin/sh\nexit 1\n' > "$T/bin/gh"
cat > "$T/bin/makepkg" <<'EOF'
#!/bin/sh
printf 'pkgbase = x\n\tpkgver = %s\n' "$(sed -n 's/^pkgver=//p' PKGBUILD)"
EOF
chmod 755 "$T/bin/"*
export PATH="$T/bin:$PATH"

snap() { "$K/packaging/snap/bump.sh" openvolley "$V"; }
aur() { "$K/packaging/aur/bump.sh" openvolley "$V"; }
flat() { "$K/packaging/flatpak/bump.sh" openvolley "$V"; }
scoop() { "$K/packaging/scoop/update-manifests.sh" openvolley "$V" "$@"; }
winget() { "$K/packaging/winget/update-manifests.sh" openvolley "$V" --date 2026-01-02 "$@"; }
sha() { sha256sum "$1" | cut -d' ' -f1; }

# --- signed files are pinned ---------------------------------------------------------
snap > "$T/out" 2>&1 || { cat "$T/out"; bad "snap/bump.sh with a signed .deb"; }
grep -qF "sha256/$(sha "$REL/$DEB")" "$K/packaging/snap/openvolley-escoresheet/snap/snapcraft.yaml" || bad "snap: hash not written"
ok "snap: a signed .deb is pinned"
aur > "$T/out" 2>&1 || { cat "$T/out"; bad "aur/bump.sh with a signed .deb"; }
grep -qF "sha256sums_x86_64=('$(sha "$REL/$DEB")')" "$K/packaging/aur/openvolley-escoresheet-bin/PKGBUILD" || bad "aur: hash not written"
ok "aur: a signed .deb is pinned"
flat > "$T/out" 2>&1 || { cat "$T/out"; bad "flatpak/bump.sh with a signed .deb"; }
grep -qF "$(sha "$REL/$DEB")" "$K/packaging/flatpak/com.openvolley.escoresheet.json" || bad "flatpak: hash not written"
ok "flatpak: a signed .deb is pinned"
scoop > "$T/out" 2>&1 || { cat "$T/out"; bad "scoop/update-manifests.sh with a signed installer"; }
grep -qF "\"$(sha "$REL/$EXE")\"" "$K/packaging/scoop/openvolley.json" || bad "scoop: hash not written"
ok "scoop: a signed installer is pinned"
winget > "$T/out" 2>&1 || { cat "$T/out"; bad "winget/update-manifests.sh with a signed installer"; }
grep -rqF "$(sha "$REL/$EXE" | tr 'a-f' 'A-F')" "$K/packaging/winget/manifests/l/Lucanepa/OpenVolley/$V" || bad "winget: hash not written"
ok "winget: a signed installer is pinned"
cp "$REL/$EXE" "$REL/$EXE.sig" "$T/"
scoop --file "$T/$EXE" > "$T/out" 2>&1 || { cat "$T/out"; bad "scoop --file with its .sig"; }
ok "scoop --file: a local copy with its .sig is pinned"

# --- everything else stops the script ------------------------------------------------
# no .sig on the release
rm "$REL/$DEB.sig"
expect_fail ".sig" snap
expect_fail ".sig" aur
expect_fail ".sig" flat
restore
rm "$REL/$EXE.sig"
expect_fail ".sig" scoop
expect_fail ".sig" winget
restore
# minisign missing does not skip the check (it is not used at all)
rm "$REL/$DEB.sig"
expect_fail ".sig" env PATH="$T/bin:/usr/bin:/bin" "$K/packaging/snap/bump.sh" openvolley "$V"
restore
# the asset replaced after it was signed
make_deb "$REL/$DEB" openvolley-escoresheet "$V"
expect_fail "signature does not match the file" snap
expect_fail "signature does not match the file" flat
restore
{ printf 'MZ'; head -c 4000 /dev/urandom; } > "$REL/$EXE"
expect_fail "signature does not match the file" scoop
expect_fail "signature does not match the file" winget
restore
# signed by another key
sign "$REL/$EXE" "$V" "$T/other.key"
expect_fail "signed by key" winget
restore
# signed for another version
sign "$REL/$DEB" 9.8.6
expect_fail "signed for version 9.8.6" aur
restore
# another signed file put in its place (same version, same key, other name)
cp "$REL/$EXE" "$T/OpenBeach_${V}_x64-setup.exe"; sign "$T/OpenBeach_${V}_x64-setup.exe"
cp "$T/OpenBeach_${V}_x64-setup.exe" "$REL/$EXE"; cp "$T/OpenBeach_${V}_x64-setup.exe.sig" "$REL/$EXE.sig"
expect_fail "the signature is for the file" scoop
restore
# --file without its .sig, or under another name
rm -f "$T/$EXE.sig"
expect_fail ".sig" scoop --file "$T/$EXE"
expect_fail ".sig" winget --file "$T/$EXE"
# no node: nothing is pinned
nonode="$T/nonode"; mkdir -p "$nonode"
for t in bash sh env cat cp mkdir mktemp rm sed grep cut tr sha256sum basename dirname python3 dpkg-deb head tail awk find date ls; do
  p=$(command -v "$t") && ln -sf "$p" "$nonode/$t"
done
expect_fail "node is needed" env PATH="$T/bin:$nonode" "$K/packaging/scoop/update-manifests.sh" openvolley "$V"
# the hash override that skipped every check is gone
expect_fail "unknown option --sha256" scoop --sha256 "$(sha "$REL/$EXE")"

echo "all $PASS checks passed"
