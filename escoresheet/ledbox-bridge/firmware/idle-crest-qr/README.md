# Crest + QR idle screen (board firmware layouts)

The board's idle/resting screen: the KSC Wiedikon crest, flanked by a **"Join WiFi"** QR
(left) and an **"Open UI"** QR (right). These live on the **board firmware**, not the bridge.

Where they go on the board (`pi@192.168.5.1`, via the `openvolley` jump host):

| File here | Board path |
|---|---|
| `waiting.xml` | `/home/pi/ledbox/layout/system/waiting.xml` — firmware default idle |
| `32_kscw_crest.xml` | `/home/pi/ledbox/layout/32_kscw_crest.xml` — the layout the bridge shows when idle |
| `media/wifi_qr.png` | `/home/pi/ledbox/media/wifi_qr.png` |
| `media/ui_qr.png` | `/home/pi/ledbox/media/ui_qr.png` |

Both idle layouts carry the QRs so the crest+QR screen shows whether the firmware's own
`waiting` layout or the bridge's `kscw_crest` layout is active. Already deployed; persists
across power cycles. Kept here for versioning / restore.

QR contents:
- `wifi_qr.png` = `WIFI:T:WPA;S:ledbox_C0270;P:47561052;;`
- `ui_qr.png` = `http://172.24.1.1:8890`

Regenerate the QR PNGs (pure-python, no PIL needed) — see the encoder used in the session
(`qrcode.get_matrix()` + a hand-rolled PNG writer), both forced to QR version 3 so they render
at the same 48×48 px. Labels are `<section type="text">` above each image in the two layouts.

## Restore after a firmware reflash
```bash
J="-J openvolley -o StrictHostKeyChecking=accept-new"
scp $J media/wifi_qr.png media/ui_qr.png pi@192.168.5.1:/home/pi/ledbox/media/
scp $J waiting.xml       pi@192.168.5.1:/home/pi/w.xml
scp $J 32_kscw_crest.xml pi@192.168.5.1:/home/pi/c.xml
ssh $J pi@192.168.5.1 'sudo cp /home/pi/w.xml /home/pi/ledbox/layout/system/waiting.xml
  sudo cp /home/pi/c.xml /home/pi/ledbox/layout/32_kscw_crest.xml
  rm -f /home/pi/w.xml /home/pi/c.xml
  PID=$(pgrep -f "[l]edbox\.py" | head -1); [ -n "$PID" ] && sudo kill "$PID"'  # watchdog respawns it
```

## ⚠️ CRITICAL
Never leave a backup file (e.g. `waiting.xml.bak`) **inside** `/home/pi/ledbox/layout/`.
The firmware's layout scanner does `filename, extension = f.split('.')`, which throws on any
multi-dot filename and hangs the board at **"starting…"**. Keep backups **outside** the layout
tree (e.g. `/home/pi/ledbox-layout-backups/`).
