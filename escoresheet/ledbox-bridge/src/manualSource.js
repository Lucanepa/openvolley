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

export class ManualSource extends EventEmitter {
  constructor() {
    super()
    this.lastEvent = null // transient: the notable event from the last apply() (e.g. 'set-end')
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
        const d = Number(action.delta) || 0
        m[side + 'Points'] = clamp0(before + d)
        if (d > 0) {
          // Rally scoring: the side that wins the point serves next.
          m.serving = side
          const deciding = m.leftSets === 2 && m.rightSets === 2 // the 5th (deciding) set
          const target = deciding ? 15 : 25
          const won = (p) => p >= target && p - m[other + 'Points'] >= 2
          if (won(m[side + 'Points']) && !won(before)) {
            // Set win: first to 25 (15 in the 5th) by >=2, uncapped. Fires once, on the transition.
            m[side + 'Sets'] = clamp0(m[side + 'Sets'] + 1)
            this.results.push({ left: m.leftPoints, right: m.rightPoints })
            this.lastEvent = m[side + 'Sets'] >= 3 ? 'match-end' : 'set-end'
          } else if (deciding && before < 8 && m[other + 'Points'] < 8 && m[side + 'Points'] >= 8) {
            // Deciding set: the first team to reach 8 triggers a side switch.
            this.lastEvent = 'switch-8'
          }
        }
        break
      }
      case 'set':
        m[key('Sets', action.side)] = clamp0(m[key('Sets', action.side)] + (Number(action.delta) || 0))
        break
      case 'timeout':
        m[key('TO', action.side)] = clamp0(m[key('TO', action.side)] + (Number(action.delta) || 0))
        break
      case 'sub':
        m[key('Sub', action.side)] = clamp0(m[key('Sub', action.side)] + (Number(action.delta) || 0))
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
        if (m.leftSets + m.rightSets !== 4) this._swap()
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
