# OpenVolley Android app

The scorer app (plus the referee, bench and livescore views) as an Android app
for the tablets, built with Capacitor from this frontend. Published to:

- the **public** OpenVolley F-Droid repo **https://get.openvolley.app/fdroid/repo**
  (fingerprint `61C70F8949441E04E2E21ACC8E6E5C6CC502ADD52A157FB9A8DD8588DACE0720`),
  install page **https://get.openvolley.app**;
- the GitHub release `desktop-v<version>` as `OpenVolley-<version>.apk` (direct download);
- the owner's private F-Droid repo **https://fdroid.lucanepa.com/repo** (basic
  auth; Vaultwarden item "Desktop Calendar F-Droid repo web login"), where the
  release script drops it first.

All three carry the same file, signed once with the OpenVolley app key below.

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

Then make it public (the private repo is only the first stop):

```bash
v=$(node -p "require('./package.json').version"); code=<versionCode>   # e.g. 1.48.19 / 10480191
apk=/srv/fdroid/desktop-calendar/repo/com.openvolley.escoresheet_$code.apk
# public F-Droid repo + install page (escoresheet/deploy/README.md, "Public downloads")
../deploy/publish-pkgs.sh "$apk"
# direct download on the GitHub release (after CI created desktop-v$v)
cp "$apk" /tmp/OpenVolley-$v.apk && gh release upload desktop-v$v --repo Lucanepa/openvolley /tmp/OpenVolley-$v.apk
```

`publish-pkgs.sh` refuses an APK that is not signed with the OpenVolley app key
and never re-signs it. The public repo has its own **repo** signing key (signs
only the index): `~/.config/openvolley-pkgs/fdroid/`, Vaultwarden "OpenVolley
F-Droid repo key". Its metadata is a copy of the yml and icon above, in
`~/.config/openvolley-pkgs/fdroid/metadata/`: copy changes over when you edit them.

Needs JDK 21 and the Android SDK in `~/Android/Sdk` (the script sets
`ANDROID_HOME`). Gradle caches go to `~/.gradle` unless `GRADLE_USER_HOME`
is set.

## Version rule

- `versionName` = `version` in `package.json` (e.g. `1.48.19`).
- `versionCode` = `(MAJOR * 1000000 + MINOR * 1000 + PATCH) * 10 + androidBuild`,
  e.g. 1.48.19 with `androidBuild = 1` → `10480191`.
- `androidBuild` (0–9, `android/app/build.gradle`) is for a native-only fix
  without a web version bump: raise it for such a rebuild, reset it to 0 when
  `package.json`'s version changes. F-Droid only offers an update when the
  `versionCode` grows, so never publish the same code twice.
- Monotonic while MINOR and PATCH stay below 1000.

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

## Automatic backups

The app saves the open match after every scoring event (same file format as
the desktop app, see `OFFLINE_DESKTOP.md`) to the public
**`Documents/OpenVolley/backups/<match>/`** folder
(`/storage/emulated/0/Documents/...`), via `@capacitor/filesystem`.

- Why Documents: it is visible in the Files app and over USB (MTP), so the
  owner can copy the backups off the tablet, and the files **survive an
  uninstall**. The app-private folders (`Directory.Data`, and
  `Android/data/<package>` = `Directory.External`) are deleted on uninstall
  and are hard to reach on Android 11+.
- Permissions: Android 11+ needs none for files the app creates there.
  Android 10 and older need storage access (`WRITE_EXTERNAL_STORAGE`
  maxSdk 29, `requestLegacyExternalStorage`); if it is refused the app falls
  back to `Android/data/com.openvolley.escoresheet/files/OpenVolley/backups`.
- After a reinstall on Android 11+, the old files belong to the previous
  install: the new one cannot overwrite or delete them. New event files and
  new matches are fine; a match continued across the reinstall keeps its old
  `latest.json` (its newest event file is the current state), and rotation
  skips what it cannot delete.
- **Options → Backup** shows the folder; **Restore from a backup file** opens
  the system picker (browse to Documents → OpenVolley → backups).

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
