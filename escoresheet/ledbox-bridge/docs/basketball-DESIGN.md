# Basketball on the KSC Wiedikon LED scoreboard — design & scaffold

**Status:** design + headless scaffold. Nothing here is wired into the running appliance yet, and
no live file is modified. The indoor volleyball scoreboard keeps working exactly as today; basketball
is added **beside** it behind a `sport` selector, alongside the beach scaffold. Everything below has
been verified headlessly (no hardware) — see [What was verified](#what-was-verified-headlessly).

Panel: 192×64 HUB75, driven by a Raspberry Pi running the open `openscore.py` firmware
(XML layouts → PNG framebuffer). Scoring is driven by hand from the phone/tablet control UI.

---

## 1. Goal & scope

Add **manual basketball scoring** — the same "operator drives the board by hand" model the indoor
`ManualSource` and the `BeachSource` scaffold already provide, but with basketball rules and a
basketball panel layout. There is no live basketball feed at the club, so the manual path is the
whole job for v1 (identical to beach).

The core deliverable is **score + period + team fouls + timeouts** rendering correctly and driven by
the operator. The **live game clock / shot clock** is the one genuinely hardware-dependent piece and
is deliberately a documented phase-2 / needs-decision item (see §9), not a blocker for the scaffold —
exactly as the beach scaffold flagged the technical-timeout timing and on-glass calibration.

Non-goals for v1: a live basketball data source; a running game/shot clock on the board; player-level
foul tracking (individual fouls, foul-out); on-glass hardware calibration (the one step that genuinely
needs the panel).

---

## 2. Rules modelled (FIBA / Swiss Basketball)

Confirmed against the **FIBA Official Basketball Rules** (2024 edition) and cross-checked against
rules summaries (sources at the end of this section). Swiss Basketball plays FIBA rules.

| Aspect | Basketball (FIBA) | (Indoor volleyball, for contrast) |
|---|---|---|
| Scoring | **running score**, +1 (free throw) / +2 (field goal) / +3 (three) | rally points, reset each set |
| Score reset | **never** — the score is cumulative across the whole game | points reset every set |
| Game format | **4 quarters × 10 min**, then **5-min overtime(s)** until decided | best of 3/5 sets |
| Period indicator | **Q1–Q4**, then **OT1, OT2 …** | set number |
| Team fouls | counted **per period**; **bonus/penalty from the 5th** team foul (opponent shoots 2 FT) | (n/a) |
| Team-foul reset | reset **each quarter**, but **NOT for overtime** (OT extends Q4 for fouls) | subs reset each set |
| Timeouts | **2 in the first half, 3 in the second half, 1 per OT**; 60 s each; no carry-over | 2 per set |
| Possession | **alternating-possession arrow** — points to who inbounds at the next jump-ball | serve (rally) |
| Sides | teams **switch baskets at half-time** (once), not every quarter | switch ends every set |
| Winner | whoever **leads when the game (or OT) ends** | first to win 2/3 sets |

**Club defaults chosen** (configurable where noted, see §6):
- **Team fouls → bonus at 5** (FIBA fixed). Kept as a rule constant (`BASKETBALL.bonusAt`), trivially
  exposable as a setting if a league ever differs.
- **Timeouts:** a single **game total, default 5** (= FIBA's 2 + 3), exposed exactly like volleyball's
  `totalTimeouts`. The precise **2-first-half / 3-second-half / +1-per-OT** split with no carry-over is
  the real rule but is a **needs-decision** refinement (see §9), not hard-coded — v1 tracks
  timeouts-used against one game total, which is the sane, glanceable club default.
- **Possession arrow:** included as an operator-set indicator (the serve bar), off by default until the
  operator sets it. Rendering it at all is a club decision (see §9).
- **Side switch at half-time:** operator-driven (`swap`), not automatic — a fixed scoreboard usually
  keeps home-left/away-right all game; the operator can reflect the half-time basket change if wanted.

Sources:
- FIBA Official Basketball Rules 2024 (primary) — https://assets.fiba.basketball/image/upload/documents-corporate-fiba-official-rules-2024-v10a.pdf
- FIBA 2024 rule changes (timeouts / periods) — https://assets.fiba.basketball/image/upload/documents-corporate-fiba-official-rules-2024-changes---v20a-eng.pdf
- Bonus / team-foul reset + OT carry-over — https://en.wikipedia.org/wiki/Bonus_(basketball)
- Alternating possession — https://opensourcesports.io/rules/basketball-fiba/rules-of-play-overtime

---

## 3. Scoreboard state model

Basketball reuses the **exact same `a/b` liveState contract** as indoor, so the whole downstream
pipeline (`SourceManager` → `/api/status` → mapper → `LedboxClient` → board, plus the web
board-mirror) is untouched. `getState()` always projects with `side_a: 'left'` (a=left, b=right),
identical to `ManualSource`/`BeachSource`.

Basketball has concepts volleyball lacks, so a few are **mapped onto existing fields** (the field
carries a basketball meaning); the two with no per-team analogue ride along as **extra scalars** that
every existing consumer safely ignores. The scoring machine is `src/basketballSource.proposal.js`.

| `a/b` field | Volleyball meaning | **Basketball meaning (this scaffold)** |
|---|---|---|
| `points_a/b` | current-set points | **running score** — cumulative, +1/+2/+3, never reset per period |
| `timeouts_a/b` | timeouts used this set | **timeouts used** (game) |
| `subs_a/b` | substitutions this set | **team fouls this period** (reset each quarter, carry into OT) |
| `serving_team` | serving side | **possession** (alternating-possession arrow), `'left'\|'right'\|null` |
| `set_results[]` | completed set scores | **per-period line-score snapshots** (the box-score line) |
| `sets_won_a/b` | sets won | **unused — emitted `0`** (no per-team set tally), kept for shape parity |
| `period` *(extra)* | — | **current period**: `1–4` = Q1–Q4, `≥5` = OT1, OT2 … |
| `over` *(extra)* | — | **game-finished** flag (the leader has won) |

Reusing `subs_a/b` for team fouls is deliberate: both are **per-period counters that reset on the
period transition**, so the indoor limit-colouring mechanic (amber near the cap, red at it) drops
straight onto the bonus threshold. `sets_won_a/b` are emitted as `0` for the same reason beach emits
`subs_a/b` as `0` — to keep the shape the pipeline expects. `period`/`over` are additive scalars: a
JSON consumer that doesn't know them just passes them through.

The machine emits `state` on every `apply()`, setting a transient `lastEvent` the UI reacts to:

| `lastEvent` | Fires when | UI reaction (proposed) |
|---|---|---|
| `bonus` | a side reaches its **5th team foul** in the period | toast "Bonus — opponent shoots"; the F counter is already red |
| `period-end` | `next-set` advances a quarter **or** starts an overtime | refresh the period label; optional quarter/OT break |
| `game-end` | `next-set` ends **Q4 or an OT while not tied** | flash the leader + "🏆 … wins" |

Event precedence is trivial (each `apply()` produces at most one), and absolute corrections (a typed-in
score/foul, `action.value`) never fire events — only a real `+delta` does, exactly like indoor/beach.

**Actions accepted** — the indoor set, **reusing the existing `ACTION_TYPES`** so `controlServer` needs
**no change**:

| action | Basketball effect |
|---|---|
| `point {side, delta:1\|2\|3}` | add to the running score (free throw / field goal / three); `{value}` sets it |
| `sub {side, delta}` | **team foul** ±; `bonus` fires on crossing 5; `{value}` corrects without firing |
| `timeout {side, delta}` | timeout used ±; `{value}` corrects |
| `serve {side}` | set the **possession arrow** to that side |
| `set {delta\|value}` | adjust the **shared period** (side ignored — a period has no side) |
| `next-set` | **end the period** → next quarter / overtime (if tied) / `game-end` (if decided) |
| `remove-set` | undo the last period transition |
| `swap` | swap sides (half-time basket change, operator's choice) |
| `team` / `reset` / `set-state` | as indoor |

`next-set` is the operator's "the clock expired" button (the game clock is not modelled — §9). It
snapshots the period's line score, then: before Q4 → advance a quarter and reset team fouls; at/after
Q4 and **tied** → start (another) overtime with fouls carried over; at/after Q4 and **decided** → set
`over` and fire `game-end`. Any unknown action (e.g. a stray value) is a safe no-op.

---

## 4. What is in this scaffold

All new, additive files (nothing existing was edited):

| Path | What |
|---|---|
| `src/basketballSource.proposal.js` | Basketball scoring machine (running score, Q/OT periods, team fouls + bonus, timeouts, possession). Runnable self-check at the bottom. |
| `src/basketballMapper.proposal.js` | Basketball state → LEDbox `SetSections` for `basketball_matchscore` (period indicator, F counter + bonus marker, T counter, possession bars, auto-fit team names). Reuses `toLeftRight`/`fitFontSize` from `volleyballMapper.js` and `periodLabel` from the source. Runnable self-check. |
| `firmware/openscore/layouts-basketball/basketball_matchscore.xml` | The basketball scoreboard layout. |
| `firmware/openscore/layouts-basketball/basketball_idle.xml` | Pre-match idle (crest + two team names) — same approach as `kscw_idle`. |
| `firmware/openscore/layouts-basketball/basketball_crest.xml` | Crest-only heartbeat (reuses the KSCW crest media). |
| `firmware/openscore/render_basketball_samples.py` | Renders the basketball screens to PNG headlessly (sibling of `render_beach_samples.py`). |
| `firmware/openscore/layouts-basketball/samples/*.png` | The rendered sample screens (for eyeballing; `samples/` is git-ignored, regenerable). |
| `docs/basketball-DESIGN.md` | This document. |

**Run the headless checks**
```bash
node src/basketballSource.proposal.js     # scoring rules — 35/35 checks
node src/basketballMapper.proposal.js     # section mapping — 17/17 checks
cd firmware/openscore && python3 render_basketball_samples.py   # (re)render the sample PNGs
```

---

## 5. Panel layouts

### `basketball_matchscore` (the scoreboard)
Modelled on `volleyball_matchscore_02` so the geometry, the web board-mirror and the mapper stay
familiar. Differences: the two-number **set line** becomes a single centre **period indicator**
(Q1–Q4 / OT1 / FINAL); the indoor **S (subs) row** becomes the **F (team-foul) row** with a per-side
**bonus marker**; the **serve bars** double as the **possession** indicator.

```
┌──────────────────────────────────────────────────────────┐
│ KSCW •         Q3          • GAST   ← team codes; • = bonus/penalty marker (red when ≥5 fouls)
│ ┌────────┐   5  F  3     ┌────────┐ ← big scores; F = team fouls (amber at 4, red at 5+ bonus)
│ │  58    │   2  T  1     │  61    │ ← T = timeouts used (red at the game total)
│ └────────┘  ▂▂       ▂▂  └────────┘ ← possession bar (lit = arrow side, in team colour)
└──────────────────────────────────────────────────────────┘
```
Section names (all present in the XML, so a `SetSections` push never hits "section not found"):
`team1/2`, `bg_score1/2`, `score1/2`, `period`, `foul1/2`, `lbl_foul`, `bonus1/2`, `timeout1/2`,
`lbl_to`, `serve1/2`.

The `period` text is fitted so "FINAL" (game over) never clips. The `bonus1/2` markers light a red
"•" next to a team once it reaches the bonus (5th team foul); the foul counter itself is already red
by then, giving two glanceable signals. No game clock is on this layout by design (§9).

### Idle / crest (reused)
`basketball_idle` shares the `team1/team2` section names with `kscw_idle`, so the **existing**
`toClubIdleSections()` paints it unchanged (crest + two team names, auto-fitted). `basketball_crest`
is image-only (the club badge) — no sections, no new artwork. Both reuse `media/kscw_crest.png`.

### Rendered samples (headless)
`firmware/openscore/layouts-basketball/samples/`:
`01_basketball_scoreboard` (Q1, no bonus, possession left), `02_basketball_bonus` (Q3, home in the
penalty — foul count red + marker lit), `03_basketball_overtime` (OT1, fouls carried, near timeout
cap), `04_basketball_idle`, `05_basketball_crest`, `06_basketball_from_jsmapper` (rendered from the
**actual `toBasketballSections()` output** through the real firmware — the full mapper→board path,
headless, with real team colours).

---

## 6. Control-UI additions (proposed — `web/index.html` not edited)

The UI is one self-contained vanilla file. Basketball needs the **sport selector** (shared with beach)
plus a few basketball-aware tweaks. Concrete anchors are named so the wiring is mechanical. Every
branch is gated on `SETTINGS.sport === 'basketball'`, so indoor (and beach) behaviour is untouched.

**Sport selector (Settings tab).** The same `<select data-set="sport">` the beach doc proposes, with a
third option (see `web/index.html` ~line 390, the "Match format" `<fieldset>`):
```html
<label class="row"><span>Sport</span>
  <select data-set="sport"><option value="indoor">Indoor volleyball</option>
    <option value="beach">Beach volleyball</option>
    <option value="basketball">Basketball</option></select></label>
```

**Basketball-aware behaviour:**
- **Board mirror** (`LAYOUT` array, ~line 745): a `LAYOUT_BASKETBALL` variant selected by sport — drop
  `set1/vs/set2`, add a centre `period`; rename `sub1/lbl_sub/sub2` → `foul1/lbl_foul(F)/foul2`; add
  `bonus1/bonus2`; keep the `timeout` row and `serve` bars — so the on-screen mirror matches the
  physical basketball panel.
- **`handleEvent()`** (~line 938): add cases — `bonus` → `toast("Bonus — opponent shoots")` (+ optional
  flash of the fouling side); `period-end` → refresh the period label (and optionally a short quarter
  break via `startCountdown`); `game-end` → flash the leader by **points** and `toast("🏆 … wins")`
  (mirrors the existing `match-end`, but the winner is by score, not `sets_won`).
- **Per-side stat blocks** (the three `.stat`s at ~lines 287–292 / 319–324): relabel **Subs → Fouls**
  (still the `subs` field/`data-val="sub"`), and hide the **Sets** stat (basketball has no set tally).
  The +/- for the `sub` stat becomes the foul control; wire the point buttons for +1/+2/+3 (below).
- **Point buttons** (~line 1064, `data-pt` → `delta`): basketball needs **+1 / +2 / +3** buttons
  (`data-pt="1|2|3"`) instead of the single +1; the existing `sendAction({type:"point", …, delta})`
  path already carries any delta.
- **Period control**: a header **period label** (Q1…/OT1/FINAL) in place of the set label
  (`setLabel()`, ~line 700), and a "Next quarter"/"End period" button → `sendAction({type:"next-set"})`
  (reusing the existing next-set/undo controls at ~line 734).
- **Settings** (Match format fieldset): in basketball hide "Best of" and "Total subs / set"; relabel
  "Total timeouts / set" → "Total timeouts (game)" and default it to **5**; the `[1,9]` clamp already
  in `settings.js` covers it (no range change needed).

Nothing above changes indoor or beach behaviour — every branch is guarded by the sport.

---

## 7. Integration plan (how basketball plugs in without breaking indoor)

The seam is the same one the beach doc opens: the state contract, the break/countdown/idle screens and
the section-write protocol are all shared, so only **(a) which scoring source**, **(b) which match
layout**, and **(c) which match mapper** differ. Basketball is a **third entry** in the sport registry
the beach doc proposes — it introduces no new seam.

**1) `sport` setting** — the beach doc already adds `sport` to `src/settings.js` `DEFAULTS`
(`sport: 'indoor'`) and `sanitize()` as an enum; extend the enum to accept `'basketball'`
(`out.sport = ['beach','basketball'].includes(patch.sport) ? patch.sport : 'indoor'`). When sport is
basketball, default `totalTimeouts` to 5 (a per-sport default applied on switch; the `[1,9]` clamp is
unchanged). No new numeric knob is required.

**2) Sport registry** (the beach doc's proposed new `src/sports.js`) — add the basketball row:
```js
import { ManualSource } from './manualSource.js'
import { BeachSource } from './beachSource.proposal.js'
import { BasketballSource } from './basketballSource.proposal.js'
import * as vb from './volleyballMapper.js'
import { toBeachSections } from './beachMapper.proposal.js'
import { toBasketballSections } from './basketballMapper.proposal.js'

export const SPORTS = {
  indoor:     { Source: ManualSource,     matchLayout: 'volleyball_matchscore_02',
                idleLayout: 'kscw_idle',        toSections: vb.toSections },
  beach:      { Source: BeachSource,      matchLayout: 'beach_matchscore',
                idleLayout: 'beach_idle',       toSections: toBeachSections },
  basketball: { Source: BasketballSource, matchLayout: 'basketball_matchscore',
                idleLayout: 'basketball_idle',  toSections: toBasketballSections },
}
```
Basketball reuses the volleyball **idle, break and countdown** mappers verbatim (those screens are
sport-neutral, and `basketball_idle` shares `team1/team2`), so only the match `toSections` is overridden.
> **Note:** `src/sports.js` is a **shared seam owned by the human integration step**. This scaffold
> only *documents* the basketball row — it does not create or edit `src/sports.js` (two agents must not
> both write the shared file). The beach and basketball rows are added together in one deliberate pass.

**3) `LedboxClient` — inject the match mapper.** Exactly as the beach doc describes: add an optional
`toSectionsFn` constructor option defaulting to the current `toSections` import; layouts are already
constructor options, so no layout code changes. Basketball passes `toBasketballSections`.

**4) `appliance.js` — pick the sport at boot.**
```js
const sport = SPORTS[settings.values.sport] || SPORTS.indoor
const manualSource = new sport.Source()
const ledbox = new LedboxClient({ /* …hosts/port… */,
  layout: sport.matchLayout, idleLayout: sport.idleLayout, toSectionsFn: sport.toSections })
```
`ManualSource`/`BeachSource`/`BasketballSource` share the interface (`getState/apply/start/stop` +
`state` event), so `SourceManager`, `controlServer` and the countdown/`next-set` plumbing all work
unchanged.

**5) `controlServer.js` (optional polish).** As with beach, inject the sport's `toSections` into
`createControlServer` and use it in `board()` for a faithful `/api/board` web mirror. Without it the
mirror renders basketball state through the indoor mapper — the score, timeouts and fouls (via
`subs_a/b`) still read correctly; only the top-centre would show `0-0` sets instead of the period. The
**physical board is already correct**; this is purely the phone's mirror.

**6) Firmware deployment.** Copy `layouts-basketball/*.xml` into the board's `openscore/layout/`
directory (filenames are `basketball_`-prefixed, so nothing collides with the volleyball or beach
layouts) and keep `media/kscw_crest.png` (already present). `openscore.load_layouts()` globs `*.xml`,
so the basketball layouts load alongside the others with no config change; `SetLayout
basketball_matchscore` then just works. **Do not** point openscore at a separate dir — merge the files
so every sport is live.

Because indoor is the default and every basketball branch is additive, an untouched deployment behaves
exactly as today.

---

## 8. Integration checklist (for the main agent)

1. **Settings**: extend the `sport` enum (added by the beach doc) to accept `'basketball'`; apply a
   per-sport `totalTimeouts` default of 5 for basketball. No `settings.js` clamp change needed.
2. **Registry**: add the `basketball` row to `src/sports.js` (the shared file created in the beach
   integration). Rename the `.proposal.js` modules to `src/basketballSource.js` / `src/basketballMapper.js`
   once adopted (or import them as-is).
3. **`LedboxClient`**: use the injectable `toSectionsFn` option (added by the beach integration) — no
   further change.
4. **`appliance.js`**: build `sport.Source`, pass `sport.matchLayout` / `sport.idleLayout` /
   `sport.toSections` to `LedboxClient` (shared with beach).
5. **`controlServer.js`** (optional): inject + use the sport's `toSections` in `board()`.
6. **`web/index.html`**: add `basketball` to the Sport `<select>`; gate the §6 tweaks on
   `SETTINGS.sport === 'basketball'` (board-mirror `LAYOUT_BASKETBALL`, `handleEvent` cases for
   `bonus`/`period-end`/`game-end`, +1/+2/+3 point buttons, Subs→Fouls + hide Sets, period label + next-quarter button, basketball settings visibility).
7. **Firmware**: copy `layouts-basketball/*.xml` into the board's `openscore/layout/`; keep
   `media/kscw_crest.png`. Re-run `python3 selftest.py` and `python3 goldentest.py` on the board.
8. **Tests**: add an appliance-level basketball smoke test mirroring `test/appliance-selftest.mjs`
   (drive a game through the API against the `MockLedbox`, assert the panel sections: score, period,
   fouls, bonus, timeouts). Optionally bless the basketball sample PNGs into a golden set.
9. **On-glass**: calibrate `basketball_matchscore` on the real panel (font sizes / y-offsets), exactly
   as the volleyball layout was — the only step that needs hardware.

---

## 9. The game clock (phase-2 / needs-decision)

The core scaffold renders **score + period + fouls + timeouts** with no timer, which is fully useful on
its own. A **running game clock (1 s) and shot clock (0.1 s)** are the genuinely hardware-dependent
piece, deliberately left as a documented decision — mirroring how beach flagged the technical-timeout
timing.

**Could the existing countdown primitive drive it?** The firmware's only timed primitive is the
server-side countdown in `controlServer.startCountdown()` — a 1 s `setInterval` that pushes remaining
seconds to a **separate** countdown/break layout, counts monotonically to zero and optionally horns. It
is used for volleyball timeouts and set intervals. It *could* be repurposed to show a running `mm:ss`
game clock, but it is **not** a game clock as-is:
- No **pause/resume/adjust** — a basketball clock stops on every whistle; the primitive only counts down.
- It drives a **full-screen break layout**, not an **inline clock** on the match layout.
- The **shot clock** needs 0.1 s resolution near zero and its own reset (24 / 14), which a 1 s server
  tick over the network cannot do accurately.
- An accurate live clock really wants to run **on the board** (in the firmware) to avoid network jitter,
  or take a dedicated timing input — a larger change than this scaffold.

**Recommendation:** ship the scaffold clock-free; treat a live clock as phase-2, and decide then between
(a) an inline `mm:ss` operator-driven clock with pause/resume added to the firmware, or (b) leaving the
clock to the hall's existing shot-clock/timer hardware and using the LED panel for score/period/fouls
only. This is a **club decision**, not a code blocker.

---

## What was verified headlessly

- **Scoring rules** — `node src/basketballSource.proposal.js` → **35/35**: +1/+2/+3 accumulate
  cumulatively (no per-period reset); a made basket fires no event and doesn't change possession; the
  possession arrow is operator-set; period labels Q1–Q4 → OT1, OT2; `next-set` advances a quarter and
  **resets team fouls but not the score or timeouts**; the **bonus** fires exactly on the 5th team foul
  (not the 4th, not re-fired on the 6th) and a typed foul correction never fires it; ending Q4 while
  **ahead** ends the game (`game-end`, `over`, no phantom Q5, the leader wins) and a stray extra press is
  ignored; a **tie at Q4 goes to OT1** with **team fouls carried over** (`period-end`, not game-end) and
  the OT then ends the game once decided; `swap` moves a team across with its score; and the emitted
  shape keeps `sets_won = 0` with `period`/`over` present.
- **Section mapping** — `node src/basketballMapper.proposal.js` → **17/17**: score + team colour, the
  centre period indicator (Q2 / OT1 / FINAL), the foul counter (neutral → amber at 4 → red at 5) with
  the bonus marker lit only for the team in the penalty, the timeout counter red at the game total, the
  possession bar on the correct side, and **no** volleyball-only `sub*`/`set*` sections leaking onto the
  board.
- **Layout names** — every section the mapper emits exists in `basketball_matchscore.xml` (no error-6 risk).
- **Rendering** — `render_basketball_samples.py` composes all six basketball screens to 192×64 PNGs with
  Pillow, and the **actual `toBasketballSections()` output** was pushed through the real `openscore`
  `Device` (`SetLayout` + `SetSections` both `ok`) and rendered (`06_basketball_from_jsmapper.png`). The
  images were eyeballed: legible big scores, correct per-team colours, centre period, amber/red foul
  counter, lit bonus marker, lit possession bar, auto-fitted team names.
- **No regression** — the indoor suites are byte-for-byte unchanged and green: `npm test`
  (mapper + relay), `npm run test:appliance` (31/31), and the firmware `selftest.py` (15/15) /
  `goldentest.py` (indoor goldens 0.00% changed). Zero existing files were edited.

## Not verifiable without hardware
- On-panel legibility/calibration (multiplexing, brightness, exact font sizes and y-offsets) — the
  documented on-glass step. `basketball_matchscore` inherits the proven `volleyball_matchscore_02`
  geometry, but the period label, the F/T stack and the bonus markers want a look on the real panel.
- The board's live acceptance of `SetLayout basketball_matchscore` (should be identical to any other
  layout; proven against the mock and the open firmware, not the physical C0270).
- Buzzer/horn timing (reuses the existing, hardware-verified horn path).

## Open questions for the club
- **Timeouts:** keep the simple **game total (default 5)**, or model the real FIBA **2 first half / 3
  second half / +1 per OT** split (reset at half-time and each OT, no carry-over)? v1 ships the total;
  the split is a phase-2 refinement.
- **Possession arrow:** show it at all? Some clubs don't bother on a fixed board. It is included as an
  operator-set indicator, off until set.
- **Live game/shot clock:** decide the approach in §9 (add an inline operator clock to the firmware, or
  leave timing to the hall's existing hardware).
- **Side switch at half-time:** reflect the basket change on the board (`swap`) or keep home-left all
  game? Currently operator's choice, not automatic.
- **Bonus threshold:** FIBA is fixed at the 5th team foul; expose as a setting only if a local league differs.
