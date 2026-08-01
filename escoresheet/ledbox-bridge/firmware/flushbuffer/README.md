# flushBuffer2 — open rebuild of the vendor panel driver

`flushBuffer` is the only closed piece left in the stack: an unstripped ARM binary
that pushes `buffer.png` out to the LED panel. This directory rebuilds an equivalent
from open source, so there is **no vendor binary and no legacy-library staging**.

## Why

The vendor `flushBuffer` links `libGraphicsMagick++-Q16.so.12`, which drags in
OpenSSL 1.1 / libtiff5 / libwebp6 — all removed from Debian 12. They are currently
staged in `/home/pi/ledbox/lib` and injected via `LD_LIBRARY_PATH`. `flushBuffer2`
links **only stock bookworm libraries** (`libstdc++`, `libm`, `libc`, `libgcc_s`) —
verified with `ldd`. It also drops the vendor licence check and the GraphicsMagick
round-trip (PNG is decoded with the single-header, public-domain `stb_image`).

## What it is

Henner Zeller's open-source [`rpi-rgb-led-matrix`](https://github.com/hzeller/rpi-rgb-led-matrix)
(the vendor's own build path `/home/pi/flushBuffer/rpi-rgb-led-matrix-master/` is
embedded in their binary) plus:

- the custom **`applicon`** GPIO mapping — stock `regular` with the **E-line on GPIO26**
  instead of GPIO15 (recovered from the vendor binary's debug info); and
- a ~60-line `main` (`flushbuffer.cc`) that reloads the PNG each frame at ~62 fps.

### Effective config (recovered from the unstripped vendor binary via gdb/objdump)

The vendor `main` **compiles in** the geometry and scan mode (they are *not* on its
command line), then lets `--led-*` flags override the rest. `flushbuffer.cc` does the
identical thing:

| setting | value | source |
|---|---|---|
| rows / cols | 64 / 64 | compiled in (`Options` stores) |
| chain_length / parallel | 3 / 1 | compiled in → 64×192 = **192×64** |
| **scan_mode** | **1** | compiled in (easy to miss — no CLI flag) |
| gpio mapping | `applicon` | CLI (`--led-gpio-mapping`) |
| pwm-bits / lsb / dither | 7 / 450 / 2 | CLI |
| multiplexing | 1 | CLI |
| brightness | 40 | CLI |
| gpio slowdown | 5 | CLI (RuntimeOptions) |

## Build

```bash
./build.sh          # fetches hzeller + stb_image, patches applicon, builds
                    # produces rpi-rgb-led-matrix-master/flushBuffer2
```

Native armhf build (board has `g++`/`make`). No cross-compiler, no cmake, no
GraphicsMagick-dev. The last line prints `ldd` — confirm only stock libs.

## ⚠️ Testing — REQUIRES eyes on the physical panel

`flushBuffer2` drives the panel over GPIO. If the geometry/mapping is wrong the panel
shows **garbage**, and that is **invisible over the network** — `buffer.png` (the source
image) still looks perfect. So this can only be verified by someone **looking at the panel**.
Do not skip this. Only one process may own the GPIO at a time.

At the panel:

```bash
# 1. stop the vendor driver (blanks the panel)
sudo killall flushBuffer

# 2. run the rebuild by hand (Ctrl-C to stop)
cd /home/pi/ledbox/bin
sudo ./flushBuffer2 ../www/buffer.png

# 3. LOOK at the panel:
#    - correct  -> proceed to "Integrate" below
#    - garbled  -> Ctrl-C, then roll back (below) and note what you saw
```

### Roll back (panel is wrong, or to return to the vendor driver)

```bash
sudo killall flushBuffer2 2>/dev/null
cd /home/pi/ledbox/bin && sudo ./startled      # restarts the vendor flushBuffer
```

Nothing here modifies the vendor `flushBuffer`, `startled`, or the watchdog, so rollback
is just "run the old driver again."

## Status: ✅ ACTIVE (integrated + panel-verified 2026-08-01)

`flushBuffer2` is the **live** driver on the board — verified on the physical panel
(rendered the same image as the vendor driver, no garble). The vendor `flushBuffer` is
kept in place as an instant fallback but is no longer run, and the `/home/pi/ledbox/lib`
legacy staging is no longer needed by the active path.

The boot scripts as deployed are captured next to this file:

- [`startled`](startled) — launches `flushBuffer2` (no `LD_LIBRARY_PATH`; `--led-*` tuning
  still read from `setting.ini` so brightness/pwm/mux stay editable; geometry + scan_mode
  are compiled in, so no `--led-rows/cols/chain/scan-mode`/`--screen-dimension`)
- [`stopled`](stopled) — `killall -q flushBuffer2 flushBuffer`
- the watchdog ([`../ledbox-watchdog.sh`](../ledbox-watchdog.sh)) now monitors `flushBuffer2`

On the board these live at `/home/pi/ledbox/bin/{startled,stopled,watchdog}`; the pre-swap
versions are backed up at `/home/pi/ledbox-config-backup/*.pre-fb2`.
Binary: `/home/pi/ledbox/bin/flushBuffer2`, sha256
`c015440506aed1abac9634029a6302e22bde5ce2b5083234009e8b278bec2c59`.

### Roll back to the vendor driver

```bash
cd /home/pi/ledbox/bin
sudo cp /home/pi/ledbox-config-backup/startled.pre-fb2 startled
sudo cp /home/pi/ledbox-config-backup/stopled.pre-fb2  stopled
sudo cp /home/pi/ledbox-config-backup/watchdog.pre-fb2 watchdog
sudo systemctl restart ledbox-watchdog
sudo ./stopled && sudo ./restartled            # back on the vendor flushBuffer + LD_LIBRARY_PATH
```
