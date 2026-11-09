#!/usr/bin/env bash
# Builds the Arch packages (the AUR PKGBUILDs) and publishes them in the
# self-hosted, signed pacman repository behind https://get.openvolley.app/arch/
#
#   escoresheet/packaging/pacman/publish-pacman.sh [--app openvolley|beach] [--deb FILE] [--keep N] [VERSION]
#   escoresheet/packaging/pacman/publish-pacman.sh --app both [--keep N]
#   escoresheet/packaging/pacman/publish-pacman.sh --init-key
#
# Runs on lenovoserver, like publish-pkgs.sh (the repo key lives only there).
# It never syncs: publish-pkgs.sh copies public/ to the server (it calls this
# script with --pacman, or run `publish-pkgs.sh` with no arguments after it).
#
# Users add the repo once (key, then [openvolley] in /etc/pacman.conf; the
# install page and README.md have the steps) and get updates with pacman -Syu.
#
#   1. Which package: ../aur/<package>-bin/PKGBUILD as committed (the same
#      PKGBUILD the AUR gets; bump it first with ../aur/bump.sh). VERSION,
#      when given, must be the PKGBUILD's pkgver. --app both takes both apps
#      at their PKGBUILD versions. A package whose file
#      (<package>-bin-<pkgver>-<pkgrel>-x86_64.pkg.tar.zst) is in the repo
#      already is kept as it is (published files never change: bump pkgrel
#      for a packaging fix); one older than the repo's newest is refused.
#   2. Builds it in an archlinux container (local image $IMAGE, base-devel,
#      rebuilt from archlinux:latest when a week old) with makepkg as a
#      non-root user that has your uid. The PKGBUILD downloads the release
#      .deb, or takes --deb FILE (publish-pkgs.sh passes the .deb it signed);
#      makepkg checks it against the PKGBUILD's sha256sums either way.
#      Each package must contain /usr/bin/<package> and the updater marker
#      /usr/lib/<package>/package-manager.
#   3. Signs each new package (detached, <file>.sig) with the pacman repo key,
#      here, not in the container (the private key never leaves this
#      machine's GNUPGHOME), and adds it to public/arch/x86_64/. Of each
#      package the newest $KEEP versions stay (default 3; older ones and
#      their .sig are deleted; rollback: pacman -U <URL of an older file>).
#   4. Rebuilds the database from scratch with repo-add (in the container)
#      from the newest version of each package, then signs it here: what
#      repo-add --sign does, without the key in the container. Published as
#      plain files: openvolley.db, openvolley.files and their .sig.
#   5. Exports the public key: public/arch/openvolley.gpg (binary, what
#      pacman-key --add takes) and public/arch/fingerprint.txt (the page
#      shows it). A different key than the one already published is refused.
#   6. Checks it as a client would: pacman (in the container, with only this
#      repo, SigLevel Required DatabaseRequired, a fresh keyring that trusts
#      only the exported key) syncs the database and downloads every package
#      in it, checking each signature.
#
# Layout under ${OV_PKGS_HOME} (default ~/.config/openvolley-pkgs, mode 700):
#   pacman-gpg/              GNUPGHOME with the pacman repo key (only that
#                            key). Vaultwarden: "OpenVolley pacman repo key"
#   pacman-gpg-passphrase    its passphrase (mode 600)
#   public/arch/             openvolley.gpg, fingerprint.txt,
#                            x86_64/{openvolley.db,openvolley.files,*.pkg.tar.zst}(+.sig)
# Source cache (the downloaded .deb files): ${OV_PACMAN_CACHE} (default
# ~/.cache/openvolley-pacman). Needs docker and gpg.
#
# --init-key makes the key (once): ed25519, no expiry, a random passphrase,
# then prints how to put both into Vaultwarden with rbw (stdin, no tty).
set -euo pipefail
umask 022

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
PKGS=${OV_PKGS_HOME:-$HOME/.config/openvolley-pkgs}
PUB="$PKGS/public"
ARCH_DIR="$PUB/arch"
REPO="$ARCH_DIR/x86_64"
PM_GNUPG=${OV_PACMAN_GNUPG:-$PKGS/pacman-gpg}
PM_PASS=${OV_PACMAN_PASSPHRASE:-$PKGS/pacman-gpg-passphrase}
PKGBUILDS=${OV_PACMAN_PKGBUILDS:-$HERE/../aur}
CACHE=${OV_PACMAN_CACHE:-$HOME/.cache/openvolley-pacman}
IMAGE=${OV_PACMAN_IMAGE:-openvolley-pacman-build}
DB=openvolley
KEY_UID="OpenVolley pacman repository <packages@openvolley.app>"
# every package this repo may hold
NAMES=(openvolley-escoresheet-bin openbeach-escoresheet-bin)

die() { echo "publish-pacman: $*" >&2; exit 1; }
pmgpg() { gpg --homedir "$PM_GNUPG" --batch "$@"; }

# --- arguments --------------------------------------------------------------
APP=
DEB=
VERSION=
KEEP=3
INIT_KEY=0
while (( $# )); do
  case "$1" in
    --app) (( $# > 1 )) || die "--app needs openvolley, beach or both"; APP=$2; shift ;;
    --deb) (( $# > 1 )) || die "--deb needs a file"; DEB=$2; shift ;;
    --keep) (( $# > 1 )) || die "--keep needs a number"; KEEP=$2; shift ;;
    --init-key) INIT_KEY=1 ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) [[ -z "$VERSION" ]] || die "one VERSION only"; VERSION=${1#v} ;;
  esac
  shift
done

# --- --init-key -------------------------------------------------------------
if (( INIT_KEY )); then
  [[ -z "$VERSION$APP$DEB" ]] || die "--init-key takes no VERSION, --app or --deb"
  command -v gpg >/dev/null || die "gpg not found"
  [[ ! -e "$PM_GNUPG" ]] || die "$PM_GNUPG exists already; restore or remove it by hand"
  mkdir -p "$PKGS" && chmod 700 "$PKGS"
  install -d -m 700 "$PM_GNUPG"
  ( umask 077; head -c 32 /dev/urandom | base64 | tr -d '=+/\n' > "$PM_PASS" )
  printf 'allow-loopback-pinentry\ndefault-cache-ttl 900\nmax-cache-ttl 3600\n' > "$PM_GNUPG/gpg-agent.conf"
  pmgpg --pinentry-mode loopback --passphrase-file "$PM_PASS" \
    --quick-generate-key "$KEY_UID" ed25519 sign never
  fpr=$(pmgpg --with-colons --list-secret-keys | awk -F: '$1 == "fpr" { print $10; exit }')
  gpgconf --homedir "$PM_GNUPG" --kill gpg-agent || true
  cat <<EOF
pacman repo key created: $fpr
  $PM_GNUPG (GNUPGHOME), $PM_PASS (passphrase)

Back it up in Vaultwarden now (rbw reads the entry from stdin in a non-tty
shell; pipe it in, never </dev/null):

  { cat "$PM_PASS"; echo; echo "fingerprint $fpr"; echo;
    gpg --homedir "$PM_GNUPG" --batch --pinentry-mode loopback --passphrase-file "$PM_PASS" \\
      --armor --export-secret-keys "$fpr"; } | rbw add "OpenVolley pacman repo key"

Restore: gpg --homedir "$PM_GNUPG" --import (the armored block), the first line
into $PM_PASS (chmod 600), and the gpg-agent.conf above.
EOF
  exit 0
fi

# --- checks -----------------------------------------------------------------
APP=${APP:-openvolley}
case "$APP" in
  openvolley) APPS=(openvolley) ;;
  beach) APPS=(beach) ;;
  both)
    APPS=(openvolley beach)
    [[ -z "$VERSION" ]] || die "--app both takes no VERSION (each app is published at its PKGBUILD's pkgver)"
    [[ -z "$DEB" ]] || die "--deb goes with one app, not --app both"
    ;;
  *) die "--app $APP: expected openvolley, beach or both" ;;
esac
[[ -z "$VERSION" || "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "$VERSION: not a version like 2.4.0"
[[ "$KEEP" =~ ^[1-9][0-9]*$ ]] || die "--keep $KEEP: expected a number from 1"
for t in docker gpg gpgv gpgconf python3 sha256sum; do
  command -v "$t" >/dev/null || die "$t not found"
done
(( $(id -u) != 0 )) || die "run it as your own user, not root (makepkg builds as your uid)"

# app_pkg APP: the command / package base name of the app.
app_pkg() { case "$1" in openvolley) echo openvolley-escoresheet ;; beach) echo openbeach-escoresheet ;; esac; }
# pkgbuild_var FILE NAME: a plain NAME=value line of a PKGBUILD (not sourced).
pkgbuild_var() { sed -n "s/^$2=['\"]\{0,1\}\([^'\"]*\)['\"]\{0,1\}\$/\1/p" "$1" | head -n1; }

declare -A PKGVER=() PKGREL=() PKGFILE=()
for app in "${APPS[@]}"; do
  base=$(app_pkg "$app")
  pb="$PKGBUILDS/$base-bin/PKGBUILD"
  [[ -f "$pb" ]] || die "no $pb"
  [[ "$(pkgbuild_var "$pb" pkgname)" == "$base-bin" ]] || die "$pb: pkgname is not $base-bin"
  PKGVER[$app]=$(pkgbuild_var "$pb" pkgver)
  PKGREL[$app]=$(pkgbuild_var "$pb" pkgrel)
  [[ "${PKGVER[$app]}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "${PKGREL[$app]}" =~ ^[1-9][0-9]*$ ]] ||
    die "$pb: pkgver ${PKGVER[$app]} / pkgrel ${PKGREL[$app]} are not X.Y.Z / N"
  if [[ -n "$VERSION" && "$VERSION" != "${PKGVER[$app]}" ]]; then
    die "$pb is at ${PKGVER[$app]}, not $VERSION: run ../aur/bump.sh $([[ $app == beach ]] && echo openbeach || echo openvolley) $VERSION and commit it first"
  fi
  PKGFILE[$app]="$base-bin-${PKGVER[$app]}-${PKGREL[$app]}-x86_64.pkg.tar.zst"
done
if [[ -n "$DEB" ]]; then
  [[ -f "$DEB" ]] || die "$DEB: no such file"
  DEB=$(cd "$(dirname "$DEB")" && pwd -P)/$(basename "$DEB")
fi

[[ -d "$PM_GNUPG" && -f "$PM_PASS" ]] || die "no pacman repo key in $PM_GNUPG (publish-pacman.sh --init-key, or restore it from Vaultwarden)"
[[ "$(stat -c %a "$PM_PASS")" == 600 ]] || die "$PM_PASS is mode $(stat -c %a "$PM_PASS"); chmod 600 it"
[[ "$(pmgpg --with-colons --list-secret-keys | grep -c '^sec:')" == 1 ]] || die "$PM_GNUPG must hold exactly one secret key"
FPR=$(pmgpg --with-colons --list-secret-keys | awk -F: '$1 == "sec" { s = 1; next } s && $1 == "fpr" { print $10; exit }')
if [[ -f "$ARCH_DIR/fingerprint.txt" && "$(tr -d '[:space:]' < "$ARCH_DIR/fingerprint.txt")" != "$FPR" ]]; then
  die "the repo is signed by $(tr -d '[:space:]' < "$ARCH_DIR/fingerprint.txt"), this key is $FPR: every user would have to import the new key. Restore the old key from Vaultwarden; to really change keys, delete $ARCH_DIR by hand first"
fi

# Work next to public/ (same file system): the new arch/ tree is put together
# in $WORK/arch, checked, then renamed into place.
WORK=$(mktemp -d "$PKGS/.pacman-work.XXXXXX")
cleanup() {
  gpgconf --homedir "$PM_GNUPG" --kill gpg-agent >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

sign() { pmgpg --yes --pinentry-mode loopback --passphrase-file "$PM_PASS" --local-user "$FPR" --detach-sign --no-armor -o "$1.sig" "$1"; }
pmgpg --export "$FPR" > "$WORK/key.gpg"
[[ -s "$WORK/key.gpg" ]] || die "cannot export the public key $FPR"
verify() { gpgv --keyring "$WORK/key.gpg" "$1.sig" "$1" 2>/dev/null; }

STAGE="$WORK/arch"
if [[ -d "$ARCH_DIR" ]]; then cp -a "$ARCH_DIR" "$STAGE"; fi
LIVE_REPO=$REPO
REPO="$STAGE/x86_64"

# versions_of NAME: the published versions (pkgver-pkgrel) of NAME, oldest first.
versions_of() {
  local f v
  for f in "$REPO/$1"-[0-9]*-x86_64.pkg.tar.zst; do
    [[ -e "$f" ]] || continue
    v=${f##*/"$1"-}; v=${v%-x86_64.pkg.tar.zst}
    [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+-[1-9][0-9]*$ ]] && echo "$v"
  done | sort -V
}
# vnewer A B: version A is newer than B
vnewer() { [[ "$1" != "$2" && "$(printf '%s\n' "$1" "$2" | sort -V | tail -n1)" == "$1" ]]; }

mkdir -p "$REPO"
for f in "$REPO"/*.pkg.tar.zst; do
  [[ -e "$f" ]] || continue
  ok=0
  for n in "${NAMES[@]}"; do [[ "${f##*/}" =~ ^$n-[0-9]+\.[0-9]+\.[0-9]+-[1-9][0-9]*-x86_64\.pkg\.tar\.zst$ ]] && ok=1; done
  (( ok )) || die "$f: not a package this repo publishes (${NAMES[*]}); remove it"
done

# --- 1. what to build -----------------------------------------------------------
BUILD=()
for app in "${APPS[@]}"; do
  base=$(app_pkg "$app") v="${PKGVER[$app]}-${PKGREL[$app]}"
  if [[ -f "$REPO/${PKGFILE[$app]}" ]]; then
    echo "$base-bin $v is in the repo already: kept as it is (bump pkgrel for a packaging fix)"
    continue
  fi
  newest=$(versions_of "$base-bin" | tail -n1)
  if [[ -n "$newest" ]] && vnewer "$newest" "$v"; then
    die "$base-bin $v is older than the published $newest"
  fi
  BUILD+=("$app")
done

# --- 2. build in the container ----------------------------------------------------
ensure_image() {
  local created age=999999999
  created=$(docker image inspect -f '{{.Created}}' "$IMAGE" 2>/dev/null || true)
  [[ -z "$created" ]] || age=$(( $(date +%s) - $(date -d "$created" +%s) ))
  if (( age > 7 * 86400 )); then
    echo "building the container image $IMAGE (archlinux:latest + base-devel)"
    docker build --pull -q -t "$IMAGE" - >/dev/null <<'DOCKERFILE'
FROM archlinux:latest
RUN pacman -Syu --noconfirm --needed base-devel && pacman -Scc --noconfirm
DOCKERFILE
  fi
}
ensure_image

if (( ${#BUILD[@]} )); then
  mkdir -p "$WORK/build" "$WORK/out" "$CACHE/src"
  for app in "${BUILD[@]}"; do
    base=$(app_pkg "$app")
    mkdir "$WORK/build/$base-bin"
    cp "$PKGBUILDS/$base-bin/PKGBUILD" "$WORK/build/$base-bin/"
    # the source file name the PKGBUILD gives the .deb; makepkg uses a file
    # of that name next to the PKGBUILD (and still checks its sha256)
    [[ -z "$DEB" ]] || cp "$DEB" "$WORK/build/$base-bin/$base-${PKGVER[$app]}-amd64.deb"
  done
  echo "building: ${BUILD[*]}"
  docker run --rm -i -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
    -v "$WORK/build:/work/build" -v "$WORK/out:/work/out" -v "$CACHE/src:/srcdest" "$IMAGE" bash -s <<'EOF'
set -euo pipefail
groupadd -g "$HOST_GID" builder 2>/dev/null || true
useradd -m -u "$HOST_UID" -g "$HOST_GID" builder
for d in /work/build/*/; do
  echo "== makepkg $(basename "$d")"
  (cd "$d" && runuser -u builder -- env PKGDEST=/work/out SRCDEST=/srcdest PKGEXT=.pkg.tar.zst \
    makepkg --nodeps --noconfirm --cleanbuild --clean --noprogressbar 2>&1 | tail -n 8)
done
for p in /work/out/*.pkg.tar.zst; do
  name=$(pacman -Qip "$p" | awk -F' *: ' '$1 == "Name" { print $2 }')
  base=${name%-bin}
  files=$(bsdtar -tf "$p")
  grep -qx "usr/bin/$base" <<<"$files" || { echo "$p: no /usr/bin/$base"; exit 1; }
  grep -qx "usr/lib/$base/package-manager" <<<"$files" || { echo "$p: no updater marker /usr/lib/$base/package-manager"; exit 1; }
done
EOF
  for app in "${BUILD[@]}"; do
    f="$WORK/out/${PKGFILE[$app]}"
    [[ -f "$f" ]] || die "the build made no ${PKGFILE[$app]} (made: $(ls "$WORK/out"))"
  done
fi

# --- 3. sign, add, keep the newest $KEEP ------------------------------------------
for app in "${BUILD[@]}"; do
  f="$WORK/out/${PKGFILE[$app]}"
  sign "$f" || die "cannot sign ${PKGFILE[$app]} with $FPR (passphrase?)"
  verify "$f" || die "${PKGFILE[$app]}.sig does not verify"
  install -m 644 "$f" "$f.sig" "$REPO/"
  echo "added ${PKGFILE[$app]} (signed by $FPR)"
done
for n in "${NAMES[@]}"; do
  mapfile -t vs < <(versions_of "$n")
  while (( ${#vs[@]} > KEEP )); do
    rm -f "$REPO/$n-${vs[0]}-x86_64.pkg.tar.zst" "$REPO/$n-${vs[0]}-x86_64.pkg.tar.zst.sig"
    echo "removed $n ${vs[0]} (keeping the newest $KEEP)"
    vs=("${vs[@]:1}")
  done
done
NEWEST=()
for n in "${NAMES[@]}"; do
  v=$(versions_of "$n" | tail -n1)
  [[ -z "$v" ]] || NEWEST+=("$n-$v-x86_64.pkg.tar.zst")
done
(( ${#NEWEST[@]} )) || die "no package in $REPO"
for f in "$REPO"/*.pkg.tar.zst; do
  if [[ ! -f "$f.sig" ]] || ! verify "$f"; then die "$f.sig is missing or does not verify with $FPR"; fi
done

# --- 4. database: repo-add in the container, signed here ---------------------------
mkdir -p "$WORK/db"
docker run --rm --user "$(id -u):$(id -g)" -v "$REPO:/repo:ro" -v "$WORK/db:/db" "$IMAGE" \
  bash -c 'cd /repo && repo-add --quiet --nocolor "/db/$0.db.tar.gz" "$@"' "$DB" "${NEWEST[@]}"
for kind in db files; do
  [[ -f "$WORK/db/$DB.$kind.tar.gz" ]] || die "repo-add made no $DB.$kind.tar.gz"
  cp "$WORK/db/$DB.$kind.tar.gz" "$WORK/$DB.$kind"
  sign "$WORK/$DB.$kind" || die "cannot sign $DB.$kind"
  verify "$WORK/$DB.$kind" || die "$DB.$kind.sig does not verify"
done
# the database last: it points at packages already in place
install -m 644 "$WORK/$DB.files" "$WORK/$DB.files.sig" "$WORK/$DB.db.sig" "$REPO/"
install -m 644 "$WORK/$DB.db" "$REPO/$DB.db"
# repo-add's own file names, from a repo-add run in this directory: not served
rm -f "$REPO/$DB".{db,files}.tar.* "$REPO"/*.old

# --- 5. public key ------------------------------------------------------------------
install -m 644 "$WORK/key.gpg" "$STAGE/$DB.gpg"
echo "$FPR" > "$STAGE/fingerprint.txt"
chmod 644 "$STAGE/fingerprint.txt"

# --- 6. check as a client, then put it in place ------------------------------------------
docker run --rm -i -v "$STAGE:/arch:ro" -e FPR="$FPR" -e DB="$DB" "$IMAGE" bash -s <<'EOF' || die "the repo does not verify as a pacman client sees it"
set -euo pipefail
mkdir -p /tmp/c/db /tmp/c/cache
cat > /tmp/c/pacman.conf <<CONF
[options]
Architecture = x86_64
DBPath = /tmp/c/db
CacheDir = /tmp/c/cache
GPGDir = /tmp/c/gnupg
SigLevel = Required DatabaseRequired
[$DB]
Server = file:///arch/\$arch
CONF
key() { pacman-key --config /tmp/c/pacman.conf --gpgdir /tmp/c/gnupg "$@" >/dev/null 2>&1; }
key --init
key --add "/arch/$DB.gpg"
key --lsign-key "$FPR"
pacman --config /tmp/c/pacman.conf -Sy --noprogressbar >/dev/null
pkgs=$(pacman --config /tmp/c/pacman.conf -Slq "$DB")
pacman --config /tmp/c/pacman.conf -Sw --noconfirm --nodeps --nodeps --noprogressbar $pkgs >/dev/null
EOF
chmod -R u=rwX,go=rX "$STAGE"
mkdir -p "$PUB"
[[ ! -d "$ARCH_DIR" ]] || mv "$ARCH_DIR" "$WORK/arch.old"
mv "$STAGE" "$ARCH_DIR"

echo "published in $LIVE_REPO (repository [$DB], key $FPR):"
python3 - "$LIVE_REPO/$DB.db" <<'PY'
import sys, tarfile
with tarfile.open(sys.argv[1]) as t:
    for m in sorted(t.getmembers(), key=lambda m: m.name):
        if m.name.endswith("/desc"):
            lines = t.extractfile(m).read().decode().split("\n")
            f = {lines[i]: lines[i + 1] for i in range(len(lines) - 1) if lines[i].startswith("%")}
            print(f"  pacman  {f['%NAME%']} {f['%VERSION%']}")
PY
echo "not synced: run publish-pkgs.sh to copy public/ to the server"
