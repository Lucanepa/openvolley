#!/usr/bin/env bash
# Rebuild and publish the public package repos behind https://get.openvolley.app
#
#   escoresheet/deploy/publish-pkgs.sh [--no-sync] [FILE.deb | FILE.apk ...]
#   escoresheet/deploy/publish-pkgs.sh --desktop VERSION [--app beach] [--staging] [--flatpak] [--no-sync] [FILE.apk ...]
#
# Runs on lenovoserver (never on the VM: the signing keys live only here).
#
# Two apps share this repo: OpenVolley eScoresheet (APT openvolley-escoresheet,
# Android com.openvolley.escoresheet, desktop tags desktop-v*) and OpenBeach
# (openbeach-escoresheet, com.openvolley.beach, beach-desktop-v*). --app beach
# makes --desktop handle an OpenBeach desktop release: tag beach-desktop-vVERSION,
# manifests in public/desktop/beach/, the tauri.beach.conf.json key, and its
# GitHub release never becomes "Latest" (OpenVolley's updater falls back to
# GitHub's "Latest"; OpenBeach's to the beach-desktop-latest prerelease,
# which gets its latest.json). Without --app it is OpenVolley, as before.
#
#   0. --desktop VERSION (a desktop app release; replaces downloading the .deb
#      by hand): downloads the Windows installer, the AppImage and the .deb of
#      the GitHub release desktop-vVERSION and checks each is that version
#      (and the macOS updater archive *_universal.app.tar.gz when the release
#      has one: latest.json then announces darwin-aarch64 and darwin-x86_64;
#      without it, no macOS update);
#      signs each with the updater key (tauri signer, signature bound to
#      VERSION); verifies each signature against the key the app trusts
#      (plugins.updater.pubkey in tauri.conf.json, also with minisign when it is
#      installed); writes latest.json (tauri-plugin-updater format; notes from
#      the fastlane changelog of that version). The .deb then goes through 1.
#      like any other (with --staging it enters the pool but not the index,
#      see 2.). After step 4 the manifest goes to public/desktop/:
#      latest-VERSION.json and staging.json always, latest.json unless
#      --staging (then only clients started with
#      OPENVOLLEY_UPDATE_CHANNEL=staging see it). After the sync the .sig files,
#      and latest.json unless --staging, go to the GitHub release (the
#      updater's fallback endpoint), which is then made GitHub's "Latest"
#      unless --staging. Needs gh, node and tauri-cli >= 2.12
#      (escoresheet/frontend: npm ci). OV_DESKTOP_RELEASE_DIR=DIR takes the
#      installers from DIR instead of GitHub (tests; only with --no-sync).
#   1. Adds the given packages: a .deb goes to the APT pool, a signed .apk to
#      the F-Droid repo. An APK must already be signed with its app's own key
#      (lib/publish-lib.sh app_cert_sha256: OpenVolley's from ANDROID.md,
#      OpenBeach's from ~/.config/openbeach-android/cert.sha256); any other app
#      id or key is refused. Nothing is ever re-signed.
#      APT packages: openvolley-escoresheet and openbeach-escoresheet (each
#      with the command /usr/bin/<package>); any other name is refused, except
#      OpenVolley's old names: a .deb named openvolley-e-scoresheet (Tauri
#      builds up to 1.48.19) or openvolley is repacked first:
#      same version, depends and files, plus Provides/Replaces/Conflicts:
#      openvolley-e-scoresheet, openvolley (and its own old name), so
#      `apt install openvolley-escoresheet` takes over an old install. Old-name
#      files already in the pool are migrated the same way. Repacking is
#      deterministic: the same input always gives the same bytes. A .deb given
#      by hand that is newer than desktop/latest.json is refused (use
#      --desktop VERSION).
#   2. Rebuilds the APT index (Packages, Release, InRelease, Release.gpg) and
#      exports the public key as apt/openvolley.gpg and apt/openvolley.asc.
#      The index never lists a desktop version newer than its app's latest.json
#      (desktop/ or desktop/beach/; lib/publish-lib.sh, APT hold-back): the in-app .deb updater installs
#      APT's newest, so a staging .deb, or one the kill switch withdrew from
#      latest.json, stays in the pool but out of the index.
#   3. Rebuilds the F-Droid index (fdroid update) and copies repo/ over.
#   3b. --flatpak (with --desktop, never with --staging: Flatpak users would get
#      it at once): builds the signed .deb as a Flatpak and commits it, signed,
#      into public/flatpak/repo/ (../packaging/flatpak/publish-flatpak.sh;
#      needs flatpak, flatpak-builder, ostree and the Flatpak repo key in
#      flatpak-gpg/). Without --flatpak public/flatpak/ is left as it is (and
#      still synced): run publish-flatpak.sh VERSION by hand, then this script.
#   4. Copies the landing page and the installer (pkgs/index.html, pkgs/install.sh).
#      The page's OpenBeach section appears once an OpenBeach .deb or APK is
#      published; install.sh takes the package name (default openvolley-escoresheet).
#   5. Refuses if anything key-like ended up in the public tree, then rsyncs
#      that tree to ${OV_PKGS_DEST} (default hetzner:/data/openvolley/pkgs/),
#      unless --no-sync.
#
# Layout under ${OV_PKGS_HOME} (default ~/.config/openvolley-pkgs, mode 700):
#   gnupg/            APT signing key (GNUPGHOME). Vaultwarden: "OpenVolley APT signing key"
#   gpg-passphrase    its passphrase (mode 600)
#   fdroid/           fdroid working dir: config.yml + keystore.p12 (repo signing
#                     key, Vaultwarden: "OpenVolley F-Droid repo key"), metadata/, repo/
#   public/           the served tree, rebuilt here and mirrored to the server:
#                       index.html  install.sh  apt/{dists,pool,openvolley.gpg,openvolley.asc}  fdroid/repo/
#                       desktop/{latest,staging,latest-<version>}.json
#                       desktop/beach/{latest,staging,latest-<version>}.json (OpenBeach)
#                       flatpak/{repo/,openvolley.flatpakrepo,<app id>.flatpakref,openvolley-flatpak.gpg}
#   flatpak-gpg/      Flatpak repo signing key (GNUPGHOME), flatpak-gpg-passphrase its
#                     passphrase. Vaultwarden: "OpenVolley Flatpak repo key"
# Desktop updater key under ${OV_DESKTOP_KEYS} (default ~/.config/openvolley-desktop):
#   updater.key       tauri signer private key, key-password its password (both
#                     mode 600). Vaultwarden: "OpenVolley desktop updater key"
#
# Only public/ ever leaves this machine. Removing a .deb from public/apt/pool/main
# or an .apk from fdroid/repo and re-running un-publishes it.
set -euo pipefail
umask 022

PKGS=${OV_PKGS_HOME:-$HOME/.config/openvolley-pkgs}
DEST=${OV_PKGS_DEST:-hetzner:/data/openvolley/pkgs/}
KIT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
APT_SIGNER_FPR=AB469DA8DC3EC90F8057320D285B18D76C16B82C
# The Android signing certificate of each app id: APP_CERT_SHA256 below (from
# lib/publish-lib.sh: OPENVOLLEY_APP_CERT_SHA256, OPENBEACH_APP_CERT_SHA256 /
# ~/.config/openbeach-android/cert.sha256).

PUB="$PKGS/public"
APT="$PUB/apt"
DIST="$APT/dists/stable"
FD="$PKGS/fdroid"
export GNUPGHOME="$PKGS/gnupg"

die() { echo "publish-pkgs: $*" >&2; exit 1; }
# shellcheck source=SCRIPTDIR/lib/publish-lib.sh
. "$KIT_DIR/lib/publish-lib.sh"
# app id -> SHA-256 of its signing certificate, for the APKs given below.
declare -A APP_CERT_SHA256=()

SYNC=1
FILES=()
DESKTOP_V=
STAGING=0
APP=
FLATPAK=0
while (( $# )); do
  case "$1" in
    --no-sync) SYNC=0 ;;
    --desktop)
      [[ -z "$DESKTOP_V" ]] || die "--desktop given twice"
      (( $# > 1 )) || die "--desktop needs a version"
      DESKTOP_V=${2#v}; shift
      desktop_version_ok "$DESKTOP_V" || die "--desktop $DESKTOP_V: not a version like 2.2.0"
      ;;
    --app)
      [[ -z "$APP" ]] || die "--app given twice"
      (( $# > 1 )) || die "--app needs openvolley or beach"
      APP=$2; shift
      [[ "$APP" == openvolley || "$APP" == beach ]] || die "--app $APP: expected openvolley or beach"
      ;;
    --staging) STAGING=1 ;;
    --flatpak) FLATPAK=1 ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) FILES+=("$1") ;;
  esac
  shift
done
(( ! STAGING )) || [[ -n "$DESKTOP_V" ]] || die "--staging needs --desktop VERSION"
[[ -z "$APP" ]] || [[ -n "$DESKTOP_V" ]] || die "--app needs --desktop VERSION"
(( ! FLATPAK )) || [[ -n "$DESKTOP_V" ]] || die "--flatpak needs --desktop VERSION (or run ../packaging/flatpak/publish-flatpak.sh VERSION, then this script)"
(( ! FLATPAK || ! STAGING )) || die "--flatpak cannot go with --staging: Flatpak users would get the staging version at once"
FLATPAK_PUBLISH="$KIT_DIR/../packaging/flatpak/publish-flatpak.sh"
desktop_app_select "${APP:-openvolley}"
[[ -z "$DESKTOP_RELEASE_DIR" ]] || (( ! SYNC )) || die "OV_DESKTOP_RELEASE_DIR is for tests: use it with --no-sync"

for t in dpkg-deb dpkg-scanpackages apt-ftparchive gpg gpgv fdroid rsync curl python3; do
  command -v "$t" >/dev/null || die "$t not found"
done
[[ -d "$GNUPGHOME" && -f "$PKGS/gpg-passphrase" ]] || die "no signing key in $PKGS (restore it from Vaultwarden)"
[[ -f "$FD/config.yml" && -f "$FD/keystore.p12" ]] || die "no F-Droid repo in $FD (restore it from Vaultwarden)"
[[ -z "$DESKTOP_V" ]] || desktop_check_setup
if (( FLATPAK )); then
  [[ -x "$FLATPAK_PUBLISH" ]] || die "$FLATPAK_PUBLISH not found"
  for t in flatpak flatpak-builder ostree; do command -v "$t" >/dev/null || die "--flatpak: $t not found"; done
  [[ -d "${OV_FLATPAK_GNUPG:-$PKGS/flatpak-gpg}" ]] || die "--flatpak: no Flatpak repo key in ${OV_FLATPAK_GNUPG:-$PKGS/flatpak-gpg} (publish-flatpak.sh --init-key, or restore it from Vaultwarden)"
fi

build_tool() {
  local bt
  bt=$(ls -d "${ANDROID_HOME:-$HOME/Android/Sdk}"/build-tools/* 2>/dev/null | sort -V | tail -1)
  [[ -x "$bt/$1" ]] || die "$1 not found in Android build-tools (set ANDROID_HOME)"
  "$bt/$1" "${@:2}"
}

# --- 1. add packages --------------------------------------------------------
# OpenVolley's package, and the names it was published under before (the
# package takes them over). OpenBeach has no old names.
OV_APT_NAME=openvolley-escoresheet
LEGACY_NAMES=(openvolley-e-scoresheet openvolley)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# --- 0. desktop release: fetch, sign, verify, latest.json -------------------
if [[ -n "$DESKTOP_V" ]]; then
  desktop_fetch "$DESKTOP_V" "$WORK/desktop"
  # (+ the macOS .app.tar.gz, when the release has one)
  desktop_sign "$DESKTOP_V" "$DESKTOP_EXE" "$DESKTOP_APPIMAGE" "$DESKTOP_DEB" ${DESKTOP_MAC:+"$DESKTOP_MAC"}
  desktop_verify "$DESKTOP_V" "$DESKTOP_EXE" "$DESKTOP_APPIMAGE" "$DESKTOP_DEB" ${DESKTOP_MAC:+"$DESKTOP_MAC"}
  desktop_manifest "$DESKTOP_V" "$WORK/desktop" "$WORK/desktop/latest.json"
  FILES+=("$DESKTOP_DEB")
fi
apt_hold_init "$PUB" "$DESKTOP_V" "$STAGING"

# add_rel CONTROL FIELD NAME: append NAME to FIELD (creating it) unless listed.
add_rel() {
  local control=$1 field=$2 name=$3
  if grep -q "^$field:" "$control"; then
    grep -Eq "^$field:(.*[ ,])?$name( *(\(|,|$))" "$control" || sed -i "s/^$field: .*/&, $name/" "$control"
  else
    sed -i "/^Description:/i $field: $name" "$control"
  fi
}

# repack_deb IN OUT: rewrite IN (an OpenVolley .deb under an old Package name)
# as $OV_APT_NAME. Same version, depends, maintainer scripts and files; adds
# Provides/Replaces/Conflicts for the legacy names and IN's own name, and makes
# sure /usr/bin/$OV_APT_NAME exists (a symlink to /usr/bin/openvolley if only that
# is there). Every mtime is set to the newest one in IN and dpkg-deb builds with
# fixed owner, compressor and thread count, so the same IN gives the same bytes.
repack_deb() {
  local in=$1 out=$2 root="$WORK/repack" old epoch f n
  old=$(dpkg-deb -f "$in" Package)
  rm -rf "$root"
  dpkg-deb -R "$in" "$root"
  if [[ ! -e "$root/usr/bin/$OV_APT_NAME" ]]; then
    [[ -e "$root/usr/bin/openvolley" ]] || die "$in: package $old has neither /usr/bin/$OV_APT_NAME nor /usr/bin/openvolley; not an OpenVolley desktop .deb"
  fi
  # Newest mtime among the packaged files (tar restored them; the top dir and
  # DEBIAN/ were created just now and do not count).
  epoch=$(find "$root" -mindepth 1 ! -path "$root/DEBIAN" ! -path "$root/DEBIAN/*" -printf '%T@\n' | sort -n | tail -1)
  epoch=${epoch%.*}
  [[ "$epoch" =~ ^[0-9]+$ ]] || die "$in: no files to take a timestamp from"
  for f in Provides Replaces Conflicts; do
    for n in "${LEGACY_NAMES[@]}" "$old"; do
      add_rel "$root/DEBIAN/control" "$f" "$n"
    done
  done
  sed -i "s/^Package: .*/Package: $OV_APT_NAME/" "$root/DEBIAN/control"
  if [[ ! -e "$root/usr/bin/$OV_APT_NAME" ]]; then
    ln -s openvolley "$root/usr/bin/$OV_APT_NAME"
  fi
  find "$root" -exec touch -h -d "@$epoch" {} +
  SOURCE_DATE_EPOCH=$epoch dpkg-deb --root-owner-group --threads-max=1 -Zxz -z9 -b "$root" "$out" >/dev/null
  rm -rf "$root"
}

# legacy_name NAME: one of OpenVolley's old package names.
legacy_name() {
  local n
  for n in "${LEGACY_NAMES[@]}"; do [[ "$1" != "$n" ]] || return 0; done
  return 1
}

# add_deb FILE: put FILE in the pool as <package>_<version>_amd64.deb, its
# package one of APT_NAMES (an OpenVolley old name is repacked first).
add_deb() {
  local f=$1 pkg ver arch target files
  pkg=$(dpkg-deb -f "$f" Package); ver=$(dpkg-deb -f "$f" Version); arch=$(dpkg-deb -f "$f" Architecture)
  [[ -n "$pkg" && -n "$ver" && "$arch" == amd64 ]] || die "$f: not an amd64 .deb"
  if legacy_name "$pkg"; then
    repack_deb "$f" "$WORK/repacked.deb"
    echo "repacked $f ($pkg) as $OV_APT_NAME $ver"
    f="$WORK/repacked.deb" pkg=$OV_APT_NAME
  fi
  apt_name_ok "$pkg" || die "$f: package $pkg is not published here (${APT_NAMES[*]})"
  # Whole listing first: grep -q exiting early would kill dpkg-deb (pipefail).
  files=$(dpkg-deb -c "$f") || die "$f: cannot list its files"
  grep -Eq " (\./)?usr/bin/$pkg( |$)" <<<"$files" || die "$f: no /usr/bin/$pkg in the package"
  target="$APT/pool/main/${pkg}_${ver}_${arch}.deb"
  if [[ -e "$target" ]] && ! cmp -s "$f" "$target"; then
    die "$target exists with different content; bump the version instead (apt and caches treat versions as immutable)"
  fi
  install -m 644 "$f" "$target"
  echo "added $target"
}

mkdir -p "$APT/pool/main" "$FD/repo"
for f in "${FILES[@]}"; do
  [[ -f "$f" ]] || die "$f: no such file"
  case "$f" in
    *.deb)
      ver=$(dpkg-deb -f "$f" Version) || die "$f: not a .deb"
      pkg=$(dpkg-deb -f "$f" Package)
      if legacy_name "$pkg"; then pkg=$OV_APT_NAME; fi
      if [[ "$f" != "$DESKTOP_DEB" ]] && apt_held "$ver" "$pkg"; then
        app=openvolley; [[ "$pkg" != openbeach-escoresheet ]] || app=beach
        die "$f: version $ver is not announced by ${APP_DESKTOP_DIR[$app]}/latest.json, so APT would not list it; publish desktop releases with --desktop $ver$([[ $app == beach ]] && echo ' --app beach') [--staging]"
      fi
      add_deb "$f"
      ;;
    *.apk)
      certs=$(build_tool apksigner verify --print-certs "$f") || die "$f: not a validly signed APK"
      badging=$(build_tool aapt2 dump badging "$f" | sed -n '/^package:/p')
      app_id=$(sed -E "s/^package: name='([^']+)'.*/\1/" <<<"$badging")
      code=$(sed -E "s/.*versionCode='([0-9]+)'.*/\1/" <<<"$badging")
      [[ -n "${APP_CERT_SHA256[$app_id]:-}" ]] || APP_CERT_SHA256[$app_id]=$(app_cert_sha256 "$app_id")
      grep -q "SHA-256 digest: ${APP_CERT_SHA256[$app_id]}" <<<"$certs" || die "$f: $app_id is not signed with its app key"
      target="$FD/repo/${app_id}_${code}.apk"
      if [[ -e "$target" ]] && ! cmp -s "$f" "$target"; then
        die "$target exists with different content; raise versionCode instead (ANDROID.md, Version rule)"
      fi
      install -m 644 "$f" "$target"
      echo "added $target"
      ;;
    *) die "$f: expected a .deb or .apk" ;;
  esac
done
# Old-name packages still in the pool: repack them (unless that version is
# already there as $OV_APT_NAME, which then wins), then drop the original.
for f in "$APT/pool/main"/*.deb; do
  [[ -e "$f" ]] || continue
  pkg=$(dpkg-deb -f "$f" Package)
  ! apt_name_ok "$pkg" || continue
  legacy_name "$pkg" || die "$f: package $pkg in the pool is not published here (${APT_NAMES[*]}); remove it"
  ver=$(dpkg-deb -f "$f" Version)
  if [[ ! -e "$APT/pool/main/${OV_APT_NAME}_${ver}_amd64.deb" ]]; then
    cp "$f" "$WORK/old.deb"
    add_deb "$WORK/old.deb"
  fi
  rm -f "$f"
  echo "removed $f ($pkg $ver)"
done

# --- 2. APT -----------------------------------------------------------------
mkdir -p "$DIST/main/binary-amd64"
gpg_sign() {
  gpg --batch --yes --pinentry-mode loopback --passphrase-file "$PKGS/gpg-passphrase" \
    --local-user "$APT_SIGNER_FPR" "$@"
}

(
  cd "$APT"
  # Paths in Packages are relative to the repo root (apt/). --multiversion keeps
  # every version installable (rollback: apt install <pkg>=<old version>).
  dpkg-scanpackages --multiversion --arch amd64 pool/main > "$DIST/main/binary-amd64/Packages"
)
apt_hold_packages "$DIST/main/binary-amd64/Packages"
gzip -9nkf "$DIST/main/binary-amd64/Packages"

conf="$WORK/apt-ftparchive.conf"
cat > "$conf" <<'CONF'
APT::FTPArchive::Release::Origin "OpenVolley";
APT::FTPArchive::Release::Label "OpenVolley";
APT::FTPArchive::Release::Suite "stable";
APT::FTPArchive::Release::Codename "stable";
APT::FTPArchive::Release::Architectures "amd64";
APT::FTPArchive::Release::Components "main";
APT::FTPArchive::Release::Description "OpenVolley eScoresheet and OpenBeach desktop apps (https://get.openvolley.app)";
CONF
apt-ftparchive -c "$conf" release "$DIST" > "$DIST/Release.tmp"
mv "$DIST/Release.tmp" "$DIST/Release"
rm -f "$DIST/InRelease" "$DIST/Release.gpg"
gpg_sign --clearsign -o "$DIST/InRelease" "$DIST/Release"
gpg_sign -abs -o "$DIST/Release.gpg" "$DIST/Release"

gpg --batch --yes --export "$APT_SIGNER_FPR" > "$APT/openvolley.gpg"
gpg --batch --yes --armor --export "$APT_SIGNER_FPR" > "$APT/openvolley.asc"
# Check the signatures against exactly the keyring users download.
gpgv --keyring "$APT/openvolley.gpg" "$DIST/InRelease" 2>/dev/null || die "InRelease does not verify"
gpgv --keyring "$APT/openvolley.gpg" "$DIST/Release.gpg" "$DIST/Release" 2>/dev/null || die "Release.gpg does not verify"

# --- 3. F-Droid -------------------------------------------------------------
(cd "$FD" && fdroid update -q)
mkdir -p "$PUB/fdroid"
# status/ is fdroidserver's run log (host OS, tool paths); clients never read it.
rsync -a --delete --delete-excluded --exclude=/status/ "$FD/repo/" "$PUB/fdroid/repo/"

# --- 3b. Flatpak (--flatpak) --------------------------------------------------
# The signed .deb (same bytes as the pool's, checked below) into the Flatpak repo.
if (( FLATPAK )); then
  OV_PKGS_HOME="$PKGS" "$FLATPAK_PUBLISH" --app "${APP:-openvolley}" --deb "$DESKTOP_DEB" "$DESKTOP_V"
fi

# --- 4. landing page and installer -----------------------------------------
# The newest .deb and APK of each app fill the version links in the template
# (lib/publish-lib.sh landing_page; OpenBeach's section only once published).
landing_page "$KIT_DIR/pkgs/index.html" "$DIST/main/binary-amd64/Packages" "$FD/repo/index-v2.json" "$PUB/index.html"
# curl -fsSL https://get.openvolley.app/install.sh | sudo sh [-s openbeach-escoresheet]
check_install_sh "$KIT_DIR/pkgs/install.sh" "$APT_SIGNER_FPR"
install -m 644 "$KIT_DIR/pkgs/install.sh" "$PUB/install.sh"

# The deb the updater announces is the pool file: same bytes as the signed one.
if [[ -n "$DESKTOP_V" ]]; then
  cmp -s "$DESKTOP_DEB" "$APT/pool/main/${DESKTOP_DEB_NAME}_${DESKTOP_V}_amd64.deb" ||
    die "pool .deb for $DESKTOP_V differs from the signed one"
  desktop_publish_tree "$DESKTOP_V" "$STAGING" "$WORK/desktop/latest.json" "$PUB"
fi

# --- 5. check and sync ------------------------------------------------------
refuse_key_material "$PUB"
chmod -R u=rwX,go=rX "$PUB"

echo "published:"
grep -E '^(Package|Version):' "$DIST/main/binary-amd64/Packages" | paste - - | sed 's/^/  apt     /'
python3 - "$FD/repo/index-v2.json" <<'EOF'
import json, sys
d = json.load(open(sys.argv[1]))
for app, p in d["packages"].items():
    for v in p["versions"].values():
        m = v["manifest"]
        print(f"  fdroid  {app} {m['versionName']} ({m['versionCode']})")
EOF
for f in "$PUB"/desktop/latest.json "$PUB"/desktop/staging.json "$PUB"/desktop/beach/latest.json "$PUB"/desktop/beach/staging.json; do
  if [[ -f "$f" ]]; then
    echo "  $(dirname "${f#"$PUB"/}") $(basename "$f" .json) $(manifest_version "$f")"
  fi
done
if [[ -f "$PUB/flatpak/repo/config" ]] && command -v ostree >/dev/null; then
  for r in $(ostree --repo="$PUB/flatpak/repo" refs | grep '^app/'); do
    echo "  flatpak $r: $(ostree --repo="$PUB/flatpak/repo" log "$r" | awk '/^    [^ ]/ { sub(/^ +/, ""); print; exit }')"
  done
fi

if (( SYNC )); then
  # --delay-updates puts every changed file in place at the end, so a client
  # never sees a new index that points at a package not uploaded yet.
  # The Flatpak repo's tmp/ and .lock are OSTree's own working files.
  rsync -rlt --delete-after --delay-updates --chmod=D755,F644 \
    --exclude=/flatpak/repo/tmp/ --exclude=/flatpak/repo/.lock "$PUB/" "$DEST"
  echo "synced to $DEST"
  # Only now: latest.json on GitHub must not point at a .deb not yet in the pool.
  [[ -z "$DESKTOP_V" ]] || desktop_upload "$DESKTOP_V" "$STAGING" "$WORK/desktop"
else
  echo "not synced (--no-sync); tree: $PUB"
  if [[ -n "$DESKTOP_V" ]]; then
    if (( STAGING )); then up="the .sig files"; else up="the .sig files and latest.json"; fi
    echo "not uploaded to $(desktop_tag "$DESKTOP_V") (--no-sync): $up"
  fi
fi
