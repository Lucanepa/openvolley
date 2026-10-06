# OpenVolley self-hosted backend: deployment kit

Everything needed to run the OpenVolley cloud backend (`escoresheet/backend`) with its own
Postgres on one Linux VM, reachable only through a Cloudflare Tunnel.

- **Now (Option A):** co-tenant on the Hetzner VM `lucanepa-prod` (`ssh hetzner`), which also
  runs KSCW production under Coolify and Traefik. See [RUNBOOK-hetzner.md](RUNBOOK-hetzner.md).
- **Later (Option B):** the same files on a small VM of its own. No DNS change, downtime under
  15 minutes. See [RUNBOOK-move-to-own-vm.md](RUNBOOK-move-to-own-vm.md).

The stack is a plain `docker compose` project named `openvolley` in `/opt/openvolley`. It is
**not** a Coolify resource. It publishes **no host ports**, joins **no** Coolify or Traefik
network, and carries `traefik.enable=false`.

```
 browsers / PWAs / tablets
        |  HTTPS + WSS  backend.openvolley.app  (CNAME -> <tunnel-id>.cfargotunnel.com, proxied)
        v
 Cloudflare edge
        ^  outbound-only QUIC/HTTP2 connections opened by cloudflared (no inbound port, no IP allowlist)
        |
 +-- compose project "openvolley" (any VM with Docker) -----------------------------------+
 |  ov-tunnel    cloudflare/cloudflared:2026.5.2   128 MB, 0.5 CPU, read-only, no caps    |
 |      | network ov-edge (egress allowed)                                                 |
 |  ov-backend   openvolley-backend:<git-sha>      256 MB, 1 CPU, pids 256, read-only,    |
 |      |        :8080 HTTP + WebSocket upgrade     user node, no caps, tmpfs /tmp         |
 |      | network ov-internal (internal: true, no egress)                                  |
 |  ov-postgres  postgres:17.11-alpine             256 MB, 0.5 CPU, pids 128, read-only,  |
 |               uid 70, refuses to start without /ovpg/.ovdata                            |
 |  ov-pkgs      caddy:2.11.7-alpine (ov-edge only) 64 MB, 0.25 CPU, read-only, nobody,   |
 |               get.openvolley.app: static APT + F-Droid repos from /data/openvolley/pkgs |
 +----------------------------------------------------------------------------------------+
   /data/openvolley/pg       8 GB loop ext4  (.ovdata sentinel, data/ = PGDATA)
   /data/openvolley/storage 15 GB loop ext4  (.ovdata sentinel, scoresheets/, backup/)
   /data/openvolley/backups  hourly db dumps + nightly storage tars, GPG-encrypted (public key only)
   /var/lib/openvolley-status/last_backup   (mounted read-only into ov-backend)
        |  nightly PULL over Tailscale (rrsync -ro)          weekly restore test
        v                                                    v
   NAS /volume1/backups/openvolley/hetzner  ------------>  lenovoserver (holds the private key)
```

## Files

| File | Runs where | What it does |
|---|---|---|
| `compose.yaml` | VM, `/opt/openvolley` | The three services, two networks, limits, bind mounts with `create_host_path: false` |
| `env.example` | VM | Template for `/opt/openvolley/.env` (mode 600). Lists every variable; no real values |
| `cloudflared/config.yml` | VM (mounted read-only) | Tunnel ingress: `backend.openvolley.app` (and the temporary `ov-preflight` name) -> `http://ov-backend:8080`, `get.openvolley.app` -> `http://ov-pkgs:80`; everything else 404 |
| `pkgs/Caddyfile` | VM (mounted read-only into `ov-pkgs`) | Static server for `get.openvolley.app`: GET/HEAD only, directory listings, MIME types for `.deb`/`.apk`/`.jar`/`.json`/`.gpg`, 1-year `immutable` cache for packages, 60 s for everything else (the desktop updater manifests too); `Access-Control-Allow-Origin: *` on `/fdroid/repo/index-v2.json` only (the Android app's update check) |
| `pkgs/index.html` | template, filled by `publish-pkgs.sh` | Install page at `/` (Android via F-Droid or APK, Linux via APT, Windows `.exe`). Its `<!--per-machine-->` block (administrator prompt, firewall rule) is published only for a desktop version newer than 2.1.0, the last per-user Windows installer |
| `pkgs/install.sh` | copied by `publish-pkgs.sh` | Linux one-line installer at `/install.sh`: checks the APT key fingerprint, adds the repo, installs `openvolley-escoresheet` |
| `publish-pkgs.sh` | lenovoserver | Adds `.deb` (repacked to `openvolley-escoresheet` if named otherwise)/signed `.apk`, copies `pkgs/install.sh`, re-signs the APT and F-Droid indexes, rsyncs the public tree to `hetzner:/data/openvolley/pkgs/`. `--desktop VERSION [--staging]` also signs a desktop release for the in-app updater and writes its `latest.json`. See [Public downloads](#public-downloads-getopenvolleyapp) |
| `lib/publish-lib.sh`, `lib/desktop-updater.mjs` | lenovoserver (used by `publish-pkgs.sh`) | The `--desktop` steps and the key-material guard; the `.mjs` (Node, no npm packages) checks updater signatures the way the app does and writes and validates `latest.json` |
| `tests/publish-desktop.test.sh` | any machine with Node, `dpkg-deb` and tauri-cli >= 2.12 | Offline tests of `--desktop` with a throwaway key: signing, verification, `latest.json`, staging, rollback and leak guards |
| `Dockerfile.backend` (+ `.dockerignore`) | build machine | Packages `escoresheet/backend`: `node:22.23.3-bookworm-slim`, `npm ci --omit=dev`, user `node`, HEALTHCHECK on `/health/live` + storage sentinel (no fallback) |
| `build-image.sh` | lenovoserver | Builds `openvolley-backend:<git-sha>`, refusing a backend tree without the self-host contract; `--ship <host>` streams it to the VM, keeps a `.tar.gz` for rollbacks and prunes to the newest 5 (`prune-images.sh`) |
| `apply-roles.sh` | VM, root | `roles.sql` from stdin with `OV_APP_PW` read from `.env` (never exported into a shell), then checks the `ov_app` login |
| `restore-db.sh` | VM, root | Restores a decrypted dump into a **fresh** database, all-or-nothing (`--single-transaction`), count check, rolls back on any failure, resets the backup count guard |
| `host-prep.sh` | VM, as root | Idempotent host setup: loop filesystems, sentinels, `chattr +i`, fstab (`nofail`), dirs, `ovbackup` user, backup units. `--check` is read-only |
| `backup-openvolley.sh` + `systemd/openvolley-backup*.{service,timer}` | VM, root | Hourly `pg_dump -Fc` + nightly storage tars, GPG to the public key, count-drop guard, rotation, `last_backup` |
| `nas-pull.sh` | NAS (DSM Task Scheduler) | Pulls the encrypted files over Tailscale with a restricted read-only key, NAS-side retention, freshness check |
| `restore-test.sh` + `systemd/openvolley-restore-test.{service,timer}` | lenovoserver, weekly | Decrypts the newest NAS dump, restores into a throwaway Postgres, boots the backend image against it, checks `/health` and row-count floors, tears down |

## Runtime contract (backend <-> kit)

These names are shared with the self-host wiring in `escoresheet/backend` and must not drift.

| Variable | Value in the container | Notes |
|---|---|---|
| `DATABASE_URL` | `postgres://ov_app:${OV_APP_PW}@ov-postgres:5432/openvolley` | Unset = LAN/local mode exactly as today (venue binaries, Pi) |
| `STORAGE_ROOT` | `/data/storage` | Bind mount of the storage loop fs; backend refuses writes without `.ovdata` |
| `STATUS_DIR` | `/var/lib/openvolley-status` | Read-only; contains `last_backup` (ISO timestamp) written by the backup job |
| `PORT` | `8080` | HTTP **and** WebSocket. `server.js` attaches `ws` to the HTTP server (`new WebSocketServer({ server })`), so there is no separate WS port and the tunnel needs one origin only |
| `PUBLIC_ORIGINS` | from `.env` | Comma-separated CORS origins |
| `TRUST_PROXY` | `cloudflare` | Client IP from `cf-connecting-ip`. Safe because the tunnel is the only way in: no host port exists that could be hit with a forged header |
| `RESEND_API_KEY`, `RESEND_FROM`, `SMTP_*`, `CONTACT_EMAIL` | from `.env` | Unchanged from today. (`REOPEN_PASSWORD_HASH` was replaced by the admin reopen of db/007 and is no longer read.) |
| `IS_CLOUD` | `1` | Existing switch for HSTS/CSP in `server.js` |
| `OV_MIN_MATCHES` | from `.env` | `/health` row-count floor |

Health endpoints: `GET /health/live` (no DB; Docker healthcheck) and `GET /health` (db ping,
catalog, floor, sentinel, disk free, backup age; 503 on db/floor/sentinel failure; used by
monitors and `restore-test.sh`). A pre-wiring image (no Postgres code; it would run today's
unauthenticated local relay mode) is kept off the server three ways: `build-image.sh` refuses
to build the tree (`--allow-prewiring` makes a local-only `-prewiring` tag that it never ships),
the image's healthcheck has **no** fallback to `/health`, so such an image never turns healthy
and `ov-tunnel` (`depends_on: service_healthy`) never starts in front of it, and
`restore-test.sh` refuses `-prewiring`/`-dirty` tags and fails on missing `/health/live`
(`RT_ALLOW_DEV_IMAGE=1 RT_REQUIRE_DB_HEALTH=0` for local kit experiments only).

Mount guards: `ov-postgres` and `ov-backend` both exit (code 78, retried by `restart:
unless-stopped`) while their filesystem's `.ovdata` sentinel is missing, so neither runs on a
bare mountpoint, and each retry binds the mount afresh once it is back. `ov-postgres` also
refuses to `initdb` when a cluster has existed on the filesystem (`state/initialized`) but
`data/PG_VERSION` is gone.

**Never `source` `.env`** into a shell: Compose prefers exported shell variables over `.env`,
so later `up`/rollback commands in that shell would silently use the old values.

## What touches KSCW (isolation on the shared VM)

Everything the kit does on `lucanepa-prod`, and nothing else:

| Shared resource | What OpenVolley uses | Bound |
|---|---|---|
| Disk | `/var/lib/openvolley/{pg,storage}.img` (23 GB, allocated once), `/data/openvolley/backups`, `/data/openvolley/pkgs` (packages, tens of MB per release), `/opt/openvolley/images` + Docker images (~350 MB per backend tag), container logs | Loop images are hard caps: a runaway cannot grow past them. `host-prep.sh` refuses unless 20 GB stay free after allocation. The backups directory is on the root fs and **not** a loop image: `backup-openvolley.sh` estimates every output (db dump, each tar) before writing it and refuses when it would leave under 10 GB free (`OV_MIN_FREE_MB`) or push the directory past 20 GB (`OV_BACKUP_MAX_MB`); a refusal alerts through the Kuma push. Rollback images: `build-image.sh --ship` keeps the newest 5 archives and tags plus the deployed one. Logs `json-file` 5 x 10 MB per service |
| RAM | 256 + 256 + 128 + 64 MB (`ov-pkgs`) | `mem_limit` = `memswap_limit` (no swap, so KSCW's page cache is not pushed out), `oom_score_adj: 500` (on host OOM the kernel picks OpenVolley first) |
| CPU / pids | 1.0 + 0.5 + 0.5 + 0.25 CPU, 256 / 128 / 64 / 64 pids | `cpus`, `pids_limit`; backups run `nice 10`, idle-ish I/O class |
| Docker daemon | Containers and networks labelled `com.docker.compose.project=openvolley` | No published ports, no `coolify` network, `traefik.enable=false`, bind mounts only (no named volumes, so `docker volume prune` cannot hit data) |
| Network | Outbound only: Cloudflare (7844 udp/tcp, 443), Resend/SMTP | `ov-internal` is `internal: true`; Postgres has no route out |
| `/etc/fstab` | Two appended lines, `nofail` | Backup copy written first. `nofail`: a broken image never blocks boot or Docker; the containers just restart until the mount is back |
| Users | System user `ovbackup` | Shell `/bin/sh`, no password, `authorized_keys` with `command="rrsync -ro ..."`, `restrict` |
| systemd | `openvolley-backup{,-files}.{service,timer}` | Own unit names, root, `ProtectSystem=full` |
| Boot order | `x-systemd.before=docker.service` on the two mounts | Ordering only, not a dependency: Docker starts even if the mounts fail |

**Not touched:** Coolify (database, settings, projects, auto-deploy), `coolify-proxy`/Traefik
(dynamic config, certificates, networks), any KSCW container, volume or network,
`kscw-postgres`, `/data/backups` and `/data/coolify`, root's crontab, root's GPG keyring
(backups use `--recipient-file` and a private homedir `/var/lib/openvolley-backup/gnupg`),
the host firewall, Cloudflare settings of other hostnames. Two items are **read, and changed
only if needed** (RUNBOOK-hetzner.md step 1): `postgres-autopatch.sh` and `backup-postgres.sh`
must not select `ov-postgres`, and `sshd_config` must allow the `ovbackup` login.

Audit at any time on the VM:

```bash
docker ps -a --filter label=com.docker.compose.project=openvolley --format '{{.Names}}\t{{.Ports}}'   # Ports column empty
docker network ls --filter label=com.docker.compose.project=openvolley
docker inspect coolify-proxy -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'           # no openvolley_* network
for n in openvolley_ov-internal openvolley_ov-edge; do docker network inspect -f '{{.Name}} internal={{.Internal}}: {{range .Containers}}{{.Name}} {{end}}' "$n"; done
docker stats --no-stream $(docker ps -q --filter label=com.docker.compose.project=openvolley)
findmnt /data/openvolley/pg; findmnt /data/openvolley/storage
systemctl list-timers 'openvolley-*'
```

Complete removal (leaves no trace besides the fstab backup copies): RUNBOOK-hetzner.md, "Uninstall".

## Public downloads: get.openvolley.app

`https://get.openvolley.app` serves the public install routes from `ov-pkgs`, through the same
tunnel as the backend:

| Path | What | Signed by |
|---|---|---|
| `/` | Install page (`pkgs/index.html`, versions filled in at publish time) | n/a |
| `/install.sh` | One-line Linux installer (`pkgs/install.sh`), served as `text/plain` | pins the APT key fingerprint below |
| `/apt/` | APT repo: `dists/stable` (component `main`, arch `amd64`), `pool/main/*.deb`, `openvolley.gpg` (binary keyring), `openvolley.asc` | GPG key **OpenVolley packages <packages@openvolley.app>**, ed25519, no expiry, fingerprint `AB46 9DA8 DC3E C90F 8057 320D 285B 18D7 6C16 B82C` |
| `/fdroid/repo/` | F-Droid repo **OpenVolley** with `com.openvolley.escoresheet` | Index: repo key `CN=openvolley, OU=F-Droid`, RSA 4096, to 2054, fingerprint `61C70F8949441E04E2E21ACC8E6E5C6CC502ADD52A157FB9A8DD8588DACE0720`. APKs: the OpenVolley app key (`frontend/ANDROID.md`), never re-signed |
| `/desktop/` | Desktop updater manifests: `latest.json` (everyone), `staging.json` (apps started with `OPENVOLLEY_UPDATE_CHANNEL=staging`), `latest-<version>.json` (archive, for the kill switch) | Each installer's signature inside: the desktop updater key (minisign Ed25519, made with `tauri signer`), public half in `frontend/src-tauri/tauri.conf.json` `plugins.updater.pubkey`; the signature also binds the version (`requireSignedVersion`) |

The Windows installer and an APK copy (`OpenVolley-<version>.apk`) are assets of the GitHub
release `desktop-v<version>`; the page links there. From 2.2.0 the release also carries a `.sig`
per installer and `latest.json`: the app asks `https://get.openvolley.app/desktop/latest.json`
first and `https://github.com/Lucanepa/openvolley/releases/latest/download/latest.json` if that
fails, so the newest `desktop-v*` release must stay GitHub's "Latest" (`desktop.yml` sets
`make_latest`; Android releases are created with `--latest=false`). The Windows and AppImage
entries point at the GitHub assets, the `.deb` entry at the APT pool.

User commands (also on the page). Linux, one line:

```bash
curl -fsSL https://get.openvolley.app/install.sh | sudo sh
```

`install.sh` (POSIX sh, Debian/Ubuntu and derivatives, amd64, root): installs `curl`,
`ca-certificates` and `gpg` if missing, downloads `apt/openvolley.gpg` and refuses it unless it
holds exactly one primary key with fingerprint `AB469DA8DC3EC90F8057320D285B18D76C16B82C`
(not revoked or expired), writes it to `/usr/share/keyrings/openvolley.gpg`, writes
`/etc/apt/sources.list.d/openvolley.list` (`signed-by` that keyring), then `apt-get update` and
`apt-get install -y openvolley-escoresheet`. Running it again rewrites the same two files and
upgrades the package. `OV_PKGS_BASE=http://host:port` points it at another server (tests only).
The same by hand:

```bash
curl -fsSL https://get.openvolley.app/apt/openvolley.gpg | sudo tee /usr/share/keyrings/openvolley.gpg >/dev/null
echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/openvolley.gpg] https://get.openvolley.app/apt stable main' | sudo tee /etc/apt/sources.list.d/openvolley.list
sudo apt update && sudo apt install openvolley-escoresheet
```

F-Droid: add `https://get.openvolley.app/fdroid/repo?fingerprint=61C70F8949441E04E2E21ACC8E6E5C6CC502ADD52A157FB9A8DD8588DACE0720`.

**Package name.** The APT package is `openvolley-escoresheet` and the command
`/usr/bin/openvolley-escoresheet` (`openvolley-escoresheet --server-only` for the tablet relay
alone). Tauri derives the `.deb` name from `productName` in kebab case, so
`frontend/src-tauri/tauri.linux.conf.json` overrides `productName` (and pins `mainBinaryName`)
to `openvolley-escoresheet` on Linux only; `tauri.conf.json` keeps "Openvolley eScoresheet" so
the Windows installer still finds the earlier install (after 2.1.0 it installs per machine and
removes an older per-user copy itself, see `frontend/OFFLINE_DESKTOP.md`, Windows install). That deb provides, replaces and conflicts with
`openvolley-e-scoresheet` (the name of the GitHub `.deb` up to 1.48.19) and `openvolley`.
`publish-pkgs.sh` repacks any `.deb` published under another name the same way (same version,
depends and files, deterministic bytes) and migrates old-name files left in the pool, so the
repo only ever lists `openvolley-escoresheet`. Someone who installed `openvolley-e-scoresheet`
(the GitHub `.deb`, or this repo before the rename) moves over with the installer or
`sudo apt install openvolley-escoresheet`; plain `apt upgrade` does not switch package names.

**Keys** (lenovoserver only, never on the VM, never in git), all under
`~/.config/openvolley-pkgs/` (mode 700):

- `gnupg/` + `gpg-passphrase`: the APT key. Vaultwarden, folder OpenVolley, **"OpenVolley APT
  signing key"** (password = passphrase; notes = armored private key and how to restore).
- `fdroid/config.yml` + `fdroid/keystore.p12`: the F-Droid repo key, created by `fdroid init`.
  Vaultwarden **"OpenVolley F-Droid repo key"** (password = keystore password; notes = key
  password, alias, base64 keystore). Losing it means every user must re-add the repo under a
  new fingerprint; losing the APT key means everyone re-downloads `openvolley.gpg`.
- `public/`: the served tree, rebuilt by `publish-pkgs.sh`. Only this directory is rsynced.

The desktop updater key lives apart, in `~/.config/openvolley-desktop/` (mode 700):
`updater.key` (the `tauri signer` private key, password protected) and `key-password` (its
password), both mode 600, plus `updater.key.pub`, whose content is the `pubkey` committed in
`tauri.conf.json`. Vaultwarden: **"OpenVolley desktop updater key"** (notes: the key file and
the password). Losing it means installed apps never update themselves again (a new key needs a
manual reinstall everywhere). CI never signs and holds no updater secret, so a GitHub compromise
cannot push code to venue laptops. `publish-pkgs.sh` checks every signature against the key in
`tauri.conf.json`, never against the `.pub` file next to the private key.

This is separate from the owner's private F-Droid repo (`/srv/fdroid/desktop-calendar`), which
stays private and is not touched by any of this.

### Release procedure

Not on match days (Friday 17:00 to Sunday): an update downloads in the background and installs
when the scorer quits the app, and it should not be the first thing a venue sees on a Saturday.

1. Desktop: bump the version (`escoresheet/frontend/package.json`) and tag `desktop-v<version>`.
   CI builds and creates the GitHub release; the release job fails if the tag and
   `package.json` disagree. Releases before 2.2.0 (no updater) were published by downloading
   the `.deb` by hand
   (`gh release download desktop-v<version> --repo Lucanepa/openvolley --pattern '*.deb' -D /tmp/ovrel`)
   and passing it to step 3; from 2.2.0 use `--desktop` (step 3) instead.
2. Android: `escoresheet/frontend/scripts/release-android.sh` builds and signs the APK and puts
   it in the private repo as `/srv/fdroid/desktop-calendar/repo/com.openvolley.escoresheet_<code>.apk`
   (`frontend/ANDROID.md`). Attach it to the release for direct download:
   ```bash
   cp /srv/fdroid/desktop-calendar/repo/com.openvolley.escoresheet_<code>.apk /tmp/ovrel/OpenVolley-<version>.apk
   gh release upload desktop-v<version> --repo Lucanepa/openvolley /tmp/ovrel/OpenVolley-<version>.apk
   ```
3. Publish (the desktop part, the APK, or both). A desktop release goes to staging first:
   ```bash
   cd escoresheet/frontend && npm ci && cd -     # tauri-cli >= 2.12 (signer --app-version)
   escoresheet/deploy/publish-pkgs.sh --desktop <version> --staging \
     /srv/fdroid/desktop-calendar/repo/com.openvolley.escoresheet_<code>.apk
   ```
   `--desktop` downloads the release's `-setup.exe`, AppImage and `.deb` with `gh`, checks each
   is that version (and the `.deb` is `openvolley-escoresheet`), signs each with the updater key
   (`tauri signer sign --app-version`, the password goes through the environment only), verifies
   each signature against `tauri.conf.json` (with `lib/desktop-updater.mjs`, and also with
   `minisign` when it is installed), writes `latest.json` (notes: the fastlane changelog of the
   same version) and adds the `.deb` to the APT pool. With `--staging` it updates
   `desktop/staging.json` and `desktop/latest-<version>.json` and uploads only the `.sig` files to
   the GitHub release. The `.deb` enters the APT repo already in this run (APT has no staging
   channel), so `sudo apt upgrade` and unattended-upgrades see it at once; only the in-app
   updater waits for `latest.json`. Start your own laptops with `OPENVOLLEY_UPDATE_CHANNEL=staging`
   and check that they update (quit, or "Restart and update"). Then everyone:
   ```bash
   escoresheet/deploy/publish-pkgs.sh --desktop <version>
   ```
   That re-signs, writes `desktop/latest.json` too and uploads `latest.json` with the `.sig`
   files to the release (after the rsync, so it never points at a `.deb` not yet served). It
   warns if that release is not GitHub's "Latest" (`gh release edit desktop-v<version> --latest`).
   A channel never moves back to an older version this way; see the kill switch below.

   `publish-pkgs.sh` refuses an APK not signed by the OpenVolley app key, a `.deb` that is not the desktop app,
   and a package that would overwrite a different file under the same version. It also copies
   `pkgs/install.sh` (after checking it pins the APT key and the package name). `--no-sync` builds `~/.config/openvolley-pkgs/public`
   without uploading anything (rsync or GitHub). Clients see the new indexes and manifests within 60 s (cache), packages are immutable.
   Before publishing, refuses anything key-like in the public tree: key stores, password files,
   `*.key`, PGP private key blocks and minisign / tauri secret keys (as text or base64).
4. Check: `curl -fsS https://get.openvolley.app/apt/dists/stable/InRelease | head`, the
   version on the page, `curl -fsSI https://get.openvolley.app/install.sh` (200, text/plain),
   and for a desktop release `curl -fsS https://get.openvolley.app/desktop/latest.json | head -3`.

To withdraw a version: delete it from `~/.config/openvolley-pkgs/public/apt/pool/main/` or
`~/.config/openvolley-pkgs/fdroid/repo/` and run `publish-pkgs.sh` again.

**Desktop kill switch** (a bad desktop release is rolling out): point the manifest back at the
previous release and sync. Clients that have not updated yet stop; clients never downgrade, so
ship a fixed patch next.
```bash
cp ~/.config/openvolley-pkgs/public/desktop/latest-<previous>.json ~/.config/openvolley-pkgs/public/desktop/latest.json
escoresheet/deploy/publish-pkgs.sh                      # syncs the tree
gh release delete-asset desktop-v<bad> latest.json --repo Lucanepa/openvolley --yes   # the fallback endpoint too
```

Tests (offline, throwaway key, no GitHub, no sync):
`TMPDIR=<scratch dir> OV_TAURI_CLI=<tauri-cli >= 2.12> escoresheet/deploy/tests/publish-desktop.test.sh`.

### Deploy (owner, once)

```bash
# DNS (openvolley.app zone): CNAME get -> 10659462-0408-42a4-bdd9-fc890094954d.cfargotunnel.com, proxied
lenovo$ ssh hetzner install -d -m 0755 -o root -g root /data/openvolley/pkgs     # or ./host-prep.sh
lenovo$ escoresheet/deploy/publish-pkgs.sh                                      # fills it
lenovo$ rsync -rlt --chmod=D750,F640 --exclude=.env escoresheet/deploy/ hetzner:/opt/openvolley/
lenovo$ ssh hetzner 'chmod 750 /opt/openvolley/*.sh && chmod 644 /opt/openvolley/cloudflared/config.yml /opt/openvolley/pkgs/Caddyfile'
hetzner# cd /opt/openvolley && docker compose config -q && docker compose up -d ov-pkgs && docker compose restart ov-tunnel
hetzner# docker compose ps ov-pkgs                                               # healthy
```

A later `pkgs/Caddyfile` change (such as the F-Droid index CORS header) does not change the
compose config, so `up -d` alone keeps the old one: copy the kit as above, then
`docker compose up -d --force-recreate ov-pkgs` and check
`curl -fsSI https://get.openvolley.app/fdroid/repo/index-v2.json | grep -i access-control`.

The `chmod 644` matters: the kit lands root-owned `640`, and `ov-pkgs` runs as `nobody` (as
`ov-tunnel` runs as a non-root user), so without it Caddy cannot read its config. `publish-pkgs.sh`
writes the public tree `D755,F644`.

Hardening as for the other services (read-only root, `cap_drop: ALL`, `no-new-privileges`, limits,
`ov-edge` only, no ports), with one capability kept: `/usr/bin/caddy` in the image has the file
capability `cap_net_bind_service`, and the kernel refuses to exec it when that capability is not in
the bounding set, so `cap_add: [NET_BIND_SERVICE]`.

## Deviations from the migration plan (and why)

| Plan | Kit | Reason |
|---|---|---|
| Proxied A record, Traefik router, Origin CA cert, `ipAllowList` of Cloudflare ranges, monthly range diff | Cloudflare Tunnel container | Owner decision: no public port, nothing to keep in sync, moves with the stack |
| Coolify project + Compose resource, branch `deploy/openvolley` | Plain compose in `/opt/openvolley`, images by git SHA | Coolify auto-deploy and network attachment cannot interfere; rollback = previous tag |
| `/data/backups/openvolley`, root crontab | `/data/openvolley/backups`, systemd timers | `/data/backups` and root's crontab belong to KSCW's backup jobs (rotation and R2 sync not read yet); keep OpenVolley out of them |
| `gpg --import` into root's keyring | `--recipient-file` + private homedir, fingerprint pinned in `backup.conf` | Nothing added to the keyring KSCW's backups use; refuses a private key file |
| `/var/lib/openvolley-{pg,storage}.img`, fstab pass 2 | `/var/lib/openvolley/{pg,storage}.img`, pass 0 | One root-only directory; no boot-time fsck of image files |
| `STORAGE_DIR`, status at `/status` | `STORAGE_ROOT`, `STATUS_DIR=/var/lib/openvolley-status` | Shared runtime contract |
| Cold standby: repoint DNS to `cloudflared-lenovo` | Same compose + same `TUNNEL_TOKEN` on lenovoserver | No DNS change; stop the hetzner tunnel first (two live connectors would split traffic) |

## Verified locally (lenovoserver, 2026-10-05)

`docker compose -p ov-kit-test config -q`; image build from this tree; `ov-postgres` +
`ov-backend` healthy on temp bind dirs (read-only rootfs, uid 70 / node, no caps, no ports,
Postgres without egress); Postgres exits with `FATAL: /ovpg/.ovdata missing` and initialises
nothing without the sentinel; a missing bind path is an error; tunnel ingress validated, dummy
token rejected; backup run with a throwaway key (wrong fingerprint, missing sentinel and a 50%
count drop all refused before dumping; `counts.reset` accepted); `restore-test.sh` passed on
that dump, failed on a raised floor, on a wrong passphrase and in strict mode on the pre-wiring
image; `host-prep.sh` apply run twice (idempotent) inside a throwaway privileged container with
64 MB images, immutable bare mountpoint refused writes, a lost image with its fstab line still
present was refused; `shellcheck` clean.

Review fixes, same day: `build-image.sh` refuses the current pre-wiring tree (and `--ship` with
`--allow-prewiring`); the `-prewiring` image stays `unhealthy` and `ov-tunnel` stays `Created`
("dependency failed to start"); `ov-backend` exits 78 without the storage sentinel and starts
once it is back; `ov-postgres` writes `state/initialized` and then refuses (exit 78, no initdb) on
an emptied `data/`; a shell-exported `OV_MIN_MATCHES` overrides `.env` (the reason for "never
source .env"), and the quoted `env.example` now sources completely; `apply-roles.sh` (quoted
password, refuses non-URL-safe passwords and a failing statement; password not in any argv);
`restore-db.sh` refused while the backend ran, on an encrypted file, while the backup lock was
held and while another session was connected, restored with matching counts (old database kept,
`counts.reset` touched, `template1` pollution ignored), and rolled back to the untouched old
database on a truncated stream, a truncated file, a failing `pg_dump` in the pipe and a count
mismatch; `backup-openvolley.sh` refused an unset fingerprint and stopped before a tar that would
exceed `OV_BACKUP_MAX_MB` (no partial left); `restore-test.sh` refused a dev tag, a missing tag
file and a missing `roles.sql`, swept a planted leftover container, network and `/dev/shm`
directory, passed, and cleaned up everything on SIGTERM; `prune-images.sh` kept the newest N plus
the deployed tag. All throwaway containers, networks, images and temp dirs removed afterwards.
