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

## Updates

**F-Droid is the updater.** On Android 12+ an F-Droid client updates the apps
it installed in the background, with no prompt (targetSdk 36 qualifies on
every version); Android 7–11 shows one "Update" tap. The app itself never
installs anything.

What the app does depends on who installed it, decided at runtime
(`UpdateSourcePlugin.java`, `src/utils/androidUpdate.js`), never at build
time: one APK, no flavors, no new permission, so the f-droid.org reproducible
build stays valid.

| Installed by | Automatic check | Options → App version |
|---|---|---|
| an F-Droid client (`org.fdroid.fdroid`, `org.fdroid.basic`, `…privileged`, Droid-ify, Neo Store; on Android 14+ also the update owner) | **none**: F-Droid does it | "Updates come from F-Droid." + Open in F-Droid + Check for updates |
| the browser / a file manager / adb (sideload), or another store | only after the user said yes to the one-time question "Get notified about new versions?" (default off, Yes and No look the same, closing it = no) | "Notify me about new versions" switch + Check for updates |

- The check is a plain GET of the public index
  `https://get.openvolley.app/fdroid/repo/index-v2.json` (about 4 kB): at
  start, back in the foreground, at sign-in and when the device comes back
  online, **at most once per 24 h** after a check that worked and an hour
  after one that failed (a tablet started offline in a gym checks again soon
  after it is back on Wi-Fi). Never offline, never during a live match, and not
  at start before the app has read whether a match is live. Nothing else is
  sent. A manual "Check for updates" is the user's own request and works for
  every install. So there is no Tracking anti-feature and the F-Droid recipe
  needs no change.
- "Newer" compares the whole `versionCode` with the installed one (the plugin
  reads it), so an Android-only rebuild with the build digit raised
  (`androidBuild` in `build.gradle`) is announced too. Without the plugin's
  answer only MAJOR.MINOR.PATCH of the version name counts.
- An F-Droid install reads the same index, the OpenVolley repo. f-droid.org
  builds a release some days later, so a user who installed from f-droid.org
  only sees "available" before F-Droid offers it: the card and the options say
  so and offer "Add the OpenVolley repo" next to "Open in F-Droid".
- The WebView (origin `https://localhost`) needs CORS on that file:
  `escoresheet/deploy/pkgs/Caddyfile` must send
  `Access-Control-Allow-Origin *` for `/fdroid/repo/index-v2.json`. Without it
  the check reports "Could not check for updates".
- A newer version shows a card on the **home screen only** (never over the
  scoreboard, setup or match end, never while a match is live; a version found
  then waits): `{current} → {new}`, "Get it from F-Droid" (adds the repo via
  `fdroidrepos://…`, or fdroid.link in the browser without a client),
  "Download APK", Later (hidden for that version until the next start).
- Prefs: `localStorage` `ov.update.notify` (`yes` / `no`) and
  `ov.update.lastCheck` (the time of the last check that worked; after a
  failure set so that the next one is due in an hour).
- Why no self-installer: `REQUEST_INSTALL_PACKAGES` needs an explicit opt-in
  under the F-Droid Inclusion Policy, and under Android 14+ update ownership a
  second installer clashes with F-Droid. A browser-installed APK is bound to
  F-Droid by one manual "Update" in F-Droid.

### Scorer tablets, once each

1. Install the **F-Droid client 2.0.x** (1.23 installs updates immediately,
   even mid-match).
2. Add the repo `https://get.openvolley.app/fdroid/repo?fingerprint=61C70F8949441E04E2E21ACC8E6E5C6CC502ADD52A157FB9A8DD8588DACE0720`
   (keeping f-droid.org as well is fine: same signer).
3. Install OpenVolley **from F-Droid**. Installed from the browser before?
   Tap "Update" in F-Droid once to hand it over.
4. Allow F-Droid to "Install unknown apps" when Android asks.
5. F-Droid Settings → app auto-updates → **Only on Wi-Fi**. F-Droid waits for
   the device to be idle, which never happens while the scoreboard keeps the
   screen on.
6. A tablet that must stay on F-Droid 1.23: turn "Automatically fetch updates"
   off and update by hand between matches.

Release timing: publish Monday to Thursday, never on match days (Fri–Sun):
tablets pick up a release within about a day.

Testing against a local index (debug build only; release builds never set it):

```bash
CAPACITOR=true VITE_UPDATE_INDEX_URL=http://10.0.2.2:8765/fdroid/repo/index-v2.json \
  npx vite build --outDir dist-capacitor --emptyOutDir
npx cap sync android && (cd android && ./gradlew assembleDebug)
```

Serve a copy of the real index with a higher `versionCode` on
`127.0.0.1:8765` (with `Access-Control-Allow-Origin: *`); `adb install` gives a
sideloaded app, `adb install -i org.fdroid.fdroid` (F-Droid installed on the
emulator) an F-Droid one. `cap sync` rewrites `capacitor.settings.gradle`
when `node_modules` is a symlink: do not commit that.

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
  desktop keep it. Icons come from Lucide (ISC) and Phosphor (MIT), both
  credited under Options → App version.

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
- **No bars while scoring on a tablet**: the scoring screen and its match
  end hide the status and navigation bars on a tablet (not on a phone; the
  app's plugin `OpenVolleyBars`, `ScoringBarsPlugin.java`,
  `src/utils/nativeSystemBars.js`). An 8" tablet held sideways (1280×800 at
  213 dpi: Lenovo Tab M8, Galaxy Tab A9) leaves the page 962×539 between
  them, under the scoring screen's 600 px minimum height; without them it is
  962×601. A swipe from the screen's edge shows the bars over the page for a
  few seconds; the page keeps its size. Leaving the scoring screen shows them
  again.
- **Back button**: goes back inside the app first (out of the scoresheet's
  in-app view, referee view → scorer). On the first page (home, match setup,
  scoreboard) it asks in the in-app dialog **"Exit OpenVolley?"**; with a live
  match "Exit OpenVolley during the match?" and that the match is saved on
  the device. Only **Exit** closes the app (the activity finishes, through the
  app's own one-method Capacitor plugin `OpenVolleyApp`,
  `AppExitPlugin.java`; no `@capacitor/app` dependency); **Stay** keeps it.
  With a dialog open, Back closes it first and never asks: an in-app
  confirm is cancelled (also "Exit OpenVolley?" itself, as Stay), a modal
  gets Escape or its × (a decision modal without × stays until answered).
  MainActivity asks the page through `window.__ovAndroidBack`
  (`src/utils/appLifecycle.js`); a page without that handler (still loading)
  sends the app to the background as before. The scorer page does not push
  its "block Back" history entry in the app (it made every other Back press
  a silent no-op).
- **Swiping the app away** in the recent apps cannot be prevented by any app
  (an Android rule; it also gets no reliable callback). The match is in
  IndexedDB and the automatic backups, so it continues on the next start:
  going to the background writes the match's last backup file at once
  (Capacitor's `pause`, or the page going hidden), so it is on disk before a
  swipe can end the app. On
  a dedicated scorer tablet use Android's **App pinning** (Settings ›
  Security › App pinning, then pin OpenVolley from the recent apps): Home,
  Recents and swiping away are blocked until it is unpinned. (The
  scoreboard's lock below is an orientation lock only; it does not stop
  this.)
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
which writes it with `@capacitor/filesystem` to the app's own folder
(`files/OpenVolley/scoresheets/`; fallback: the app's external files folder)
and offers **Open**, **Share** and **Export to Documents** (a copy in
`Documents/OpenVolley/exported/`, which the app never moves or deletes) in the bar.
Saved PDFs follow the backups' 30 days (deleted at the next start after
that). The WebView has no print and cannot download a blob, so there is no
print dialog. External links and
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
`Documents/OpenVolley/scoresheets/` (before the app folder, see above) and the bar says so; `location.assign` of
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
LAN address: the desktop app's as the Connect tablets dialog shows it
(`192.168.1.20:5173`), the venue server's with its one port
(`192.168.1.20:8080`). The app checks `/health`, asks the relay's
`/api/server/status` for its WebSocket port (the desktop relays take the
WebSocket on 8080, not on 5173; `learnRelayWsPort` in `backendConfig.js`,
with 5173 → 8080 as the default until it answered), stores the address and
reloads. **Options → Use this tablet as** opens the bundled
referee, bench or livescore view; they share the chosen server.

**Joining a scoretable (follow-up, not built).** The desktop's Connect tablets
dialog shows a Wi-Fi QR code (when the laptop creates the Wi-Fi) and a QR code
per role. In the app there is no scanner yet: the Wi-Fi QR is scanned with
Android's own Settings › Wi-Fi › QR icon, and a role QR opens Chrome, not the
app (no App Links intent-filter, no `@capacitor/app`). A "Join a scoretable"
flow would need a camera / barcode plugin (and the CAMERA permission), a small
native plugin for `WifiNetworkSuggestion` / `WifiNetworkSpecifier` (Android 10+
asks the user once) and then open `/referee/index.html?server=http://<laptop>:5173&match=…`.
The app reaches the desktop relay there: `?server=` goes through
`applyServerParam`, so the relay WebSocket is `ws://<laptop>:8080` (or the
port the relay's `/api/server/status` names), not `ws://<laptop>:5173`.

## Automatic backups

The app saves the open match after every scoring event (same file format as
the desktop app, **encrypted** with the match's game PIN and referee PIN and
the league's recovery key, see `OFFLINE_DESKTOP.md` › Encrypted backup files)
to the app's own **`files/OpenVolley/backups/<match>/`** folder
(`Directory.Data`; fallback `Directory.External`), via `@capacitor/filesystem`.

- Why the app folder (owner decision 2026-11): the public
  `Documents/OpenVolley` folder of 3.1.4 and older was readable by anyone
  holding the tablet (Files app, USB), on Android 10 and older by other apps
  with storage permission, and the files stayed after an uninstall. The app
  folder is reached by no other app, file manager or USB cable, and goes
  with the app on uninstall.
- Copies go out only on request: **Options → Backup → Export to Documents**
  copies each match's `latest.json` (as `<match>.json`) and every saved PDF
  to a new `Documents/OpenVolley/export-<yyyymmdd-hhmm>/` folder; the PDF
  view's Export to Documents copies one PDF to `Documents/OpenVolley/exported/`.
  Those copies are the user's: the app never moves or deletes them (the move
  below never reads these folders).
- First start of this version: the files older versions left in
  `Documents/OpenVolley/backups`, `Documents/OpenVolley/scoresheets`,
  `Documents/OpenVolley/logs` (the activity log's daily files; and the
  external fallback) are moved into the app folder, once
  (`nativeBackup/androidFiles.js` moveLegacyFiles; a `latest.json` the app
  wrote since is kept, a day's log the app already writes to gets the older
  lines). Once is a marker file in the app folder
  (`OpenVolley/legacy-files-moved`), so Options "Clear all" does not run it
  again. Files an earlier install left on Android 11+ belong to that install
  and stay (logged). On Android 10 and older Documents is only read with the
  storage permission already granted: the start never asks for it. Android
  only: on iOS Capacitor maps Documents, Data and External to one folder.
- The activity log's daily files (`src/utils/activity/fileSink.js`) are in the
  app folder too (`OpenVolley/logs/`).
- At every start (a few seconds in) the rotation below runs over every
  match folder, and saved PDFs older than 30 days are deleted; before, the
  rotation waited for the session's first backup.
- Permissions: none for the app folder. Export to Documents and the move need
  storage access on Android 10 and older (`WRITE_EXTERNAL_STORAGE` and
  `READ_EXTERNAL_STORAGE`, both maxSdk 29: the plugin asks for the pair; plus
  `requestLegacyExternalStorage`).
- **Personal data**: the files hold player names and birth dates, officials
  and signature images, **encrypted** with the match's game PIN and referee
  PIN (either opens a file), and with the recovery public key of the build
  when it has one (the league opens any file with the private half, kept
  offline: `scripts/backup-recovery.mjs`). Without a key only the game
  number, team names, scheduled date, set scores and the file's time can be
  read; a test match has no PIN and is saved plain. PINs and session ids are
  never in a file (the restore keeps the typed PIN, the local copy's, or
  makes new ones). Files of 3.0.8 and older are plain: their event files go
  after 30 days, but the newest event file and `latest.json` of a folder
  never do. A 6-digit PIN only slows down someone who copies a file and
  tries every PIN (about 80 minutes on a 16-core desktop); the recovery key
  does not fall to guessing.
- Cost: one file per event, each the whole match (a 5-set match ends near
  0.9 MB encrypted). The event file crosses the WebView bridge once;
  `latest.json` is a native `Filesystem.copy`. The engine waits for a 150 ms
  quiet window and an idle moment before it reads IndexedDB. The PIN keys
  of a match (Argon2id, about 0.5 s per PIN on a mid-range tablet) are
  derived once per session in a Web Worker when the engine first sees the
  match (it is opened), so scoring does not stall and even the first file
  only encrypts (AES-GCM in WebCrypto); a worker that gives no answer in
  10 s is retired and the keys are derived on the main thread. Each match keeps its newest files
  within 64 MB, a match idle for 12 hours keeps its newest 10, files older
  than 30 days go, and the newest file of every folder is always kept (also
  when `latest.json` belongs to an earlier install).
- **Options → Backup** shows the folder; the restore list (Saved on this
  device) lists its matches; **Restore from a backup file** opens the system
  picker (for an exported copy or a file from elsewhere), then asks
  for the **game PIN or the referee PIN** of the match (a wrong PIN says so
  and asks again; Cancel goes back) before the confirmation. Restore match →
  Restore from local file does the same before its preview. A failing
  backup shows a red **Backup** badge next to the scoreboard clock.

## Icons and splash

`python3 scripts/make-brand-assets.py` renders every logo raster from the
SVGs in `brand/` (see `brand/README.md`): the launcher icons (`mipmap-*`:
square, round, the adaptive foreground and the monochrome layer that Android
13+ tints for themed icons), the pre-Android-12 splash images, and the web,
desktop and store icons. The adaptive icon's background is plain white
(`values/ic_launcher_background.xml`).

The F-Droid repo shows its own copy of the icon,
`metadata/com.openvolley.escoresheet/en-US/icon.png` on the F-Droid host
(see above), outside this repo: after a logo change, copy
`fastlane/metadata/android/en-US/images/icon.png` there and run `publish.sh`.

## Testing

`~/.claude/skills/android-emulator/` (headless emulator). A tablet AVD:
`avdmanager create avd -n ov-tablet -k "system-images;android-36;google_apis_playstore;x86_64" -d pixel_tablet`,
then `AVD=ov-tablet emu.sh start`. The host is `10.0.2.2` from the emulator,
so a local relay (`cd escoresheet/backend && node server.js --local`) is
`10.0.2.2:8080`. Use test matches only: they never go to the cloud database.
