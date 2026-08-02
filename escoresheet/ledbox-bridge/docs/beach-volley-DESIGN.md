# Beach volleyball on the KSC Wiedikon LED scoreboard — design & scaffold

**Status:** design + headless scaffold. Nothing here is wired into the running appliance yet, and
no live file is modified. The indoor volleyball scoreboard keeps working exactly as today; beach
is added **beside** it behind a `sport` selector. Everything below has been verified headlessly
(no hardware) — see [What was verified](#what-was-verified-headlessly).

Panel: 192×64 HUB75, driven by a Raspberry Pi running the open `openscore.py` firmware
(XML layouts → PNG framebuffer). Scoring is driven by hand from the phone/tablet control UI.

---

## 1. Goal & scope

Add **manual beach volleyball scoring** — the same "operator drives the board by hand" model the
indoor `ManualSource` already provides, but with beach rules and a beach panel layout. Beach at the
club is scored by hand at the table (there is no live OpenVolley beach feed), so the manual path is
the whole job for v1. Linking a live LAN beach match is noted as future work in §8.

Non-goals for v1: a live beach data source; player-level serve order; on-glass hardware calibration
(that is the one step that genuinely needs the panel).

---

## 2. Rules modelled (FIVB / Swiss Volley beach)

Confirmed against the **FIVB Official Beach Volleyball Rules 2025–2028** and a Swiss/German rules
summary (sources at the end of this section).

| Aspect | Beach | (Indoor, for contrast) |
|---|---|---|
| Match format | **Best of 3** | Best of 5 |
| Sets 1–2 target | **21**, win by 2, **no cap** | 25, win by 2, no cap |
| Deciding set (3rd) | **15**, win by 2, no cap | 15 (5th set) |
| Players per side | **2 (a pair)** | 6 + libero |
| Rotation / libero / subs | **none** | rotation, libero, 6 subs/set |
| Team identity | pair name / two surnames | 6-person roster |
| Change of ends | **every 7 points** (sum) in sets 1–2, **every 5** in the deciding set | ends change per set; 5th-set switch at 8 |
| Technical timeout | **one automatic 30 s** in sets 1–2 when the points **sum = 21**; none in the deciding set | (n/a) |
| Team timeouts | **1 per team per set**, 30 s | 2 per set |
| Serve | rally scoring; winner of the rally serves | rally scoring |

**Club defaults chosen** (all configurable, see §6):
- Team timeouts per set: **1** (FIVB). Duration 30 s.
- Technical timeout: **on, 30 s**, sets 1–2, at sum = 21. *Note:* some competitions have dropped the
  technical timeout, and some national events use 60 s — so it is a **toggle + duration**, not hard-coded.
- Set interval / change-of-ends cue: a short on-board "Change ends" prompt (default 5 s), then a side swap.

**Deciding-set coin toss.** Like the indoor 5th set, the 3rd set sides/serve come from a fresh toss,
so the between-sets auto-swap is skipped going *into* the decider (modelled in `next-set`).

Sources:
- FIVB Official Beach Volleyball Rules 2025–2028 — https://www.fivb.com/wp-content/uploads/2025/02/FIVB-BeachVolleyball_Rules2025_2028-EN-v01.pdf
- Swiss/DE rules summary (21 / switch 7 & 5 / timeouts) — https://www.volleyballer.de/beach-regel-kap.php?Kapitel=7.2

---

## 3. Scoreboard state model

Beach reuses the **exact same `a/b` liveState contract** as indoor, so the whole downstream pipeline
(`SourceManager` → `/api/status` → mapper → `LedboxClient` → board, plus the web board-mirror) is
untouched. `side_a` decides which physical side `a` is on; `getState()` always projects with
`side_a: 'left'` (a=left, b=right), identical to `ManualSource`.

Fields used: `team_*_name/short/color`, `points_a/b`, `sets_won_a/b`, `timeouts_a/b`, `serving_team`,
`set_results[]`. `subs_a/b` are **always 0** in beach (kept only so the shape matches — there are no
substitutions), and there is **no `sub` action**.

The scoring machine is `src/beachSource.proposal.js` — a beach-rules sibling of `manualSource.js`.
It stores an internal left/right model and emits `state` on every `apply()`, setting a transient
`lastEvent` the UI reacts to:

| `lastEvent` | Fires when | UI reaction (proposed) |
|---|---|---|
| `set-end` | a set is won (21, or 15 in the decider), by ≥2 | hold final score → "Start interval" prompt (as indoor) |
| `match-end` | the **2nd** set is won (best of 3) | flash winner + "🏆 … wins the match" |
| `court-switch` | points **sum** crosses a change-of-ends boundary (7 in sets 1–2, 5 in the decider) | brief "Change ends" cue (5 s), then a side swap |
| `tech-timeout` | sets 1–2, points **sum reaches 21** | auto-start the 30 s technical-timeout countdown |

Event precedence on a point: **set/match win** > **technical timeout** (at sum 21, which also implies a
change of ends) > **court switch**. Absolute corrections (a typed-in score, `action.value`) never fire
events — only a real `+delta` rally point does, exactly like indoor.

Actions accepted: `point, set, timeout, serve, swap, team, next-set, remove-set, reset, set-state`
(the indoor set minus `sub`). Any unknown action — including a stray indoor `sub` — is a safe no-op,
so the existing `controlServer` `ACTION_TYPES` set needs **no change**.

---

## 4. What is in this scaffold

All new, additive files (nothing existing was edited):

| Path | What |
|---|---|
| `src/beachSource.proposal.js` | Beach scoring machine (21/21/15, switch 7/7/5, tech TO, pairs). Runnable self-check at the bottom. |
| `src/beachMapper.proposal.js` | Beach state → LEDbox `SetSections` for `beach_matchscore` (no sub row, court-switch cue, 1 timeout/set, auto-fit pair names). Reuses `toLeftRight`/`fitFontSize` from `volleyballMapper.js`. Runnable self-check. |
| `firmware/openscore/layouts-beach/beach_matchscore.xml` | The beach scoreboard layout. |
| `firmware/openscore/layouts-beach/beach_idle.xml` | Pre-match idle (crest + two pair names) — same approach as `kscw_idle`. |
| `firmware/openscore/layouts-beach/beach_crest.xml` | Crest-only heartbeat (reuses the KSCW crest media). |
| `firmware/openscore/render_beach_samples.py` | Renders the beach screens to PNG headlessly (sibling of `render_samples.py`). |
| `firmware/openscore/layouts-beach/samples/*.png` | The rendered sample screens (committed for eyeballing). |
| `docs/beach-volley-DESIGN.md` | This document. |

**Run the headless checks**
```bash
node src/beachSource.proposal.js     # scoring rules — 18/18 checks
node src/beachMapper.proposal.js     # section mapping — 8/8 checks
cd firmware/openscore && python3 render_beach_samples.py   # (re)render the sample PNGs
```

---

## 5. Panel layouts

### `beach_matchscore` (the scoreboard)
Modelled on `volleyball_matchscore_02` so the geometry, the web board-mirror and the mapper stay
familiar. Differences: the **sub (S) row is gone** (no substitutions in beach), the centre carries a
**court-switch cue**, and only **one timeout column (T)** is meaningful.

```
┌──────────────────────────────────────────────────────────┐
│ MOL/SOR        0 - 0        ART/DAL     ← pair names + set line
│ ┌────────┐     SWITCH      ┌────────┐   ← amber cue when a change of ends is due
│ │   4    │     0  T  1     │   3    │   ← big scores; T = team timeouts (red once used)
│ └────────┘   ▂▂      ▂▂    └────────┘   ← serve bars (lit = serving side, in pair colour)
└──────────────────────────────────────────────────────────┘
```
Section names (all present in the XML, so a `SetSections` push never hits "section not found"):
`team1/2`, `bg_score1/2`, `score1/2`, `set1`, `vs`, `set2`, `switch`, `timeout1/2`, `lbl_to`,
`serve1/2`.

The `switch` cue is **stateless**: the mapper lights it amber (`SWITCH`) whenever the current points
sum sits on a change-of-ends boundary, and blanks it otherwise — so it shows for exactly as long as
the board holds that score (i.e. during the change). It complements the transient "Change ends"
countdown overlay; neither depends on the other.

### Idle / crest (reused)
`beach_idle` shares the `team1/team2` section names with `kscw_idle`, so the **existing**
`toClubIdleSections()` paints it unchanged (crest + two pair names, auto-fitted). `beach_crest` is
image-only (the club badge) — no sections, no new artwork. Both reuse `media/kscw_crest.png`.

### Rendered samples (headless, committed)
`firmware/openscore/layouts-beach/samples/`:
`01_beach_scoreboard` (switch cue lit at sum 7), `02_beach_midset` (right serving, no cue),
`03_beach_deciding` (1–1, target 15, cue at sum 5), `04_beach_idle`, `05_beach_crest`,
`06_beach_from_jsmapper` (rendered from the **actual `toBeachSections()` output** through the real
firmware — the full mapper→board path, headless).

---

## 6. Control-UI additions (proposed — `web/index.html` not edited)

The UI is one self-contained vanilla file. Beach needs a **sport selector** plus a few beach-aware
tweaks. Concrete anchors are named so the wiring is mechanical:

**Sport selector (Settings tab).** Add to the "Match format" `<fieldset>`:
```html
<label class="row"><span>Sport</span>
  <select data-set="sport"><option value="indoor">Indoor volleyball</option>
    <option value="beach">Beach volleyball</option></select></label>
```
It saves like every other setting (`saveSettings()` already POSTs `data-set` keys). Changing sport
re-initialises the source + board layout (see §7); simplest is to apply on the **next start** and show
a "Restart to apply" note — a live switch is an enhancement.

**Beach-aware behaviour** (gate on `SETTINGS.sport === 'beach'`):
- **Board mirror** (`LAYOUT` array, ~line 738): swap to a beach variant — drop `sub1/lbl_sub/sub2`,
  add the centre `switch` cue — so the on-screen mirror matches the physical beach panel. (A second
  `LAYOUT_BEACH` const selected by sport is the least-invasive change.)
- **`handleEvent()`** (~line 931): add two cases —
  `court-switch` → `startCountdown(5, "Change ends", () => sendAction({ type: "swap" }))`
  (mirrors the existing `switch-8` handling); `tech-timeout` → auto-start the technical-timeout
  countdown (`startCountdown(SETTINGS.techTimeoutSeconds || 30, "Technical timeout", null, {...})`).
- **Subs stat block** (the third `.stat` in each `.side`): hidden in beach (no substitutions).
- **`setLabel()`** (~line 693): "Final" at **2** sets in beach (best of 3), not 3.
- **Team inputs**: placeholder "Pair A/B", allow the two-surname short (`maxlength` already 12).
- **Settings**: in beach, hide "Best of" (fixed 3) and "Total subs/set"; default "Total timeouts/set"
  to 1; add a "Technical timeout" toggle + seconds. Countdown labels use "Time out", "Technical
  timeout", "Change ends".

Nothing above changes indoor behaviour — every branch is guarded by `sport === 'beach'`.

---

## 7. Integration plan (how beach plugs in without breaking indoor)

The seam is small because the state contract, the break/countdown/idle screens and the section-write
protocol are all shared. Only **(a) which scoring source**, **(b) which match layout**, and **(c) which
match mapper** differ. Introduce a tiny **sport registry** and inject those three; default = indoor, so
the indoor path is byte-for-byte unchanged.

**1) `sport` setting** — add to `src/settings.js` `DEFAULTS` (`sport: 'indoor'`) and to `sanitize()` as
an enum (`out.sport = patch.sport === 'beach' ? 'beach' : 'indoor'`). Persisted, survives restart, like
every other preference. (This file is *not* one of the three the task freezes, but the change is shown
here rather than applied, per the "propose the integration" brief.)

**2) A sport registry** (new `src/sports.js`), the single place that knows the per-sport wiring:
```js
import { ManualSource } from './manualSource.js'
import { BeachSource } from './beachSource.proposal.js'
import * as vb from './volleyballMapper.js'
import { toBeachSections } from './beachMapper.proposal.js'

export const SPORTS = {
  indoor: { Source: ManualSource, matchLayout: 'volleyball_matchscore_02',
            idleLayout: 'kscw_idle', toSections: vb.toSections },
  beach:  { Source: BeachSource,  matchLayout: 'beach_matchscore',
            idleLayout: 'beach_idle', toSections: toBeachSections },
}
```
Beach reuses the volleyball **idle, break and countdown** mappers verbatim (the break/countdown screens
are sport-neutral score-box-plus-clock layouts, and `beach_idle` shares `team1/team2`), so only the
match `toSections` is overridden.

**3) `LedboxClient` — inject the match mapper.** It already takes every layout name as a constructor
option (`layout`, `idleLayout`, `crestLayout`, `breakLayout`, `countdownLayout`), so layouts need no
code change — just different values. The one coupling is the hard `import … toSections … from
'./volleyballMapper.js'`. Add an optional `toSections` option defaulting to the imported one:
```js
constructor({ /* … */ toSectionsFn = toSections, /* … */ }) { this._toSections = toSectionsFn }
// in pushState(): this.send('SetSections', this._toSections(state, { totalTimeouts, totalSubs }))
```
Indoor passes nothing → identical behaviour. Beach passes `toBeachSections`.

**4) `appliance.js` — pick the sport at boot.**
```js
const sport = SPORTS[settings.values.sport] || SPORTS.indoor
const manualSource = new sport.Source()
const ledbox = new LedboxClient({ /* …hosts/port… */,
  layout: sport.matchLayout, idleLayout: sport.idleLayout, toSectionsFn: sport.toSections })
```
`ManualSource`/`BeachSource` share the interface (`getState/apply/start/stop` + `state` event), so
`SourceManager`, `controlServer` and the countdown/`next-set` plumbing all work unchanged.

**5) `controlServer.js` (optional polish).** It uses `volleyballMapper.toSections` only for the
`/api/board` **web mirror**, and `toLeftRight` (sport-neutral) for the timeout-team label and point
blink. For a faithful beach mirror, pass the sport's `toSections` into `createControlServer` the same
way and use it in `board()`. Functionally the board itself is already correct without this — it is a
cosmetic fix to the phone's mirror.

**6) Firmware deployment.** Copy `layouts-beach/*.xml` into the board's `openscore/layout/` directory
(filenames are already `beach_`-prefixed, so nothing collides with the volleyball layouts) and ensure
`media/kscw_crest.png` is present (it already is). `openscore.load_layouts()` globs `*.xml`, so the
beach layouts load alongside the indoor ones with no config change; `SetLayout beach_matchscore` then
just works. **Do not** point openscore at a *separate* dir — merge the files so both sports are live.

Because indoor is the default and every beach branch is additive, an untouched deployment behaves
exactly as today.

---

## 8. Integration checklist (for the main agent)

1. **Settings**: add `sport` to `src/settings.js` `DEFAULTS` + `sanitize()` (enum, default `indoor`);
   add the beach knobs (`techTimeoutOn`, `techTimeoutSeconds`, default team-timeouts 1 for beach).
2. **Registry**: add `src/sports.js` (the `SPORTS` map above). Rename the `.proposal.js` modules to
   `src/beachSource.js` / `src/beachMapper.js` once adopted (or import them as-is).
3. **`LedboxClient`**: add the injectable `toSectionsFn` option (default = current import). No other
   change — layouts are already parameters.
4. **`appliance.js`**: read `settings.values.sport`, build `sport.Source`, pass `sport.matchLayout` /
   `sport.idleLayout` / `sport.toSections` to `LedboxClient`.
5. **`controlServer.js`** (optional): inject + use the sport's `toSections` in `board()` for a faithful
   `/api/board` mirror.
6. **`web/index.html`**: add the Sport `<select>`; gate the beach tweaks in §6 on `SETTINGS.sport`
   (board-mirror `LAYOUT_BEACH`, `handleEvent` cases for `court-switch`/`tech-timeout`, hide Subs,
   `setLabel` win-at-2, beach settings visibility, countdown labels).
7. **Firmware**: copy `layouts-beach/*.xml` into the board's `openscore/layout/`; keep
   `media/kscw_crest.png`. Re-run `python3 selftest.py` and `python3 goldentest.py` on the board.
8. **Tests**: add an appliance-level beach smoke test mirroring `test/appliance-selftest.mjs` (drive a
   beach match through the API against the `MockLedbox`, assert the panel sections). Optionally bless
   the beach sample PNGs into `firmware/openscore/golden/` for `goldentest.py`.
9. **On-glass**: calibrate `beach_matchscore` on the real panel (font sizes / y-offsets), exactly as
   the volleyball layout was — this is the only step that needs hardware.

---

## What was verified headlessly

- **Scoring rules** — `node src/beachSource.proposal.js` → **18/18**: court switch at sum 7 (and every
  7), no switch off-boundary, technical timeout at sum 21 (sets 1–2), set win at 21 by ≥2, win-by-2 with
  no cap (21-20/21-21 not won, 23-21 won), deciding set target 15 with switches every 5, `match-end` on
  the 2nd set from both 1-1 and 1-0, and change-of-ends on `next-set` except into the decider.
- **Section mapping** — `node src/beachMapper.proposal.js` → **8/8**: switch cue lights amber on a
  boundary and blanks off it (sets 1–2 and the decider), no `sub` sections ever emitted, used team
  timeout goes red, each pair painted one colour.
- **Layout names** — every section the mapper emits exists in `beach_matchscore.xml` (no error-6 risk).
- **Rendering** — `render_beach_samples.py` composes all five beach screens to 192×64 PNGs with Pillow,
  and the **actual `toBeachSections()` output** was pushed through the real `openscore` `Device`
  (`SetLayout` + `SetSections` both `ok`) and rendered (`06_beach_from_jsmapper.png`). The images were
  eyeballed: legible scores, correct colours, amber switch cue, lit serve bar, auto-fitted pair names.

## Not verifiable without hardware
- On-panel legibility/calibration (multiplexing, brightness, exact font sizes and y-offsets) — the
  documented on-glass step. `beach_matchscore` inherits the proven `volleyball_matchscore_02` geometry,
  but the longer pair names and the new centre cue want a look on the real panel.
- The board's live acceptance of `SetLayout beach_matchscore` (should be identical to any other layout;
  proven against the mock and the open firmware, not the physical C0270).
- Buzzer/horn timing on the technical timeout end (reuses the existing, hardware-verified horn path).

## Open questions for the club
- Keep the automatic **technical timeout**? (Default on/30 s; some competitions drop it, some use 60 s.)
- **Team timeouts per set**: 1 (FIVB) — confirm for club/tournament play.
- Show **player-level serve order** (which of the pair serves)? Out of scope for v1 (side-level serve
  only), easy to add later as a serve dot per player.
