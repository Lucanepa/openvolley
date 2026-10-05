#!/usr/bin/env bash
# Regression test for .gitleaks.toml: each case is a one-line file that must
# (or must not) trip a given rule. Not a git hook (git only runs hooks by
# their fixed names), it just lives next to the hook it protects.
#
# The fake secrets are assembled at runtime from fragments so this file never
# contains a scannable literal and passes its own pre-commit scan.
#
# Usage: .githooks/test-gitleaks-config.sh   (exit 0 = all cases pass)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$ROOT/.gitleaks.toml"
command -v gitleaks >/dev/null 2>&1 || { echo "SKIP: gitleaks not on PATH"; exit 0; }
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 not on PATH"; exit 0; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fails=0

# Random-looking but obviously fake material.
rnd() { python3 -c "import secrets,string,sys;a=string.ascii_letters+string.digits;print(''.join(secrets.choice(a) for _ in range(int(sys.argv[1]))))" "$1"; }
b64url() { python3 -c "import base64,sys;print(base64.urlsafe_b64encode(sys.argv[1].encode()).decode().rstrip('='))" "$1"; }
jwt() { echo "$(b64url '{"alg":"HS256","typ":"JWT"}').$(b64url "$1").$(rnd 43)"; }

# expect <hit|miss> <rule-id> <filename> <content>
expect() {
  local want="$1" rule="$2" name="$3" content="$4" dir report got
  dir="$TMP/case$RANDOM$RANDOM"; mkdir -p "$dir"
  printf '%s\n' "$content" > "$dir/$name"
  report="$dir.json"
  gitleaks dir "$dir" --no-banner --log-level error --config "$CONFIG" \
    --report-format json --report-path "$report" --exit-code 0 >/dev/null 2>&1 || true
  if python3 -c "import json,sys;sys.exit(0 if any(f['RuleID']==sys.argv[2] for f in json.load(open(sys.argv[1]))) else 1)" "$report" "$rule"; then
    got=hit
  else
    got=miss
  fi
  if [[ "$got" == "$want" ]]; then
    echo "ok   $want $rule ($name)"
  else
    echo "FAIL want $want, got $got: $rule ($name)"; fails=$((fails + 1))
  fi
}

SR='{"iss":"supabase","ref":"abcdefghijklmnopqrst","role":"service_role","iat":1700000000,"exp":2000000000}'
ANON='{"iss":"supabase","ref":"abcdefghijklmnopqrst","role":"anon","iat":1700000000,"exp":2000000000}'
OTHER='{"sub":"1234567890","name":"someone","admin":true,"iat":1516239022}'

# Supabase: service_role is a leak, anon is publishable (no rule may fire on it).
expect hit  supabase-service-role-jwt env.sh "SUPABASE_KEY=$(jwt "$SR")"
expect miss supabase-service-role-jwt env.sh "VITE_SUPABASE_ANON_KEY=$(jwt "$ANON")"
expect miss jwt                       env.sh "VITE_SUPABASE_ANON_KEY=$(jwt "$ANON")"
expect hit  jwt                       a.js   "const token = '$(jwt "$OTHER")'"
expect hit  supabase-secret-api-key   a.js   "const k = 'sb_""secret_$(rnd 32)'"
expect miss supabase-secret-api-key   a.js   "const k = 'sb_""publishable_$(rnd 32)'"

# Env-style secrets the backend reads.
expect hit  openvolley-env-secret .env.prod "SMTP_PASS=$(rnd 16)"
expect hit  openvolley-env-secret .env.prod "POCKETBASE_ADMIN_PASSWORD=$(rnd 16)"
expect hit  openvolley-env-secret .env.prod "SUPABASE_SERVICE_ROLE_KEY=$(rnd 40)"
expect hit  openvolley-env-secret c.yml     "  RESEND_API_KEY: \"$(rnd 30)\""
expect miss openvolley-env-secret c.yml     "  RESEND_API_KEY: \${{ secrets.RESEND_API_KEY }}"
expect miss openvolley-env-secret a.js      "const pass = process.env.SMTP_PASS || ''"
expect miss openvolley-env-secret a.js      "  SMTP_PASS: process.env.SMTP_PASS,"
expect miss openvolley-env-secret .env.ex   "SMTP_PASS=your-smtp-password"
expect hit  resend-api-key        a.js      "const k = 're_$(rnd 8)_$(rnd 24)'"

# DeepL: translate.js reads DEEPL_KEY (Pro keys have no :fx suffix).
expect hit  deepl-api-key-assignment .env "DEEPL_KEY=$(python3 -c 'import uuid;print(uuid.uuid4())')"
expect hit  deepl-api-key-assignment .env "DEEPL_API_KEY=$(python3 -c 'import uuid;print(uuid.uuid4())')"
expect miss deepl-api-key-assignment .env "DEEPL_KEY=your-deepl-key-goes-here"

# Postgres and TLS.
expect hit  postgres-uri-password  .env "DATABASE_URL=postgres""://openvolley:$(rnd 20)@db:5432/ov"
expect miss postgres-uri-password  .env "DATABASE_URL=postgres""://openvolley:\${PGPASS}@db:5432/ov"
expect hit  base64-pem-private-key .env "SSL_KEY_BASE64=$(python3 -c "import base64,secrets;print(base64.b64encode(b'-----BEGIN '+b'PRIVATE KEY-----\n'+base64.b64encode(secrets.token_bytes(120))).decode())")"

# Wi-Fi.
expect hit  wifi-wpa-passphrase gen.py "QR = 'WIFI:T:WPA;S:ledbox;P:$(rnd 18);;'"
expect hit  wifi-wpa-passphrase gen.py "QR = 'WIFI:S:ledbox;T:WPA;P:$(rnd 18);;'"
expect miss wifi-wpa-passphrase gen.py "QR = f'WIFI:T:WPA;S:{ssid};P:{passphrase};;'"
expect hit  wifi-config-psk     wpa.conf  "  psk=\"$(rnd 18)\""
expect hit  wifi-config-psk     hostapd.conf "wpa_passphrase=$(rnd 18)"
expect miss wifi-config-psk     hostapd.conf "wpa_passphrase=<your-passphrase>"

# Generic sweep: placeholders are allowed only on the value, not the whole line.
expect hit  generic-credential-assignment a.py "test_api_key = \"$(rnd 24)\""
expect hit  generic-credential-assignment a.py "sudoPassword = '$(rnd 9)'"
expect hit  generic-credential-assignment a.py "sudoPassword = '$(rnd 9 | tr 'A-Z0-9' 'a-za-j')'"
expect miss generic-credential-assignment a.py "password = \"your-password-here\""
expect miss generic-credential-assignment a.js "access_token=\"access_token\""
expect miss generic-credential-assignment de.json "  \"password\": \"Passwort\","

# Known openvolley look-alikes.
expect miss generic-api-key b.json "{\"seed_key\": \"match_$(rnd 10)_$(rnd 10)\"}"

if (( fails > 0 )); then
  echo "$fails case(s) failed"; exit 1
fi
echo "all cases passed"
