#!/usr/bin/env bash
# Regenerate the winget manifests of one app for a new version.
#
#   escoresheet/packaging/winget/update-manifests.sh openvolley 2.4.0
#   escoresheet/packaging/winget/update-manifests.sh openbeach  2.0.1
#
# Writes manifests/l/Lucanepa/<OpenVolley|OpenBeach>/<version>/ (the same
# path as in microsoft/winget-pkgs, so the folder can be copied into a fork
# as it is) and removes the older version folders of that app here: winget-pkgs
# keeps every version, this repo keeps only the one to submit.
#
# The installer's SHA-256 and the release date come from the GitHub release
# (the Windows installer is downloaded once, ~7 MB). Overrides, e.g. before
# the release is published:
#   --file PATH        hash a local copy of the setup .exe instead
#   --sha256 HEX       use this hash, download nothing
#   --date YYYY-MM-DD  release date (default: the release's publish date,
#                      or today when it cannot be read)
#
# Then check them: escoresheet/packaging/winget/validate.sh
set -euo pipefail

REPO=Lucanepa/openvolley
MANIFEST_VERSION=1.28.0
HERE=$(cd "$(dirname "$0")" && pwd)

die() { echo "update-manifests: $*" >&2; exit 1; }

[ $# -ge 2 ] || die "usage: $0 openvolley|openbeach VERSION [--file PATH | --sha256 HEX] [--date YYYY-MM-DD]"
app=$1 version=$2
shift 2
file='' sha='' date=''
while [ $# -gt 0 ]; do
  case $1 in
    --file) file=${2:?}; shift 2 ;;
    --sha256) sha=${2:?}; shift 2 ;;
    --date) date=${2:?}; shift 2 ;;
    *) die "unknown option $1" ;;
  esac
done
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must look like 2.4.0, got '$version'"
[ -z "$date" ] || [[ $date =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || die "--date must be YYYY-MM-DD"

# One block per app. ProductCode / DisplayName are what Tauri's NSIS installer
# writes to Apps & features: the uninstall key is the productName of
# tauri.conf.json / tauri.beach.conf.json, the Publisher is the second part of
# the identifier (no bundle.publisher is set), the folder is
# %ProgramFiles%\<productName> (installMode perMachine).
case $app in
  openvolley)
    id=Lucanepa.OpenVolley
    dir_name=OpenVolley
    tag=desktop-v$version
    asset=Openvolley.eScoresheet_${version}_x64-setup.exe
    product="Openvolley eScoresheet"
    package_name="OpenVolley eScoresheet"
    moniker=openvolley
    package_url=https://openvolley.app
    license_url=https://github.com/Lucanepa/openvolley/blob/main/escoresheet/LICENSE
    short_en="Open Source Volleyball eScoresheet"
    desc_en="Fully offline volleyball e-scoresheet. Runs the scoretable and a built-in LAN server, so the referee, bench and livescore tablets connect over the same Wi-Fi: no internet, no accounts. The computer can open its own Wi-Fi for the tablets."
    short_de="Elektronisches Matchblatt für Volleyball (Open Source)"
    desc_de="Elektronisches Volleyball-Matchblatt, das komplett offline funktioniert. Es betreibt den Schreibertisch und einen eingebauten LAN-Server, damit sich die Tablets von Schiedsrichter, Mannschaften und Livescore über dasselbe WLAN verbinden: ohne Internet, ohne Anmeldung. Der Computer kann dafür ein eigenes WLAN für die Tablets öffnen."
    tags=(volleyball scoresheet escoresheet scorekeeping sports referee livescore offline)
    ;;
  openbeach|beach)
    id=Lucanepa.OpenBeach
    dir_name=OpenBeach
    tag=beach-desktop-v$version
    asset=OpenBeach_${version}_x64-setup.exe
    product="OpenBeach"
    package_name="OpenBeach"
    moniker=openbeach
    package_url=https://beach.openvolley.app
    license_url=https://github.com/Lucanepa/openbeach/blob/main/escoresheet/LICENSE
    short_en="Open Source Beach Volleyball eScoresheet"
    desc_en="Fully offline beach volleyball e-scoresheet. Runs the scoretable and a built-in LAN server, so the referee and livescore tablets and the court displays connect over the same Wi-Fi: no internet, no accounts. The computer can open its own Wi-Fi for the tablets."
    short_de="Elektronisches Matchblatt für Beachvolleyball (Open Source)"
    desc_de="Elektronisches Beachvolleyball-Matchblatt, das komplett offline funktioniert. Es betreibt den Schreibertisch und einen eingebauten LAN-Server, damit sich die Tablets von Schiedsrichter und Livescore und die Court-Anzeigen über dasselbe WLAN verbinden: ohne Internet, ohne Anmeldung. Der Computer kann dafür ein eigenes WLAN für die Tablets öffnen."
    tags=(beach-volleyball volleyball scoresheet escoresheet scorekeeping sports referee livescore offline)
    ;;
  *) die "app must be openvolley or openbeach, got '$app'" ;;
esac

url=https://github.com/$REPO/releases/download/$tag/$asset
release_notes_url=https://github.com/$REPO/releases/tag/$tag

# --- SHA-256 of the installer ------------------------------------------------
if [ -z "$sha" ]; then
  if [ -z "$file" ]; then
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    echo "downloading $url" >&2
    curl -fsSL --retry 3 -o "$tmp/$asset" "$url" || die "could not download $url (is the release published? or pass --file / --sha256)"
    file=$tmp/$asset
  fi
  [ -f "$file" ] || die "no such file: $file"
  sha=$(sha256sum "$file" | cut -d' ' -f1)
fi
[[ $sha =~ ^[0-9a-fA-F]{64}$ ]] || die "not a SHA-256: $sha"
sha=$(printf '%s' "$sha" | tr 'a-f' 'A-F')

# --- release date --------------------------------------------------------------
if [ -z "$date" ]; then
  date=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/tags/$tag" 2>/dev/null \
    | sed -n 's/^ *"published_at": *"\([0-9-]\{10\}\)T.*/\1/p' | head -1 || true)
  [ -n "$date" ] || { date=$(date -u +%Y-%m-%d); echo "release date unknown, using today ($date)" >&2; }
fi

# --- write ---------------------------------------------------------------------
base=$HERE/manifests/l/Lucanepa/$dir_name
out=$base/$version
# only the version being submitted stays here
if [ -d "$base" ]; then
  find "$base" -mindepth 1 -maxdepth 1 -type d ! -name "$version" -exec rm -r {} +
fi
mkdir -p "$out"

header() {
  printf '# yaml-language-server: $schema=https://aka.ms/winget-manifest.%s.%s.schema.json\n' "$1" "$MANIFEST_VERSION"
  printf '# Generated by escoresheet/packaging/winget/update-manifests.sh\n\n'
}
tag_list() { local t; for t in "$@"; do printf -- '- %s\n' "$t"; done; }
# a YAML single-quoted scalar (the texts contain ": ")
q() { local s=${1//\'/\'\'}; printf "'%s'" "$s"; }

{
  header version
  cat <<EOF
PackageIdentifier: $id
PackageVersion: $version
DefaultLocale: en-US
ManifestType: version
ManifestVersion: $MANIFEST_VERSION
EOF
} >"$out/$id.yaml"

# Scope machine + elevatesSelf: installMode perMachine (Program Files, the
# installer asks for administrator rights itself). /S is NSIS's silent switch;
# Tauri's installer has no separate "silent with progress" mode that winget
# can use (/P is its passive mode, which winget does not need).
# UpgradeBehavior install: the new installer replaces the old one in place
# (it quits a running copy cleanly first, see windows/installer-hooks.nsh).
{
  header installer
  cat <<EOF
PackageIdentifier: $id
PackageVersion: $version
InstallerType: nullsoft
Scope: machine
InstallerSwitches:
  Silent: /S
  SilentWithProgress: /S
UpgradeBehavior: install
ElevationRequirement: elevatesSelf
ProductCode: $product
ReleaseDate: $date
AppsAndFeaturesEntries:
- DisplayName: $product
  Publisher: openvolley
  DisplayVersion: $version
  ProductCode: $product
InstallationMetadata:
  DefaultInstallLocation: '%ProgramFiles%\\$product'
Installers:
- Architecture: x64
  InstallerUrl: $url
  InstallerSha256: $sha
ManifestType: installer
ManifestVersion: $MANIFEST_VERSION
EOF
} >"$out/$id.installer.yaml"

{
  header defaultLocale
  cat <<EOF
PackageIdentifier: $id
PackageVersion: $version
PackageLocale: en-US
Publisher: OpenVolley
PublisherUrl: https://openvolley.app
PublisherSupportUrl: https://github.com/$REPO/issues
PrivacyUrl: https://openvolley.app/en/privacy
Author: Luca Canepa
PackageName: $(q "$package_name")
PackageUrl: $package_url
License: GPL-3.0-or-later
LicenseUrl: $license_url
ShortDescription: $(q "$short_en")
Description: $(q "$desc_en")
Moniker: $moniker
Tags:
$(tag_list "${tags[@]}")
ReleaseNotesUrl: $release_notes_url
ManifestType: defaultLocale
ManifestVersion: $MANIFEST_VERSION
EOF
} >"$out/$id.locale.en-US.yaml"

{
  header locale
  cat <<EOF
PackageIdentifier: $id
PackageVersion: $version
PackageLocale: de-CH
Publisher: OpenVolley
PublisherUrl: https://openvolley.app
PublisherSupportUrl: https://github.com/$REPO/issues
PrivacyUrl: https://openvolley.app/datenschutz
Author: Luca Canepa
PackageName: $(q "$package_name")
PackageUrl: $package_url
License: GPL-3.0-or-later
LicenseUrl: $license_url
ShortDescription: $(q "$short_de")
Description: $(q "$desc_de")
Tags:
$(tag_list "${tags[@]}")
ReleaseNotesUrl: $release_notes_url
ManifestType: locale
ManifestVersion: $MANIFEST_VERSION
EOF
} >"$out/$id.locale.de-CH.yaml"

echo "wrote ${out#"$HERE"/}/ ($id $version, sha256 $sha, $date)"
