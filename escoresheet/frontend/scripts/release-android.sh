#!/usr/bin/env bash
# Build the OpenVolley Android app (Capacitor) and publish it to the private
# F-Droid repo (https://fdroid.lucanepa.com/repo). See ANDROID.md.
#
#   cd escoresheet/frontend && scripts/release-android.sh            # build + publish
#   cd escoresheet/frontend && scripts/release-android.sh --no-publish  # build only
#
# The APK bundles the web app (no live site): every web change that should
# reach the tablets needs a version bump (package.json) and a new release.
# versionName = package.json version, versionCode = MAJOR*1000000 + MINOR*1000
# + PATCH (android/app/build.gradle).
#
# Signing key: ~/.config/openvolley-android/ (release.p12 + signing.properties,
# backed up in Vaultwarden "OpenVolley Android signing key") — updates must be
# signed with the same key forever.
set -euo pipefail
cd "$(dirname "$0")/.."

SIGNING=${SIGNING:-$HOME/.config/openvolley-android/signing.properties}
ADD_APK=/srv/fdroid/desktop-calendar/add-apk.sh
export ANDROID_HOME=${ANDROID_HOME:-$HOME/Android/Sdk}
export ANDROID_SDK_ROOT=${ANDROID_SDK_ROOT:-$ANDROID_HOME}

# F-Droid builds the same tag from source and checks it against this APK byte
# for byte (reproducible builds), so publish only from a clean tree. The web
# bundle ignores .env files in this build (envDir: false in vite.config.js).
if [ "${1:-}" != --no-publish ]; then
  if [ -n "$(git status --porcelain -- .)" ]; then
    echo "escoresheet/frontend has uncommitted or untracked files; commit them (and tag android-v<version>) first" >&2
    exit 1
  fi
  echo "building $(git describe --tags --always --dirty)"
fi

# CAPACITOR=true: no service worker (vite.config.js). The WebView origin is
# https://localhost, so the cloud backend must be given explicitly.
CAPACITOR=true VITE_BACKEND_URL=${VITE_BACKEND_URL:-https://backend.openvolley.app} \
  npx vite build --outDir dist-capacitor --emptyOutDir
npx cap sync android

(cd android && ./gradlew --no-daemon -q assembleRelease)
APK=android/app/build/outputs/apk/release/app-release-unsigned.apk
echo "built $APK"

if [ "${1:-}" != --no-publish ]; then
  "$ADD_APK" "$APK" "$SIGNING"

  # The signed APK is what F-Droid compares its own build against (Binaries in
  # the fdroiddata recipe): it copies this APK's signature onto its unsigned
  # build and verifies it. Do the same here, so a signing step that rewrites
  # the ZIP (apksigner without --alignment-preserved true) is caught now and
  # not in F-Droid's pipeline.
  code=$(sed -nE 's/^ +versionCode ([0-9]+)$/\1/p' android/app/build.gradle)
  SIGNED=/srv/fdroid/desktop-calendar/repo/com.openvolley.escoresheet_${code}.apk
  bt=$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)
  python3 - "$SIGNED" "$APK" "$bt/apksigner" <<'PY' || {
import os, subprocess, sys, tempfile
from fdroidserver import apksigcopier
signed, unsigned, apksigner = sys.argv[1:4]
with tempfile.TemporaryDirectory() as d:
    out = os.path.join(d, 'copied.apk')
    apksigcopier.do_copy(signed, unsigned, out)
    ok = subprocess.run([apksigner, 'verify', out], capture_output=True).returncode == 0
sys.exit(0 if ok else 1)
PY
    echo "WARNING: $SIGNED does not match the unsigned build once its signature is copied:" >&2
    echo "  F-Droid's reproducible-build check would fail. Sign with apksigner --alignment-preserved true." >&2
    exit 1
  }
  echo "reproducible: signature of $SIGNED copies onto the unsigned build"
  echo "attach it to the GitHub release: gh release create android-v$(sed -nE 's/^ +versionName \"(.*)\"$/\1/p' android/app/build.gradle) $SIGNED"
fi
