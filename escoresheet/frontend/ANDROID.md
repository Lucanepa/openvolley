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

- `versionName` = `version` in `package.json` (e.g. `2.0.0`).
- `versionCode` = `(MAJOR * 1000000 + MINOR * 1000 + PATCH) * 10 + androidBuild`,
  e.g. 1.48.20 → `10480200`, 2.0.0 → `20000000`.
- **Every Android release bumps PATCH** in `package.json`, a native-only fix
  (Gradle, manifest, `MainActivity.java`) included. `androidBuild` in
  `android/app/build.gradle` stays **0**. It was used only for 1.48.19
  (10480191 = first private-repo build, 10480192 = never published) and is
  kept so the codes keep growing. Reason: a release for F-Droid is the tag
  `android-v<versionName>`. A native-only rebuild with the same versionName would
  need that tag again, and a tag F-Droid has built must never move (and
  `UpdateCheckMode` only matches `android-v<digits and dots>`). One version, one
  tag, one versionCode.
- F-Droid only offers an update when the `versionCode` grows, so never
  publish the same code twice. Monotonic while MINOR and PATCH stay below 1000.
- Both values are **literals** in `defaultConfig` of `android/app/build.gradle`
  (`versionCode 20000000`, `versionName "2.0.0"`): F-Droid's update checker
  reads them with a regex and cannot evaluate Groovy. The build fails if they
  do not match `package.json` + `androidBuild`, so update them together
  (`scripts/bump-version.js` does it when it bumps `package.json`; keep the
  root `version` in `package-lock.json` in step too).

## F-Droid (official catalogue)

The app is prepared for f-droid.org, which builds it from source itself:

- Listing text, icon and screenshots: `fastlane/metadata/android/` at the
  **repo root** (fdroidserver only looks there or in the build subdir). Add a
  `changelogs/<versionCode>.txt` for every release.
- Recipe for fdroiddata: `android/fdroid/com.openvolley.escoresheet.yml`
  (reference copy; the live one is in gitlab.com/fdroid/fdroiddata).
- A release for F-Droid = an annotated tag `android-v<versionName>` on the
  commit whose `build.gradle` carries that version (a new PATCH version for
  every release, see Version rule; never move or reuse a tag). F-Droid's checkupdates
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
- No third-party artwork without a licence that allows redistribution. The
  Swiss Volley logo in the scoresheet PDF header (`scoresheet_pdf/components/swissvolleylogo.jpg`)
  is left out of this build: with `CAPACITOR=true`, `vite.config.js` aliases
  it to `noFederationLogo.js` (null), and the header slot stays empty. Web and
  desktop keep it. Icons come from Lucide (ISC) or Game Icons (CC BY 3.0,
  credited under Options → App version).

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
- **Orientation**: the app rotates freely (`screenOrientation="unspecified"`):
  home, match setup and the forms work in portrait (one field per row). Only
  the scoreboard is landscape-only: while it is mounted it locks the activity
  to landscape natively (`@capacitor/screen-orientation`,
  `src/utils/nativeOrientation.js`; the WebView ignores
  `screen.orientation.lock()`), on the side the tablet is already on, so a
  tablet tilted on the scorer's table never flips into the "rotate your
  device" overlay mid-rally; leaving it unlocks. Android 16 ignores
  orientation requests on tablets unless the app opts out
  (`PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY`, set). In a browser both
  calls are no-ops.
  Known limits: the lock is a fixed side (`SCREEN_ORIENTATION_LANDSCAPE` or
  `REVERSE_LANDSCAPE`, the plugin has no sensor-landscape), so a tablet turned
  round by 180° while the scoreboard is open shows it upside down until the
  scoreboard is left and opened again. On displays that ignore orientation
  requests (`ignoreOrientationRequest`, Pixel Tablet style and the emulator
  default) an upright tablet shows the scoreboard as a letterboxed landscape
  view; it never becomes a portrait scoreboard.
- **Screen stays on**: the scoreboard's Screen Wake Lock request works in the
  WebView (no extra native code).
- **Venue mode (no internet)**: plain-http LAN relays are allowed:
  `res/xml/network_security_config.xml` permits cleartext and
  `android.allowMixedContent` lets the `https://localhost` page reach
  `http://` / `ws://` LAN addresses. Which hosts are accepted at all is still
  `isAllowedBackendUrl` in `src/utils/backendConfig.js` (localhost, RFC 1918,
  `*.local`, `*.openvolley.app`).

## Scoresheet and links (in-app view)

A WebView has no second window, and leaving the page would unmount the
scorer's screen. `src/utils/openAppWindow.js` opens the app's own pages (the
scoresheet and its print / save / approval-PDF modes) in a full-screen
**in-app view**: an iframe on the same origin (`https://localhost`, so the
same IndexedDB) under a white bar with **Back**. Back, the Android Back
button (a pushed history entry, closed on `popstate`) or Escape close it; the
screen underneath (match setup, scoreboard, match end) stays mounted, with
its state. The page in the view talks to the app through
`src/utils/appWindowGuest.js`: the approval PDF goes to the app,
`window.close()` closes the view, and **Save PDF** hands the PDF to the app,
which writes it with `@capacitor/filesystem` to
`Documents/OpenVolley/scoresheets/` (Files app, USB; fallback: the app's
external files folder) and says where in the bar. The WebView has no print
and cannot download a blob, so there is no print dialog. External links and
`mailto:` are navigations Capacitor hands to Android's browser / mail app.

The view loads `/scoresheet/index.html?…`, not `/scoresheet/?…`: Capacitor's
local server (html5mode) answers every path whose last segment has no `.` with
the root `index.html`, which put a second scorer app inside the view.

A page in the view that opens another one (the scoresheet list's download)
hands the request to the app under it, which shows the page in the same view.
(Capacitor injects its bridge into the iframe too, so on its own the page
would nest a second in-app view inside the first.) When the approval PDF cannot be made, the scoresheet says so
and the view closes, back to match end. A sign-in error in the view offers
"Close" (back to the scorer app) instead of a link that would load a second
scorer app inside it.

Checked on the emulator (Android 16, debug build, 2560×1600 tablet screen):
Match setup → Scoresheet and Scoreboard → Preview show the scoresheet; the
bar's Back and the Android Back button return to the screen underneath,
unchanged; Save PDF writes the full sheet (~790 KB) to
`Documents/OpenVolley/scoresheets/` and the bar says so; `location.assign` of
an https link opens Chrome and of a `mailto:` link opens Gmail, the app page
staying where it was; an open request from inside the view replaces the page
in the same view. Not checked on a device: the match-end approval PDF
(`action=getBlob`). The match-end ZIP and log downloads (`MatchEnd.jsx`) are
still blob downloads and do nothing in the WebView.

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
  Android 10 and older need storage access (`WRITE_EXTERNAL_STORAGE` and
  `READ_EXTERNAL_STORAGE`, both maxSdk 29: the plugin asks for the pair; plus
  `requestLegacyExternalStorage`); if it is refused the app falls
  back to `Android/data/com.openvolley.escoresheet/files/OpenVolley/backups`.
- After a reinstall on Android 11+, the old files belong to the previous
  install: the new one cannot overwrite or delete them. New event files and
  new matches are fine; a match continued across the reinstall keeps its old
  `latest.json` (its newest event file is the current state and is never
  rotated away), and rotation skips what it cannot delete. Folders are named
  by the whole match seed, so a new install's matches never land in an old
  match's folder.
- **Personal data**: the files hold player names and birth dates, officials
  and signature images. PINs and session ids are left out (the restore keeps
  or regenerates them). Documents is readable by anyone who has the tablet
  (Files app, USB), on Android 10 and older also by other apps with storage
  permission, and the files **stay after an uninstall**; after a reinstall
  the app can no longer delete them, so rotation stops for them. Options →
  Backup says this to the user. Delete `Documents/OpenVolley` before a tablet
  changes hands. *Owner decision pending*: keep Documents (copyable, survives
  uninstall) or move to `Directory.External` (private to the app, deleted on
  uninstall, hard to reach on Android 11+).
- Cost: one file per event, each the whole match (a 5-set match ends near
  0.7 MB). The event file crosses the WebView bridge once; `latest.json` is a
  native `Filesystem.copy`. The engine waits for a 150 ms quiet window and an
  idle moment before it reads IndexedDB. Each match keeps its newest files
  within 64 MB, a match idle for 12 hours keeps its newest 10, files older
  than 30 days go, and the newest file of every folder is always kept (also
  when `latest.json` belongs to an earlier install).
- **Options → Backup** shows the folder; **Restore from a backup file** opens
  the system picker (browse to Documents → OpenVolley → backups). A failing
  backup shows a red **Backup** badge next to the scoreboard clock.

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
