import { describe, it, expect } from 'vitest'
import { rallyStatusOf, currentSetOf, isFirstRallyOf, startingLineupsIn, sentOffOnCourt, rallyStartOfPoint } from '../rally'

const ev = (type, seq, setIndex = 1, ts = '2026-10-08T10:00:00.000Z') => ({ type, seq, setIndex, ts })

describe('rallyStatusOf', () => {
  it('is in play only when the set\'s last event is a rally_start', () => {
    expect(rallyStatusOf([ev('set_start', 1), ev('rally_start', 2)], 1)).toBe('in_play')
    expect(rallyStatusOf([ev('rally_start', 2), ev('point', 3)], 1)).toBe('idle')
    expect(rallyStatusOf([ev('rally_start', 2), ev('replay', 3)], 1)).toBe('idle')
    expect(rallyStatusOf([ev('point', 3), ev('lineup', 3.1)], 1)).toBe('idle')
    expect(rallyStatusOf([ev('set_start', 1)], 1)).toBe('idle')
    expect(rallyStatusOf([], 1)).toBe('idle')
  })

  // a remark saved while the ball is in play (or a bench injury) is recorded
  // beside the play: it ended the rally (Start set came back at a set's
  // first rally, the Point buttons went away)
  it('a remark or a bench injury does not end the rally in play', () => {
    expect(rallyStatusOf([ev('set_start', 1), ev('rally_start', 2), ev('remark', 3)], 1)).toBe('in_play')
    expect(rallyStatusOf([ev('rally_start', 2), ev('bench_injury', 3), ev('remark', 4)], 1)).toBe('in_play')
    expect(rallyStatusOf([ev('rally_start', 2), ev('point', 3), ev('remark', 4)], 1)).toBe('idle')
    expect(rallyStatusOf([ev('remark', 4)], 1)).toBe('idle')
  })

  it('goes by seq, not by the order of the rows', () => {
    expect(rallyStatusOf([ev('point', 5), ev('rally_start', 4)], 1)).toBe('idle')
    expect(rallyStatusOf([ev('rally_start', 6), ev('point', 5)], 1)).toBe('in_play')
  })

  it('looks at the given set only', () => {
    const events = [ev('rally_start', 9, 1), ev('point', 10, 2)]
    expect(rallyStatusOf(events, 1)).toBe('in_play')
    expect(rallyStatusOf(events, 2)).toBe('idle')
  })

  it('goes by time for events without seq', () => {
    const events = [ev('point', 0, 1, '2026-10-08T10:00:02.000Z'), ev('rally_start', 0, 1, '2026-10-08T10:00:01.000Z')]
    expect(rallyStatusOf(events, 1)).toBe('idle')
  })
})

describe('currentSetOf', () => {
  it('takes the newest row per index, then the first set not finished', () => {
    const sets = [
      { id: 1, index: 1, finished: true },
      { id: 2, index: 2, finished: false },
      { id: 5, index: 2, finished: true },
      { id: 6, index: 3, finished: false }
    ]
    expect(currentSetOf(sets).id).toBe(6)
    expect(currentSetOf([{ id: 1, index: 1, finished: true }]).id).toBe(1)
    expect(currentSetOf([])).toBe(null)
  })
})

describe('isFirstRallyOf', () => {
  const pt = (seq, payload = {}) => ({ type: 'point', seq, setIndex: 1, payload: { team: 'home', ...payload } })

  it('until the set has a set_start or a rally_start', () => {
    expect(isFirstRallyOf([], 1)).toBe(true)
    expect(isFirstRallyOf([ev('lineup', 1), ev('lineup', 2)], 1)).toBe(true)
    expect(isFirstRallyOf([ev('set_start', 3)], 1)).toBe(false)
    expect(isFirstRallyOf([ev('rally_start', 3)], 1)).toBe(false)
    // another set's start does not count
    expect(isFirstRallyOf([ev('set_start', 3, 1)], 2)).toBe(true)
  })

  it('a penalty point before the first serve does not end it; a rally\'s point (older sets without set_start) does', () => {
    expect(isFirstRallyOf([ev('sanction', 3), pt(4, { penaltySeq: 3 })], 1)).toBe(true)
    expect(isFirstRallyOf([pt(4)], 1)).toBe(false)
  })
})

describe('startingLineupsIn', () => {
  const lineup = (team, setIndex = 1, isInitial = true) => ({ type: 'lineup', seq: 1, setIndex, payload: { team, lineup: {}, isInitial } })
  it('both teams\' starting line-ups of the set', () => {
    expect(startingLineupsIn([lineup('home')], 1)).toBe(false)
    expect(startingLineupsIn([lineup('home'), lineup('away')], 1)).toBe(true)
    expect(startingLineupsIn([lineup('home'), lineup('away', 2)], 1)).toBe(false)
    expect(startingLineupsIn([lineup('home'), lineup('away', 1, false)], 1)).toBe(false)
  })
})

describe('sentOffOnCourt (Start rally, and continuous play\'s point that opens its rally)', () => {
  const lineup = (team, seq, l, setIndex = 2) => ({ type: 'lineup', seq, setIndex, payload: { team, lineup: l } })
  const sanction = (team, seq, type, playerNumber, setIndex = 2) => ({ type: 'sanction', seq, setIndex, payload: { team, type, playerNumber } })
  const L = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }

  it('a player on court expelled in this set, or disqualified in any set', () => {
    expect(sentOffOnCourt([lineup('home', 1, L), sanction('home', 2, 'expulsion', 3)], 2)).toEqual({ team: 'home', number: '3' })
    expect(sentOffOnCourt([lineup('away', 1, L), sanction('away', 2, 'disqualification', 5, 1)], 2)).toEqual({ team: 'away', number: '5' })
  })

  it('not an expulsion of an earlier set, a player on the bench, or the other team\'s number', () => {
    expect(sentOffOnCourt([lineup('home', 1, L), sanction('home', 2, 'expulsion', 3, 1)], 2)).toBeNull()
    expect(sentOffOnCourt([lineup('home', 1, L), sanction('home', 2, 'expulsion', 9)], 2)).toBeNull()
    expect(sentOffOnCourt([lineup('home', 1, L), sanction('away', 2, 'expulsion', 3)], 2)).toBeNull()
    expect(sentOffOnCourt([], 2)).toBeNull()
    expect(sentOffOnCourt(null, 2)).toBeNull()
  })

  it('the team\'s latest line-up of the set is the court (his substitution recorded: none)', () => {
    const events = [lineup('home', 1, L), sanction('home', 2, 'expulsion', 3), lineup('home', 3.1, { ...L, III: '9' })]
    expect(sentOffOnCourt(events, 2)).toBeNull()
    // court players stored as { number }
    expect(sentOffOnCourt([lineup('home', 1, { ...L, III: { number: 3 } }), sanction('home', 2, 'expulsion', 3)], 2)).toEqual({ team: 'home', number: 3 })
  })
})

describe('rallyStartOfPoint (Undo takes a point back with its own rally start only)', () => {
  const point = (seq, extra = {}) => ({ type: 'point', seq, setIndex: 1, payload: { team: 'home', ...extra } })

  it('the rally_start right before the point (continuous play writes it so)', () => {
    const start = ev('rally_start', 6)
    const p = point(7)
    expect(rallyStartOfPoint([ev('rally_start', 2), point(3), start, p], p)).toBe(start)
    // a remark, a time-out or a libero replacement between them: still its own
    const withRemark = [start, ev('remark', 6.5), p]
    expect(rallyStartOfPoint(withRemark, p)).toBe(start)
  })

  it('none when another rally ended since (a point, a replay): an older rally\'s start stays', () => {
    const p = point(9)
    // a set scored on another device: its rally starts stayed there
    expect(rallyStartOfPoint([ev('rally_start', 2), point(3), ev('lineup', 3.1), p], p)).toBeNull()
    // continuous play: a replay recorded between rallies, then this point with no start of its own
    expect(rallyStartOfPoint([ev('rally_start', 2), point(3), ev('replay', 4), p], p)).toBeNull()
  })

  it('a penalty point given during the rally does not end it', () => {
    const start = ev('rally_start', 2)
    const p = point(9)
    expect(rallyStartOfPoint([start, ev('sanction', 3), point(4, { penaltySeq: 3 }), p], p)).toBe(start)
  })

  it('the point\'s set only; nothing for anything but a point', () => {
    const p = point(9)
    expect(rallyStartOfPoint([{ ...ev('rally_start', 8), setIndex: 2 }, p], p)).toBeNull()
    expect(rallyStartOfPoint([ev('rally_start', 8)], ev('timeout', 9))).toBeNull()
    expect(rallyStartOfPoint([], null)).toBeNull()
  })
})
