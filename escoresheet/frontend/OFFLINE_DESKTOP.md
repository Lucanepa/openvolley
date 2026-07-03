# Offline Desktop App (Windows / Linux) + LAN tablet server

The Electron desktop app runs the scoretable **fully offline** and doubles as a
**LAN server** so referee / bench / livescore tablets on the same Wi-Fi can
connect — no internet, no cloud, no accounts required to score a match.

## How it works

```
   ┌─────────────────────────── Desktop app (Electron) ──────────────────────────┐
   │  Renderer (the scoretable)  ──loads──►  http://localhost:5173                 │
   │                                              ▲                                │
   │  In-process relay (electron/relayServer.js)  │  serves built site (dist/)     │
   │    • HTTP  on :5173  (static site + /api/*)   │  + WebSocket relay on :8080    │
   └──────────────────────────────────────────────┼────────────────────────────────┘
                                                   │  same Wi-Fi / LAN
              tablets/phones open  http://<LAN-IP>:5173/referee.html  etc.
```

- The relay starts **in the Electron main process** (no child `node`, no bundling
  headaches) the moment the app launches, then the window loads the app from
  `http://localhost:5173`. Serving over `http://localhost` (a secure context)
  means the desktop keeps camera/QR, and the app's normal LAN client code
  resolves its backend/WebSocket URLs correctly.
- Data lives locally in IndexedDB (Dexie). Supabase cloud sync is optional and
  degrades gracefully when offline.
- If the relay can't start (e.g. port 5173 already in use), the app still opens
  fully offline by loading the built files from disk — only tablet connectivity
  is unavailable in that case.

## Build the installers

```bash
cd escoresheet/frontend
npm install
npm run electron:build:win     # → dist-electron/  (NSIS installer + portable .exe)
npm run electron:build:linux   # → dist-electron/  (AppImage, .deb, .rpm)
# npm run electron:build:mac   # (macOS, if needed)
```

## Connect a tablet

1. Make sure the tablet is on the **same Wi-Fi/LAN** as the computer.
2. On the desktop, open **Help → Connect a Tablet…** to see the addresses, e.g.:
   - Scoretable: `http://192.168.1.42:5173/`
   - Referee:    `http://192.168.1.42:5173/referee.html`
   - Bench:      `http://192.168.1.42:5173/bench.html`
   - Livescore:  `http://192.168.1.42:5173/livescore.html`
3. Type the address into the tablet's browser and enter the match PIN.

## Why plain HTTP (and the tablet-camera trade-off)

Tablets connect over plain `http://<LAN-IP>` — simple, zero setup, no
certificate warnings. The trade-off: browsers block the camera on a non-secure
origin, so **QR-scan roster upload does not work on tablets** (it still works on
the desktop, which is served from the secure `http://localhost`).

If camera/QR on tablets becomes a requirement later, the options are: install a
trusted local CA certificate on each tablet and serve HTTPS, or use an mDNS
`.local` name with a trusted cert. That's deliberately deferred — see below.

## Follow-ups (not in this change)

- **Tablet HTTPS + camera** — only if QR scanning on tablets is needed.
- **Auto-update** — `electron-builder` publish config is present (GitHub); wire
  `electron-updater` when a release channel is chosen.
- **Port-in-use UX** — surface a message in the UI when the relay can't bind.
