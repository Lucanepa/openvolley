# Runbook: first deploy on hetzner (Option A, co-tenant on `lucanepa-prod`)

Who: the owner, at a keyboard on lenovoserver, Monday to Friday before 17:00.
Time: about half a day the first time, excluding the data load from the migration plan (§6).
Hosts: `lenovoserver` (build machine, tunnel admin, private backup key), `hetzner`
(`ssh hetzner`, root), `nas` (`ssh nas`).

Prompts: `lenovo$` is lenovoserver in the repo checkout, `hetzner#` is root on the VM.

**Shell hygiene: never `source` / `set -a; . .env`.** Docker Compose gives variables exported
in the calling shell priority over `.env`. In such a shell every later `docker compose up`
silently keeps the exported values: an `OV_BACKEND_IMAGE` changed for an update or rollback,
or a raised `OV_MIN_MATCHES`, would be ignored. The one place that needs a value from `.env`
(the app password for `roles.sql`) uses `apply-roles.sh`, which reads just that value. Before
any `docker compose up`, this must print nothing:

```bash
hetzner# env | grep -E '^(OV_|TUNNEL_TOKEN|PUBLIC_ORIGINS|RESEND_|SMTP_|CONTACT_EMAIL|REOPEN_PASSWORD_HASH)='
```

**Preconditions**
- The self-host wiring (Phases 1-3 of the migration plan) is merged: `/health/live`, `/health`
  with `db`, `DATABASE_URL`, `STORAGE_ROOT`, `STATUS_DIR`, `TRUST_PROXY`. Check:
  `lenovo$ grep -c "health/live" escoresheet/backend/server.js` is non-zero. `build-image.sh`
  enforces this too: it refuses to build a tree without `/health/live`, `DATABASE_URL`,
  `STORAGE_ROOT` and `STATUS_DIR`, and the image's healthcheck has no fallback, so a pre-wiring
  image never turns healthy and the tunnel never starts in front of it.
- The Phase-0 archives exist and `scripts/migrate/restore.sh` + `escoresheet/backend/db/*.sql`
  are in the tree (data load, step 8).
- The `openvolley-backup` GPG key exists on lenovoserver; its public part is in
  `~/ov-backup-public.asc`.

---

## 1. Read before changing anything (hetzner, read-only)

```bash
hetzner# ss -Htlnup | sort > /root/ov-ss-before.txt           # listeners before; diffed in step 9
hetzner# df -h / && free -m
hetzner# crontab -l
hetzner# grep -nE 'docker (ps|exec)|postgres|grep' /usr/local/bin/postgres-autopatch.sh /usr/local/bin/backup-postgres.sh /usr/local/bin/restore-test.sh
hetzner# sshd -T | grep -iE '^(allowusers|allowgroups|denyusers|passwordauthentication|pubkeyauthentication)'
hetzner# command -v rrsync || ls /usr/share/doc/rsync/scripts/rrsync*
hetzner# docker info --format '{{.ServerVersion}} {{.Driver}}'; docker compose version
```

Decide from the output, and write the answers down:
- **`postgres-autopatch.sh` / `backup-postgres.sh`:** if they select containers by image
  (`postgres:*`) or by a name pattern that matches `ov-postgres`, they would patch or dump
  OpenVolley's database with KSCW's procedure. Add an explicit exclusion (match the label
  `com.docker.compose.project=openvolley`) **with a dated backup copy of the script**. This is
  the only KSCW-owned file the deploy may edit. If they use a fixed list of names, change nothing.
- **sshd:** if `AllowUsers`/`AllowGroups` is set, `ovbackup` must be added for the NAS pull
  (step 12), in a drop-in `/etc/ssh/sshd_config.d/60-ovbackup.conf`, then `sshd -t && systemctl reload ssh`.
- **rrsync:** Ubuntu's `rsync` package ships `/usr/bin/rrsync`. If it is missing, install it
  from `/usr/share/doc/rsync/scripts/rrsync` to `/usr/local/bin/rrsync` and use that path in step 12.
- **Coolify Docker cleanup** (Servers -> lucanepa-prod -> Docker Cleanup): it prunes unused images.
  Rollback images of OpenVolley would be pruned too; that is why `build-image.sh --ship` keeps a
  `.tar.gz` of each tag in `/opt/openvolley/images/`. Volumes are not at risk (bind mounts only).

## 2. Create the tunnel (lenovoserver)

`~/.cloudflared/cert.pem` (from `cloudflared tunnel login`) is scoped to **one zone**. `tunnel
route dns` creates records only in that zone; for any other zone it silently creates a wrong
name such as `backend.openvolley.app.<other-zone>`. Check which zone the cert belongs to (prints
only the zone id):

```bash
lenovo$ sed -n '/BEGIN ARGO TUNNEL TOKEN/,/END ARGO TUNNEL TOKEN/{//!p}' ~/.cloudflared/cert.pem | base64 -d | jq -r .zoneID
```

Compare it with the Zone ID on the `openvolley.app` overview page of the Cloudflare dashboard.

```bash
lenovo$ cloudflared tunnel create openvolley        # writes ~/.cloudflared/<TUNNEL-UUID>.json
lenovo$ cloudflared tunnel list | grep openvolley    # note the UUID
lenovo$ cloudflared tunnel token openvolley          # -> TUNNEL_TOKEN
```

Store the token and the credentials JSON in Vaultwarden ("OpenVolley tunnel"). The token is the
only credential the VM needs. It is the same on any VM that runs the stack.

Do **not** route `backend.openvolley.app` yet; that is the go-live switch (step 10).

## 3. Build and ship the image (lenovoserver)

```bash
lenovo$ git switch <merged branch> && git pull && git status --short     # clean tree
lenovo$ escoresheet/deploy/build-image.sh                                # local build + smoke
lenovo$ ssh hetzner 'install -d -m 750 /opt/openvolley /opt/openvolley/images'
lenovo$ escoresheet/deploy/build-image.sh --ship hetzner                 # prints the tag, e.g. openvolley-backend:1a2b3c4d5e6f
```

## 4. Copy the kit (lenovoserver -> hetzner)

```bash
lenovo$ rsync -rlt --chmod=D750,F640 --exclude=.env escoresheet/deploy/ hetzner:/opt/openvolley/
lenovo$ ssh hetzner 'chmod 750 /opt/openvolley/*.sh && chmod 644 /opt/openvolley/cloudflared/config.yml'
lenovo$ scp ~/ov-backup-public.asc hetzner:/root/ov-backup-public.asc
```

## 5. Host preparation (hetzner)

```bash
hetzner# cd /opt/openvolley
hetzner# ./host-prep.sh --check          # read-only; must end with "preflight ok"
hetzner# ./host-prep.sh                  # creates loop fs, sentinels, dirs, ovbackup, backup units
hetzner# findmnt /data/openvolley/pg; findmnt /data/openvolley/storage
hetzner# lsattr -d /data/openvolley/pg/.ovdata /data/openvolley/storage/.ovdata   # both ----i----
```

Size check: the storage filesystem must be at least 3 x the Phase-0 `scoresheets` total plus
5 GB. If not, rerun with `OV_STORAGE_SIZE=<n>G` **before** any data is in it (delete the empty
image, its fstab line and mountpoint first), or grow it later with
`umount; e2fsck -f; truncate -s <new>; resize2fs; mount` during a stop.

GPG public key and backup config:

```bash
hetzner# install -m 644 /root/ov-backup-public.asc /etc/openvolley/openvolley-backup.pub.asc && rm /root/ov-backup-public.asc
hetzner# gpg --homedir /var/lib/openvolley-backup/gnupg --show-keys --with-colons /etc/openvolley/openvolley-backup.pub.asc | awk -F: '$1=="fpr"{print $10; exit}'
hetzner# editor /etc/openvolley/backup.conf      # OV_GPG_FPR=<that fingerprint>, OV_KUMA_PUSH_URL=<backup push monitor>
```

Compare the fingerprint with `gpg --fingerprint openvolley-backup` on lenovoserver.

## 6. `.env` (hetzner)

```bash
hetzner# cd /opt/openvolley && install -m 600 env.example .env && editor .env
```

- `OV_BACKEND_IMAGE` = the tag from step 3.
- `OV_OWNER_PW`, `OV_APP_PW` = `openssl rand -hex 32` each (into Vaultwarden).
- `TUNNEL_TOKEN` from step 2.
- `RESEND_*`, `SMTP_*`, `CONTACT_EMAIL`, `REOPEN_PASSWORD_HASH` from the old backend's settings.
- `OV_MIN_MATCHES=0` until the data load (step 8).

```bash
hetzner# docker compose config -q && echo ok      # validates and interpolates; prints nothing secret
```

## 7. Postgres, and the mount-guard drill (hetzner)

```bash
hetzner# docker compose up -d ov-postgres && docker compose ps
```

Drill, before any data exists:

```bash
hetzner# docker compose stop ov-postgres && umount /data/openvolley/pg
hetzner# docker compose up -d ov-postgres; sleep 5
hetzner# docker compose logs --tail 3 ov-postgres      # "FATAL: /ovpg/.ovdata missing ... Refusing to start."
hetzner# ls -A /data/openvolley/pg                      # empty: nothing was created on the bare mountpoint
hetzner# docker compose stop ov-postgres && mount /data/openvolley/pg && docker compose up -d ov-postgres
hetzner# docker compose ps ov-postgres                  # healthy
hetzner# ls /data/openvolley/pg/state                   # "initialized": from now on an empty data/ refuses to start
```

## 8. Load the data (hetzner + lenovoserver)

Follow the migration plan, Phase 4a step 6 and §6, with these adaptations:
- Import directory: `/data/openvolley/pg/import` (inside the capped filesystem, mode 700).
- Container argument for `scripts/migrate/restore.sh`: the compose container,
  `$(docker compose -f /opt/openvolley/compose.yaml ps -q ov-postgres)`. Copy
  `escoresheet/backend/db/*.sql` and `escoresheet/backend/scripts/migrate/restore.sh` into the
  import directory next to `public.dump` and `auth_users.csv`, then:
  ```bash
  hetzner# bash /data/openvolley/pg/import/restore.sh --env-file /opt/openvolley/.env \
             "$(docker compose -f /opt/openvolley/compose.yaml ps -q ov-postgres)" /data/openvolley/pg/import
  ```
  Add `--expect-counts <file>` with the per-table counts from `introspect.txt` (one
  `<table> <count>` per line) to have them compared. It ends with the row counts and
  `OV_MIN_MATCHES=<90%>`; it refuses a database that already holds data (`--force` keeps
  it as `openvolley_pre_restore_<UTC>` and loads a fresh one). It logs which SQL directory
  it uses: the copies next to the script.
- `roles.sql` with the app password from `.env` (read by the script, never exported):
  ```bash
  hetzner# /opt/openvolley/apply-roles.sh < /data/openvolley/pg/import/roles.sql   # "ok: ov_app logs in and sees N matches"
  ```
- Storage: rsync the unpacked scoresheets (and the last 30 days of `backup/`) into
  `/data/openvolley/storage/`, then `chown -R 1000:1000 /data/openvolley/storage/{scoresheets,backup}`.
- Set `OV_MIN_MATCHES` in `.env` to 90% of the restored `matches` count.
- `shred -u /data/openvolley/pg/import/* && rmdir /data/openvolley/pg/import`.

## 9. Backend and tunnel up; checks from inside (hetzner)

```bash
hetzner# cd /opt/openvolley && docker compose up -d && docker compose ps     # 3 services, backend healthy
# (ov-backend exits with "FATAL: /data/storage/.ovdata missing" if the storage fs is not mounted)
hetzner# docker compose exec ov-backend node -e 'for (const p of ["/health/live","/health"]) fetch("http://127.0.0.1:8080"+p).then(async r=>console.log(p, r.status, await r.text()))'
hetzner# docker compose logs --tail 20 ov-tunnel                              # "Registered tunnel connection" (x4)
hetzner# ss -Htlnup | sort | diff /root/ov-ss-before.txt - && echo "no new listeners"
hetzner# docker ps --filter label=com.docker.compose.project=openvolley --format '{{.Names}}\t{{.Ports}}'   # Ports empty
hetzner# docker inspect coolify-proxy -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'      # no openvolley_*
hetzner# for n in openvolley_ov-internal openvolley_ov-edge; do docker network inspect -f '{{.Name}} internal={{.Internal}}: {{range .Containers}}{{.Name}} {{end}}' $n; done
hetzner# docker stats --no-stream $(docker compose ps -q)
```

Expected: `/health` 200 with `"db":"ok"`, catalog ok, floor ok, `sentinel` true, `diskFreeMB > 0`;
`ov-internal` holds only `ov-postgres` + `ov-backend`; `ov-edge` only `ov-backend` + `ov-tunnel`.

## 10. External checks, then go live (lenovoserver)

Pre-flight through the real tunnel on a throwaway name (already in `cloudflared/config.yml`):

```bash
lenovo$ cloudflared tunnel route dns openvolley ov-preflight.openvolley.app
lenovo$ cloudflared tunnel info openvolley                   # connector(s) from the hetzner IP
lenovo$ curl -s https://ov-preflight.openvolley.app/health | jq .
lenovo$ curl -s -o /dev/null -w '%{http_code}\n' https://ov-preflight.openvolley.app/nope    # 404 from the backend
lenovo$ node -e 'const w=new WebSocket("wss://ov-preflight.openvolley.app/?purpose=live");w.onopen=()=>{console.log("ws open");w.close()};w.onerror=()=>{console.error("ws error");process.exit(1)}'
lenovo$ for i in $(seq 100); do curl -s -o /dev/null -w '%{http_code}\n' https://ov-preflight.openvolley.app/health; done | sort | uniq -c   # 100 x 200
```

Also hold one WSS connection for 5 minutes without client pings (the server heartbeat must keep
it open), and restart `ov-postgres` during the hold: socket stays open, `/health/live` stays 200,
`/health` goes 503 and recovers. Check `docker compose logs ov-backend` shows real client IPs
(from `cf-connecting-ip`), not the tunnel container's address.

**Go live** (DNS):
1. Dashboard -> `openvolley.app` -> DNS: delete the old `backend` A record (dead Infomaniak) and
   the `pocketbase` record.
2. `lenovo$ cloudflared tunnel route dns openvolley backend.openvolley.app`
   This works only if step 2 showed the cert's zone **is** `openvolley.app`. Otherwise (or if
   the command reports another zone), delete any stray record it created and add the record by
   hand in the `openvolley.app` zone: **CNAME** `backend` -> `<TUNNEL-UUID>.cfargotunnel.com`,
   **Proxied**.
3. `lenovo$ curl -s https://backend.openvolley.app/health | jq .db` -> `"ok"`.
4. Delete the `ov-preflight` CNAME in the dashboard.
5. Continue with the Pages rebuild (migration plan Phase 4a step 8).

## 11. Backups (hetzner, then lenovoserver)

```bash
hetzner# systemctl start openvolley-backup-files.service && journalctl -u openvolley-backup-files -n 20 --no-pager
hetzner# ls -la /data/openvolley/backups && cat /var/lib/openvolley-status/last_backup
hetzner# systemctl enable --now openvolley-backup.timer openvolley-backup-files.timer && systemctl list-timers 'openvolley-*'
```

Restore test of that first dump (lenovoserver, private key). It boots the image recorded in
`~/ov-ops/shipped-hetzner` by step 3 and needs `escoresheet/backend/db/roles.sql` (a missing
file is a failure):

```bash
lenovo$ scp 'hetzner:/data/openvolley/backups/db-*' /dev/shm/ && escoresheet/deploy/restore-test.sh /dev/shm/db-<UTC>.dump.gpg
lenovo$ rm -f /dev/shm/db-*
```

Then install the weekly timer (it reads from the NAS, so step 12 first):

```bash
lenovo$ mkdir -p ~/ov-ops && ln -sfn ~/repos/openvolley/escoresheet/deploy ~/ov-ops/deploy
lenovo$ install -D -m 600 /dev/stdin ~/.config/openvolley/gpg-passphrase     # paste the passphrase, Ctrl-D
lenovo$ printf 'RT_KUMA_PUSH_URL=<restore-test push url>\n' > ~/.config/openvolley/restore-test.env
lenovo$ sudo install -m 644 escoresheet/deploy/systemd/openvolley-restore-test.{service,timer} /etc/systemd/system/
lenovo$ sudo systemctl daemon-reload && sudo systemctl enable --now openvolley-restore-test.timer
lenovo$ sudo systemctl start openvolley-restore-test.service && journalctl -u openvolley-restore-test -n 30 --no-pager
```

## 12. NAS pull (NAS + hetzner)

Follow the header of `nas-pull.sh`: key pair on the NAS, pinned host key, and on hetzner one line in
`/var/lib/ovbackup/.ssh/authorized_keys`:

```
command="/usr/bin/rrsync -ro /data/openvolley/backups",restrict,from="<nas-tailnet-ip>" ssh-ed25519 AAAA... nas-ovpull
```

On the NAS: copy `nas-pull.sh` to `/volume1/backups/openvolley/`, write `nas-pull.conf` with
`NP_REMOTE=ovbackup@<hetzner-tailnet-ip>` and `NP_PUSH_URL`, run it once by hand, then add a DSM
Task Scheduler job (root, daily 04:30): `bash /volume1/backups/openvolley/nas-pull.sh`. Enable
Snapshot Replication on the share: 7 daily, 4 weekly, 6 monthly.

Check that the key really is read-only: from the NAS,
`ssh -i <key> ovbackup@<ip> ls` must fail and `rsync ... ovbackup@<ip>:./ /tmp/x --dry-run` must list files.

## 13. Monitoring

- Uptime Kuma (on hetzner): HTTP keyword `"db":"ok"` on `https://backend.openvolley.app/health`, 60 s.
- Push monitors: backup (2 h), NAS pull (26 h), restore test (8 days). Alerts to ntfy.
- Beszel: alerts at 80% of the `ov-backend` and `ov-postgres` memory limits and at 80% use of
  `/data/openvolley/pg` and `/data/openvolley/storage`.
- diun: notify-only for `postgres:17-alpine`, `node:22-slim`, `cloudflare/cloudflared`.
- The synthetic probe on lenovoserver (migration plan §8) points at `backend.openvolley.app`.

---

## Match-day rules (deploy freeze)

From **Friday 17:00 to Sunday 23:59**: no `build-image.sh --ship`, no `docker compose up`, no edits
in `/opt/openvolley`, no `host-prep.sh`, no Postgres image bump. Relay rooms live in memory, so any
backend restart during a match drops every live room. On Friday: check `/health`, the probe
history, `systemctl list-timers 'openvolley-*'` and the newest NAS file.

## Updating

Backend release (Monday to Friday, before 17:00):

```bash
lenovo$ git pull && escoresheet/deploy/build-image.sh --ship hetzner          # prints NEW tag
hetzner# cd /opt/openvolley
hetzner# grep ^OV_BACKEND_IMAGE= .env | tee -a DEPLOYED.log                  # remember the current tag
hetzner# systemctl start openvolley-backup.service                            # fresh dump before the change
hetzner# sed -i 's|^OV_BACKEND_IMAGE=.*|OV_BACKEND_IMAGE=openvolley-backend:<NEW>|' .env
hetzner# env | grep -E '^(OV_|TUNNEL_TOKEN)=' ; docker compose config --images | grep backend   # nothing exported; shows <NEW>
hetzner# docker compose up -d ov-backend && docker compose ps
hetzner# docker compose exec ov-backend node -e 'fetch("http://127.0.0.1:8080/health").then(async r=>console.log(r.status, await r.text()))'
hetzner# echo "$(date -u +%FT%TZ) deployed openvolley-backend:<NEW>" >> DEPLOYED.log
```

Kit changes (`compose.yaml`, `cloudflared/config.yml`, scripts): rsync as in step 4 (never `.env`),
then `docker compose config -q && docker compose up -d` (recreates only what changed). Script
changes also need `./host-prep.sh` (reinstalls `backup-openvolley.sh` and the units).

Postgres minor bump (monthly, weekday): set `OV_POSTGRES_IMAGE=postgres:17.<n>-alpine`,
`docker compose pull ov-postgres && docker compose up -d ov-postgres`, check `/health`, then run the
restore test.

## Apply a new db migration

A new `escoresheet/backend/db/NNN_*.sql` (for example `006_matches_updated_at.sql`) reaches a
running database only by hand; `restore.sh` runs them on a restore only. Each file is
idempotent. Run the files the database does not have yet, in number order, as `ov_owner`, then
`roles.sql`, before or together with the backend that expects them:

```bash
lenovo$  ssh hetzner 'cd /opt/openvolley && docker compose exec -T ov-postgres psql -U ov_owner -d openvolley -v ON_ERROR_STOP=1' \
           < escoresheet/backend/db/006_matches_updated_at.sql
lenovo$  ssh hetzner /opt/openvolley/apply-roles.sh < escoresheet/backend/db/roles.sql   # "ok: ov_app logs in and sees N matches"
```

Do the same on the dev database.

## Rollback

| Situation | Action |
|---|---|
| Before go-live (step 10) | `docker compose down`. Nothing public changed. |
| Bad backend release | Put the previous tag (from `DEPLOYED.log`) back into `OV_BACKEND_IMAGE`, check `docker compose config --images` shows it (if not, the shell exports `OV_BACKEND_IMAGE`: see Shell hygiene), and `docker compose up -d ov-backend`. If the image was pruned: `gunzip -c images/openvolley-backend-<sha>.tar.gz \| docker load` first. Same database and storage, so sessions survive and no data moves. If the release changed the schema, first restore the pre-deploy dump into a side container (as `restore-test.sh` does) and compare. |
| Data corruption | "Restore the database" below. |
| VM lost or KSCW under pressure | Same compose on lenovoserver with the **same `TUNNEL_TOKEN`** and the newest NAS dump (RUNBOOK-move-to-own-vm.md, steps 3-9, with lenovoserver as the target). No DNS change. Make sure the hetzner `ov-tunnel` is stopped, or Cloudflare splits traffic between both. |
| Anything on a match day | LAN mode / Pi / desktop build from `pre-selfhost`. Scoring never depends on the cloud. |

## Restore the database (data corruption)

A restore goes into a **fresh** database (`restore-db.sh`), never over the live one with
`pg_restore --clean`: that keeps going after errors (a half-restored database looks fine) and
does not remove objects or rows missing from the dump. The script runs `pg_restore
--exit-on-error --single-transaction`, keeps the current database as
`openvolley_pre_restore_<UTC>`, and on any error or count mismatch puts everything back as it was.

```bash
# 1. stop writes and the backup timers (a restored, smaller DB must not trip or feed the count guard)
hetzner# systemctl stop openvolley-backup.timer openvolley-backup-files.timer
hetzner# cd /opt/openvolley && docker compose stop ov-tunnel ov-backend
# 2. newest GOOD dump + its .counts, decrypted on lenovoserver (private key), sent to the pg fs
lenovo$  set -o pipefail; D=db-<UTC>                                # from the NAS: /volume1/backups/openvolley/hetzner
lenovo$  scp "nas:/volume1/backups/openvolley/hetzner/$D.*" /dev/shm/ && gpg -o /dev/shm/db.dump -d /dev/shm/$D.dump.gpg
lenovo$  ssh hetzner 'install -d -m 700 /data/openvolley/pg/import' && scp /dev/shm/db.dump /dev/shm/$D.counts hetzner:/data/openvolley/pg/import/
lenovo$  shred -u /dev/shm/db.dump && rm -f /dev/shm/$D.*
# 3. restore (refuses while backend/tunnel/timers run; checks the .counts file)
hetzner# ./restore-db.sh --counts /data/openvolley/pg/import/db-<UTC>.counts /data/openvolley/pg/import/db.dump
# 4. roles, then the backend
lenovo$  ssh hetzner /opt/openvolley/apply-roles.sh < escoresheet/backend/db/roles.sql
hetzner# env | grep -E '^(OV_|TUNNEL_TOKEN)=' ; docker compose up -d && docker compose ps
hetzner# docker compose exec ov-backend node -e 'fetch("http://127.0.0.1:8080/health").then(async r=>console.log(r.status, await r.text()))'
# 5. backups back on (restore-db.sh touched counts.reset: the first run takes the restored counts as baseline)
hetzner# systemctl start openvolley-backup.service && journalctl -u openvolley-backup -n 5 --no-pager
hetzner# systemctl enable --now openvolley-backup.timer openvolley-backup-files.timer
# 6. clean up once satisfied (the old database stays for comparison until then)
hetzner# shred -u /data/openvolley/pg/import/* && rmdir /data/openvolley/pg/import
hetzner# docker compose exec -T ov-postgres psql -U ov_owner -d postgres -c 'DROP DATABASE "openvolley_pre_restore_<UTC>"'
```

If `/health` reports the floor below `OV_MIN_MATCHES` because the dump is older, lower it in
`.env` and `docker compose up -d ov-backend`. Devices re-sync what they still have queued. If
the restore-test floor (`~/ov-ops/restore-floor` on lenovoserver) is above the restored counts,
delete that file after the next good backup.

If `ov-postgres` itself refuses to start with "no PG_VERSION, but a cluster existed", PGDATA was
lost: stop it, move `/data/openvolley/pg/data` aside (`install -d -o 70 -g 70 -m 700` a new
one), remove `/data/openvolley/pg/state/initialized`, start `ov-postgres` (fresh initdb), then
follow the steps above.

## Uninstall (removes every trace from the VM)

```bash
hetzner# cd /opt/openvolley && docker compose down --rmi local     # containers + networks
hetzner# systemctl disable --now openvolley-backup.timer openvolley-backup-files.timer
hetzner# rm -f /etc/systemd/system/openvolley-backup* /usr/local/sbin/backup-openvolley.sh && systemctl daemon-reload
hetzner# umount /data/openvolley/pg /data/openvolley/storage
hetzner# sed -i '/openvolley/d' /etc/fstab && systemctl daemon-reload      # only our lines contain "openvolley"
hetzner# chattr -i /data/openvolley/pg /data/openvolley/storage
hetzner# rm -rf /data/openvolley /var/lib/openvolley /var/lib/openvolley-status /var/lib/openvolley-backup /etc/openvolley /opt/openvolley
hetzner# userdel -r ovbackup
hetzner# docker rmi $(docker images openvolley-backend -q) 2>/dev/null; true
```

Check `grep -n openvolley /etc/fstab` prints nothing first, and keep the off-site copies on the NAS.
Then revert the exclusion in `postgres-autopatch.sh` / `backup-postgres.sh` and the sshd drop-in,
if step 1 added them.
