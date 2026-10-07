# AUR packages (Arch Linux, Manjaro, EndeavourOS, ...)

Two packages for the Arch User Repository, both built from the `.deb` that
GitHub Actions releases (`.github/workflows/desktop.yml`):

| AUR package | App | Release tag | Ports (HTTP / WebSocket) |
|---|---|---|---|
| `openvolley-escoresheet-bin` | OpenVolley eScoresheet | `desktop-vX.Y.Z` | 5173 / 8080 |
| `openbeach-escoresheet-bin` | OpenBeach | `beach-desktop-vX.Y.Z` | 5174 / 8081 |

`-bin` is the AUR name for a package that installs a prebuilt binary rather
than compiling. The two can be installed side by side.

Users install with any AUR helper, or by hand:

```bash
yay -S openvolley-escoresheet-bin          # or: paru -S ...
# by hand
git clone https://aur.archlinux.org/openvolley-escoresheet-bin.git
cd openvolley-escoresheet-bin && makepkg -si
```

Updates arrive with `yay -Syu` / `paru -Syu` (or `git pull && makepkg -si`).

## Files

| File | What |
|---|---|
| `<pkg>/PKGBUILD` | the package: downloads the release `.deb` and the LICENSE at the same tag |
| `<pkg>/.SRCINFO` | generated from the PKGBUILD (`makepkg --printsrcinfo`); the AUR reads it |
| `bump.sh` | points a package at a new release: pkgver, pkgrel, sha256sums, .SRCINFO |
| `test.sh` | builds, installs and checks a package in a clean `archlinux` container |
| `publish.sh` | owner-run: pushes PKGBUILD + .SRCINFO to aur.archlinux.org |

## What the package contains

From the `.deb`: `/usr/bin/<pkg>`, the desktop file and the 32, 128 and 256 px
icons (the bundler's `256x256@2` folder is installed as `256x256`). Added:
`/usr/share/licenses/<pkgname>/LICENSE` (GPL-3.0-or-later) and the updater
marker `/usr/lib/<pkg>/package-manager` (below).

Left out: `/usr/libexec/<pkg>/apt-upgrade` and its polkit action, the APT
updater's root helper. pacman updates the package.

Dependencies: `webkit2gtk-4.1`, `gtk3`, `libsoup3`, `glib2`, `cairo`,
`gdk-pixbuf2`, `dbus`, `libgcc`, `glibc`, `hicolor-icon-theme`, and
`libayatana-appindicator` for the tray icon. The tray library is loaded at run
time (`libloading`), so `namcap` reports it as "may not be needed": it is
needed: without it the app has no tray icon, and closing the window only
minimises it (the app logs `[tray] no tray icon ...`).

Optional: `networkmanager` (the tablet Wi-Fi hotspot and the Bluetooth
network the app starts over D-Bus), `bluez` (Bluetooth network), `dnsmasq`
(NetworkManager's shared mode hands out the tablets' addresses with it),
`xdg-utils` (opening links, the PDF and the backup folder).

## The in-app updater is off

The app updates itself on Windows and the AppImage, and through APT for the
`.deb` (`src-tauri/src/updater.rs`). Under pacman it must not, so the package
does two things:

1. **The marker file** `/usr/lib/<pkg>/package-manager` (one line: `aur`).
   The updater's `managed_by()` looks for `<prefix>/lib/<command>/package-manager`
   next to `<prefix>/bin/<command>`; a release that has it (`Kind::Managed`,
   commit e323002f, in OpenVolley 2.4.1 and OpenBeach 2.0.1 on) never checks,
   downloads or runs the APT helper, logs
   `[update] installed by aur: it updates the app`, and Options > App version
   says "Updates come from your package manager".
2. **The bundle-type stamp**, for releases before that (2.3.0, 2.4.0, OpenBeach
   2.0.0). The Tauri bundler writes the bundle type into the binary
   (`__TAURI_BUNDLE_TYPE_VAR_DEB` in the `.deb`). Left as it is, an Arch
   install would count as "a .deb without the APT repo" and tell the scorer
   to run the APT `install.sh`. `prepare()` sets it back to
   `__TAURI_BUNDLE_TYPE_VAR_UNK`, what the compiler wrote before the bundler
   patched it (same length). `bundle_type()` then returns nothing, the
   updater is `Kind::Unsupported`: it never checks, Options > App version
   says "This build does not update itself", and the log says
   `[update] not an installed copy (no bundle type): no automatic updates`.

   The binary also holds `__TAURI_BUNDLE_TYPE_VAR_DEB` as the value
   `bundle_type()` compares against (a table of DEB, RPM, APP, MSI, NSS).
   The patch skips that one (it is directly followed by `...RPM`) and fails
   the build unless it finds exactly one other occurrence, so a different
   compiler layout breaks the build instead of shipping a binary that
   updates itself. Once every packaged release knows the marker, this step
   can go; until then it costs nothing (the marker wins when both apply).

After a `pacman -Syu` while the app runs, the running copy keeps the old
version until it is restarted (the "Restart to finish" prompt is for APT
installs only).

## Not sandboxed: what works

An AUR package is a normal system package, so everything the `.deb` does
works the same:

- the LAN server (scoretable page and WebSocket on the ports above, on all
  interfaces). With `ufw` or `firewalld` on, open them for the tablets, e.g.
  `sudo ufw allow 5173,8080/tcp` (OpenBeach: `5174,8081/tcp`);
- the tablet Wi-Fi hotspot and the Bluetooth network through NetworkManager
  and BlueZ over D-Bus, when `networkmanager` (+ `dnsmasq`, `bluez`) is
  installed and running. NetworkManager's own polkit rules apply: a local
  active session may create shared connections. The Wi-Fi card must support
  AP mode. On a system without NetworkManager (systemd-networkd, iwd alone,
  connman) the app says the tablet network is not available; the hall Wi-Fi
  or Ethernet works;
- the tray icon (with `libayatana-appindicator`; GNOME needs the
  AppIndicator extension, as on any distribution);
- data, backups and logs in the same places as the `.deb`
  (`~/.local/share/...`, `~/.config/com.openvolley.escoresheet` /
  `com.openvolley.beach`).

The Windows firewall rule does not exist on Linux.

## Checks run (Docker, `archlinux:latest`, 2026-10-07)

`./test.sh openvolley` and `./test.sh openbeach` both pass:

- `namcap PKGBUILD`: clean;
- `makepkg -si` as a non-root `builder` user: builds and installs;
- `namcap` on the package: one warning, `libayatana-appindicator` "may not be
  needed" (run-time `dlopen`, see above);
- `ldd /usr/bin/<pkg>`: no missing library;
  `/usr/lib/libayatana-appindicator3.so.1` present;
- `desktop-file-validate`: valid (one hint: `Sports` could be paired with
  `Education`/`Science`; the categories are `Utility;Sports;`);
- the binary's stamp reads `UNK`, the marker file says `aur`;
- started under Xvfb + a D-Bus session: keeps running, the LAN page answers
  200 on 5173 (OpenBeach: 5174), WebSocket on 8080 (8081), the log says no
  automatic updates, no panic. `test.sh` fails if the log has the updater's
  `checking after the page loaded` line. Control: the unpatched 2.3.0 binary
  from the `.deb`, run the same way, logs
  `[update] 2.3.0 DebNoRepo: checking after the page loaded, then every 6 h`.

Not tested: a real desktop session (tray, hotspot, Bluetooth), which takes
the same code paths as the `.deb`; and the marker path with a real binary
(no release has `Kind::Managed` yet; run `test.sh` again after the first
release that has it).

## A new release

After the GitHub release is published (the `.deb` must be downloadable):

```bash
cd escoresheet/packaging/aur
./bump.sh openvolley 2.4.0        # or: ./bump.sh openbeach 2.1.0
./test.sh openvolley              # optional, ~2 min, needs Docker
git add openvolley-escoresheet-bin && git commit -m "chore(aur): openvolley-escoresheet-bin 2.4.0"
./publish.sh openvolley           # owner, with the AUR SSH key
```

`bump.sh` sets `pkgver`, resets `pkgrel` to 1 (third argument to set it, for
a packaging-only fix of the same release), downloads the `.deb` and the
LICENSE at that tag, writes both `sha256sums`, and regenerates `.SRCINFO`
(the local `makepkg` on Arch, else in an `archlinux` container as `nobody`).

Only `PKGBUILD` and `.SRCINFO` go to the AUR; the scripts stay here.

`bump.sh` can run in CI (it needs no key), for example a job after the
desktop release that opens a PR with the bump. `publish.sh` needs the AUR SSH
key, and keys stay on lenovoserver, so it runs there (like
`deploy/publish-pkgs.sh`).

## One-time setup (owner)

1. Create an account at <https://aur.archlinux.org/register> (user name,
   e-mail).
2. Make a key for the AUR only and add the public half under My Account >
   SSH Public Key:

   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/aur -C "aur openvolley"
   cat ~/.ssh/aur.pub
   ```

3. `~/.ssh/config` on lenovoserver:

   ```
   Host aur.archlinux.org
     IdentityFile ~/.ssh/aur
     User aur
   ```

4. Check it: `ssh aur@aur.archlinux.org help` lists the AUR commands.
5. Put your e-mail in the `# Maintainer:` line of both PKGBUILDs (AUR
   convention, e.g. `Luca Canepa <name at example dot com>`) and commit. It
   is a comment, so `.SRCINFO` does not change.
   `publish.sh` commits in a fresh clone with your git `user.name` /
   `user.email`; the AUR shows them in the package's git log.
6. First publish: `./publish.sh openvolley` and `./publish.sh openbeach`. A
   push to a name nobody owns creates the package, owned by you.

Optional on the AUR web page: add a co-maintainer, and keep the package's
comments on (users report problems there).

## Rules worth knowing

- The AUR rejects a push whose commits lack a valid `.SRCINFO`, but it
  cannot run the PKGBUILD, so it accepts a stale one. The web page and the
  AUR helpers (yay, paru) read only `.SRCINFO`: a stale one shows the old
  version and makes helpers miss the update. `publish.sh` checks that it
  matches the PKGBUILD before pushing.
- Only the `master` branch counts, and the AUR keeps every pushed commit
  (no force-push): bump `pkgrel` for a packaging fix, never rewrite history.
- A package that is "out of date" for weeks can be orphaned on request: bump
  with every desktop release.
- Never change a `.deb` behind a released tag: the checksum would no longer
  match and every install fails (`makepkg` "FAILED" on validity). Release a
  new version instead, or `bump.sh <app> <ver> 2` if the file really changed.
