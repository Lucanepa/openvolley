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
fi
