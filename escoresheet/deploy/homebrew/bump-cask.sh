#!/usr/bin/env bash
# Write or bump a cask of the Homebrew tap (github.com/Lucanepa/homebrew-tap)
# for a published macOS release:
#
#   escoresheet/deploy/homebrew/bump-cask.sh [--app beach] VERSION TAP_DIR
#
#   --app beach   OpenBeach (cask openbeach, release beach-desktop-vVERSION);
#                 without it OpenVolley (cask openvolley, desktop-vVERSION)
#   TAP_DIR       a checkout of the tap; Casks/<cask>.rb is (re)written there
#
# It downloads the disk image from exactly the URL the cask will install from
# (the GitHub release asset <App>_VERSION_universal.dmg), checks it is a disk
# image, and fills its SHA-256 and VERSION into Casks/<cask>.rb (template next
# to this script). Nothing is committed or pushed: review the diff in TAP_DIR,
# then git commit and push there. Run it after publish-pkgs.sh --desktop
# VERSION [--app beach], so the cask never announces a version the app's own
# updater (latest.json) does not have yet.
#
# The casks are for this tap only: Homebrew's official cask repository takes
# no app that fails Gatekeeper (Homebrew 5: unsigned / unnotarized casks are
# disabled there from September 2026), and these apps are ad-hoc signed, not
# notarized. The cask's caveats say how to open the app the first time.
#
# OV_CASK_DMG=FILE uses FILE instead of downloading (tests).
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
die() { echo "bump-cask: $*" >&2; exit 1; }

app=openvolley
args=()
while (( $# )); do
  case "$1" in
    --app)
      (( $# > 1 )) || die "--app needs openvolley or beach"
      app=$2; shift ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) args+=("$1") ;;
  esac
  shift
done
(( ${#args[@]} == 2 )) || die "usage: bump-cask.sh [--app beach] VERSION TAP_DIR"
version=${args[0]#v}
tap=${args[1]}
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || die "$version: not a version like 2.4.0"
[[ -d "$tap" ]] || die "$tap: no such directory (git clone git@github.com:Lucanepa/homebrew-tap.git)"

case "$app" in
  openvolley) cask=openvolley tag=desktop-v dmg="OpenVolley.eScoresheet_${version}_universal.dmg" ;;
  beach) cask=openbeach tag=beach-desktop-v dmg="OpenBeach_${version}_universal.dmg" ;;
  *) die "--app $app: expected openvolley or beach" ;;
esac
template="$HERE/Casks/$cask.rb"
url="https://github.com/Lucanepa/openvolley/releases/download/$tag$version/$dmg"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
if [[ -n "${OV_CASK_DMG:-}" ]]; then
  cp "$OV_CASK_DMG" "$work/$dmg"
else
  curl -fsSL --retry 3 -o "$work/$dmg" "$url" || die "cannot download $url (is $tag$version published with its macOS build?)"
fi
# A UDIF disk image ends with a 512-byte trailer that starts with "koly".
size=$(wc -c < "$work/$dmg")
(( size > 512 )) && [[ "$(tail -c 512 "$work/$dmg" | head -c 4)" == koly ]] || die "$url is not a disk image"
if command -v sha256sum >/dev/null; then sha=$(sha256sum "$work/$dmg"); else sha=$(shasum -a 256 "$work/$dmg"); fi
sha=${sha%% *}
[[ "$sha" =~ ^[0-9a-f]{64}$ ]] || die "no SHA-256 for $dmg"

mkdir -p "$tap/Casks"
out="$tap/Casks/$cask.rb"
# the template's first two comment lines are for this repository only
sed -e '1,2d' -e "s/@VERSION@/$version/" -e "s/@SHA256@/$sha/" "$template" > "$work/$cask.rb"
! grep -q '@[A-Z0-9_]*@' "$work/$cask.rb" || die "$template has unfilled placeholders"
grep -qx "  version \"$version\"" "$work/$cask.rb" && grep -qx "  sha256 \"$sha\"" "$work/$cask.rb" || die "$template: version / sha256 lines not filled"
if command -v ruby >/dev/null; then ruby -c "$work/$cask.rb" >/dev/null || die "$cask.rb: Ruby syntax error"; fi
install -m 644 "$work/$cask.rb" "$out"
echo "wrote $out: $cask $version, sha256 $sha"
echo "next: cd $tap && git diff && git commit -am \"$cask $version\" && git push"
