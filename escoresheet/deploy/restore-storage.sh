#!/usr/bin/env bash
# restore-storage.sh [options] TARGET
#
# Restores the object storage (scoresheets, their owner records, match
# backups) from the nightly tars of backup-openvolley.sh --with-files:
#
#   1. the newest scoresheets-<UTC>.tar.gpg at or before --at: every file
#      under scoresheets/ plus the owner records .owners/ (without them the
#      backend refuses each restored scoresheet to its own scorer);
#   2. every snapshots-<UTC>.tar.gpg at or before --at, oldest first: each is
#      the backup/ files changed in ~26 h, so a later one overwrites what an
#      earlier one had. Only as far back as the tars kept (7 days on the
#      server, longer on the NAS).
#
# Run it where the openvolley-backup PRIVATE key is (it is never on the
# server): on the NAS copy, or on the server after a temporary import into a
# private GNUPGHOME. TARGET is the storage mount (with its .ovdata sentinel)
# or an empty directory; files there are overwritten only with --force.
# Stop ov-backend while restoring into the live mount.
#
# Options:
#   --from DIR       backup directory (default /data/openvolley/backups)
#   --at STAMP       newest tar to use, as in the names (20261108T0335Z);
#                    default: the newest
#   --gpg-home DIR   GNUPGHOME holding the private key (default: gpg's own)
#   --chown U:G      owner of the restored files (the backend runs as 1000:1000)
#   --force          TARGET already holds files: overwrite them
#   --dry-run        list what would be unpacked, change nothing
#
# Exit codes: 0 restored, 1 failed, 2 usage.
set -euo pipefail
umask 027

FROM=/data/openvolley/backups
AT=
GPG_HOME=
CHOWN=
FORCE=0
DRY=0
TARGET=

usage() { sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
die() { printf 'restore-storage: %s\n' "$*" >&2; exit 1; }
log() { printf 'restore-storage: %s\n' "$*"; }

while (( $# )); do
  case "$1" in
    --from) FROM=${2:?}; shift 2 ;;
    --at) AT=${2:?}; shift 2 ;;
    --gpg-home) GPG_HOME=${2:?}; shift 2 ;;
    --chown) CHOWN=${2:?}; shift 2 ;;
    --force) FORCE=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage ;;
    -*) echo "unknown option $1" >&2; usage ;;
    *) [[ -z "$TARGET" ]] || usage; TARGET=$1; shift ;;
  esac
done
[[ -n "$TARGET" ]] || usage
[[ -z "$AT" || "$AT" =~ ^[0-9]{8}T[0-9]{4}Z$ ]] || die "--at wants a stamp like 20261108T0335Z"
[[ -d "$FROM" ]] || die "no backup directory $FROM"
[[ -d "$TARGET" ]] || die "no target directory $TARGET"
if [[ ! -f "$TARGET/.ovdata" ]] && [[ -n "$(ls -A "$TARGET")" ]] && (( ! FORCE )); then
  die "$TARGET is neither the storage mount (.ovdata) nor empty; --force to unpack into it anyway"
fi
if (( ! FORCE )) && [[ -n "$(find "$TARGET" -mindepth 1 -maxdepth 1 \( -name scoresheets -o -name .owners -o -name backup \) -print -quit)" ]]; then
  die "$TARGET already holds storage files; --force overwrites them"
fi

GPG=(gpg --batch --quiet --no-tty --decrypt)
[[ -z "$GPG_HOME" ]] || GPG=(gpg --homedir "$GPG_HOME" --batch --quiet --no-tty --decrypt)

# the tars of one kind at or before --at, oldest first (UTC stamps sort as text)
stamp_of() { local n=${1##*/}; n=${n#*-}; printf '%s' "${n%%.*}"; }
pick() {
  local f
  for f in "$FROM"/"$1"-*.tar.gpg; do
    [[ -f "$f" ]] || continue
    [[ -z "$AT" || ! "$(stamp_of "$f")" > "$AT" ]] && printf '%s\n' "$f"
  done | sort
}

unpack() {  # file
  log "unpacking $(basename "$1")"
  (( DRY )) && { "${GPG[@]}" "$1" | tar -tf - | sed 's/^/  /'; return 0; }
  "${GPG[@]}" "$1" | tar -C "$TARGET" --no-same-owner -xf - || die "unpacking $(basename "$1") failed"
}

mapfile -t sheets < <(pick scoresheets)
mapfile -t snaps < <(pick snapshots)
(( ${#sheets[@]} + ${#snaps[@]} > 0 )) || die "no scoresheets-*/snapshots-* tar in $FROM${AT:+ at or before $AT}"

if (( ${#sheets[@]} )); then
  newest=${sheets[-1]}
  unpack "$newest"
  if (( ! DRY )) && [[ -d "$TARGET/scoresheets" && ! -d "$TARGET/.owners" ]]; then
    log "WARNING: $(basename "$newest") holds no .owners (a tar from before the owner records were backed up):"
    log "         each scoresheet needs its owners set again (backend scripts/storage-owner.mjs) before its scorer can open it"
  fi
else
  log "no scoresheets tar${AT:+ at or before $AT}: scoresheets not restored"
fi
for f in "${snaps[@]}"; do unpack "$f"; done

(( DRY )) && { log "dry run: nothing changed"; exit 0; }
if [[ -n "$CHOWN" ]]; then
  for d in scoresheets .owners backup; do
    [[ ! -e "$TARGET/$d" ]] || chown -R "$CHOWN" "$TARGET/$d"
  done
fi
count() { [[ -d "$TARGET/$1" ]] && find "$TARGET/$1" -type f | wc -l || echo 0; }
log "done: scoresheets $(count scoresheets) file(s), owner records $(count .owners), match backups $(count backup) (${#snaps[@]} snapshot tar(s))"
