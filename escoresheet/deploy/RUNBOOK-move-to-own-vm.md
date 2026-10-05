# Runbook: move OpenVolley to its own VM (Option B)

Moves the whole stack from `lucanepa-prod` (`hetzner`) to a dedicated small VM. Nothing in the
kit changes: same `compose.yaml`, same `.env`, same **tunnel token**, so `backend.openvolley.app`
keeps pointing at the same tunnel and **DNS does not change**. Cloudflare sends traffic to
whichever connector of that tunnel is running.

**Target:** under 15 minutes of backend downtime (write path), on a weekday, never Friday 17:00
to Sunday 23:59. During the window, devices keep scoring offline and queue their sync jobs;
livescore pauses.

Hosts: `old` = hetzner (`ssh hetzner`), `new` = the new VM (`ssh ov-new`, root), lenovoserver
for building and the private key.

Never `source` the `.env` file into a shell (RUNBOOK-hetzner.md, Shell hygiene): compose would
prefer the exported values over later edits. `apply-roles.sh` reads the one value it needs.
Run `set -o pipefail` in the lenovoserver shell before the `ssh ... | ssh ...` pipes below, so a
failing `pg_dump` or a dropped ssh fails the whole command.

The same procedure, with lenovoserver as `new`, is the cold-standby recovery when hetzner is lost
(then skip every step that reads from `old` and restore from the newest NAS dump instead).

---

## Days before: prepare the new VM (no downtime)

### 1. Create the VM

Hetzner Cloud, same project, location near the old VM (e.g. `fsn1`/`nbg1`):
- **Type:** the smallest shared-vCPU **x86** type (CX22 or its current successor: 2 vCPU,
  4 GB). Stay on x86: the backend image is built `linux/amd64`, and a physical copy of
  PGDATA is only valid on the same architecture.
- **Image:** Ubuntu 24.04 LTS. **SSH key:** the owner's key. **Backups:** optional (Hetzner
  snapshots are a bonus, the NAS copies are the real backups).
- **Firewall:** a Hetzner Cloud Firewall with **no inbound rules** (Tailscale and the tunnel
  are outbound-only). Public SSH is closed from the first boot, so Tailscale must come up
  **without** an SSH session: cloud-init installs it with a one-time auth key.

Tailscale admin console -> Settings -> Keys -> Generate auth key: **not reusable**, expiry 1 hour,
pre-approved, tag as the other servers. The key also stays readable in the VM's metadata
(user data), which is why it must be single-use and short-lived.

```bash
lenovo$ install -m 600 /dev/null /dev/shm/ov-ci.yaml && cat > /dev/shm/ov-ci.yaml <<'EOF'
#cloud-config
package_update: true
package_upgrade: true
packages: [rsync, jq, unattended-upgrades, e2fsprogs]
runcmd:
  - [sh, -c, "curl -fsSL https://tailscale.com/install.sh | sh"]
  - [tailscale, up, --auth-key=TSKEY, --hostname=openvolley-1]
  - [sh, -c, "curl -fsSL https://get.docker.com | sh"]
EOF
lenovo$ read -rs TSKEY && sed -i "s|TSKEY|$TSKEY|" /dev/shm/ov-ci.yaml; unset TSKEY     # paste the key
lenovo$ hcloud server create --name openvolley-1 --type cx22 --image ubuntu-24.04 --location fsn1 \
          --ssh-key <key-name> --firewall ov-no-inbound --user-data-from-file /dev/shm/ov-ci.yaml
lenovo$ shred -u /dev/shm/ov-ci.yaml
```

### 2. Base system

Wait for `openvolley-1` to appear in `tailscale status` (2-4 minutes), add `ov-new` to
`~/.ssh/config` on lenovoserver (tailnet IP, user root), then:

```bash
new# cloud-init status --wait && tail -n 20 /var/log/cloud-init-output.log
new# docker version --format '{{.Server.Version}}' && docker compose version && tailscale status --self
```

If the VM never joins the tailnet (typo in the key, expired key): Hetzner Console -> the server ->
Rescue -> **Reset root password**, log in on the web console, read
`/var/log/cloud-init-output.log`, and run `tailscale up --auth-key=<new key>` there. Do not
open port 22 in the cloud firewall.

### 3. Kit, host prep, image

```bash
lenovo$ ssh ov-new 'install -d -m 750 /opt/openvolley /opt/openvolley/images'
lenovo$ rsync -rlt --exclude=.env escoresheet/deploy/ ov-new:/opt/openvolley/
lenovo$ escoresheet/deploy/build-image.sh --ship ov-new            # same commit as running on old
new#    cd /opt/openvolley && ./host-prep.sh --check && ./host-prep.sh
```

On a VM of its own the size caps can be larger (`OV_PG_SIZE=20G OV_STORAGE_SIZE=40G
./host-prep.sh`); the layout stays identical.

### 4. Secrets and config (copied, never typed)

```bash
lenovo$ ssh hetzner 'cat /opt/openvolley/.env' | ssh ov-new 'umask 077; cat > /opt/openvolley/.env'
lenovo$ ssh hetzner 'cat /etc/openvolley/openvolley-backup.pub.asc' | ssh ov-new 'cat > /etc/openvolley/openvolley-backup.pub.asc'
lenovo$ ssh hetzner 'cat /etc/openvolley/backup.conf' | ssh ov-new 'cat > /etc/openvolley/backup.conf'
new#    cd /opt/openvolley && grep ^OV_BACKEND_IMAGE= .env && docker image inspect "$(sed -n 's/^OV_BACKEND_IMAGE=//p' .env)" >/dev/null && echo image-present
new#    docker compose config -q && echo ok
```

### 5. Start only Postgres; dry-run the data move

```bash
new# cd /opt/openvolley && docker compose up -d ov-postgres && docker compose ps
```

Dry run (live system, no downtime; proves the pipe and gives a timing):

```bash
lenovo$ set -o pipefail
lenovo$ time (ssh hetzner 'docker compose --project-directory /opt/openvolley exec -T ov-postgres pg_dump -U ov_owner -d openvolley -Fc' \
          | ssh ov-new '/opt/openvolley/restore-db.sh --drop-previous -')
lenovo$ ssh ov-new /opt/openvolley/apply-roles.sh < escoresheet/backend/db/roles.sql
```

`restore-db.sh` restores into a fresh database in one transaction (`--exit-on-error
--single-transaction`): a truncated stream or any error leaves the previous state untouched and
the command fails. `--drop-previous` drops the database it replaced (on `new` that is only the
empty initial one or an earlier dry run).

### 6. Pre-sync storage (live, repeatable)

Give the new VM a temporary pull key to the old one (removed in step 13):

```bash
new#    ssh-keygen -t ed25519 -N '' -C "ov-move-$(date +%F)-REMOVE-AFTER-MOVE" -f /root/.ssh/ov-move
hetzner# cp -p /root/.ssh/authorized_keys /root/.ssh/authorized_keys.ov-move-bak
hetzner# echo 'from="<new-tailnet-ip>",restrict,command="/usr/bin/rrsync -ro /data/openvolley/storage" <contents of new:/root/.ssh/ov-move.pub>' >> /root/.ssh/authorized_keys
hetzner# grep -c 'REMOVE-AFTER-MOVE' /root/.ssh/authorized_keys          # 1
new#    rsync -aH --numeric-ids --delete --exclude=.ovdata --exclude=lost+found -e 'ssh -i /root/.ssh/ov-move' root@<old-tailnet-ip>:./ /data/openvolley/storage/
```

`.ovdata` is excluded because each filesystem keeps its own immutable sentinel.

This is a root key on KSCW's production host, so it is as narrow as sshd allows (`from=` the new
VM's tailnet IP only, `restrict`, forced `rrsync -ro` limited to the storage directory), carries
a dated `REMOVE-AFTER-MOVE` marker, and step 13 removes it with a check. (The `ovbackup` user
cannot be used instead without changing ownership or ACLs of the live storage files.) If the
move is postponed by more than a few days, remove the line now and re-add it before step 6.

---

## Cutover day (downtime starts at step 7, ends at step 10)

Announce the window. Have the Pi / LAN binary ready, as on any match day.

### 7. Stop writes on old (T+0)

```bash
hetzner# cd /opt/openvolley && docker compose stop ov-tunnel ov-backend
hetzner# systemctl stop openvolley-backup.timer openvolley-backup-files.timer
hetzner# systemctl start openvolley-backup.service        # final encrypted dump, as a safety net (Postgres still up)
```

From here `backend.openvolley.app` returns Cloudflare 1033 (no connector). Clients queue.

### 8. Final data move (T+2)

```bash
lenovo$ set -o pipefail
lenovo$ ssh hetzner 'docker compose --project-directory /opt/openvolley exec -T ov-postgres pg_dump -U ov_owner -d openvolley -Fc' \
          | ssh ov-new '/opt/openvolley/restore-db.sh --drop-previous -' && echo RESTORE-OK
lenovo$ ssh ov-new /opt/openvolley/apply-roles.sh < escoresheet/backend/db/roles.sql
new#    rsync -aH --numeric-ids --delete --exclude=.ovdata --exclude=lost+found -e 'ssh -i /root/.ssh/ov-move' root@<old-tailnet-ip>:./ /data/openvolley/storage/
```

No `RESTORE-OK`: stop here, nothing on `new` changed; fix and repeat step 8 (or abort: `docker
compose up -d` on old). Counts must match exactly (nothing writes any more):

```bash
Q="select (select count(*) from public.matches),(select count(*) from public.events),(select count(*) from auth.users),(select count(*) from auth.app_sessions)"
lenovo$ for h in hetzner ov-new; do ssh $h "docker compose --project-directory /opt/openvolley exec -T ov-postgres psql -U ov_owner -d openvolley -At -c \"$Q\""; done
lenovo$ for h in hetzner ov-new; do ssh $h 'find /data/openvolley/storage -type f | wc -l'; done
```

### 9. Stop old completely, start new (T+8)

Order matters: the old tunnel must be down before the new one starts, so Cloudflare never
balances between two databases.

```bash
hetzner# cd /opt/openvolley && docker compose stop          # everything on old is now stopped
new#     cd /opt/openvolley && docker compose up -d && docker compose ps
new#     docker compose logs --tail 20 ov-tunnel             # "Registered tunnel connection"
```

### 10. Verify (T+10, downtime ends)

```bash
lenovo$ cloudflared tunnel info openvolley                   # connectors only from the NEW VM's IP
lenovo$ curl -s https://backend.openvolley.app/health | jq '{status, db, floor, sentinel}'
lenovo$ node -e 'const w=new WebSocket("wss://backend.openvolley.app/?purpose=live");w.onopen=()=>{console.log("ws open");w.close()};w.onerror=()=>process.exit(1)'
```

Sign in on one device (sessions moved with the database, so existing tokens stay valid) and open
one scoresheet. Watch the probe and Kuma for 30 minutes.

---

## After the cutover

### 11. Backups on the new VM

```bash
new# systemctl start openvolley-backup-files.service && cat /var/lib/openvolley-status/last_backup
new# systemctl enable --now openvolley-backup.timer openvolley-backup-files.timer
```

NAS: add the NAS key to `new:/var/lib/ovbackup/.ssh/authorized_keys` (same line as on hetzner),
re-pin the host key (`ssh-keyscan -t ed25519 <new-tailnet-ip> > .../known_hosts`, compare the
fingerprint), set `NP_REMOTE=ovbackup@<new-tailnet-ip>` in `nas-pull.conf`, run `nas-pull.sh` once.
Keep the old pulled files on the NAS (no `--delete`).

### 12. Monitoring

Update Beszel (add the new VM's agent; alerts on the two loop filesystems and container
limits), the restore-test source if it changed, and its image: in
`~/.config/openvolley/restore-test.env` set `RT_TAG_FILE=/home/lucanepa/ov-ops/shipped-ov-new` (written by
`build-image.sh --ship ov-new`). The Kuma HTTP monitor needs no change
(same hostname).

### 13. Decommission old (after 7 days and one passing weekly restore test from the new VM's backups)

Until then the stopped stack on hetzner is the fallback: to go back, stop `new` completely,
reverse-copy anything written since the cutover (step 8 in the other direction), and
`docker compose up -d` on hetzner.

Then on hetzner, follow "Uninstall" in RUNBOOK-hetzner.md and remove the temporary root key:

```bash
hetzner# sed -i '/REMOVE-AFTER-MOVE/d' /root/.ssh/authorized_keys && ! grep -n 'ov-move\|REMOVE-AFTER-MOVE' /root/.ssh/authorized_keys && echo removed
hetzner# rm -f /root/.ssh/authorized_keys.ov-move-bak
new#     rm -f /root/.ssh/ov-move /root/.ssh/ov-move.pub
```
 Remove the
`postgres-autopatch.sh` / `backup-postgres.sh` exclusions and the sshd drop-in if they were added.

---

## Timing budget

| Step | Expected |
|---|---|
| 7 stop + final dump | 1-2 min |
| 8 dump/restore (tens of MB) + storage delta + counts | 3-6 min |
| 9 stop old, start new, tunnel registers | 1-2 min |
| 10 verify | 2-3 min |
| **Total** | **7-13 min** |

If the dry run in step 5 took more than 5 minutes, or the storage delta in step 6 is large,
repeat step 6 just before step 7 and start the window earlier in the day.
