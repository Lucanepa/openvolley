# LEDBox firmware 0.552 — KSC Wiedikon build

> **Per Emilio (IT):** la 0.552 è la 0.551 con tutti i bug Python-3 corretti. La
> 0.551 originale è una migrazione py2→py3 lasciata a metà: su Raspberry Pi OS
> bookworm (Python 3.11) va in errore in più punti — il più grave rompe
> l'aggiornamento dei punteggi (`SetSection`). Questa build gira già sul tabellone
> del KSC Wiedikon ed è stata verificata riga per riga contro la tua 0.551.

## What this is

`0.552` is a clean, fully-Python-3 firmware for the LedBox C0270. It was produced by:

1. decompiling the vendor `0.550` `.pyc` (the build the phone-app "update" pushed onto
   the board, which is Python **2** and cannot run on the board's Python 3.11);
2. porting it to Python 3 (automated `2to3` + hand fixes);
3. **reconciling it, function by function at the AST level, against the genuine
   `0.551` source** (thank you for sending it).

That reconciliation is the reason for this file. The genuine `0.551` turned out to be a
*half-finished* py2→py3 migration: some spots were converted, others were left as Python 2
and silently misbehave on Python 3.11. This build fixes all of them. **Deploying the vendor
`0.551` as-is would re-break the board.**

## Bugs in genuine 0.551 that 0.552 fixes

All confirmed by comparing the two sources; all on code paths the board actually uses.

| # | File · function | Python-2 code left in 0.551 | Effect on the board (Py 3.11) | 0.552 fix |
|---|---|---|---|---|
| 1 | `ledboxAPI.py` · `SetSection` | `str(type(v)) == "<type 'list'>"` | Always **False** on py3 → a list of attributes (the normal score push) falls into the single-attribute branch and indexes a list by a string → **TypeError, score won't update** | `isinstance(v, list)` |
| 2 | `ledboxAPI.py` · `SetSection` | `result` only assigned inside the loop | Empty attribute list → `return result` on an **unbound variable** → `UnboundLocalError` | seed `result = True` |
| 3 | `ledboxApp.py` · `processMessage` | `str(type(response)) == "<type 'instance'>"` | Always **False** on py3 (no old-style classes) → API objects never converted to dict → `json.dumps` **fails to serialize the reply** | `hasattr(response,'__dict__')` guard |
| 4 | `ledboxApp.py` · `processMessage` | `str(message)` on a `bytes` object | Uncompressed messages become the literal text `"b'...'"` → **command not parsed** | decode bytes → str |
| 5 | `LEDMatrix2.py` · `printText` | `text.decode('utf8').encode('latin1')` | On py3 this mangles accented letters → **umlauts break** (e.g. "Zürich"/"Küssnacht" render as garbage) | drop the transcode (py3 `str` is already what Pillow wants) |
| 6 | `serverSound.py` | `print json_data` (statement form) | **SyntaxError — the module won't even import** | `print(json_data)` |
| 7 | `ledboxSound.py` · `play_music` | `print("File {}…").format(…)` | `.format` runs on `print()`'s `None` return → **AttributeError** when a sound file is missing | `print("…".format(…))` |

Tell-tale that 0.551 was mid-migration: the identical `str(type()) == "<type 'list'>"` check was
**fixed in `SetLayout`** (line 76, with the old line left commented right below it) but **missed in
`SetSection`** (#1 above).

## The rest of the stack

- **`firmware/src/*.py`** — the ported Python-3 application (this is what runs).
- **`firmware/plugin/*.py`** — the genuine 0.551 plugin **sources** (previously we only had the
  surviving `cpython-311.pyc`). Verified clean py3. The board can keep running the `.pyc` or
  recompile from these.
- **`bin/flushBuffer`** — unchanged vendor binary. It is the open-source
  [`rpi-rgb-led-matrix`](https://github.com/hzeller/rpi-rgb-led-matrix) library (the build path
  `/home/pi/flushBuffer/rpi-rgb-led-matrix-master/` is embedded in it) with a custom `applicon`
  GPIO mapping (= stock `regular` with the E-line on GPIO26). It needs OpenSSL-1.1 / GraphicsMagick
  era libraries, which are staged in `/home/pi/ledbox/lib` and reached via `LD_LIBRARY_PATH` — **no
  system packages are touched, fully reversible.** A from-source rebuild (zero vendor binary, stock
  bookworm libs) is possible and planned; it needs a human at the panel to verify.
- **Display profile** — this panel is a **Pi 4 + outdoor unit (vendor "Model D")**; the
  `[DISPLAY]` params are correct for it. See `setting.ini.example`. Do **not** switch it to the
  indoor profile — `multiplexing=0` would scramble this panel, and the scramble is invisible over
  the network.

## Deploying 0.552 to the board

    # from a machine that can reach the board (through the OpenVolley Pi):
    #   src/     -> /home/pi/ledbox/           (the .py application)
    #   plugin/  -> /home/pi/ledbox/plugin/    (optional; .pyc already run)
    #   manifest.xml -> /home/pi/ledbox/manifest.xml   (bumps reported version to 0.552)
    # then restart the app (the watchdog restarts it in ~8–16 s), or reboot.

Reported version comes from `manifest.xml`; until it is deployed the board still shows the stale
`0.550` (cosmetic — the running code is this port).

## Not included / follow-ups

- **Beach volleyball** — the firmware already ships beach layouts
  (`layout/system/14_/15_escoresheet_beach_matchscore*`). Driving them for beach scoring
  (sets to 21, deciding set to 15, 2 players/side) is a change to the **bridge**, not the firmware.
- **flushBuffer from source** — see above; staged for an at-the-panel session.
