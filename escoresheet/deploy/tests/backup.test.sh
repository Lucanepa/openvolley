#!/usr/bin/env bash
# Offline tests for backup-openvolley.sh and restore-storage.sh: separate
# status files and pushes per part, the count-drop quarantine (the storage
# tars still run), WAL shipping, the owner records in the scoresheets tar,
# and a storage restore from those tars. docker and curl are stubs in a
# scratch PATH; gpg is real, with a throwaway key in a scratch homedir.
#
#   escoresheet/deploy/tests/backup.test.sh
set -euo pipefail
KIT_SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
T=$(mktemp -d "${TMPDIR:-/tmp}/ov-backup-test.XXXXXX")
trap 'gpgconf --homedir "$T/key" --kill all 2>/dev/null || true; rm -rf -- "$T"' EXIT
PASS=0
ok() { PASS=$((PASS + 1)); echo "ok   $*"; }
bad() { echo "FAIL $*" >&2; [[ -f "$T/log" ]] && sed 's/^/     /' "$T/log" >&2; exit 1; }

mkdir -p "$T/bin" "$T/pg/walarchive" "$T/storage/scoresheets/k1" "$T/storage/.owners/scoresheets" \
  "$T/storage/backup/a1" "$T/out" "$T/status" "$T/gh" "$T/key" "$T/restore"
chmod 0700 "$T/key" "$T/gh"
touch "$T/pg/.ovdata" "$T/storage/.ovdata"
echo pdf1 >"$T/storage/scoresheets/k1/game1.pdf"
echo '{"key":"k1/game1.pdf","owners":["u1"]}' >"$T/storage/.owners/scoresheets/abc.json"
echo snap1 >"$T/storage/backup/a1/m1.json"
printf 'w1' >"$T/pg/walarchive/000000010000000000000001"

gpg --homedir "$T/key" --batch --passphrase '' --quick-gen-key 'backup test <backup@example.invalid>' ed25519 cert never 2>/dev/null
FPR=$(gpg --homedir "$T/key" --batch --with-colons --list-keys | awk -F: '$1=="fpr" {print $10; exit}')
gpg --homedir "$T/key" --batch --passphrase '' --quick-add-key "$FPR" cv25519 encr never 2>/dev/null
gpg --homedir "$T/key" --batch --armor --export "$FPR" >"$T/pub.asc"

cat >"$T/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >>"$CALLS"
case "$1" in
  ps) echo pg0 ;;
  exec)
    shift 2
    case "$*" in
      "test -f /ovpg/.ovdata") exit 0 ;;
      *pg_database_size*) echo 1 ;;
      *"count(*)"*) cat "$COUNTS" ;;
      *pg_basebackup*) echo base-tar ;;
      *pg_dump*) echo dump-in-pg ;;
    esac ;;
  compose) [[ " $* " == *" run "*"ov-backup pg_dump "* ]] && echo dump ;;
esac
EOF
cat >"$T/bin/curl" <<'EOF'
#!/usr/bin/env bash
echo "curl $*" >>"$CALLS"
EOF
chmod +x "$T/bin/docker" "$T/bin/curl"
cat >"$T/conf" <<EOF
OV_PG_MOUNT=$T/pg
OV_STORAGE_MOUNT=$T/storage
OV_BACKUP_DIR=$T/out
OV_STATUS_DIR=$T/status
OV_GPG_PUBKEY=$T/pub.asc
OV_GPG_FPR=$FPR
OV_GPG_HOME=$T/gh
OV_LOCK_FILE=$T/lock
OV_ENV_FILE=$T/env
OV_MIN_FREE_MB=0
OV_KUMA_PUSH_URL=https://kuma.invalid/db
OV_KUMA_FILES_PUSH_URL=https://kuma.invalid/files
EOF
export PATH="$T/bin:$PATH" OV_BACKUP_CONF="$T/conf" CALLS="$T/calls" COUNTS="$T/counts"
run() { : >"$CALLS"; "$KIT_SRC/backup-openvolley.sh" "$@" >"$T/log" 2>&1; }

# 1. hourly: dump in ov-backup, WAL shipped, only last_backup, only the db push
echo "10 100 5" >"$COUNTS"
run || { bad "hourly run failed"; }
grep -q 'compose .*run --rm -T --no-deps ov-backup pg_dump' "$CALLS" || bad "pg_dump not in ov-backup"
ls "$T/out"/db-*.dump.gpg >/dev/null 2>&1 || bad "no db dump"
[[ -f "$T/out/wal/000000010000000000000001.gpg" && ! -e "$T/pg/walarchive/000000010000000000000001" ]] || bad "WAL segment not shipped"
[[ -f "$T/status/last_backup" && ! -e "$T/status/last_files_backup" ]] || bad "hourly status files"
grep -q 'kuma.invalid/db' "$CALLS" && ! grep -q 'kuma.invalid/files' "$CALLS" || bad "hourly pushes"
ok "hourly run: dump in ov-backup, WAL shipped, db status and push only"

# 2. nightly: base backup, scoresheets tar with .owners, files status + push
rm -f "$T/status/last_backup"
run --with-files || { bad "nightly run failed"; }
sheets=$(ls "$T/out"/scoresheets-*.tar.gpg)
gpg --homedir "$T/key" --batch --quiet --decrypt "$sheets" | tar -tf - >"$T/list"
grep -q '^\.owners/scoresheets/abc.json$' "$T/list" && grep -q '^scoresheets/k1/game1.pdf$' "$T/list" || bad "scoresheets tar lacks .owners: $(cat "$T/list")"
ls "$T/out"/base-*.tar.gpg >/dev/null 2>&1 || bad "no base backup"
[[ -f "$T/status/last_backup" && -f "$T/status/last_files_backup" ]] || bad "nightly status files"
grep 'kuma.invalid/files' "$CALLS" | grep -q 'status=up' || bad "files push"
ok "nightly run: base backup, owner records in the scoresheets tar, both status files"

# 3. a failing files part leaves last_backup fresh but not last_files_backup, pushes files down
rm -f "$T/status"/last_*
mv "$T/storage/.ovdata" "$T/storage/.ovdata.off"
if run --with-files; then bad "files part without its mount succeeded"; fi
mv "$T/storage/.ovdata.off" "$T/storage/.ovdata"
[[ -f "$T/status/last_backup" && ! -e "$T/status/last_files_backup" ]] || bad "a failing files part must not write last_files_backup"
grep 'kuma.invalid/files' "$CALLS" | grep -q 'status=down' || bad "files failure not pushed"
ok "a failing files part is visible on its own: no last_files_backup, files push down"

# 4. count drop: quarantine dump, storage tars still made, no good-dump status, exit 1
rm -f "$T/status"/last_* "$T/out"/scoresheets-*.tar.gpg
echo "10 100 2" >"$COUNTS"
if run --with-files; then bad "count drop did not fail the run"; fi
ls "$T/out"/quarantine-db-*.dump.gpg >/dev/null 2>&1 || bad "no quarantine dump"
ls "$T/out"/scoresheets-*.tar.gpg >/dev/null 2>&1 || bad "storage tars skipped on a count drop"
[[ ! -e "$T/status/last_backup" && -f "$T/status/last_files_backup" ]] || bad "count drop status files"
[[ "$(cat "$T/out/counts.last")" == "10 100 5" ]] || bad "count drop moved the baseline"
grep 'kuma.invalid/db' "$CALLS" | grep -q 'count-drop' || bad "count drop not pushed"
ok "count drop: quarantine dump, storage tars made, run fails, baseline kept"

# 5. restore-storage.sh: newest scoresheets tar + every snapshot in order, owners back
echo "10 100 5" >"$COUNTS"; touch "$T/out/counts.reset"
echo snap2 >"$T/storage/backup/a1/m1.json"
# the first night's snapshot tar as an older night
for f in "$T/out"/snapshots-*.tar.gpg; do mv "$f" "$T/out/snapshots-20000101T0000Z.tar.gpg"; done
run --with-files || { bad "second nightly run failed"; }
"$KIT_SRC/restore-storage.sh" --from "$T/out" --gpg-home "$T/key" "$T/restore" >"$T/log" 2>&1 || bad "restore-storage failed"
[[ "$(cat "$T/restore/scoresheets/k1/game1.pdf")" == pdf1 ]] || bad "scoresheet not restored"
[[ -f "$T/restore/.owners/scoresheets/abc.json" ]] || bad "owner records not restored"
[[ "$(cat "$T/restore/backup/a1/m1.json")" == snap2 ]] || bad "snapshots not applied oldest first"
if "$KIT_SRC/restore-storage.sh" --from "$T/out" --gpg-home "$T/key" "$T/restore" >"$T/log" 2>&1; then bad "overwrote without --force"; fi
ok "restore-storage: scoresheets with owners, snapshots in order, refuses to overwrite"

echo "all ${PASS} passed"
