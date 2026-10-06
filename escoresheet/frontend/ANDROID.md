# OpenVolley Android app

The scorer app (plus the referee, bench and livescore views) as an Android app
for the tablets, built with Capacitor from this frontend. It is published to
the owner's private F-Droid repo **https://fdroid.lucanepa.com/repo** (basic
auth; Vaultwarden item "Desktop Calendar F-Droid repo web login").

- Package: `com.openvolley.escoresheet`, name **OpenVolley**
- The APK **bundles** the web app (`dist-capacitor/`): it works with no
  internet at all. Every web change that should reach the tablets needs a new
  release.
- No service worker in this build (`CAPACITOR=true`, see `vite.config.js`):
  the files are already local, and an old precache would otherwise keep
  serving the previous version after an update.

## Release

```bash
cd escoresheet/frontend
scripts/release-android.sh              # build, sign, publish to F-Droid
scripts/release-android.sh --no-publish # build only (unsigned APK)
```

The script runs `vite build` with `CAPACITOR=true` and
`VITE_BACKEND_URL=https://backend.openvolley.app` into `dist-capacitor/`, then
`npx cap sync android` and `./gradlew assembleRelease`, then
`/srv/fdroid/desktop-calendar/add-apk.sh`. That zipaligns the APK, signs it
with the OpenVolley key, copies it to `repo/com.openvolley.escoresheet_<versionCode>.apk`
and runs `publish.sh` (`fdroid update` + rsync to the served copy). The
F-Droid metadata (name, summary, description, icon) is
`/srv/fdroid/desktop-calendar/metadata/com.openvolley.escoresheet.yml` and
`metadata/com.openvolley.escoresheet/en-US/icon.png`, outside this repo.

Needs JDK 21 and the Android SDK in `~/Android/Sdk` (the script sets
`ANDROID_HOME`). Gradle caches go to `~/.gradle` unless `GRADLE_USER_HOME`
is set.

## Version rule

- `versionName` = `version` in `package.json` (e.g. `1.48.19`).
- `versionCode` = `(MAJOR * 1000000 + MINOR * 1000 + PATCH) * 10 + androidBuild`,
  e.g. 1.48.19 with `androidBuild = 2` → `10480192` (10480191 was the first
  private-repo build; 10480192 adds the F-Droid preparation).
- `androidBuild` (0–9, `android/app/build.gradle`) is for a native-only fix
  without a web version bump: raise it for such a rebuild, reset it to 0 when
  `package.json`'s version changes. F-Droid only offers an update when the
  `versionCode` grows, so never publish the same code twice.
- Monotonic while MINOR and PATCH stay below 1000.
- Both values are **literals** in `defaultConfig` of `android/app/build.gradle`
  (`versionCode 10480192`, `versionName "1.48.19"`): F-Droid's update checker
  reads them with a regex and cannot evaluate Groovy. The build fails if they
  do not match `package.json` + `androidBuild`, so update them together
  (`scripts/bump-version.js` does it when it bumps `package.json`).

## F-Droid (official catalogue)

The app is prepared for f-droid.org, which builds it from source itself:

- Listing text, icon and screenshots: `fastlane/metadata/android/` at the
  **repo root** (fdroidserver only looks there or in the build subdir). Add a
  `changelogs/<versionCode>.txt` for every release.
- Recipe for fdroiddata: `android/fdroid/com.openvolley.escoresheet.yml`
  (reference copy; the live one is in gitlab.com/fdroid/fdroiddata).
- A release for F-Droid = an annotated tag `android-v<versionName>` on the
  commit whose `build.gradle` carries that version. F-Droid's checkupdates
  finds the tag, reads versionName/versionCode from `build.gradle` and builds
  it (no further action needed once the app is in the catalogue).
- Reproducible builds (`Binaries` + `AllowedAPKSigningKeys` in the recipe):
  F-Droid builds the tag, copies the signature of the owner-signed APK
  (GitHub release asset `com.openvolley.escoresheet_<versionCode>.apk` on the
  `android-v<versionName>` release) onto its build and ships the owner-signed
  APK if it verifies. Users can then move between the private repo and
  F-Droid. Requirements: build from a clean checkout of the tag
  (`release-android.sh` refuses a dirty tree); the Android bundle ignores
  `.env` files (`envDir: false` for `CAPACITOR=true` in `vite.config.js`); and
  the signing step must keep AGP's ZIP alignment: `apksigner sign
  --alignment-preserved true` (plain `apksigner sign` re-aligns stored
  entries and the copied signature no longer verifies).
  `release-android.sh` checks this after signing, like F-Droid does.
- No Google services plugin, no proprietary libraries: keep it that way
  (Capacitor plugins that pull Firebase/Play Services would block inclusion).

## Signing key

- `~/.config/openvolley-android/release.p12` (PKCS12, alias `release`,
  RSA 4096, valid until 2051) and `signing.properties` next to it
  (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`; mode 600).
- Backup: Vaultwarden, folder OpenVolley, item **"OpenVolley Android signing
  key"** (password = store and key password; the notes hold the keystore as
  base64 and how to restore it).
- Every update must be signed with this key, or Android refuses to install it
  over the existing app. Never commit it.

## Native settings (android/)

- **Light look**: white status and navigation bars with dark icons
  (`SystemBars.style: LIGHT`), white splash, Light (not DayNight) theme so
  the WebView is never darkened.
- **Insets** (`MainActivity.java`): the WebView is kept inside the system
  bars natively (old WebViews report `env(safe-area-inset-*)` as 0 on
  Android 15+). The keyboard never resizes the page (that would drop it under
  the app's 600 px minimum height and unmount the form being typed in); the
  WebView slides up just enough to show the focused field.
- **Back button**: goes back inside the app (referee view → scorer); on the
  first page it only sends the app to the background, so it never closes a
  running match.
- **Orientation**: `sensorLandscape` (landscape, either way up). The scoring
  screen is landscape-only and the WebView ignores `screen.orientation.lock()`;
  a tablet tilted on the scorer's table would otherwise flip into the
  "rotate your device" overlay mid-rally. Android 16 ignores orientation
  requests on tablets unless the app opts out
  (`PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY`, set). Tablets whose
  launcher rotates the display anyway (Pixel Tablet) letterbox the app in
  portrait instead of rotating it.
- **Screen stays on**: the scoreboard's Screen Wake Lock request works in the
  WebView (no extra native code).
- **Venue mode (no internet)**: plain-http LAN relays are allowed:
  `res/xml/network_security_config.xml` permits cleartext and
  `android.allowMixedContent` lets the `https://localhost` page reach
  `http://` / `ws://` LAN addresses. Which hosts are accepted at all is still
  `isAllowedBackendUrl` in `src/utils/backendConfig.js` (localhost, RFC 1918,
  `*.local`, `*.openvolley.app`).

## Servers in the app

The WebView origin is `https://localhost`, which has no backend behind it
(`isNativeApp()` in `backendConfig.js` treats it like a static deployment). By
default everything goes to the cloud (`https://backend.openvolley.app`). At a
venue: **Options → Server → Change server → Local server**, enter the relay's
LAN address (e.g. `192.168.1.20:8080`); the app checks `/health`, stores the
address and reloads. **Options → Use this tablet as** opens the bundled
referee, bench or livescore view; they share the chosen server.

## Icons and splash

`python3 scripts/make-android-icons.py` regenerates the launcher icons
(`mipmap-*`) from `public/ball.png` and the splash images from
`public/openvolley_no_bg.png`.

## Testing

`~/.claude/skills/android-emulator/` (headless emulator). A tablet AVD:
`avdmanager create avd -n ov-tablet -k "system-images;android-36;google_apis_playstore;x86_64" -d pixel_tablet`,
then `AVD=ov-tablet emu.sh start`. The host is `10.0.2.2` from the emulator,
so a local relay (`cd escoresheet/backend && node server.js --local`) is
`10.0.2.2:8080`. Use test matches only: they never go to the cloud database.
