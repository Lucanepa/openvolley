#!/bin/sh
# OpenVolley eScoresheet installer for Debian, Ubuntu and derivatives (amd64).
#
#   curl -fsSL https://get.openvolley.app/install.sh | sudo sh
#
# Adds the signed OpenVolley APT repository and installs the package
# openvolley-escoresheet; from then on `sudo apt upgrade` keeps it current.
# Safe to run again: it rewrites the same two files and installs or upgrades
# the package.
#
#   1. Checks: apt-get and dpkg, amd64, root.
#   2. Installs curl, ca-certificates and gpg first if any is missing.
#   3. Downloads the repository key and refuses it unless it holds exactly one
#      primary key, fingerprint FPR below, neither revoked nor expired. Only
#      then writes it to /usr/share/keyrings/openvolley.gpg.
#   4. Writes /etc/apt/sources.list.d/openvolley.list (signed-by that keyring,
#      so the key is trusted for this repository only), runs apt-get update and
#      apt-get install -y openvolley-escoresheet. An older install under the
#      name openvolley-e-scoresheet (a .deb from GitHub up to 1.48.19) is
#      replaced: the package provides, replaces and conflicts with it.
#
# OV_PKGS_BASE overrides https://get.openvolley.app (testing only).
#
# Undo: sudo apt remove openvolley-escoresheet &&
#       sudo rm /etc/apt/sources.list.d/openvolley.list /usr/share/keyrings/openvolley.gpg
#
# Everything runs from main at the very end, so a download cut short
# executes nothing.

FPR=AB469DA8DC3EC90F8057320D285B18D76C16B82C
PKG=openvolley-escoresheet

set -eu

BASE=${OV_PKGS_BASE:-https://get.openvolley.app}
BASE=${BASE%/}
KEYRING=/usr/share/keyrings/openvolley.gpg
LIST=/etc/apt/sources.list.d/openvolley.list
TMP=

say() { printf 'openvolley: %s\n' "$*"; }
die() { printf 'openvolley: %s\n' "$*" >&2; exit 1; }
cleanup() { [ -z "$TMP" ] || rm -rf "$TMP"; }

# apt-get without prompts, and never reading the piped script from stdin.
apt_get() { DEBIAN_FRONTEND=noninteractive apt-get -q "$@" </dev/null; }

# Prints the fingerprint of every primary key in FILE, one per line, prefixed
# "unusable:" when the key is revoked, expired or disabled.
key_fingerprints() {
  GNUPGHOME="$TMP/gnupg" gpg --batch --no-options --with-colons --show-keys "$1" 2>/dev/null </dev/null |
    awk -F: '$1 == "pub" { want = 1; bad = ($2 ~ /^[red]/); next }
             $1 == "fpr" && want { print (bad ? "unusable:" : "") $10; want = 0 }'
}

main() {
  # --- 1. checks -------------------------------------------------------------
  if ! command -v apt-get >/dev/null 2>&1 || ! command -v dpkg >/dev/null 2>&1; then
    die "this installer is for Debian, Ubuntu and their derivatives (needs apt-get and dpkg).
  For Windows and Android see https://get.openvolley.app"
  fi
  arch=$(dpkg --print-architecture)
  if [ "$arch" != amd64 ]; then
    die "OpenVolley eScoresheet for Linux is built for 64-bit PCs (amd64) only; this system is $arch.
  For Windows and Android see https://get.openvolley.app"
  fi
  if [ "$(id -u)" -ne 0 ]; then
    die "needs root. Run it with sudo:
  curl -fsSL $BASE/install.sh | sudo sh"
  fi

  TMP=$(mktemp -d)
  trap cleanup EXIT
  trap 'exit 130' INT TERM
  mkdir -m 700 "$TMP/gnupg"

  # --- 2. tools --------------------------------------------------------------
  need=
  command -v curl >/dev/null 2>&1 || need="$need curl"
  [ -s /etc/ssl/certs/ca-certificates.crt ] || need="$need ca-certificates"
  command -v gpg >/dev/null 2>&1 || need="$need gpg"
  if [ -n "$need" ]; then
    say "installing$need"
    apt_get update
    # shellcheck disable=SC2086
    apt_get install -y --no-install-recommends $need
  fi

  # --- 3. key ----------------------------------------------------------------
  say "downloading the repository key"
  curl -fsSL --retry 3 -o "$TMP/openvolley.gpg" "$BASE/apt/openvolley.gpg" ||
    die "cannot download $BASE/apt/openvolley.gpg"
  fprs=$(key_fingerprints "$TMP/openvolley.gpg") || fprs=
  if [ "$fprs" != "$FPR" ]; then
    die "the downloaded key is not the OpenVolley key; nothing was changed.
  expected: $FPR
  got:      $(printf '%s' "${fprs:-unreadable}" | tr '\n' ' ')"
  fi
  say "key fingerprint verified: $FPR"
  install -m 644 "$TMP/openvolley.gpg" "$KEYRING.new"
  mv -f "$KEYRING.new" "$KEYRING"

  # --- 4. repository and package ---------------------------------------------
  printf 'deb [arch=amd64 signed-by=%s] %s/apt stable main\n' "$KEYRING" "$BASE" > "$LIST.new"
  chmod 644 "$LIST.new"
  mv -f "$LIST.new" "$LIST"
  say "repository: $(cat "$LIST")"

  apt_get update
  apt_get install -y "$PKG"

  version=$(dpkg-query -W -f '${Version}' "$PKG" 2>/dev/null) || version=
  [ -n "$version" ] || die "$PKG did not install"
  cat <<EOF

OpenVolley eScoresheet $version is installed.

  Start it:          from the app menu (OpenVolley eScoresheet), or run: $PKG
  Tablet server only (no window, e.g. on a headless box):
                     $PKG --server-only
  Updates:           sudo apt update && sudo apt upgrade
  Remove:            sudo apt remove $PKG

In the app, the header menu > Connect tablets shows the addresses the tablets use.
EOF
}

main "$@"
