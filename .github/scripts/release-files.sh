#!/usr/bin/env bash
# The installers a desktop release job uploads, for desktop.yml:
#
#   .github/scripts/release-files.sh TAG OUTDIR SUMS FILE...
#
# Copies each FILE to OUTDIR and writes the SHA-256 of every copied file to
# SUMS (a "### SHA-256" section for the release notes). When the GitHub
# release TAG exists already, a file whose name it holds is left out: a
# published installer is never replaced (Tauri builds are not bit-identical,
# and the updater signatures, latest.json and every store pin the published
# bytes), only the ones the release lacks are added (a macOS build that failed
# the first time). Writes exists=true|false and count=N to $GITHUB_OUTPUT.
# Needs gh with GH_TOKEN and GH_REPO.
set -euo pipefail

die() { echo "::error::release-files: $*" >&2; exit 1; }
(( $# >= 3 )) || die "usage: release-files.sh TAG OUTDIR SUMS FILE..."
tag=$1 out=$2 sums=$3
shift 3

err=$(mktemp)
trap 'rm -f "$err"' EXIT
if published=$(gh release view "$tag" --json assets --jq '.assets[].name' 2>"$err"); then
  exists=true
  echo "::notice::$tag is published already: its files stay as they are, only missing ones are added"
elif grep -qi 'not found' "$err"; then
  exists=false published=''
else
  cat "$err" >&2
  die "cannot read the release $tag"
fi

mkdir -p "$out"
count=0
for f in "$@"; do
  [[ -f "$f" ]] || continue
  name=$(basename "$f")
  if [[ -e "$out/$name" ]]; then die "two files named $name"; fi
  if [[ "$exists" == true ]] && grep -qxF -- "$name" <<<"$published"; then
    echo "::warning::kept the published $name (not replaced by this run's build)"
    continue
  fi
  cp "$f" "$out/$name"
  count=$((count + 1))
done
if [[ "$exists" == false && "$count" == 0 ]]; then die "no installers to release"; fi

{
  printf '\n### SHA-256\n\n```\n'
  if (( count > 0 )); then (cd "$out" && sha256sum -- *); fi
  printf '```\n'
} > "$sums"
echo "$count file(s) to upload:"
ls -la "$out"
{ echo "exists=$exists"; echo "count=$count"; } >> "${GITHUB_OUTPUT:-/dev/null}"
