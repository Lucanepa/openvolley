# Flatpak: OpenVolley eScoresheet and OpenBeach

Flatpak packages of the two desktop apps, for any Linux distribution with
Flatpak (Fedora, Arch, openSUSE, Mint, Ubuntu, ...). They repack the `.deb`
that GitHub Actions builds and releases (`.github/workflows/desktop.yml`), the
same way the AUR packages do: nothing is compiled here except the tray library.

| | OpenVolley eScoresheet | OpenBeach |
|---|---|---|
| App id | `com.openvolley.escoresheet` | `com.openvolley.beach` |
| Command | `openvolley-escoresheet` | `openbeach-escoresheet` |
| Release tag / asset | `desktop-vX` / `openvolley-escoresheet_X_amd64.deb` | `beach-desktop-vX` / `openbeach-escoresheet_X_amd64.deb` |
| Version here | 2.4.0 | 2.0.0 |

Install (self-hosted repo, once it is published):

```sh
flatpak install --user https://get.openvolley.app/flatpak/com.openvolley.escoresheet.flatpakref
flatpak install --user https://get.openvolley.app/flatpak/com.openvolley.beach.flatpakref
flatpak update   # updates come from here, never from the app
```

The runtime (GNOME 51) comes from Flathub; the `.flatpakref` names Flathub as
the runtime repo, so it is added if missing.

## Files

| File | What |
|---|---|
| `com.openvolley.escoresheet.json`, `com.openvolley.beach.json` | flatpak-builder manifests (JSON: the scripts edit them with the Python stdlib) |
| `*.metainfo.xml` | AppStream metadata: description, releases, screenshots, OARS rating, branding |
| `*.desktop` | desktop entries (`Icon=<app id>`, `StartupWMClass=<command>`) |
| `screenshots/` | the screenshots the metainfo links to (taken from the Flatpak under Xvfb) |
| `unstamp-bundle-type.py` | turns the in-app updater off in the repacked binary (below) |
| `shared-modules/` | Flathub's libayatana-appindicator module (tray icon), vendored from [flathub/shared-modules](https://github.com/flathub/shared-modules) at `cb9ec602` |
| `flatpak-meta.py` | edits a manifest's `.deb` source and adds a `<release>` to a metainfo |
| `bump.sh` | a new release into the manifest and metainfo (to commit) |
| `publish-flatpak.sh` | builds a release into the signed self-hosted repo (lenovoserver) |
| `test.sh` | builds, installs, starts and publishes both apps in a Docker container |

## The in-app updater is off

The app updates itself on Windows, from the AppImage and through APT. Inside a
Flatpak it must not: `flatpak update` does that. Two switches:

1. **`unstamp-bundle-type.py`** (every version, so also 2.3.0 and OpenBeach
   2.0.0). The Tauri bundler stamps `__TAURI_BUNDLE_TYPE_VAR_DEB` into the
   binary it packs into the `.deb`; the updater (`src-tauri/src/updater.rs`)
   reads it and would offer the APT repo. The build writes `UNK` back (only
   the stamp, not the `..._DEB` literal `bundle_type()` compares with; the
   script fails unless it finds exactly one stamp). The app then logs
   `[update] not an installed copy (no bundle type): no automatic updates`
   and Options shows "This build does not update itself".
2. **`updater.rs` `managed_by`** (from 2.4.0). The app itself sees `FLATPAK_ID`
   or `/.flatpak-info` (also `SNAP_NAME`, `OPENVOLLEY_PACKAGED=<name>` or a
   distro package's `/usr/lib/<command>/package-manager` marker) and never
   checks; Options says "Updates come from your package manager".

`test.sh` checks the stamp inside the sandbox and the log line at start.

## Sandbox permissions

| finish-arg | Why |
|---|---|
| `--share=network` | the LAN relay (HTTP + WebSocket, OpenVolley 5173/8080, OpenBeach 5174/8081) the tablets connect to, cloud sync, links |
| `--share=ipc`, `--socket=wayland`, `--socket=fallback-x11`, `--device=dri` | the window (WebKitGTK) |
| `--talk-name=org.kde.StatusNotifierWatcher` | the tray icon (libayatana-appindicator, built in the manifest) |
| `--system-talk-name=org.freedesktop.NetworkManager` | the tablet Wi-Fi (hotspot) and the Bluetooth network the app can start (`netshare/linux.rs`) |
| `--system-talk-name=org.bluez` | Bluetooth adapter state for the Bluetooth network |
| `--filesystem=xdg-download` | the scoresheet PDF and exports go to Downloads |

The single-instance D-Bus name (`<app id>.SingleInstance`) is under the app id,
which Flatpak allows without a permission. File pickers (restore a backup) use
`GtkFileChooserNative`, so the FileChooser portal: any file can be picked.

## What is different or does not work in the sandbox

- **Its own data.** `XDG_DATA_HOME` is `~/.var/app/<app id>/data`: the matches
  (WebKit storage) are in `~/.var/app/<app id>/data/<app id>/`, backups and logs
  in `~/.var/app/<app id>/data/OpenVolley/` (`OpenBeach/`), not in
  `~/.local/share/...` like the `.deb`/AppImage. A Flatpak does not see the
  matches of an APT install on the same computer: back them up in the old app
  and restore them in the Flatpak.
- **Tablet hotspot / Bluetooth network.** They talk to NetworkManager and BlueZ
  on the system bus (allowed above); polkit decides as for the `.deb`. Needs
  NetworkManager on the host. Not tested in the container (no NetworkManager
  there): test once on a real laptop before relying on it.
- **Host firewall.** As with the `.deb`, a host firewall (ufw, firewalld) must
  let the tablets reach the ports above; the app does not open them on Linux.
  (The Windows firewall rule is Windows only.)
- **Tray icon.** Needs a StatusNotifier host, as for the `.deb` (GNOME: the
  AppIndicator extension). Without one, closing the window minimises it.
- **"Open backup folder"** goes through the OpenURI portal (`xdg-open` in the
  runtime) and opens `~/.var/app/...` in the file manager. Not tested headless.
- **`--server-only`** (relay without a window): `flatpak run <app id> --server-only`.
  The arguments pass through; not tested headless.
- **No in-app updates** (by design, above), and no `apt-upgrade` helper or
  polkit policy (they stay out of the Flatpak).
- **x86_64 only**: the releases have no arm64 `.deb`.

## Self-hosted repository (get.openvolley.app/flatpak)

Signed OSTree repository next to the APT and F-Droid repos, built on
lenovoserver like them (the key never leaves it, CI never signs).

```
~/.config/openvolley-pkgs/
  flatpak-gpg/               GNUPGHOME with only the Flatpak repo key
  flatpak-gpg-passphrase     its passphrase (mode 600)
  public/flatpak/
    repo/                    OSTree repo (archive), branch "stable"
    openvolley.flatpakrepo   the repo + its public key
    <app id>.flatpakref      one per app (installs the app, adds the repo)
    openvolley-flatpak.gpg   the public key
```

### Once: the key

On lenovoserver (needs `apt install flatpak flatpak-builder ostree`):

```sh
escoresheet/packaging/flatpak/publish-flatpak.sh --init-key
```

It makes an ed25519 signing key "OpenVolley Flatpak repository
<support@openvolley.app>" with a random passphrase, and prints the `rbw add
"OpenVolley Flatpak repo key"` command that stores passphrase, fingerprint and
the armored secret key in Vaultwarden (rbw reads the entry from stdin in a
non-tty shell). Run that command right away. Restore: import the armored block
into `flatpak-gpg/` (`gpg --homedir ... --import`), put the passphrase back into
`flatpak-gpg-passphrase` (mode 600) and `gpg-agent.conf` (`allow-loopback-pinentry`,
`default-cache-ttl 900`). A new key means every user re-adds the repo: keep it.

### Each release

With the desktop release (the normal way):

```sh
escoresheet/deploy/publish-pkgs.sh --desktop 2.4.0 --flatpak [FILE.apk]
escoresheet/deploy/publish-pkgs.sh --desktop 2.0.1 --app beach --flatpak
```

`--flatpak` builds the signed, verified `.deb` into the Flatpak repo before the
sync (never with `--staging`: Flatpak users would get it at once). Without
`--flatpak` the Flatpak repo is left alone and still synced.

For a version already published (2.4.0 and OpenBeach 2.0.0 now):

```sh
escoresheet/packaging/flatpak/publish-flatpak.sh 2.4.0
escoresheet/packaging/flatpak/publish-flatpak.sh --app beach 2.0.0
escoresheet/deploy/publish-pkgs.sh          # rebuilds the indexes and syncs
```

`publish-flatpak.sh` takes the `.deb` from the APT pool (else GitHub), builds
with flatpak-builder (runtime and SDK from Flathub into the user installation,
cache in `~/.cache/openvolley-flatpak`), commits the app into `repo/` signed,
regenerates the signed summary with static deltas, keeps the last 5 commits per
app, writes the `.flatpakrepo`/`.flatpakref` files and checks the result like a
client (fresh Flatpak installation, the public key, the version in AppStream).
The landing page gets a Flatpak card per app once its `.flatpakref` exists.
Rollback for a user: `flatpak update --commit=<hash> <app id>`
(`flatpak remote-info --log openvolley app/<app id>/x86_64/stable` lists them).

Then commit the manifest and metainfo for the new version:

```sh
escoresheet/packaging/flatpak/bump.sh openvolley 2.4.0   # or: beach 2.0.1
```

(`publish-flatpak.sh` adds a missing `<release>` to its build copy and says so,
so the order does not matter, but the repo should carry it.)

The server needs nothing new: Caddy serves `/flatpak/` as static files
(`deploy/pkgs/Caddyfile`: `.flatpakref`/`.flatpakrepo` content types, OSTree
objects cached as immutable).

### Test

```sh
escoresheet/packaging/flatpak/test.sh            # both apps; or: openvolley | beach
```

Clean `debian:trixie` container (`--privileged` for bubblewrap): validates the
metainfo and desktop files, builds each manifest as committed, checks linking,
the tray library and the bundle stamp inside the sandbox, starts the app under
Xvfb (LAN page answers, updater log line), then runs `publish-flatpak.sh` with
a throwaway key and installs from the `.flatpakref` over HTTP. The runtimes
stay in the Docker volume `ov-flatpak-test-cache`. Last run 2026-10-07: all
checks passed for OpenVolley 2.3.0 and OpenBeach 2.0.0.

## Flathub

Not submitted. What it would take (checked 2026-10-07 against
[the Flathub requirements](https://docs.flathub.org/docs/for-app-authors/requirements)
and `flatpak-builder-lint`):

1. **Build from source.** "All source available submissions must be built
   entirely from source code" (exceptions only case by case). These manifests
   repack the `.deb`, which Flathub does not accept for an open-source app
   (`extra-data` is for non-redistributable binaries; as upstream we may
   redistribute anyway). A Flathub manifest needs: the git tag as source,
   `org.freedesktop.Sdk.Extension.rust-stable` and `node22`, offline sources
   generated with [flatpak-builder-tools](https://github.com/flatpak/flatpak-builder-tools)
   (`flatpak-cargo-generator.py Cargo.lock`, `flatpak-node-generator npm
   package-lock.json`), `npm run build` then `cargo build --release` with
   `OV_DIST`, and the same install steps. OpenBeach also needs the openbeach
   frontend repository as a second source (its `tauri.beach.conf.json` builds
   `../../../openbeach/escoresheet/frontend`). The updater switch is then
   `managed_by` (no `.deb` stamp to reset).
2. **App id.** Flathub checks that the id's domain belongs to the developer:
   `com.openvolley.*` means `openvolley.com`, which is not ours (a parked domain);
   the linter fails with `appid-url-not-reachable`. Use `app.openvolley.escoresheet`
   and `app.openvolley.beach` (verified through `openvolley.app`), with
   `--own-name=com.openvolley.escoresheet.SingleInstance` (resp. `.beach`) for
   the single-instance D-Bus name of the Tauri identifier. The self-hosted repo
   keeps `com.openvolley.*`, the Tauri identifier.
3. **Screenshots** must be reachable: the metainfo links to
   `raw.githubusercontent.com/.../main/escoresheet/packaging/flatpak/screenshots/`,
   which works once this is on `main` (the linter's only other errors were
   these). Flathub mirrors them itself.
4. **Permissions.** Expect reviewers to ask about the system-bus names; the
   reason is the tablet hotspot/Bluetooth network (table above).
5. **Runtime.** GNOME 51 (49 and 50 still on Flathub; all ship
   `webkit2gtk-4.1`). Move to each new GNOME runtime before the old one is EOL
   (Flathub refuses EOL runtimes): change `runtime-version` in both manifests
   and run `test.sh`.

Then: fork [flathub/flathub](https://github.com/flathub/flathub), add the
manifest on the `new-pr` branch, open the PR; after merging, Flathub hosts a
repo per app and its CI builds each version from a PR there.
