# LedBox C0270 — firmware recovery (2026-07-31)

The board was bricked by pressing "update" in the Tech4Sport phone app. This directory
holds the Python-3 firmware port that recovered it, and the notes to redo it if needed.

## What actually happened

The vendor app's update pulls `ledbox_0550.zip` from `ledbox.tech4sport.com`. That build
is from **2023-05-20 and is Python 2**. The board runs **Python 3.11** (Raspbian 12
bookworm), so the update was a *downgrade* that overwrote the working 0.551 files:

- every top-level `*.pyc` → Python 2.7 bytecode (magic `03 f3 0d 0a`)
  → `RuntimeError: Bad magic number in .pyc file`, app never starts
- `bin/flushBuffer` (the LED panel driver) → a 2023 binary linked against
  **OpenSSL 1.1 / libtiff5 / libwebp6**, none of which exist on bookworm
  → `error while loading shared libraries: libcrypto.so.1.1`, panel stays dark
- `layout/system/*.xml` → the vendor's `escoresheet_*` layouts, replacing the
  `volleyball_matchscore_02` family the bridge drives

Re-running the update cannot fix it: the vendor server only serves 0.550.

**Update:** Emilio later supplied the genuine **0.551** source. Our port was reconciled against
it function-by-function and found **equal-or-better**: 0.551 is a *half-finished* py2→py3 migration
that still crashes on the board's Python 3.11 in several places (score push, umlauts, a py2 `print`
that won't import). It must **not** be deployed as-is. See `CHANGELOG-0.552.md` for the full diff and
the 0.552 build that fixes everything.

## The fix

**1. Firmware → `firmware/src/*.py` (19 files, ~2.9k lines)**

Recovered by decompiling the 0.550 `.pyc` with `uncompyle6`, then porting to Python 3.
Beyond the automatic `2to3` pass, these needed hand fixing — they are the ones to
re-check if anything misbehaves:

| Fix | Where |
|---|---|
| `gzip` needs `BytesIO`, not `StringIO` | `socketStruct`, `ledboxApp`, `testProcedure` |
| socket `recv()` returns bytes → decode before `.split()` | `ledboxApp.processMessage` |
| socket `send()` needs bytes → encode str | `socketStruct`, `serverSound` |
| serial EOL / PNG reads must be bytes / `'rb'` | `SerialThreading` |
| upload buffer must start as `b''` | `ledboxFileUploadServer` |
| `pexpect` needs `encoding='utf-8'` | `BtAutoPair` |
| `subprocess` output needs `.decode()` | `ledboxApp.getIpCard` |
| `Image.ANTIALIAS` removed in Pillow 10 → `LANCZOS` | `LEDMatrix2` |
| `string.replace(s, …)` → `s.replace(…)` | `LedboxPlugin` |
| **`str(type(x)) == "<type 'list'>"`** → `isinstance(x, list)` | `ledboxAPI` ×2, `ledboxApp` ×1 |
| decompiler dropped an `else`, so the list branch fell through | `ledboxAPI.SetSection` |

The last two are the subtle ones: in Python 3 that type string is `"<class 'list'>"`, so
every check silently took the wrong branch — `SetLayout` was handed a section list
instead of a layout name.

**Plugins were not ported.** `plugin/__pycache__/*.cpython-311.pyc` survived the
downgrade — that is the genuine 0.551 Python-3 plugin bytecode. It was copied over the
Python-2 `plugin/*.pyc`. (Python-2 originals: `ledbox-config-backup/plugin-py2/`.)

**2. Panel driver → `firmware/libs/`**

`flushBuffer` is a **vendor binary with no source**. It works; it just needs old
libraries. They are installed to `/home/pi/ledbox/lib` and reached via
`LD_LIBRARY_PATH` — **no system packages were touched**, so this is fully reversible.

| Library | From |
|---|---|
| `libcrypto.so.1.1`, `libssl.so.1.1` | Debian 11 `libssl1.1_1.1.1w-0+deb11u8_armhf` |
| `libtiff.so.5` | Debian 11 `libtiff5_4.2.0-1+deb11u5_armhf` |
| `libwebp.so.6`, `libwebpmux.so.2` | Debian 9 `libwebp6` / `libwebpmux2_0.5.2-1_armhf` |

Note the board is **armhf** userland on an arm64 kernel — use armhf packages.

**3. Layouts** — restored from `../layouts/` (`02/03/04_volleyball_*`, `20_openvolley_timeout`).
`volleyball-matchscore-02-specular.xml` was deliberately skipped: it declares the *same*
layout name as `02_…`, which would make the loader pick whichever it scanned first.

**4. Boot** — `bin/startledbox` now runs `python3 -u ledbox.py` with `LD_LIBRARY_PATH`
set. Verified across a cold reboot: app + panel driver both come up unattended.

**5. `bin/onlineupdate` is disabled** — it would re-download 0.550 and brick the board
again. Original at `/home/pi/ledbox-config-backup/onlineupdate.orig`.

## Backups on the board (`/home/pi/ledbox-config-backup/`)

`layout.tar.gz` · `broken-pyc-0550.tar.gz` (0.550 `.pyc` + `bin/`) ·
`plugin-py2/` · `startled.orig` · `startledbox.orig` · `onlineupdate.orig`

## Redeploying

    tar czf port.tar.gz -C firmware/src .
    scp port.tar.gz openvolley:/tmp/            # → board via the Pi (192.168.5.1)
    # on the board: tar xzf /tmp/port.tar.gz -C /home/pi/ledbox
    #               rm -rf __pycache__ && sudo systemctl reboot

SSH to the board goes **through the Pi** (`openvolley`), which is on its subnet:
`ssh openvolley` → `sshpass -p '<board-pw>' ssh pi@192.168.5.1`.

Debug: run `sudo python3 -u ledbox.py` from `/home/pi/ledbox` — **`-u` matters**, output
is block-buffered otherwise and a traceback can look like a silent hang.

## Caveats

- The board still reports **"Versione 0.550"** (cosmetic — the version string lives in
  the config, the running code is the port).
- `flushBuffer` remains an opaque vendor binary. Everything *above* it is now ours.
- This is no longer a vendor-supported build.
- The vendor zip is not committed (18 MB). Source:
  `http://ledbox.tech4sport.com//store/firmware/ledbox_0550.zip`

## Protocol notes confirmed from source (`ledboxAPI.py`)

- `Init` → `alias` and `sport` are **top-level**; `version` is inside `value`.
- `SetSections` → `value` is a **list** of `{name, value:{attrib,value}}`.
  Passing a single dict makes the loop iterate the dict's *keys* and fail with
  `key name not defined`.

## Editing a layout on the board

Copy the XML into `/home/pi/ledbox/layout/` and **restart the app** — the change will not
show otherwise. `ReloadLayout` looks like the right command and returns `ok`, but with
`force_reload=True` `layoutManager.loadLayout` builds a fresh object *without* replacing
the cached one, so the next `SetLayout` still serves the old geometry. Killing the app is
enough; the watchdog restarts it in ~8-16s.

Text is positioned by PIL's top-left anchor, and the useful numbers are what the renderer
actually produces, not the font metrics: at fontsize 24 capital ink runs `y+9 .. y+25`,
and an umlaut's dots start ~4px above the capitals. `firmware/render-mock.py` renders a
candidate at true 192x64 with the board's own ARIAL.TTF, which is far quicker than
restarting the app to look at each attempt.

## OPEN: re-enable the watchdog

`ledbox-watchdog` was disabled on 2026-07-31 just before a clean shutdown and the board
powered off before it could be re-enabled, so it will not start on the next boot. The board
boots and runs without it — what is missing is crash recovery. Next time it is on:

    sudo systemctl enable --now ledbox-watchdog
    systemctl is-enabled ledbox-watchdog   # expect: enabled

There is no need to disable it before a shutdown: systemd stops it as part of the shutdown
anyway, and `disable` persists across reboots.
