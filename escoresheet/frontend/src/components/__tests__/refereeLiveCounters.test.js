// The referee's TO / SUB counters from the scorer's live state: an
// exceptional substitution (FIVB 15.7) is beyond the 6 of a set, as on the
// scorer's SUB box and the bench tablet. Full-match test 21.11.2026: the
// referee showed SUB 7 where the scorer and the bench showed 6.
import { describe, it, expect } from 'vitest'
import { liveStateCounters } from '../referee/liveCounters.js'

// Scoreboard captureFullStateSnapshot subsA / subsB entries
const sub = (playerIn, playerOut, exceptional = false) => ({ playerIn, playerOut, position: 'I', exceptional, ts: '2026-11-21T22:20:00.000Z' })
const sixRegular = [sub(8, 1), sub(9, 2), sub(10, 3), sub(1, 8), sub(2, 9), sub(3, 10)]

describe('liveStateCounters', () => {
  it('leaves exceptional substitutions out of SUB: 6 regular + 1 exceptional is 6', () => {
    const live = { subs_a: [...sixRegular, sub(4, 11, true)], subs_b: [sub(7, 5)], timeouts_a: [{}, {}], timeouts_b: [{}] }
    expect(liveStateCounters(live, true)).toEqual({
      home: { timeouts: 2, substitutions: 6 },
      away: { timeouts: 1, substitutions: 1 }
    })
  })

  it('an exceptional substitution alone counts none', () => {
    expect(liveStateCounters({ subs_b: [sub(8, 7, true)] }, true).away.substitutions).toBe(0)
  })

  it('maps Team A / B to home / away by the live state\'s Team A', () => {
    const live = { subs_a: [sub(8, 1), sub(9, 2, true)], subs_b: [sub(7, 5), sub(8, 6), sub(9, 4)], timeouts_a: [{}], timeouts_b: [] }
    expect(liveStateCounters(live, false)).toEqual({
      home: { timeouts: 0, substitutions: 3 },
      away: { timeouts: 1, substitutions: 1 }
    })
  })

  it('an older scorer\'s numbers are taken as they are', () => {
    expect(liveStateCounters({ subs_a: 4, subs_b: 0, timeouts_a: 1, timeouts_b: 2 }, true)).toEqual({
      home: { timeouts: 1, substitutions: 4 },
      away: { timeouts: 2, substitutions: 0 }
    })
  })

  it('without the lists (no substitution yet: null; a summary: left out) the public regular count, else 0', () => {
    expect(liveStateCounters({ subs_a: null, subs_b: null, subs_count_a: 0, subs_count_b: 0 }, true).home.substitutions).toBe(0)
    expect(liveStateCounters({ subs_count_a: 6, subs_count_b: 2 }, true)).toEqual({
      home: { timeouts: 0, substitutions: 6 },
      away: { timeouts: 0, substitutions: 2 }
    })
    expect(liveStateCounters(null, true)).toEqual({
      home: { timeouts: 0, substitutions: 0 },
      away: { timeouts: 0, substitutions: 0 }
    })
  })
})
