# Installation & Development Guide

## Prerequisites

- **Node.js** 20+ (LTS recommended)
- **npm** (comes with Node.js)
- **Git**

## Setup

1. Clone the repository:

    ```bash
    git clone https://github.com/lucacanepa/openvolley.git
    cd openvolley/escoresheet/frontend
    ```

2. Install dependencies:

    ```bash
    npm install
    ```

## Development

### Web Development

Start the Vite dev server:

```bash
npm run dev
```

The app will be available at `http://localhost:5173`. Other devices on the same network can also access it (the server binds to `0.0.0.0`).

### HTTPS Development

Required for testing PWA installation and secure features:

```bash
npm run dev:https
```

If you don't have certificates, generate them first:

```bash
npm run generate-certs
```

### Electron Development (Desktop)

Starts Vite and Electron concurrently:

```bash
npm run electron:dev
```

This waits for the dev server on port 5173, then launches the Electron window.

## Environment Variables

Create a `.env` file in `escoresheet/frontend/` if you need cloud features. All variables are optional -- the app works fully offline without them.

| Variable | Description |
| --- | --- |
| `VITE_SUPABASE_URL` | Supabase project URL for cloud sync |
| `VITE_SUPABASE_ANON_KEY` | Supabase anonymous key |
| `VITE_BACKEND_URL` | WebSocket backend URL (e.g., `https://your-server.railway.app`) |
| `VITE_HTTPS` | Set to `true` to enable HTTPS in dev |
| `VITE_BASE_PATH` | Base path for non-root deployments (e.g., `/openvolley/`) |
| `VITE_APP_TITLE` | Override PWA manifest app name |

## Project Scripts

### Development

| Script | Description |
| --- | --- |
| `dev` | Start web dev server (Vite, port 5173) |
| `dev:https` | Start dev server with HTTPS |
| `preview` | Preview production build locally |
| `start` | Start production server (server.js) |
| `start:prod` | Build + start production server |
| `start:https` | Start production server with HTTPS |
| `start:prod:https` | Build + start production server with HTTPS |
| `generate-certs` | Generate local HTTPS certificates |

### Building

| Script | Description |
| --- | --- |
| `build` | Build web app for production (`dist/`) |
| `build:subdomains` | Build all subdomains (`dist-app/`, `dist-referee/`, etc.) |
| `build:app` | Build main app subdomain only |
| `build:referee` | Build referee subdomain only |
| `build:bench` | Build bench subdomain only |
| `build:livescore` | Build livescore subdomain only |
| `build:roster` | Build roster subdomain only |

### Desktop (Electron)

| Script | Description |
| --- | --- |
| `electron:dev` | Start Electron dev environment |
| `electron:build` | Build desktop app (current platform) |
| `electron:build:win` | Build Windows installer + portable |
| `electron:build:mac` | Build macOS DMG + ZIP |
| `electron:build:linux` | Build Linux AppImage + DEB + RPM |
| `electron:clean` | Clean `dist-electron/` directory |

### Mobile (Capacitor)

| Script | Description |
| --- | --- |
| `cap:sync` | Sync web assets to native projects |
| `cap:open:android` | Open Android project in Android Studio |
| `cap:open:ios` | Open iOS project in Xcode |
| `cap:build:android` | Build web + sync to Android |
| `cap:build:ios` | Build web + sync to iOS |

### Utilities

| Script | Description |
| --- | --- |
| `translate` | Auto-translate missing i18n keys |
| `translate:dry` | Preview translation changes without writing |

## Backend Development

The WebSocket backend is optional and lives in `escoresheet/backend/`:

```bash
cd escoresheet/backend
npm install
npm start
```

Server runs on `http://localhost:8080`. See the [Backend README](../backend/README.md) for full documentation.
