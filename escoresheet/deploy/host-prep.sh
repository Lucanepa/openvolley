#!/usr/bin/env bash
# host-prep.sh: prepare a Linux VM for the OpenVolley compose stack.
#
#   sudo ./host-prep.sh --check   # read-only preflight, changes nothing
#   sudo ./host-prep.sh           # apply (idempotent; safe to re-run)
#
# What it does (and nothing else):
#   - two ext4 loop filesystems with hard size caps
#       ${OV_IMG_DIR}/pg.img      (8 GB)  -> ${OV_BASE}/pg
#       ${OV_IMG_DIR}/storage.img (15 GB) -> ${OV_BASE}/storage
#     mounted via /etc/fstab with `nofail` (a broken image never blocks boot,
#     Docker or any other tenant), a `.ovdata` sentinel inside each, and
#     `chattr +i` on the bare mountpoints so nothing can write into them while
#     they are unmounted
#   - ${OV_STATUS_DIR} (last_backup lives here; read-only in the backend)
#   - system user `ovbackup` (read-only rrsync target for the NAS pull)
#   - ${OV_BACKUP_DIR} root:ovbackup 2750
#   - ${OV_ETC_DIR} (backup.conf, GPG public key) and /var/lib/openvolley-backup/gnupg
#   - ${OV_OPT_DIR} layout (images/ for saved rollback images)
#   - installs backup-openvolley.sh and the systemd units if they sit next to
#     this script (timers are installed, NOT enabled)
#
# It never touches Docker networks, other containers, Coolify, Traefik, other
# users' files, or any path outside the ones listed above plus one appended
# block in /etc/fstab (backed up first). It refuses to run when ${OV_BASE}
# (or anything it would create) already belongs to something else.
set -euo pipefail
umask 022
PATH=$PATH:/usr/sbin:/sbin

OV_BASE=${OV_BASE:-/data/openvolley}
OV_IMG_DIR=${OV_IMG_DIR:-/var/lib/openvolley}
OV_PG_SIZE=${OV_PG_SIZE:-8G}
OV_STORAGE_SIZE=${OV_STORAGE_SIZE:-15G}
OV_STATUS_DIR=${OV_STATUS_DIR:-/var/lib/openvolley-status}
OV_BACKUP_DIR=${OV_BACKUP_DIR:-${OV_BASE}/backups}
OV_OPT_DIR=${OV_OPT_DIR:-/opt/openvolley}
OV_ETC_DIR=${OV_ETC_DIR:-/etc/openvolley}
OV_PROJECT=${OV_PROJECT:-openvolley}
OV_MIN_FREE_AFTER_GB=${OV_MIN_FREE_AFTER_GB:-20}
OV_FSTAB=${OV_FSTAB:-/etc/fstab}
PG_UID=70        # postgres user in postgres:*-alpine
NODE_UID=1000    # node user in node:*-slim
MARKER="${OV_BASE}/.openvolley-host"
KIT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)

MODE=apply
case "${1:-}" in
  --check) MODE=check ;;
  "") ;;
  -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
  *) echo "usage: $0 [--check]" >&2; exit 2 ;;
esac

PROBLEMS=0
log()  { printf '[host-prep] %s\n' "$*"; }
warn() { printf '[host-prep] WARNING: %s\n' "$*" >&2; }
bad()  { printf '[host-prep] REFUSE: %s\n' "$*" >&2; PROBLEMS=$((PROBLEMS + 1)); }
die()  { printf '[host-prep] FATAL: %s\n' "$*" >&2; exit 1; }

size_bytes() {  # 8G / 512M / 1024 -> bytes
  local v=$1 n u
  n=${v%[KkMmGgTt]}; u=${v#"$n"}
  case "$u" in
    "") echo "$n" ;; [Kk]) echo $((n * 1024)) ;; [Mm]) echo $((n * 1024 ** 2)) ;;
    [Gg]) echo $((n * 1024 ** 3)) ;; [Tt]) echo $((n * 1024 ** 4)) ;;
  esac
}

# --- the two filesystems: name label size ------------------------------------
FS_LIST=("pg ovpg ${OV_PG_SIZE}" "storage ovstorage ${OV_STORAGE_SIZE}")

# Backing file of the loop device mounted at $1, or empty.
mounted_backing_file() {
  local src
  src=$(findmnt -rn -o SOURCE --mountpoint "$1" 2>/dev/null | head -n1) || true
  [[ -n "$src" ]] || return 0
  if [[ "$src" == /dev/loop* ]]; then
    losetup -n -O BACK-FILE "$src" 2>/dev/null | sed 's/ *$//' || true
  else
    echo "$src"
  fi
}

fstab_line_for() {  # $1 = mountpoint -> matching non-comment fstab line(s)
  awk -v mp="$1" '$1 !~ /^#/ && $2 == mp' "$OV_FSTAB" 2>/dev/null || true
}

# ============================================================================
# Preflight (both modes). Collects every problem, then refuses if any.
# ============================================================================
preflight() {
  log "mode=${MODE} base=${OV_BASE} images=${OV_IMG_DIR} backups=${OV_BACKUP_DIR}"

  [[ "$(uname -s)" == Linux ]] || die "Linux only"
  if [[ "$MODE" == apply && $EUID -ne 0 ]]; then die "run as root (or use --check)"; fi

  local c
  for c in docker findmnt mountpoint losetup blkid mkfs.ext4 fallocate chattr lsattr awk useradd install stat df; do
    command -v "$c" >/dev/null 2>&1 || bad "required command missing: $c"
  done

  # Docker present and answering; compose v2 plugin present.
  if ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
    bad "docker daemon not reachable (is Docker installed and running?)"
  else
    log "docker $(docker version --format '{{.Server.Version}}')"
  fi
  if ! docker compose version >/dev/null 2>&1; then
    bad "docker compose v2 plugin missing"
  fi

  # --- OV_BASE ownership --------------------------------------------------------
  if [[ -e "$OV_BASE" && ! -d "$OV_BASE" ]]; then
    bad "${OV_BASE} exists and is not a directory"
  elif [[ -d "$OV_BASE" && ! -f "$MARKER" ]]; then
    if mountpoint -q "$OV_BASE"; then
      bad "${OV_BASE} is a mountpoint ($(findmnt -rn -o SOURCE --mountpoint "$OV_BASE")) not created by host-prep"
    fi
    if [[ -n "$(ls -A "$OV_BASE" 2>/dev/null)" ]]; then
      bad "${OV_BASE} exists, is not empty and was not created by host-prep (no ${MARKER}); contents: $(find "$OV_BASE" -mindepth 1 -maxdepth 1 -printf '%f ' | head -c 300)"
    else
      warn "${OV_BASE} exists but is empty; it will be adopted"
    fi
  fi

  # Mounts at or below OV_BASE must be exactly our two loop images.
  local tgt
  while read -r tgt; do
    [[ -n "$tgt" ]] || continue
    local ok=0 entry name label size
    for entry in "${FS_LIST[@]}"; do
      read -r name label size <<<"$entry"
      if [[ "$tgt" == "${OV_BASE}/${name}" && "$(mounted_backing_file "$tgt")" == "${OV_IMG_DIR}/${name}.img" ]]; then ok=1; fi
    done
    (( ok )) || bad "foreign mount under ${OV_BASE}: ${tgt} <- $(findmnt -rn -o SOURCE --mountpoint "$tgt")"
  done < <(findmnt -rn -o TARGET | awk -v b="$OV_BASE" 'index($0, b) == 1 && (length($0) == length(b) || substr($0, length(b) + 1, 1) == "/")')

  # Containers using our paths must belong to compose project ${OV_PROJECT}.
  if docker version >/dev/null 2>&1; then
    local line cname proj srcs s
    while IFS='|' read -r cname proj srcs; do
      for s in $srcs; do
        case "$s" in
          "$OV_BASE"|"$OV_BASE"/*|"$OV_STATUS_DIR"|"$OV_STATUS_DIR"/*|"$OV_IMG_DIR"|"$OV_IMG_DIR"/*)
            [[ "$proj" == "$OV_PROJECT" ]] || bad "container ${cname} (project '${proj:-none}') mounts ${s}" ;;
        esac
      done
    done < <(docker ps -aq | xargs -r docker inspect --format \
      '{{.Name}}|{{index .Config.Labels "com.docker.compose.project"}}|{{range .Mounts}}{{.Source}} {{end}}' 2>/dev/null || true)
  fi

  # Existing images must be ours (ext4 with our label); fstab lines must be ours.
  local entry name label size img mp line
  for entry in "${FS_LIST[@]}"; do
    read -r name label size <<<"$entry"
    img="${OV_IMG_DIR}/${name}.img"; mp="${OV_BASE}/${name}"
    if [[ -e "$img" ]]; then
      local have
      have=$(blkid -o value -s LABEL "$img" 2>/dev/null || true)
      [[ "$have" == "$label" ]] || bad "${img} exists but is not an ext4 image labelled ${label} (label='${have}')"
    fi
    line=$(fstab_line_for "$mp")
    if [[ -n "$line" ]]; then
      [[ "$(awk '{print $1}' <<<"$line")" == "$img" ]] || bad "fstab already mounts something else on ${mp}: ${line}"
      [[ -e "$img" ]] || bad "fstab has ${mp} but ${img} is missing. Refusing to create a fresh empty filesystem over a lost one; restore deliberately (see RUNBOOK)."
    fi
    if [[ -d "$mp" ]] && ! mountpoint -q "$mp" && [[ -n "$(ls -A "$mp" 2>/dev/null)" ]]; then
      bad "bare mountpoint ${mp} is not empty while unmounted (something wrote into it): $(find "$mp" -mindepth 1 -maxdepth 1 -printf '%f ' | head -c 300)"
    fi
  done

  # Other paths we create: refuse if they exist with foreign content.
  [[ ! -e "$OV_STATUS_DIR" || -d "$OV_STATUS_DIR" ]] || bad "${OV_STATUS_DIR} exists and is not a directory"
  if [[ -d "$OV_OPT_DIR" && -n "$(find "$OV_OPT_DIR" -mindepth 1 -maxdepth 1 -print -quit)" \
        && ! -f "${OV_OPT_DIR}/compose.yaml" && ! -f "${OV_OPT_DIR}/.openvolley-kit" ]]; then
    bad "${OV_OPT_DIR} exists with content that is not the OpenVolley kit (no compose.yaml / .openvolley-kit)"
  fi
  if id ovbackup >/dev/null 2>&1; then
    local h
    h=$(getent passwd ovbackup | cut -d: -f6)
    [[ "$h" == /var/lib/ovbackup ]] || bad "user ovbackup already exists with home ${h} (not created by host-prep)"
  fi

  # Free space: creating the images must leave OV_MIN_FREE_AFTER_GB on that fs.
  local need=0 avail_dir="$OV_IMG_DIR"
  [[ -d "$avail_dir" ]] || avail_dir=$(dirname "$OV_IMG_DIR")
  for entry in "${FS_LIST[@]}"; do
    read -r name label size <<<"$entry"
    [[ -e "${OV_IMG_DIR}/${name}.img" ]] || need=$((need + $(size_bytes "$size")))
  done
  if (( need > 0 )); then
    local avail
    avail=$(( $(df -P -k "$avail_dir" | awk 'NR==2 {print $4}') * 1024 ))
    if (( avail - need < OV_MIN_FREE_AFTER_GB * 1024 ** 3 )); then
      bad "not enough space on $(df -P "$avail_dir" | awk 'NR==2 {print $6}'): avail $((avail / 1024 ** 3)) GB, images need $((need / 1024 ** 3)) GB, must leave ${OV_MIN_FREE_AFTER_GB} GB for the other tenants"
    else
      log "space ok: avail $((avail / 1024 ** 3)) GB, images need $((need / 1024 ** 3)) GB"
    fi
  fi

  # chattr must work where the mountpoints live (ext4/xfs/btrfs: yes; tmpfs: no).
  local parent="$OV_BASE"
  while [[ ! -d "$parent" ]]; do parent=$(dirname "$parent"); done
  local fstype
  fstype=$(findmnt -rn -o FSTYPE --target "$parent" | head -n1)
  case "$fstype" in
    ext2|ext3|ext4|xfs|btrfs) ;;
    *) bad "filesystem under ${OV_BASE} is '${fstype}': chattr +i on the bare mountpoints is not supported there" ;;
  esac

  # Informational: who owns the uids the containers use.
  local u
  for u in "$PG_UID" "$NODE_UID"; do
    if getent passwd "$u" >/dev/null; then
      log "note: host uid ${u} is '$(getent passwd "$u" | cut -d: -f1)'; files of the matching container user show under that name on the host"
    fi
  done

  if (( PROBLEMS > 0 )); then
    die "${PROBLEMS} problem(s) found; nothing was changed"
  fi
  log "preflight ok"
}

# ============================================================================
# Apply
# ============================================================================
ensure_fs() {  # name label size
  local name=$1 label=$2 size=$3
  local img="${OV_IMG_DIR}/${name}.img" mp="${OV_BASE}/${name}" fresh=0

  if [[ ! -e "$img" ]]; then
    log "creating ${img} (${size}, ext4 label ${label})"
    fallocate -l "$size" "$img"
    chmod 600 "$img"
    mkfs.ext4 -q -L "$label" -m 0 "$img"
    fresh=1
  fi

  if [[ ! -d "$mp" ]]; then
    install -d -m 0755 -o root -g root "$mp"
  fi
  if ! mountpoint -q "$mp"; then
    # Bare mountpoint: make it immutable so nothing can be created in it
    # while the filesystem is not mounted (create_host_path:false + this =
    # no silent empty data directory).
    chattr +i "$mp"
  fi

  if [[ -z "$(fstab_line_for "$mp")" ]]; then
    local bak
    bak="${OV_FSTAB}.openvolley-bak-$(date -u +%Y%m%dT%H%M%SZ)"
    cp -p "$OV_FSTAB" "$bak"
    log "appending ${mp} to ${OV_FSTAB} (backup: ${bak})"
    local header=1
    grep -q '^# openvolley (host-prep.sh)' "$OV_FSTAB" && header=0
    {
      (( header )) && printf '\n# openvolley (host-prep.sh): loop filesystems, nofail so they never block boot or docker\n'
      printf '%s %s ext4 loop,noatime,nodev,nosuid,nofail,x-systemd.before=docker.service 0 0\n' "$img" "$mp"
    } >>"$OV_FSTAB"
    systemctl daemon-reload 2>/dev/null || true
  fi

  if ! mountpoint -q "$mp"; then
    log "mounting ${mp}"
    mount "$mp"
  fi
  [[ "$(mounted_backing_file "$mp")" == "$img" ]] || die "${mp} is mounted but not from ${img}"

  # Sentinel: only ever created on a filesystem that is fresh/empty.
  if [[ ! -f "${mp}/.ovdata" ]]; then
    local content
    content=$(find "$mp" -mindepth 1 -maxdepth 1 ! -name 'lost+found' -printf '%f ')
    if (( fresh == 0 )) && [[ -n "$content" ]]; then
      die "${mp} has data but no .ovdata sentinel; refusing to bless it. Inspect and create the sentinel by hand if this is really the OpenVolley ${name} filesystem."
    fi
    printf 'openvolley %s filesystem, created %s by host-prep.sh\n' "$name" "$(date -u +%FT%TZ)" >"${mp}/.ovdata"
    chmod 0444 "${mp}/.ovdata"
    chattr +i "${mp}/.ovdata"
    log "sentinel written: ${mp}/.ovdata"
  fi

  case "$name" in
    pg)
      chown root:root "$mp"; chmod 0755 "$mp"
      install -d -o "$PG_UID" -g "$PG_UID" -m 0700 "${mp}/data"
      # state/initialized is written by the ov-postgres guard/healthcheck once
      # a cluster exists; afterwards an empty data/ refuses to start (no
      # silent initdb over lost data).
      install -d -o "$PG_UID" -g "$PG_UID" -m 0700 "${mp}/state"
      ;;
    storage)
      chown "${NODE_UID}:${NODE_UID}" "$mp"; chmod 0750 "$mp"
      ;;
  esac
}

apply() {
  install -d -m 0755 -o root -g root "$OV_BASE"
  [[ -f "$MARKER" ]] || printf 'created by openvolley host-prep.sh on %s\n' "$(date -u +%FT%TZ)" >"$MARKER"
  install -d -m 0700 -o root -g root "$OV_IMG_DIR"

  local entry name label size
  for entry in "${FS_LIST[@]}"; do
    read -r name label size <<<"$entry"
    ensure_fs "$name" "$label" "$size"
  done

  install -d -m 0755 -o root -g root "$OV_STATUS_DIR"

  if ! id ovbackup >/dev/null 2>&1; then
    log "creating system user ovbackup"
    # A real shell is required: sshd runs the forced rrsync command through it.
    useradd --system --create-home --home-dir /var/lib/ovbackup --shell /bin/sh ovbackup
    usermod -p '*' ovbackup   # no password login; key-only (not "locked", which some sshd configs reject)
  fi
  install -d -m 0700 -o ovbackup -g ovbackup /var/lib/ovbackup/.ssh
  [[ -f /var/lib/ovbackup/.ssh/authorized_keys ]] || install -m 0600 -o ovbackup -g ovbackup /dev/null /var/lib/ovbackup/.ssh/authorized_keys

  # setgid so dumps written by root inherit group ovbackup (umask 027 -> 0640).
  install -d -m 2750 -o root -g ovbackup "$OV_BACKUP_DIR"

  install -d -m 0750 -o root -g root "$OV_ETC_DIR"
  install -d -m 0700 -o root -g root /var/lib/openvolley-backup /var/lib/openvolley-backup/gnupg
  if [[ ! -f "${OV_ETC_DIR}/backup.conf" ]]; then
    cat >"${OV_ETC_DIR}/backup.conf" <<EOF
# Sourced by backup-openvolley.sh. See that script for every variable.
OV_PROJECT=${OV_PROJECT}
OV_PG_MOUNT=${OV_BASE}/pg
OV_STORAGE_MOUNT=${OV_BASE}/storage
OV_BACKUP_DIR=${OV_BACKUP_DIR}
OV_STATUS_DIR=${OV_STATUS_DIR}
OV_GPG_PUBKEY=${OV_ETC_DIR}/openvolley-backup.pub.asc
# Fingerprint of the openvolley-backup key (required: the script refuses to
# run while it is empty, and refuses any other key).
OV_GPG_FPR=
# Cap on the total size of ${OV_BACKUP_DIR} in MB (it lives on the shared root
# filesystem); each output is checked against it and against OV_MIN_FREE_MB.
#OV_BACKUP_MAX_MB=20480
# Uptime Kuma push URL (…/api/push/<token>), empty = no push.
OV_KUMA_PUSH_URL=
EOF
    chmod 0640 "${OV_ETC_DIR}/backup.conf"
  fi

  install -d -m 0750 -o root -g root "$OV_OPT_DIR" "${OV_OPT_DIR}/images"
  [[ -f "${OV_OPT_DIR}/.openvolley-kit" ]] || printf 'openvolley deploy kit (host-prep.sh)\n' >"${OV_OPT_DIR}/.openvolley-kit"
  [[ ! -f "${OV_OPT_DIR}/.env" ]] || chmod 0600 "${OV_OPT_DIR}/.env"

  # Backup script + systemd units, if the kit is next to this script.
  if [[ -f "${KIT_DIR}/backup-openvolley.sh" ]]; then
    install -m 0750 -o root -g root "${KIT_DIR}/backup-openvolley.sh" /usr/local/sbin/backup-openvolley.sh
    local u
    for u in openvolley-backup.service openvolley-backup.timer openvolley-backup-files.service openvolley-backup-files.timer; do
      if [[ -f "${KIT_DIR}/systemd/${u}" ]]; then
        install -D -m 0644 "${KIT_DIR}/systemd/${u}" "/etc/systemd/system/${u}"
      fi
    done
    systemctl daemon-reload || warn "systemctl daemon-reload failed; run it by hand"
    log "backup script + units installed (timers NOT enabled; see RUNBOOK step 11)"
  fi

  log "done. Layout:"
  findmnt -rn -o TARGET,SOURCE,SIZE,USE% --target "${OV_BASE}/pg" || true
  findmnt -rn -o TARGET,SOURCE,SIZE,USE% --target "${OV_BASE}/storage" || true
  find "${OV_BASE}/pg" "${OV_BASE}/storage" -mindepth 1 -maxdepth 1 -printf '  %M %u:%g %p\n'
}

preflight
if [[ "$MODE" == apply ]]; then
  apply
else
  log "--check: nothing changed"
fi
