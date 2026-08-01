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

## Integrate (only after the panel test passes)

Point the boot path at `flushBuffer2`. It needs **no** `LD_LIBRARY_PATH` and **no**
`--led-*`/`--screen-dimension` args (geometry + tuning are compiled in), though any
`--led-*` flag still overrides:

```bash
# in bin/startled, the flushBuffer line becomes simply:
sudo /home/pi/ledbox/bin/flushBuffer2 ../www/buffer.png
```

Then update the watchdog's process check from `flushBuffer` to `flushBuffer2`. Keep the
vendor binary in place as an instant fallback.

## Staged

Built and staged on the board at `/home/pi/ledbox/bin/flushBuffer2` (not yet activated —
the vendor driver is still live). sha256 recorded in the deploy notes.
