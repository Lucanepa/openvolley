// PROPOSAL — basketball scoring source for the LedBox appliance. Standalone: nothing
// imports this yet (see docs/basketball-DESIGN.md for how it plugs in behind a `sport`
// selector without touching the indoor path). It is a basketball-rules sibling of
// src/manualSource.js and src/beachSource.proposal.js and speaks the SAME a/b liveState
// contract, so the SourceManager, /api/status, the mapper and the web board-mirror all keep
// working unchanged.
//
// Basketball differs from volleyball in ways that force a few concepts onto existing a/b
// fields (documented in full in the design doc). The mapping used here:
//   * Running score, +1/+2/+3 (free throw / field goal / three) — CUMULATIVE across the whole
//     game, it does NOT reset each period. Carried on points_a/b (the same big-number field
//     volleyball uses for set points).
//   * Four 10-min quarters, then 5-min overtime(s) until decided. Period has no per-team
//     analogue, so it can't live in an a/b field — it rides along as an extra scalar `period`
//     (1-4 = Q1..Q4, >=5 = OT1, OT2 ...). `over` (bool, extra scalar) flags a finished game.
//   * Team fouls per period — mapped onto subs_a/b (volleyball's per-set counter that also
//     resets each period). Reset at each new QUARTER, but NOT for overtime (FIBA: OT extends
//     Q4 for foul accumulation). Bonus/penalty when a side reaches its 5th team foul — emitted
//     as a 'bonus' event, exactly the threshold-crossing pattern beach uses for 'tech-timeout'.
//   * Timeouts used — on timeouts_a/b, as in volleyball. A single configurable game total is
//     the club default (FIBA's real 2-first-half / 3-second-half / 1-per-OT split is a
//     documented needs-decision; see the design doc). Timeouts do NOT reset per quarter.
//   * Possession / alternating-possession arrow — mapped onto serving_team ('left'|'right'|
//     null), the field volleyball already lights the serve bar from. Operator-set (a made
//     basket does NOT auto-flip it, unlike volleyball rally scoring).
//   * sets_won_a/b are emitted as 0 (basketball has no per-team set tally) — kept only so the
//     shape matches the indoor liveState the rest of the pipeline expects, exactly as beach
//     keeps subs_a/b at 0.
//
// Internally the model is LEFT/RIGHT (physical board sides); getState() projects it back to
// the a/b liveState with side_a always 'left' (a=left, b=right), like ManualSource, so the
// volleyball mapper's toLeftRight() resolves it identically.

import { EventEmitter } from 'node:events'

// Basketball rule constants — the knobs that differ from the indoor model (FIBA / Swiss
// Basketball; see the design doc for sources). teamTimeoutsTotal is the club DEFAULT, exposed
// as a setting (like volleyball's totalTimeouts) rather than hard-coded downstream.
export const BASKETBALL = {
  quarters: 4, // Q1..Q4 before overtime
  bonusAt: 5, // a team is in the penalty (opponent shoots) from its 5th team foul in a period
  teamTimeoutsTotal: 5, // club default: FIBA 2 (first half) + 3 (second half), whole-game total
  otAfterPeriod: 4, // periods beyond this are overtime (5 -> OT1, 6 -> OT2 ...)
}

// Human label for a period number: Q1..Q4, then OT1, OT2 ... (>4). Exported so the mapper
// paints exactly the same string the machine reasons about.
export function periodLabel(period) {
  const p = Number(period) || 1
  return p <= BASKETBALL.quarters ? `Q${p}` : `OT${p - BASKETBALL.quarters}`
}

// Neutral starting board.
const NEUTRAL = {
  side_a: 'left',
  team_a_name: '', team_a_short: 'HOME', team_a_color: '#2563eb',
  team_b_name: '', team_b_short: 'GUEST', team_b_color: '#ef4444',
  points_a: 0, points_b: 0, sets_won_a: 0, sets_won_b: 0,
  timeouts_a: 0, timeouts_b: 0, subs_a: 0, subs_b: 0, // subs_a/b carry TEAM FOULS in basketball
  serving_team: null, // basketball: the possession arrow ('left'|'right'|null)
  period: 1, over: false,
}

const clamp0 = (n) => (n < 0 ? 0 : n)
const num = (v) => (Array.isArray(v) ? v.length : Number(v) || 0)

export class BasketballSource extends EventEmitter {
  constructor() {
    super()
    this.lastEvent = null // transient: notable event from the last apply() (bonus / period-end / game-end)
    this._fromLiveState(NEUTRAL)
  }

  // Load the internal left/right model from an a/b liveState, honouring side_a.
  _fromLiveState(s) {
    const isALeft = (s.side_a || 'left') === 'left'
    const pick = (a, b) => (isALeft ? a : b)
    this.m = {
      leftName: pick(s.team_a_name, s.team_b_name) ?? '',
      leftShort: pick(s.team_a_short, s.team_b_short) ?? '',
      leftColor: pick(s.team_a_color, s.team_b_color) ?? '#2563eb',
      rightName: pick(s.team_b_name, s.team_a_name) ?? '',
      rightShort: pick(s.team_b_short, s.team_a_short) ?? '',
      rightColor: pick(s.team_b_color, s.team_a_color) ?? '#ef4444',
      leftPoints: num(pick(s.points_a, s.points_b)),
      rightPoints: num(pick(s.points_b, s.points_a)),
      // subs_a/b are the per-period TEAM FOULS in basketball (see header).
      leftFoul: num(pick(s.subs_a, s.subs_b)),
      rightFoul: num(pick(s.subs_b, s.subs_a)),
      leftTO: num(pick(s.timeouts_a, s.timeouts_b)),
      rightTO: num(pick(s.timeouts_b, s.timeouts_a)),
      period: Math.max(1, num(s.period) || 1),
      over: !!s.over,
      serving: s.serving_team ?? null, // the possession arrow: 'left' | 'right' | null
    }
    // Per-period cumulative score snapshots (the line score), stored per physical side so a
    // swap keeps them side-correct. The basketball analogue of volleyball's set_results.
    this.results = (Array.isArray(s.set_results) ? s.set_results : []).map((r) => ({
      left: num(pick(r.a, r.b)), right: num(pick(r.b, r.a)),
    }))
  }

  // Project the left/right model back to the a/b liveState contract (a=left). subs_a/b carry
  // team fouls; sets_won_a/b are always 0 (no per-team set tally in basketball) — both emitted
  // so the shape matches the indoor liveState the pipeline expects. `period` and `over` ride
  // along as extra scalars the basketball mapper reads (harmless to every other consumer).
  getState() {
    const m = this.m
    return {
      side_a: 'left',
      team_a_name: m.leftName, team_a_short: m.leftShort, team_a_color: m.leftColor,
      team_b_name: m.rightName, team_b_short: m.rightShort, team_b_color: m.rightColor,
      points_a: m.leftPoints, points_b: m.rightPoints,
      sets_won_a: 0, sets_won_b: 0,
      timeouts_a: m.leftTO, timeouts_b: m.rightTO,
      subs_a: m.leftFoul, subs_b: m.rightFoul,
      serving_team: m.serving,
      period: m.period, over: m.over,
      set_results: this.results.map((r) => ({ a: r.left, b: r.right })),
    }
  }

  apply(action = {}) {
    const m = this.m
    this.lastEvent = null
    const key = (base, side) => (side === 'right' ? 'right' : 'left') + base
    switch (action.type) {
      case 'point': {
        const side = action.side === 'right' ? 'right' : 'left'
        // An absolute set (an operator correction typed in) just sets the number — no events.
        // Only a +delta scores a basket. delta is +1/+2/+3 (free throw / field goal / three),
        // or a negative correction; the running score is cumulative and never resets per period.
        if (action.value != null) { m[side + 'Points'] = clamp0(Number(action.value) || 0); break }
        m[side + 'Points'] = clamp0(m[side + 'Points'] + (Number(action.delta) || 0))
        // Basketball possession is the alternating-possession arrow, not "the scorer serves":
        // a made basket does NOT change it (operator-driven via the `serve` action).
        break
      }
      // `sub` is REUSED as a TEAM FOUL in basketball (subs_a/b carry the per-period foul count).
      // A +delta that lifts a side to the bonus threshold (5th team foul) fires 'bonus' once —
      // from then on the opponent shoots free throws. A typed correction (value) never fires it.
      case 'sub': {
        const side = action.side === 'right' ? 'right' : 'left'
        if (action.value != null) { m[side + 'Foul'] = clamp0(Number(action.value) || 0); break }
        const before = m[side + 'Foul']
        const d = Number(action.delta) || 0
        m[side + 'Foul'] = clamp0(before + d)
        if (d > 0 && before < BASKETBALL.bonusAt && m[side + 'Foul'] >= BASKETBALL.bonusAt) {
          this.lastEvent = 'bonus'
        }
        break
      }
      case 'timeout':
        m[key('TO', action.side)] = action.value != null
          ? clamp0(Number(action.value) || 0)
          : clamp0(m[key('TO', action.side)] + (Number(action.delta) || 0))
        break
      // `set` is REPURPOSED to adjust the shared PERIOD (side ignored — a period has no side).
      // A pure correction: it never resets fouls or fires an event; that is next-set's job.
      case 'set':
        m.period = action.value != null
          ? Math.max(1, Number(action.value) || 1)
          : Math.max(1, m.period + (Number(action.delta) || 0))
        m.over = false
        break
      case 'serve': // set the possession arrow ('left' | 'right')
        m.serving = action.side === 'right' ? 'right' : 'left'
        break
      case 'swap':
        this._swap()
        break
      case 'team': {
        const side = action.side === 'right' ? 'right' : 'left'
        if (action.name != null) m[side + 'Name'] = String(action.name)
        if (action.short != null) m[side + 'Short'] = String(action.short)
        if (action.color != null) m[side + 'Color'] = String(action.color)
        break
      }
      case 'next-set': {
        // "End the period" — the operator's clock-expiry button, since the game clock is not
        // modelled here (see the design doc). Snapshot the running score as the period's line
        // score, then decide what the next period is:
        //   * before Q4  -> advance a quarter and reset team fouls ('period-end').
        //   * at/after Q4 & TIED -> start (another) overtime; fouls CARRY (FIBA: OT extends Q4).
        //   * at/after Q4 & DECIDED -> the game is over; the leader wins ('game-end').
        if (m.over) break // already finished — ignore a stray extra press
        this.results.push({ left: m.leftPoints, right: m.rightPoints })
        if (m.period < BASKETBALL.quarters) {
          m.period += 1
          m.leftFoul = 0
          m.rightFoul = 0 // team fouls reset each new quarter
          this.lastEvent = 'period-end'
        } else if (m.leftPoints === m.rightPoints) {
          m.period += 1 // into overtime — team fouls carry over, so they are NOT reset
          this.lastEvent = 'period-end'
        } else {
          m.over = true // decided at the end of Q4 (or an OT): whoever leads wins
          this.lastEvent = 'game-end'
        }
        break
      }
      case 'remove-set': {
        // Undo the last period transition: drop the snapshot, step the period back, clear `over`.
        // (Team fouls are not restored — a rare correction; use set-state to rebuild exactly.)
        const last = this.results.pop()
        if (last) m.period = Math.max(1, m.period - 1)
        m.over = false
        break
      }
      case 'reset':
        this._fromLiveState(NEUTRAL)
        break
      case 'set-state':
        this._fromLiveState(action.state || NEUTRAL)
        break
      default:
        return // unknown action: no-op (server validates before calling)
    }
    this.emit('state', this.getState())
  }

  // Swap every left<->right field, including names/colours, and flip the possession arrow. The
  // operator uses this to reflect the halftime change of baskets on the board if the club wants
  // it (FIBA teams switch ends at half-time); it is not automatic, unlike volleyball's per-set swap.
  _swap() {
    const m = this.m
    const pairs = ['Name', 'Short', 'Color', 'Points', 'Foul', 'TO']
    for (const p of pairs) {
      const tmp = m['left' + p]
      m['left' + p] = m['right' + p]
      m['right' + p] = tmp
    }
    if (m.serving === 'left') m.serving = 'right'
    else if (m.serving === 'right') m.serving = 'left'
    for (const r of this.results) { const t = r.left; r.left = r.right; r.right = t }
  }

  start() {} // no-op; present for the uniform Source interface
  stop() {}
}

// --------------------------------------------------------------------------------------
// Tiny self-check (mirrors test/*.mjs and the beach source). Runs only when executed directly:
//     node src/basketballSource.proposal.js
// Proves scoring 1/2/3, period advance, the foul/bonus threshold, timeout counting, and the
// operator-driven game-end (regulation vs overtime).
// --------------------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  let pass = 0, fail = 0
  const ok = (cond, label) => { if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}`) } }
  const mk = () => new BasketballSource()
  const score = (s, side, delta) => { s.apply({ type: 'point', side, delta }); return s.lastEvent }
  const foul = (s, side) => { s.apply({ type: 'sub', side, delta: 1 }); return s.lastEvent }

  // Scoring: +1 / +2 / +3 accumulate, cumulatively (no per-period reset).
  {
    const s = mk()
    score(s, 'left', 1); score(s, 'left', 2); score(s, 'left', 3) // 6
    score(s, 'right', 2); score(s, 'right', 2) // 4
    ok(s.getState().points_a === 6, 'left scores 1+2+3 = 6')
    ok(s.getState().points_b === 4, 'right scores 2+2 = 4')
    ok(score(s, 'left', 2) == null, 'a made basket fires no event')
    ok(s.getState().serving_team == null, 'a made basket does not change possession')
  }

  // Possession arrow via the serve action.
  {
    const s = mk()
    s.apply({ type: 'serve', side: 'right' })
    ok(s.getState().serving_team === 'right', 'possession arrow set right by the serve action')
  }

  // Period labels: Q1..Q4 then OT1, OT2 ...
  {
    ok(periodLabel(1) === 'Q1' && periodLabel(4) === 'Q4', 'periods 1-4 label as Q1..Q4')
    ok(periodLabel(5) === 'OT1' && periodLabel(6) === 'OT2', 'periods 5,6 label as OT1, OT2')
  }

  // Period advance (next-set): quarter increments, team fouls reset, score + timeouts do NOT.
  {
    const s = mk()
    score(s, 'left', 3); score(s, 'right', 2)
    foul(s, 'left'); foul(s, 'left') // 2 team fouls
    s.apply({ type: 'timeout', side: 'left', delta: 1 }) // 1 timeout used
    ok(s.lastEvent == null, 'plain foul/timeout below threshold fires nothing')
    s.apply({ type: 'next-set' }) // end Q1
    ok(s.getState().period === 2, 'next-set advances Q1 -> Q2')
    ok(s.lastEvent === 'period-end', 'next-set fires period-end')
    ok(s.getState().subs_a === 0 && s.getState().subs_b === 0, 'team fouls reset for the new quarter')
    ok(s.getState().points_a === 3 && s.getState().points_b === 2, 'score is cumulative across quarters (not reset)')
    ok(s.getState().timeouts_a === 1, 'timeouts do NOT reset per quarter (FIBA: per half)')
  }

  // Foul / bonus threshold: the 5th team foul fires 'bonus' once; the 4th does not, the 6th does not re-fire.
  {
    const s = mk()
    let e = null
    for (let i = 0; i < 4; i++) e = foul(s, 'left')
    ok(e == null, 'no bonus at the 4th team foul')
    ok(foul(s, 'left') === 'bonus', 'bonus fires on the 5th team foul (penalty)')
    ok(foul(s, 'left') == null, 'bonus does not re-fire on the 6th foul')
    ok(s.getState().subs_a === 6, 'team fouls keep counting past the bonus')
    // A typed foul correction never fires bonus.
    const s2 = mk()
    s2.apply({ type: 'sub', side: 'right', value: 5 })
    ok(s2.lastEvent == null && s2.getState().subs_b === 5, 'a typed foul correction sets the count without firing bonus')
  }

  // Timeout counting (used count on timeouts_a/b).
  {
    const s = mk()
    s.apply({ type: 'timeout', side: 'right', delta: 1 })
    s.apply({ type: 'timeout', side: 'right', delta: 1 })
    ok(s.getState().timeouts_b === 2, 'timeouts used count up on the right')
  }

  // Game end in regulation: end Q4 while ahead -> game-end, no 5th period, leader leads.
  {
    const s = mk()
    s.apply({ type: 'set', value: 4 }) // jump to Q4
    ok(s.getState().period === 4, 'set action jumps straight to Q4 (period control)')
    score(s, 'left', 3); score(s, 'right', 2) // 3-2
    s.apply({ type: 'next-set' }) // end Q4, decided
    ok(s.lastEvent === 'game-end', 'ending Q4 while not tied ends the game')
    ok(s.getState().over === true, 'over flag set')
    ok(s.getState().period === 4, 'no phantom Q5 — the game just ends')
    ok(s.getState().points_a > s.getState().points_b, 'the leader (left) is the winner')
    // A stray extra press after the game is over is ignored.
    const before = s.getState().period
    s.apply({ type: 'next-set' })
    ok(s.getState().period === before, 'next-set after game-end is a no-op')
  }

  // Tie at the end of Q4 -> overtime; team fouls CARRY into OT (FIBA: OT extends Q4).
  {
    const s = mk()
    s.apply({ type: 'set', value: 4 })
    score(s, 'left', 2); score(s, 'right', 2) // 2-2 tie
    foul(s, 'left'); foul(s, 'left'); foul(s, 'left') // 3 team fouls in Q4
    s.apply({ type: 'next-set' }) // end Q4, tied
    ok(s.getState().period === 5 && periodLabel(s.getState().period) === 'OT1', 'a tie at Q4 goes to OT1')
    ok(s.lastEvent === 'period-end', 'starting overtime fires period-end (not game-end)')
    ok(s.getState().subs_a === 3, 'team fouls carry into overtime (not reset)')
    ok(s.getState().over === false, 'game is not over — overtime is live')
    // Decide the overtime.
    score(s, 'left', 3)
    s.apply({ type: 'next-set' })
    ok(s.lastEvent === 'game-end' && s.getState().over === true, 'overtime ends the game once decided')
  }

  // Swap sides (halftime change of baskets, operator-driven).
  {
    const s = mk()
    s.apply({ type: 'team', side: 'left', short: 'AAA' })
    s.apply({ type: 'team', side: 'right', short: 'BBB' })
    score(s, 'left', 2)
    s.apply({ type: 'swap' })
    ok(s.getState().team_a_short === 'BBB', 'swap moves the right team to the left')
    ok(s.getState().points_a === 0 && s.getState().points_b === 2, 'the score follows the team across the swap')
  }

  // Contract-shape parity: sets_won always 0, subs carry fouls, period/over present.
  {
    const s = mk()
    const st = s.getState()
    ok(st.sets_won_a === 0 && st.sets_won_b === 0, 'sets_won emitted as 0 for shape parity (no sets in basketball)')
    ok('subs_a' in st && 'timeouts_a' in st && 'serving_team' in st, 'full a/b contract shape emitted')
    ok('period' in st && 'over' in st, 'period and over ride along as extra scalars')
  }

  console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}
