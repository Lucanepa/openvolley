#!/usr/bin/env bash
# Offline tests for restore-test.sh (SEC-24): it takes the newest dump, its
# .counts and the secrets file it needs from the off-site copy (a local dir,
# or host:/dir through ssh + cat), and hands the backend container an env
# file with TRUST_PROXY_FROM, the dump's OV_PIN_SECRET / OV_MATCH_TOKEN_SECRET
# (or those of RT_BACKEND_ENV_FILE) and the production settings, nothing
# secret on a command line; it refuses without counts or a PIN secret, and
# posts every failure to RT_NTFY_URL. docker, ssh, rsync and curl are stubs in
# a scratch PATH; gpg is real, with a throwaway key.
#
# With PG_TEST_URL and escoresheet/backend/node_modules it also boots the real
# backend (server.js) with the env file the script made (restore-test-boot.mjs):
# it must come up, while the settings the script gave before (no
# TRUST_PROXY_FROM, no PIN secret) stop it at once.
#
#   escoresheet/deploy/tests/restore-test.test.sh
set -euo pipefail
KIT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
T=$(mktemp -d "${TMPDIR:-/tmp}/ov-restore-test.XXXXXX")
trap 'gpgconf --homedir "$T/key" --kill all 2>/dev/null || true; rm -rf -- "$T"' EXIT
PASS=0
ok() { PASS=$((PASS + 1)); echo "ok   $*"; }
bad() { echo "FAIL $*" >&2; [[ -f "$T/log" ]] && sed 's/^/     /' "$T/log" >&2; exit 1; }

mkdir -p "$T/bin" "$T/key" "$T/nas" "$T/shm" "$T/nosecrets" "$T/nocounts"
chmod 0700 "$T/key"
gpg --homedir "$T/key" --batch --passphrase '' --quick-gen-key 'restore test <restore@example.invalid>' ed25519 cert never 2>/dev/null
FPR=$(gpg --homedir "$T/key" --batch --with-colons --list-keys | awk -F: '$1=="fpr" {print $10; exit}')
gpg --homedir "$T/key" --batch --passphrase '' --quick-add-key "$FPR" cv25519 encr never 2>/dev/null
enc() { gpg --homedir "$T/key" --batch --yes --quiet --trust-model always -r "$FPR" -o "$2" --encrypt "$1" 2>/dev/null; }

stamp() { date -u -d "$1" +%Y%m%dT%H%MZ; }
TS=$(stamp '-1 hour')
OLD=$(stamp '-5 hours')
NEW=$(stamp '+1 hour')
PIN_OLD=pin-of-the-dump-$(printf '%040d' 7)
TOK_OLD=token-of-the-dump-$(printf '%040d' 8)
echo "fake dump bytes" >"$T/plain.dump"
printf 'OV_PIN_SECRET=%s\nOV_MATCH_TOKEN_SECRET=%s\nOTHER=not-taken\n' "$PIN_OLD" "$TOK_OLD" >"$T/secrets-old.env"
printf 'OV_PIN_SECRET=newer-than-the-dump-%040d\n' 9 >"$T/secrets-new.env"
for d in nas nosecrets nocounts; do
  enc "$T/plain.dump" "$T/$d/db-$TS.dump.gpg"
  [[ "$d" == nocounts ]] || echo "10 100 5" >"$T/$d/db-$TS.counts"
  [[ "$d" == nosecrets ]] && continue
  enc "$T/secrets-old.env" "$T/$d/secrets-$OLD.env.gpg"
  enc "$T/secrets-new.env" "$T/$d/secrets-$NEW.env.gpg"
done
# an older dump that must not be picked
enc "$T/plain.dump" "$T/nas/db-$(stamp '-3 hours').dump.gpg"
: >"$T/roles.sql"

cat >"$T/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >>"$CALLS"
case "$1" in
  version|network|rm|logs) exit 0 ;;
  ps) exit 0 ;;
  image) exit 0 ;;
  inspect) echo true ;;
  run)
    prev=
    for a in "$@"; do [[ "$prev" == --env-file ]] && { cp "$a" "$CAPTURED"; stat -c %a "$a" >"$CAPTURED.mode"; }; prev=$a; done
    echo cid ;;
  exec)
    case "$*" in
      *pg_isready*) exit 0 ;;
      *pg_restore*) cat >/dev/null ;;
      *ov_app_pw*) cat >/dev/null ;;
      *"-U ov_app "*) echo 10 ;;
      *"count(*) from public.matches),"*) echo "10 100 5" ;;
      *"node -e"*) echo '{"status":"ok","db":"ok"}' ;;
      *) echo "unexpected docker exec: $*" >&2; exit 9 ;;
    esac ;;
  *) echo "unexpected docker $1" >&2; exit 9 ;;
esac
EOF
cat >"$T/bin/ssh" <<'EOF'
#!/usr/bin/env bash
while [[ "$1" == -o ]]; do shift 2; done
echo "ssh $1" >>"$CALLS"
shift
exec bash -c "$*"
EOF
printf '#!/bin/sh\necho "rsync $*" >>"$CALLS"; exit 7\n' >"$T/bin/rsync"
printf '#!/bin/sh\necho "curl $*" >>"$CURLS"\n' >"$T/bin/curl"
chmod +x "$T/bin/"*

export PATH="$T/bin:$PATH" CALLS="$T/calls" CURLS="$T/curls" CAPTURED="$T/captured.env"
export RT_CONF="$T/no-conf" RT_SOURCE="$T/nas" RT_BACKEND_IMAGE=openvolley-backend:test RT_GNUPGHOME="$T/key" \
  RT_ROLES_SQL="$T/roles.sql" RT_LOCK_FILE="$T/lock" RT_FLOOR_FILE="$T/floor" RT_WORK_BASE="$T/shm" \
  RT_NTFY_URL=https://ntfy.example.invalid/ov RT_KUMA_PUSH_URL=https://kuma.example.invalid/push RT_HEALTH_TIMEOUT=5
unset RT_BACKEND_ENV_FILE RT_GPG_PASSPHRASE_FILE CREDENTIALS_DIRECTORY
run() { : >"$CALLS"; : >"$CURLS"; rm -f "$CAPTURED" "$T/floor"; "$KIT/restore-test.sh" "$@" >"$T/log" 2>&1; }
val() { sed -n "s/^$1=//p" "$CAPTURED"; }

# 1. the NAS copy as a local dir: newest dump, its counts, the secrets not newer than it
run || bad "restore test from a local copy failed"
grep -q "PASS db-$TS.dump.gpg" "$T/log" || bad "did not restore the newest dump db-$TS"
grep -q "secrets secrets-$OLD.env.gpg" "$T/log" || bad "did not take the secrets file not newer than the dump"
[[ "$(val TRUST_PROXY_FROM)" == 127.0.0.1/32 && "$(val TRUST_PROXY)" == cloudflare && "$(val IS_CLOUD)" == 1 ]] || bad "backend env: TRUST_PROXY / TRUST_PROXY_FROM / IS_CLOUD"
[[ "$(val OV_PIN_SECRET)" == "$PIN_OLD" && "$(val OV_MATCH_TOKEN_SECRET)" == "$TOK_OLD" ]] || bad "backend env: the dump's PIN and token secrets"
[[ -z "$(val OTHER)" ]] || bad "backend env: took more than the two secrets from the secrets file"
[[ "$(val DATABASE_URL)" == postgres://ov_app:*@ov-postgres:5432/openvolley && "$(val OV_MIN_MATCHES)" == 9 && "$(val VM_SYNC)" == off ]] || bad "backend env: database, floor, VM sync"
[[ "$(cat "$CAPTURED.mode")" == 600 ]] || bad "backend env file mode $(cat "$CAPTURED.mode")"
! grep -E '^docker run .*(OV_PIN_SECRET|DATABASE_URL|ov_app:)' "$CALLS" >/dev/null || bad "a secret on the docker run command line"
[[ -z "$(find "$T/shm" -mindepth 1)" ]] || bad "work dir left in RT_WORK_BASE"
[[ "$(cat "$T/floor")" == "10 100 5" ]] || bad "floor file"
! grep -q ntfy "$CURLS" && grep -q 'status=up' "$CURLS" || bad "a passing run: Kuma up, no ntfy post"
ok "local copy: newest dump + counts + matching secrets, env file with TRUST_PROXY_FROM and the secrets, nothing secret in argv"

# 2. host:/dir: ssh + cat (DSM refuses rsync over ssh)
RT_SOURCE="nas-test:$T/nas" run || bad "restore test over ssh failed"
grep -q '^ssh nas-test$' "$CALLS" && ! grep -q '^rsync' "$CALLS" || bad "ssh source: ssh + cat, never rsync"
[[ "$(val OV_PIN_SECRET)" == "$PIN_OLD" ]] || bad "ssh source: secrets"
ok "host:/dir source: listed and copied with ssh + cat, same env"

# 3. no secrets file and no RT_BACKEND_ENV_FILE: refused, owner alerted
RT_SOURCE="$T/nosecrets" run && bad "ran without any PIN secret"
grep -q 'no OV_PIN_SECRET for' "$T/log" || bad "no secrets: message"
grep -q 'Title: OpenVolley restore test FAILED' "$CURLS" && grep -q 'ntfy.example.invalid' "$CURLS" && grep -q 'status=down' "$CURLS" || bad "no secrets: ntfy alert and Kuma down"
[[ ! -e "$CAPTURED" ]] || bad "no secrets: the backend was started"
ok "no secrets file: refused before the backend starts, ntfy alert + Kuma down"

# 4. RT_BACKEND_ENV_FILE: secrets from the vault (quoted), the fixed keys stay the script's
cat >"$T/extra.env" <<EOF
# from the club vault
OV_PIN_SECRET="vault-pin-$(printf '%040d' 1)"
OV_MATCH_TOKEN_SECRET='vault-token-$(printf '%040d' 2)'
DATABASE_URL=postgres://evil@example.invalid/x
TRUST_PROXY_FROM=10.0.0.0/8
EOF
RT_SOURCE="$T/nosecrets" RT_BACKEND_ENV_FILE="$T/extra.env" run || bad "restore test with RT_BACKEND_ENV_FILE failed"
[[ "$(val OV_PIN_SECRET)" == "vault-pin-$(printf '%040d' 1)" && "$(val OV_MATCH_TOKEN_SECRET)" == "vault-token-$(printf '%040d' 2)" ]] || bad "RT_BACKEND_ENV_FILE: secrets (quotes dropped)"
[[ "$(val DATABASE_URL)" == postgres://ov_app:* ]] || bad "RT_BACKEND_ENV_FILE changed DATABASE_URL"
[[ "$(val TRUST_PROXY_FROM)" == 10.0.0.0/8 ]] || bad "RT_BACKEND_ENV_FILE: TRUST_PROXY_FROM override"
grep -q 'WARNING: DATABASE_URL in' "$T/log" || bad "RT_BACKEND_ENV_FILE: no warning for DATABASE_URL"
# the dump's own secrets file wins over the vault copy
RT_BACKEND_ENV_FILE="$T/extra.env" run || bad "secrets file + RT_BACKEND_ENV_FILE"
[[ "$(val OV_PIN_SECRET)" == "$PIN_OLD" ]] || bad "the dump's secrets file must win over RT_BACKEND_ENV_FILE"
printf 'OV_PIN_SECRET=x\nthis line holds a s3cr3t-value\n' >"$T/junk.env"
RT_BACKEND_ENV_FILE="$T/junk.env" run && bad "took a malformed RT_BACKEND_ENV_FILE"
grep -q 'line 2 is not KEY=VALUE' "$T/log" && ! grep -q 's3cr3t' "$T/log" "$CURLS" || bad "malformed RT_BACKEND_ENV_FILE: message must name the line, not print it"
ok "RT_BACKEND_ENV_FILE: vault secrets when the copy has none, cannot change the fixed keys, never printed"

# 5. no .counts next to the dump: refused
RT_SOURCE="$T/nocounts" run && bad "ran without the .counts file"
grep -q "no db-$TS.counts next to" "$T/log" || bad "no counts: message"
ok "no .counts next to the dump: refused"

# the unit: runs the script of its own checkout, alerts the owner
U="$KIT/systemd/openvolley-restore-test.service"
grep -qE '^ExecStart=/.*/escoresheet/deploy/restore-test\.sh$' "$U" && grep -qE '^Environment=RT_NTFY_URL=.' "$U" ||
  bad "openvolley-restore-test.service: ExecStart of a checkout's escoresheet/deploy, RT_NTFY_URL"
! grep -q '^SupplementaryGroups=' "$U" || bad "openvolley-restore-test.service still needs the group of the old local source"
ok "the unit runs a checkout's restore-test.sh and alerts through ntfy"

# 6. the real backend with that env file (needs Postgres and the backend's node_modules)
if [[ -n "${PG_TEST_URL:-${TEST_DATABASE_URL:-}}" && -d "$KIT/../backend/node_modules" ]] && command -v node >/dev/null; then
  run || bad "restore test for the boot check failed"
  out=$(node "$KIT/tests/restore-test-boot.mjs" "$CAPTURED" boot 2>&1) || { echo "$out" >&2; bad "the backend does not boot with the env file restore-test.sh makes"; }
  ok "server.js boots with the env file restore-test.sh hands the container ($out)"
  grep -vE '^(TRUST_PROXY_FROM|OV_PIN_SECRET|OV_MATCH_TOKEN_SECRET|VM_SYNC)=' "$CAPTURED" >"$T/before.env"
  out=$(node "$KIT/tests/restore-test-boot.mjs" "$T/before.env" exit 2>&1) || { echo "$out" >&2; bad "the old settings were expected to stop the backend"; }
  ok "the settings restore-test.sh gave before stop it ($out)"
else
  echo "skip boot of server.js (PG_TEST_URL or escoresheet/backend/node_modules missing)"
fi

echo "restore-test.test.sh: $PASS passed"
