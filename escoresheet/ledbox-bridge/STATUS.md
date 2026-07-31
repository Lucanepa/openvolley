# LedBox appliance — status

Snapshot of what works, what's parked, and how to finish the parked items. Companion to
[`PROTOCOL.md`](./PROTOCOL.md) (the device protocol) and [`DESIGN-appliance.md`](./DESIGN-appliance.md).

Hardware: Tech4Sport **C0270**, firmware **0.551**, 192×64 panel. Driven by a Raspberry Pi 5
(`openvolley` on Tailscale) running the appliance under systemd.

---

## Working on the board today

Verified on the real panel:

- **Live scoreboard** — team names + colours, points, sets, timeouts, subs, serve indicator.
- **Point / substitution blink** — the scored point blinks in its team colour; a substitution
  blinks that side's counter. Native `animation=blinking`, toggleable in settings.
- **Countdowns on the device's own timeout layout**, with per-break content:
  - **Timeout** → label `TO <team>`, shows points + sets.
  - **Set interval** → label `INTERVAL`, shows sets only.
  - **Warm-up** → label `WARM UP`, shows the clock alone.
  - Timer is `M:SS` while there are minutes, bare seconds under a minute.
  - The Tech4Sport logo is blanked so the clock owns the screen.
- **Horn on time's-up** — buzzer sounds when a countdown reaches zero, silent on a manual skip.
  Toggleable.
- **Counter limit colours** — timeout counter goes dark red at 2; substitution counter amber at
  5, dark red at 6 (FIVB per-set maximums).
- **VS pre-match screen** — team names + "VS", scores blanked. (Basic; the good version is the
  logo screen below.)
- **Settings page** (persisted on the Pi, survives restart): blink on/off + length, countdown
  on/off + lengths, horn on/off, best-of 3/5, club name.

## Working in the appliance / infra

- **Control UI** — landscape-first phone page; game / link / settings tabs; full-screen.
- **Board auto-discovery** — finds the board on its Wi-Fi (`172.24.1.1`) or the cable
  (`192.168.5.1`), whichever answers; fails over in ~8s.
- **systemd** — `ledbox-bridge.service` enabled; survives reboot; no MOCK in the unit.
- **Venue networking** — board's own Wi-Fi `ledbox_C0270` carries phone+Pi+board with no cable
  (verified). Fallback Pi hotspot profile `openvolley-ap` exists (autoconnect off).

---

## Parked — all blocked on ONE thing: writing files to the board

The board's web server can READ its layout/media files but cannot WRITE them (the layout
directory is read-only to Apache; the `file_cover` upload reports success but changes nothing
that renders). So every remaining item needs a **shell on the board** to drop a file in:

| Parked item | What it needs |
|---|---|
| Full-panel **Wiedikon logo idle screen** (crest + "KSC WIEDIKON") | upload a 192×64 image, show it via the full-screen image layout when idle |
| **Logo / big text** in the countdown's empty left half | a custom timeout layout (move `timer` left+big, add a wide text/image box) |
| **Wide name boxes** for long team names (WIEDIKON overflows at fontsize 18) | a custom match layout with a wider `team1`/`team2` box |
| **Split** score-left / clock-right countdown | same custom layout (section `x`/`y` are NOT settable live — fixed in the layout XML) |

**Built and ready to install:** the idle image is generated (crest + KSC/WIEDIKON, 192×64) and
the source logos are in the repo. All six stock layout XMLs are backed up in `layouts/` — the
ground truth for geometry and the restore path.

### The unblock recipe (once we have board SSH)

The board is a Raspberry Pi with **port 22 open**; we don't have its password (asked Tech4Sport
2026-07-31). When it arrives:

```bash
ssh openvolley                 # onto the Pi
ssh root@192.168.5.1           # onto the board (password from Tech4Sport)
id; mount | grep ' ro,'        # confirm root + which partition is read-only
sudo mount -o remount,rw /path # make the layout/media dir writable
# then: scp the image into the media dir, and/or drop a custom layout XML next to the stock ones
```

Custom layouts are plain XML (see `layouts/*.xml`); sections carry `x y fontsize color
bordercolor align animation src`. `animation`/`color`/`fontsize`/`bordercolor`/`src` are also
settable **live** over `SetSections`; `x`/`y` are only honoured from the layout file.

---

## Not doable on this hardware

- **Panel brightness** — no brightness/luminosity command exists in the protocol; it is not in
  the config surface (only NETWORK/WIFI/GENERAL/LAYOUT). Would be a device-side/web concern only.

## Open decision

- **Pi-as-AP topology** — the board can run as a Wi-Fi *client*, so the Pi could be the access
  point (`openvolley-ap`) that board + phones both join. Cleaner (stable addresses, no cable),
  but the Pi's single radio then can't also be on home Wi-Fi → no Tailscale at home unless the
  Pi uplinks via ethernet. Worth doing deliberately at the machine, not remotely.

---

## Key addresses

| | |
|---|---|
| Control UI | `http://172.24.1.60:8890` (on board Wi-Fi) · `http://openvolley:8890` (Tailscale) |
| Board web admin | `http://192.168.5.1` (from Pi) — `admin` / `admin` |
| Board Wi-Fi | `ledbox_C0270` / `47561052` |
| Board on cable | `192.168.5.1` · Pi on cable `192.168.5.50` |
| Service | `ledbox-bridge` on the Pi |
