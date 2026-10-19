#!/usr/bin/env bash
# Write or bump a cask of the Homebrew tap (github.com/Lucanepa/homebrew-tap)
# for a published macOS release:
#
#   escoresheet/deploy/homebrew/bump-cask.sh [--app beach|point-hub] VERSION TAP_DIR
#
#   --app beach   OpenBeach (cask openbeach, release beach-desktop-vVERSION);
#                 without it OpenVolley (cask openvolley, desktop-vVERSION)
#   --app point-hub
#                 Point Hub (cask point-hub, release desktop-vVERSION of
#                 Lucanepa/point-hub): two disk images, Point-Hub-VERSION-macos-arm64.dmg
#                 and -x64.dmg, one SHA-256 each (arch arm: / intel:). The app
#                 bundle's name is read from the images (7z): it must be the
#                 same in both, its CFBundleIdentifier ch.kscw.pointhub and
#                 its version VERSION; the cask's app and caveats use it. No
#                 auto_updates (Point Hub has no updater).
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
# OV_CASK_DMG=FILE uses FILE instead of downloading (tests; for Point Hub
# both images, or OV_CASK_DMG_ARM64 / OV_CASK_DMG_X64 each), and
# OV_CASK_APP_INFO="NAME.app|ID|VERSION" what the images' Info.plist says
# instead of reading it (tests with fake images).
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
(( ${#args[@]} == 2 )) || die "usage: bump-cask.sh [--app beach|point-hub] VERSION TAP_DIR"
version=${args[0]#v}
tap=${args[1]}
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || die "$version: not a version like 2.4.0"
[[ -d "$tap" ]] || die "$tap: no such directory (git clone git@github.com:Lucanepa/homebrew-tap.git)"

case "$app" in
  openvolley) cask=openvolley tag=desktop-v dmg="OpenVolley.eScoresheet_${version}_universal.dmg" ;;
  beach) cask=openbeach tag=beach-desktop-v dmg="OpenBeach_${version}_universal.dmg" ;;
  point-hub) cask=point-hub tag=desktop-v dmg= ;;
  *) die "--app $app: expected openvolley, beach or point-hub" ;;
esac
template="$HERE/Casks/$cask.rb"
url="https://github.com/Lucanepa/openvolley/releases/download/$tag$version/$dmg"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Point Hub: its own repository, one disk image per architecture.
if [[ "$app" == point-hub ]]; then
  declare -A sha_of=()
  app_name=
  for a in arm64 x64; do
    dmg="Point-Hub-${version}-macos-$a.dmg"
    url="https://github.com/Lucanepa/point-hub/releases/download/$tag$version/$dmg"
    local_dmg=${OV_CASK_DMG:-}
    [[ "$a" != arm64 || -z "${OV_CASK_DMG_ARM64:-}" ]] || local_dmg=$OV_CASK_DMG_ARM64
    [[ "$a" != x64 || -z "${OV_CASK_DMG_X64:-}" ]] || local_dmg=$OV_CASK_DMG_X64
    if [[ -n "$local_dmg" ]]; then
      cp "$local_dmg" "$work/$dmg"
    else
      curl -fsSL --retry 3 -o "$work/$dmg" "$url" || die "cannot download $url (is $tag$version of Lucanepa/point-hub published?)"
    fi
    size=$(wc -c < "$work/$dmg")
    (( size > 512 )) && [[ "$(tail -c 512 "$work/$dmg" | head -c 4)" == koly ]] || die "$url is not a disk image"
    if command -v sha256sum >/dev/null; then sha=$(sha256sum "$work/$dmg"); else sha=$(shasum -a 256 "$work/$dmg"); fi
    sha=${sha%% *}
    [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || die "no SHA-256 for $dmg"
    sha_of[$a]=$sha
    # The bundle the cask installs: <volume>/<Name>.app at the top of the image.
    if [[ -n "${OV_CASK_APP_INFO:-}" ]]; then
      info=$OV_CASK_APP_INFO
    else
      command -v 7z >/dev/null || die "7z (p7zip / 7-Zip) is needed to read the app's name from $dmg"
      # (-slt: one "Path = ..." line per entry, so names with spaces stay whole)
      plist=$(7z l -slt -ba "$work/$dmg" 2>/dev/null | sed -n 's/^Path = //p' | grep -E '^[^/]+/[^/]+\.app/Contents/Info\.plist$' | sort -u) || true
      [[ -n "$plist" && "$plist" != *$'\n'* ]] || die "$dmg: expected one <Name>.app at its top, found: ${plist:-none}"
      info=$(7z e -so "$work/$dmg" "$plist" 2>/dev/null | python3 -c '
import plistlib, sys
p = plistlib.loads(sys.stdin.buffer.read())
print(sys.argv[1], p.get("CFBundleIdentifier", ""), p.get("CFBundleShortVersionString", ""), sep="|")' "$(basename "$(dirname "$(dirname "$plist")")")") ||
        die "$dmg: cannot read $plist"
    fi
    IFS='|' read -r name id v <<<"$info"
    [[ "$name" == *.app && "$id" == ch.kscw.pointhub && "$v" == "$version" ]] ||
      die "$dmg: the bundle is '$info' (name, identifier, version), expected <Name>.app ch.kscw.pointhub $version"
    [[ -z "$app_name" || "$app_name" == "$name" ]] || die "the two images hold different apps: $app_name and $name"
    app_name=$name
  done
  mkdir -p "$tap/Casks"
  out="$tap/Casks/$cask.rb"
  sed -e '1,2d' -e "s/@VERSION@/$version/" -e "s/@SHA256_ARM64@/${sha_of[arm64]}/" -e "s/@SHA256_X64@/${sha_of[x64]}/" \
    -e "s/@APP@/$app_name/g" "$template" > "$work/$cask.rb"
  ! grep -q '@[A-Z0-9_]*@' "$work/$cask.rb" || die "$template has unfilled placeholders"
  grep -qx "  version \"$version\"" "$work/$cask.rb" && grep -qx "  sha256 arm:   \"${sha_of[arm64]}\"," "$work/$cask.rb" &&
    grep -qx "         intel: \"${sha_of[x64]}\"" "$work/$cask.rb" && grep -qx "  app \"$app_name\"" "$work/$cask.rb" ||
    die "$template: version / sha256 / app lines not filled"
  if command -v ruby >/dev/null; then ruby -c "$work/$cask.rb" >/dev/null || die "$cask.rb: Ruby syntax error"; fi
  install -m 644 "$work/$cask.rb" "$out"
  echo "wrote $out: $cask $version, $app_name, sha256 arm64 ${sha_of[arm64]}, x64 ${sha_of[x64]}"
  echo "next: cd $tap && git diff && git commit -am \"$cask $version\" && git push"
  exit 0
fi
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
