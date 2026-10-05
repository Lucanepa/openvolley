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
| `cloudflared/config.yml` | VM (mounted read-only) | Tunnel ingress: `backend.openvolley.app` (and the temporary `ov-preflight` name) -> `http://ov-backend:8080`; everything else 404 |
| `Dockerfile.backend` (+ `.dockerignore`) | build machine | Packages `escoresheet/backend`: `node:22.23.3-bookworm-slim`, `npm ci --omit=dev`, user `node`, HEALTHCHECK on `/health/live` |
| `build-image.sh` | lenovoserver | Builds `openvolley-backend:<git-sha>`; `--ship <host>` streams it to the VM and keeps a `.tar.gz` for rollbacks |
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
| `RESEND_API_KEY`, `RESEND_FROM`, `SMTP_*`, `CONTACT_EMAIL`, `REOPEN_PASSWORD_HASH` | from `.env` | Unchanged from today |
| `IS_CLOUD` | `1` | Existing switch for HSTS/CSP in `server.js` |
| `OV_MIN_MATCHES` | from `.env` | `/health` row-count floor |

Health endpoints: `GET /health/live` (no DB; Docker healthcheck) and `GET /health` (db ping,
catalog, floor, sentinel, disk free, backup age; 503 on db/floor/sentinel failure; used by
monitors and `restore-test.sh`). The image's healthcheck falls back to `/health` when
`/health/live` answers 404, so images built before the wiring still report healthy; a
pre-wiring image must **not** be deployed (it has no Postgres code), and `restore-test.sh`
fails on it by design unless `RT_REQUIRE_DB_HEALTH=0`.

## What touches KSCW (isolation on the shared VM)

Everything the kit does on `lucanepa-prod`, and nothing else:

| Shared resource | What OpenVolley uses | Bound |
|---|---|---|
| Disk | `/var/lib/openvolley/{pg,storage}.img` (23 GB, allocated once), `/data/openvolley/backups`, Docker images (~350 MB per backend tag), container logs | Loop images are hard caps: a runaway cannot grow past them. `host-prep.sh` refuses unless 20 GB stay free after allocation. `backup-openvolley.sh` refuses to write below 10 GB free. Logs `json-file` 5 x 10 MB per service |
| RAM | 256 + 256 + 128 MB | `mem_limit` = `memswap_limit` (no swap, so KSCW's page cache is not pushed out), `oom_score_adj: 500` (on host OOM the kernel picks OpenVolley first) |
| CPU / pids | 1.0 + 0.5 + 0.5 CPU, 256 / 128 / 64 pids | `cpus`, `pids_limit`; backups run `nice 10`, idle-ish I/O class |
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
