#!/usr/bin/env bash
# Offline tests for check-edge.sh's TLS probe against local openssl s_server
# instances (127.0.0.1, port 0): a TLS 1.2-only server refuses TLS 1.0, a
# server that allows TLS 1.0 is reported as accepting it, and a client that
# cannot offer TLS 1.0 is "cannot-test", not "refused".
#
#   escoresheet/deploy/tests/check-edge.test.sh
set -euo pipefail
KIT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
T=$(mktemp -d "${TMPDIR:-/tmp}/ov-edge-test.XXXXXX")
PIDS=()
trap 'kill "${PIDS[@]}" 2>/dev/null; rm -rf -- "$T"' EXIT
PASS=0
ok() { PASS=$((PASS + 1)); echo "ok   $*"; }
bad() { echo "FAIL $*" >&2; exit 1; }

openssl req -x509 -newkey rsa:2048 -nodes -keyout "$T/key" -out "$T/cert" -subj /CN=localhost -days 1 2>/dev/null
# serve name [s_server options...] -> sets PORT
serve() {
  local name=$1; shift
  OPENSSL_CONF=/dev/null openssl s_server -accept 127.0.0.1:0 -cert "$T/cert" -key "$T/key" -www "$@" >"$T/$name" 2>&1 &
  PIDS+=($!)
  for _ in $(seq 50); do PORT=$(sed -n 's/^ACCEPT .*:\([0-9]*\)$/\1/p' "$T/$name"); [[ -n "$PORT" ]] && return; sleep 0.1; done
  bad "s_server $name did not start"
}
probe() { "$KIT/check-edge.sh" --tls-probe 127.0.0.1 "$1" "$2"; }

serve modern -no_tls1 -no_tls1_1
[[ $(probe "$PORT" tls1) == refused ]] || bad "TLS 1.2-only server: tls1 should be refused"
[[ $(probe "$PORT" tls1_2) == accepted ]] || bad "TLS 1.2-only server: tls1_2 should be accepted"
ok "TLS 1.2-only server: tls1 refused, tls1_2 accepted"

serve legacy -cipher 'DEFAULT:@SECLEVEL=0'
[[ $(probe "$PORT" tls1) == accepted ]] || bad "server allowing TLS 1.0: tls1 should be accepted (client must really offer it)"
ok "server allowing TLS 1.0: reported as accepted"

mkdir "$T/bin"
cat >"$T/bin/openssl" <<'STUB'
#!/usr/bin/env bash
echo 'CONNECTED(00000003)'
echo '40E7:error:0A0000BF:SSL routines:tls_setup_handshake:no protocols available' >&2
exit 1
STUB
chmod +x "$T/bin/openssl"
[[ $(PATH="$T/bin:$PATH" probe "$PORT" tls1) == cannot-test ]] || bad "client without TLS 1.0 should be cannot-test"
ok "client that cannot offer TLS 1.0: cannot-test, not refused"

[[ $(probe 1 tls1) == no-answer ]] || bad "closed port should be no-answer"
ok "closed port: no-answer, not refused"

echo "check-edge.sh: ${PASS} passed"
