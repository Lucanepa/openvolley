# openscore — architecture & design

A **clean-room, fully-open reimplementation** of the Tech4Sport LedBox board's firmware app.
It replaces the one closed layer left in the KSCW scoreboard stack (Tech4Sport's decompiled,
proprietary Python renderer) with our own renderer that speaks the **same** TCP `:8889`
protocol — so the existing open bridge keeps working **unchanged**.

```
control UI + bridge (open, Node)  ─8889/gzip-JSON─▶  openscore.py (open, Python 3)
                                                          │ writes www/buffer.png (atomic)
                                                          ▼
                                                     flushBuffer2 (open C++, hzeller
                                                     rpi-rgb-led-matrix + stb_image)
                                                          │ ~62 fps over GPIO
                                                          ▼
                                                     192×64 HUB75 panel
```

> **Clean-room provenance.** Every design decision below is derived **only** from open
> sources: `PROTOCOL.md`, `DESIGN-appliance.md`, the bridge's own wire code
> (`src/ledboxProtocol.js`, `src/ledboxClient.js`, `src/volleyballMapper.js`,
> `src/mockLedbox.js`), the public layout XML (`layouts/*.xml`) and the open panel driver
> (`firmware/flushbuffer/`). **No decompiled vendor Python was read, translated or copied.**
> Where the vendor's exact behaviour is unknown (e.g. the `bar` section, the `fontsize`
> ladder) the choice is documented as provisional and deferred to on-glass calibration.

---

## 1. The split: renderer vs panel driver

The vendor firmware was already two processes joined by a file:

1. a **renderer** that draws the current screen to `/home/pi/ledbox/www/buffer.png`, and
2. **flushBuffer**, which reloads that PNG every frame (~62 fps) and clocks it out over GPIO.

We have already replaced #2 with the open **`flushBuffer2`** (`../flushbuffer/`, panel-verified
2026-08-01). `openscore` replaces **#1 only**. The contract between them is deliberately dumb:
**openscore writes a 192×64 PNG atomically; flushBuffer2 displays whatever PNG is at the path.**
openscore never touches GPIO, which is why the whole renderer can be **fully validated with no
panel** — the headless PNG *is* the hardware path minus the final DMA.

Consequences:
- "Hand the framebuffer to flushBuffer2" = `os.replace(buffer.png.tmp, buffer.png)`.
- Rendering correctness is a pixel question we can answer off-hardware (see `render_samples.py`).
- The only things that *require* the physical panel are geometry/mux/brightness — and those live
  entirely in flushBuffer2 + `setting.ini`, not here.

## 2. Process & threading model

- **One TCP server** on `0.0.0.0:8889` (`Server`). Accepts one bridge client at a time.
- **A new client supersedes the old one**: the previous socket is dropped immediately. This is
  the deliberate fix for the documented vendor bug where `:8889` **wedges for ~80 s** (needs a
  power-cycle) when a client dies without `Disconnect` (PROTOCOL.md §"the board's control port
  wedges"). A dead/idle client is also reaped by a 90 s socket timeout.
- **`Device` is the single source of truth**: loaded layouts, the current layout, and each
  section's live state. The server just decodes frames and calls `device.handle(msg)`.
- **`Device._lock` is an `RLock`.** `handle()` holds it and some commands (`Clear`,
  `StopAllProcess`, `showInfo`) re-enter it via `show_idle()`/`show_info()`; a plain `Lock`
  would deadlock the client thread. (This was a latent bug in the first scaffold pass.)
- **Horn** runs on a throwaway daemon thread so its inter-beep sleeps never block the socket.

## 3. Wire protocol

Byte-for-byte the format in `src/ledboxProtocol.js`, re-derived independently:

- **Framing**: each message is a UTF-8 JSON string, **gzip-compressed**, one **self-delimiting
  gzip member per message** (magic `1f 8b` … 8-byte CRC/ISIZE footer). No length prefix.
  `StreamDecoder` accumulates stream bytes and yields each complete member; a partial member is
  held until the next chunk. On desync it resyncs to the next `0x1f`.
- **Compression level 1** on our replies (fastest; the board ignores compressed size).
- **Request/response shape**: `{cmd, value, …}` → `{status, sender, value}` where
  `sender == cmd` (the bridge matches replies by command name, so it serialises one command at a
  time — we never need to correlate by id).
- **Errors**: `{status:"error", sender, error_code, error_message}`. The field is
  **`error_message`**, not `message` (the bridge reads only the former). Codes:
  `1` API not available · `5` layout not present · `6` section not found · `8` app not
  compatible · `9` malformed (`key 'attrib' …`).
- **`noresend` is OFF.** The vendor advertises `noresend:true` and then stays *silent* when asked
  to set something it already has (e.g. `SetLayout` to the current layout), making the bridge
  wait out a full 5 s timeout. We **always reply**, so the bridge never stalls.

## 4. Message types — every command, and how we handle each

Vocabulary from PROTOCOL.md §"Command vocabulary (from the APK)". "Bridge?" = does the current
open bridge send it (from `ledboxClient.js`).

### Implemented (the working set the bridge drives)

| Command | Bridge? | Handling |
|---|---|---|
| **Init** | ✅ | Requires integer `value.version == 2` (else it *would* be error 8; we accept 2). Replies `{deviceName, version, role:"admin", current_layout, plugins:[], noresend:false}`. |
| **SetLayout** | ✅ | Switch to a loaded layout by `name`/`value`; render it. Unknown → **error 5**. Re-selecting the current layout still replies ok (no `noresend` stall). |
| **SetSections** | ✅ | Value is a **list** of `{name, value:{attrib,value}}`. **WRITE shape = exactly one `{attrib,value}` per entry.** A list-valued entry is the READ shape → **error 9** (`key 'attrib' in section <name> not defined`), matching the device. Unknown section → **error 6**. Applies each attrib, re-renders once. |
| **SetSection** | ✅ | Singular form; a single `{name, value:{attrib,value}}`. Same rules as SetSections. |
| **GetSections** | (avail) | READ shape: `[{name, value:[{attrib:"text",…},{attrib:"color",…}]}]`. **Skips `private` sections** (mirrors the device reporting only `text`+`color`). |
| **GetLayout** | (avail) | Returns the current layout name. |
| **ReloadLayout** | (avail) | **Requires the name** (bare → error 5). Re-reads layout XML from disk and resets that layout's sections to their file defaults — the documented way to undo a stray `fontsize`/attrib. |
| **Info** | ✅ (`info()`) | Returns `{deviceName, version}` (matches `mockLedbox`). **Does not change the screen** — a poll must not clobber a live scoreboard. |
| **showInfo** | behaviour | Paints the **network-info screen** (device name, local IPv4s, control port, firmware) — the screen the vendor board flashes at boot. Built procedurally as an ad-hoc text layout (no XML file needed). Also `ShowInfo`. |
| **Horn** | ✅ | `{times, sleep}` → beeps on a daemon thread (`aplay back.wav` if a `horn_cmd`/wav is configured; otherwise a no-op that still replies ok). Verified payload from `functions.js`. |
| **Clear** | (avail) | Blank → idle/waiting screen. |
| **StopAllProcess** | (avail) | Stop everything → idle/waiting screen (we run no playlists, so this is just "go idle"). |
| **ChangeWaiting** | (avail) | Echoes the object back with `exist:false` (the device's observed behaviour; the real feature needs the media-upload path we don't implement). |
| **Disconnect** | ✅ | Reply, then close the socket cleanly; fall back to the idle screen. |
| *unknown cmd* | — | **error 1** `API not avaible` (verbatim vendor spelling), exactly like the device — so command probing stays reliable. |

### Deliberately not implemented (bridge never calls them)

These exist in the APK vocabulary but the bridge (our only client) never sends them; the panel
scoreboard does not need them. They currently return **error 1** (clean failure, like an absent
command) and are listed here so the boundary is explicit:

- **Upload / Uploaded** — media/layout upload. On the real box this is a *separate* service on
  TCP `:12345`, not part of `:8889`. Custom layouts are installed by dropping XML into `layout/`
  (see §7), so the scoreboard path needs no upload command.
- **Reboot / RestartDHCP / DeleteInterfaces / DeleteMediaAlias** — appliance/network admin.
- **SetConfig(s) / GetConfig(s)** — these are **network** config (`ip_lan`, `network_gateway`,
  `DHCP`), not display settings (PROTOCOL.md). Out of scope for the renderer.
- **GetClients** — could trivially return our single connected peer if a client ever needs it.
- **{Set,Start,Pause,Stop,GetList,DeleteAll,Upload}PlaylistImage / PlaylistAudio / Practice**,
  **{Start,Pause,Stop}CustomText** — vendor plugin subsystems (image/audio playlists, training
  drills, scrolling custom text). Not used by the scoreboard.

Adding any of these is a localised change in `Device.handle()` — the dispatch is a flat table.

## 5. Section types — every type, and how we render each

Types seen across the open `layouts/*.xml` are `text`, `image`, `rectangle`, `circle`; the
protocol brief also names `bar`. All five are handled. Each section is a fixed box positioned on
the 192×64 canvas via `x, y, width, height`, aligned with `align`/`valign`.

| Type | Rendering |
|---|---|
| **text** | The element's text, drawn at `(x,y)` with a Pillow anchor from `align`×`valign` (`left/center/right` × `top/middle/bottom`). **Shrink-to-fit**: if `width>0`, the TTF size is reduced until the string fits the box (min 6 px) — long club names scale down instead of clipping, which the vendor's fixed-`fontsize` lever could not do. `color`, `fontsize`. |
| **image** | PNG/JPG (via Pillow) **scaled to fit** the box preserving aspect ratio, then positioned inside it by `align`/`valign`, alpha-composited. A **missing `src` is skipped silently** (an operator may not have uploaded a media placeholder; the blanked vendor `banner.jpg` is expected to be absent). |
| **rectangle** | Filled with `color`, outlined with `bordercolor`. A **black fill with a border** renders as a hollow coloured frame over the black background (how the score boxes and serve indicators are drawn). |
| **circle / ellipse** | Filled ellipse inside the box, `bordercolor` outline — the tennis layout's serve dots. |
| **bar** | *Provisional* (no shipped layout uses it yet): `bordercolor` draws the track outline, `color` fills a fraction of it. The fraction is read from the section text (`0..100` percent or `0..1`); horizontal when wider than tall, vertical otherwise. Forward-compatible; to be calibrated if a real `bar` layout ever appears. |

### Section attributes understood

From the layout XML and `SetSections` writes: `name`, `type`, `x`, `y`, `width`, `height`,
`align`, `valign`, `color` (`"R,G,B"` decimal, per PROTOCOL.md — not hex), `bordercolor`,
`fontsize`, `src`, `visible`, `private`, and the element text (the default value). `animation` /
`animation_params` are parsed but **rendered statically** — the bridge does its point/sub blink in
software by toggling `color` over `SetSections` (see §6), so a native animation engine is not
required for parity; it is a later enhancement.

**Colour format**: `"R,G,B"` decimal strings (`_to_rgb` also tolerates `;`-separated). Rendering
is RGB; the panel is RGB.

**`fontsize` caveat**: the vendor panel uses **bitmap** fonts with a discrete height ladder
(PROTOCOL.md notes `fontsizearray`), so vendor `fontsize` values are calibrated to *those* glyphs.
We render **scalable TTF** (DejaVuSans-Bold by default), so the numbers won't match 1:1 — this is
the main calibration task in the ROADMAP (Phase 2), not a protocol issue.

## 6. Behaviours the bridge relies on

All of these are already exercised by `render_samples.py` / `selftest.py`:

- **Idle / "waiting" screen.** With **no client connected**, the device shows its own
  `layout/system/waiting.xml` — the KSCW crest flanked by a "Join WiFi" QR and an "Open UI" QR.
  When a client connects but is idle, the **bridge** selects `kscw_crest` (crest only) or
  `kscw_idle` (crest + team names) via `SetLayout`; we just render whichever it asks for. On
  client disconnect we fall back to `waiting`.
- **showInfo network-info screen.** §4 — device name, IP(s), port, firmware; the boot info screen.
- **Countdown push.** For timeouts / set intervals / warm-up the bridge switches to a countdown
  layout (`kscw_break`, or the vendor `volleyball_matchscore_timeout_02`) and writes `timer` /
  `lbl` / scores. There is **no dedicated countdown command** — it is just `SetLayout` +
  `SetSections`. Our only obligation is to switch layouts and re-render promptly (the bridge
  inserts its own settle delay, `layoutSettleMs`, because a switch takes real time). The break
  layout carries two clock sections (`timer`, `timerbig`) so the bridge can size the clock to the
  gap between the score boxes.
- **Blink / pulse a section.** The bridge acknowledges a point/substitution by **software-blinking**
  a section: it rapidly `SetSections` the section's `color` between the team colour and off
  (`pulseIntervalMs≈160 ms`). We render each write; the ~62 fps PNG poll smooths it into a clean
  blink. No native `blinking` animation is needed (the vendor's ignored the runtime colour anyway).
- **Horn.** §4.

## 7. Layouts, media & config

- **Layouts** load from `layout/*.xml` **and** `layout/system/*.xml` (glob + `os.path.splitext`).
  Both the `name=` attribute and the bare filename resolve, first definition wins. A malformed or
  oddly-named file is **skipped with a warning** — never crashes the load. This pointedly avoids
  the vendor scanner's `filename, extension = f.split('.')`, which throws on any multi-dot
  filename and hangs the board at "starting…" (idle-crest-qr/README.md §CRITICAL).
- **Media** paths in `src` resolve relative to the firmware dir (`media/…`).
- **Config**: `setting.ini` → `[DISPLAY] width/height` (192×64) and `[TCP] port` (8889);
  `user_setting.ini` → `[GENERAL] device` (device name); `manifest.xml` → version (`…-open`).
  The `[DISPLAY]` driver-tuning keys (mux/pwm/brightness/mapping) are for **flushBuffer2**, not us.
- **Output**: `www/buffer.png`, written to `…tmp` then `os.replace`d (atomic; flushBuffer2 never
  sees a half-written frame). The `www/` dir is created if absent.

## 8. Improvements over the vendor firmware (all behaviour-preserving on the wire)

| Vendor behaviour | openscore |
|---|---|
| `:8889` **wedges ~80 s** when a client dies without `Disconnect` | dead socket dropped at once; new client always accepted; idle-timeout reaps silent clients |
| `noresend:true` → bridge **stalls 5 s** on a redundant `SetLayout` | always replies |
| layout scanner **crashes** on any multi-dot filename | globs `*.xml`, skips bad files with a warning |
| `fontsize` **clips** long names (fixed bitmap boxes) | shrink-to-fit TTF |
| latin-1 / py2 umlaut breakage | UTF-8 throughout; structured logging |
| accepting the READ shape silently | rejects it with **error 9**, exactly like real hardware (fidelity) |

## 9. Non-goals (this pass)

- No GPIO / panel driving (that is flushBuffer2's job, already done).
- No media/layout **upload** service (`:12345`), no network-admin commands, no vendor plugins.
- No native animation engine (software blink covers the bridge's needs).
- Pixel-exact parity with the vendor's bitmap fonts — deferred to on-glass calibration (ROADMAP).

## 10. File map

```
firmware/openscore/
├── openscore.py     the firmware: StreamDecoder · Layout/Section model + XML loader ·
│                     Renderer (→ www/buffer.png) · Device (command dispatch) · Server (:8889)
├── setting.ini       [DISPLAY] width/height (+ flushBuffer2 tuning) · [TCP] port
├── layout/           the rendered layouts (open XML)
│   ├── volleyball_matchscore_02.xml            the match screen
│   ├── volleyball_matchscore_timeout_02.xml    vendor countdown
│   ├── volleyball_matchscore_set_02.xml        image-only set screen
│   ├── kscw_idle.xml / kscw_crest.xml          club idle screens
│   ├── kscw_break.xml                          our full-panel break screen
│   ├── tennis_matchscore.xml                   exercises the `circle` type
│   ├── openvolley_timeout.xml
│   └── system/waiting.xml                      no-client idle (crest + QRs)
├── media/            kscw_crest.png · wifi_qr.png · ui_qr.png
├── www/              buffer.png output (flushBuffer2 polls this)
├── selftest.py       real-socket protocol proof (handshake + parse + error codes + render)
├── render_samples.py drives every screen → samples/*.png for eyeball validation (no panel)
├── DESIGN.md · ROADMAP.md · README.md · PANEL-AND-DIY.md
```
