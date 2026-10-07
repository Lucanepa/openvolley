#!/usr/bin/env bash
# Builds a desktop release as a Flatpak and adds it to the self-hosted, signed
# Flatpak repository behind https://get.openvolley.app/flatpak/
#
#   escoresheet/packaging/flatpak/publish-flatpak.sh [--app openvolley|beach] [--deb FILE] VERSION
#   escoresheet/packaging/flatpak/publish-flatpak.sh --init-key
#
# Runs on lenovoserver, like publish-pkgs.sh (the repo key lives only there).
# It never syncs: publish-pkgs.sh copies public/ to the server (it calls this
# script with --flatpak, or run `publish-pkgs.sh` with no arguments after it).
#
#   1. The .deb: --deb FILE, else the APT pool's copy
#      (public/apt/pool/main/<package>_VERSION_amd64.deb, the bytes
#      publish-pkgs.sh signed), else the GitHub release asset. Its Package and
#      Version must be the app's and VERSION.
#   2. A build copy of this directory: the manifest's .deb source points at
#      that file; the metainfo gets <release VERSION> if it lacks one (notes
#      from the fastlane changelog; commit it with bump.sh afterwards).
#   3. flatpak-builder (branch stable, runtime and SDK from Flathub into the
#      user installation) into an unsigned scratch repo; then the app ref is
#      committed into the public repo signed with the Flatpak repo key, and
#      the summary is regenerated, signed, with static deltas; the last
#      $PRUNE_DEPTH commits of each ref stay (rollback:
#      flatpak update --commit=<hash> <app id>).
#   4. Writes public/flatpak/openvolley.flatpakrepo, <app id>.flatpakref and
#      openvolley-flatpak.gpg (the public key).
#   5. Checks it as a client would: a throwaway Flatpak installation adds the
#      repo with that public key and reads the app's ref (signature checked).
#
# The in-app updater is off inside the Flatpak (unstamp-bundle-type.py, and
# from 2.4.1 / OpenBeach 2.0.1 updater.rs managed_by): `flatpak update` updates the app.
#
# Layout under ${OV_PKGS_HOME} (default ~/.config/openvolley-pkgs, mode 700):
#   flatpak-gpg/              GNUPGHOME with the Flatpak repo key (only that
#                             key). Vaultwarden: "OpenVolley Flatpak repo key"
#   flatpak-gpg-passphrase    its passphrase (mode 600)
#   public/flatpak/repo/      the OSTree repository (archive mode)
# Build cache: ${OV_FLATPAK_CACHE} (default ~/.cache/openvolley-flatpak).
#
# --init-key makes the key (once): ed25519, no expiry, a random passphrase,
# then prints how to put both into Vaultwarden with rbw (stdin, no tty).
set -euo pipefail
umask 022

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
PKGS=${OV_PKGS_HOME:-$HOME/.config/openvolley-pkgs}
PUB="$PKGS/public"
FLAT="$PUB/flatpak"
REPO="$FLAT/repo"
FP_GNUPG=${OV_FLATPAK_GNUPG:-$PKGS/flatpak-gpg}
FP_PASS=${OV_FLATPAK_PASSPHRASE:-$PKGS/flatpak-gpg-passphrase}
CACHE=${OV_FLATPAK_CACHE:-$HOME/.cache/openvolley-flatpak}
BASE_URL=${OV_FLATPAK_URL:-https://get.openvolley.app/flatpak}
GH_REPO=Lucanepa/openvolley
PRUNE_DEPTH=5
BRANCH=stable
KEY_UID="OpenVolley Flatpak repository <support@openvolley.app>"
FASTLANE_CHANGELOGS="$HERE/../../../fastlane/metadata/android/en-US/changelogs"
BEACH_CHANGELOGS=${OV_BEACH_CHANGELOGS:-$HERE/../../../openbeach/fastlane/metadata/android/en-US/changelogs}

die() { echo "publish-flatpak: $*" >&2; exit 1; }
fpgpg() { gpg --homedir "$FP_GNUPG" --batch "$@"; }

# --- arguments --------------------------------------------------------------
APP=openvolley
DEB=
VERSION=
INIT_KEY=0
while (( $# )); do
  case "$1" in
    --app) (( $# > 1 )) || die "--app needs openvolley or beach"; APP=$2; shift ;;
    --deb) (( $# > 1 )) || die "--deb needs a file"; DEB=$2; shift ;;
    --init-key) INIT_KEY=1 ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) [[ -z "$VERSION" ]] || die "one VERSION only"; VERSION=${1#v} ;;
  esac
  shift
done

# --- --init-key -------------------------------------------------------------
if (( INIT_KEY )); then
  [[ -z "$VERSION" ]] || die "--init-key takes no VERSION"
  command -v gpg >/dev/null || die "gpg not found"
  [[ ! -e "$FP_GNUPG" ]] || die "$FP_GNUPG exists already; restore or remove it by hand"
  mkdir -p "$PKGS" && chmod 700 "$PKGS"
  install -d -m 700 "$FP_GNUPG"
  ( umask 077; head -c 32 /dev/urandom | base64 | tr -d '=+/\n' > "$FP_PASS" )
  # The passphrase reaches gpg-agent once per signing step (loopback, see
  # agent_warm); the agent keeps it for this long, then forgets it.
  printf 'allow-loopback-pinentry\ndefault-cache-ttl 900\nmax-cache-ttl 3600\n' > "$FP_GNUPG/gpg-agent.conf"
  fpgpg --pinentry-mode loopback --passphrase-file "$FP_PASS" \
    --quick-generate-key "$KEY_UID" ed25519 sign never
  fpr=$(fpgpg --with-colons --list-secret-keys | awk -F: '$1 == "fpr" { print $10; exit }')
  gpgconf --homedir "$FP_GNUPG" --kill gpg-agent || true
  cat <<EOF
Flatpak repo key created: $fpr
  $FP_GNUPG (GNUPGHOME), $FP_PASS (passphrase)

Back it up in Vaultwarden now (rbw reads the entry from stdin in a non-tty
shell; pipe it in, never </dev/null):

  { cat "$FP_PASS"; echo; echo "fingerprint $fpr"; echo;
    gpg --homedir "$FP_GNUPG" --batch --pinentry-mode loopback --passphrase-file "$FP_PASS" \\
      --armor --export-secret-keys "$fpr"; } | rbw add "OpenVolley Flatpak repo key"

Restore: gpg --homedir "$FP_GNUPG" --import (the armored block), the first line
into $FP_PASS (chmod 600), and the gpg-agent.conf above.
EOF
  exit 0
fi

# --- checks -----------------------------------------------------------------
[[ -n "$VERSION" ]] || die "VERSION missing (publish-flatpak.sh [--app openvolley|beach] VERSION)"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "$VERSION: not a version like 2.3.0"
case "$APP" in
  openvolley) APP_ID=com.openvolley.escoresheet CMD=openvolley-escoresheet TAG=desktop-v$VERSION
    TITLE="OpenVolley eScoresheet" NAME=OpenVolley HOMEPAGE=https://openvolley.app LOGS=$FASTLANE_CHANGELOGS ;;
  beach) APP_ID=com.openvolley.beach CMD=openbeach-escoresheet TAG=beach-desktop-v$VERSION
    TITLE="OpenBeach" NAME=OpenBeach HOMEPAGE=https://beach.openvolley.app LOGS=$BEACH_CHANGELOGS ;;
  *) die "--app $APP: expected openvolley or beach" ;;
esac
for t in flatpak flatpak-builder ostree gpg gpgconf dpkg-deb python3; do
  command -v "$t" >/dev/null || die "$t not found (apt install flatpak flatpak-builder ostree)"
done
[[ -d "$FP_GNUPG" && -f "$FP_PASS" ]] || die "no Flatpak repo key in $FP_GNUPG (publish-flatpak.sh --init-key, or restore it from Vaultwarden)"
[[ "$(stat -c %a "$FP_PASS")" == 600 ]] || die "$FP_PASS is mode $(stat -c %a "$FP_PASS"); chmod 600 it"
[[ "$(fpgpg --with-colons --list-secret-keys | grep -c '^sec:')" == 1 ]] || die "$FP_GNUPG must hold exactly one secret key"
# the primary key's fingerprint: the first "fpr" after "sec" (subkeys follow)
FPR=$(fpgpg --with-colons --list-secret-keys | awk -F: '$1 == "sec" { s = 1; next } s && $1 == "fpr" { print $10; exit }')

WORK=$(mktemp -d)
cleanup() {
  gpgconf --homedir "$FP_GNUPG" --kill gpg-agent >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# agent_warm: give gpg-agent the passphrase (loopback) right before a step that
# signs through gpgme (flatpak, ostree), which cannot pass one itself.
agent_warm() {
  echo x | fpgpg --pinentry-mode loopback --passphrase-file "$FP_PASS" \
    --local-user "$FPR" -o /dev/null --sign || die "cannot sign with $FPR (passphrase?)"
}

# --- 1. the .deb ------------------------------------------------------------
if [[ -z "$DEB" ]]; then
  pool="$PUB/apt/pool/main/${CMD}_${VERSION}_amd64.deb"
  if [[ -f "$pool" ]]; then
    DEB=$pool
  else
    command -v gh >/dev/null || die "no $pool and no gh to download $TAG"
    gh release download "$TAG" --repo "$GH_REPO" --pattern "${CMD}_${VERSION}_amd64.deb" --dir "$WORK" ||
      die "cannot download ${CMD}_${VERSION}_amd64.deb from $TAG"
    DEB="$WORK/${CMD}_${VERSION}_amd64.deb"
  fi
fi
[[ -f "$DEB" ]] || die "$DEB: no such file"
DEB=$(cd "$(dirname "$DEB")" && pwd -P)/$(basename "$DEB")
[[ "$(dpkg-deb -f "$DEB" Package)" == "$CMD" ]] || die "$DEB: package $(dpkg-deb -f "$DEB" Package), expected $CMD"
[[ "$(dpkg-deb -f "$DEB" Version)" == "$VERSION" ]] || die "$DEB: version $(dpkg-deb -f "$DEB" Version), expected $VERSION"
echo "deb: $DEB ($(sha256sum "$DEB" | cut -c1-16)…)"

# --- 2. build copy ------------------------------------------------------------
SRC="$WORK/src"
mkdir -p "$SRC"
cp -r "$HERE/shared-modules" "$HERE/unstamp-bundle-type.py" "$HERE/$APP_ID".{json,desktop,metainfo.xml} "$SRC/"
python3 "$HERE/flatpak-meta.py" set-deb "$SRC/$APP_ID.json" --path "$DEB"
maj=${VERSION%%.*} rest=${VERSION#*.}; min=${rest%%.*} pat=${rest#*.}
code=$(( (maj * 1000000 + min * 1000 + pat) * 10 ))
notes=
for b in 9 8 7 6 5 4 3 2 1 0; do
  if [[ -f "$LOGS/$((code + b)).txt" ]]; then notes="$LOGS/$((code + b)).txt"; break; fi
done
notes_args=()
if [[ -n "$notes" ]]; then
  sed "1{/^$NAME /d}" "$notes" > "$WORK/notes.txt"
  notes_args=("$WORK/notes.txt")
fi
if ! grep -q "<release [^>]*version=\"$VERSION\"" "$HERE/$APP_ID.metainfo.xml"; then
  echo "note: $APP_ID.metainfo.xml has no release $VERSION; the build adds it (commit it: bump.sh $APP $VERSION)"
fi
python3 "$HERE/flatpak-meta.py" add-release "$SRC/$APP_ID.metainfo.xml" "$VERSION" "$(date -u +%F)" \
  "https://github.com/$GH_REPO/releases/tag/$TAG" "${notes_args[@]}" >/dev/null

# --- 3. build, then commit signed into the public repo -----------------------
mkdir -p "$CACHE/build" "$FLAT"
flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
(
  cd "$SRC"
  flatpak-builder --user --install-deps-from=flathub --disable-rofiles-fuse --force-clean \
    --state-dir="$CACHE/state" --default-branch="$BRANCH" \
    --subject="$TITLE $VERSION" --repo="$WORK/build-repo" "$CACHE/build/$APP_ID" "$APP_ID.json"
)
# flatpak-builder needs its build dir on the state dir's filesystem
rm -rf "$CACHE/build/$APP_ID"
if [[ ! -f "$REPO/config" ]]; then
  ostree init --mode=archive-z2 --repo="$REPO"
  echo "created $REPO"
fi
REF=app/$APP_ID/x86_64/$BRANCH
agent_warm
flatpak build-commit-from --src-repo="$WORK/build-repo" --gpg-sign="$FPR" --gpg-homedir="$FP_GNUPG" \
  --no-update-summary --subject="$TITLE $VERSION" "$REPO" "$REF"
agent_warm
flatpak build-update-repo --gpg-sign="$FPR" --gpg-homedir="$FP_GNUPG" \
  --title="OpenVolley" --default-branch="$BRANCH" \
  --generate-static-deltas --prune --prune-depth="$PRUNE_DEPTH" "$REPO"

# --- 4. key, .flatpakrepo, .flatpakref ---------------------------------------
fpgpg --export "$FPR" > "$FLAT/openvolley-flatpak.gpg"
key64=$(base64 -w0 "$FLAT/openvolley-flatpak.gpg")
cat > "$FLAT/openvolley.flatpakrepo" <<EOF
[Flatpak Repo]
Title=OpenVolley
Url=$BASE_URL/repo/
Homepage=https://get.openvolley.app
Comment=OpenVolley eScoresheet and OpenBeach desktop apps
Description=Offline volleyball and beach volleyball e-scoresheets with a LAN server for the tablets.
DefaultBranch=$BRANCH
GPGKey=$key64
EOF
write_ref() {
  local id=$1 title=$2 homepage=$3
  cat > "$FLAT/$id.flatpakref" <<EOF
[Flatpak Ref]
Name=$id
Branch=$BRANCH
Title=$title
Homepage=$homepage
Url=$BASE_URL/repo/
SuggestRemoteName=openvolley
RuntimeRepo=https://dl.flathub.org/repo/flathub.flatpakrepo
IsRuntime=false
GPGKey=$key64
EOF
}
write_ref "$APP_ID" "$TITLE" "$HOMEPAGE"

# --- 5. check as a client ------------------------------------------------------
gpgconf --homedir "$FP_GNUPG" --kill gpg-agent >/dev/null 2>&1 || true
(
  export FLATPAK_USER_DIR="$WORK/client"
  flatpak remote-add --user --gpg-import="$FLAT/openvolley-flatpak.gpg" check "file://$REPO"
  flatpak remote-info --user check "$REF" > "$WORK/remote-info.txt"
  flatpak update --user --appstream check >/dev/null
  flatpak remote-ls --user check --columns=application,version > "$WORK/remote-ls.txt"
) || die "the repo does not verify with $FLAT/openvolley-flatpak.gpg"
grep -q "^ *Subject: $TITLE $VERSION$" "$WORK/remote-info.txt" ||
  die "the repo's $REF is not $TITLE $VERSION: $(grep -E '^ *Subject:' "$WORK/remote-info.txt")"
grep -qxP "$APP_ID\t$VERSION" "$WORK/remote-ls.txt" ||
  die "the repo's AppStream does not list $APP_ID $VERSION: $(tr '\t' ' ' < "$WORK/remote-ls.txt")"
commit=$(ostree --repo="$REPO" rev-parse "$REF")
echo "published $REF $VERSION (commit ${commit:0:12}, signed by $FPR) in $REPO"
echo "install: flatpak install --user $BASE_URL/$APP_ID.flatpakref"
echo "not synced: run publish-pkgs.sh to copy public/ to the server"
