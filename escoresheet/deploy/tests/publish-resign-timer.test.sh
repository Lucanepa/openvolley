#!/usr/bin/env bash
# Offline test of publish-pkgs.sh's re-sign timer guard (SEC-54): a publish
# that syncs refuses, before any key or network use, when
# openvolley-pkgs-resign.timer is not enabled, when the re-sign never ran
# (no heartbeat) or last ran more than OV_PKGS_RESIGN_MAX_AGE_DAYS ago;
# --without-resign-timer goes on with a warning; --no-sync and --resign are
# not held back. systemctl is a stub; the package home is an empty scratch
# dir, so a run that passes the guard stops at the next check (tools or key).
# The unit documents the heartbeat.
#
#   escoresheet/deploy/tests/publish-resign-timer.test.sh
set -euo pipefail
KIT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
T=$(mktemp -d "${TMPDIR:-/tmp}/ov-resign-timer-test.XXXXXX")
trap 'rm -rf -- "$T"' EXIT
PASS=0
ok() { PASS=$((PASS + 1)); echo "ok   $*"; }
bad() { echo "FAIL $*" >&2; [[ -f "$T/log" ]] && sed 's/^/     /' "$T/log" >&2; exit 1; }

mkdir -p "$T/bin" "$T/home"
cat >"$T/bin/systemctl" <<'EOF'
#!/bin/sh
echo "systemctl $*" >>"$CALLS"
[ "$1" = is-enabled ] && [ "$TIMER" = enabled ] && exit 0
exit 1
EOF
printf '#!/bin/sh\necho "curl $*" >>"$CALLS"\n' >"$T/bin/curl"
chmod +x "$T/bin/"*
export PATH="$T/bin:$PATH" CALLS="$T/calls" OV_PKGS_HOME="$T/home" OV_PKGS_DEST="$T/dest/"
unset OV_DESKTOP_RELEASE_DIR OV_PKGS_KUMA_PUSH_URL OV_PKGS_RESIGN_MAX_AGE_DAYS
HB="$T/home/resign-heartbeat"
pp() { : >"$CALLS"; rc=0; "$KIT/publish-pkgs.sh" "$@" >"$T/log" 2>&1 || rc=$?; }
refused() { [[ "$rc" != 0 ]] && grep -q 'refusing to publish: ' "$T/log" && grep -qF -- "$1" "$T/log"; }
passed_guard() { ! grep -q 'refusing to publish: ' "$T/log"; }

TIMER=disabled pp
refused "openvolley-pkgs-resign.timer is not enabled" || bad "timer not enabled: not refused"
grep -q 'is-enabled --quiet openvolley-pkgs-resign.timer' "$CALLS" || bad "did not ask systemctl about the timer"
ok "timer not enabled: refused"

TIMER=enabled pp
refused "the re-sign has not run since it was installed" || bad "no heartbeat: not refused"
ok "timer enabled but never ran: refused"

echo "2026-11-01T04:20:00Z Wed, 01 Dec 2026" >"$HB"; touch -d '-20 days' "$HB"
TIMER=enabled pp
refused "the last re-sign was 20 days ago" || bad "stale heartbeat: not refused"
OV_PKGS_RESIGN_MAX_AGE_DAYS=30 TIMER=enabled pp
passed_guard || bad "OV_PKGS_RESIGN_MAX_AGE_DAYS=30 should accept a 20-day-old heartbeat"
ok "last re-sign older than OV_PKGS_RESIGN_MAX_AGE_DAYS: refused"

touch "$HB"
TIMER=enabled pp
passed_guard || bad "fresh heartbeat: refused"
[[ "$rc" != 0 ]] && grep -qE 'not found|no signing key' "$T/log" || bad "fresh heartbeat: expected the next check (tools or key) to stop it"
ok "timer enabled and a fresh heartbeat: passes the guard"

rm -f "$HB"
TIMER=disabled pp --without-resign-timer
passed_guard && grep -q 'WARNING (--without-resign-timer): the re-sign timer' "$T/log" || bad "--without-resign-timer: no warning, or refused"
ok "--without-resign-timer: publishes with a warning"

TIMER=disabled pp --no-sync
passed_guard && ! grep -q 'is-enabled' "$CALLS" || bad "--no-sync was held back by the timer guard"
TIMER=disabled pp --resign
passed_guard || bad "--resign was held back by the timer guard"
ok "--no-sync and --resign are not held back"

TIMER=disabled OV_PKGS_NTFY_URL=https://ntfy.example.invalid/ov pp --resign
[[ "$rc" != 0 ]] && grep -q 'Title: OpenVolley APT re-sign FAILED' "$CALLS" || bad "a failed --resign did not post to ntfy"
TIMER=disabled OV_PKGS_NTFY_URL=https://ntfy.example.invalid/ov pp
! grep -q 'ntfy.example.invalid' "$CALLS" || bad "an interactive publish posted to ntfy"
ok "a failed --resign (the timer) posts to OV_PKGS_NTFY_URL, an interactive refusal does not"

U="$KIT/systemd/openvolley-pkgs-resign.service"
grep -q 'resign-heartbeat' "$U" && grep -qE '^Environment=OV_PKGS_NTFY_URL=.' "$U" || bad "the unit: heartbeat, ntfy"
grep -q 'printf .* >"$RESIGN_HEARTBEAT.tmp"' "$KIT/publish-pkgs.sh" || bad "--resign does not write the heartbeat"
ok "--resign writes the heartbeat the unit documents"

echo "publish-resign-timer.test.sh: $PASS passed"
