#!/usr/bin/env bash
# Offline tests for ov-backup-pull.sh (SEC-25): from a VPS backup dir laid out
# as backup-openvolley.sh writes it, the NAS gets the dumps, their .counts, the
# tars, the secrets-*.env.gpg and the WAL segments (in wal/), with the VPS's
# modification times; counts.last, counts.reset, quarantine dumps and partial
# files stay behind; a second run copies nothing; files past the NAS retention
# are neither copied nor kept; a VPS it cannot reach fails the run and posts to
# ntfy. Every output name of backup-openvolley.sh must be either pulled or
# named here as staying on the VPS. Also: nas-pull.sh (the NAS-side variant)
# takes the same files. ssh and curl are stubs; the "VPS" and the "NAS" are
# scratch directories.
#
#   escoresheet/deploy/tests/ov-backup-pull.test.sh
set -euo pipefail
KIT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
T=$(mktemp -d "${TMPDIR:-/tmp}/ov-backup-pull-test.XXXXXX")
trap 'rm -rf -- "$T"' EXIT
PASS=0
ok() { PASS=$((PASS + 1)); echo "ok   $*"; }
bad() { echo "FAIL $*" >&2; [[ -f "$T/log" ]] && sed 's/^/     /' "$T/log" >&2; exit 1; }

V="$T/vps/backups"; N="$T/nas/infomaniak"
mkdir -p "$T/bin" "$V/wal" "$V/freescout" "$T/nas"
TS=20261123T0305Z
PULLED=(db-$TS.dump.gpg db-$TS.counts base-$TS.tar.gpg scoresheets-$TS.tar.gpg global-$TS.tar.gpg
        snapshots-$TS.tar.gpg secrets-$TS.env.gpg wal/000000010000000000000042.gpg)
STAYS=(counts.last counts.reset quarantine-db-$TS.dump.gpg quarantine-db-$TS.counts .db-$TS.dump.gpg.partial wal/.000000010000000000000043.gpg.partial)
for f in "${PULLED[@]}" "${STAYS[@]}"; do printf 'data of %s\n' "$f" >"$V/$f"; done
echo fs >"$V/freescout/freescout-$TS.sql.gpg"
touch -d '2026-11-20 03:05' "$V/db-$TS.dump.gpg"
# past the NAS retention: a 40-day-old dump on the VPS, a 100-day-old tar already on the NAS
echo old >"$V/db-20261001T0305Z.dump.gpg"; touch -d '-40 days' "$V/db-20261001T0305Z.dump.gpg"
mkdir -p "$N"; echo stale >"$N/base-20260801T0305Z.tar.gpg"; touch -d '-100 days' "$N/base-20260801T0305Z.tar.gpg"

# Every file name backup-openvolley.sh writes is in PULLED or STAYS (by its prefix).
names=$(grep -oE '\$OUT/[A-Za-z0-9_./${}-]+' "$KIT/backup-openvolley.sh" | sed 's#^\$OUT/##' | sort -u)
for n in $names; do
  case "$n" in '$DUMP_NAME'|wal|.counts.last.tmp) continue ;; esac   # db-/quarantine-db-*.dump.gpg, the dir, a temp name
  pat=${n//'${TS}'/$TS}; pat=${pat//'${name}'/000000010000000000000042}
  [[ " ${PULLED[*]} ${STAYS[*]} " == *" $pat "* ]] || bad "backup-openvolley.sh writes $n: pull it (ov-backup-pull.sh SETS) or list it in STAYS here"
done
ok "every output of backup-openvolley.sh is pulled or knowingly stays on the VPS"

cat >"$T/bin/ssh" <<'EOF'
#!/usr/bin/env bash
# ssh [-n] [-o X]... host cmd: runs cmd here, host "ov-vps" / "nas-ts" map to scratch dirs
args=()
while (( $# )); do case "$1" in -n) shift ;; -o) shift 2 ;; *) break ;; esac; done
host=$1; shift
echo "ssh $host" >>"$CALLS"
[[ "$host" != "${FAIL_HOST:-}" ]] || exit 255
cmd=$*
cmd=${cmd//sudo /}
exec bash -c "$cmd"
EOF
printf '#!/bin/sh\necho "curl $*" >>"$CURLS"\n' >"$T/bin/curl"
chmod +x "$T/bin/"*
export PATH="$T/bin:$PATH" CALLS="$T/calls" CURLS="$T/curls"
export OVP_SRC="$V" OVP_DST="$N" OVP_FREESCOUT_DST="$T/nas/freescout" OVP_NTFY=https://ntfy.example.invalid/ov
run() { : >"$CALLS"; : >"$CURLS"; "$KIT/ov-backup-pull.sh" >"$T/log" 2>&1; }

run || bad "first pull failed"
for f in "${PULLED[@]}"; do
  [[ -f "$N/$f" ]] && cmp -s "$V/$f" "$N/$f" || bad "not pulled: $f"
done
[[ "$(stat -c %Y "$N/db-$TS.dump.gpg")" == "$(stat -c %Y "$V/db-$TS.dump.gpg")" ]] || bad "modification time not carried over"
for f in "${STAYS[@]}"; do [[ ! -e "$N/$f" ]] || bad "pulled what stays on the VPS: $f"; done
[[ -f "$T/nas/freescout/freescout-$TS.sql.gpg" ]] || bad "FreeScout dump not pulled"
[[ ! -e "$N/db-20261001T0305Z.dump.gpg" ]] || bad "copied a dump past the NAS retention"
[[ ! -e "$N/base-20260801T0305Z.tar.gpg" ]] || bad "kept a tar past the NAS retention"
! grep -q ntfy "$CURLS" || bad "a clean run posted to ntfy"
grep -q '^OK: copied 9 new file' "$T/log" || bad "summary: $(cat "$T/log")"
ok "dumps, counts, tars, secrets and WAL reach the NAS (mtimes kept); counts.last, quarantine and partial files stay; retention applied"

run || bad "second pull failed"
grep -q '^OK: copied 0 new file' "$T/log" || bad "second run copied again: $(cat "$T/log")"
ok "a second run copies nothing"

echo changed-and-longer >"$V/secrets-$TS.env.gpg"
run || bad "pull of a changed file failed"
cmp -s "$V/secrets-$TS.env.gpg" "$N/secrets-$TS.env.gpg" || bad "a file whose size changed was not sent again"
ok "a file whose size changed is sent again"

FAIL_HOST=ov-vps run && bad "a VPS it cannot reach did not fail the run"
grep -q 'Title: OpenVolley backup pull to NAS FAILED' "$CURLS" || bad "no ntfy post on failure"
ok "VPS unreachable: exit 1 and an ntfy post"

# nas-pull.sh (the NAS-side pull over rsync, not in use) takes the same files
inc=$(sed -n "/^rsync /,/-e \"\$SSH\"/p" "$KIT/nas-pull.sh" | grep -oE "\-\-(include|exclude)='[^']+'" | sed "s/^/  /")
mkdir -p "$T/rs"
eval "rsync -rt $(tr '\n' ' ' <<<"$inc") '$V/' '$T/rs/'"
for f in "${PULLED[@]}"; do [[ -f "$T/rs/$f" ]] || bad "nas-pull.sh leaves out $f"; done
for f in counts.last counts.reset .db-$TS.dump.gpg.partial; do [[ ! -e "$T/rs/$f" ]] || bad "nas-pull.sh takes $f"; done
grep -q "secrets-\*.env.gpg" <<<"$(sed -n '/NAS-side retention/,/^# Freshness/p' "$KIT/nas-pull.sh")" || bad "nas-pull.sh: no NAS-side retention for secrets-*.env.gpg"
ok "nas-pull.sh's filter takes the same files, secrets included, and prunes them"

echo "ov-backup-pull.test.sh: $PASS passed"
