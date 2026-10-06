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
- Cloud sync needs the window on **port 5173** (`http://localhost:5173` or
  `http://127.0.0.1:5173`): those are the only desktop origins the cloud
  backend's CORS trusts (`ALLOWED_ORIGINS` in `backend/server.js`). If
  `OPENVOLLEY_HTTP_PORT` moves the relay elsewhere (5173 taken by another
  program), the venue runs as usual but cloud sync is off: the connection
  status says "Cloud sync unavailable on port N"
  (`isCloudBlockedOnThisPort` in `src/utils/backendConfig.js`) and the app
  logs the same at start. The automatic backups do not depend on the port
  (the `backup` capability allows the window on any loopback port).
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

Names. `productName` in `tauri.conf.json` ("Openvolley eScoresheet") names the
Windows installer and its install directory; keep it, or Windows installs stop
upgrading in place. On Linux `tauri.linux.conf.json` overrides `productName` and
`mainBinaryName` with `openvolley-escoresheet`, because Tauri derives the `.deb`
package name from `productName` in kebab case ("Openvolley eScoresheet" gave
`openvolley-e-scoresheet`). So the Linux files are
`openvolley-escoresheet_<version>_amd64.deb` / `.AppImage`, the package and the
command are `openvolley-escoresheet`, and the desktop entry (template
`src-tauri/openvolley-escoresheet.desktop`) keeps the menu name **OpenVolley
eScoresheet**. The `.deb` provides, replaces and conflicts with
`openvolley-e-scoresheet` and `openvolley`, so `apt install
openvolley-escoresheet` takes over an older install. The bundle `identifier`
(`com.openvolley.escoresheet`) is the same everywhere: it keys the app's stored
data.

Install on Debian/Ubuntu (amd64) from the signed APT repository:

```bash
curl -fsSL https://get.openvolley.app/install.sh | sudo sh   # once
sudo apt update && sudo apt upgrade                           # later updates
```

(`escoresheet/deploy/README.md`, Public downloads, has what the installer does
and how packages get published.)

Windows installers are produced by CI (`.github/workflows/desktop.yml`, a
`windows-latest` runner) — WebView2/NSIS can't be cross-built from Linux. Push a
`desktop-v*` tag or run the workflow manually to get Windows + Linux artifacts.

Headless / server-only (no window — a plain "server for tablets"):

```bash
npx tauri build            # or use the debug binary
./src-tauri/target/release/openvolley-escoresheet --server-only
# ports overridable: OPENVOLLEY_HTTP_PORT / OPENVOLLEY_WS_PORT
# (cloud sync needs the default HTTP port 5173, see above)
```

Installed from the APT repository it is `openvolley-escoresheet --server-only`.

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

## Display devices (LedBox) and rehearsals

- Every relay lists all scheduled / live matches a scorer currently publishes
  on `GET /api/match/list` (public fields only, no PINs), whatever their
  referee connection: the point-hub LedBox bridge picks its match there. The
  referee and bench apps still offer only the matches they can join.
- A **test (rehearsal) match** sends its live state to a **local relay only**,
  never to the cloud, so the board can be rehearsed in the hall. "Local" is
  decided from the relay address the scorer is connected to
  (`isLocalRelayUrl` in `src/utils/relayPublisher.js`): `localhost`, private
  and link-local IPs (`10.x`, `172.16–31.x`, `192.168.x`, `169.254.x`,
  Tailscale `100.64–127.x`, `fc00::/7`, `fe80::/10`), single-label host names
  (`openvolley-pi`) and `.local` / `.lan` / `.home.arpa` / `.internal` names.
  A venue relay reached through a **public domain name** (e.g.
  `wss://scoreboard.myclub.ch` via split DNS or a reverse proxy on the Pi) does
  not count: a rehearsal there sends no live state to the board. Connect the
  scorer by the box's IP or `.local` name to rehearse.
- Each device's test match has its own relay room
  (`test-match-default-<random>`), so two scorers can rehearse on one relay.

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

## Scoresheet windows, links and downloads

Every `window.open` of the app goes through `src/utils/openAppWindow.js`; the
desktop side is `src-tauri/src/popups.rs` (new-window handler on the main
window and on the windows it opens):

- The app's own pages (`http://localhost:<port>/…`: the scoresheet, its
  print / save / approval-PDF modes) open as an **app window** (label
  `popup-<n>`, in no capability, so no app commands). It is the webview the
  opener asked for: same web process and data store (the scoresheet reads the
  match from the same IndexedDB) and `window.opener` (the match-end approval
  PDF comes back by `postMessage`). `window.close()` in it closes the window.
- Web links and `mailto:` go to the system browser / mail app (`xdg-open`,
  `open`, `rundll32 url.dll,FileProtocolHandler`); other schemes are refused.
- WebKitGTK only asks the handler about a `window.open` made during a click;
  the app's buttons first read IndexedDB, so scripts may open windows (the
  handler decides what opens).
- Downloads ("Save PDF" is a blob download) go to the Downloads folder
  (`~/Downloads` when there is no `user-dirs.dirs`) under a free name; the
  windows get an `ov-download-finished` event and the scoresheet shows where
  the file went. One handler on the main window: the popups share its context.

Known limits:

- **Save PDF on Linux fails**: html-to-image turns the scoresheet into a
  ~73 MB `data:image/svg+xml` URL and WebKitGTK refuses data URLs above
  ~64 MB ("Not allowed to load local resource"); a `blob:` URL loads but
  taints the canvas. The scoresheet now says "The PDF could not be created on
  this device". Windows (WebView2, Chromium) is not affected. Fix options: a
  smaller SVG (html-to-image `includeStyleProperties`), capturing the sheet in
  parts, or `window.print()` to the GTK print dialog (Print to file).
- **`alert()` / `confirm()` in the desktop app**: `tauri-plugin-dialog`
  replaces both with IPC calls (`plugin:dialog|message` / `|confirm`) that no
  capability allows, so `alert()` shows nothing and `confirm()` returns a
  Promise, which is truthy: the action-log deletes and the LFP warning in the
  scoreboard (`if (confirm(...))`) go ahead without asking. Not changed here.
