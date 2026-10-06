# Offline Desktop App (Windows / Linux) + LAN tablet server

The desktop app runs the scoretable **fully offline** and doubles as a **LAN
server** so referee / bench / livescore tablets on the same Wi-Fi can connect —
no internet, no cloud, no accounts required to score a match.

There are two implementations of the same idea; **Tauri is the recommended one.**

| | **Tauri (Rust)** — recommended | Electron |
|---|---|---|
| Installer size | ~3–10 MB | ~85–120 MB |
| Runtime | native OS webview (WebView2 / WebKitGTK) | bundled Chromium + Node |
| LAN relay | Rust `axum` (`src-tauri/src/relay.rs`) | Node in main process (`electron/relayServer.js`) |
| Frontend | **identical** React `dist/` | identical React `dist/` |

## How it works (both)

```
   ┌──────────────────────────── Desktop app ────────────────────────────┐
   │  Window (the scoretable)  ──loads──►  http://localhost:5173          │
   │                                            ▲                          │
   │  In-process relay                          │  serves built site       │
   │    • HTTP  :5173  (static site + /api/*)    │  + WebSocket relay :8080 │
   └────────────────────────────────────────────┼──────────────────────────┘
                                                 │  same Wi-Fi / LAN
            tablets/phones open  http://<LAN-IP>:5173/referee  etc.
```

- The relay starts **in-process** when the app launches; the window then loads
  the app from `http://localhost:5173`. Serving over `http://localhost` (a
  secure context) keeps the desktop's camera/QR working, and the app's normal
  LAN client code resolves its backend/WebSocket URLs correctly.
- Data lives locally in IndexedDB (Dexie). Cloud sync is optional and degrades
  gracefully when offline: the relay has no database, so cloud calls (/api/db,
  auth, storage, sync queue, restore, database realtime) go to
  `https://backend.openvolley.app` (`getCloudApiUrl` in
  `src/utils/backendConfig.js`; a build can set `VITE_CLOUD_API_URL`), while
  the match relay WebSocket and the tablet endpoints stay on the local relay
  (`ws://localhost:8080`, `http://<LAN-IP>:5173`). Online, the startup check
  shows Cloud sync: Connected; without internet it shows Cloud sync: Offline
  and the header pill reads **Local only** while the venue keeps running.
  Nothing is uploaded without an account: with no sign-in the queue waits
  ("Sign in to sync") and matches stay on this laptop.
- Only the desktop window (loopback origin) talks to the cloud. Pages the
  relay serves to the venue tablets from the LAN address
  (`http://<LAN-IP>:5173/referee`, `/bench`, `/livescore`) keep cloud calls on
  the relay itself: the cloud rejects LAN origins (CORS), and the relay
  answers `/api/db` with an instant 404, so the tablets never wait on a hall
  Wi-Fi without uplink. The referee and bench match lists ask the relay first
  on a relay-served page (`src/utils/matchListSource.js`).
- The desktop connects from loopback, so it bypasses the single-scoretable gate
  and can reload freely; a second device hitting the root over the LAN still
  gets the "one scoretable" protection.

## Build — Tauri (recommended)

Prereqs: Rust (`rustup`), Node, and on Linux the WebView deps
(`libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`).

```bash
cd escoresheet/frontend
npm install
npx tauri build            # → src-tauri/target/release/bundle/
#   Windows: an NSIS .exe installer     (build on Windows / CI)
#   Linux:   an .AppImage and a .deb
```

Windows installers are produced by CI (`.github/workflows/desktop.yml`, a
`windows-latest` runner) — WebView2/NSIS can't be cross-built from Linux. Push a
`desktop-v*` tag or run the workflow manually to get Windows + Linux artifacts.

Headless / server-only (no window — a plain "server for tablets"):

```bash
npx tauri build            # or use the debug binary
./src-tauri/target/release/openvolley-escoresheet --server-only
# ports overridable: OPENVOLLEY_HTTP_PORT / OPENVOLLEY_WS_PORT
```

## Build — Electron (alternative)

```bash
cd escoresheet/frontend
npm run electron:build:win     # → dist-electron/  (NSIS installer + portable .exe)
npm run electron:build:linux   # → dist-electron/  (AppImage, .deb, .rpm)
```

## Connect a tablet

1. Make sure the tablet is on the **same Wi-Fi/LAN** as the computer.
2. On the desktop, open the header menu (☰) → **Connect tablets** to see the
   addresses (with copy buttons and a QR code), e.g.:
   - Scoretable: `http://192.168.1.42:5173/`
   - Referee:    `http://192.168.1.42:5173/referee`
   - Bench:      `http://192.168.1.42:5173/bench`
   - Livescore:  `http://192.168.1.42:5173/livescore`
3. Type the address into the tablet's browser and enter the match PIN.

## Why plain HTTP (and the tablet-camera trade-off)

Tablets connect over plain `http://<LAN-IP>` — simple, zero setup, no
certificate warnings. The trade-off: browsers block the camera on a non-secure
origin, so **QR-scan roster upload does not work on tablets** (it still works on
the desktop, which is served from the secure `http://localhost`).

If camera/QR on tablets becomes a requirement later, the options are: install a
trusted local CA certificate on each tablet and serve HTTPS, or use an mDNS
`.local` name with a trusted cert. That's deliberately deferred.

## Follow-ups (not in this change)

- **Tablet HTTPS + camera** — only if QR scanning on tablets is needed.
- **Auto-update** — wire `tauri-plugin-updater` (or `electron-updater`) once a
  release channel is chosen.
- **electronAPI shim in Tauri** — inject `window.electronAPI` backed by Tauri
  commands so the in-app connection/QR panels (which check for Electron) light
  up natively. Today the LAN addresses are shown in the header menu
  (**Connect tablets**, read from `/api/server/status`).
- **Port-in-use UX** — surface a friendly message when the relay can't bind.

## Window chrome

- No native menu bar on Linux / Windows (it held only Help → Connect a Tablet
  and rendered in the GTK system theme). Its items live in the app's header
  menu: Connect tablets, help (?), version. macOS keeps Tauri's default app menu.
- Light only: besides `Theme::Light`, the Linux build asks GTK for the light
  variant of a dark system theme (`Yaru-dark` → `Yaru`), so the title bar,
  pickers and scrollbars stay light on a dark desktop. A `GTK_THEME` set by the
  user still wins. The app logs `[theme] GTK theme … -> …` when it switches.
