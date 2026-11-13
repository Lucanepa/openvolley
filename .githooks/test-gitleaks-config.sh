#!/usr/bin/env bash
# Regression test for .gitleaks.toml: each case is a one-line file that must
# (or must not) trip a given rule. Not a git hook (git only runs hooks by
# their fixed names), it just lives next to the hook it protects.
#
# The fake secrets are assembled at runtime from fragments so this file never
# contains a scannable literal and passes its own pre-commit scan.
#
# Usage: .githooks/test-gitleaks-config.sh   (exit 0 = all cases pass)
# A missing gitleaks (>= 8.25) or python3 is a failure (exit 2), not a skip, so
# a CI job that runs this cannot pass while testing nothing.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$ROOT/.gitleaks.toml"
for tool in gitleaks python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: $tool not on PATH, nothing was tested" >&2; exit 2; }
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fails=0

# Random-looking but obviously fake material.
rnd() { python3 -c "import secrets,string,sys;a=string.ascii_letters+string.digits;print(''.join(secrets.choice(a) for _ in range(int(sys.argv[1]))))" "$1"; }
b64url() { python3 -c "import base64,sys;print(base64.urlsafe_b64encode(sys.argv[1].encode()).decode().rstrip('='))" "$1"; }
jwt() { echo "$(b64url '{"alg":"HS256","typ":"JWT"}').$(b64url "$1").$(rnd 43)"; }

# expect <hit|miss> <rule-id> <filename> <content>
# The filename may hold folders (tests/fixtures/a.json) for the path rules.
expect() {
  local want="$1" rule="$2" name="$3" content="$4" dir report got
  dir="$TMP/case$RANDOM$RANDOM"; mkdir -p "$(dirname "$dir/$name")"
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
expect hit  openvolley-env-secret .env.prod "SMTP_PASS=$(rnd 6)abcDEF"
expect miss openvolley-env-secret a.js      "  SMTP_PASS: smtpPass,"
expect miss openvolley-env-secret a.ts      "  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),"
expect miss openvolley-env-secret a.js      "  jwt_secret: jwtSecret,"
expect miss openvolley-env-secret c.yml     "      POSTGRES_PASSWORD: postgres"
expect hit  openvolley-env-secret c.yml     "      POSTGRES_PASSWORD: $(rnd 20)"
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
expect hit  wifi-wpa-passphrase gen.py "QR = 'WIFI:T:WPA;S:Hall Net;P:$(rnd 6) $(rnd 6)\\;$(rnd 4);;'"
expect hit  wifi-config-psk     hostapd.conf "wpa_passphrase=$(rnd 18)"
expect hit  wifi-config-psk     hostapd.conf "wpa_psk=$(python3 -c 'import secrets;print(secrets.token_hex(32))')"
expect miss wifi-config-psk     hostapd.conf "wpa_passphrase=<your-passphrase>"

# Wi-Fi in prose: the hall-guide form that leaked the second AP passphrase.
expect hit  wifi-ssid-passphrase-prose guide.html "  <li><b>Board wifi</b><span>ledbox_C$(rnd 4) / $(rnd 12)</span></li>"
expect hit  wifi-ssid-passphrase-prose guide.html "    <div class=\"sub\">ledbox_C$(rnd 4) · $(rnd 12)</div>"
expect hit  wifi-ssid-passphrase-prose notes.md   "SSID: HallNet / $(rnd 14)"
expect miss wifi-ssid-passphrase-prose notes.md   "see escoresheet/ledbox_api/handlers.py and ledbox_api/routes.py"
expect miss wifi-ssid-passphrase-prose notes.md   "| SSID / Passwort | notes |"
expect miss wifi-ssid-passphrase-prose notes.md   "SSID see https://example.org/wifi-setup-guide"
expect miss wifi-ssid-passphrase-prose guide.html "<span>ledbox_C0000 / &lt;passphrase&gt;</span>"
expect hit  wifi-passphrase-label      guide.html "<b>WLAN-Passwort</b>: <code>$(rnd 12)</code>"
expect hit  wifi-passphrase-label      notes.md   "Wi-Fi password: $(rnd 12)"
expect miss wifi-passphrase-label      a.js       "  wifiPassword: cfg.wifiPassword,"
expect miss wifi-passphrase-label      notes.md   "Wi-Fi password: <ask the hall manager>"

# Generic sweep: placeholders are allowed only on the value, not the whole line.
expect hit  generic-credential-assignment a.py "test_api_key = \"$(rnd 24)\""
expect hit  generic-credential-assignment a.py "sudoPassword = '$(rnd 9)'"
expect hit  generic-credential-assignment a.py "sudoPassword = '$(rnd 9 | tr 'A-Z0-9' 'a-za-j')'"
expect miss generic-credential-assignment a.py "password = \"your-password-here\""
expect miss generic-credential-assignment a.js "access_token=\"access_token\""
expect miss generic-credential-assignment de.json "  \"password\": \"Passwort\","
expect miss generic-credential-assignment auth.test.js "  const r = await login({ email: 'a@example.ch', password: 'pw$(rnd 6)' })"
expect hit  supabase-secret-api-key       auth.test.js "const k = 'sb_""secret_$(rnd 32)'"

# Known openvolley look-alikes.
expect miss generic-api-key b.json "{\"seed_key\": \"match_$(rnd 10)_$(rnd 10)\"}"
# F-Droid recipe: public signing-certificate fingerprint; a key-named hex value still hits.
hex64() { python3 -c "import secrets;print(secrets.token_hex(32))"; }
expect miss generic-api-key app.yml "AllowedAPKSigningKeys: $(hex64)"
expect hit  generic-api-key app.yml "api_key: $(hex64)"

# Personal data from matches: a date of birth, a signature image, a contact
# list, an encrypted backup, an app backup/log file. Fictional people only.
P='"firstName": "Anna", "lastName": "Muster"'
SIG="data:image/png;base64,$(python3 -c "import base64,os;print(base64.b64encode(os.urandom(300)).decode())")"
ENV="{\"format\": \"openvolley-encrypted-backup\", \"formatVersion\": 1, \"readable\": {\"gameN\": 3}, \"ciphertext\": \"$(rnd 64)\"}"
expect hit  match-data-birth-date  export.json "[{\"number\": 7, $P, \"dob\": \"01.02.2008\", \"libero\": \"\"}]"
expect hit  match-data-birth-date  export.json "{\"first_name\": \"Anna\", \"last_name\": \"Muster\", \"date_of_birth\": \"2008-02-01\"}"
expect hit  match-data-birth-date  export.json "{\"dob\": \"01/02/2008\", \"role\": \"Coach\", \"lastName\": \"Muster\"}"
expect hit  match-data-birth-date  notes.txt   "10:00:01 state {\\\"lastName\\\":\\\"Muster\\\",\\\"dob\\\":\\\"2008-02-01\\\"}"
expect hit  match-data-birth-date  export.json "{\"team\": {\"name\": \"Home\"}, \"players\": [{\"dob\": \"01.02.2008\"}]}"
expect hit  match-data-birth-date  dump.json   "[{\"dob\": \"2008-02-01T00:00:00.000Z\", $P}]"
expect hit  match-data-birth-date  dump.json   "[{$P, \"licence\": {\"number\": \"12345\"}, \"dob\": \"01.02.2008\"}]"
expect hit  match-data-birth-date  games.json  "[{\"game_n\": 3, \"referee_1_first_name\": \"Anna\", \"referee_1_dob\": \"1990-02-01\"}]"
expect hit  match-data-birth-date  games.json  "[{\"gameN\": 3, \"referee1First\": \"Anna\", \"referee1Dob\": \"01.02.1990\"}]"
expect hit  match-data-birth-date  persons.json "[{$P, \"formattedAndTimezoneIndependentBirthday\": \"01.02.2008\"}]"
expect hit  match-data-birth-date  session.har "{\"text\": \"[{\\\"lastName\\\":\\\"Muster\\\",\\\"birthDate\\\":\\\"2008-02-01\\\"}]\"}"
expect hit  match-data-birth-date  league-fixtures/2026/roster.json "[{$P, \"dob\": \"01.02.2008\"}]"
expect miss match-data-birth-date  de.json     "{\"firstName\": \"Vorname\", \"lastName\": \"Nachname\", \"dob\": \"Geburtsdatum\"}"
expect miss match-data-birth-date  en.json     "{\"dobFormat\": \"dd.mm.yyyy\", \"birthYear\": 2008}"
expect miss match-data-birth-date  export.json "{$P, \"dob\": \"\"}"
expect miss match-data-birth-date  tests/fixtures/match.json "[{$P, \"dob\": \"01.02.2008\"}]"
expect miss match-data-birth-date  relay.rs    "json!([{ $P, \"dob\": \"1980-01-01\" }])"
expect hit  match-data-signature   backup.json "{\"homeCoachSignature\": \"$SIG\"}"
expect hit  match-data-signature   notes.txt   "{\"signatures\": {\"home_coach\": \"$SIG\"}}"
expect miss match-data-signature   backup.json "{\"icon\": \"data:image/png;base64,iVBORw0KGgo=\"}"
expect miss match-data-signature   __tests__/fixtures/sign.json "{\"homeCoachSignature\": \"$SIG\"}"
expect miss match-data-signature   a.js        "const sheet = {\"homeCoachSignature\": \"$SIG\"}"
expect hit  match-data-contact     list.json   "[{$P, \"phone\": \"079 000 00 00\"}]"
expect hit  match-data-contact     list.json   "[{\"mobile\": \"+41 79 000 00 00\", \"name\": \"Anna Muster\"}]"
expect miss match-data-contact     en.json     "{\"name\": \"Name\", \"phone\": \"Phone\"}"
expect miss match-data-contact     tests/fixtures/list.json "[{\"name\": \"Anna Muster\", \"phone\": \"079 000 00 00\"}]"
expect hit  match-data-email       list.json   "[{$P, \"email\": \"anna.muster@mail.example\"}]"
expect hit  match-data-email       list.json   "[{\"contactEmail\": \"a.muster@club-mail.example\", \"name\": \"Anna Muster\"}]"
expect miss match-data-email       list.json   "[{\"name\": \"Anna Muster\", \"email\": \"anna@example.org\"}]"
expect miss match-data-email       list.json   "[{\"name\": \"Anna Muster\", \"email\": \"anna@club.test\"}]"
expect miss match-data-email       en.json     "{\"name\": \"Name\", \"email\": \"Email\", \"emailPlaceholder\": \"name@email\"}"
expect miss match-data-email       __fixtures__/list.json "[{\"name\": \"Anna Muster\", \"email\": \"anna.muster@mail.example\"}]"
expect hit  match-data-encrypted-backup  exports/game3.json "$ENV"
expect hit  match-data-encrypted-backup  game3-match_1/latest.json "$ENV"
expect miss match-data-encrypted-backup  envelope.js "export const ENVELOPE = { \"format\": \"openvolley-encrypted-backup\" }"
expect miss match-data-encrypted-backup  tests/fixtures/envelope.json "$ENV"
expect hit  match-data-file        backup_g1_set2_scoreleft15_scoreright12_20250104_153045_123.json "{}"
expect hit  match-data-file        game1-match_1/20261112T101500.123Z-00042.json "{}"
expect hit  match-data-file        OpenVolley/game1-match_1/a1b2c3d4-manual-20261112T101500Z.json "{}"
expect hit  match-data-file        OpenVolley/backups/game3-match_1759740000000_ab12cd/latest.json "{}"
expect hit  match-data-file        game9/latest.json "{}"
expect hit  match-data-file        match-5/latest.json "{}"
expect hit  match-data-file        test-game1-s/latest.json "{}"
expect hit  match-data-file        debug_logs/notes.txt "-"
expect hit  match-data-file        logs_match_1_2026-11-12T10-15-00-000Z.txt "-"
expect hit  match-data-file        openvolley-diagnostics-20261112-1015-g1.txt "-"
expect hit  match-data-file        openvolley-diagnostics.txt "-"
expect hit  match-data-file        openvolley-activity-all-2026-11-12T10-15-00-000Z.csv "-"
expect hit  match-data-file        openvolley-activity.json "{}"
expect miss match-data-file        tests/fixtures/backup_g1_set1_scoreleft0_scoreright0_20250104_153045_123.json "{}"
expect miss match-data-file        tests/fixtures/game1-match_1/latest.json "{}"
expect miss match-data-file        latest.json "{}"
expect miss match-data-file        deploy/latest.json "{}"
expect miss match-data-file        deploy/systemd/openvolley-diagnostics-cleanup.timer "-"
expect miss match-data-file        docs/openvolley-activity-log.md "-"
expect miss match-data-file        backupManager.js "-"

if (( fails > 0 )); then
  echo "$fails case(s) failed"; exit 1
fi
echo "all cases passed"
