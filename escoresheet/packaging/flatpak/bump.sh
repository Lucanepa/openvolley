#!/usr/bin/env bash
# Points a Flatpak manifest at a new release and lists it in the metainfo.
#
#   escoresheet/packaging/flatpak/bump.sh <openvolley|beach> VERSION
#
# Downloads the release .deb from GitHub (tag desktop-vVERSION or
# beach-desktop-vVERSION), checks its package and version, writes its URL and
# SHA-256 into <app id>.json and adds <release VERSION> (date: the GitHub
# release's, notes: the fastlane changelog when there is one) to
# <app id>.metainfo.xml. Commit both; for Flathub, the same change goes to the
# Flathub repo of the app (README.md).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd -P)
repo_root=$(cd "$here/../../.." && pwd -P)
die() { echo "bump: $*" >&2; exit 1; }

case ${1:-} in
  openvolley) id=com.openvolley.escoresheet cmd=openvolley-escoresheet tag_prefix=desktop-v name=OpenVolley
    logs="$repo_root/fastlane/metadata/android/en-US/changelogs" ;;
  beach) id=com.openvolley.beach cmd=openbeach-escoresheet tag_prefix=beach-desktop-v name=OpenBeach
    logs="$repo_root/openbeach/fastlane/metadata/android/en-US/changelogs" ;;
  *) die "usage: $0 <openvolley|beach> VERSION" ;;
esac
v=${2#v}
[[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "usage: $0 <openvolley|beach> VERSION (like 2.4.0)"
tag=$tag_prefix$v
url="https://github.com/Lucanepa/openvolley/releases/download/$tag/${cmd}_${v}_amd64.deb"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/app.deb" "$url" || die "cannot download $url"
[[ "$(dpkg-deb -f "$tmp/app.deb" Package)" == "$cmd" && "$(dpkg-deb -f "$tmp/app.deb" Version)" == "$v" ]] ||
  die "$url is not $cmd $v"
sha=$(sha256sum "$tmp/app.deb" | cut -d' ' -f1)

date=$(date -u +%F)
if command -v gh >/dev/null; then
  published=$(gh release view "$tag" --repo Lucanepa/openvolley --json publishedAt -q .publishedAt 2>/dev/null || true)
  [[ -z "$published" ]] || date=${published%%T*}
fi

IFS=. read -r maj min pat <<<"$v"
code=$(( (maj * 1000000 + min * 1000 + pat) * 10 ))
notes=()
for b in 9 8 7 6 5 4 3 2 1 0; do
  if [[ -f "$logs/$((code + b)).txt" ]]; then
    sed "1{/^$name /d}" "$logs/$((code + b)).txt" > "$tmp/notes.txt"
    notes=("$tmp/notes.txt")
    break
  fi
done

python3 "$here/flatpak-meta.py" set-deb "$here/$id.json" --url "$url" --sha256 "$sha"
python3 "$here/flatpak-meta.py" add-release "$here/$id.metainfo.xml" "$v" "$date" \
  "https://github.com/Lucanepa/openvolley/releases/tag/$tag" "${notes[@]}"
echo "$id.json: $cmd $v ($sha)"
(( ${#notes[@]} )) || echo "no fastlane changelog for $v: the release has no notes"
