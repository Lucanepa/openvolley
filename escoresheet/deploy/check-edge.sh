#!/usr/bin/env bash
# check-edge.sh [domain]   (default openvolley.app)
#
# Read-only pre-go-live check of the edge and the mail domain
# (RUNBOOK-hetzner.md, "Edge and mail domain"). Run it before go-live and after
# every Cloudflare or DNS change, from any machine with dig, openssl and curl.
# It changes nothing. Exit 0 = every check passed; 1 = at least one failed.
#
#   CAA     only the CAs Cloudflare and this kit use (pki.goog, letsencrypt.org,
#           ssl.com, as issue and issuewild) plus an iodef contact
#   DMARC   p=quarantine or p=reject, with rua (the aggregate reports)
#   TLS     TLS 1.0 and 1.1 refused, TLS 1.2 accepted (backend., app., get.)
#   HTTPS   http:// redirects to https://; https:// sends Strict-Transport-Security
set -uo pipefail

DOMAIN=${1:-openvolley.app}
HOSTS=("backend.$DOMAIN" "app.$DOMAIN" "get.$DOMAIN")
ALLOWED_CAS='^(pki\.goog|letsencrypt\.org|ssl\.com)$'
for t in dig openssl curl; do
  command -v "$t" >/dev/null || { echo "check-edge: needs $t" >&2; exit 2; }
done

FAILED=0
pass() { printf 'ok    %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; FAILED=1; }

# --- CAA ---------------------------------------------------------------------
caa=$(dig +short CAA "$DOMAIN")
if [[ -z "$caa" ]]; then
  fail "CAA $DOMAIN: no records (any CA may issue)"
else
  bad=0
  for tag in issue issuewild; do
    cas=$(awk -v t="$tag" '$2 == t { gsub(/"/, "", $3); sub(/;.*/, "", $3); print $3 }' <<<"$caa" | sort -u)
    [[ -n "$cas" ]] || { fail "CAA $DOMAIN: no $tag records"; bad=1; continue; }
    while read -r ca; do
      [[ "$ca" =~ $ALLOWED_CAS ]] || { fail "CAA $DOMAIN: $tag \"$ca\" is not one of pki.goog, letsencrypt.org, ssl.com"; bad=1; }
    done <<<"$cas"
  done
  grep -q ' iodef "mailto:' <<<"$caa" || { fail "CAA $DOMAIN: no iodef \"mailto:...\" contact"; bad=1; }
  (( bad )) || pass "CAA $DOMAIN: $(tr '\n' ' ' <<<"$caa")"
fi

# --- DMARC -------------------------------------------------------------------
dmarc=$(dig +short TXT "_dmarc.$DOMAIN" | tr -d '"' | tr -s ' ')
if [[ "$dmarc" =~ (^|[;[:space:]])p=(quarantine|reject)([;[:space:]]|$) && "$dmarc" == *rua=* ]]; then
  pass "DMARC _dmarc.$DOMAIN: $dmarc"
else
  fail "DMARC _dmarc.$DOMAIN: want p=quarantine or p=reject with rua, got: ${dmarc:-nothing}"
fi

# --- TLS versions and HTTPS --------------------------------------------------
tls() { openssl s_client -connect "$1:443" -servername "$1" "-$2" </dev/null >/dev/null 2>&1; }
for h in "${HOSTS[@]}"; do
  for v in tls1 tls1_1; do
    if tls "$h" "$v"; then fail "TLS $h: $v accepted (Minimum TLS Version must be 1.2)"; else pass "TLS $h: $v refused"; fi
  done
  if tls "$h" tls1_2; then pass "TLS $h: tls1_2 accepted"; else fail "TLS $h: tls1_2 refused"; fi

  loc=$(curl -sS -o /dev/null -m 15 -w '%{http_code} %{redirect_url}' "http://$h/" 2>/dev/null)
  if [[ "$loc" =~ ^30[1278]\ https:// ]]; then pass "HTTP $h: redirects to https"; else fail "HTTP $h: http:// answers '${loc:-no answer}' instead of a redirect to https:// (Always Use HTTPS)"; fi

  path=/; [[ "$h" == backend.* ]] && path=/health
  hsts=$(curl -sS -o /dev/null -D - -m 15 "https://$h$path" 2>/dev/null | tr -d '\r' | awk 'tolower($1) == "strict-transport-security:" { $1 = ""; print substr($0, 2) }')
  if [[ "$hsts" =~ max-age=([0-9]+) ]] && (( BASH_REMATCH[1] >= 31536000 )); then pass "HSTS $h: $hsts"; else fail "HSTS $h: want max-age>=31536000, got: ${hsts:-none}"; fi
done

(( FAILED )) && { echo "check-edge: some checks FAILED (RUNBOOK-hetzner.md, Edge and mail domain)"; exit 1; }
echo "check-edge: all checks passed"
