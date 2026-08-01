# flushBuffer — what's inside it, and how to replace it

`bin/flushBuffer` is the only piece of the board we have no source for. It is what
actually drives the LED panel: the Python app renders a frame to `www/buffer.png`, and
this binary pushes those pixels out the GPIO pins.

It is **not** a black box any more. It ships with **debug info and is not stripped**, so
everything needed to rebuild an equivalent is recoverable.

> **✅ Rebuilt.** The open replacement now exists in [`flushbuffer/`](flushbuffer/) —
> `flushBuffer2`, built from the open-source hzeller lib + the `applicon` mapping, linking
> **only stock Debian-12 libraries** (no more `/home/pi/ledbox/lib` staging). Built and
> staged on the board; awaiting an eyes-on-panel test before activation. This document
> records how it was reverse-engineered; `flushbuffer/README.md` is the build + swap guide.

## What it is

Stock **hzeller `rpi-rgb-led-matrix`** — the build path is still embedded in the binary:

    /home/pi/flushBuffer/rpi-rgb-led-matrix-master/lib

plus GraphicsMagick for loading the PNG, and one vendor addition: a custom GPIO mapping
called **`applicon`**, selected by `bin/startled` via `--led-gpio-mapping=applicon`.
That custom mapping was the only thing standing between us and a rebuildable driver.

## The `applicon` GPIO mapping (extracted)

Read out of `matrix_hardware_mappings` (`0x3400c`, 896 bytes = 8 × 112-byte
`HardwareMapping` structs; 112 bytes confirms `gpio_bits_t` is `uint32_t`):

| Signal | GPIO | | Signal | GPIO |
|---|---|---|---|---|
| `output_enable` | 18 | | `p0_r1` | 11 |
| `clock` | 17 | | `p0_g1` | 27 |
| `strobe` | 4 | | `p0_b1` | 7 |
| `a` | 22 | | `p0_r2` | 8 |
| `b` | 23 | | `p0_g2` | 9 |
| `c` | 24 | | `p0_b2` | 10 |
| `d` | 25 | | | |
| `e` | **26** | | `p1_*`, `p2_*` | unused |

**It is the stock `regular` mapping with exactly two changes:** `e` moved from GPIO 15 to
GPIO 26, and only one parallel chain is wired (`regular` defines three). Everything else
is byte-identical to upstream.

To rebuild: take upstream `rpi-rgb-led-matrix`, add this entry to
`lib/hardware-mapping.c`, and drive it with the panel parameters already in
`setting.ini` (`--led-pwm-bits=7 --led-slowdown-gpio=5 --led-pwm-lsb-nanoseconds=450
--led-multiplexing=1 --led-brightness=40 --led-pwm-dither-bits=2`, 192×64).

## Why replacing it would be worth something

- **Drops the legacy library problem entirely.** The vendor binary needs OpenSSL 1.1,
  libtiff5 and libwebp6 — all gone from Debian 12, currently staged in
  `/home/pi/ledbox/lib`. A fresh build needs none of them.
- **Removes the PNG round-trip.** Today every frame is written to the SD card twice
  (`buffer.png` + `buffer_compressed.png`) at ~5 fps, then read back. Rendering straight
  into the matrix removes constant SD wear and a chunk of latency.
- **Unlocks smooth animation.** Blinks and countdowns are currently limited by that
  file-based frame path.

## Why it has NOT been replaced

It works, and it is the one component that talks directly to hardware. A wrong pin
mapping means a panel that shows garbage — during a season, on the club's only board.
The extraction above is the hard part and it is done; the remaining work is a build and
a careful side-by-side test.

**Recommended sequencing:** do this in the off-season, with the vendor binary kept in
place as an instant rollback (`bin/flushBuffer`, also inside
`ledbox-config-backup/WORKING-SNAPSHOT-*.tar.gz`). Nothing about the current setup
blocks it.

## Reproducing the extraction

    readelf -sW flushBuffer | grep matrix_hardware_mappings   # -> addr, size
    readelf --debug-dump=info flushBuffer | grep -A2 HardwareMapping   # -> byte_size

then walk the array: each entry is `{const char *name; int max_parallel_chains;
uint32_t output_enable, clock, strobe, a, b, c, d, e; uint32_t p0_r1 … p2_b2;}`,
resolving `name` through the section headers.
