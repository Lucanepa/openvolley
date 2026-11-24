#!/bin/bash
# ov-backup-pull.sh — copy OpenVolley's ENCRYPTED backups from its Infomaniak VPS (`ov-vps`,
# since 09.11.2026) to the NAS. Runs on lenovoserver (ov-backup-pull.service/.timer, hourly at
# :25, after the VPS dumps at :05). Same pattern as kscw-backup-pull.sh: this box PULLS over
# `ssh ov-vps` (Luca's key, user debian + sudo there) and streams each file straight to the
# NAS over `ssh nas-ts`. Nothing is stored here, and the VPS has no key to the NAS.
#
# The repository's copy of the live script (~/stacks/ov-backup-pull/ov-backup-pull.sh, which
# is a file copy, not a checkout): change it here, test it (tests/ov-backup-pull.test.sh),
# then install it there:
#   install -m 700 escoresheet/deploy/ov-backup-pull.sh ~/stacks/ov-backup-pull/ov-backup-pull.sh
#
# The files are GPG-encrypted on the VPS to the OpenVolley backup key (public half only on the
# VPS), so the NAS stores ciphertext. What backup-openvolley.sh writes, and what a restore
# after losing the VPS needs:
#   db-*.dump.gpg       hourly dumps                                   (NAS: 30 days)
#   db-*.counts         their row counts (restore-test.sh, restore-db.sh check them; 30 days)
#   *.tar.gpg           nightly base backup and storage tars            (90 days)
#   secrets-*.env.gpg   OV_PIN_SECRET and OV_MATCH_TOKEN_SECRET: without them no stored PIN
#                       or match token of a restored dump checks       (90 days)
#   wal/*.gpg           WAL segments since the base backup: point-in-time recovery between
#                       the hourly dumps (a sub-directory; a day longer than the tars, 91 days)
# plus FreeScout's encrypted dumps (freescout-*.gpg). counts.last, counts.reset and the
# quarantine-db-* of a count-drop stay on the VPS. Until 09.11 the stack ran on this box and
# borg carried the dumps.
#
# Files are compared by name + size, so a file still being written on the VPS during one run is
# re-sent by the next. Modification times are carried over so the NAS retention matches.
# DSM refuses rsync-over-ssh for this user, so this uses ssh `cat` + `mv` + `touch`.
#
# Settings (env; the defaults are lenovoserver's): OVP_VPS, OVP_NAS (ssh hosts), OVP_SRC (the
# VPS's backup dir), OVP_DST (the NAS dir), OVP_FREESCOUT_DST, OVP_NTFY (ntfy topic URL for a
# failure; empty = none).
set -uo pipefail

VPS=${OVP_VPS:-ov-vps}
NAS=${OVP_NAS:-nas-ts}
NTFY=${OVP_NTFY-http://127.0.0.1:8445/homelab}
SRC_BASE=${OVP_SRC:-/data/openvolley/backups}
DST_BASE=${OVP_DST:-/volume1/backups/openvolley/infomaniak}
FREESCOUT_DST=${OVP_FREESCOUT_DST:-/volume1/backups/openvolley/freescout}
SSHO=(-o BatchMode=yes -o ConnectTimeout=20)

# source dir | file pattern | NAS dir | prune after N days (0 = keep)
SETS=(
  "$SRC_BASE|db-*.dump.gpg|$DST_BASE|30"
  "$SRC_BASE|*.tar.gpg|$DST_BASE|90"
  "$SRC_BASE/freescout|freescout-*.gpg|$FREESCOUT_DST|30"
  # audit 23.11.2026 (SEC-25): without these a restore after losing the VPS has no point-in-time
  # recovery (WAL), cannot check existing PINs/match tokens (secrets) and cannot verify row counts
  "$SRC_BASE|secrets-*.env.gpg|$DST_BASE|90"
  "$SRC_BASE|db-*.counts|$DST_BASE|30"
  "$SRC_BASE/wal|*.gpg|$DST_BASE/wal|91"
)

FAILED=()
COPIED=0
for set in "${SETS[@]}"; do
  IFS='|' read -r SRC PAT DST DAYS <<<"$set"
  if ! SRC_LIST=$(ssh "${SSHO[@]}" "$VPS" "sudo find '$SRC' -maxdepth 1 -type f -name '$PAT' -printf '%f %s %T@\n'"); then
    FAILED+=("list $VPS:$SRC"); continue
  fi
  if ! DST_LIST=$(ssh "${SSHO[@]}" "$NAS" "mkdir -p '$DST' && find '$DST' -maxdepth 1 -type f -name '$PAT' -printf '%f %s\n'"); then
    FAILED+=("list $NAS:$DST"); continue
  fi
  # fd 3: the ssh calls inside the loop must not eat the file list from stdin
  while read -r NAME SIZE MTIME <&3; do
    [ -n "$NAME" ] || continue
    grep -qxF "$NAME $SIZE" <<<"$DST_LIST" && continue
    # already past the NAS retention: copying it would only feed the prune below
    [ "$DAYS" -gt 0 ] && [ "${MTIME%.*}" -lt $(( $(date +%s) - DAYS * 86400 )) ] && continue
    if ssh -n "${SSHO[@]}" "$VPS" "sudo cat '$SRC/$NAME'" \
       | ssh "${SSHO[@]}" "$NAS" "cat > '$DST/.$NAME.part' && mv -f '$DST/.$NAME.part' '$DST/$NAME' && touch -d @${MTIME%.*} '$DST/$NAME'"; then
      GOT=$(ssh -n "${SSHO[@]}" "$NAS" "stat -c %s '$DST/$NAME'" 2>/dev/null)
      if [ "$GOT" = "$SIZE" ]; then COPIED=$((COPIED + 1)); else FAILED+=("$NAME size $GOT != $SIZE"); fi
    else
      FAILED+=("$NAME")
    fi
  done 3<<<"$SRC_LIST"
  if [ "$DAYS" -gt 0 ]; then
    ssh "${SSHO[@]}" "$NAS" "find '$DST' -maxdepth 1 -type f -name '$PAT' -mtime +$DAYS -delete" || FAILED+=("prune $DST/$PAT")
  fi
done

if [ ${#FAILED[@]} -gt 0 ]; then
  [ -z "$NTFY" ] || curl -s -m 10 -H "Title: OpenVolley backup pull to NAS FAILED" -H "Priority: high" -H "Tags: rotating_light" \
    -d "Copied ${COPIED}; failed: ${FAILED[*]} (journalctl -u ov-backup-pull)" "$NTFY" >/dev/null || true
  echo "FAILED: ${FAILED[*]} (copied ${COPIED})" >&2
  exit 1
fi
echo "OK: copied ${COPIED} new file(s) from the VPS to the NAS"
