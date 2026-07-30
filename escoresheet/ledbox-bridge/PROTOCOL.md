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
| `animation`, `animation_velocity`, `blinking` | In the APK's vocabulary; applicability to *scoreboard* sections untested. Values include `none`, `static`, `scroller_left_right`, `scroller_right_left`, `scroller_top_bottom`, `scroller_bottom_top`, `scroller_x_lr`, `scroller_x_rl`, `scroller_y_bt`, `scroller_y_tb`. |

**`fontsize` is real but uncalibrated.** Proven by a differential: `team1` at `6`
and `team2` at `28` in a single write, on a section never touched by earlier
probing — `6` clipped to a single visible pixel row, `28` overflowed across the
whole panel. Neither is usable. The APK also references `fontsizearray`, which
suggests the panel offers a **discrete set of bitmap font heights** rather than a
continuous scale; arbitrary values likely land between them and clip. The valid
ladder is not yet known — it needs a sweep on hardware.

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

Unused by us and possibly useful: **`Horn`** (end-of-set signal), **`Clear`**,
**`ReloadLayout`**, **`GetClients`**.

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
