# OpenVolley on Google Play

Third channel next to F-Droid and the direct APK. Same sources, same
`versionName`/`versionCode` (ANDROID.md, "Version rule"). Package
`com.openvolley.escoresheet`.

## Account (owner)

Personal developer account (the first one was closed for inactivity on
18 May 2026, so this is a new one). A new personal account must run a
**closed test with at least 12 testers for 14 days** before Play allows a
production release. Keep the account active afterwards (publish or sign in
now and then), or Google closes it again.

## Signing: decided 15.11 = B (hand Play the OpenVolley app key)

Enrolment: Play Console → the app → Test and release → Setup → App signing →
"Export and upload a key from a Java keystore". The console shows a `pepk.jar`
command with Google's encryption key; run it on lenovoserver against
`~/.config/openvolley-android/release.p12` (alias `release`), then upload the
`.zip` it writes (done 16.11, certificate SHA-256 `2C:7F:9D:B4:…:BE:87`).
The upload key is a separate one (Play step 5): `play-upload.jks` +
`play-upload.properties` in `~/.config/openvolley-android/`, alias `upload`,
RSA 4096, valid to 2051; a lost or leaked upload key is reset in the Console.
Back it up in Vaultwarden (folder OpenVolley). Irreversible: Google keeps a
copy of the app key.

The comparison that led to B:

| | A. Dedicated upload key (default) | B. Hand Play the OpenVolley app key |
|---|---|---|
| Play-installed APK signature | Google's own key, differs from F-Droid / GitHub | the OpenVolley key, same as F-Droid / GitHub |
| Switching channel on one tablet | uninstall + reinstall (match data lives in the app: back up first) | in-place update |
| Key custody | OpenVolley key stays only with us | a copy of it is held by Google, forever |
| Effort | create a new key | export the key with Google's PEPK tool at enrolment |

Recommended: **B** if tablets will move between F-Droid and Play, otherwise A.
Either way `scripts/release-play.sh` signs the `.aab` with whatever
`~/.config/openvolley-android/play-upload.properties` points to.

## Release

```bash
cd escoresheet/frontend
# bump PATCH first (scripts/bump-version.js), commit, tag android-v<version>
scripts/release-play.sh      # -> android/app/build/play/OpenVolley-<versionCode>.aab
```

Upload in the Play Console (Closed testing first). Do not upload the same
versionCode twice.

## App behaviour on Play

A Play install (`com.android.vending`) is its own update family: the app
never checks the F-Droid index, never shows the update card and never offers
F-Droid or an APK download (Play policy forbids an app that updates itself or
points to another source). Options → App version says "Updates come from
Google Play." Sideload and F-Droid installs are unchanged.

## Listing

Text and screenshots already exist in `fastlane/metadata/android/{en-US,de,fr,it}`
(title, short and full description, icon, screenshots); copy them into the
console. Privacy policy URL: https://openvolley.app/en/privacy

## Data safety form: draft to check against the privacy policy

Answers from reading the app; confirm each against the current privacy
policy (the manifest declares only INTERNET, plus storage on Android 10 and
older) before submitting.

- Collects data: **Yes**. Shared with third parties: **No** (own backend on
  our server in Switzerland; no analytics or ads SDKs, no Firebase, no Play
  Services).
- Personal info: name, email, phone (accounts and manager contact); players'
  and officials' names and dates of birth, licence data (match rosters).
  Purpose: app functionality, account management. Required for the
  corresponding feature; optional for the app as a whole (a match can be
  scored without an account).
- Photos / files: signatures (images) on the scoresheet. App functionality.
- App activity: match events (points, sanctions). App functionality.
- Device or other IDs: none collected for advertising; session ids are
  functional only.
- Data encrypted in transit: **Yes** (HTTPS), except the optional venue mode
  over plain HTTP on a local network; say so in the form notes.
- Users can request deletion: **Yes** (in-app account deletion plus the
  privacy page).
- Target audience: adults (referees, scorers, coaches); not for children.
- Ads: none. News / health / finance / government: none.

## Closed test checklist

1. Console: create the app, set up Play App Signing (choice above).
2. Upload the `.aab` to Closed testing, add 12+ testers (Google group or
   email list), start the 14 days.
3. Fill in listing, content rating, Data safety, target audience.
4. After 14 days: Apply for production access, then promote.
