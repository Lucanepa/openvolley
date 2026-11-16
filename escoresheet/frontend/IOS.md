# OpenVolley iOS app

The scorer app (plus the referee, bench and livescore views) for iPad and
iPhone, built with Capacitor from this frontend, like the Android app
(ANDROID.md). It **bundles** the web app (`dist-capacitor/`, no service
worker): it works with no internet at all, and every web change that should
reach the iPads needs a new build.

- Bundle ID `com.openvolley.escoresheet` (the Android package), name
  **OpenVolley**, iOS 15 and newer, iPad and iPhone
- Apple team **T2Q99T2KH5** (Luca Canepa, individual): App Store seller
  "Luca Canepa", EU trader status: not a trader
- The page runs at `capacitor://localhost` (WKWebView cannot serve
  `https://localhost` like Android does). The cloud backend
  (`backend/lib/cors.js`) and the desktop relay (`src-tauri/src/relay.rs`,
  any `localhost` origin) accept it. At a venue the app talks plain http / ws
  to the relay on the LAN: Info.plist allows that for local addresses and web
  content only.

## Build

There is no Mac here: `.github/workflows/ios.yml` builds on GitHub's macOS
runner with the newest stable Xcode.

- Every run (and every pull request that touches `ios/`): checks the project
  (`src/__tests__/iosApp.test.js`), builds the web app like
  `scripts/release-android.sh` (`CAPACITOR=true`, cloud backend), `npx cap
  sync ios`, builds for the simulator and starts the app on an iPad
  simulator. The screenshot and the log are the `ios-smoke` artifact.
- **TestFlight**: run the workflow by hand with "testflight" ticked (or put
  the label `testflight` on a pull request). It archives the Release build,
  signs it with the Apple Distribution certificate and the "OpenVolley App
  Store" profile, and uploads it with the App Store Connect API key. Version =
  `package.json`, build number = the workflow's run number. After Apple's
  processing (minutes to an hour) the build shows in App Store Connect ›
  TestFlight; internal testers get it in the TestFlight app at once.

Secrets: `IOS_DIST_CERTIFICATE` (Apple Distribution .p12, base64),
`IOS_DIST_CERTIFICATE_PASSWORD`, `IOS_PROVISIONING_PROFILE` (.mobileprovision,
base64), and `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_PRIVATE_KEY`
(shared with the notarized macOS app, desktop.yml).

## Native code

The app's own plugin (`ios/App/App`, registered by `MainViewController`)
and what stands in for the other Android ones (MainActivity):

| Page asks for | Android | iOS |
|---|---|---|
| `OpenVolleyFiles` open / share a saved PDF | FileProvider intents | Quick Look / share sheet (`ScoresheetFilesPlugin.swift`) |
| `OpenVolleyBars` hide / show | status + navigation bars | Capacitor's own `SystemBars`: status bar + home indicator (`nativeSystemBars.js` asks for it on iOS) |
| `OpenVolleyApp` exitApp | Back on the first page | none: no Back button, an iOS app never ends itself |
| `UpdateSource` | F-Droid updates | none: the App Store updates the app |

Saved scoresheet PDFs go to the app's Documents, which the Files app shows
under On My iPad › OpenVolley.

Icon and launch screen: `scripts/make-brand-assets.py` renders them from
`brand/` (1024 px opaque icon; iOS rounds the corners).

## Yearly

The membership renews on 9 November. The Apple Distribution certificate and
the "OpenVolley App Store" profile expire after a year: renew both in the
developer account, then update `IOS_DIST_CERTIFICATE*` and
`IOS_PROVISIONING_PROFILE`. Apps already on the App Store keep working.
