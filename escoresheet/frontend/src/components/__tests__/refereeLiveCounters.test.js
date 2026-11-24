// The referee's TO / SUB counters from the scorer's live state. SUB shows
// every substitution of the set, exceptional ones included (owner
// 22.11.2026: "SUB shall count exceptional substitutions"), as the scorer's
// SUB box and the bench tablet; its colour follows the regular ones, the 6
// of the rule (FIVB 15.6; an exceptional substitution is beyond them).
import { describe, it, expect } from 'vitest'
import { liveStateCounters, eventCounters, subCounterTone } from '../referee/liveCounters.js'

// Scoreboard captureFullStateSnapshot subsA / subsB entries
const sub = (playerIn, playerOut, exceptional = false) => ({ playerIn, playerOut, position: 'I', exceptional, ts: '2026-11-21T22:20:00.000Z' })
const sixRegular = [sub(8, 1), sub(9, 2), sub(10, 3), sub(1, 8), sub(2, 9), sub(3, 10)]

describe('liveStateCounters', () => {
  it('counts exceptional substitutions in SUB: 6 regular + 1 exceptional is 7 (6 regular)', () => {
    const live = { subs_a: [...sixRegular, sub(4, 11, true)], subs_b: [sub(7, 5)], timeouts_a: [{}, {}], timeouts_b: [{}] }
    expect(liveStateCounters(live, true)).toEqual({
      home: { timeouts: 2, substitutions: 7, regularSubstitutions: 6 },
      away: { timeouts: 1, substitutions: 1, regularSubstitutions: 1 }
    })
  })

  it('an exceptional substitution alone counts one, no regular one', () => {
    expect(liveStateCounters({ subs_b: [sub(8, 7, true)] }, true).away).toEqual({ timeouts: 0, substitutions: 1, regularSubstitutions: 0 })
  })

  it('maps Team A / B to home / away by the live state\'s Team A', () => {
    const live = { subs_a: [sub(8, 1), sub(9, 2, true)], subs_b: [sub(7, 5), sub(8, 6), sub(9, 4)], timeouts_a: [{}], timeouts_b: [] }
    expect(liveStateCounters(live, false)).toEqual({
      home: { timeouts: 0, substitutions: 3, regularSubstitutions: 3 },
      away: { timeouts: 1, substitutions: 2, regularSubstitutions: 1 }
    })
  })

  it('an older scorer\'s numbers are taken as they are', () => {
    expect(liveStateCounters({ subs_a: 4, subs_b: 0, timeouts_a: 1, timeouts_b: 2 }, true)).toEqual({
      home: { timeouts: 1, substitutions: 4, regularSubstitutions: 4 },
      away: { timeouts: 2, substitutions: 0, regularSubstitutions: 0 }
    })
  })

  it('without the lists (no substitution yet: null; a summary: left out) the public count, else 0', () => {
    expect(liveStateCounters({ subs_a: null, subs_b: null, subs_count_a: 0, subs_count_b: 0 }, true).home.substitutions).toBe(0)
    expect(liveStateCounters({ subs_count_a: 7, subs_count_b: 2 }, true)).toEqual({
      home: { timeouts: 0, substitutions: 7, regularSubstitutions: 7 },
      away: { timeouts: 0, substitutions: 2, regularSubstitutions: 2 }
    })
    expect(liveStateCounters(null, true)).toEqual({
      home: { timeouts: 0, substitutions: 0, regularSubstitutions: 0 },
      away: { timeouts: 0, substitutions: 0, regularSubstitutions: 0 }
    })
  })
})

describe('eventCounters (relay bundle / local log)', () => {
  const ev = (type, team, extra = {}) => ({ type, setIndex: 1, payload: { team, ...extra } })
  it('all substitutions, the regular ones apart, the time-outs', () => {
    const events = [
      ...Array.from({ length: 6 }, () => ev('substitution', 'home')),
      ev('substitution', 'home', { isExceptional: true, isExpelled: true }),
      ev('timeout', 'home'),
      ev('substitution', 'away', { isExceptional: true })
    ]
    expect(eventCounters(events)).toEqual({
      home: { timeouts: 1, substitutions: 7, regularSubstitutions: 6 },
      away: { timeouts: 0, substitutions: 1, regularSubstitutions: 0 }
    })
  })
})

describe('subCounterTone: the colour from the regular substitutions', () => {
  it('red at 6 regular (7 shown with an exceptional one), amber at 5, none below', () => {
    expect(subCounterTone({ substitutions: 7, regularSubstitutions: 6 })).toBe('max')
    // 5 regular + 1 exceptional: 6 shown, one regular still possible
    expect(subCounterTone({ substitutions: 6, regularSubstitutions: 5 })).toBe('near')
    expect(subCounterTone({ substitutions: 2, regularSubstitutions: 1 })).toBe(null)
    // without the regular count (an older shape): the shown one
    expect(subCounterTone({ substitutions: 6 })).toBe('max')
  })
})
