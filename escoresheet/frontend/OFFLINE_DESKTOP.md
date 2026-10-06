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
- Data lives locally in IndexedDB (Dexie). Supabase cloud sync is optional and
  degrades gracefully when offline.
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
2. On the desktop, open **Help → Connect a Tablet…** to see the addresses, e.g.:
   - Scoretable: `http://192.168.1.42:5173/`
   - Referee:    `http://192.168.1.42:5173/referee`
   - Bench:      `http://192.168.1.42:5173/bench`
   - Livescore:  `http://192.168.1.42:5173/livescore`
3. Type the address into the tablet's browser and enter the match PIN.

## Automatic backups (every event)

The desktop app saves the open match after **every scoring event** (point,
timeout, substitution, sanction, libero change, roster change, set start/end,
match end, undo), on by default, no browser feature needed:

- Linux: `~/.local/share/OpenVolley/backups/<match>/`
- Windows: `%APPDATA%\OpenVolley\backups\<match>\`
- (`OPENVOLLEY_BACKUP_DIR` overrides the folder.)

Each match folder (`game<N>-<whole seed>`, `test-…` for test matches; without
a seed `game<N>-local<id>`) holds one `<UTC time>-<event seq>.json` per event
plus `latest.json`, in the same format as **Download backup** without the
match PINs and session ids (`"secretsRemoved": true`), so **Options → Backup →
Restore from a backup file** (or Restore match → local file) restores any of
them; the restore keeps the PINs of the local copy it replaces or makes new
ones. **Options → Backup → Open backup folder** opens it in the file manager.

When it writes: after a write of the match, once nothing more was written for
150 ms (at most 1.5 s later), on an idle moment, so a point (event, its state
snapshot, the set score) is one consistent file and the scorer's taps go
first. A state that only differs in heartbeats, sessions or `updatedAt` is not
written again.

Size and rotation: every file is the whole match, about 1.5 KB per event, so a
5-set match ends near 0.7 MB and writes about 80 MB in total (measured with
`src/utils/nativeBackup/__tests__/fullMatch.size.test.js`). So each match keeps
its newest files within **64 MB** (and 500 files); a match nobody scored for
**12 hours** is thinned to its newest **10** files; event files older than
**30 days** are deleted; the newest event file of a match and `latest.json`
are always kept. Older folders are rotated after the first backup of a
session, in small chunks.

Privacy: the files hold player names and birth dates, officials and signature
images (no PINs). On Linux the folders are created `0700` and the files
`0600`; on Windows `%APPDATA%` is private to the user account. If only
`latest.json` cannot be replaced (Windows: a virus scan or the Explorer
preview holds it), the event file is still saved and it is not an error. A
failing backup shows a red **Backup** badge next to the scoreboard clock
(tap: Options).

The writes go through the app's `backup_*` Rust commands
(`src-tauri/src/backup.rs`), which only accept a match folder and a file name
inside that one folder; `capabilities/backup.json` grants them to the main
window on `http://localhost` only. LAN tablets are plain browsers and keep the
browser options (folder on Chrome/Edge, downloads elsewhere). The ACL is
tested through Tauri's mock runtime with the app's real context
(`ipc_acl_tests` in `src-tauri/src/main.rs`: `http://localhost:<port>` may
write and list, a LAN address, another site or `localhost.evil.com` may not).

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
  up natively. Today the LAN addresses are shown via the native menu instead.
- **Port-in-use UX** — surface a friendly message when the relay can't bind.
