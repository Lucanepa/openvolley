#!/usr/bin/env bash
# Rebuild and publish the public package repos behind https://get.openvolley.app
#
#   escoresheet/deploy/publish-pkgs.sh [--no-sync] [FILE.deb | FILE.apk ...]
#
# Runs on lenovoserver (never on the VM: the signing keys live only here).
#
#   1. Adds the given packages: a .deb goes to the APT pool, a signed .apk to
#      the F-Droid repo. An APK must already be signed with the OpenVolley app
#      key (ANDROID.md); anything else is refused. Nothing is ever re-signed.
#   2. Rebuilds the APT index (Packages, Release, InRelease, Release.gpg) and
#      exports the public key as apt/openvolley.gpg and apt/openvolley.asc.
#   3. Rebuilds the F-Droid index (fdroid update) and copies repo/ over.
#   4. Copies the landing page (pkgs/index.html from this kit).
#   5. Refuses if anything key-like ended up in the public tree, then rsyncs
#      that tree to ${OV_PKGS_DEST} (default hetzner:/data/openvolley/pkgs/),
#      unless --no-sync.
#
# Layout under ${OV_PKGS_HOME} (default ~/.config/openvolley-pkgs, mode 700):
#   gnupg/            APT signing key (GNUPGHOME). Vaultwarden: "OpenVolley APT signing key"
#   gpg-passphrase    its passphrase (mode 600)
#   fdroid/           fdroid working dir: config.yml + keystore.p12 (repo signing
#                     key, Vaultwarden: "OpenVolley F-Droid repo key"), metadata/, repo/
#   public/           the served tree, rebuilt here and mirrored to the server:
#                       index.html  apt/{dists,pool,openvolley.gpg,openvolley.asc}  fdroid/repo/
#
# Only public/ ever leaves this machine. Removing a .deb from public/apt/pool/main
# or an .apk from fdroid/repo and re-running un-publishes it.
set -euo pipefail
umask 022

PKGS=${OV_PKGS_HOME:-$HOME/.config/openvolley-pkgs}
DEST=${OV_PKGS_DEST:-hetzner:/data/openvolley/pkgs/}
KIT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
APT_SIGNER_FPR=AB469DA8DC3EC90F8057320D285B18D76C16B82C
# SHA-256 of the OpenVolley app signing certificate (release.p12, ANDROID.md).
APP_CERT_SHA256=2c7f9db4da41f5475f36142403043e45452a3143baff764e3d511d686ddabe87

PUB="$PKGS/public"
APT="$PUB/apt"
DIST="$APT/dists/stable"
FD="$PKGS/fdroid"
export GNUPGHOME="$PKGS/gnupg"

die() { echo "publish-pkgs: $*" >&2; exit 1; }

SYNC=1
FILES=()
for a in "$@"; do
  case "$a" in
    --no-sync) SYNC=0 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    -*) die "unknown option $a" ;;
    *) FILES+=("$a") ;;
  esac
done

for t in dpkg-scanpackages apt-ftparchive gpg gpgv fdroid rsync; do
  command -v "$t" >/dev/null || die "$t not found"
done
[[ -d "$GNUPGHOME" && -f "$PKGS/gpg-passphrase" ]] || die "no signing key in $PKGS (restore it from Vaultwarden)"
[[ -f "$FD/config.yml" && -f "$FD/keystore.p12" ]] || die "no F-Droid repo in $FD (restore it from Vaultwarden)"

build_tool() {
  local bt
  bt=$(ls -d "${ANDROID_HOME:-$HOME/Android/Sdk}"/build-tools/* 2>/dev/null | sort -V | tail -1)
  [[ -x "$bt/$1" ]] || die "$1 not found in Android build-tools (set ANDROID_HOME)"
  "$bt/$1" "${@:2}"
}

# --- 1. add packages --------------------------------------------------------
mkdir -p "$APT/pool/main" "$FD/repo"
for f in "${FILES[@]}"; do
  [[ -f "$f" ]] || die "$f: no such file"
  case "$f" in
    *.deb)
      pkg=$(dpkg-deb -f "$f" Package); ver=$(dpkg-deb -f "$f" Version); arch=$(dpkg-deb -f "$f" Architecture)
      [[ -n "$pkg" && -n "$ver" && "$arch" == amd64 ]] || die "$f: not an amd64 .deb"
      target="$APT/pool/main/${pkg}_${ver}_${arch}.deb"
      if [[ -e "$target" ]] && ! cmp -s "$f" "$target"; then
        die "$target exists with different content; bump the version instead (apt and caches treat versions as immutable)"
      fi
      install -m 644 "$f" "$target"
      echo "added $target"
      ;;
    *.apk)
      certs=$(build_tool apksigner verify --print-certs "$f") || die "$f: not a validly signed APK"
      grep -q "SHA-256 digest: $APP_CERT_SHA256" <<<"$certs" || die "$f: not signed with the OpenVolley app key"
      badging=$(build_tool aapt2 dump badging "$f" | sed -n '/^package:/p')
      app_id=$(sed -E "s/^package: name='([^']+)'.*/\1/" <<<"$badging")
      code=$(sed -E "s/.*versionCode='([0-9]+)'.*/\1/" <<<"$badging")
      target="$FD/repo/${app_id}_${code}.apk"
      if [[ -e "$target" ]] && ! cmp -s "$f" "$target"; then
        die "$target exists with different content; raise versionCode instead (ANDROID.md, Version rule)"
      fi
      install -m 644 "$f" "$target"
      echo "added $target"
      ;;
    *) die "$f: expected a .deb or .apk" ;;
  esac
done

# --- 2. APT -----------------------------------------------------------------
mkdir -p "$DIST/main/binary-amd64"
gpg_sign() {
  gpg --batch --yes --pinentry-mode loopback --passphrase-file "$PKGS/gpg-passphrase" \
    --local-user "$APT_SIGNER_FPR" "$@"
}

(
  cd "$APT"
  # Paths in Packages are relative to the repo root (apt/). --multiversion keeps
  # every version installable (rollback: apt install <pkg>=<old version>).
  dpkg-scanpackages --multiversion --arch amd64 pool/main > "$DIST/main/binary-amd64/Packages"
)
gzip -9nkf "$DIST/main/binary-amd64/Packages"

conf=$(mktemp)
trap 'rm -f "$conf"' EXIT
cat > "$conf" <<'CONF'
APT::FTPArchive::Release::Origin "OpenVolley";
APT::FTPArchive::Release::Label "OpenVolley";
APT::FTPArchive::Release::Suite "stable";
APT::FTPArchive::Release::Codename "stable";
APT::FTPArchive::Release::Architectures "amd64";
APT::FTPArchive::Release::Components "main";
APT::FTPArchive::Release::Description "OpenVolley eScoresheet desktop app (https://get.openvolley.app)";
CONF
apt-ftparchive -c "$conf" release "$DIST" > "$DIST/Release.tmp"
mv "$DIST/Release.tmp" "$DIST/Release"
rm -f "$DIST/InRelease" "$DIST/Release.gpg"
gpg_sign --clearsign -o "$DIST/InRelease" "$DIST/Release"
gpg_sign -abs -o "$DIST/Release.gpg" "$DIST/Release"

gpg --batch --yes --export "$APT_SIGNER_FPR" > "$APT/openvolley.gpg"
gpg --batch --yes --armor --export "$APT_SIGNER_FPR" > "$APT/openvolley.asc"
# Check the signatures against exactly the keyring users download.
gpgv --keyring "$APT/openvolley.gpg" "$DIST/InRelease" 2>/dev/null || die "InRelease does not verify"
gpgv --keyring "$APT/openvolley.gpg" "$DIST/Release.gpg" "$DIST/Release" 2>/dev/null || die "Release.gpg does not verify"

# --- 3. F-Droid -------------------------------------------------------------
(cd "$FD" && fdroid update -q)
mkdir -p "$PUB/fdroid"
# status/ is fdroidserver's run log (host OS, tool paths); clients never read it.
rsync -a --delete --delete-excluded --exclude=/status/ "$FD/repo/" "$PUB/fdroid/repo/"

# --- 4. landing page --------------------------------------------------------
# Newest .deb and newest APK fill the version links in the template.
read -r deb_pkg deb_ver < <(awk '/^Package:/{p=$2} /^Version:/{print p, $2}' "$DIST/main/binary-amd64/Packages" | sort -k2,2V | tail -1)
read -r apk_ver apk_file < <(python3 - "$FD/repo/index-v2.json" <<'EOF'
import json, sys
d = json.load(open(sys.argv[1]))
vs = d["packages"]["com.openvolley.escoresheet"]["versions"].values()
v = max(vs, key=lambda v: v["manifest"]["versionCode"])
print(v["manifest"]["versionName"], v["file"]["name"].lstrip("/"))
EOF
)
[[ -n "${deb_ver:-}" && -n "${apk_file:-}" ]] || die "need at least one .deb and one com.openvolley.escoresheet APK"
sed -e "s|@DESKTOP_VERSION@|$deb_ver|g" -e "s|@DEB_PACKAGE@|$deb_pkg|g" \
    -e "s|@APK_VERSION@|$apk_ver|g" -e "s|@APK_FILE@|$apk_file|g" \
    "$KIT_DIR/pkgs/index.html" > "$PUB/index.html"
! grep -q '@[A-Z_]*@' "$PUB/index.html" || die "index.html has unfilled placeholders"

# --- 5. check and sync ------------------------------------------------------
leak=$(find "$PUB" \( -iname '*.p12' -o -iname '*.jks' -o -iname '*.keystore' -o -iname 'config.yml' \
  -o -iname '*passphrase*' -o -iname 'private-keys-v1.d' -o -iname '*.kbx' -o -iname 'secring*' \) -print)
[[ -z "$leak" ]] || die "refusing to publish, key material in the public tree: $leak"
if grep -rlqs -- '-----BEGIN PGP PRIVATE KEY BLOCK-----' "$PUB"; then
  die "refusing to publish, a private key block is in the public tree"
fi
chmod -R u=rwX,go=rX "$PUB"

echo "published:"
grep -E '^(Package|Version):' "$DIST/main/binary-amd64/Packages" | paste - - | sed 's/^/  apt     /'
python3 - "$FD/repo/index-v2.json" <<'EOF'
import json, sys
d = json.load(open(sys.argv[1]))
for app, p in d["packages"].items():
    for v in p["versions"].values():
        m = v["manifest"]
        print(f"  fdroid  {app} {m['versionName']} ({m['versionCode']})")
EOF

if (( SYNC )); then
  # --delay-updates puts every changed file in place at the end, so a client
  # never sees a new index that points at a package not uploaded yet.
  rsync -rlt --delete-after --delay-updates --chmod=D755,F644 "$PUB/" "$DEST"
  echo "synced to $DEST"
else
  echo "not synced (--no-sync); tree: $PUB"
fi
