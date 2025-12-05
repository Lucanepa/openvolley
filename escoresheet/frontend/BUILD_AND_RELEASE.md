# Building and Releasing Desktop Apps

## Quick Build (Local)

### Windows
```bash
cd frontend
npm install
npm run electron:build:win
```
Output: `dist-electron/Openvolley-eScoresheet-Setup-x.x.x.exe`

### macOS
```bash
cd frontend
npm install
npm run electron:build:mac
```
Output: `dist-electron/Openvolley-eScoresheet-x.x.x.dmg`

### Linux
```bash
cd frontend
npm install
npm run electron:build:linux
```
Output: `dist-electron/Openvolley-eScoresheet-x.x.x.AppImage`

## Creating a GitHub Release

1. **Build the apps** (see above) or use the automated workflow (see below)

2. **Create a new release on GitHub:**
   - Go to: https://github.com/lucacanepa/openvolley/releases/new
   - Tag: `v0.1.0` (or your version number)
   - Title: `Release v0.1.0`
   - Description: Add release notes

3. **Upload the built files:**
   - Drag and drop the files from `dist-electron/` folder:
     - `Openvolley-eScoresheet-Setup-x.x.x.exe` (Windows)
     - `Openvolley-eScoresheet-x.x.x.dmg` (macOS)
     - `Openvolley-eScoresheet-x.x.x.AppImage` (Linux)
   - Click "Publish release"

4. **The download links will work automatically** once files are uploaded!

## Automated Release (GitHub Actions)

A workflow file is provided to automatically build and create releases. See `.github/workflows/release.yml`
