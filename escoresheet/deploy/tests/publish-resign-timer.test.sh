#!/usr/bin/env bash
# Offline test of publish-pkgs.sh's re-sign timer guard (SEC-54): a publish
# that syncs refuses, before any key or network use, when
# openvolley-pkgs-resign.timer is not enabled, when no successful re-sign is
# on record or the newest one is more than OV_PKGS_RESIGN_MAX_AGE_DAYS old;
# --without-resign-timer goes on with a warning; --no-sync and --resign are
# not held back. A successful re-sign is on record in the heartbeat file (new
# checkouts) or in systemd's record of the service's last run (also a checkout
# from before the heartbeat, until the next boot); the newer counts.
# systemctl is a stub (SD_RESULT, SD_STATUS, SD_EXIT: the last run's result,
# exit status and end time in Unix seconds; no SD_EXIT: never ran since boot);
# the package home is an empty scratch dir, so a run that passes the guard
# stops at the next check (tools or key). The unit documents the heartbeat.
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
# systemctl show prints what systemd 257 does for a service (no run since boot:
# an empty ExecMainExitTimestamp, Result=success)
cat >"$T/bin/systemctl" <<'EOF'
#!/bin/sh
echo "systemctl $*" >>"$CALLS"
case "$1" in
  is-enabled) [ "$TIMER" = enabled ] && exit 0 ;;
  show) printf 'Result=%s\nExecMainExitTimestamp=%s\nExecMainStatus=%s\n' \
          "${SD_RESULT:-success}" "${SD_EXIT:+@$SD_EXIT}" "${SD_STATUS:-0}"; exit 0 ;;
esac
exit 1
EOF
printf '#!/bin/sh\necho "curl $*" >>"$CALLS"\n' >"$T/bin/curl"
chmod +x "$T/bin/"*
export PATH="$T/bin:$PATH" CALLS="$T/calls" OV_PKGS_HOME="$T/home" OV_PKGS_DEST="$T/dest/"
unset OV_DESKTOP_RELEASE_DIR OV_PKGS_KUMA_PUSH_URL OV_PKGS_RESIGN_MAX_AGE_DAYS SD_RESULT SD_STATUS SD_EXIT
HB="$T/home/resign-heartbeat"
now=$(date +%s)
pp() { : >"$CALLS"; rc=0; "$KIT/publish-pkgs.sh" "$@" >"$T/log" 2>&1 || rc=$?; }
refused() { [[ "$rc" != 0 ]] && grep -q 'refusing to publish: ' "$T/log" && grep -qF -- "$1" "$T/log"; }
passed_guard() { ! grep -q 'refusing to publish: ' "$T/log"; }

TIMER=disabled pp
refused "openvolley-pkgs-resign.timer is not enabled" || bad "timer not enabled: not refused"
grep -q 'is-enabled --quiet openvolley-pkgs-resign.timer' "$CALLS" || bad "did not ask systemctl about the timer"
ok "timer not enabled: refused"

TIMER=enabled pp
refused "no successful re-sign on record" || bad "no heartbeat, no run in systemd: not refused"
# the way out it names: the checkout first (a checkout from before the
# heartbeat writes none), then one run
grep -qE 'git -C ~/ov-ops/pkgs-resign checkout --detach origin/main.*then sudo systemctl start openvolley-pkgs-resign\.service' "$T/log" ||
  bad "no record: the refusal does not say to move the re-sign checkout to main, then start the service"
ok "timer enabled but no re-sign on record: refused, naming the checkout and the first run"

# The installed checkout predates the heartbeat (SEC-54 review: ~/ov-ops/
# pkgs-resign at 62ab9773c): systemd's record of its last run counts
TIMER=enabled SD_EXIT=$((now - 86400)) pp
passed_guard || bad "no heartbeat, systemd: the last run succeeded yesterday: refused"
grep -q 'show --timestamp=unix .*openvolley-pkgs-resign.service' "$CALLS" || bad "did not ask systemd about the service's last run"
TIMER=enabled SD_EXIT=$((now - 20 * 86400)) pp
refused "the last re-sign was 20 days ago" || bad "systemd: the last success 20 days ago: not refused"
TIMER=enabled SD_EXIT=$((now - 86400)) SD_RESULT=exit-code SD_STATUS=1 pp
refused "its last run failed (systemd: Result=exit-code, status 1)" || bad "systemd: the last run failed, no heartbeat: not refused"
grep -q 'checkout --detach origin/main' "$T/log" || bad "failed run: the refusal does not name the checkout"
ok "no heartbeat: systemd's last successful run counts (yesterday passes, 20 days or a failed run is refused)"

echo "2026-11-01T04:20:00Z Wed, 01 Dec 2026" >"$HB"; touch -d '-20 days' "$HB"
TIMER=enabled pp
refused "the last re-sign was 20 days ago" || bad "stale heartbeat: not refused"
OV_PKGS_RESIGN_MAX_AGE_DAYS=30 TIMER=enabled pp
passed_guard || bad "OV_PKGS_RESIGN_MAX_AGE_DAYS=30 should accept a 20-day-old heartbeat"
ok "last re-sign older than OV_PKGS_RESIGN_MAX_AGE_DAYS: refused"

TIMER=enabled SD_EXIT=$((now - 86400)) pp
passed_guard || bad "a 20-day-old heartbeat and a successful run yesterday in systemd: refused"
ok "a stale heartbeat and a newer successful run in systemd: the newer counts"

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
