# Deployment Guide

This guide describes how to build and deploy Openvolley eScoresheet for various platforms.

## Web Deployment

Ensure you are in the `escoresheet/frontend` directory:
```bash
cd escoresheet/frontend
```

To build the application for the web:

```bash
npm run build
```

This command uses Vite to build the application. The output files will be generated in the `dist` directory. You can deploy the contents of this directory to any static file serving service (e.g., Netlify, Vercel, GitHub Pages).

### Subdomains
The project includes scripts to build specific "subdomains" or modules (referee, bench, livescore, roster).

```bash
npm run build:subdomains
```
Or individually:
```bash
npm run build:referee
npm run build:bench
# ... etc
```

## Desktop Deployment (Electron)

To build the desktop application for different operating systems:

### Windows
```bash
npm run electron:build:win
```
This builds an installer (NSIS) and a portable executable.

### macOS
```bash
npm run electron:build:mac
```
This builds `.dmg` and `.zip` files.

### Linux
```bash
npm run electron:build:linux
```
This builds `.AppImage`, `.deb`, and `.rpm` files.

> **Note:** The artifacts for Electron builds are output to `dist-electron` as configured in `package.json`.

## Mobile Deployment (Capacitor)

The project uses Capacitor to deploy to Android and iOS.

### Android
1.  **Sync Dependencies:**
    ```bash
    npm run cap:sync
    ```
2.  **Open in Android Studio:**
    ```bash
    npm run cap:open:android
    ```
3.  **Build:**
    Run the build from Android Studio.

### iOS
1.  **Sync Dependencies:**
    ```bash
    npm run cap:sync
    ```
2.  **Open in Xcode:**
    ```bash
    npm run cap:open:ios
    ```
3.  **Build:**
    Run the build from Xcode.

> **Tip:** You can combine build and sync with `npm run cap:build:android` or `npm run cap:build:ios`.

## Automated Releases

The project is configured with GitHub Actions to automatically build and release the desktop application.

1.  **Trigger:** Push a tag starting with `v` (e.g., `v1.0.0`).
    ```bash
    git tag v1.0.0
    git push origin v1.0.0
    ```
2.  **Process:** The workflow in `.github/workflows/release.yml` will run, build the application for Windows, and upload the artifacts to the GitHub Release page draft.

