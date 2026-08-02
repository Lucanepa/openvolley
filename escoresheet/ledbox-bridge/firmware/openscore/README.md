# openscore — open-source LedBox firmware

Replaces the **one closed layer** left in the KSCW scoreboard stack. The board's stock firmware
(`/home/pi/ledbox/ledbox.py` + friends) is Tech4Sport's proprietary app **decompiled and
hand-ported to Python** — the only closed/legally-grey layer, and the reason the repo is private.
`openscore.py` is a **clean-room, from-scratch** reimplementation (designed only from the open
protocol docs, the bridge's wire code and the public layout XML — **no vendor code was read**)
that speaks the same protocol and renders the same layouts, so the whole stack becomes open:

```
control UI + bridge (open)  ->  openscore.py (open)  ->  flushBuffer2 (open)  ->  LED panel
        Node                        this — Python           hzeller rgb-matrix      HUB75 192×64
```

See **`DESIGN.md`** for the architecture and a table of every protocol message and section type;
**`ROADMAP.md`** for the path from here to board cutover.

## How it works

`openscore` keeps the exact **render → PNG → panel** split the stock firmware used:

- **Protocol** — TCP `:8889`, gzip'd JSON `{cmd,value}` ⇆ `{status,sender,value}`, one
  self-delimiting gzip member per message. Byte-compatible with `src/ledboxProtocol.js`.
- **Layouts** — the same `layout/*.xml` + `layout/system/*.xml` files (team1/score1/set1/…).
- **Render** — Pillow draws the current layout's sections onto a 192×64 image and writes
  `www/buffer.png` **atomically**.
- **Panel** — the already-open, panel-verified `flushBuffer2` (`../flushbuffer/`) continuously
  reloads `buffer.png` and drives the HUB75 panel over GPIO. `openscore` never touches GPIO —
  which is why it can be **fully validated with no panel**.

## Why it's better / less error-prone than the vendor firmware

| Vendor bug | openscore |
|---|---|
| Port `:8889` **wedges ~80 s** when a client dies without `Disconnect` (needs a power-cycle) | dead socket dropped immediately; new client always accepted; falls back to idle |
| `noresend: true` → bridge **stalls 5 s** on a redundant `SetLayout` | `noresend: false`, **always replies** — no stalls |
| layout scanner `f.split('.')` **crashes** on any multi-dot filename | globs `*.xml` + `os.path.splitext` — bad files skipped with a warning |
| `fontsize` clips long names (fixed bitmap boxes) | **shrink-to-fit** text scales names down to their box |
| accepts the malformed READ shape silently | rejects it with **error 9**, exactly like real hardware |
| py2 remnants, latin-1 umlaut breakage | UTF-8 throughout, structured logging |

## Quick start (any machine, no board)

The scaffold is **self-contained** — `layout/`, `media/` and `setting.ini` ship alongside it.

```bash
pip install pillow            # the only dependency (rendering); the server runs without it

# 1) Prove the protocol over a real socket (handshake + parsing + error codes + render):
python3 selftest.py           # -> "15/15 checks passed"

# 2) Render every screen to samples/*.png for eyeball validation (no panel):
python3 render_samples.py     # -> samples/00_waiting.png … 07_info.png (192×64 each)

# 3) Run the server for real and inspect the live frame:
python3 openscore.py         # listens on 0.0.0.0:8889; writes www/buffer.png
#   (use --port 18889 to avoid clashing with anything already on 8889)
```

`openscore.py --help` covers `--base-dir` (defaults to this dir), `--host`, `--port`, `--font`.

## Prove the handshake with the real bridge

Point the existing (unchanged) bridge at openscore and watch it complete `Init → SetLayout →
SetSections`:

```bash
# terminal 1 — the open firmware
cd firmware/openscore && python3 openscore.py --port 8889

# terminal 2 — the bridge, aimed at the firmware (from the repo root)
LEDBOX_HOST=127.0.0.1 LEDBOX_PORT=8889 MATCH_ID=1 npm start
#   the bridge connects, Init handshakes, SetLayout(volleyball_matchscore_02) is accepted,
#   and score updates land as SetSections — visible in openscore's per-command log and in
#   www/buffer.png. (LEDBOX_HOST/LEDBOX_PORT are read by src/config.js.)
```

`selftest.py` reproduces exactly this handshake with a stdlib-only client, so you don't need Node
just to confirm the wire protocol.

## Deploy on the board (replaces ledbox.py) — see ROADMAP Phase 3–4

> ⚠️ Do this **with eyes on the panel** — a wrong render is invisible over the network, and
> fonts/positions will need calibration (the vendor tuned `fontsize` to bitmap fonts; we render
> scalable TTF). Keep the stock firmware as a fallback; **never** put a backup file inside
> `layout/` (that scan is fragile). Full checklist in `ROADMAP.md`.

1. `sudo apt install -y python3-pil` (or `pip3 install --break-system-packages pillow`).
2. Copy `openscore.py` + `layout/` + `media/` to `/home/pi/ledbox/` (point `buffer_path` at the
   `www/buffer.png` flushBuffer2 already polls). Try it first on a **spare port** alongside the
   vendor stack.
3. Edit `bin/startledbox` to run `python3 -u openscore.py` instead of `ledbox.py`. Leave
   `bin/startled` (flushBuffer2) untouched.
4. Restart via the watchdog (`sudo systemctl restart ledbox-watchdog`) or reboot; watch the panel.
5. Calibrate fonts/positions in `layout/*.xml`, then retire `ledbox.py`.

Config comes from `setting.ini` (`[DISPLAY] width/height`, `[TCP] port`) and, if present,
`user_setting.ini` (`[GENERAL] device`) — same as the stock firmware. `--font` overrides the TTF.

## Scope

Implements the working set the bridge (our only client) uses: `Init, SetLayout, SetSections,
SetSection, GetLayout, GetSections, ReloadLayout, Info, showInfo, Horn, Clear, StopAllProcess,
ChangeWaiting, Disconnect`. Section types `text, image, rectangle, circle, bar`. Vendor extras the
bridge never calls (media/layout upload on `:12345`, network-admin commands, Bluetooth/serial,
playlist/practice plugins, native animations) are intentionally omitted and fail cleanly with
`error 1` — add them only if a non-bridge client needs them (`DESIGN.md` §4–§5, §9).

## Files

`openscore.py` (the firmware) · `selftest.py` · `render_samples.py` · `setting.ini` · `layout/` ·
`media/` · `www/` (output) · `DESIGN.md` · `ROADMAP.md` · `PANEL-AND-DIY.md` (rebuild an
equivalent panel from open parts).
