#!/usr/bin/env bash
# Owner-run: pushes a package's PKGBUILD and .SRCINFO to the AUR. Needs the
# AUR SSH key (README.md, "One-time setup"); never run from CI.
#
#   escoresheet/packaging/aur/publish.sh openvolley
#   escoresheet/packaging/aur/publish.sh openbeach [--yes]
#   escoresheet/packaging/aur/publish.sh point-hub
#
# The first push of a package name creates it on the AUR. It checks first that
# .SRCINFO matches the PKGBUILD (run bump.sh after any PKGBUILD edit), shows
# the diff against what the AUR has, and asks before pushing (--yes: no question).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
case ${1:-} in
  openvolley) pkg=openvolley-escoresheet-bin ;;
  openbeach)  pkg=openbeach-escoresheet-bin ;;
  point-hub)  pkg=point-hub-bin ;;
  *) echo "usage: $0 <openvolley|openbeach|point-hub> [--yes]" >&2; exit 2 ;;
esac
yes=${2:-}
dir=$here/$pkg

# Point Hub's PKGBUILD is committed with the @SHA256@ placeholder until its
# first release: never push that (makepkg would refuse it for every user).
if grep -Eq '^sha256sums(_x86_64)?=.*@SHA256@' "$dir/PKGBUILD"; then
  echo "$pkg/PKGBUILD still has the @SHA256@ placeholder: run bump.sh $1 <version> first" >&2; exit 1
fi

# .SRCINFO must describe this PKGBUILD (the AUR web page and helpers read it)
ver=$(sed -n 's/^pkgver=//p' "$dir/PKGBUILD")
rel=$(sed -n 's/^pkgrel=//p' "$dir/PKGBUILD")
if ! grep -q "^	pkgver = $ver\$" "$dir/.SRCINFO" || ! grep -q "^	pkgrel = $rel\$" "$dir/.SRCINFO"; then
  echo ".SRCINFO is not for $ver-$rel: run bump.sh first" >&2; exit 1
fi
srcinfo() {
  if command -v makepkg >/dev/null 2>&1; then
    (cd "$dir" && makepkg --printsrcinfo)
  else
    docker run --rm -v "$dir/PKGBUILD:/in/PKGBUILD:ro" archlinux:latest bash -c '
      set -e
      mkdir /p && cp /in/PKGBUILD /p/ && chown -R nobody /p && cd /p
      runuser -u nobody -- makepkg --printsrcinfo'
  fi
}
if ! diff -u "$dir/.SRCINFO" <(srcinfo); then
  echo ".SRCINFO is out of date: run bump.sh $1 $ver $rel" >&2; exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git clone -q "ssh://aur@aur.archlinux.org/$pkg.git" "$tmp/aur"
cd "$tmp/aur"
git checkout -q -B master
cp "$dir/PKGBUILD" "$dir/.SRCINFO" .
git add PKGBUILD .SRCINFO
if git diff --cached --quiet; then
  echo "the AUR already has this $pkg ($ver-$rel)"; exit 0
fi
git --no-pager diff --cached --stat
git --no-pager diff --cached -- .SRCINFO
if [[ $yes != --yes ]]; then
  read -r -p "push $pkg $ver-$rel to the AUR? [y/N] " ok
  [[ $ok == y || $ok == Y ]] || { echo "not pushed"; exit 1; }
fi
git commit -q -m "Update to $ver-$rel"
git push -q origin master
echo "pushed: https://aur.archlinux.org/packages/$pkg"
