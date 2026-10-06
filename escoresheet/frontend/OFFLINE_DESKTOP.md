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
(`libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf`).

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

## Connect tablets

Header menu (☰) → **Connect tablets** (also Options → Connections on the home
screen and the scoreboard). Three tabs, and on each every role: scoretable,
referee, home bench, away bench, livescore — link, large QR code, Copy. The
referee and bench rows show their **PIN on the scorer's screen only** (never in
a link or QR code; the game PIN is never shown) and the switch that lets the
role in. A link only preselects the match (`?match=<seed key>`, benches
`&team=home|away`); the tablet still asks for the PIN.

**Livescore works without internet.** On the hall Wi-Fi, the laptop's own
Wi-Fi and Bluetooth the livescore row has its link and QR code
(`http://<laptop address>:5173/livescore`, no match, no PIN). A livescore
page served by a relay on this machine or the local network (or the Android
app pointed at one) reads that relay instead of the cloud's live table
(`src/utils/relayLivescore.js`): the match list from
`/api/match/list?finished=1` every 10 s, then one WebSocket with
`subscribe-match { device: 'livescore' }` per match and never a PIN. The
relay answers such a socket with the public summary only (team names and
colours, status, set scores, the scorer's live state: score, serve, sides,
timeouts) and every `live-state-update`; PINs, rosters, officials, dates of
birth, events and match actions go only to a socket that proved a PIN. The
page keeps only the fields it shows. A rehearsal (test) match is shown with
a "Test match" chip; the cloud livescore never lists one. Online (the Server
tab, `livescore.openvolley.app`) it reads the cloud as before.

Asked first: **Create Wi-Fi** when it takes the laptop off its Wi-Fi (one
card: "This computer leaves <hall Wi-Fi>: tablets on it disconnect and cloud
sync pauses"), and **Stop** while referee / bench tablets are on the match or
on the Wi-Fi.

### LAN — Hall Wi-Fi

The tablet joins the same Wi-Fi / LAN as the computer and opens
`http://<laptop address>:5173/referee?match=…` etc. The addresses come from
`/api/server/status` → `interfaces` (`[{name, ip, kind}]`, kind `wifi`,
`ethernet`, `hotspot`, `bluetooth`, `other`; container / VM / VPN interfaces
left out). With several hall addresses the dialog lets the scorer pick one.
A hotspot of the laptop is listed too, last, as "This computer's hotspot":
one switched on in the system's own settings (Windows quick settings, GNOME
"Turn On Wi-Fi Hotspot") is a network tablets may already be on. Bluetooth
networks the laptop only joined (tethered to a phone: Windows "Bluetooth
Network Connection", Linux `bnep0`) are never listed; only the app's own
`pan-openvolley` bridge counts as a Bluetooth network.

### LAN — Create Wi-Fi for tablets (desktop app)

The laptop becomes the access point, no router and no internet needed:
**Create Wi-Fi** shows the network name (`OpenVolley-XXXX`) and password, a
Wi-Fi QR code (step 1, `WIFI:T:WPA;S:…;P:…;;`) next to the role's QR code
(step 2, on the laptop's address in the new network). The name and password
are made once per run; the dialog remembers the last ones, so tablets rejoin
by themselves next time. **New password** (while the Wi-Fi is off) makes a
fresh one, e.g. after it leaked; remembered ones the app refuses are forgotten
and the run's own are used. A hotspot already on in the system's own settings
shows as on with its links (Windows also with its name, password and Wi-Fi
code); the app does not stop it. Joining: iPad → Camera app on the Wi-Fi code;
Android 10+ → Settings › Wi-Fi › QR icon (or the camera); answer
"Stay connected" when the tablet says the Wi-Fi has no internet.

- **Linux** (`src-tauri/src/netshare/linux.rs`): NetworkManager over D-Bus
  (zbus, no shell). A WPA2 (RSN/CCMP, PMF off) 2.4 GHz access point,
  `ipv4.method shared` (laptop `10.42.0.1`, DHCP by dnsmasq), firewalld zone
  `trusted` (the default `nm-shared` zone blocks ports 5173 / 8080; see
  **Firewall exposure** below), owned by
  the desktop user (no admin password with the stock polkit rules), volatile
  and bound to the app's D-Bus connection: if the app crashes or quits,
  NetworkManager takes the network down and the laptop's normal Wi-Fi comes
  back. Needs NetworkManager, `dnsmasq` (`dnsmasq-base` on Debian/Ubuntu) and
  a card with AP mode. **The laptop leaves its own Wi-Fi while it runs** (one
  card); cloud sync pauses unless it is on a cable or has a second Wi-Fi
  adapter. No NetworkManager (iwd / ConnMan only): the dialog says so — use the
  system's hotspot or a travel router and Hall Wi-Fi.
- **Windows** (`netshare/win.rs`): the Mobile Hotspot through WinRT
  (`NetworkOperatorTetheringManager`), also offline (it tethers from any
  connection profile Windows allows, not only the internet one). Windows 11
  24H2+ takes the name / password for this session only; older builds store
  them as the user's own hotspot settings, which are put back on stop. The
  "turn off when no devices are connected" timeout is off while it runs. The
  laptop stays on its own Wi-Fi (`192.168.137.1` on the virtual adapter).
  Fallback when tethering is not possible: a Wi-Fi Direct legacy access point.
  Stopped on exit and at the next start after a crash: the marker file
  `%LOCALAPPDATA%\OpenVolley\tablet-wifi-on` holds the user's own hotspot
  name, password and band (older builds) and the timeout flag while the Wi-Fi
  runs, so a crash cannot leave them replaced. Status and stop use the
  connection profile the hotspot was started from (an uplink plugged in later
  does not confuse them). **Firewall**: the first run asks Windows Defender
  Firewall for access — tick **Public** too (the hotspot network is usually
  Public), or tablets join the Wi-Fi and get no page; the dialog shows this
  step on Windows once the Wi-Fi is on (Windows Security › Firewall & network
  protection › Allow an app through firewall › OpenVolley › Public).
  Third-party security suites may block `192.168.137.x`.
- **Browser / web build**: no button; the dialog explains the desktop app and
  the travel-router way (a small router, no internet, everyone on it, then Hall
  Wi-Fi).

**Firewall exposure (Linux).** The `trusted` zone opens *every* service of
the laptop to anyone holding the tablets' Wi-Fi password (or paired over
Bluetooth), not just 5173 / 8080: ssh, CUPS, a dev server. The password is
shown in large type on the scorer's screen in a public hall, and the relay's
WebSocket has no authentication of its own (PINs only). Accepted for v1; use
**New password** after the match if it may have been seen. Follow-up: a
custom firewalld zone (DHCP, DNS, 5173, 8080 only) shipped by the `.deb`
postinst, with `trusted` as the fallback for the AppImage.

### Server

Cloud links for each role on the role sites next to the scorer's deployment
(`referee.openvolley.app` …, `dev-…` on dev) with `?server=<backend>`, the
game number, the account (Sign in when signed out) and the match sync state.
Tablets need internet; the match must be synced and the role switched on.

### Bluetooth

- **Linux desktop app** (experimental): **Start Bluetooth network** adds a
  NetworkManager Bluetooth NAP bridge (`pan-openvolley`, shared addressing,
  e.g. `10.42.1.1`) on the first adapter and makes the laptop visible for
  pairing for 3 minutes. Android: pair, ⚙ → "Internet access" (Wi-Fi off if it
  does not connect). iPad: may not work (Apple documents PAN for cellular
  tethering only). Slow (first page several seconds), about 6 devices.
- A `pan-openvolley` bridge this run did not start is shown as on with its
  links, but Stop is disabled (the app holds nothing to stop it with).
- **Windows**: cannot serve a Bluetooth network (PANU only) — the tab says so,
  and gives no links even when the laptop is tethered to a phone over
  Bluetooth.
- **Not built**: a direct BLE link (GATT) for the Android app. Browsers on
  tablets cannot use Bluetooth (no Web Bluetooth on iPadOS; plain-http pages
  are not a secure context), so it would be app-only and needs a second
  transport on both ends.

### Must be tested on real hardware

The network code is unit-tested and type-checked (Linux build; Windows
`cargo check --target x86_64-pc-windows-msvc`), not run on a real laptop:

- Linux (Ubuntu 24.04, Framework): Create Wi-Fi as the desktop user (no polkit
  prompt), dnsmasq present, `10.42.0.1` shown, tablets get pages; quit / kill
  the app → the hotspot goes and the normal Wi-Fi comes back; Fedora: firewalld
  zone `trusted` lets 5173 / 8080 through; iPad joins (PMF off). One card:
  Create Wi-Fi asks first and names the hall Wi-Fi. GNOME "Turn On Wi-Fi
  Hotspot" switched on first: the dialog shows it as on (external), its links
  work, Stop is disabled.
- Windows 10 22H2 / 11 23H2 / 11 24H2, standard (non-admin) user: Create Wi-Fi
  with no internet; with zero saved profiles (Wi-Fi Direct fallback); the
  firewall prompt / rule for 5173 and 8080 on the hotspot adapter (is the
  hotspot adapter on the Public profile? do tablets time out until Public is
  ticked?); the user's own hotspot name and password back after Stop (older
  builds) **and after a crash** (kill the app while the Wi-Fi runs, start it
  again: Settings › Mobile hotspot shows the user's own name, the
  no-connections timeout is back on); plug in Ethernet while the tablets'
  Wi-Fi runs (it must stay on, not be stopped as "switched off elsewhere");
  Mobile Hotspot switched on in quick settings first: shown as on (external)
  with its name, password and links, Stop disabled; 2-hour match with tablets
  idle.
- Android 10–15 and iPad: Wi-Fi QR join, "no internet" prompt, mobile data on
  (the local address must still go over the Wi-Fi), WebSocket reconnects.
- Bluetooth (Linux): pairing + "Internet access" on Android, iPad join (or not),
  4–6 tablets.
- `cargo test -- --ignored --nocapture probe_this_machine` prints what the
  dialog will be told on a Linux laptop, without starting anything.

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
- **Windows firewall rule in the installer** (owner's decision) — the NSIS bundle installs per
  user (no admin), so it cannot add an inbound rule for 5173 / 8080; today the
  Defender prompt on first run does it (tick Public too). A per-machine
  install mode with an NSIS post-install `netsh advfirewall` hook would make
  the tablets' Wi-Fi work without that prompt.
- **Android app joins by QR** — scan the Wi-Fi QR (connect through a
  `WifiNetworkSuggestion`) and the role QR (open the bundled view with
  `server` / `match` / `team`) inside the app. Needs a camera / scanner plugin
  and a native Wi-Fi plugin; today a QR opens Chrome (see ANDROID.md).
- **Port-in-use UX** — surface a friendly message when the relay can't bind.

## Closing, the tray and quitting

The scoretable is also the tablets' server, so closing its window does not
quit (`src-tauri/src/lifecycle.rs`, page side `src/utils/appLifecycle.js`):

- **Close button / Alt+F4** hides the scoretable and its scoresheet windows
  to a **tray icon** (the app icon, tooltip "OpenVolley eScoresheet"). The
  relay keeps serving the tablets, the laptop's Wi-Fi / Bluetooth for the
  tablets keeps running, the match is untouched. The first close of each run
  shows an in-app notice first ("OpenVolley keeps running in the tray",
  Hide window / Keep open); later closes hide at once.
- **Tray icon**: on Windows a left click shows the window, the right click
  opens the menu; on Linux (AppIndicator) every click opens the menu. Menu:
  **Show OpenVolley**, a status line (tablets connected, "Match in progress" /
  "Test match in progress"), **Quit OpenVolley…**. The menu is in the app's
  language: the page sends its translated texts (`app_page_state`, again on
  every language change); until the page has loaded they are English. The
  tablet count is the relay's WebSocket connections from other machines,
  polled every 3 s.
- **Quitting** asks first: "Quit OpenVolley…" in the tray menu or in the
  app's header menu shows the window and an in-app question (danger tone):
  tablets on this computer's network disconnect; when the app runs the
  laptop's own Wi-Fi / Bluetooth for tablets, it says that stops too (a
  hotspot switched on outside the app is not mentioned: the app does not stop
  it); with a live match it says so (official or test match), that the match
  is saved on this computer and continues from the home screen. Only
  **Quit OpenVolley** exits, cleanly as before (the tablets' network is
  stopped on `RunEvent::Exit`, the relay goes with the process).
- **Exit rules** (`ExitGate`, unit-tested): a close hides; an exit nobody
  confirmed (`RunEvent::ExitRequested` while the scoretable window exists) is
  prevented and turned into the question; a confirmed quit exits; the OS is
  never held up: Linux `SIGTERM` (logout, shutdown, `kill`), `SIGINT`,
  `SIGHUP` quit at once (a second signal, or 10 s without an exit, ends the
  process), Windows ends the event loop itself on `WM_ENDSESSION`. A window
  with no loaded page (blank / broken) quits without asking, so the app can
  never become impossible to quit.
- **One app per computer** (`tauri-plugin-single-instance`): starting it
  again while it runs (e.g. in the tray) shows the running window and the
  second process exits, instead of failing on the busy ports. The ports are
  bound after that check. On Linux this uses the session D-Bus; without one
  the app still starts and a second launch fails on the ports as before.
- **Linux tray**: needs `libayatana-appindicator3` (or `libappindicator3`) at
  run time, which the `.deb` depends on (`libayatana-appindicator3-1 |
  libappindicator3-1`) and Tauri's AppImage bundler copies from the build
  machine (CI installs `libayatana-appindicator3-dev`; not yet checked on a
  built AppImage), and a StatusNotifier host
  on the session bus. KDE, Xfce, Cinnamon, MATE and Ubuntu's GNOME have one;
  plain GNOME (Fedora, Debian) needs the "AppIndicator and KStatusNotifierItem
  Support" extension. Without either, the app logs `[tray] no tray icon: …`
  and the close button **minimises** the window instead of hiding it (the
  notice then says so), so it can never become unreachable; quit from the
  header menu. Windows: the tray works natively.
- Checked under Xvfb (isolated HOME and session bus, a stand-in
  StatusNotifier host, the tray menu driven over D-Bus): close → hidden,
  relay still serving; Show → back with its scoresheet window; Quit →
  question; Keep running → still running; Quit OpenVolley → exited, ports
  free; second launch → the first shows its window; SIGTERM → clean exit;
  no StatusNotifier host → minimise fallback. Not yet on a real Windows
  desktop (type-checked with `cargo check --target x86_64-pc-windows-msvc`).

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
- The scoresheet windows belong to the scoretable: closing the main window
  hides them with it to the tray (and brings them back with it, see
  "Closing, the tray and quitting"). Should the main window be destroyed
  anyway (by the OS), they are closed and the app quits. (A scoresheet left
  open used to keep the process, the relay and ports 5173 / 8080 alive, and
  the next launch failed with "Cannot bind HTTP port", silently in a release
  build.)
- The match-end approval opens the scoresheet with `action=getBlob`. When the
  PDF cannot be made (see below), the scoresheet tells the opener
  (`pdfBlobFailed`) and closes; the approval goes on without the PDF at once
  instead of waiting 30 s. On a timeout the window is closed as well.
- Web links and `mailto:` go to the system browser / mail app (`xdg-open`,
  `open`, `rundll32 url.dll,FileProtocolHandler`), at most one per second;
  other schemes are refused.
- WebKitGTK only asks the handler about a `window.open` made during a click;
  the app's buttons first read IndexedDB, so scripts may open windows (the
  handler decides what opens). The price: a script in the app's pages could
  open windows without a click; the one-per-second limit on system links
  bounds what an injected script (e.g. via a team name) could do with that.
- Downloads ("Save PDF" is a blob download) go to the Downloads folder
  (`~/Downloads` when there is no `user-dirs.dirs`) under a free name; the
  page gets an `ov-download-finished` event (path, file name) and the
  scoresheet shows where its PDF went. WebKitGTK: one handler on the main
  window (the popups share its context, and it cannot tell which window
  downloaded), so every window hears every download and the scoresheet keeps
  only its own file. WebView2: one handler per window, only that window hears.

Known limits:

- **Save PDF on Linux (WebKitGTK)**: html-to-image copies every computed
  style property onto every cloned element and loads the result as a
  `data:image/svg+xml` URL. On WebKitGTK that URL was ~73-87 MB (WebKit also
  lists every Tailwind `--*` custom property), and WebKitGTK refuses data URLs
  above ~64 MB; a `blob:` URL loads but taints the canvas. On WebKitGTK the
  capture now copies only the properties the sheet actually uses (those that
  differ somewhere from the browser's defaults for the same element;
  `scoresheet_pdf/utils/pdfCapture.ts`), ~18 MB, and draws the logos and
  signatures onto the canvas itself, because WebKitGTK paints pictures nested
  in an SVG image only now and then. Checked under Xvfb: the lean capture
  matches the full one (within 1/255) outside the pictures. Other engines
  (WebView2, Android, browsers) keep the full copy and use the lean one only
  if it fails.
- **`alert()` / `confirm()` / `prompt()` in the desktop app**: `tauri-plugin-dialog`
  replaces both with IPC calls (`plugin:dialog|message` / `|confirm`) that no
  capability allows, so `alert()` shows nothing and `confirm()` returns a
  Promise, which is truthy. The app therefore never calls them: every question
  goes through `src/utils/askConfirm.js` (the in-app volleyui dialog, awaited),
  the same in the browser, the desktop app and Android. A vitest guard
  (`src/utils/__tests__/noNativeDialogs.test.jsx`) fails on any bare
  `confirm(` / `alert(` and on an `askConfirm()` that is not awaited.
  The same goes for `prompt()`: text is asked through `src/utils/askText.js`
  (the same dialog with a text field; Cancel returns null), and the guard
  catches `prompt(` too.
