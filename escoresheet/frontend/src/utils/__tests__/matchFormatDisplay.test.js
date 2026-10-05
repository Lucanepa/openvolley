import { describe, it, expect } from 'vitest'
import { displaySetNumber, setsWonWithFinishedSet, getNextSetIndex, isMatchFinished } from '../matchFormat'

describe('displaySetNumber', () => {
  it('shows a best-of-3 decider (index 5) as set 3', () => {
    expect(displaySetNumber(5, 3)).toBe(3)
    expect(displaySetNumber(5, '3')).toBe(3)
    expect(displaySetNumber(getNextSetIndex(2, 1, 1, 3), 3)).toBe(3)
  })

  it('leaves every other index as it is', () => {
    expect(displaySetNumber(5, 5)).toBe(5)
    expect(displaySetNumber(5)).toBe(5)
    expect(displaySetNumber(5, undefined)).toBe(5)
    for (const i of [1, 2, 3, 4]) {
      expect(displaySetNumber(i, 3)).toBe(i)
      expect(displaySetNumber(i, 5)).toBe(i)
    }
  })
})

describe('setsWonWithFinishedSet (live-state push at a set end / match end)', () => {
  // Snapshot of the last point: set counts from before the set
  const snap = (extra) => ({ teamAKey: 'home', setScoreA: 1, setScoreB: 0, pointsA: 18, pointsB: 25, ...extra })

  it('counts a set Team B won (from the event winner or the points)', () => {
    expect(setsWonWithFinishedSet(snap(), 'away', true)).toEqual({ a: 1, b: 1 })
    expect(setsWonWithFinishedSet(snap(), undefined, true)).toEqual({ a: 1, b: 1 })
    // Team A = away: B is home
    expect(setsWonWithFinishedSet(snap({ teamAKey: 'away' }), 'home', true)).toEqual({ a: 1, b: 1 })
    expect(setsWonWithFinishedSet(snap({ teamAKey: 'away' }), undefined, true)).toEqual({ a: 1, b: 1 })
  })

  it('counts a set Team A won', () => {
    expect(setsWonWithFinishedSet(snap({ pointsA: 25, pointsB: 2, setScoreA: 0 }), 'home', true)).toEqual({ a: 1, b: 0 })
    expect(setsWonWithFinishedSet(snap({ teamAKey: 'away', pointsA: 25, pointsB: 2, setScoreA: 0 }), undefined, true)).toEqual({ a: 1, b: 0 })
  })

  it('the e2e match 991303 (best of 3, B wins sets 2 and 3) ends 1:2, so it is finished', () => {
    const afterSet2 = setsWonWithFinishedSet(snap(), 'away', true)
    expect(afterSet2).toEqual({ a: 1, b: 1 })
    expect(getNextSetIndex(2, afterSet2.a, afterSet2.b, 3)).toBe(5)
    const decider = setsWonWithFinishedSet({ teamAKey: 'home', setScoreA: 1, setScoreB: 1, pointsA: 10, pointsB: 15 }, 'away', true)
    expect(decider).toEqual({ a: 1, b: 2 })
    expect(isMatchFinished(decider.a, decider.b, 3)).toBe(true)
  })

  it('other pushes keep the snapshot counts; a tie counts nothing', () => {
    expect(setsWonWithFinishedSet(snap(), 'away', false)).toEqual({ a: 1, b: 0 })
    expect(setsWonWithFinishedSet(snap({ pointsA: 3, pointsB: 3 }), undefined, true)).toEqual({ a: 1, b: 0 })
    expect(setsWonWithFinishedSet(null, undefined, true)).toEqual({ a: 0, b: 0 })
  })
})
