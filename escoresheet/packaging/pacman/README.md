# pacman repository (Arch Linux, Manjaro, EndeavourOS)

Our own signed pacman repository at `https://get.openvolley.app/arch/`, so
Arch users install and update OpenVolley eScoresheet and OpenBeach with plain
`pacman`, no AUR helper and no AUR account needed. The packages are the AUR
ones (`../aur/<package>-bin/PKGBUILD`: the released `.deb`, repackaged, with
the updater marker), built here and signed with our own key.

| Package | App | Release tag |
|---|---|---|
| `openvolley-escoresheet-bin` | OpenVolley eScoresheet | `desktop-vX.Y.Z` |
| `openbeach-escoresheet-bin` | OpenBeach | `beach-desktop-vX.Y.Z` |

## What users do (the install page's Arch card)

```bash
curl -fsSLO https://get.openvolley.app/arch/openvolley.gpg
gpg --show-keys openvolley.gpg            # must show the fingerprint on the page
sudo pacman-key --add openvolley.gpg
sudo pacman-key --lsign-key <FINGERPRINT>
```

Then at the end of `/etc/pacman.conf`:

```ini
[openvolley]
SigLevel = Required DatabaseRequired
Server = https://get.openvolley.app/arch/$arch
```

and `sudo pacman -Syu openvolley-escoresheet-bin` (or `openbeach-escoresheet-bin`).
Updates come with every `sudo pacman -Syu`. The page says `-Syu <package>`,
not `-Sy <package>`: installing after a database refresh without upgrading is
a partial upgrade, which Arch does not support.

`SigLevel = Required DatabaseRequired`: pacman refuses an unsigned or wrongly
signed database or package from this repo (the default `DatabaseOptional`
would accept an unsigned database). `--lsign-key` makes pacman trust the key
for any repository, as with every third-party Arch repo; it signs nothing
but packages of these two apps.

The in-app updater stays off (the marker file `/usr/lib/<package>/package-manager`
and, for 2.4.0 / OpenBeach 2.0.0, the bundle-type reset; see `../aur/README.md`).

## Layout

On lenovoserver, under `~/.config/openvolley-pkgs` (mode 700):

| Path | What |
|---|---|
| `pacman-gpg/` | GNUPGHOME with the repo key only. Vaultwarden: "OpenVolley pacman repo key" |
| `pacman-gpg-passphrase` | its passphrase (mode 600) |
| `public/arch/openvolley.gpg` | the public key (binary; `pacman-key --add` takes it) |
| `public/arch/fingerprint.txt` | its fingerprint (the install page shows it) |
| `public/arch/x86_64/openvolley.db`, `.files` (+ `.sig`) | the database, signed |
| `public/arch/x86_64/*.pkg.tar.zst` (+ `.sig`) | the packages, each signed; the newest 3 versions of each |

`publish-pkgs.sh` syncs `public/` to `hetzner:/data/openvolley/pkgs/`, Caddy
serves it (`../../deploy/pkgs/Caddyfile`): packages and their `.sig` are
immutable (a version is never rebuilt), the database and its `.sig` are
`no-cache` (pacman sends `If-Modified-Since`, so that costs a 304), and none
of them is re-compressed. The install page shows the Arch card once
`public/arch/x86_64/openvolley.db` exists, each app's install line once its
package is in the repo.

## Files

| File | What |
|---|---|
| `publish-pacman.sh` | builds, signs and indexes; `--init-key` makes the key; `--help` has the details |
| `test.sh` | end to end with a throwaway key: real packages, served by Caddy, installed in a clean Arch container from the page's own steps, an update, tampering refused |
| `../aur/check-installed.sh` | the checks of an installed package (shared with `../aur/test.sh`) |
| `../../deploy/tests/publish-desktop.test.sh` | unit tests of `publish-pacman.sh` (fake PKGBUILDs, throwaway key) and `publish-pkgs.sh --pacman` |

## How `publish-pacman.sh` works

1. Takes the committed PKGBUILD (`VERSION` must be its `pkgver`; run
   `../aur/bump.sh` first). A version already in the repo is kept as it is;
   an older one than the repo's newest is refused.
2. Builds it with `makepkg` as a non-root user (your uid) in an archlinux
   container (local image `openvolley-pacman-build`: base-devel, rebuilt
   from `archlinux:latest` once a week). The `.deb` comes from GitHub, or
   from `--deb FILE` (what `publish-pkgs.sh --pacman` passes: the same bytes
   it signed); `makepkg` checks its sha256 against the PKGBUILD either way.
3. Signs each new package here, on the host (detached `.sig`): the private
   key never enters a container.
4. Rebuilds the database from scratch with `repo-add` (in the container) from
   the newest version of each package, and signs `openvolley.db` and
   `openvolley.files` here: the same result as `repo-add --sign`, without the
   key in the container. Plain files, no symlinks.
5. Exports the public key and its fingerprint. A key other than the one
   already published is refused (every user would have to import it again).
6. Puts the new `arch/` tree together in a scratch copy, checks it with
   `pacman` as a client (only this repo, `SigLevel = Required
   DatabaseRequired`, a fresh keyring that trusts only the exported key: sync
   the database, download and verify every package), and only then renames
   it into `public/arch/`. A failed run leaves the published tree as it was.

It never syncs; `publish-pkgs.sh` does.

## One-time setup (owner, on lenovoserver)

```bash
escoresheet/packaging/pacman/publish-pacman.sh --init-key
# run the `... | rbw add "OpenVolley pacman repo key"` command it prints, right away
```

Keep this key: a new one means every user has to import it again
(`publish-pacman.sh` refuses to sign with another key than the published one).

First publish (each app at its committed PKGBUILD's version: on `main` since
a5542a38 that is OpenVolley 2.4.1 and OpenBeach 2.0.1):

```bash
escoresheet/packaging/pacman/publish-pacman.sh --app both
escoresheet/deploy/publish-pkgs.sh      # the page gets its Arch card, syncs to hetzner
```

Redeploy `escoresheet/deploy/pkgs/Caddyfile` on hetzner first
(`deploy/RUNBOOK-hetzner.md`): it has the pacman content types and caching.

Check on any Arch machine (or `./test.sh` here): the page's steps install the app.

## A new release

After the GitHub release is out:

```bash
cd escoresheet/packaging/aur
./bump.sh openvolley X.Y.Z && git commit -am "chore(aur): openvolley-escoresheet-bin X.Y.Z"
cd ../../deploy
./publish-pkgs.sh --desktop X.Y.Z --pacman [--flatpak] [APK]
```

`--pacman` is refused with `--staging` (`pacman -Syu` would install the staging
version at once) and refused before anything is signed when the PKGBUILD is not
at `X.Y.Z`. OpenBeach: `bump.sh openbeach X.Y.Z`, `--desktop X.Y.Z --app beach --pacman`.

A packaging-only fix of a release: `./bump.sh openvolley X.Y.Z 2` (pkgrel 2),
commit, `publish-pacman.sh X.Y.Z`, then `publish-pkgs.sh`. Users get it with
`pacman -Syu`. Never rebuild a published `pkgver-pkgrel`: the files are cached
as immutable.

Rollback for one user: `sudo pacman -U https://get.openvolley.app/arch/x86_64/<older file>.pkg.tar.zst`
(the repo keeps the newest 3 of each package; `--keep N` to change).

## Checks run (Docker, 2026-10-08)

`./test.sh` passes (9 checks, about 6 minutes), with a throwaway key:

- both packages built from the real releases (OpenVolley 2.4.0, OpenBeach
  2.0.0), signed, indexed, client-checked by `publish-pacman.sh`;
- served by `caddy:2` with the production Caddyfile: `openvolley.db`,
  `.files` and their `.sig` are `no-cache`, packages and their `.sig`
  `immutable`, the database `application/octet-stream`, packages
  `application/zstd`, signatures `application/pgp-signature`, nothing
  re-encoded although the client asks for gzip/zstd;
- a clean `archlinux:latest` container (after `pacman-key --init` and
  `pacman -Syu`, as on an installed Arch) runs the four command blocks of the
  page's Arch card, taken from `index.html` (only the host name and the
  fingerprint substituted), and gets both packages installed;
- `../aur/check-installed.sh` for both: no missing library, desktop file and
  icons, stamp `UNK`, marker `aur`, the app runs under Xvfb, its LAN page
  answers 200, the log says `no automatic updates`;
- a pkgrel bump (2.4.0-2) published: `pacman -Syu` upgrades to it;
- refused: a database with one byte changed ("signature ... is invalid"), a
  database signed by another key that is in the keyring but not trusted
  ("unknown trust"), a package signed by that key ("unknown trust"), a
  database or a package without its `.sig` (404: what `SigLevel = Required
  DatabaseRequired` is for), a package with one byte changed (pacman's
  checksum from the signed database catches it first). After each, with the
  real files back, pacman syncs and installs again.

Also checked, by hand, on the branch merged with `main` (OpenVolley 2.4.1,
OpenBeach 2.0.1, the first releases that read the marker file): the Arch
card of the page as `landing_page` renders it, its four command blocks run
verbatim (no substitution) against `https://get.openvolley.app` (a TLS proxy
in front of the production Caddyfile, its CA trusted by the client), both
apps installed and passed `check-installed.sh`, a pkgrel 2 came with
`sudo pacman -Syu` and the database still listed both packages.

`../../deploy/tests/publish-desktop.test.sh` (155 checks, 32 of them for
this repo) covers `--init-key`, the argument checks, `publish-pkgs.sh
--pacman`, the page's Arch card, and in Docker: build, keeping a published
version, a pkgrel bump, `--keep`, refusing an older version, a foreign file,
another key, and a broken signature (the published tree stays as it was).

Seen on the way: a database refused once stays in pacman's sync directory,
and pacman complains about that copy each time it starts until the next good
`pacman -Sy`. Harmless, and the same for any repository.

Not tested: a real Arch desktop (tray, hotspot, Bluetooth), the same as for
the AUR package.
