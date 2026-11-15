#!/usr/bin/env bash
# Build the OpenVolley Android App Bundle (.aab) for Google Play and sign it
# with the Play UPLOAD key. Upload the result by hand in the Play Console
# (Testing / Production -> Create release). See ANDROID.md "Google Play".
#
#   cd escoresheet/frontend && scripts/release-play.sh
#
# Same sources and the same versionName/versionCode as the F-Droid APK
# (android/app/build.gradle, "Version rule" in ANDROID.md): never upload a
# versionCode twice; every release bumps PATCH.
#
# Upload key: PLAY_SIGNING (default ~/.config/openvolley-android/play-upload.properties,
# same format as signing.properties: storeFile, storePassword, keyAlias,
# keyPassword; mode 600). Either a dedicated upload key (Play re-signs with its
# own app key) or the OpenVolley app key itself when it was handed to Play
# App Signing at enrolment. Never commit it.
set -euo pipefail
cd "$(dirname "$0")/.."

PLAY_SIGNING=${PLAY_SIGNING:-$HOME/.config/openvolley-android/play-upload.properties}
export ANDROID_HOME=${ANDROID_HOME:-$HOME/Android/Sdk}
export ANDROID_SDK_ROOT=${ANDROID_SDK_ROOT:-$ANDROID_HOME}

if [ ! -r "$PLAY_SIGNING" ]; then
  echo "no upload key settings at $PLAY_SIGNING (see the header of this script)" >&2
  exit 1
fi
if [ -n "$(git status --porcelain -- .)" ]; then
  echo "escoresheet/frontend has uncommitted or untracked files; commit them first" >&2
  exit 1
fi

prop() { sed -nE "s/^$1=(.*)$/\1/p" "$PLAY_SIGNING" | head -1; }
STORE=$(prop storeFile); ALIAS=$(prop keyAlias)
case "$STORE" in /*) ;; *) STORE="$(dirname "$PLAY_SIGNING")/$STORE" ;; esac

# Same web bundle as the APK (CAPACITOR=true: no service worker, local files)
CAPACITOR=true VITE_BACKEND_URL=${VITE_BACKEND_URL:-https://backend.openvolley.app} \
  npx vite build --outDir dist-capacitor --emptyOutDir
npx cap sync android

(cd android && ./gradlew --no-daemon -q bundleRelease)
AAB=android/app/build/outputs/bundle/release/app-release.aab
[ -f "$AAB" ] || { echo "no $AAB" >&2; exit 1; }

code=$(sed -nE 's/^ +versionCode ([0-9]+)$/\1/p' android/app/build.gradle)
OUT=android/app/build/play
mkdir -p "$OUT"
SIGNED="$OUT/OpenVolley-$code.aab"
cp "$AAB" "$SIGNED"

# Play checks the bundle's jar signature (v1) against the registered upload
# key; passwords come from the environment, never the command line
export OV_PLAY_STOREPASS=$(prop storePassword) OV_PLAY_KEYPASS=$(prop keyPassword)
jarsigner -sigalg SHA256withRSA -digestalg SHA-256 \
  -keystore "$STORE" -storepass:env OV_PLAY_STOREPASS -keypass:env OV_PLAY_KEYPASS \
  "$SIGNED" "$ALIAS" >/dev/null
jarsigner -verify "$SIGNED" >/dev/null
echo "signed $SIGNED (versionCode $code)"
echo "Upload it in the Play Console: Testing -> Closed testing -> Create release."
