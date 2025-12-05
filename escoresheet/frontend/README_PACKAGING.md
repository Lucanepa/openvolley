# Packaging Guide for Openvolley eScoresheet

This guide explains how to build desktop and mobile applications from the PWA.

## Desktop Applications (Windows, macOS, Linux)

### Prerequisites

- Node.js 20+ installed
- For Windows: No additional requirements
- For macOS: Xcode Command Line Tools (`xcode-select --install`)
- For Linux: `fakeroot` and `dpkg` for .deb, `rpm` for .rpm

### Building Desktop Apps

1. **Install dependencies:**
   ```bash
   cd frontend
   npm install
   ```

2. **Build for your platform:**
   
   **Windows:**
   ```bash
   npm run electron:build:win
   ```
   Output: `dist-electron/Openvolley eScoresheet Setup x.x.x.exe` (installer)
   Output: `dist-electron/Openvolley eScoresheet x.x.x.exe` (portable)
   
   **macOS:**
   ```bash
   npm run electron:build:mac
   ```
   Output: `dist-electron/Openvolley eScoresheet-x.x.x.dmg` (installer)
   Output: `dist-electron/Openvolley eScoresheet-x.x.x-mac.zip` (zip)
   
   **Linux:**
   ```bash
   npm run electron:build:linux
   ```
   Output: `dist-electron/Openvolley eScoresheet-x.x.x.AppImage` (AppImage)
   Output: `dist-electron/Openvolley eScoresheet-x.x.x.deb` (Debian package)
   Output: `dist-electron/Openvolley eScoresheet-x.x.x.rpm` (RPM package)

3. **Build all platforms:**
   ```bash
   npm run electron:build
   ```

### Development Mode

Run the app in development mode with hot reload:
```bash
npm run electron:dev
```

## Mobile Applications (Android, iOS)

### Prerequisites

- Node.js 20+ installed
- For Android: Android Studio with Android SDK
- For iOS: macOS with Xcode (iOS development only works on Mac)

### Setting Up Mobile Apps

1. **Initialize Capacitor (first time only):**
   ```bash
   cd frontend
   npm install
   npx cap init
   ```
   - App name: `Openvolley eScoresheet`
   - App ID: `com.openvolley.escoresheet`

2. **Add platforms:**
   ```bash
   npx cap add android
   npx cap add ios  # macOS only
   ```

3. **Build and sync:**
   ```bash
   npm run build
   npx cap sync
   ```

### Building Android App

1. **Open Android Studio:**
   ```bash
   npm run cap:open:android
   ```

2. **In Android Studio:**
   - Wait for Gradle sync to complete
   - Click "Build" → "Build Bundle(s) / APK(s)" → "Build APK(s)"
   - Or use "Build" → "Generate Signed Bundle / APK" for release

3. **Output location:**
   - APK: `android/app/build/outputs/apk/`
   - AAB (for Play Store): `android/app/build/outputs/bundle/`

### Building iOS App (macOS only)

1. **Open Xcode:**
   ```bash
   npm run cap:open:ios
   ```

2. **In Xcode:**
   - Select your development team in "Signing & Capabilities"
   - Select a device or simulator
   - Click "Product" → "Archive" for release build
   - Or click "Run" (▶️) for development build

3. **For App Store submission:**
   - Archive the app
   - Use "Distribute App" to create an .ipa file
   - Upload via App Store Connect

### Updating Mobile Apps

After making changes to your web app:

1. **Rebuild:**
   ```bash
   npm run build
   ```

2. **Sync to native projects:**
   ```bash
   npx cap sync
   ```

3. **Reopen in IDE:**
   ```bash
   npm run cap:open:android  # or cap:open:ios
   ```

## Icons

Place app icons in `electron/` directory:
- `icon.ico` - Windows icon (256x256)
- `icon.icns` - macOS icon (512x512)
- `icon.png` - Linux icon (512x512)

For mobile apps, icons are generated automatically from `electron/icon.png` or you can customize them in the native projects.

## Notes

- Desktop apps use Electron and bundle the entire app
- Mobile apps use Capacitor and wrap the web app in a native container
- All apps work offline and use IndexedDB for local storage
- Supabase sync works in all versions when online

## Troubleshooting

### Electron build fails
- Make sure all dependencies are installed: `npm install`
- Check that `dist/` folder exists after `npm run build`
- For macOS, ensure you have Xcode Command Line Tools

### Capacitor sync fails
- Run `npm run build` first
- Make sure `dist/` folder exists
- Check that platforms are added: `npx cap ls`

### Android build fails
- Open Android Studio and let it sync Gradle
- Check Android SDK is installed
- Ensure Java/JDK is properly configured

### iOS build fails (macOS only)
- Ensure Xcode is installed and updated
- Select a development team in Xcode
- Check that signing certificates are valid
