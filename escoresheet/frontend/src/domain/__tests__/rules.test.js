import { describe, it, expect } from 'vitest'
import { getFirstServeForSet, getSetResult, isDecidingSet } from '../rules'

describe('getFirstServeForSet', () => {
  it('set 1 uses match.firstServe', () => {
    expect(getFirstServeForSet(1, { firstServe: 'home' })).toBe('home')
    expect(getFirstServeForSet(1, { firstServe: 'away' })).toBe('away')
  })
  it('defaults firstServe to home', () => {
    expect(getFirstServeForSet(1, {})).toBe('home')
  })
  it('alternates: odd sets same as set 1, even sets opposite', () => {
    const m = { firstServe: 'home' }
    expect(getFirstServeForSet(1, m)).toBe('home')
    expect(getFirstServeForSet(2, m)).toBe('away')
    expect(getFirstServeForSet(3, m)).toBe('home')
    expect(getFirstServeForSet(4, m)).toBe('away')
  })
  it('alternates from an away first serve', () => {
    const m = { firstServe: 'away' }
    expect(getFirstServeForSet(2, m)).toBe('home')
    expect(getFirstServeForSet(3, m)).toBe('away')
  })
  it('set 5 uses the separate coin toss (set5FirstServe A/B -> coin-toss keys)', () => {
    expect(getFirstServeForSet(5, { set5FirstServe: 'A', coinTossTeamA: 'home', coinTossTeamB: 'away' })).toBe('home')
    expect(getFirstServeForSet(5, { set5FirstServe: 'B', coinTossTeamA: 'home', coinTossTeamB: 'away' })).toBe('away')
    // custom keys
    expect(getFirstServeForSet(5, { set5FirstServe: 'A', coinTossTeamA: 'away', coinTossTeamB: 'home' })).toBe('away')
  })
  it('set 5 without set5FirstServe falls back to firstServe', () => {
    expect(getFirstServeForSet(5, { firstServe: 'away' })).toBe('away')
  })
})

describe('getSetResult', () => {
  it('no winner mid-set', () => {
    expect(getSetResult(10, 8, 1)).toEqual({ winner: null, isSetWon: false, pointsToWin: 25, isMatchEnd: false })
  })
  it('home wins a normal set at 25 with a 2-point margin', () => {
    expect(getSetResult(25, 23, 1)).toMatchObject({ winner: 'home', isSetWon: true, pointsToWin: 25 })
  })
  it('no win at 25-24 (needs 2-point margin)', () => {
    expect(getSetResult(25, 24, 2)).toMatchObject({ winner: null, isSetWon: false })
  })
  it('deuce resolves at 27-25', () => {
    expect(getSetResult(27, 25, 3)).toMatchObject({ winner: 'home', isSetWon: true })
    expect(getSetResult(25, 27, 3)).toMatchObject({ winner: 'away', isSetWon: true })
  })
  it('5th set is to 15', () => {
    expect(getSetResult(15, 13, 5)).toMatchObject({ winner: 'home', isSetWon: true, pointsToWin: 15 })
    expect(getSetResult(15, 14, 5)).toMatchObject({ winner: null, pointsToWin: 15 })
    expect(getSetResult(16, 14, 5)).toMatchObject({ winner: 'home', isSetWon: true })
  })
  it('handles missing/zero points safely', () => {
    expect(getSetResult(undefined, undefined, 1)).toMatchObject({ winner: null })
  })
})

describe('isDecidingSet + bestOf-aware match end', () => {
  it('the deciding set is index 5 in both formats', () => {
    expect(isDecidingSet(5)).toBe(true)
    expect(isDecidingSet(1)).toBe(false)
    expect(isDecidingSet(3)).toBe(false)
  })

  it('best-of-5: match ends when the winner reaches their 3rd set', () => {
    // home had 2 sets, wins set 4 -> match end
    expect(getSetResult(25, 20, 4, { bestOf: 5, homeSetsWon: 2, awaySetsWon: 1 }).isMatchEnd).toBe(true)
    // home had 1 set, wins set 3 -> not yet
    expect(getSetResult(25, 20, 3, { bestOf: 5, homeSetsWon: 1, awaySetsWon: 1 }).isMatchEnd).toBe(false)
    // deciding set to 15 wins the match
    expect(getSetResult(15, 12, 5, { bestOf: 5, homeSetsWon: 2, awaySetsWon: 2 }).isMatchEnd).toBe(true)
  })

  it('best-of-3: match ends when the winner reaches their 2nd set', () => {
    // away had 1 set, wins set 2 -> match end
    expect(getSetResult(20, 25, 2, { bestOf: 3, homeSetsWon: 0, awaySetsWon: 1 }).isMatchEnd).toBe(true)
    // 1-1 -> the tiebreak is index 5, to 15, and wins the match
    expect(getSetResult(15, 10, 5, { bestOf: 3, homeSetsWon: 1, awaySetsWon: 1 })).toMatchObject({ winner: 'home', pointsToWin: 15, isMatchEnd: true })
    // winning set 1 never ends a bo3 match
    expect(getSetResult(25, 10, 1, { bestOf: 3, homeSetsWon: 0, awaySetsWon: 0 }).isMatchEnd).toBe(false)
  })

  it('no match end without a set winner', () => {
    expect(getSetResult(20, 18, 1, { bestOf: 5, homeSetsWon: 2, awaySetsWon: 2 }).isMatchEnd).toBe(false)
  })
})
