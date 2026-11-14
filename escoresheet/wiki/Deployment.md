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
3. Add environment variables in Pages settings (optional):
   - `VITE_BACKEND_URL`
4. Deploy

Everything the pages load (scripts, fonts, icons) is bundled into `dist/`; no page loads code from a CDN.

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
| `manager.openvolley.app` | Admin console and competition manager (no service worker, noindex; see `docs/manager-site-deploy.md`) | `node scripts/build-subdomains.js manager` |

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

## Desktop Deployment (Tauri)

The desktop app (offline scoretable and LAN relay for the tablets) is built with Tauri. Build steps, the OpenBeach flavour, signing and the Windows installer are in [OFFLINE_DESKTOP.md](../frontend/OFFLINE_DESKTOP.md). Releases are built by CI (see "Automated Releases" below).

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

Desktop releases are built by `.github/workflows/desktop.yml` (repository root) when a tag like `desktop-v<version>` is pushed: Windows, Linux and macOS, one GitHub release with every file. The version in `escoresheet/frontend/package.json` must match the tag. Publishing to the download page and the package channels is a separate step, see the release procedure in [deploy/README.md](../deploy/README.md).

`GITHUB_TOKEN` is provided automatically by GitHub Actions. The macOS signing secrets are listed in the workflow file.

## Backend Deployment

The optional WebSocket backend is deployed separately. See the [Backend README](../backend/README.md) for Render deployment instructions and other hosting options.
