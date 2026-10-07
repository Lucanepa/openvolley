# Snap packages

Two snaps, one per desktop app, for the Snap Store:

| Snap | App | From the release | Identifier |
|---|---|---|---|
| `openvolley-escoresheet` | OpenVolley eScoresheet | `desktop-vX`, `openvolley-escoresheet_X_amd64.deb` | `com.openvolley.escoresheet` |
| `openbeach-escoresheet` | OpenBeach | `beach-desktop-vX`, `openbeach-escoresheet_X_amd64.deb` | `com.openvolley.beach` |

```
snap/
  bump.sh                               point a snap at a new release
  openvolley-escoresheet/snap/
    snapcraft.yaml
    gui/icon.png                        store icon (src-tauri/icons/icon.png)
    local/launch                        last command-chain step (data location)
  openbeach-escoresheet/snap/           the same for OpenBeach
```

Each snap **repackages the released .deb** (the `dump` plugin, `source-type: deb`).
Nothing is compiled: the snap runs the same binary as the APT repo, the
AppImage and the .deb on GitHub. The .deb is pinned by URL and sha256, so the
build fails if a release asset ever changes.

- base `core24`, `confinement: strict`, amd64 only (there is no arm64 .deb);
- the `gnome` extension provides GTK 3, WebKitGTK 4.1 and libsoup 3 (the
  `gnome-46-2404` runtime), plus the desktop plugs (desktop, desktop-legacy,
  gsettings, opengl, wayland, x11);
- `libayatana-appindicator3-1` is staged for the tray icon; a `cleanup` part
  removes whatever it dragged in that core24 or the gnome runtime already has;
- the .deb's APT update helper (`/usr/libexec/...`) and its polkit action are
  left out.

## The in-app updater is off

The Snap Store updates the snap. The app recognises the snap by `SNAP_NAME`
(set by snapd) and does not check, download or install updates (`Kind::Managed`
in `src-tauri/src/updater.rs`, commit "a Flatpak, Snap or distro-package copy
never updates itself"; the same switch serves Flatpak and the AUR). Options >
App version then says "Updates come from your package manager" and has no
check button.

**The first versions that have this switch are the first to publish:**
OpenVolley 2.4.0 and the OpenBeach release after 2.0.0. The yaml files point at
2.3.0 / 2.0.0 today only because those are released and build; a snap of them
would treat itself as a .deb installed by hand (it would offer "add the APT
repository" and check get.openvolley.app). Run `bump.sh` first.

snapd refreshes a snap only while it is not running (refresh-app-awareness), so
no update lands during a match. It postpones a refresh for at most 14 days
while the app keeps running; before a tournament weekend a scorer can hold
refreshes: `sudo snap refresh --hold=72h openvolley-escoresheet`.

## Interfaces (plugs)

| Plug | Auto-connected | What for | Without it |
|---|---|---|---|
| `network` | yes | the cloud sync and the live score upload | offline only |
| `network-bind` | yes | the tablets' relay: HTTP :5173 / WS :8080 (OpenBeach :5174 / :8081) | no tablets |
| `home` | yes (classic) | PDFs and exports to `~/Downloads`, imports | saving outside the snap fails |
| desktop, wayland, x11, opengl, gsettings | yes (gnome extension) | the window, the tray (StatusNotifier) | - |
| `network-observe` | **no** | listing the laptop's addresses (`local-ip-address`: a raw netlink route socket) for "Connect tablets" | the address list and QR code for the tablets are empty |
| `network-manager` | **no** | the tablets' Wi-Fi hotspot and Bluetooth network (NetworkManager over D-Bus) | "NetworkManager not available"; use the hall Wi-Fi |
| `bluez` | **no** | switching the Bluetooth adapter on and discoverable (BlueZ D-Bus) | no Bluetooth network |
| `removable-media` | **no** | exports to a USB stick (`/media`, `/mnt`) | the stick is not visible in file dialogs |

Slot: `single-instance` (`dbus`, session bus, `com.openvolley.escoresheet.SingleInstance`
/ `com.openvolley.beach.SingleInstance`): tauri-plugin-single-instance owns that
name, so a second launch brings the running window forward instead of failing
to bind the relay's ports.

Until the store grants auto-connection, a user connects them once:

```bash
sudo snap connect openvolley-escoresheet:network-observe
sudo snap connect openvolley-escoresheet:network-manager
sudo snap connect openvolley-escoresheet:bluez
sudo snap connect openvolley-escoresheet:removable-media   # optional
```

`network-manager` and `bluez` have an implicit slot on classic distributions
(snapd provides it, it talks to the host's NetworkManager and BlueZ). The
hotspot asks NetworkManager's polkit exactly as the .deb does
(`wifi.share.protected`, `settings.modify.own`: no password for the active
local session).

## What does not work, or works differently, in the snap

- **Hotspot / Bluetooth / tablet addresses** need the manual connections above
  until the store grants auto-connect.
- **Data location.** All app data (the matches and teams in WebKit storage,
  the automatic backups, the activity log) lives in
  `~/snap/<snap>/common/.local/share/` (`snap/local/launch` moves
  XDG_DATA_HOME out of the versioned `$SNAP_USER_DATA`, so a `snap revert` or
  an automatic rollback never takes matches back). Backups:
  `~/snap/openvolley-escoresheet/common/.local/share/OpenVolley/backups`.
  Data of a .deb / AppImage install (`~/.local/share/com.openvolley.escoresheet`)
  is **not** picked up; to move it, quit both and copy it:
  `cp -a ~/.local/share/com.openvolley.escoresheet ~/.local/share/OpenVolley ~/snap/openvolley-escoresheet/common/.local/share/`.
- **Opening files and folders** ("Open" on a saved PDF, "Show in folder",
  "Open backup folder"): the app runs `xdg-open`, which inside a snap goes
  through snapd / the desktop portal. Web links and mail work; local files
  may ask for confirmation, and a folder in the snap's private data
  (the backup folder) may not open at all. Not tested on a desktop yet.
- **The in-app updater** is off (above); "Check for updates" is not shown.
  The update notices of the scoretable never appear either.
- **.deb and snap side by side**: both use the same ports, only one can run.
- **GPU / blank window**: WebKitGTK comes from the gnome runtime, not the
  host. If the window stays white (some NVIDIA setups), start it with
  `WEBKIT_DISABLE_DMABUF_RENDERER=1 openvolley-escoresheet`.
- No arm64 snap (no arm64 .deb is built).
- Windows-only parts (the firewall rule, Mobile Hotspot) do not apply.

## Building

`snapcraft` needs snapd. On Ubuntu with snapd:

```bash
sudo snap install snapcraft --classic
cd escoresheet/packaging/snap/openvolley-escoresheet
snapcraft pack                      # builds in an LXD container (snapcraft sets it up)
snapcraft pack --destructive-mode   # or directly on an Ubuntu 24.04 host / VM
```

Without LXD or an Ubuntu host (how it was tested here, on Debian 13), a
privileged Ubuntu 24.04 container running systemd + snapd works:

```bash
cat > Dockerfile <<'EOF'
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive container=docker
RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv \
      snapd squashfuse fuse3 sudo ca-certificates dbus curl
RUN echo 'Acquire::ForceIPv4 "true";' > /etc/apt/apt.conf.d/99force-ipv4
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
EOF
docker build -t ov-snapd .
docker run -d --name ov-snap --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
  -v "$PWD/escoresheet/packaging/snap:/src:ro" ov-snapd
docker exec ov-snap bash -c '
  mount -t securityfs securityfs /sys/kernel/security; systemctl restart snapd
  snap wait system seed.loaded && snap install snapcraft --classic
  cp -r /src/openvolley-escoresheet /build && cd /build && apt-get update
  /snap/bin/snapcraft pack --destructive-mode'
docker cp ov-snap:/build/openvolley-escoresheet_2.3.0_amd64.snap .
docker rm -f ov-snap
```

(securityfs: snapd's hooks need AppArmor visible; ForceIPv4: a container
without an IPv6 route otherwise hangs on archive.ubuntu.com.)

Try it on an Ubuntu desktop:

```bash
sudo snap install --dangerous ./openvolley-escoresheet_2.3.0_amd64.snap
sudo snap connect openvolley-escoresheet:network-observe   # and the others above
snap run openvolley-escoresheet
```

## A new release

```bash
cd escoresheet/packaging/snap
./bump.sh openvolley 2.4.0       # or: ./bump.sh openbeach 2.0.1
```

It downloads the .deb and its `.sig` from the GitHub release, checks the
minisign signature against the updater key in `tauri.conf.json` /
`tauri.beach.conf.json` (when `minisign` is installed; it warns otherwise) and
the version in the package, then writes `version`, the URL and the sha256 into
the snapcraft.yaml. Commit, build, upload.

## Owner steps (store; nothing of this is done)

1. `snapcraft login` (Ubuntu One account; the developer account is created on
   first login at snapcraft.io).
2. Register the names: `snapcraft register openvolley-escoresheet` and
   `snapcraft register openbeach-escoresheet`.
3. Bump to the first versions with the updater switch (OpenVolley 2.4.0, the
   next OpenBeach), build both, then upload, first to a test channel:
   `snapcraft upload --release=edge openvolley-escoresheet_2.4.0_amd64.snap`.
   Install from edge on a real Ubuntu laptop, connect the plugs, test a hotspot
   and a tablet, then `snapcraft release openvolley-escoresheet <rev> stable`.
4. Expect a manual review on the first upload: the `dbus` slot
   (`single-instance`) and the super-privileged plugs. If the slot holds up
   the review, it can be dropped (a second launch then shows "port in use"
   instead of raising the window).
5. Ask for auto-connection of `network-manager`, `bluez` and `network-observe`
   for both snaps: a post in the **store-requests** category of
   forum.snapcraft.io, explaining that the app creates a temporary Wi-Fi
   hotspot / Bluetooth PAN for the scoring tablets (volatile NetworkManager
   profiles bound to the app's D-Bus connection) and lists the interfaces'
   addresses for the tablets. Until granted, users run the `snap connect`
   lines (the store description says so).
6. Store listing: the icon from `snap/gui/icon.png`, screenshots, category
   (Utilities / Sports), license. The yaml says `GPL-3.0-only`; change it if
   the project is "GPL-3.0-or-later".
7. Optional: build in CI later (`snapcore/action-build` +
   `snapcore/action-publish` with a `SNAPCRAFT_STORE_CREDENTIALS` secret from
   `snapcraft export-login`). That puts a store credential in GitHub, which
   the current release process deliberately avoids for signing keys; building
   and uploading from lenovoserver keeps it that way.
