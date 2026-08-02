# Panel characteristics + DIY build

Everything below is pulled off the actual C0270 (`setting.ini`, `flushbuffer.cc`, board probing)
so you can rebuild an equivalent panel from open parts.

## Panel & driver characteristics (measured)

| Property | Value | Source |
|---|---|---|
| Resolution | **192 × 64** RGB pixels | `[DISPLAY] width/height`, compiled in |
| Panel type | Outdoor **HUB75** LED matrix | hardware |
| Module layout | **3 × 64×64** panels, single chain, `parallel = 1` | `flushbuffer.cc` `rows=64 cols=64 chain=3` |
| **Scan mode** | **1** (progressive) — *compiled in, no CLI flag* | `flushbuffer.cc:46` |
| Multiplexing | 1 | `setting.ini` |
| GPIO mapping | **`applicon`** = stock `regular` with the **E address line on GPIO26** (not GPIO15) | recovered from the vendor binary |
| PWM | `pwm_bits=7`, `pwm_lsb_nanoseconds=450`, `pwm_dither_bits=2` | `setting.ini [DISPLAY]` |
| GPIO slowdown | 5 | `setting.ini` |
| Hardware pulsing | on (`no_hardware_pulsing=0`) | `setting.ini` |
| Brightness | 40 (%) | `setting.ini` |
| Host | Raspberry Pi (armhf); board HW ver **0.42**; firmware app **0.552** | `config`, `manifest.xml` |
| Refresh | ~62 fps (flushBuffer2 reloads the PNG each frame) | `flushbuffer/README.md` |

**Not readable in software** (read them off the module labels): **pixel pitch** (P-value, e.g. P4/P5/P6),
physical dimensions, and rated power/current. These decide the PSU size and the physical case.

## DIY shopping list

### Electronics
- **Raspberry Pi 4** (a Pi 3B+ works; Pi 4 has headroom). The board itself is a Pi 4.
- **HUB75 driver HAT** — Adafruit **RGB Matrix Bonnet** (or an "Electrodragon"/generic RGB-matrix HAT).
  Provides the level-shifting + a clean GPIO pinout for `rpi-rgb-led-matrix`.
- **3 × 64×64 outdoor HUB75 LED panels**, same pixel pitch, that chain (each has HUB75 in/out + a
  power pigtail). Match the pitch to your viewing distance (larger pitch = brighter/cheaper, coarser).
- **5 V DC power supply** sized to the panels: a 64×64 outdoor panel can pull **~4 A peak each**, so
  budget **5 V / ~20 A** (≈100 W) for three, plus a bit for the Pi. Outdoor panels are hungrier than
  indoor. Use the panels' rated max, not a guess.
- **Power injection wiring** — the panels' 5 V pigtails wired to the PSU (don't power panels through
  the Pi/HAT). A small 5 V buck or a second rail for the Pi is cleanest.
- Short **HUB75 ribbon cables** (usually included) to chain panel→panel and HAT→panel 1.

### Case / enclosure
- **Outdoor (beach/hall):** an **IP54+ aluminium/steel LED-cabinet frame** sized to 3×(64×64) — many
  sign shops sell empty "P-series outdoor cabinets"; or a custom laser-cut aluminium frame + a
  polycarbonate/acrylic anti-glare front + a rubber gasket. Add a rear vented box for the Pi + PSU.
- **Indoor/portable:** a laser-cut plywood or 3D-printed frame + a tinted acrylic front (raises
  contrast). Magnetic panel mounts (the panels ship with magnet studs + screw holes) make servicing
  easy. Leave airflow for the PSU.
- Fit a **panel front diffuser/louver** (outdoor panels usually include a louver mask) — it's what
  makes scores readable in sunlight.
- Strain-relief the mains + a proper **IEC inlet with a fuse/switch**; keep the 5 V PSU inside the case.

## Software (all reusable)

1. `git clone https://github.com/hzeller/rpi-rgb-led-matrix` and run its samples with:
   ```
   --led-rows=64 --led-cols=64 --led-chain=3 --led-parallel=1 \
   --led-multiplexing=1 --led-pwm-bits=7 --led-slowdown-gpio=5 --led-brightness=40
   ```
   plus **scan_mode=1** (set in code / options). Use the gpio-mapping that matches **your** HAT —
   `regular` or `adafruit-hat`. The board's `applicon` (E-line on GPIO26) is specific to Tech4Sport's
   wiring; don't copy it onto a standard bonnet.
2. Reuse the KSCW stack unchanged: **bridge + control UI + `openscore.py` + `flushBuffer2`**
   (rebuild `flushBuffer2` for your gpio-mapping via `../flushbuffer/build.sh`, or drive the matrix
   directly from `openscore` via the library's Python bindings).
3. Confirm the chain order/orientation on the glass and adjust `--led-pixel-mapper` if a panel is
   rotated or the chain snakes.

The only panel-specific unknowns are **pixel pitch, physical size, and power** — everything
electronic and all the software is already in hand.
