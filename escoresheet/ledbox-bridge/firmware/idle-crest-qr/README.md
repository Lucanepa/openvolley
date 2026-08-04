# Crest + QR idle screen (board firmware layouts)

The board's idle/resting screen: the KSC Wiedikon crest, flanked by a **"Join WiFi"** QR
(left) and an **"Open UI"** QR (right). These live on the **board firmware**, not the bridge.

There are **two** crest screens and the bridge picks between them (`ledboxClient.showIdle`):

| Screen | When | Why |
|---|---|---|
| `kscw_crest` | nobody on the control UI | The QRs are instructions for getting connected. |
| `kscw_clock` | an operator is on the control UI | Once they're connected the QRs are dead space, so it carries the wall clock instead. |

"Connected" = the control server saw an API request within `viewerTimeoutMs` (20s; the UI polls
every 1.5s). Both are the *no-teams-known* screen — once teams are set, `kscw_idle` already uses
that side of the panel for their names.

Where they go on the board (`pi@192.168.5.1`, via the `openvolley` jump host):

| File here | Board path |
|---|---|
| `waiting.xml` | `/home/pi/ledbox/layout/system/waiting.xml` — firmware default idle |
| `32_kscw_crest.xml` | `/home/pi/ledbox/layout/32_kscw_crest.xml` — crest + QRs (nobody connected) |
| `33_kscw_clock.xml` | `/home/pi/ledbox/layout/33_kscw_clock.xml` — crest + wall clock (someone connected) |
| `media/wifi_qr.png` | `/home/pi/ledbox/media/wifi_qr.png` |
| `media/ui_qr.png` | `/home/pi/ledbox/media/ui_qr.png` |

## `kscw_clock` geometry (192×64)

Crest at x=3 y=4, 53×56 — the same placement as `kscw_idle`. The remaining column is x=64..192
(128px), with both text sections centred on x=128:

| Section | Font | Content | Measured width |
|---|---|---|---|
| `time` | 28, white | `HH:MM:SS` | 109px |
| `date` | 14, club gold | `Ddd DD.MM.YYYY` | ≤95px |

Widths were measured against the board's own `/home/pi/ledbox/fonts/ARIAL.TTF` using the same
call the firmware makes (`ImageFont.truetype(font, fontsize)`, width = `getbbox(text)[2]`), so
they are what the panel actually draws. Both are comfortably inside the 128px column; the date
is a fixed 14 characters, so no weekday or date can outgrow it.

The bridge writes `time`/`date` once a minute (only on an actual rollover), never per second.

> The board has **no RTC**. Its clock is only right because it reaches the internet through the
> `openvolley` Pi — see `ledbox-nat.service` on that Pi. If that NAT rule is missing the panel
> will happily display a confidently wrong time.

Both idle layouts carry the QRs so the crest+QR screen shows whether the firmware's own
`waiting` layout or the bridge's `kscw_crest` layout is active. Already deployed; persists
across power cycles. Kept here for versioning / restore.

QR contents:
- `wifi_qr.png` = `WIFI:T:WPA;S:ledbox_C0270;P:<AP passphrase>;;` — **NOT in git, and must never be.**
  The image *is* the passphrase: anyone who points a phone at it has the credential, so committing
  it to this public repo published the board's AP. (It was, until 2026-08-04; the passphrase has
  since been rotated and the file gitignored.) It is derived, not source — regenerate it:
  ```bash
  python3 gen_qr.py --wifi-pass "$(rbw get 'LedBox - ledbox_C0270 WiFi (Tech4Sport)')"
  ```
  The passphrase itself lives in Vaultwarden and in `/etc/hostapd/hostapd.conf` on the board;
  those two must match or the QR joins nothing.
- `ui_qr.png` = `http://172.24.1.1:8890` (no secret — safe to commit)

Regenerate the QR PNGs (pure-python, no PIL needed) — see the encoder used in the session
(`qrcode.get_matrix()` + a hand-rolled PNG writer), both forced to QR version 3 so they render
at the same 48×48 px. Labels are `<section type="text">` above each image in the two layouts.

## Restore after a firmware reflash
```bash
J="-J openvolley -o StrictHostKeyChecking=accept-new"
# wifi_qr.png is gitignored, so a fresh clone has to rebuild it first (see "QR contents" above).
python3 gen_qr.py --wifi-pass "$(rbw get 'LedBox - ledbox_C0270 WiFi (Tech4Sport)')"
scp $J media/wifi_qr.png media/ui_qr.png pi@192.168.5.1:/home/pi/ledbox/media/
scp $J waiting.xml       pi@192.168.5.1:/home/pi/w.xml
scp $J 32_kscw_crest.xml pi@192.168.5.1:/home/pi/c.xml
scp $J 33_kscw_clock.xml pi@192.168.5.1:/home/pi/k.xml
ssh $J pi@192.168.5.1 'sudo cp /home/pi/w.xml /home/pi/ledbox/layout/system/waiting.xml
  sudo cp /home/pi/c.xml /home/pi/ledbox/layout/32_kscw_crest.xml
  sudo cp /home/pi/k.xml /home/pi/ledbox/layout/33_kscw_clock.xml
  rm -f /home/pi/w.xml /home/pi/c.xml /home/pi/k.xml
  PID=$(pgrep -f "[l]edbox\.py" | head -1); [ -n "$PID" ] && sudo kill "$PID"'  # watchdog respawns it
```

Note the staging via `/home/pi/*.xml`: the layout tree is scanned with `f.split('.')`, so a file
must be copied in under its final single-dot name — see the warning below.

## ⚠️ CRITICAL
Never leave a backup file (e.g. `waiting.xml.bak`) **inside** `/home/pi/ledbox/layout/`.
The firmware's layout scanner does `filename, extension = f.split('.')`, which throws on any
multi-dot filename and hangs the board at **"starting…"**. Keep backups **outside** the layout
tree (e.g. `/home/pi/ledbox-layout-backups/`).
