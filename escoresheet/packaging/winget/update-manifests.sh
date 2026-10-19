#!/usr/bin/env bash
# Regenerate the winget manifests of one app for a new version.
#
#   escoresheet/packaging/winget/update-manifests.sh openvolley 2.4.0
#   escoresheet/packaging/winget/update-manifests.sh openbeach  2.0.1
#   escoresheet/packaging/winget/update-manifests.sh point-hub  1.1.0
#
# Writes manifests/l/Lucanepa/<OpenVolley|OpenBeach>/<version>/ (the same
# path as in microsoft/winget-pkgs, so the folder can be copied into a fork
# as it is) and removes the older version folders of that app here: winget-pkgs
# keeps every version, this repo keeps only the one to submit. point-hub:
# KSCWiedikon.PointHub (KSC Wiedikon's scoreboard console, the .msi of
# Lucanepa/point-hub's release desktop-v<version>) in manifests/k/KSCWiedikon/PointHub/.
#
# The installer's SHA-256 and the release date come from the GitHub release
# (the Windows installer is downloaded once, ~7 MB; Point Hub's .msi ~220 MB).
# For Point Hub the .msi itself is read too (msitools' msiinfo, or in a
# debian container): its ProductVersion must be the version, its UpgradeCode
# Point Hub's, it must install per machine, and its ProductCode goes into the
# manifest. Overrides, e.g. before the release is published:
#   --file PATH        hash a local copy of the installer instead
#   --sha256 HEX       use this hash, download nothing (Point Hub: with
#                      --product-code {GUID}, as there is no .msi to read)
#   --date YYYY-MM-DD  release date (default: the release's publish date,
#                      or today when it cannot be read)
#   --placeholder      before the first release (Point Hub): InstallerSha256
#                      @SHA256@, no ProductCode and no ReleaseDate; validate.sh
#                      reports it as pending until the release is out. Run
#                      again without it after the release.
#
# Then check them: escoresheet/packaging/winget/validate.sh
set -euo pipefail

REPO=Lucanepa/openvolley
MANIFEST_VERSION=1.28.0
HERE=$(cd "$(dirname "$0")" && pwd)

die() { echo "update-manifests: $*" >&2; exit 1; }

[ $# -ge 2 ] || die "usage: $0 openvolley|openbeach|point-hub VERSION [--file PATH | --sha256 HEX [--product-code GUID] | --placeholder] [--date YYYY-MM-DD]"
app=$1 version=$2
shift 2
file='' sha='' date='' product_code='' placeholder=0
while [ $# -gt 0 ]; do
  case $1 in
    --file) file=${2:?}; shift 2 ;;
    --sha256) sha=${2:?}; shift 2 ;;
    --date) date=${2:?}; shift 2 ;;
    --product-code) product_code=${2:?}; shift 2 ;;
    --placeholder) placeholder=1; shift ;;
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
    tags=(beach-volleyball volleyball scoresheet escoresheet scorekeeping sports referee livescore offline)
    ;;
  point-hub|pointhub)
    # Point Hub: KSC Wiedikon's, from its own repository; jpackage's .msi
    # (WiX), per machine. DisplayName / Publisher are what that .msi writes
    # to Apps & features (ProductName point-hub, Manufacturer KSC Wiedikon);
    # the UpgradeCode is fixed in point-hub's android/desktop/build.gradle.kts.
    app=point-hub
    REPO=Lucanepa/point-hub
    id=KSCWiedikon.PointHub
    publisher_dir=KSCWiedikon
    dir_name=PointHub
    tag=desktop-v$version
    asset=point-hub-$version.msi
    product="point-hub"
    upgrade_code='{6F0C3A2E-6C7B-4D44-9A3E-2F5A8E1B7C10}'
    package_name="Point Hub"
    moniker=point-hub
    package_url=https://github.com/Lucanepa/point-hub
    license_url=https://github.com/Lucanepa/point-hub/blob/main/LICENSE
    short_en="The console of the LedBox scoreboard"
    desc_en="Point Hub is the console of the LedBox scoreboard, for the scorer's table. It finds the scoreboard on its own Wi-Fi or on the cable, also without internet, and shows the board's console: the game on the board, the link to an OpenVolley eScoresheet match, the history and the settings."
    tags=(scoreboard volleyball ledbox sports console)
    ;;
  *) die "app must be openvolley, openbeach or point-hub, got '$app'" ;;
esac
publisher_dir=${publisher_dir:-Lucanepa}
(( ! placeholder )) || [ -z "$file$sha$product_code" ] || die "--placeholder takes no --file, --sha256 or --product-code"

url=https://github.com/$REPO/releases/download/$tag/$asset
release_notes_url=https://github.com/$REPO/releases/tag/$tag

# --- SHA-256 of the installer ------------------------------------------------
if (( placeholder )); then
  # quoted: a YAML value cannot start with @
  sha="'@SHA256@'"
elif [ -z "$sha" ]; then
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
(( placeholder )) || [[ $sha =~ ^[0-9a-fA-F]{64}$ ]] || die "not a SHA-256: $sha"
sha=$(printf '%s' "$sha" | tr 'a-f' 'A-F')

# --- Point Hub: what its .msi says ----------------------------------------------
# msi_property FILE NAME: a value of the .msi's Property table (msitools).
msi_property() {
  if command -v msiinfo >/dev/null 2>&1; then
    msiinfo export "$1" Property
  else
    command -v docker >/dev/null 2>&1 || die "need msiinfo (apt install msitools) or docker to read $1"
    docker run --rm -v "$(realpath "$1"):/m.msi:ro" debian:trixie-slim sh -c \
      'apt-get update -qq >/dev/null && apt-get install -y -qq msitools >/dev/null 2>&1 && msiinfo export /m.msi Property'
  fi | tr -d '\r' | awk -F '\t' -v k="$2" '$1 == k { print $2; exit }'
}
if [ "$app" = point-hub ] && (( ! placeholder )); then
  if [ -n "$file" ]; then
    msi_version=$(msi_property "$file" ProductVersion)
    msi_upgrade=$(msi_property "$file" UpgradeCode)
    msi_allusers=$(msi_property "$file" ALLUSERS)
    msi_code=$(msi_property "$file" ProductCode)
    [ "$msi_version" = "$version" ] || die "$file: ProductVersion '$msi_version', expected $version"
    [ "$msi_upgrade" = "$upgrade_code" ] || die "$file: UpgradeCode '$msi_upgrade', expected $upgrade_code"
    [ "$msi_allusers" = 1 ] || die "$file: not a per-machine package (ALLUSERS '$msi_allusers', expected 1)"
    [ -z "$product_code" ] || [ "$product_code" = "$msi_code" ] || die "--product-code $product_code, but $file says $msi_code"
    product_code=$msi_code
  fi
  [[ $product_code =~ ^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$ ]] ||
    die "no ProductCode for the .msi (--sha256 needs --product-code {GUID}), got '$product_code'"
fi

# --- release date --------------------------------------------------------------
if (( placeholder )); then
  :
elif [ -z "$date" ]; then
  date=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/tags/$tag" 2>/dev/null \
    | sed -n 's/^ *"published_at": *"\([0-9-]\{10\}\)T.*/\1/p' | head -1 || true)
  [ -n "$date" ] || { date=$(date -u +%Y-%m-%d); echo "release date unknown, using today ($date)" >&2; }
fi

# --- write ---------------------------------------------------------------------
base=$HERE/manifests/$(printf '%s' "$publisher_dir" | cut -c1 | tr 'A-Z' 'a-z')/$publisher_dir/$dir_name
out=$base/$version
# only the version being submitted stays here
if [ -d "$base" ]; then
  find "$base" -mindepth 1 -maxdepth 1 -type d ! -name "$version" -exec rm -r {} +
fi
mkdir -p "$out"
# English only: winget's banking check (Policy-Test-1.8) flagged the German
# text twice ("Konten", "Bank" for the team bench), so there is no de-CH
# locale any more (and none left over from an earlier run)
rm -f "$out/$id.locale."*.yaml

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

# Point Hub's .msi: Scope machine (ALLUSERS=1, Program Files); winget runs a
# wix installer with its own switches (/quiet, /passive) and gets a
# machine-scope MSI elevated itself, so neither InstallerSwitches nor an
# ElevationRequirement. UpgradeBehavior install: a newer .msi with the same
# UpgradeCode replaces the old version (major upgrade). The ProductCode is
# the .msi's own; --placeholder leaves it, the hash's value and the date out.
if [ "$app" = point-hub ]; then
  {
    header installer
    printf 'PackageIdentifier: %s\nPackageVersion: %s\n' "$id" "$version"
    printf 'InstallerType: wix\nScope: machine\nUpgradeBehavior: install\n'
    (( placeholder )) || printf "ProductCode: '%s'\nReleaseDate: %s\n" "$product_code" "$date"
    printf 'AppsAndFeaturesEntries:\n- DisplayName: %s\n  Publisher: KSC Wiedikon\n  DisplayVersion: %s\n' "$product" "$version"
    (( placeholder )) || printf "  ProductCode: '%s'\n" "$product_code"
    printf "  UpgradeCode: '%s'\n" "$upgrade_code"
    printf "InstallationMetadata:\n  DefaultInstallLocation: '%s'\n" "%ProgramFiles%\\$product"
    printf 'Installers:\n- Architecture: x64\n  InstallerUrl: %s\n  InstallerSha256: %s\n' "$url" "$sha"
    printf 'ManifestType: installer\nManifestVersion: %s\n' "$MANIFEST_VERSION"
  } >"$out/$id.installer.yaml"

  {
    header defaultLocale
    printf 'PackageIdentifier: %s\nPackageVersion: %s\nPackageLocale: en-US\n' "$id" "$version"
    printf 'Publisher: KSC Wiedikon\nPublisherUrl: https://kscw.ch\nPublisherSupportUrl: https://github.com/%s/issues\n' "$REPO"
    printf 'Author: KSC Wiedikon\nPackageName: %s\nPackageUrl: %s\n' "$(q "$package_name")" "$package_url"
    printf 'License: MIT\nLicenseUrl: %s\n' "$license_url"
    printf 'ShortDescription: %s\nDescription: %s\n' "$(q "$short_en")" "$(q "$desc_en")"
    printf 'Moniker: %s\nTags:\n' "$moniker"
    tag_list "${tags[@]}"
    printf 'ReleaseNotesUrl: %s\n' "$release_notes_url"
    printf 'ManifestType: defaultLocale\nManifestVersion: %s\n' "$MANIFEST_VERSION"
  } >"$out/$id.locale.en-US.yaml"
  if (( placeholder )); then
    echo "wrote ${out#"$HERE"/}/ ($id $version, placeholder: run again after the release)"
  else
    echo "wrote ${out#"$HERE"/}/ ($id $version, sha256 $sha, ProductCode $product_code, $date)"
  fi
  exit 0
fi

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

echo "wrote ${out#"$HERE"/}/ ($id $version, sha256 $sha, $date)"
