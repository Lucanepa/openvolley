#!/usr/bin/env bash
# Deploy the pending KSCW LedBox BRIDGE changes to the board.
# Run this once the board (pi@192.168.5.1, reached via the `openvolley` Pi jump host) is ON.
#
# What it ships: the PIN-gate (scorer lock) + the already-built history and shutdown backends,
# and the redesigned control UI. The firmware's crest+QR idle screen lives on the board's own
# disk and survives power cycles, so it is NOT part of this script (see firmware/idle-crest-qr/
# if you ever need to restore it).
set -euo pipefail
J=(-J openvolley -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)
REPO="$(cd "$(dirname "$0")" && pwd)"
BOARD=pi@192.168.5.1

echo "== 1) board reachable? =="
ssh "${J[@]}" "$BOARD" hostname || { echo "!! board not reachable — is it powered on and the Pi up?"; exit 1; }

echo "== 2) back up current bridge files on the board =="
ssh "${J[@]}" "$BOARD" 'D=/home/pi/ledbox-bridge
  cp -f "$D/src/controlServer.js" "$D/src/controlServer.js.pre-pin" 2>/dev/null || true
  cp -f "$D/src/settings.js"      "$D/src/settings.js.pre-pin"      2>/dev/null || true
  cp -f "$D/web/index.html"       "$D/web/index.html.pre-pin"       2>/dev/null || true
  echo backed-up'

echo "== 3) copy bridge (PIN gate + history + shutdown + UI) =="
scp "${J[@]}" "$REPO/src/settings.js" "$REPO/src/controlServer.js" "$REPO/src/historyStore.js" "$BOARD:/home/pi/ledbox-bridge/src/"
scp "${J[@]}" "$REPO/web/index.html" "$BOARD:/home/pi/ledbox-bridge/web/index.html"

echo "== 4) restart bridge =="
ssh "${J[@]}" "$BOARD" 'sudo systemctl restart ledbox-bridge'
sleep 6

echo "== 5) verify =="
ssh "${J[@]}" "$BOARD" '
  echo -n "bridge: "; systemctl is-active ledbox-bridge
  N=/opt/nodejs/bin/node
  $N -e "fetch(\"http://127.0.0.1:8890/api/status\").then(r=>r.json()).then(s=>console.log(\"  connected=\"+(s.ledbox&&s.ledbox.connected),\"pinRequired=\"+s.pinRequired)).catch(e=>console.log(\"  status ERR\",e.message))"
  $N -e "fetch(\"http://127.0.0.1:8890/\").then(r=>r.text()).then(t=>console.log(\"  UI has PIN gate:\", t.includes(\"X-Scorer-Pin\"))).catch(()=>{})"'

echo
echo "DONE. To turn the lock on: open the control UI -> Settings -> Access -> Scorer PIN, set a code, Save."
echo "Until a PIN is set it stays open (shared control, current behaviour)."
