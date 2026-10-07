# shellcheck shell=bash
# Functions for publish-pkgs.sh (sourced, never run). The test harness
# tests/publish-desktop.test.sh sources this too, with throwaway keys.
#
# The caller defines die() and KIT_DIR (escoresheet/deploy), and runs under
# set -euo pipefail.
#
# Two apps are published here: OpenVolley eScoresheet and OpenBeach (the same
# desktop shell, src-tauri/src/flavour.rs; their own Android apps). Each has
# its own .deb, app id, Android key, GitHub release tags and update manifests:
#   desktop_app_select APP      openvolley (the default) or beach: sets the
#                               DESKTOP_* variables the steps below use
#   apt_name_ok NAME            NAME is one of the APT packages published here
#   app_cert_sha256 APPID       the signing certificate an APK of APPID needs
#   check_install_sh FILE       pkgs/install.sh pins the key and the packages
#   landing_page TEMPLATE PACKAGES INDEXV2 OUT   pkgs/index.html filled in
#   pacman_repo_fpr ARCHDIR     the published pacman repo key's fingerprint (checked)
#
# Desktop updater release (publish-pkgs.sh --desktop VERSION [--staging] [--app APP]):
#   desktop_check_setup         tools, key files, tauri CLI >= 2.12, trusted pubkey
#   desktop_fetch V DIR         the three installers of desktop-vV into DIR, and
#                               the macOS .app.tar.gz when the release has one
#   desktop_sign V FILE...      FILE.sig, bound to version V (tauri signer)
#   desktop_verify V FILE...    each FILE.sig against the key the app trusts
#   desktop_notes V OUT         What's new text (fastlane changelog) into OUT
#   desktop_manifest V DIR OUT  latest.json for the files desktop_fetch found
#   desktop_publish_tree V STAGING MANIFEST PUBDIR
#   desktop_upload V STAGING DIR   .sig files (+ latest.json) to the GitHub release
#                                  (OpenBeach: latest.json to beach-desktop-latest only)
# the APT hold-back (the index never runs ahead of desktop/latest.json):
#   apt_hold_init PUBDIR [V STAGING]   which desktop versions APT must not list yet
#   apt_held VER                       true if VER is held back
#   apt_hold_packages PACKAGES         drops held-back stanzas from a Packages file
# and the public-tree guard:
#   refuse_key_material PUBDIR

OV_GH_REPO=Lucanepa/openvolley
APT_POOL_URL=https://get.openvolley.app/apt/pool/main
# One updater key for both desktop apps (their Tauri configs pin the same public key).
DESKTOP_KEYS=${OV_DESKTOP_KEYS:-$HOME/.config/openvolley-desktop}
# The key the app trusts is the one committed in its Tauri config, so signatures
# are checked against that, never against the .pub file next to the private key.
OPENVOLLEY_TAURI_CONF=${OV_DESKTOP_TAURI_CONF:-$KIT_DIR/../frontend/src-tauri/tauri.conf.json}
OPENBEACH_TAURI_CONF=${OV_BEACH_TAURI_CONF:-$KIT_DIR/../frontend/src-tauri/tauri.beach.conf.json}
TAURI_CLI=${OV_TAURI_CLI:-$KIT_DIR/../frontend/node_modules/.bin/tauri}
# Test input instead of `gh release download` (publish-pkgs.sh allows it with --no-sync only).
DESKTOP_RELEASE_DIR=${OV_DESKTOP_RELEASE_DIR:-}
UPDATER_JS="$KIT_DIR/lib/desktop-updater.mjs"
# What's new: the Android changelogs (fastlane) of each app. OpenBeach's come
# from the openbeach checkout next to this repo's root (as for the desktop build).
FASTLANE_CHANGELOGS="$KIT_DIR/../../fastlane/metadata/android/en-US/changelogs"
BEACH_CHANGELOGS=${OV_BEACH_CHANGELOGS:-$KIT_DIR/../../openbeach/fastlane/metadata/android/en-US/changelogs}

# The APT packages this repository publishes, one per desktop app.
APT_NAMES=(openvolley-escoresheet openbeach-escoresheet)
# Every app's package, for the APT hold-back: app -> package, app -> manifest dir.
declare -A APP_DEB_NAME=([openvolley]=openvolley-escoresheet [beach]=openbeach-escoresheet)
declare -A APP_DESKTOP_DIR=([openvolley]=desktop [beach]=desktop/beach)

# Set by desktop_app_select.
DESKTOP_APP='' DESKTOP_NAME='' DESKTOP_TAG_PREFIX='' DESKTOP_DEB_NAME='' DESKTOP_DIR=''
DESKTOP_TAURI_CONF='' DESKTOP_MAKE_LATEST='' DESKTOP_FALLBACK_TAG='' DESKTOP_ID=''
# Set by desktop_fetch (DESKTOP_MAC empty: the release has no macOS build).
DESKTOP_EXE='' DESKTOP_APPIMAGE='' DESKTOP_DEB='' DESKTOP_MAC=''

# desktop_app_select APP: which app's desktop release the desktop_* steps handle.
#   openvolley  tags desktop-vV, package openvolley-escoresheet, manifests in
#               desktop/, its release becomes GitHub's "Latest" (the updater's
#               fallback is releases/latest/download/latest.json)
#   beach       tags beach-desktop-vV, package openbeach-escoresheet, manifests
#               in desktop/beach/, never "Latest": its updater's GitHub fallback
#               is the beach-desktop-latest prerelease, which gets latest.json
desktop_app_select() {
  case "$1" in
    openvolley)
      DESKTOP_APP=openvolley DESKTOP_NAME=OpenVolley DESKTOP_TAG_PREFIX=desktop-v DESKTOP_ID=com.openvolley.escoresheet
      DESKTOP_TAURI_CONF=$OPENVOLLEY_TAURI_CONF DESKTOP_MAKE_LATEST=1 DESKTOP_FALLBACK_TAG='' ;;
    beach)
      DESKTOP_APP=beach DESKTOP_NAME=OpenBeach DESKTOP_TAG_PREFIX=beach-desktop-v DESKTOP_ID=com.openvolley.beach
      DESKTOP_TAURI_CONF=$OPENBEACH_TAURI_CONF DESKTOP_MAKE_LATEST=0 DESKTOP_FALLBACK_TAG=beach-desktop-latest ;;
    *) die "unknown app $1 (openvolley or beach)" ;;
  esac
  DESKTOP_DEB_NAME=${APP_DEB_NAME[$1]} DESKTOP_DIR=${APP_DESKTOP_DIR[$1]}
}
desktop_app_select openvolley

apt_name_ok() {
  local n
  for n in "${APT_NAMES[@]}"; do [[ "$1" != "$n" ]] || return 0; done
  return 1
}

# app_cert_sha256 APPID: the SHA-256 (lowercase hex) of the certificate every
# APK of APPID must be signed with (publish-pkgs.sh, F-Droid repo). Each app has
# its own key: OpenVolley's from ANDROID.md; OpenBeach's from
# $OPENBEACH_CERT_FILE (default ~/.config/openbeach-android/cert.sha256, written
# when its key was made; Vaultwarden "OpenBeach Android signing key") unless
# OPENBEACH_APP_CERT_SHA256 is filled in below. Any other app id is refused.
OPENVOLLEY_APP_CERT_SHA256=2c7f9db4da41f5475f36142403043e45452a3143baff764e3d511d686ddabe87
OPENBEACH_APP_CERT_SHA256=
OPENBEACH_CERT_FILE=${OV_BEACH_CERT_FILE:-$HOME/.config/openbeach-android/cert.sha256}
app_cert_sha256() {
  local cert
  case "$1" in
    com.openvolley.escoresheet) cert=$OPENVOLLEY_APP_CERT_SHA256 ;;
    com.openvolley.beach)
      cert=$OPENBEACH_APP_CERT_SHA256
      if [[ -z "$cert" && -r "$OPENBEACH_CERT_FILE" ]]; then
        cert=$(tr -d ' :\r\n' < "$OPENBEACH_CERT_FILE" | tr 'A-F' 'a-f')
      fi
      [[ -n "$cert" ]] ||
        die "no signing certificate for com.openvolley.beach: put its SHA-256 in $OPENBEACH_CERT_FILE (or OPENBEACH_APP_CERT_SHA256 in lib/publish-lib.sh)"
      [[ "$cert" != "$OPENVOLLEY_APP_CERT_SHA256" ]] ||
        die "the com.openvolley.beach certificate is OpenVolley's: OpenBeach must have its own Android key" ;;
    *) die "app id ${1:-?} is not published here (com.openvolley.escoresheet, com.openvolley.beach)" ;;
  esac
  [[ "$cert" =~ ^[0-9a-f]{64}$ ]] || die "the certificate SHA-256 for $1 is not 64 hex digits: $cert"
  printf '%s\n' "$cert"
}

# check_install_sh FILE: the one-line installer pins the APT key FPR, defaults
# to openvolley-escoresheet and installs only the packages published here.
check_install_sh() {
  local f=$1 fpr=$2
  sh -n "$f" || die "$f: syntax error"
  grep -q "^FPR=$fpr\$" "$f" || die "$f does not pin the APT key $fpr"
  grep -q "^DEFAULT_PKG=openvolley-escoresheet\$" "$f" || die "$f does not install openvolley-escoresheet by default"
  grep -qxF "PACKAGES=\"${APT_NAMES[*]}\"" "$f" || die "$f does not allow exactly the packages ${APT_NAMES[*]}"
}

updater() { node "$UPDATER_JS" "$@"; }

desktop_version_ok() {
  [[ "$1" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]]
}

# --- landing page ---------------------------------------------------------------
# github_setup_exe_url TAG: the Windows installer (-setup.exe, named after the
# app's productName) of the GitHub release TAG; offline or not found, the
# release page.
github_setup_exe_url() {
  local rel="https://github.com/$OV_GH_REPO/releases/tag/$1" url
  url=$(curl -fsS --max-time 20 "https://api.github.com/repos/$OV_GH_REPO/releases/tags/$1" 2>/dev/null |
    python3 -c 'import json, sys; print(next(a["browser_download_url"] for a in json.load(sys.stdin)["assets"] if a["name"].lower().endswith("-setup.exe")))' 2>/dev/null) || url=$rel
  [[ "$url" =~ ^https://github\.com/Lucanepa/openvolley/releases/[A-Za-z0-9._/%+-]+$ ]] || url=$rel
  printf '%s\n' "$url"
}

# github_dmg_url TAG: the macOS disk image (*_universal.dmg) of the GitHub
# release TAG; nothing when GitHub lists the release without one (built
# before macOS, or its macOS job failed); the release page when GitHub cannot
# be asked.
github_dmg_url() {
  local rel="https://github.com/$OV_GH_REPO/releases/tag/$1" json url
  json=$(curl -fsS --max-time 20 "https://api.github.com/repos/$OV_GH_REPO/releases/tags/$1" 2>/dev/null) || { printf '%s\n' "$rel"; return 0; }
  url=$(python3 -c 'import json, sys; print(next((a["browser_download_url"] for a in json.load(sys.stdin)["assets"] if a["name"].endswith("_universal.dmg")), ""))' <<<"$json" 2>/dev/null) || url=$rel
  [[ -z "$url" || "$url" =~ ^https://github\.com/Lucanepa/openvolley/releases/[A-Za-z0-9._/%+-]+$ ]] || url=$rel
  printf '%s\n' "$url"
}

# newest_deb PACKAGES NAME: the newest version of NAME in an APT Packages file.
newest_deb() {
  awk -v want="$2" '/^Package:/ { p = $2 } /^Version:/ && p == want { print $2 }' "$1" | sort -V | tail -1
}

# newest_apk INDEXV2 APPID: "<versionName> <file>" of APPID's highest
# versionCode in the F-Droid index; nothing when the app is not there.
newest_apk() {
  python3 - "$1" "$2" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
p = d.get("packages", {}).get(sys.argv[2])
if p and p.get("versions"):
    v = max(p["versions"].values(), key=lambda v: v["manifest"]["versionCode"])
    print(v["manifest"]["versionName"], v["file"]["name"].lstrip("/"))
PY
}

# landing_page TEMPLATE PACKAGES INDEXV2 OUT: pkgs/index.html with the newest
# published versions. OpenVolley's .deb and APK must be there. The OpenBeach
# section (<!--beach--> ... <!--/beach-->) is left out until something of it
# is published, and within it the desktop (<!--beach-desktop-->) or Android
# (<!--beach-android-->) part until that is. Each app's macOS part
# (<!--mac-->, <!--beach-mac-->) only when its GitHub release has a .dmg.
# The Flatpak parts and the pacman card (<!--pacman-->) once those are
# published next to OUT (OUT's directory: flatpak/, arch/).
landing_page() {
  local template=$1 packages=$2 index=$3 out=$4 ver apk_ver='' apk_file='' win_url mac_url
  local b_ver b_apk_ver='' b_apk_file='' b_win='' b_mac='' sed_args=()
  ver=$(newest_deb "$packages" openvolley-escoresheet)
  read -r apk_ver apk_file < <(newest_apk "$index" com.openvolley.escoresheet) || true
  [[ -n "$ver" && -n "$apk_file" ]] || die "need at least one openvolley-escoresheet .deb and one com.openvolley.escoresheet APK"
  win_url=$(github_setup_exe_url "desktop-v$ver")
  mac_url=$(github_dmg_url "desktop-v$ver")
  [[ -n "$mac_url" ]] || sed_args+=(-e '/<!--mac/,/<!--\/mac-->/d')
  # The per-machine Windows installer (administrator prompt, firewall rule for
  # the tablets) comes after 2.1.0: up to 2.1.0 the linked setup.exe installs
  # per user, so the <!--per-machine--> block of the page is left out.
  local per_user_until=2.1.0
  [[ "$ver" != "$per_user_until" && "$(printf '%s\n' "$per_user_until" "$ver" | sort -V | tail -1)" == "$ver" ]] ||
    sed_args+=(-e '/<!--per-machine/,/<!--\/per-machine-->/d')

  b_ver=$(newest_deb "$packages" openbeach-escoresheet)
  read -r b_apk_ver b_apk_file < <(newest_apk "$index" com.openvolley.beach) || true
  if [[ -z "$b_ver" && -z "$b_apk_file" ]]; then
    sed_args+=(-e '/<!--beach-->/,/<!--\/beach-->/d')
  else
    if [[ -n "$b_ver" ]]; then
      b_win=$(github_setup_exe_url "beach-desktop-v$b_ver")
      b_mac=$(github_dmg_url "beach-desktop-v$b_ver")
      [[ -n "$b_mac" ]] || sed_args+=(-e '/<!--beach-mac-->/,/<!--\/beach-mac-->/d')
    else
      sed_args+=(-e '/<!--beach-desktop-->/,/<!--\/beach-desktop-->/d')
    fi
    [[ -n "$b_apk_file" ]] || sed_args+=(-e '/<!--beach-android-->/,/<!--\/beach-android-->/d')
  fi
  # Flatpak parts once publish-flatpak.sh published that app next to this page.
  local flat
  flat="$(dirname "$out")/flatpak"
  [[ -f "$flat/com.openvolley.escoresheet.flatpakref" ]] || sed_args+=(-e 's|<!--flatpak-->.*<!--/flatpak-->||' -e '/<!--flatpak-->/,/<!--\/flatpak-->/d')
  [[ -f "$flat/com.openvolley.beach.flatpakref" ]] || sed_args+=(-e '/<!--beach-flatpak-->/,/<!--\/beach-flatpak-->/d')
  # The pacman card once publish-pacman.sh published the repo next to this
  # page (its key's fingerprint filled in), each app's line once its package is.
  local arch fpr='' fpr_grouped=''
  arch="$(dirname "$out")/arch"
  if [[ -f "$arch/x86_64/openvolley.db" ]]; then
    fpr=$(pacman_repo_fpr "$arch")
    fpr_grouped=$(sed 's/..../& /g; s/ $//' <<<"$fpr")
    compgen -G "$arch/x86_64/openvolley-escoresheet-bin-*.pkg.tar.zst" >/dev/null ||
      sed_args+=(-e '/<!--pacman-ov-->/,/<!--\/pacman-ov-->/d')
    compgen -G "$arch/x86_64/openbeach-escoresheet-bin-*.pkg.tar.zst" >/dev/null ||
      sed_args+=(-e '/<!--beach-pacman-->/,/<!--\/beach-pacman-->/d')
  else
    sed_args+=(-e 's|<!--pacman-->.*<!--/pacman-->||' -e '/<!--pacman-->/,/<!--\/pacman-->/d')
  fi
  sed "${sed_args[@]}" \
    -e "s|@DESKTOP_VERSION@|$ver|g" -e "s|@DEB_PACKAGE@|openvolley-escoresheet|g" -e "s|@WINDOWS_URL@|$win_url|g" \
    -e "s|@MAC_URL@|$mac_url|g" -e "s|@BEACH_MAC_URL@|$b_mac|g" \
    -e "s|@APK_VERSION@|$apk_ver|g" -e "s|@APK_FILE@|$apk_file|g" \
    -e "s|@BEACH_DESKTOP_VERSION@|$b_ver|g" -e "s|@BEACH_WINDOWS_URL@|$b_win|g" \
    -e "s|@BEACH_APK_VERSION@|$b_apk_ver|g" -e "s|@BEACH_APK_FILE@|$b_apk_file|g" \
    -e "s|@PACMAN_FPR@|$fpr|g" -e "s|@PACMAN_FPR_GROUPED@|$fpr_grouped|g" \
    "$template" > "$out"
  ! grep -q '@[A-Z_]*@' "$out" || die "index.html has unfilled placeholders"
}

# pacman_repo_fpr ARCHDIR: the fingerprint in ARCHDIR/fingerprint.txt, after
# checking that ARCHDIR/openvolley.gpg (what users import) is that key.
pacman_repo_fpr() {
  local arch=$1 fpr key_fpr home
  [[ -f "$arch/fingerprint.txt" && -f "$arch/openvolley.gpg" ]] ||
    die "$arch has a database but no fingerprint.txt / openvolley.gpg (run publish-pacman.sh)"
  fpr=$(tr -d '[:space:]' < "$arch/fingerprint.txt")
  [[ "$fpr" =~ ^[0-9A-F]{40}$ ]] || die "$arch/fingerprint.txt: not a key fingerprint"
  home=$(mktemp -d)
  key_fpr=$(gpg --homedir "$home" --batch --with-colons --show-keys "$arch/openvolley.gpg" 2>/dev/null |
    awk -F: '$1 == "fpr" { print $10; exit }') || true
  rm -rf "$home"
  [[ "$key_fpr" == "$fpr" ]] || die "$arch/openvolley.gpg is not the key $fpr of fingerprint.txt"
  echo "$fpr"
}

desktop_check_setup() {
  local t v mode
  for t in node dpkg-deb; do command -v "$t" >/dev/null || die "$t not found"; done
  [[ -n "$DESKTOP_RELEASE_DIR" ]] || command -v gh >/dev/null || die "gh not found"
  [[ -x "$TAURI_CLI" ]] || die "no tauri CLI at $TAURI_CLI (cd escoresheet/frontend && npm ci)"
  v=$("$TAURI_CLI" --version </dev/null | awk '{print $2}')
  # --app-version (the version bound into the signature) needs tauri-cli 2.12.
  [[ "$(printf '%s\n' 2.12.0 "$v" | sort -V | head -1)" == 2.12.0 ]] ||
    die "tauri CLI $v is older than 2.12 (no signer --app-version); cd escoresheet/frontend && npm ci"
  for t in updater.key key-password; do
    [[ -f "$DESKTOP_KEYS/$t" ]] || die "no $DESKTOP_KEYS/$t (restore it from Vaultwarden: \"OpenVolley desktop updater key\")"
    mode=$(stat -c %a "$DESKTOP_KEYS/$t")
    [[ "$mode" == 600 || "$mode" == 400 ]] || die "$DESKTOP_KEYS/$t is mode $mode; chmod 600 it"
  done
  updater pubkey --tauri-conf "$DESKTOP_TAURI_CONF" >/dev/null || die "no usable updater public key in $DESKTOP_TAURI_CONF"
}

# desktop_tag V: the GitHub release of version V of the selected app.
desktop_tag() { printf '%s%s\n' "$DESKTOP_TAG_PREFIX" "$1"; }

# desktop_fetch V DIR: the Windows installer, the AppImage and the .deb of the
# GitHub release desktop-vV (OpenBeach: beach-desktop-vV; or of
# $DESKTOP_RELEASE_DIR), each checked to be version V, and the macOS updater
# archive when the release has one (desktop_check_mac). Sets DESKTOP_EXE,
# DESKTOP_APPIMAGE, DESKTOP_DEB and DESKTOP_MAC (empty without a macOS build:
# releases before it, or a failed macOS job; latest.json then announces no
# macOS update).
desktop_fetch() {
  local v=$1 dir=$2 f kind found pkg ver arch magic draft pre tag
  tag=$(desktop_tag "$v")
  mkdir -p "$dir"
  if [[ -n "$DESKTOP_RELEASE_DIR" ]]; then
    for f in "$DESKTOP_RELEASE_DIR"/*-setup.exe "$DESKTOP_RELEASE_DIR"/*.AppImage "$DESKTOP_RELEASE_DIR"/*.deb "$DESKTOP_RELEASE_DIR"/*.app.tar.gz; do
      if [[ -e "$f" ]]; then cp "$f" "$dir/"; fi
    done
  else
    read -r draft pre < <(gh release view "$tag" --repo "$OV_GH_REPO" --json isDraft,isPrerelease -q '"\(.isDraft) \(.isPrerelease)"') ||
      die "no GitHub release $tag"
    [[ "$draft $pre" == "false false" ]] || die "release $tag is a draft or a prerelease"
    gh release download "$tag" --repo "$OV_GH_REPO" -p '*-setup.exe' -p '*.AppImage' -p '*.deb' -p '*.app.tar.gz' -D "$dir" --clobber >/dev/null ||
      die "could not download the $tag installers"
  fi
  for kind in '*-setup.exe' '*.AppImage' '*.deb'; do
    found=()
    for f in "$dir"/$kind; do
      if [[ -e "$f" ]]; then found+=("$f"); fi
    done
    (( ${#found[@]} == 1 )) || die "$tag: expected one $kind, found ${#found[@]}"
    f=${found[0]}
    # Names end up in URLs as they are; GitHub already turned spaces into dots.
    [[ "$(basename "$f")" =~ ^[A-Za-z0-9._+-]+$ ]] || die "$f: unexpected characters in the name"
    [[ "$(basename "$f")" == *"_${v}_"* ]] || die "$f: name does not carry version $v"
    magic=$(head -c 4 "$f" | od -An -tx1 | tr -d ' \n')
    case "$kind" in
      '*-setup.exe') [[ "$magic" == 4d5a* ]] || die "$f: not a Windows executable"; DESKTOP_EXE=$f ;;
      '*.AppImage') [[ "$magic" == 7f454c46 ]] || die "$f: not an ELF AppImage"; DESKTOP_APPIMAGE=$f ;;
      '*.deb')
        pkg=$(dpkg-deb -f "$f" Package); ver=$(dpkg-deb -f "$f" Version); arch=$(dpkg-deb -f "$f" Architecture)
        # The updater downloads the pool copy, so the .deb must go in unchanged
        # (publish-pkgs.sh repacks other package names, which changes the bytes).
        [[ "$pkg" == "$DESKTOP_DEB_NAME" ]] || die "$f: package $pkg, expected $DESKTOP_DEB_NAME"
        [[ "$ver" == "$v" ]] || die "$f: version $ver, expected $v"
        [[ "$arch" == amd64 ]] || die "$f: architecture $arch, expected amd64"
        DESKTOP_DEB=$f ;;
    esac
  done
  found=()
  for f in "$dir"/*.app.tar.gz; do
    if [[ -e "$f" ]]; then found+=("$f"); fi
  done
  (( ${#found[@]} <= 1 )) || die "$tag: expected at most one *.app.tar.gz, found ${#found[@]}"
  DESKTOP_MAC=''
  if (( ${#found[@]} == 0 )); then
    echo "$tag has no macOS build (*.app.tar.gz): latest.json announces no macOS update"
  else
    desktop_check_mac "$v" "${found[0]}"
    DESKTOP_MAC=${found[0]}
  fi
}

# desktop_check_mac V FILE: the updater archive the macOS job made
# (desktop.yml): named <package>_V_universal.app.tar.gz, a gzip whose every
# entry is under one <Name>.app/ (tauri-plugin-updater drops the first path
# component and puts the rest in place of the running bundle), holding this
# app's bundle (CFBundleIdentifier, the binary named after the package) at
# version V.
desktop_check_mac() {
  local v=$1 f=$2 magic list top info
  [[ "$(basename "$f")" == "${DESKTOP_DEB_NAME}_${v}_universal.app.tar.gz" ]] ||
    die "$f: expected ${DESKTOP_DEB_NAME}_${v}_universal.app.tar.gz"
  magic=$(head -c 2 "$f" | od -An -tx1 | tr -d ' \n')
  [[ "$magic" == 1f8b ]] || die "$f: not a gzip archive"
  list=$(tar -tzf "$f") || die "$f: not a tar.gz"
  top=${list%%$'\n'*}
  top=${top%%/*}
  [[ "$top" == *.app && -n "${top%.app}" ]] || die "$f: the first entry is not a <Name>.app folder"
  awk -v top="$top" '$0 != top && index($0, top "/") != 1 { bad = 1 } /(^|\/)\.\.(\/|$)/ { bad = 1 } END { exit bad }' <<<"$list" ||
    die "$f: entries outside $top/ (or with ..)"
  grep -qxF "$top/Contents/MacOS/$DESKTOP_DEB_NAME" <<<"$list" || die "$f: no $top/Contents/MacOS/$DESKTOP_DEB_NAME"
  info=$(tar -xzOf "$f" "$top/Contents/Info.plist" | python3 -c '
import plistlib, sys
p = plistlib.loads(sys.stdin.buffer.read())
print(p.get("CFBundleIdentifier", ""), p.get("CFBundleShortVersionString", ""), p.get("CFBundleExecutable", ""))') ||
    die "$f: no readable $top/Contents/Info.plist"
  [[ "$info" == "$DESKTOP_ID $v $DESKTOP_DEB_NAME" ]] ||
    die "$f: Info.plist says '$info' (identifier, version, executable), expected '$DESKTOP_ID $v $DESKTOP_DEB_NAME'"
}

# desktop_sign V FILE...: FILE.sig with the updater key. The password goes to
# the tauri CLI through its environment only (never argv, never printed).
desktop_sign() {
  local v=$1 f out pass
  shift
  pass=$(<"$DESKTOP_KEYS/key-password")
  for f in "$@"; do
    rm -f "$f.sig"
    if ! out=$(
      unset TAURI_SIGNING_PRIVATE_KEY
      TAURI_SIGNING_PRIVATE_KEY_PATH="$DESKTOP_KEYS/updater.key" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$pass" \
        "$TAURI_CLI" signer sign --app-version "$v" "$f" </dev/null 2>&1
    ); then
      [[ -z "$pass" ]] || out=${out//"$pass"/<password>}
      printf '%s\n' "$out" | tail -5 >&2
      die "signing $(basename "$f") failed (wrong password in $DESKTOP_KEYS/key-password?)"
    fi
    [[ -s "$f.sig" ]] || die "signing $(basename "$f") wrote no $f.sig"
    echo "signed $(basename "$f")"
  done
}

# desktop_verify V FILE...: as the app does it (node), and with minisign too
# when it is installed.
desktop_verify() {
  local v=$1 pub f
  shift
  updater verify --tauri-conf "$DESKTOP_TAURI_CONF" --version "$v" "$@" || die "a signature does not verify against the key the app trusts"
  if command -v minisign >/dev/null; then
    pub=$(mktemp)
    updater pubkey --tauri-conf "$DESKTOP_TAURI_CONF" | base64 -d > "$pub" || die "cannot decode the updater public key"
    for f in "$@"; do
      base64 -d "$f.sig" > "$f.minisig"
      minisign -V -q -m "$f" -x "$f.minisig" -p "$pub" || { rm -f "$pub"; die "minisign: $(basename "$f").sig does not verify"; }
      grep -q $'\tversion:'"$v"'$' "$f.minisig" || { rm -f "$pub"; die "minisign: $(basename "$f").sig is not bound to $v"; }
      rm -f "$f.minisig"
    done
    rm -f "$pub"
    echo "minisign: the $# signatures verify"
  fi
}

# desktop_notes V OUT: the What's new text for V, from the selected app's
# Android changelog of the same version (fastlane, en-US; versionCode =
# (MAJ*1e6+MIN*1e3+PATCH)*10 + build, the highest build wins), without its
# "OpenVolley X.Y.Z" / "OpenBeach X.Y.Z" title line. Empty when there is none.
desktop_notes() {
  local v=${1%%-*} out=$2 maj min pat code b f='' logs=$FASTLANE_CHANGELOGS
  [[ "$DESKTOP_APP" != beach ]] || logs=$BEACH_CHANGELOGS
  IFS=. read -r maj min pat <<<"$v"
  code=$(( (maj * 1000000 + min * 1000 + pat) * 10 ))
  for b in 9 8 7 6 5 4 3 2 1 0; do
    if [[ -f "$logs/$((code + b)).txt" ]]; then f="$logs/$((code + b)).txt"; break; fi
  done
  if [[ -n "$f" ]]; then
    sed "1{/^$DESKTOP_NAME /d}" "$f" > "$out"
  else
    : > "$out"
  fi
}

# desktop_manifest V DIR OUT: latest.json (tauri-plugin-updater static format)
# for the files desktop_fetch found, signed and verified first.
desktop_manifest() {
  local v=$1 dir=$2 out=$3 tag gh_dl urls u
  tag=$(desktop_tag "$v")
  gh_dl="https://github.com/$OV_GH_REPO/releases/download/$tag"
  desktop_notes "$v" "$dir/notes.txt"
  [[ -s "$dir/notes.txt" ]] || echo "no fastlane changelog for $v: latest.json has no notes"
  if [[ -z "$DESKTOP_RELEASE_DIR" ]]; then
    # The URLs below must be the assets GitHub really serves.
    urls=$(gh release view "$tag" --repo "$OV_GH_REPO" --json assets -q '.assets[].url') || die "cannot list the assets of $tag"
    for u in "$gh_dl/$(basename "$DESKTOP_EXE")" "$gh_dl/$(basename "$DESKTOP_APPIMAGE")" ${DESKTOP_MAC:+"$gh_dl/$(basename "$DESKTOP_MAC")"}; do
      grep -qxF "$u" <<<"$urls" || die "$u is not an asset of $tag"
    done
  fi
  # macOS: the universal archive for both architectures, when the release has it
  local mac=()
  [[ -z "$DESKTOP_MAC" ]] || mac=(--app "$DESKTOP_MAC" "$gh_dl/$(basename "$DESKTOP_MAC")")
  updater manifest --tauri-conf "$DESKTOP_TAURI_CONF" --version "$v" --out "$out" \
    --notes-file "$dir/notes.txt" \
    --nsis "$DESKTOP_EXE" "$gh_dl/$(basename "$DESKTOP_EXE")" \
    --appimage "$DESKTOP_APPIMAGE" "$gh_dl/$(basename "$DESKTOP_APPIMAGE")" \
    --deb "$DESKTOP_DEB" "$APT_POOL_URL/${DESKTOP_DEB_NAME}_${v}_amd64.deb" \
    ${mac[@]+"${mac[@]}"} || die "latest.json not written"
  updater check --tauri-conf "$DESKTOP_TAURI_CONF" --version "$v" --dir "$dir" "$out" >/dev/null || die "latest.json does not check out"
}

# desktop_publish_tree V STAGING MANIFEST PUBDIR: PUBDIR/desktop/ (OpenBeach:
# PUBDIR/desktop/beach/) gets latest-V.json (archive, for the kill switch) and
# staging.json, and latest.json unless STAGING is 1. A channel never goes back
# to an older version here; rolling back is the kill switch (deploy/README.md).
desktop_publish_tree() {
  local v=$1 staging=$2 manifest=$3 d="$4/$DESKTOP_DIR" ch cur cmp
  mkdir -p "$d"
  for ch in staging latest; do
    if [[ "$ch" == latest && "$staging" == 1 ]]; then continue; fi
    if [[ -f "$d/$ch.json" ]]; then
      cur=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version)' "$d/$ch.json") ||
        die "cannot read $d/$ch.json"
      cmp=$(updater compare "$v" "$cur") || die "cannot compare $v with $cur"
      [[ "$cmp" != -1 ]] ||
        die "$DESKTOP_DIR/$ch.json announces $cur, newer than $v (to roll back, see the kill switch in deploy/README.md)"
    fi
  done
  install -m 644 "$manifest" "$d/latest-$v.json"
  install -m 644 "$manifest" "$d/staging.json"
  if [[ "$staging" == 1 ]]; then
    echo "$DESKTOP_DIR: staging.json and latest-$v.json now announce $v (latest.json unchanged)"
  else
    install -m 644 "$manifest" "$d/latest.json"
    echo "$DESKTOP_DIR: latest.json, staging.json and latest-$v.json now announce $v"
  fi
}

# desktop_upload V STAGING DIR: the .sig files and, unless STAGING, latest.json
# to the GitHub release. latest.json there is the updater's fallback endpoint,
# so a staging run must not put it there:
#   OpenVolley  releases/latest/download/latest.json: its desktop-vV release
#               becomes GitHub's "Latest"
#   OpenBeach   releases/download/beach-desktop-latest/latest.json: a
#               prerelease holding only latest.json (made on first use); its
#               beach-desktop-vV release never becomes "Latest" and never
#               carries a latest.json: both apps trust one updater key, so if
#               GitHub's "Latest" ever landed on it (the newest desktop-v*
#               release deleted, a manual "Set as latest"), OpenVolley's
#               fallback would read OpenBeach's manifest and install OpenBeach
desktop_upload() {
  local v=$1 staging=$2 dir=$3 files latest tag
  tag=$(desktop_tag "$v")
  files=("$DESKTOP_EXE.sig" "$DESKTOP_APPIMAGE.sig" "$DESKTOP_DEB.sig")
  [[ -z "$DESKTOP_MAC" ]] || files+=("$DESKTOP_MAC.sig")
  [[ "$staging" == 1 || "$DESKTOP_MAKE_LATEST" != 1 ]] || files+=("$dir/latest.json")
  gh release upload "$tag" --repo "$OV_GH_REPO" --clobber "${files[@]}" || die "upload to $tag failed"
  echo "uploaded to $tag: ${files[*]##*/}"
  [[ "$staging" != 1 ]] || return 0
  latest=$(gh api "repos/$OV_GH_REPO/releases/latest" -q .tag_name 2>/dev/null || true)
  if [[ "$DESKTOP_MAKE_LATEST" != 1 ]]; then
    if ! gh release view "$DESKTOP_FALLBACK_TAG" --repo "$OV_GH_REPO" >/dev/null 2>&1; then
      gh release create "$DESKTOP_FALLBACK_TAG" --repo "$OV_GH_REPO" --prerelease --latest=false \
        --title "$DESKTOP_NAME desktop: update manifest" \
        --notes "latest.json for the $DESKTOP_NAME desktop updater's fallback endpoint (publish-pkgs.sh --desktop --app $DESKTOP_APP). The installers are in the $DESKTOP_TAG_PREFIX* releases." >/dev/null ||
        die "could not create the $DESKTOP_FALLBACK_TAG prerelease"
    fi
    gh release upload "$DESKTOP_FALLBACK_TAG" --repo "$OV_GH_REPO" --clobber "$dir/latest.json" ||
      die "upload of latest.json to $DESKTOP_FALLBACK_TAG failed"
    echo "uploaded to $DESKTOP_FALLBACK_TAG: latest.json"
    # OpenVolley's updater falls back to whatever GitHub calls "Latest".
    if [[ "$latest" == "$tag" || "$latest" == "$DESKTOP_FALLBACK_TAG" ]]; then
      echo "WARNING: GitHub's latest release is $latest; OpenVolley's updater fallback needs a desktop-v* release there (publish-pkgs.sh --desktop <its version>, or gh release edit desktop-v<version> --latest)" >&2
    fi
    return 0
  fi
  # The fallback endpoint is releases/latest/download/latest.json: whatever
  # release GitHub calls "Latest" (a server v* or Android release that took it,
  # an OpenBeach release, or a newer desktop-v* still on staging) must give way
  # to the one desktop/latest.json now announces.
  [[ "$latest" != "$tag" ]] || return 0
  if gh release edit "$tag" --repo "$OV_GH_REPO" --latest >/dev/null; then
    echo "$tag is now GitHub's latest release (was ${latest:-unknown}): the updater's fallback endpoint"
  else
    echo "WARNING: GitHub's latest release is ${latest:-unknown}, not $tag, and making it latest failed: the updater's fallback endpoint serves the wrong release (gh release edit $tag --latest)" >&2
  fi
}

# --- APT hold-back -------------------------------------------------------------
# The in-app .deb updater runs `apt-get install --only-upgrade`, which installs
# whatever the APT index lists as newest, not the version latest.json
# announces. So the index must never list a desktop version that the app's
# latest.json does not announce yet: a --staging .deb goes into the pool (its
# URL in staging.json works) but stays out of Packages, and the kill switch
# (latest.json back to the previous version) takes the bad version out of the
# index on the next run. Per app (openvolley-escoresheet: desktop/*.json,
# openbeach-escoresheet: desktop/beach/*.json), in dpkg version order:
#   latest.json exists      hold back every version newer than it
#   only staging.json       hold back that version and newer (the first
#                           --staging, before any latest.json)
#   neither                 hold back nothing (OpenVolley releases before 2.2.0)
# A --desktop V run counts as having already written its app's manifests.
declare -A APT_HOLD_OP=() APT_HOLD_V=()

# manifest_version FILE: the "version" of a desktop manifest.
manifest_version() {
  python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' "$1" 2>/dev/null ||
    die "cannot read the version in $1"
}

# apt_hold_init PUBDIR [V STAGING]: sets APT_HOLD_OP[package] (gt, ge or
# empty) and APT_HOLD_V[package] for every app; V and STAGING are the
# --desktop run of the selected app (desktop_app_select).
apt_hold_init() {
  local pub=$1 v=${2:-} staging=${3:-0} app d pkg latest stg
  APT_HOLD_OP=() APT_HOLD_V=()
  for app in "${!APP_DEB_NAME[@]}"; do
    pkg=${APP_DEB_NAME[$app]} d="$pub/${APP_DESKTOP_DIR[$app]}" latest='' stg=''
    if [[ -f "$d/latest.json" ]]; then latest=$(manifest_version "$d/latest.json"); fi
    if [[ -f "$d/staging.json" ]]; then stg=$(manifest_version "$d/staging.json"); fi
    if [[ -n "$v" && "$app" == "$DESKTOP_APP" ]]; then
      stg=$v
      [[ "$staging" == 1 ]] || latest=$v
    fi
    if [[ -n "$latest" ]]; then
      APT_HOLD_OP[$pkg]=gt APT_HOLD_V[$pkg]=$latest
    elif [[ -n "$stg" ]]; then
      APT_HOLD_OP[$pkg]=ge APT_HOLD_V[$pkg]=$stg
    fi
  done
}

# apt_held VER [PACKAGE]: true if APT must not list VER of PACKAGE (default:
# the selected app's package).
apt_held() {
  local pkg=${2:-$DESKTOP_DEB_NAME}
  [[ -n "${APT_HOLD_OP[$pkg]:-}" ]] && dpkg --compare-versions "$1" "${APT_HOLD_OP[$pkg]}" "${APT_HOLD_V[$pkg]}"
}

# apt_hold_packages PACKAGES: rewrite the Packages file without the held-back
# stanzas of every app; prints each version it leaves out.
apt_hold_packages() {
  local file=$1 tmp keep=() pkg ver held=0 why app dir
  (( ${#APT_HOLD_OP[@]} )) || return 0
  # One line per stanza: "<package> <version>", in file order.
  while read -r pkg ver; do
    if [[ -n "${APT_HOLD_OP[$pkg]:-}" ]] && apt_held "$ver" "$pkg"; then
      for app in "${!APP_DEB_NAME[@]}"; do [[ "${APP_DEB_NAME[$app]}" != "$pkg" ]] || dir=${APP_DESKTOP_DIR[$app]}; done
      if [[ "${APT_HOLD_OP[$pkg]}" == gt ]]; then
        why="$dir/latest.json announces ${APT_HOLD_V[$pkg]}"
      else
        why="${APT_HOLD_V[$pkg]} is only on staging, no $dir/latest.json yet"
      fi
      keep+=(0)
      echo "held back from APT: $pkg $ver ($why)"
      held=$((held + 1))
    else
      keep+=(1)
    fi
  done < <(awk 'BEGIN { RS = ""; FS = "\n" } {
      p = ""; v = ""
      for (i = 1; i <= NF; i++) {
        if ($i ~ /^Package: /) p = substr($i, 10)
        if ($i ~ /^Version: /) v = substr($i, 10)
      }
      print p, v
    }' "$file")
  (( held )) || return 0
  tmp=$(mktemp)
  awk -v keep="${keep[*]}" 'BEGIN { RS = ""; ORS = "\n\n"; n = split(keep, k, " ") }
    { if (k[NR] == 1) print }' "$file" > "$tmp"
  cat "$tmp" > "$file"
  rm -f "$tmp"
}

# refuse_key_material PUBDIR: die if anything key-like is in the public tree:
# key stores and password files by name, a PGP private key block, or a
# minisign / tauri updater secret key (as text or in its base64 file form).
# Public keys and .sig files are fine (their comments say "public key" and
# "signature from ... secret key").
refuse_key_material() {
  local pub=$1 leak
  leak=$(find "$pub" \( -iname '*.p12' -o -iname '*.jks' -o -iname '*.keystore' -o -iname 'config.yml' \
    -o -iname '*passphrase*' -o -iname '*password*' -o -iname 'private-keys-v1.d' -o -iname '*.kbx' \
    -o -iname 'secring*' -o -iname '*.key' \) -print)
  [[ -z "$leak" ]] || die "refusing to publish, key material in the public tree: $leak"
  # base64 of "untrusted comment: rsign encrypted secret key" (tauri signer),
  # "untrusted comment: minisign encrypted secret key" and the first 36 bytes
  # of "untrusted comment: minisign secret key" (unencrypted).
  leak=$(grep -rlsE \
    -e '-----BEGIN PGP PRIVATE KEY BLOCK-----' \
    -e 'untrusted comment: (rsign|minisign)( encrypted)? secret key' \
    -e 'dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWduIGVuY3J5cHRlZCBzZWNyZXQga2V5' \
    -e 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIGVuY3J5cHRlZCBzZWNyZXQga2V5' \
    -e 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHNlY3JldCBr' \
    "$pub" || true)
  [[ -z "$leak" ]] || die "refusing to publish, a private key is in the public tree: $leak"
}
