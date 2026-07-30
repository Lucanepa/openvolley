# Tech4Sport LedBox — protocol reference

What the device actually does, as opposed to what the docs claim. Two sources:

1. **Hardware** — a C0270, firmware `0.551`, cabled at `192.168.5.1` (2026-07-30).
2. **The vendor APK** (`ledbox_1_49`, Xamarin/.NET). Its command vocabulary is a
   UTF-16 literal table in the `#US` heap of `ledbox.dll`, inside an LZ4-compressed
   `assemblies.blob` — an ASCII `strings` pass over the APK finds none of it.

> **Trust rule.** The device returns `ok` for *any* attribute name, including
> nonsense. An `ok` is therefore **not** evidence that an attribute exists. Unknown
> *commands* do fail cleanly (`error 1 - API not avaible`), so command probing is
> reliable; attribute probing is only ever settled on the glass.

## Handshake

`Init` requires an **integer** version of `2`. `1.30` (from the docs) is rejected
with `error 8 - App not compatible`.

```jsonc
{ "cmd": "Init", "alias": "openvolley", "sport": "volleyball",
  "value": { "version": 2, "typeDevice": "app" } }
```

The reply carries `deviceName`, `version` (firmware, a string), `role`,
`current_layout`, installed `plugins`, and **`noresend: true`** — see below.

## Sections

The layout this device ships is **`volleyball_matchscore_02`**. Plain
`volleyball_matchscore` does not exist (`error 5 - layout not present in device`).

The **write** and **read** shapes differ, which is the single easiest thing to get
wrong:

```jsonc
// WRITE — SetSections: ONE attribute per entry.
{ "cmd": "SetSections", "value": [
  { "name": "team1", "value": { "attrib": "text",  "value": "WIEDIKON" } },
  { "name": "team1", "value": { "attrib": "color", "value": "37,99,235" } }
]}

// READ — GetSections: attribs nested in an array.
[ { "name": "team1", "value": [ { "attrib": "text",  "value": "WIEDIKON" },
                                { "attrib": "color", "value": "37,99,235" } ] } ]
```

Sending the read shape to `SetSections` fails with
`error 9 - key 'attrib' in section <name> not defined`. To set both text and colour,
name the section twice.

Colours are `"R,G,B"` decimal strings, not hex.

### Section names (`volleyball_matchscore_02`)

`team1` `team2` · `score1` `score2` · `set1` `set2` · `timeout1` `timeout2` ·
`sub1` `sub2` · `serve1` `serve2` · `bg_score1` `bg_score2` · `vs` `lbl_to`
`lbl_sub` `mode` `banner` `timer`

### Attributes

| Attribute | Status |
|---|---|
| `text` | Verified. Reported by `GetSections`. |
| `color` | Verified. Reported by `GetSections`. |
| `fontsize` | **Verified on the glass**, never reported by `GetSections`. See below. |
| `bordercolor` | Unverified — accepted, but everything is. |
| everything else | `GetSections` reports **only** text and color, on every layout — those two are all we can read back and verify. |
| `animation`, `animation_velocity`, `blinking` | In the APK's vocabulary; applicability to *scoreboard* sections untested. Values include `none`, `static`, `scroller_left_right`, `scroller_right_left`, `scroller_top_bottom`, `scroller_bottom_top`, `scroller_x_lr`, `scroller_x_rl`, `scroller_y_bt`, `scroller_y_tb`. |

**`fontsize` is real but uncalibrated.** Proven by a differential: `team1` at `6`
and `team2` at `28` in a single write, on a section never touched by earlier
probing — `6` clipped to a single visible pixel row, `28` overflowed across the
whole panel. Neither is usable. The APK also references `fontsizearray`, which
suggests the panel offers a **discrete set of bitmap font heights** rather than a
continuous scale; arbitrary values likely land between them and clip. The valid
ladder is not yet known — it needs a sweep on hardware.

## Layouts — the full inventory

Enumerated on the device (`test/probe-board.mjs`). These four exist; **everything else we
tried is absent** (`error 5`), including `volleyball_matchscore_01`, `volleyball_timeout_02`,
`warmup`, and plain `timeout`/`set`.

| Layout | Sections | Use |
|---|---|---|
| `volleyball_matchscore_02` | `team1 team2 score1 score2 set1 set2 timeout1 timeout2 sub1 sub2 serve1 serve2 vs mode` | the match screen |
| `volleyball_matchscore_timeout_02` | `lbl` ("TIMEOUT") · `timer` ("30") · `score1 score2 set1 set2 sep bg_score1 bg_score2 media` | **any countdown** |
| `volleyball_matchscore_set_02` | `media` only | an image screen; needs an upload to be useful |
| `waiting` | — | the idle screen shown when no client is connected |

Two things this settles:

- **Countdowns have a purpose-built screen.** A timeout, a set interval and a warm-up clock
  are all `volleyball_matchscore_timeout_02` with a different `lbl` and `timer`. There is no
  `timer` section on the match layout — writing one there is an `error 6`.
- **The match layout has a `vs` section** (default `"-"`), so a names-and-VS pre-match screen
  needs no new protocol: paint `team1`, `team2`, `vs` and blank the rest.

`waiting` could not be switched to while a client was connected — `GetLayout` kept reporting
`volleyball_matchscore_02`. It appears to be the device's own no-client screen rather than a
layout an app can select.

`ReloadLayout` **requires the layout name** (bare `''` gives `error 5`) and resets that
layout's sections to their defaults — which is how to undo a stray `fontsize`.

## Why `fontsize` misaligns

Layouts are **HTML pages** (see the vendor's `assets/Content/functions.js`: elements carry
`name=` and `layoutattrib=` and are updated with jQuery). Each section is therefore a fixed,
CSS-positioned box. `fontsize` changes the glyph size *inside* that box; it does not resize
the box, re-centre it, or move its baseline. Small text ends up clipped against the box's
anchor, large text overflows it — exactly what the hardware showed at 6 and 28.

So `fontsize` is the wrong lever for a name that does not fit. The real options are a custom
uploaded layout with a properly sized box, or the `scroller_*` marquee family.

## Horn — CONFIRMED working

```jsonc
{ "cmd": "Horn", "value": { "times": 2, "sleep": 0.2 } }
```

Payload from the vendor's own `functions.js`; **verified audible on the hardware**
(2026-07-30). `times` = how many beeps, `sleep` = gap in seconds. Defaults in the vendor code
are `times: 1, sleep: 0.5`. An obvious end-of-set / match-point signal.

## ChangeWaiting

Takes an **object** and echoes it back with an `exist` flag:

```
{}                                  -> { exist: false }
{ text: "KSC WIEDIKON" }            -> { text: "KSC WIEDIKON", exist: false }
{ name: "waiting", value: "KSC …" } -> { name: "waiting", value: "KSC …", exist: false }
```

A bare string times out. `exist: false` on every attempt suggests it references a **stored
media/interface that must already be uploaded**, rather than accepting literal text — so it
likely needs the `Upload` path before it does anything visible. Unresolved.

## Operational: the board's control port wedges

If a client dies without disconnecting (e.g. the Pi reboots), the board **keeps port 8889
closed to new connections** — observed closed for 80s straight while port 80 still answered
HTTP 200, i.e. the device was healthy and only the scoreboard service was stuck. It does not
self-heal; the board has to be power-cycled. After power-on, **8889 comes back at ~45s**.

Practical consequence: "restart the Pi" is not a safe recovery step on its own — restarting
the Pi while the board holds a stale session takes the board down with it.

## Errors

```jsonc
{ "status": "error", "sender": "SetSections",
  "error_code": 9, "error_message": "key 'attrib' in section team1 not defined" }
```

The field is **`error_message`**, not `message`. Codes seen: `1` API not available ·
`5` layout not present · `6` section not found · `8` app not compatible · `9` malformed.

## `noresend`

`Init` advertises `noresend: true`, and the device stays **silent** when asked to set
something it already has — notably `SetLayout` to the current layout. A
request/response client waits out its full timeout. Use `ReloadLayout` to reset a
layout to its defaults instead of bouncing `SetLayout` through another name.

## Command vocabulary (from the APK)

```
Init  Disconnect  SetSection  SetSections  GetSections  GetLayout  SetLayout
ReloadLayout  ChangeWaiting  Clear  Upload  Uploaded  Horn  Reboot  RestartDHCP
StopAllProcess  DeleteInterfaces  DeleteMediaAlias
SetConfig  SetConfigs  GetConfig  GetConfigs  GetClients
{Set,Start,Pause,Stop,GetList,DeleteAll,Upload}PlaylistImage
{Set,Start,Pause,Stop,GetList,DeleteAll,Upload}PlaylistAudio
{Set,Start,Pause,Stop,GetList,DeleteAll,Upload}Practice
{Start,Pause,Stop}CustomText
```

**`Horn`** is confirmed working (see above). **`ReloadLayout`** needs the layout name.
Still unused and possibly useful: **`Clear`**, **`GetClients`**.

`GetConfig`/`GetConfigs` take `value: { section, field }`, but the surrounding APK
strings (`ip_lan`, `ip_wifi`, `network_gateway`, `DHCP`) show they are **network**
config, not display settings.

## Panel brightness — not in this protocol

No brightness/luminosity/dimmer/contrast command exists in the app's vocabulary, and
none of the probed names work on the device. The box runs **Apache/PHP with an
AdminLTE panel on port 80** (`http://192.168.5.1`, username/password); port `12345`
takes layout uploads. Panel brightness is a venue setup knob and almost certainly
lives in that web UI. The vendor app itself embeds this admin UI in a WebView and
drives it with JavaScript (`openLayout(default_layout); refreshValue();`) rather than
extending the TCP protocol.

## Open questions

- The valid `fontsize` ladder (needs a hardware sweep; see `fontsizearray`).
- Whether `animation: scroller_left_right` works on `team1`/`team2` — if it does, long
  club names could marquee instead of being shrunk or truncated.
- Whether the `timer` section exists in this layout (`pushCountdown` targets it,
  still unconfirmed).
- Brightness via the port-80 admin UI, and whether its PHP endpoint is scriptable.
