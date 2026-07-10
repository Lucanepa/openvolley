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
          // Set win: first to 25 (15 in a deciding 5th set) with a >=2 lead, uncapped.
          // Fire only on the transition INTO a win, so extra points don't re-count it.
          const target = (m.leftSets === 2 && m.rightSets === 2) ? 15 : 25
          const won = (p) => p >= target && p - m[other + 'Points'] >= 2
          if (won(m[side + 'Points']) && !won(before)) {
            m[side + 'Sets'] = clamp0(m[side + 'Sets'] + 1)
            this.lastEvent = 'set-end'
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
        // Start the next set: clear points only (keep sets, names, colours, serving).
        m.leftPoints = 0
        m.rightPoints = 0
        break
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
  }

  start() {} // no-op; present for the uniform Source interface
  stop() {}
}
