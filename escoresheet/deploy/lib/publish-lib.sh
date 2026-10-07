# shellcheck shell=bash
# Functions for publish-pkgs.sh (sourced, never run). The test harness
# tests/publish-desktop.test.sh sources this too, with throwaway keys.
#
# The caller defines die() and KIT_DIR (escoresheet/deploy), and runs under
# set -euo pipefail.
#
# Desktop updater release (publish-pkgs.sh --desktop VERSION [--staging]):
#   desktop_check_setup         tools, key files, tauri CLI >= 2.12, trusted pubkey
#   desktop_fetch V DIR         the three installers of desktop-vV into DIR
#   desktop_sign V FILE...      FILE.sig, bound to version V (tauri signer)
#   desktop_verify V FILE...    each FILE.sig against the key the app trusts
#   desktop_notes V OUT         What's new text (fastlane changelog) into OUT
#   desktop_manifest V DIR OUT  latest.json for the files desktop_fetch found
#   desktop_publish_tree V STAGING MANIFEST PUBDIR
#   desktop_upload V STAGING DIR   .sig files (+ latest.json) to the GitHub release
# the APT hold-back (the index never runs ahead of desktop/latest.json):
#   apt_hold_init PUBDIR [V STAGING]   which desktop versions APT must not list yet
#   apt_held VER                       true if VER is held back
#   apt_hold_packages PACKAGES         drops held-back stanzas from a Packages file
# and the public-tree guard:
#   refuse_key_material PUBDIR

OV_GH_REPO=Lucanepa/openvolley
APT_POOL_URL=https://get.openvolley.app/apt/pool/main
DESKTOP_KEYS=${OV_DESKTOP_KEYS:-$HOME/.config/openvolley-desktop}
# The key the app trusts is the one committed in tauri.conf.json, so signatures
# are checked against that, never against the .pub file next to the private key.
DESKTOP_TAURI_CONF=${OV_DESKTOP_TAURI_CONF:-$KIT_DIR/../frontend/src-tauri/tauri.conf.json}
TAURI_CLI=${OV_TAURI_CLI:-$KIT_DIR/../frontend/node_modules/.bin/tauri}
# Test input instead of `gh release download` (publish-pkgs.sh allows it with --no-sync only).
DESKTOP_RELEASE_DIR=${OV_DESKTOP_RELEASE_DIR:-}
UPDATER_JS="$KIT_DIR/lib/desktop-updater.mjs"
FASTLANE_CHANGELOGS="$KIT_DIR/../../fastlane/metadata/android/en-US/changelogs"
DESKTOP_DEB_NAME=openvolley-escoresheet

# Set by desktop_fetch.
DESKTOP_EXE='' DESKTOP_APPIMAGE='' DESKTOP_DEB=''

updater() { node "$UPDATER_JS" "$@"; }

desktop_version_ok() {
  [[ "$1" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]]
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

# desktop_fetch V DIR: the Windows installer, the AppImage and the .deb of the
# GitHub release desktop-vV (or of $DESKTOP_RELEASE_DIR), each checked to be
# version V. Sets DESKTOP_EXE, DESKTOP_APPIMAGE, DESKTOP_DEB.
desktop_fetch() {
  local v=$1 dir=$2 f kind found pkg ver arch magic draft pre
  mkdir -p "$dir"
  if [[ -n "$DESKTOP_RELEASE_DIR" ]]; then
    for f in "$DESKTOP_RELEASE_DIR"/*-setup.exe "$DESKTOP_RELEASE_DIR"/*.AppImage "$DESKTOP_RELEASE_DIR"/*.deb; do
      if [[ -e "$f" ]]; then cp "$f" "$dir/"; fi
    done
  else
    read -r draft pre < <(gh release view "desktop-v$v" --repo "$OV_GH_REPO" --json isDraft,isPrerelease -q '"\(.isDraft) \(.isPrerelease)"') ||
      die "no GitHub release desktop-v$v"
    [[ "$draft $pre" == "false false" ]] || die "release desktop-v$v is a draft or a prerelease"
    gh release download "desktop-v$v" --repo "$OV_GH_REPO" -p '*-setup.exe' -p '*.AppImage' -p '*.deb' -D "$dir" --clobber >/dev/null ||
      die "could not download the desktop-v$v installers"
  fi
  for kind in '*-setup.exe' '*.AppImage' '*.deb'; do
    found=()
    for f in "$dir"/$kind; do
      if [[ -e "$f" ]]; then found+=("$f"); fi
    done
    (( ${#found[@]} == 1 )) || die "desktop-v$v: expected one $kind, found ${#found[@]}"
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

# desktop_notes V OUT: the What's new text for V, from the Android changelog of
# the same version (fastlane, en-US; versionCode = (MAJ*1e6+MIN*1e3+PATCH)*10
# + build, the highest build wins), without its "OpenVolley X.Y.Z" title line.
# Empty when there is none.
desktop_notes() {
  local v=${1%%-*} out=$2 maj min pat code b f=
  IFS=. read -r maj min pat <<<"$v"
  code=$(( (maj * 1000000 + min * 1000 + pat) * 10 ))
  for b in 9 8 7 6 5 4 3 2 1 0; do
    if [[ -f "$FASTLANE_CHANGELOGS/$((code + b)).txt" ]]; then f="$FASTLANE_CHANGELOGS/$((code + b)).txt"; break; fi
  done
  if [[ -n "$f" ]]; then
    sed '1{/^OpenVolley /d}' "$f" > "$out"
  else
    : > "$out"
  fi
}

# desktop_manifest V DIR OUT: latest.json (tauri-plugin-updater static format)
# for the files desktop_fetch found, signed and verified first.
desktop_manifest() {
  local v=$1 dir=$2 out=$3 gh_dl="https://github.com/$OV_GH_REPO/releases/download/desktop-v$1" urls u
  desktop_notes "$v" "$dir/notes.txt"
  [[ -s "$dir/notes.txt" ]] || echo "no fastlane changelog for $v: latest.json has no notes"
  if [[ -z "$DESKTOP_RELEASE_DIR" ]]; then
    # The URLs below must be the assets GitHub really serves.
    urls=$(gh release view "desktop-v$v" --repo "$OV_GH_REPO" --json assets -q '.assets[].url') || die "cannot list the assets of desktop-v$v"
    for u in "$gh_dl/$(basename "$DESKTOP_EXE")" "$gh_dl/$(basename "$DESKTOP_APPIMAGE")"; do
      grep -qxF "$u" <<<"$urls" || die "$u is not an asset of desktop-v$v"
    done
  fi
  updater manifest --tauri-conf "$DESKTOP_TAURI_CONF" --version "$v" --out "$out" \
    --notes-file "$dir/notes.txt" \
    --nsis "$DESKTOP_EXE" "$gh_dl/$(basename "$DESKTOP_EXE")" \
    --appimage "$DESKTOP_APPIMAGE" "$gh_dl/$(basename "$DESKTOP_APPIMAGE")" \
    --deb "$DESKTOP_DEB" "$APT_POOL_URL/${DESKTOP_DEB_NAME}_${v}_amd64.deb" || die "latest.json not written"
  updater check --tauri-conf "$DESKTOP_TAURI_CONF" --version "$v" --dir "$dir" "$out" >/dev/null || die "latest.json does not check out"
}

# desktop_publish_tree V STAGING MANIFEST PUBDIR: PUBDIR/desktop/ gets
# latest-V.json (archive, for the kill switch) and staging.json, and
# latest.json unless STAGING is 1. A channel never goes back to an older
# version here; rolling back is the kill switch (deploy/README.md).
desktop_publish_tree() {
  local v=$1 staging=$2 manifest=$3 d="$4/desktop" ch cur cmp
  mkdir -p "$d"
  for ch in staging latest; do
    if [[ "$ch" == latest && "$staging" == 1 ]]; then continue; fi
    if [[ -f "$d/$ch.json" ]]; then
      cur=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version)' "$d/$ch.json") ||
        die "cannot read $d/$ch.json"
      cmp=$(updater compare "$v" "$cur") || die "cannot compare $v with $cur"
      [[ "$cmp" != -1 ]] ||
        die "desktop/$ch.json announces $cur, newer than $v (to roll back, see the kill switch in deploy/README.md)"
    fi
  done
  install -m 644 "$manifest" "$d/latest-$v.json"
  install -m 644 "$manifest" "$d/staging.json"
  if [[ "$staging" == 1 ]]; then
    echo "desktop: staging.json and latest-$v.json now announce $v (latest.json unchanged)"
  else
    install -m 644 "$manifest" "$d/latest.json"
    echo "desktop: latest.json, staging.json and latest-$v.json now announce $v"
  fi
}

# desktop_upload V STAGING DIR: the .sig files and, unless STAGING, latest.json
# to the GitHub release. latest.json there is the updater's fallback endpoint
# (releases/latest/download/latest.json), so a staging run must not put it there.
desktop_upload() {
  local v=$1 staging=$2 dir=$3 files latest
  files=("$DESKTOP_EXE.sig" "$DESKTOP_APPIMAGE.sig" "$DESKTOP_DEB.sig")
  [[ "$staging" == 1 ]] || files+=("$dir/latest.json")
  gh release upload "desktop-v$v" --repo "$OV_GH_REPO" --clobber "${files[@]}" || die "upload to desktop-v$v failed"
  echo "uploaded to desktop-v$v: ${files[*]##*/}"
  [[ "$staging" != 1 ]] || return 0
  # The fallback endpoint is releases/latest/download/latest.json: whatever
  # release GitHub calls "Latest" (a server v* or Android release that took it,
  # or a newer desktop-v* still on staging) must give way to the one
  # desktop/latest.json now announces.
  latest=$(gh api "repos/$OV_GH_REPO/releases/latest" -q .tag_name 2>/dev/null || true)
  [[ "$latest" != "desktop-v$v" ]] || return 0
  if gh release edit "desktop-v$v" --repo "$OV_GH_REPO" --latest >/dev/null; then
    echo "desktop-v$v is now GitHub's latest release (was ${latest:-unknown}): the updater's fallback endpoint"
  else
    echo "WARNING: GitHub's latest release is ${latest:-unknown}, not desktop-v$v, and making it latest failed: the updater's fallback endpoint serves the wrong release (gh release edit desktop-v$v --latest)" >&2
  fi
}

# --- APT hold-back -------------------------------------------------------------
# The in-app .deb updater runs `apt-get install --only-upgrade`, which installs
# whatever the APT index lists as newest, not the version latest.json
# announces. So the index must never list a desktop version that
# desktop/latest.json does not announce yet: a --staging .deb goes into the
# pool (its URL in staging.json works) but stays out of Packages, and the kill
# switch (latest.json back to the previous version) takes the bad version out
# of the index on the next run. The rule, in dpkg version order:
#   desktop/latest.json exists      hold back every version newer than it
#   only desktop/staging.json       hold back that version and newer (the
#                                   first --staging, before any latest.json)
#   neither                         hold back nothing (releases before 2.2.0)
# A --desktop V run counts as having already written its manifests.
APT_HOLD_OP='' APT_HOLD_V=''

# manifest_version FILE: the "version" of a desktop manifest.
manifest_version() {
  python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' "$1" 2>/dev/null ||
    die "cannot read the version in $1"
}

# apt_hold_init PUBDIR [V STAGING]: sets APT_HOLD_OP (gt, ge or empty) and APT_HOLD_V.
apt_hold_init() {
  local d="$1/desktop" v=${2:-} staging=${3:-0} latest='' stg=''
  if [[ -f "$d/latest.json" ]]; then latest=$(manifest_version "$d/latest.json"); fi
  if [[ -f "$d/staging.json" ]]; then stg=$(manifest_version "$d/staging.json"); fi
  if [[ -n "$v" ]]; then
    stg=$v
    [[ "$staging" == 1 ]] || latest=$v
  fi
  APT_HOLD_OP='' APT_HOLD_V=''
  if [[ -n "$latest" ]]; then
    APT_HOLD_OP=gt APT_HOLD_V=$latest
  elif [[ -n "$stg" ]]; then
    APT_HOLD_OP=ge APT_HOLD_V=$stg
  fi
}

apt_held() {
  [[ -n "$APT_HOLD_OP" ]] && dpkg --compare-versions "$1" "$APT_HOLD_OP" "$APT_HOLD_V"
}

# apt_hold_packages PACKAGES: rewrite the Packages file without the held-back
# $DESKTOP_DEB_NAME stanzas; prints each version it leaves out.
apt_hold_packages() {
  local file=$1 tmp keep=() pkg ver held=0 why
  [[ -n "$APT_HOLD_OP" ]] || return 0
  if [[ "$APT_HOLD_OP" == gt ]]; then
    why="desktop/latest.json announces $APT_HOLD_V"
  else
    why="$APT_HOLD_V is only on staging, no desktop/latest.json yet"
  fi
  # One line per stanza: "<package> <version>", in file order.
  while read -r pkg ver; do
    if [[ "$pkg" == "$DESKTOP_DEB_NAME" ]] && apt_held "$ver"; then
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
