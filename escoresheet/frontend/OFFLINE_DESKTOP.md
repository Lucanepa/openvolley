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

### OpenBeach: the same shell as a second app

The Tauri shell also builds **OpenBeach**, the beach volleyball eScoresheet
(Lucanepa/openbeach), as its own app: a flavour, not a copy
(`src-tauri/src/flavour.rs`). Everything below the UI is shared (relay, backups,
tablet networks, tray, updater, installer hooks); only the names differ:

| | OpenVolley eScoresheet | OpenBeach |
|---|---|---|
| identifier | `com.openvolley.escoresheet` | `com.openvolley.beach` |
| window title / Windows productName | OpenVolley eScoresheet / Openvolley eScoresheet | OpenBeach |
| `.deb` package, command | `openvolley-escoresheet` | `openbeach-escoresheet` |
| relay ports (HTTP / WebSocket) | 5173 / 8080 | 5174 / 8081 |
| frontend | `../dist` (this app) | `openbeach/escoresheet/frontend/dist` |
| firewall rule | OpenVolley eScoresheet (tablets on the local network) | OpenBeach (tablets on the local network) |
| backups, tablet Wi-Fi name | `OpenVolley/backups`, `OpenVolley-XXXX` | `OpenBeach/backups`, `OpenBeach-XXXX` |
| updates | `get.openvolley.app/desktop/latest.json`, then GitHub "Latest" | `get.openvolley.app/desktop/beach/latest.json`, then the `beach-desktop-latest` prerelease |
| release tags | `desktop-v*` | `beach-desktop-v*` |

So both apps install and run side by side on one laptop. The openbeach checkout
lives at the repo root as `openbeach/` (git-ignored; CI checks it out there, locally
clone it or symlink it):

```bash
git clone https://github.com/Lucanepa/openbeach openbeach      # or: ln -s ~/repos/openbeach openbeach
(cd openbeach/escoresheet/frontend && npm ci)
cd escoresheet/frontend
npx tauri build --config src-tauri/tauri.beach.conf.json --config src-tauri/tauri.beach.linux.conf.json   # Linux
npx tauri build --config src-tauri/tauri.beach.conf.json                                                  # Windows
```

`tauri.beach.conf.json` (identifier, names, icons from openbeach's
`public_beach/openbeach_no_bg.png` in `src-tauri/icons/beach/`, version from
openbeach's `package.json`, updater endpoints) and `tauri.beach.linux.conf.json`
(package name, desktop entry `openbeach-escoresheet.desktop`, its own update helper
and polkit action in `src-tauri/linux/beach/`, none of OpenVolley's package
relations) are merged over OpenVolley's configs. `build.rs` reads the merged
identifier and compiles the beach names in; the relay embeds the frontend from
`OV_DIST` (default: the config's `frontendDist`). Without the Tauri CLI:
`OV_FLAVOUR=beach cargo test` (build.rs merges the beach configs itself).
`src/__tests__/desktopFlavours.test.js` and the Rust tests in `flavour.rs` pin
OpenVolley's identity and check OpenBeach shares none of it. Point openbeach's
own build at other paths with `--config '{"build":{"frontendDist":"…"}}'` (and
`OV_DIST`). The shell's close-to-tray, quit and update logic waits for the
page: until openbeach's scoretable page reports itself (`app_page_state`, as
OpenVolley's does, see "Closing, the tray and quitting"), closing the window asks
natively "Quit OpenBeach?" and the updater never starts checking.

### Windows install (per machine, firewall rule)

The NSIS installer installs **for all users** (`bundle.windows.nsis.installMode`
`perMachine`, owner's decision): `C:\Program Files\Openvolley eScoresheet`,
Start menu and desktop shortcuts for everyone, uninstall entry under HKLM, and
**one administrator prompt** (UAC) at install. A standard user needs an
administrator's password once; running the app never does. Each Windows user
keeps their own data: matches in `%LOCALAPPDATA%\com.openvolley.escoresheet`
(WebView2 IndexedDB), backups in `%APPDATA%\OpenVolley\backups`.

The installer hooks (`src-tauri/windows/installer-hooks.nsh`, `installerHooks`):

- **Firewall** (after the files are in place): one Windows Defender Firewall
  inbound rule, **OpenVolley eScoresheet (tablets on the local network)**:
  allow, program `<install dir>\openvolley-escoresheet.exe`, TCP, profiles
  **private and public** (the laptop's own Wi-Fi and a newly joined hall Wi-Fi
  are usually Public), remote address **LocalSubnet** (the tablets' network
  only, never the internet), no port filter (the app listens on 5173 / 8080, or
  the `OPENVOLLEY_*_PORT` ones). `netsh advfirewall` (64-bit, via `Sysnative`),
  delete-then-add, so a reinstall never makes a second one. Domain networks are
  not covered (Defender asks there; Cancel at that prompt, or a standard user
  who cannot elevate, makes inbound **Block** rules for the Program Files exe,
  and Block beats Allow on every network: the app's check below catches
  that). If netsh fails the install goes on and
  Defender asks at the first start, as before. Removed after an uninstall.
- **Upgrade from a per-user install** (2.0.x / 2.1.0 installed into
  `%LOCALAPPDATA%\Openvolley eScoresheet`, HKCU): Tauri's own "already
  installed" page only reads HKLM in per-machine mode, so on its own the
  installer would leave two installs and two Start menu entries. Before copying,
  the hook finds the installing user's old uninstaller (HKCU uninstall entry);
  if the app runs (for any Windows user) it asks once, closes it for **all**
  users (as Tauri's own per-machine check right after the hook would; Cancel or
  a failure to close stops the install before anything is removed), and runs
  the old uninstaller silently in place
  (`uninstall.exe /S _?=<dir>`). Silent never ticks **Delete the application
  data**, so matches and settings stay; no uninstaller ever touches the backups
  folder. Then it deletes the leftover `uninstall.exe` and folder and the
  Defender rules Windows made for the old exe path. A failure is logged and the
  install goes on (the old copy can be removed in Settings › Apps; its data
  stays either way). Known limit: when a **standard user** installs with an
  administrator's password, the installer runs as that administrator and sees
  the administrator's HKCU, not the standard user's: the standard user's old
  per-user copy stays (two Start menu entries) until it is uninstalled in
  Settings › Apps. Matches are not lost: both copies use the same data folder.
- The app checks the rule itself (`firewall_status`, `src-tauri/src/firewall.rs`,
  read through the firewall's COM API, main window only): Connect tablets shows
  the manual "tick Public" step only while the rule is missing (a dev build, a
  copy run from elsewhere, a rule removed by IT or group policy) or an enabled
  inbound Block rule for this exe (TCP or any protocol, private or public)
  overrides it (`blocked-by-rule`; ticking Public in "Allow an app through
  firewall" turns Defender's Block rule into an Allow one). Not while the check
  is still running, so the step never flashes up. Not covered: "Block all
  incoming connections" in a profile's settings, and Block rules for all
  programs or for ports only.

Checked on Linux only: the config against the Tauri schema, and the real Tauri
NSIS template with these hooks compiled by `makensis` 3.11 (`npx tauri bundle
--bundles nsis --target x86_64-pc-windows-msvc` with a placeholder exe and
`makensis` from a container). The installer itself must be run on Windows (see
**Must be tested on real hardware**).

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
  does not confuse them). **Firewall**: the installer adds an inbound rule for
  the tablets (private + public networks, local subnet only; see **Windows
  install** above), so tablets get their page without any prompt. Without that
  rule (dev build, a copy run from elsewhere, rule removed) the first run asks
  Windows Defender Firewall for access — tick **Public** too (the hotspot
  network is usually Public), or tablets join the Wi-Fi and get no page; the
  dialog then shows this step on Windows, on both Wi-Fi tabs (Windows Security ›
  Firewall & network protection › Allow an app through firewall › OpenVolley ›
  Public), and hides it once `firewall_status` finds the installer's rule.
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
- Windows installer (per machine, firewall rule; Windows 10 22H2 and 11):
  fresh install as an administrator and as a standard user (one UAC prompt,
  installs into Program Files, shortcuts for all users); `wf.msc` shows
  **OpenVolley eScoresheet (tablets on the local network)**: inbound, allow,
  the exe in Program Files, TCP, Private + Public, remote LocalSubnet; first
  start shows **no** Defender prompt; a tablet on the laptop's Mobile Hotspot
  (Public) and on a hall Wi-Fi set to Public gets the page; Connect tablets
  shows no "tick Public" step. Reinstall the same version and install a newer
  one: still exactly one rule (`netsh advfirewall firewall show rule
  name="OpenVolley eScoresheet (tablets on the local network)"`). Uninstall:
  the rule is gone; cancel the "app is running" question during uninstall:
  the rule stays. Upgrade **from 2.1.0 per-user** (with matches, a backup and
  a ticked-Public Defender rule): the old app running → the close question
  appears once (Cancel: the old app still installed and working, nothing
  changed); afterwards one entry in Settings › Apps, one Start menu
  entry, no `%LOCALAPPDATA%\Openvolley eScoresheet` folder, the old Defender
  rules for that path gone, and the matches, settings, remembered tablet Wi-Fi
  and `%APPDATA%\OpenVolley\backups` all still there in the new app. The
  same upgrade by a standard user with an administrator's password (expected:
  the old copy stays, data intact). The app open in a **second user session**
  (fast user switching) during that upgrade: one question, OK closes both
  users' copies and the upgrade completes; Cancel leaves the old install in
  place. Defender Block rule: on a domain network (or with the rule deleted)
  cancel Defender's first-start prompt, then on the hotspot the dialog shows
  the step (`firewall_status` reason `blocked-by-rule`); tick Public: it goes.
  Silent install `/S` from an elevated
  prompt over 2.1.0. Delete the rule by hand, start the app: the dialog shows
  the step again. Group policy that ignores local rules (domain laptop): note
  what happens.
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
  stopped on `RunEvent::Exit`, the relay goes with the process). A quit
  request while the first-close notice is open replaces the notice.
- **When the page cannot ask**, the app asks itself: a native "Quit
  OpenVolley?" (tauri-plugin-dialog, Quit OpenVolley / Keep running, in the
  last language the page reported). That is the case when the page's
  handler is gone (it crashed into its error screen and said so,
  `app_page_gone`), the page is still loading, or it did not take the tray's
  request within 2.5 s (`app_quit_ack`; e.g. a hung web process, where
  sending the event still "succeeds"). A second tray Quit while a request is
  unanswered asks natively at once. So the app can always be quit, and never
  without a confirmation.
- **Exit rules** (`ExitGate`, unit-tested): a close hides; an exit nobody
  confirmed (`RunEvent::ExitRequested` while the scoretable window exists) is
  prevented and turned into the question; a confirmed quit exits; the OS is
  never held up: Linux `SIGTERM` (logout, shutdown, `kill`), `SIGINT`,
  `SIGHUP` quit at once (a second signal, or 10 s without an exit, ends the
  process), Windows ends the event loop itself on `WM_ENDSESSION`. A window
  with no page that answers gets the native question (above).
- **Windows installer / uninstaller** (`src-tauri/windows/installer-hooks.nsh`,
  `bundle.windows.nsis.installerHooks`): Tauri's own check would end a
  running app (usually in the tray) with `TerminateProcess`, skipping the
  exit, so the tablets' Mobile Hotspot stayed on (after an uninstall for
  good). Before that check the hooks ask "OpenVolley is running. Quit it
  now?" (English, like the installer; silent / passive updates do not ask;
  Cancel stops the installer) and run `openvolley-escoresheet.exe --quit`:
  the running app gets it through the single-instance plugin and quits
  cleanly (network stopped, the user's hotspot settings back); with no app
  running, `--quit` only undoes a hotspot a crashed run left on (the
  `tablet-wifi-on` marker) and exits. They wait up to 15 s; an app still
  running then gets Tauri's own "click OK to kill it". Not yet run on
  Windows (no NSIS here).
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
  no StatusNotifier host → minimise fallback; `--quit` → the running app
  exits cleanly, with none running it exits at once; tray Quit with the
  page's handler gone → native question. Not yet on a real Windows
  desktop (type-checked with `cargo check --target x86_64-pc-windows-msvc`).

## Automatic updates (from 2.2.0)

The app updates itself, never during a match (`src-tauri/src/updater.rs`,
page side `src/hooks/useDesktopUpdate.js`, `src/components/DesktopUpdateNotice.jsx`,
Options > App version). 2.1.x and older have no updater: install 2.2.0 once by
hand (APT: `sudo apt upgrade`).

- **When it checks:** a minute after the scoretable page first loaded, every
  6 hours, at a sign-in (at most every 15 minutes) and on "Check for updates".
  Never at startup, never during a live match, and automatic checks and
  downloads wait 5 minutes after a match. It reads
  `https://get.openvolley.app/desktop/latest.json`, then
  `https://github.com/Lucanepa/openvolley/releases/latest/download/latest.json`.
  `OPENVOLLEY_UPDATE_CHANNEL=staging` reads `desktop/staging.json` (canary).
- **Windows (NSIS) and the AppImage:** the file downloads in the background
  (stopped when a match starts) and is verified with the updater key
  (`plugins.updater.pubkey` in tauri.conf.json, minisign; `requireSignedVersion`:
  the signature must name the announced version, `tauri signer sign
  --app-version`, CLI 2.12+). It installs when the scorer **quits** OpenVolley
  (confirmed quit, no live match; Windows: one administrator prompt, the
  installer runs passive and does not relaunch the app; a declined prompt is
  not asked again on quit for that version for 3 days), or at once with
  **Restart and update** (home screen notice, Options, tray item "Restart to
  update to {v}").
- **Linux .deb from the APT repo** (`/etc/apt/sources.list.d/openvolley.list`,
  written by install.sh): no download by the app. While no match is live the
  app runs `pkexec /usr/libexec/openvolley-escoresheet/apt-upgrade` (shipped in
  the .deb, `src-tauri/linux/`; polkit action
  `com.openvolley.escoresheet.update`, `allow_active=yes`: no password for the
  local active session). The helper takes no input and upgrades only this
  package from this repo. The running app keeps its old binary and says
  "Restart to finish the update to {v}"; it notices an `apt upgrade` or
  unattended-upgrades the same way (`/proc/self/exe` ends in " (deleted)").
  Without pkexec (or refused) Options shows `sudo apt update && sudo apt upgrade`.
  A .deb installed by hand (no repo) shows the install.sh command once.
- **The gate**, in Rust, checked before every download / install / restart:
  download only with no live match; **restart** only with no live match, no
  tablet connected, no tablet Wi-Fi / Bluetooth of the app running and the
  page loaded (otherwise the notice and Options say why, and the app refuses
  `update_install_now` whatever the page asks); install on a confirmed quit
  only with no live match. The OS ending the app (logout, shutdown, SIGTERM)
  never installs. "Restart and update" checks the restart gate twice: before
  the install and again right before the restart, since the install can take
  minutes (the APT helper waits for the dpkg lock and downloads). If a
  match started or a tablet connected in the meantime, the update stays
  installed and the app does not restart. It shows "Restart to finish" and
  offers the restart again once the gate opens.
- **Windows administrator prompt cancelled** ("Restart and update"): the app
  keeps running with its window and tray icon. The plugin's before-exit hook
  only stops the tablet network and hides the tray icon before the prompt;
  the icon comes back if the installer does not start. The plugin's default,
  `cleanup_before_exit`, would drop the tray and hide every window for good.
- **The page** gets the status from `update_status` and the `ov-update`
  window event (numbered: an older answer never replaces a newer event). The
  notice is a small card on the home screen only, hidden during a live match,
  quiet while checking or downloading; Later hides it for that version until
  the next start. Options > App version: status, Check for updates, Restart
  and update (or why it waits), "Check for updates automatically", "Install
  updates automatically" (`<config dir>/update.json`), What's new. The
  updater plugin's own JS commands are granted to no window
  (`capabilities/update.json` has the app's four commands only).
- **Checked** under Xvfb with the debug AppImages 2.1.1 → 2.2.0 from a local
  server, signed with a throwaway key (the debug-only
  `OPENVOLLEY_UPDATE_TEST_ENDPOINT` / `_PUBKEY` / `_FIRST_DELAY` / `_TICK` /
  `_KIND` / `_EXE` overrides; a release build has none): found and downloaded
  in the background; a live test match hides the notice, the app refuses the
  restart (matchLive) and the tray offers none; after the match "Restart and
  update" replaced the AppImage and restarted into 2.2.0 (single-instance
  active, not handed back to the old process); SIGTERM did not install; a
  confirmed quit installed. Not yet on Windows (UAC, passive installer,
  relaunch) nor a real APT upgrade through polkit (`cargo check --target
  x86_64-pc-windows-msvc`; the .deb's helper and policy checked with
  shellcheck, the XML and `dpkg-deb -c`).

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
