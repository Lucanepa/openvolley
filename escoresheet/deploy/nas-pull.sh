#!/bin/bash
# nas-pull.sh: runs ON THE NAS (Synology DSM Task Scheduler, nightly 04:30,
# as root or a dedicated user). PULLS the encrypted OpenVolley backups from
# the server over Tailscale with a restricted, read-only key.
#
# Why pull: a compromised server holds no credential that can reach, change
# or delete the NAS copies. The server side only has the public GPG key, so
# the NAS stores ciphertext only. No --delete: files removed on the server
# (rotation) stay on the NAS; the NAS prunes by its own retention below, and
# btrfs snapshots (Snapshot Replication: 7 daily / 4 weekly / 6 monthly) keep
# history beyond that.
#
# One-time setup (see README.md "Off-site copy"):
#   NAS:    ssh-keygen -t ed25519 -N '' -C nas-ovpull -f /volume1/backups/openvolley/.ssh/id_ovpull
#           ssh-keyscan -t ed25519 <server-tailnet-ip> > /volume1/backups/openvolley/.ssh/known_hosts
#           (compare the fingerprint with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server)
#   server: append to /var/lib/ovbackup/.ssh/authorized_keys (one line):
#           command="/usr/bin/rrsync -ro /data/openvolley/backups",restrict,from="<nas-tailnet-ip>" ssh-ed25519 AAAA... nas-ovpull
#
# Settings (env, or ${NP_CONF:-/volume1/backups/openvolley/nas-pull.conf}):
#   NP_REMOTE          ovbackup@<server-tailnet-ip>          (required)
#   NP_KEY             /volume1/backups/openvolley/.ssh/id_ovpull
#   NP_KNOWN_HOSTS     /volume1/backups/openvolley/.ssh/known_hosts
#   NP_DEST            /volume1/backups/openvolley/hetzner
#   NP_KEEP_DB_DAYS    30   hourly dumps kept on the NAS
#   NP_KEEP_FILES_DAYS 90   nightly storage tars kept on the NAS
#   NP_MAX_AGE_H       3    newest db dump on the NAS must be younger than this
#   NP_PUSH_URL        optional Uptime Kuma push URL (status=up/down)
set -euo pipefail
umask 077

NP_CONF=${NP_CONF:-/volume1/backups/openvolley/nas-pull.conf}
if [ -f "$NP_CONF" ]; then
  # shellcheck source=/dev/null
  . "$NP_CONF"
fi

NP_REMOTE=${NP_REMOTE:?set NP_REMOTE=ovbackup@<server-tailnet-ip>}
NP_KEY=${NP_KEY:-/volume1/backups/openvolley/.ssh/id_ovpull}
NP_KNOWN_HOSTS=${NP_KNOWN_HOSTS:-/volume1/backups/openvolley/.ssh/known_hosts}
NP_DEST=${NP_DEST:-/volume1/backups/openvolley/hetzner}
NP_KEEP_DB_DAYS=${NP_KEEP_DB_DAYS:-30}
NP_KEEP_FILES_DAYS=${NP_KEEP_FILES_DAYS:-90}
NP_MAX_AGE_H=${NP_MAX_AGE_H:-3}
NP_PUSH_URL=${NP_PUSH_URL:-}

log() { printf '[nas-pull %s] %s\n' "$(date -u +%FT%TZ)" "$*"; }
push() {
  [ -n "$NP_PUSH_URL" ] || return 0
  curl -fsS -m 10 -G --data-urlencode "status=$1" --data-urlencode "msg=$2" "$NP_PUSH_URL" >/dev/null 2>&1 || true
}
fail() { log "FAILED: $1"; push down "$1"; exit 1; }

[ -r "$NP_KEY" ] || fail "key not readable: $NP_KEY"
[ -s "$NP_KNOWN_HOSTS" ] || fail "pinned known_hosts missing: $NP_KNOWN_HOSTS"
mkdir -p "$NP_DEST"

SSH="ssh -i $NP_KEY -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$NP_KNOWN_HOSTS -o ConnectTimeout=20"

# Only completed backup files: the server writes .<name>.partial first and
# renames, so dotfiles are excluded. rrsync roots the remote path at the
# server's backup dir; "./" is that dir.
log "pulling from ${NP_REMOTE}"
rsync -rt --partial-dir=.rsync-partial --timeout=600 \
  --exclude='.*' \
  --include='db-*.dump.gpg' --include='db-*.counts' \
  --include='scoresheets-*.tar.gpg' --include='snapshots-*.tar.gpg' \
  --exclude='*' \
  -e "$SSH" "${NP_REMOTE}:./" "$NP_DEST/" \
  || fail "rsync exit $?"

# NAS-side retention (independent of the server's).
find "$NP_DEST" -maxdepth 1 -type f \( -name 'db-*.dump.gpg' -o -name 'db-*.counts' \) \
  -mtime +"$NP_KEEP_DB_DAYS" -exec rm -f {} \;
find "$NP_DEST" -maxdepth 1 -type f \( -name 'scoresheets-*.tar.gpg' -o -name 'snapshots-*.tar.gpg' \) \
  -mtime +"$NP_KEEP_FILES_DAYS" -exec rm -f {} \;

# Freshness: rsync -t kept the server mtimes, so this checks the server's
# backups are still being produced, not only that the pull ran.
fresh=$(find "$NP_DEST" -maxdepth 1 -type f -name 'db-*.dump.gpg' -mmin -"$((NP_MAX_AGE_H * 60))" | wc -l)
[ "$fresh" -gt 0 ] || fail "no db dump younger than ${NP_MAX_AGE_H} h on the NAS"

newest=$(find "$NP_DEST" -maxdepth 1 -type f -name 'db-*.dump.gpg' | sed 's#.*/##' | sort | tail -n1)
total=$(find "$NP_DEST" -maxdepth 1 -type f -name '*.gpg' | wc -l)
log "ok: newest ${newest}, ${total} encrypted files on the NAS"
push up "$newest"
