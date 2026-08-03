// Manual control source for the LedBox appliance. The operator drives the board
// by hand — points, sets, timeouts, subs, serve, team names/colours — with no
// live match behind it. Internally the model is stored as LEFT/RIGHT (physical
// board sides); getState() projects it back to the a/b liveState contract with
// side_a always 'left' (a=left, b=right), which the mapper then resolves.

import { EventEmitter } from 'node:events'

// Neutral starting board (mirrors the appliance's NEUTRAL constant).
const NEUTRAL = {
  side_a: 'left',
  team_a_name: '', team_a_short: 'HOME', team_a_color: '#2563eb',
  team_b_name: '', team_b_short: 'AWAY', team_b_color: '#ef4444',
  points_a: 0, points_b: 0, sets_won_a: 0, sets_won_b: 0,
  timeouts_a: 0, timeouts_b: 0, subs_a: 0, subs_b: 0,
  serving_team: 'left',
}

const clamp0 = (n) => (n < 0 ? 0 : n)
const num = (v) => (Array.isArray(v) ? v.length : Number(v) || 0)

// Indoor volleyball is best-of-5: 3 sets take the match, and the 5th is the deciding set.
// Named so the deciding-set rules below read as "deciding", not a hardcoded "== 2". (Wiring a
// best-of-3 alternative is part of the deferred per-sport settings refactor, not this slice.)
const SETS_TO_WIN = 3
// Deciding set only: the first team to reach this many points prompts a change of ends.
const DECIDER_SWITCH_AT = 8

export class ManualSource extends EventEmitter {
  constructor() {
    super()
    this.lastEvent = null // transient: the notable event from the last apply() (set-end / match-end / switch-due)
    this._fromLiveState(NEUTRAL)
  }

  // The deciding set — both teams one set short of the match (2-2 in best-of-5). Court switches
  // in the deciding set hinge on this rather than on a hardcoded set number.
  get _deciding() {
    return this.m.leftSets === SETS_TO_WIN - 1 && this.m.rightSets === SETS_TO_WIN - 1
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
      leftSets: num(pick(s.sets_won_a, s.sets_won_b)),
      rightSets: num(pick(s.sets_won_b, s.sets_won_a)),
      leftTO: num(pick(s.timeouts_a, s.timeouts_b)),
      rightTO: num(pick(s.timeouts_b, s.timeouts_a)),
      leftSub: num(pick(s.subs_a, s.subs_b)),
      rightSub: num(pick(s.subs_b, s.subs_a)),
      serving: s.serving_team ?? null, // already 'left' | 'right' | null
    }
    // Completed-set final scores, stored per physical side (swapped on _swap()).
    this.results = (Array.isArray(s.set_results) ? s.set_results : []).map((r) => ({
      left: num(pick(r.a, r.b)), right: num(pick(r.b, r.a)),
    }))
  }

  // Project the left/right model back to the a/b liveState contract (a=left).
  getState() {
    const m = this.m
    return {
      side_a: 'left',
      team_a_name: m.leftName, team_a_short: m.leftShort, team_a_color: m.leftColor,
      team_b_name: m.rightName, team_b_short: m.rightShort, team_b_color: m.rightColor,
      points_a: m.leftPoints, points_b: m.rightPoints,
      sets_won_a: m.leftSets, sets_won_b: m.rightSets,
      timeouts_a: m.leftTO, timeouts_b: m.rightTO,
      subs_a: m.leftSub, subs_b: m.rightSub,
      serving_team: m.serving,
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
        const other = side === 'left' ? 'right' : 'left'
        const before = m[side + 'Points']
        // Absolute set (an operator correction typed in) just sets the number — no serve
        // change, no set-win detection. Only a +delta drives the rally rules below.
        if (action.value != null) { m[side + 'Points'] = clamp0(Number(action.value) || 0); break }
        const d = Number(action.delta) || 0
        m[side + 'Points'] = clamp0(before + d)
        if (d > 0) {
          // Rally scoring: the side that wins the point serves next.
          m.serving = side
          const deciding = this._deciding // the deciding set (5th in best-of-5)
          const target = deciding ? 15 : 25
          const won = (p) => p >= target && p - m[other + 'Points'] >= 2
          if (won(m[side + 'Points']) && !won(before)) {
            // Set win: first to 25 (15 in the deciding set) by >=2, uncapped. Fires once, on the transition.
            m[side + 'Sets'] = clamp0(m[side + 'Sets'] + 1)
            this.results.push({ left: m.leftPoints, right: m.rightPoints })
            this.lastEvent = m[side + 'Sets'] >= SETS_TO_WIN ? 'match-end' : 'set-end'
          } else if (deciding && before < DECIDER_SWITCH_AT && m[other + 'Points'] < DECIDER_SWITCH_AT && m[side + 'Points'] >= DECIDER_SWITCH_AT) {
            // Deciding set: the first team to reach 8 flags that a change of ends is DUE. The source
            // does NOT swap — the UI confirms ("Switch sides?"), blinks COURT SWITCH, then sends `swap`.
            this.lastEvent = 'switch-due'
          }
        }
        break
      }
      // For set/timeout/sub, action.value sets the number absolutely (a typed correction);
      // otherwise action.delta adjusts it. Both clamp at 0.
      case 'set':
        m[key('Sets', action.side)] = action.value != null
          ? clamp0(Number(action.value) || 0)
          : clamp0(m[key('Sets', action.side)] + (Number(action.delta) || 0))
        break
      case 'timeout':
        m[key('TO', action.side)] = action.value != null
          ? clamp0(Number(action.value) || 0)
          : clamp0(m[key('TO', action.side)] + (Number(action.delta) || 0))
        break
      case 'sub':
        m[key('Sub', action.side)] = action.value != null
          ? clamp0(Number(action.value) || 0)
          : clamp0(m[key('Sub', action.side)] + (Number(action.delta) || 0))
        break
      case 'serve':
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
      case 'next-set':
        // Start the next set: clear points AND the per-set counters (timeouts and
        // substitutions reset every set — FIVB), then switch ends. Teams change sides
        // after every set EXCEPT going into the deciding 5th (its sides are the coin toss).
        m.leftPoints = 0
        m.rightPoints = 0
        m.leftTO = 0
        m.rightTO = 0
        m.leftSub = 0
        m.rightSub = 0
        if (m.leftSets + m.rightSets !== (SETS_TO_WIN - 1) * 2) this._swap()
        break
      case 'remove-set': {
        // Undo the last recorded set: drop its result and its set point.
        const last = this.results.pop()
        if (last) {
          const w = last.left > last.right ? 'left' : (last.right > last.left ? 'right' : null)
          if (w) m[w + 'Sets'] = clamp0(m[w + 'Sets'] - 1)
        }
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

  // Swap every left<->right field, including names/colours, and flip serving.
  _swap() {
    const m = this.m
    const pairs = ['Name', 'Short', 'Color', 'Points', 'Sets', 'TO', 'Sub']
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
// Tiny self-check (mirrors test/*.mjs and the beach/basketball sources). Runs only when
// executed directly:   node src/manualSource.js
// Proves set-end / match-end fire at the right scores, that the deciding set flags a court
// switch DUE at first-to-8 WITHOUT auto-swapping, and that the between-set change of ends
// swaps (except going into the deciding set).
// --------------------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  let pass = 0, fail = 0
  const ok = (cond, label) => { if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}`) } }
  const mk = () => new ManualSource()
  const pt = (s, side) => { s.apply({ type: 'point', side, delta: 1 }); return s.lastEvent }
  const decider = (over = {}) => {
    const s = mk()
    s.apply({ type: 'set-state', state: { side_a: 'left', team_a_short: 'LLL', team_b_short: 'RRR', sets_won_a: 2, sets_won_b: 2, ...over } })
    return s
  }

  // Set win: first to 25 by >=2 counts a set (not yet the match).
  {
    const s = mk()
    for (let i = 0; i < 24; i++) pt(s, 'left') // 24-0
    ok(pt(s, 'left') === 'set-end', 'set ends at 25-0 (win by >=2)')
    ok(s.getState().sets_won_a === 1, 'the set is counted to the left team')
  }

  // Win-by-2, uncapped: no set at 25-24 or 25-25.
  {
    const s = mk()
    for (let i = 0; i < 24; i++) { pt(s, 'left'); pt(s, 'right') } // 24-24
    ok(pt(s, 'left') !== 'set-end', 'no set win at 25-24 (needs a 2-point margin)')
    ok(pt(s, 'right') !== 'set-end', 'no set win at 25-25')
    pt(s, 'left') // 26-25
    ok(pt(s, 'left') === 'set-end', 'set ends at 27-25 (uncapped, win by 2)')
  }

  // Deciding set (2-2): target 15, and the first team to reach 8 flags switch-due — no auto-swap.
  {
    const s = decider()
    ok(s._deciding === true, 'sets 2-2 is the deciding set')
    for (let i = 0; i < 7; i++) pt(s, 'left') // 7-0
    ok(s.lastEvent !== 'switch-due', 'no switch-due before 8 in the deciding set')
    ok(pt(s, 'left') === 'switch-due', 'switch-due fires when the first team reaches 8 (deciding set)')
    ok(s.getState().team_a_short === 'LLL', 'switch-due does NOT auto-swap (left team unchanged)')
  }

  // Outside the deciding set, reaching 8 flags nothing.
  {
    const s = mk()
    for (let i = 0; i < 8; i++) pt(s, 'left') // 8-0 in set 1
    ok(s.lastEvent !== 'switch-due', 'no switch-due at 8 outside the deciding set')
  }

  // Deciding set win at 15, and match-end at the 3rd set.
  {
    const s = decider()
    let last = null
    for (let i = 0; i < 15; i++) last = pt(s, 'left') // 15-0
    ok(last === 'match-end', 'winning the deciding set (to 15) ends the match')
    ok(s.getState().sets_won_a === 3, 'the winner has 3 sets')
  }

  // Change of ends between sets, but NOT going into the deciding 5th set.
  {
    const s = mk()
    s.apply({ type: 'team', side: 'left', short: 'AAA' })
    s.apply({ type: 'team', side: 'right', short: 'BBB' })
    s.apply({ type: 'set', side: 'left', delta: 1 }) // sets 1-0
    s.apply({ type: 'next-set' })
    ok(s.getState().team_a_short === 'BBB', 'ends change after a normal set (next-set swaps)')
    const d = decider({ team_a_short: 'AAA', team_b_short: 'BBB' }) // 2-2, deciding next
    d.apply({ type: 'next-set' })
    ok(d.getState().team_a_short === 'AAA', 'ends do NOT auto-swap going into the deciding set')
  }

  console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}
