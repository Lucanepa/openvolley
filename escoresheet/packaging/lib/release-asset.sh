# shellcheck shell=bash
# Signed release assets for the channel scripts that pin an installer's
# SHA-256 (aur/bump.sh, flatpak/bump.sh, snap/bump.sh,
# scoop/update-manifests.sh, winget/update-manifests.sh). Sourced, never run.
#
# Every installer of a desktop release gets <file>.sig from
# deploy/publish-pkgs.sh --desktop (the updater key, bound to the version and
# the file name). A channel pins a hash only of a file whose .sig verifies
# against the key the app trusts (plugins.updater.pubkey in tauri.conf.json /
# tauri.beach.conf.json, as committed here), so an asset replaced on GitHub
# after it was signed is never pinned. It fails closed: no .sig, no node, a
# wrong key, version or file name, and the script stops. Node is the only
# tool it needs (deploy/lib/desktop-updater.mjs; minisign is not needed).
#
#   release_asset_fetch APP VERSION URL DIR   URL and URL.sig into DIR (under
#                                             the URL's file name), verified;
#                                             prints the local path
#   release_asset_verify APP VERSION FILE     FILE.sig next to FILE verifies
#
# APP: openvolley, openbeach (or beach). The caller runs under set -euo pipefail.
# OV_DESKTOP_TAURI_CONF / OV_BEACH_TAURI_CONF replace the committed configs
# (tests with a throwaway key, as in deploy/lib/publish-lib.sh).

RELEASE_ASSET_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)

release_asset_die() { echo "release-asset: $*" >&2; exit 1; }

# release_asset_conf APP: the Tauri config whose updater key APP trusts.
release_asset_conf() {
  case "$1" in
    openvolley) echo "${OV_DESKTOP_TAURI_CONF:-$RELEASE_ASSET_ROOT/frontend/src-tauri/tauri.conf.json}" ;;
    openbeach|beach) echo "${OV_BEACH_TAURI_CONF:-$RELEASE_ASSET_ROOT/frontend/src-tauri/tauri.beach.conf.json}" ;;
    *) release_asset_die "unknown app $1 (openvolley or openbeach)" ;;
  esac
}

release_asset_verify() {
  local app=$1 v=$2 f=$3 conf
  conf=$(release_asset_conf "$app")
  command -v node >/dev/null || release_asset_die "node is needed to check $(basename "$f").sig (nothing was pinned)"
  [[ -f "$f" ]] || release_asset_die "no such file: $f"
  [[ -f "$f.sig" ]] ||
    release_asset_die "no $(basename "$f").sig next to $f: only a file signed by publish-pkgs.sh --desktop is pinned (download it from the release too)"
  node "$RELEASE_ASSET_ROOT/deploy/lib/desktop-updater.mjs" verify --tauri-conf "$conf" --version "$v" --check-name "$f" >&2 ||
    release_asset_die "$(basename "$f"): its signature does not verify against the updater key in $(basename "$conf"): not pinned"
}

release_asset_fetch() {
  local app=$1 v=$2 url=$3 dir=$4 name
  name=$(basename "${url%%#*}")
  [[ "$name" =~ ^[A-Za-z0-9._+-]+$ ]] || release_asset_die "unexpected file name in $url"
  mkdir -p "$dir"
  echo "downloading ${url%%#*}" >&2
  curl -fsSL --retry 3 -o "$dir/$name" "${url%%#*}" || release_asset_die "could not download ${url%%#*}"
  curl -fsSL --retry 3 -o "$dir/$name.sig" "${url%%#*}.sig" ||
    release_asset_die "could not download ${url%%#*}.sig (publish-pkgs.sh --desktop $v uploads it: run that first)"
  release_asset_verify "$app" "$v" "$dir/$name"
  echo "$dir/$name"
}
