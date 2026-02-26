# Deployment Guide

## Web Deployment (Static Hosting)

### Build for Production

From the `escoresheet/frontend` directory:

```bash
npm run build
```

Output goes to `dist/`. Deploy this folder to any static hosting provider.

### Cloudflare Pages

1. Connect your GitHub repo in [Cloudflare Pages](https://pages.cloudflare.com/)
2. Configure build settings:
   - **Build command**: `cd escoresheet/frontend && npm install && npm run build`
   - **Build output directory**: `escoresheet/frontend/dist`
   - **Root directory**: `/` (leave empty)
3. Add environment variables in Pages settings:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `VITE_BACKEND_URL` (optional)
4. Deploy

Dependencies like animejs and bootstrap-icons are loaded from CDN, so `node_modules` is not included in the build output.

### Other Static Hosts

The `dist/` folder works with any static host:

- **Netlify**: Connect repo, set build command and output directory
- **Vercel**: Same approach as Cloudflare Pages
- **GitHub Pages**: Use the `VITE_BASE_PATH` env var if deploying to a project subpath (e.g., `VITE_BASE_PATH=/openvolley/`)

## Subdomain Deployment

The app supports deploying each role as a separate subdomain for cleaner URLs and independent scaling.

### Architecture

```text
                        DNS (Cloudflare)
                             |
        +----------+---------+---------+----------+
        v          v         v         v          v
   app.*      referee.*   bench.*  livescore.*  roster.*
  (main)
   Static      Static    Static    Static     Static
        |          |         |         |          |
        +----------+---------+---------+----------+
                             v
                    Backend (optional)
                    WebSocket + API
```

### Subdomains

| Subdomain | Purpose | Build Command |
| --- | --- | --- |
| `app.openvolley.app` | Main scoresheet | `npm run build:app` |
| `referee.openvolley.app` | Referee dashboard | `npm run build:referee` |
| `bench.openvolley.app` | Bench dashboard | `npm run build:bench` |
| `livescore.openvolley.app` | Live score display | `npm run build:livescore` |
| `roster.openvolley.app` | Roster PDF upload | `npm run build:roster` |

Build all at once:

```bash
npm run build:subdomains
```

This creates `dist-app/`, `dist-referee/`, `dist-bench/`, `dist-livescore/`, and `dist-roster/`.

### DNS Configuration

Add CNAME records for each subdomain pointing to your hosting provider:

```text
app.openvolley.app        CNAME   your-app-service.example.com
referee.openvolley.app    CNAME   your-referee-service.example.com
bench.openvolley.app      CNAME   your-bench-service.example.com
livescore.openvolley.app  CNAME   your-livescore-service.example.com
roster.openvolley.app     CNAME   your-roster-service.example.com
```

### CORS Configuration

The backend must allow all subdomain origins. This is already configured in `server.js` to accept any `*.openvolley.app` subdomain plus localhost for development.

## Desktop Deployment (Electron)

### Windows

```bash
npm run electron:build:win
```

Output in `dist-electron/`:

- NSIS installer (x64 + ia32)
- Portable executable (x64)

### macOS

```bash
npm run electron:build:mac
```

Output in `dist-electron/`:

- DMG (x64 + arm64)
- ZIP (x64 + arm64)

### Linux

```bash
npm run electron:build:linux
```

Output in `dist-electron/`:

- AppImage (x64)
- DEB (x64)
- RPM (x64)

## Mobile Deployment (Capacitor)

### Android

```bash
npm run cap:build:android    # Build web + sync to native
npm run cap:open:android     # Open in Android Studio
```

Then build the APK/AAB from Android Studio.

### iOS

```bash
npm run cap:build:ios        # Build web + sync to native
npm run cap:open:ios         # Open in Xcode
```

Then build from Xcode. Requires a Mac with Xcode installed.

## Automated Releases (GitHub Actions)

The project uses GitHub Actions to automatically build and publish desktop releases.

### How It Works

1. Workflow file: `.github/workflows/release.yml`
2. Builds Electron apps in parallel: Windows, macOS, Linux
3. Creates a GitHub Release with all artifacts
4. Automatically deletes releases older than the last 3

### Triggering a Release

#### Tag Push

```bash
git tag v1.3.0
git push origin v1.3.0
```

#### Manual Dispatch

Go to Actions > "Build and Release Desktop Apps" > Run workflow > Enter version (e.g., `v1.3.0`).

### Required GitHub Secrets

| Secret | Description |
| --- | --- |
| `VITE_SUPABASE_URL` | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase anonymous key |

`GITHUB_TOKEN` is provided automatically by GitHub Actions.

### Build Output

Each release includes:

- **Windows**: Installer (`.exe`) + Portable (`.exe`)
- **macOS**: DMG (`.dmg`) + ZIP (`.zip`) for both x64 and arm64
- **Linux**: AppImage (`.AppImage`) + DEB (`.deb`) + RPM (`.rpm`)

## Backend Deployment

The optional WebSocket backend is deployed separately. See the [Backend README](../backend/README.md) for Render deployment instructions and other hosting options.
