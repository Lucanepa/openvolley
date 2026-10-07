#!/usr/bin/env bash
# End to end test of the pacman repository, with a THROWAWAY key (never the
# real one, never ~/.config/openvolley-pkgs, never synced):
#
#   1. publish-pacman.sh --init-key into a scratch OV_PKGS_HOME, then
#      --app both: the real PKGBUILDs of ../aur (the released .deb files,
#      downloaded from GitHub) built, signed and indexed in a scratch public/.
#   2. That public/ tree served over HTTP by Caddy with deploy/pkgs/Caddyfile
#      (the production config), as http://get.test on a Docker network; the
#      pacman files' Content-Type and Cache-Control are checked.
#   3. A CLEAN archlinux container runs the install page's own steps (taken
#      from the Arch card of deploy/pkgs/index.html: key, lsign, the
#      [openvolley] block for pacman.conf, pacman -Syu <package>) and installs
#      both apps; ../aur/check-installed.sh checks each (updater marker, the
#      stamp, the app runs under Xvfb and does not update itself).
#   4. A newer pkgrel of OpenVolley is published: pacman -Syu installs it.
#   5. Tampering is rejected: a changed database, a database or a package
#      signed by another key, a database or a package without its signature,
#      a changed package. After each, the real files
#      are put back and pacman works again.
#
#   escoresheet/packaging/pacman/test.sh
#
# Needs docker, gpg, python3 and the network (GitHub, Arch mirrors). About
# 6 minutes. Containers, network and scratch files are removed at the end.
# The downloaded .deb files stay in ${OV_PACMAN_CACHE:-~/.cache/openvolley-pacman}.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
ESC=$(cd "$HERE/../.." && pwd -P)
T=$(mktemp -d "${TMPDIR:-/tmp}/ov-pacman-test.XXXXXX")
ID=$$
NET=ov-pacman-net-$ID
SRV=ov-pacman-srv-$ID
CLI=ov-pacman-client-$ID
cleanup() {
  gpgconf --homedir "$T/other" --kill gpg-agent >/dev/null 2>&1 || true
  docker rm -f "$SRV" "$CLI" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$T"
}
trap cleanup EXIT INT TERM

export OV_PKGS_HOME="$T/home" OV_PACMAN_PKGBUILDS="$T/pkgbuilds"
unset OV_PACMAN_GNUPG OV_PACMAN_PASSPHRASE
PUBLISH="$HERE/publish-pacman.sh"
RX="$T/home/public/arch/x86_64"
OV=openvolley-escoresheet-bin
OB=openbeach-escoresheet-bin

PASS=0
ok() { PASS=$((PASS + 1)); echo "ok   $*"; }
bad() { echo "FAIL $*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }
# client CMD...: run a bash command line in the client container
# (no stdin: a pacman prompt fails instead of waiting)
client() { docker exec "$CLI" bash -c "$*" </dev/null; }
# client_fails WANT CMD: CMD fails in the client, its output matches WANT (ERE)
client_fails() {
  local want=$1 out rc
  set +e
  out=$(docker exec "$CLI" bash -c "$2" </dev/null 2>&1)
  rc=$?
  set -e
  (( rc != 0 )) || { echo "$out"; bad "expected a failure: $2"; }
  grep -Eq "$want" <<<"$out" || { echo "$out"; bad "expected /$want/ from: $2"; }
  echo "$out" | grep -E "$want" | head -n 2 | sed 's/^/     /'
}

# --- 1. throwaway key, real packages ----------------------------------------------
step "throwaway key and the real PKGBUILDs"
mkdir -p "$T/pkgbuilds"
cp -r "$ESC/packaging/aur/$OV" "$ESC/packaging/aur/$OB" "$T/pkgbuilds/"
"$PUBLISH" --init-key > "$T/init.out" 2>&1
FPR=$(sed -n 's/^pacman repo key created: //p' "$T/init.out")
[[ "$FPR" =~ ^[0-9A-F]{40}$ ]] || { cat "$T/init.out"; bad "no key"; }
OV_VER=$(sed -n 's/^pkgver=//p' "$T/pkgbuilds/$OV/PKGBUILD")-$(sed -n 's/^pkgrel=//p' "$T/pkgbuilds/$OV/PKGBUILD")
OB_VER=$(sed -n 's/^pkgver=//p' "$T/pkgbuilds/$OB/PKGBUILD")-$(sed -n 's/^pkgrel=//p' "$T/pkgbuilds/$OB/PKGBUILD")
echo "key $FPR; $OV $OV_VER, $OB $OB_VER"

step "publish both"
"$PUBLISH" --app both
[[ -f "$RX/$OV-$OV_VER-x86_64.pkg.tar.zst" && -f "$RX/$OB-$OB_VER-x86_64.pkg.tar.zst" ]] || bad "packages missing"
ok "published $OV $OV_VER and $OB $OB_VER, signed with the throwaway key"

# --- 2. serve it -------------------------------------------------------------------------
step "serve public/ with the production Caddyfile"
docker network create "$NET" >/dev/null
mkdir -p "$T/steps"
docker run -d --name "$SRV" --network "$NET" --network-alias get.test \
  -v "$ESC/deploy/pkgs/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$T/home/public:/srv/pkgs:ro" caddy:2 >/dev/null
docker run -d --name "$CLI" --network "$NET" \
  -v "$ESC/packaging/aur/check-installed.sh:/check-installed.sh:ro" -v "$T/steps:/steps:ro" \
  archlinux:latest sleep infinity >/dev/null
# has_headers PATH LINE...: the response to PATH (asked with Accept-Encoding,
# like a browser) has each header LINE (lower case) and no Content-Encoding
# (pacman checks the bytes against the signature).
has_headers() {
  local path=$1 h line
  shift
  h=$(client "curl -fsS -o /dev/null -D - -H 'Accept-Encoding: gzip, zstd' http://get.test/$path" | tr -d '\r' | tr '[:upper:]' '[:lower:]')
  for line in "$@"; do grep -qxF "$line" <<<"$h" || { echo "$h"; bad "$path: no '$line'"; }; done
  if grep -q '^content-encoding' <<<"$h"; then echo "$h"; bad "$path: re-encoded"; fi
}
for _ in $(seq 20); do client 'curl -fs -o /dev/null http://get.test/arch/fingerprint.txt' && break; sleep 0.5; done
has_headers arch/x86_64/openvolley.db 'cache-control: no-cache' 'content-type: application/octet-stream'
has_headers arch/x86_64/openvolley.db.sig 'cache-control: no-cache' 'content-type: application/pgp-signature'
has_headers arch/x86_64/openvolley.files 'cache-control: no-cache' 'content-type: application/octet-stream'
has_headers "arch/x86_64/$OV-$OV_VER-x86_64.pkg.tar.zst" 'cache-control: public, max-age=31536000, immutable' 'content-type: application/zstd'
has_headers "arch/x86_64/$OV-$OV_VER-x86_64.pkg.tar.zst.sig" 'cache-control: public, max-age=31536000, immutable' 'content-type: application/pgp-signature'
has_headers arch/openvolley.gpg 'cache-control: public, max-age=60, must-revalidate' 'content-type: application/pgp-keys'
ok "Caddy: database + .sig no-cache (octet-stream, not re-encoded), packages + .sig immutable, key pgp-keys"

# --- 3. a clean Arch system follows the install page ---------------------------------------
step "the install page's Arch steps"
# The Arch card's command blocks, in page order: key steps, the pacman.conf
# block, one install line per app. sudo is root in the container, pacman
# gets --noconfirm, the site is http://get.test.
python3 - "$ESC/deploy/pkgs/index.html" "$T/steps" "$FPR" <<'PY'
import html, re, sys
page, out, fpr = sys.argv[1:]
s = open(page).read()
card = s[s.index("<!--pacman-->\n"):s.index("<!--/pacman-->\n")]
blocks = [html.unescape(b) for b in re.findall(r"<pre><code>(.*?)</code></pre>", card, re.S)]
assert len(blocks) == 4, blocks
def site(t): return t.replace("https://get.openvolley.app", "http://get.test").replace("@PACMAN_FPR@", fpr)
open(f"{out}/1-key.sh", "w").write(site(blocks[0]) + "\n")
open(f"{out}/pacman.conf.add", "w").write(site(blocks[1]) + "\n")
open(f"{out}/3-install-ov.sh", "w").write(site(blocks[2]) + "\n")
open(f"{out}/3-install-ob.sh", "w").write(site(blocks[3]) + "\n")
PY
cat > "$T/steps/run.sh" <<'EOF'
set -euo pipefail
sudo() { if [[ $1 == pacman ]]; then shift; pacman --noconfirm --noprogressbar "$@"; else "$@"; fi; }
cd /tmp
. "/steps/$1"
EOF
sed 's/^/     /' "$T/steps/1-key.sh" "$T/steps/pacman.conf.add" "$T/steps/3-install-ov.sh" "$T/steps/3-install-ob.sh"
# An up-to-date Arch system, as on a real computer. The Docker image comes
# without the keyring's local key (an installed Arch has one, made at install
# time), which pacman-key --lsign-key needs: make it here.
client 'pacman-key --init >/dev/null 2>&1 && pacman -Syu --noconfirm --noprogressbar >/dev/null'
client 'bash /steps/run.sh 1-key.sh' | tail -n 3
client "gpg --show-keys /tmp/openvolley.gpg | grep -q $FPR" || bad "the page's key check: gpg --show-keys does not show $FPR"
client 'printf "\n" >> /etc/pacman.conf && cat /steps/pacman.conf.add >> /etc/pacman.conf && tail -n 4 /etc/pacman.conf'
client 'bash /steps/run.sh 3-install-ov.sh' | tail -n 4
client 'bash /steps/run.sh 3-install-ob.sh' | tail -n 4
[[ "$(client "pacman -Q $OV $OB" | xargs)" == "$OV $OV_VER $OB $OB_VER" ]] || bad "installed: $(client "pacman -Q $OV $OB")"
ok "a clean Arch container installed both apps with the page's steps (key, lsign, pacman.conf, pacman -Syu)"

step "check-installed.sh"
client 'PKG=openvolley-escoresheet PORT=5173 bash /check-installed.sh' | tail -n 12
client 'PKG=openbeach-escoresheet PORT=5174 bash /check-installed.sh' | tail -n 12
ok "both apps: marker file 'aur', bundle stamp UNK, run under Xvfb, LAN page 200, the in-app updater off"

# --- 4. an update ------------------------------------------------------------------------------
step "a newer pkgrel"
NEXT=${OV_VER%-*}-$(( ${OV_VER##*-} + 1 ))
sed -i "s/^pkgrel=.*/pkgrel=${NEXT##*-}/" "$T/pkgbuilds/$OV/PKGBUILD"
"$PUBLISH" --app openvolley | tail -n 4
client 'pacman -Syu --noconfirm --noprogressbar' | grep -E "$OV|upgrading" | head -n 4
[[ "$(client "pacman -Q $OV")" == "$OV $NEXT" ]] || bad "pacman -Syu did not upgrade to $NEXT: $(client "pacman -Q $OV")"
ok "pacman -Syu upgraded $OV $OV_VER -> $NEXT"

# --- 5. tampering ----------------------------------------------------------------------------------
step "tampering"
mkdir -p "$T/good" "$T/other"
cp -p "$RX"/* "$T/good/"
# put the real files back as a new publish would (new mtimes)
restore() { cp "$T/good"/* "$RX/"; }
# flip FILE: one byte in the middle changed, same size (the database's size
# check passes; the signature must catch it)
flip() { python3 -c 'import sys; f = open(sys.argv[1], "r+b"); n = f.seek(0, 2) // 2; f.seek(n); b = f.read(1); f.seek(n); f.write(bytes([b[0] ^ 0xFF]))' "$1"; }
chmod 700 "$T/other"
gpg --homedir "$T/other" --batch --pinentry-mode loopback --passphrase '' \
  --quick-generate-key "Mallory <m@example.invalid>" ed25519 sign never 2>/dev/null
other_sign() { gpg --homedir "$T/other" --batch --yes --detach-sign --no-armor -o "$1.sig" "$1"; }
# The other key is in the client's keyring but not trusted (not lsigned):
# pacman knows who signed and must still refuse (no keyserver lookup).
gpg --homedir "$T/other" --batch --export > "$T/steps/other.gpg"
client 'pacman-key --add /steps/other.gpg >/dev/null 2>&1'

flip "$RX/openvolley.db"
client_fails 'openvolley.*(invalid or corrupted database|signature)' 'pacman -Syy --noconfirm --noprogressbar'
restore
ok "a changed database is refused"
other_sign "$RX/openvolley.db"
client_fails 'openvolley.*(Mallory.*(unknown|marginal|never) trust|signature.*invalid)' 'pacman -Syy --noconfirm --noprogressbar'
restore
client 'pacman -Syy --noconfirm --noprogressbar >/dev/null 2>&1' || bad "pacman -Syy after putting the database back"
# (pacman keeps a refused database in its sync dir and complains about that
# copy when it starts; after the good sync above, nothing is left to say)
[[ -z "$(client 'pacman -Sl openvolley 2>&1 >/dev/null')" ]] || bad "pacman still reports an error after the good sync"
ok "a database signed by another key is refused; the real one syncs again"
# What the page's SigLevel line is for: pacman's default (DatabaseOptional)
# would take a database without a signature.
rm "$RX/openvolley.db.sig"
client_fails "openvolley\.db\.sig.*404" 'pacman -Syy --noconfirm --noprogressbar'
restore
client 'pacman -Syy --noconfirm --noprogressbar >/dev/null 2>&1' || bad "pacman -Syy after putting the database signature back"
ok "a database without its signature is refused (SigLevel DatabaseRequired)"

client "pacman -Rns --noconfirm $OB >/dev/null && rm -f /var/cache/pacman/pkg/$OB-*"
OBF="$RX/$OB-$OB_VER-x86_64.pkg.tar.zst"
other_sign "$OBF"
client_fails "$OB.*(Mallory.*(unknown|marginal|never) trust|signature.*invalid)" "pacman -S --noconfirm --noprogressbar $OB"
client "rm -f /var/cache/pacman/pkg/$OB-*"
restore
rm "$OBF.sig"
client_fails "$OB-.*\.sig.*404" "pacman -S --noconfirm --noprogressbar $OB"
client "rm -f /var/cache/pacman/pkg/$OB-*"
restore
flip "$OBF"
client_fails "$OB.*(signature.*invalid|invalid or corrupted package)" "pacman -S --noconfirm --noprogressbar $OB"
client "rm -f /var/cache/pacman/pkg/$OB-*"
client "! pacman -Q $OB >/dev/null 2>&1" || bad "a tampered $OB got installed"
restore
client "pacman -S --noconfirm --noprogressbar $OB >/dev/null" || bad "the real $OB does not install after the tampering tests"
[[ "$(client "pacman -Q $OB")" == "$OB $OB_VER" ]] || bad "reinstall"
ok "a package signed by another key, one without its signature and a changed package are refused; the real one installs"

echo
echo "all $PASS checks passed (throwaway key $FPR)"
