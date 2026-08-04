#!/usr/bin/env bash
# Deploy the KSCW LedBox BRIDGE to the board.
# Run this once the board (pi@192.168.5.1, reached via the `openvolley` Pi jump host) is ON.
# From cold the board's ethernet only links ~50s after power-on and it answers ~2 min in, so a
# run started straight after switching it on can fail step 1 — wait rather than assume a fault.
#
# Ships the WHOLE of src/ and the WHOLE of web/. It used to name individual files, which meant
# every change had to remember to add itself to the list — and one that didn't (a fix living in
# ledboxClient.js) would deploy "successfully" while the actual fix never reached the board. The
# same trap caught web/ when logs.html arrived, so both are now synced wholesale.
#
# NOT shipped: the firmware's crest+QR idle screen (lives on the board's own disk and survives
# power cycles — see firmware/idle-crest-qr/), settings.json (the board's operator preferences)
# and data/ (its match history).
set -euo pipefail
J=(-J openvolley -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)
REPO="$(cd "$(dirname "$0")" && pwd)"
BOARD=pi@192.168.5.1
DEST=/home/pi/ledbox-bridge
STAMP="$(date +%Y%m%d-%H%M%S)"
KEEP=5 # how many previous deploys to keep under .deploy-backups (see step 2)

echo "== 1) board reachable? =="
ssh "${J[@]}" "$BOARD" hostname || { echo "!! board not reachable — is it powered on and the Pi up? (needs ~2 min from cold)"; exit 1; }

echo "== 2) back up what is on the board now =="
# KEEP is a cap, not a suggestion: the board is a 6.8G SD card and this used to add a backup per
# deploy with nothing ever removing one. Timestamped names sort chronologically, so "all but the
# newest KEEP" is just a tail of the sorted list.
ssh "${J[@]}" "$BOARD" "B=$DEST/.deploy-backups/$STAMP
  mkdir -p \"\$B\"
  cp -a $DEST/src \"\$B/src\" 2>/dev/null || true
  cp -a $DEST/web \"\$B/web\" 2>/dev/null || true
  echo \"  backed up to \$B\"
  cd $DEST/.deploy-backups 2>/dev/null && ls -1d 20* 2>/dev/null | sort -r | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -rf -- \"\$old\" && echo \"  pruned old backup \$old\"
  done
  true"

echo "== 3) copy bridge sources + control UI =="
scp "${J[@]}" "$REPO"/src/*.js "$BOARD:$DEST/src/"
scp "${J[@]}" "$REPO"/web/*.html "$BOARD:$DEST/web/"

echo "== 4) restart bridge =="
ssh "${J[@]}" "$BOARD" 'sudo systemctl restart ledbox-bridge'
sleep 6

echo "== 5) verify =="
ssh "${J[@]}" "$BOARD" "
  echo -n '  bridge: '; systemctl is-active ledbox-bridge
  N=/opt/nodejs/bin/node
  \$N -e 'fetch(\"http://127.0.0.1:8890/api/status\").then(r=>r.json()).then(s=>console.log(\"  connected=\"+(s.ledbox&&s.ledbox.connected),\"sport=\"+s.sport,\"pinRequired=\"+s.pinRequired)).catch(e=>console.log(\"  status ERR\",e.message))'
  # Prove the NEW code is what is actually running — not merely that something started.
  grep -q SELF-CLOCKED     $DEST/src/ledboxClient.js && echo '  ✓ self-clocked blink'      || echo '  ✗ blink fix MISSING'
  grep -q showSportConfirm $DEST/src/ledboxClient.js && echo '  ✓ sport confirmation'      || echo '  ✗ sport confirm MISSING'
  grep -q sport-switch     $DEST/src/appliance.js    && echo '  ✓ sport-switch marker'     || echo '  ✗ marker MISSING'
  grep -q LAST_STATUS      $DEST/web/index.html      && echo '  ✓ UI status-merge'         || echo '  ✗ UI fix MISSING'
  test -f $DEST/web/logs.html                        && echo '  ✓ /logs viewer'            || echo '  ✗ logs.html MISSING'
  grep -q logStore         $DEST/src/appliance.js    && echo '  ✓ structured logging'      || echo '  ✗ logging MISSING'"

echo
echo "DONE. Roll back with:"
echo "  ssh -J openvolley $BOARD 'cp -a $DEST/.deploy-backups/$STAMP/src/. $DEST/src/ && cp -a $DEST/.deploy-backups/$STAMP/web/. $DEST/web/ && sudo systemctl restart ledbox-bridge'"
