// The decision change works on a rally, never on a penalty's point (audit
// LOG-06). Right after a delay penalty (or a misconduct penalty) the set's
// last point is the point the sanction gave (payload.penaltySeq). The dialog
// took it as "the last point": swap gave the sanctioned team the point and
// the serve, replay deleted the penalty's point and left the sanction. Now
// the set's last RALLY point is the one; while a sanction or a penalty's
// point follows it, the decision change is shown but not offered ("Undo the
// sanction first": Undo takes a penalty back with its point).
import { describe, it, expect } from 'vitest'
import { decisionPointOf, decisionChangeBlock, isPenaltyPoint } from '../decisionChange'
import { decisionChangeTakeBack } from '../interruptionRequests'

let id = 1
const ev = (type, payload, seq, setIndex = 1) => ({ id: id++, matchId: 1, setIndex, type, payload, seq, ts: new Date(1_800_000_000_000 + seq * 1000).toISOString() })
const start = () => [
  ev('lineup', { team: 'home', lineup: {}, isInitial: true }, 1),
  ev('lineup', { team: 'away', lineup: {}, isInitial: true }, 2),
  ev('set_start', {}, 3)
]

// home wins rally 1 (1:0); away delays twice: a warning, then a penalty
// that gives home the point and the serve (2:0)
function afterDelayPenalty() {
  const events = [...start(), ev('rally_start', {}, 4), ev('point', { team: 'home' }, 5)]
  events.push(ev('sanction', { team: 'away', type: 'delay_warning' }, 6))
  events.push(ev('sanction', { team: 'away', type: 'delay_penalty' }, 7))
  events.push(ev('point', { team: 'home', penaltySeq: 7 }, 8))
  return events
}

describe('decisionPointOf: the rally point a decision change changes', () => {
  it('the set\'s last rally point, also past its own rows (N.x) and a remark recorded since', () => {
    const events = [...start(), ev('rally_start', {}, 4), ev('point', { team: 'home' }, 5), ev('rally_start', {}, 6), ev('point', { team: 'away' }, 7), ev('lineup', { team: 'away', lineup: {} }, 7.1)]
    expect(decisionPointOf(events, 1)?.seq).toBe(7)
    expect(decisionPointOf([...events, ev('remark', { text: 'x' }, 8)], 1)?.seq).toBe(7)
    expect(decisionPointOf(events, 2)).toBeNull()
  })

  it('never a penalty\'s point, nor its rotation row', () => {
    const events = afterDelayPenalty()
    expect(isPenaltyPoint(events[events.length - 1])).toBe(true)
    expect(decisionPointOf(events, 1)).toBeNull()
    // a side-out of the penalty: the penalty point wrote the rotation (8.1)
    expect(decisionPointOf([...events, ev('lineup', { team: 'home', lineup: {} }, 8.1)], 1)).toBeNull()
  })

  it('a penalty before the set\'s first rally: nothing to change', () => {
    const events = [...start(), ev('sanction', { team: 'away', type: 'delay_penalty' }, 4), ev('point', { team: 'home', penaltySeq: 4 }, 5)]
    expect(decisionPointOf(events, 1)).toBeNull()
    expect(decisionChangeBlock(events, 1)).toBeNull()
  })
})

describe('decisionChangeBlock: why the decision change waits', () => {
  it('a penalty point after the last rally: "sanction"', () => {
    expect(decisionChangeBlock(afterDelayPenalty(), 1)).toBe('sanction')
  })

  it('a sanction without a point after it (a warning, a delay warning): "sanction"', () => {
    const events = [...start(), ev('rally_start', {}, 4), ev('point', { team: 'home' }, 5), ev('sanction', { team: 'away', type: 'warning', playerType: 'player', playerNumber: 12 }, 6)]
    expect(decisionPointOf(events, 1)).toBeNull()
    expect(decisionChangeBlock(events, 1)).toBe('sanction')
  })

  it('nothing after the rally, or only time-outs: no block (the decision change is offered)', () => {
    const plain = [...start(), ev('rally_start', {}, 4), ev('point', { team: 'home' }, 5)]
    expect(decisionChangeBlock(plain, 1)).toBeNull()
    expect(decisionChangeBlock([...plain, ev('timeout', { team: 'away' }, 6)], 1)).toBeNull()
    // a sanction of an earlier rally does not count
    const earlier = [...start(), ev('sanction', { team: 'away', type: 'delay_warning' }, 4), ev('rally_start', {}, 5), ev('point', { team: 'home' }, 6)]
    expect(decisionChangeBlock(earlier, 1)).toBeNull()
    expect(decisionPointOf(earlier, 1)?.seq).toBe(6)
  })

  it('the take-back of row 19 is never offered on a penalty point (time-outs after it)', () => {
    const events = [...afterDelayPenalty(), ev('timeout', { team: 'away' }, 9)]
    expect(decisionChangeTakeBack(events, 1, {})).toBeNull()
    expect(decisionChangeBlock(events, 1)).toBe('sanction')
    // control: the same time-out after a rally point is taken back with it
    const rally = [...start(), ev('rally_start', {}, 4), ev('point', { team: 'home' }, 5), ev('timeout', { team: 'away' }, 6)]
    expect(decisionChangeTakeBack(rally, 1, {})?.point.seq).toBe(5)
  })
})
