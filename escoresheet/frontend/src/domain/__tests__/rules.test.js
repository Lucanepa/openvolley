import { describe, it, expect } from 'vitest'
import { getFirstServeForSet, getSetResult, isDecidingSet, scoreFromPointEvents, getSideAForSet, getLeftTeamLabelForSet } from '../rules'

describe('getSideAForSet', () => {
  it('sets 1-4: odd sets A left, even sets A right (the teams change sides after every set)', () => {
    expect(getSideAForSet(1, {})).toBe('left')
    expect(getSideAForSet(2, {})).toBe('right')
    expect(getSideAForSet(3, {})).toBe('left')
    expect(getSideAForSet(4, {})).toBe('right')
  })

  it('set 5 follows the coin toss left team (A/B), before and after the 8-point switch', () => {
    expect(getSideAForSet(5, { set5LeftTeam: 'B' })).toBe('right')
    expect(getSideAForSet(5, { set5LeftTeam: 'A' })).toBe('left')
    expect(getSideAForSet(5, { set5LeftTeam: 'B', set5CourtSwitched: true })).toBe('left')
    // set5LeftTeam only matters in set 5
    expect(getSideAForSet(3, { set5LeftTeam: 'B' })).toBe('left')
  })

  // The scorer's court (Scoreboard leftIsHome) put team A on the RIGHT in a
  // set 5 without its coin toss (the side set 4 ended on, the default the set
  // end proposes); the referee's fallback and the live state put A on the LEFT.
  it('set 5 before its coin toss is written: the side the set before ended on, not odd = left', () => {
    expect(getSideAForSet(5, {})).toBe('right')
    expect(getSideAForSet(5, { set5CourtSwitched: true })).toBe('left')
    expect(getSideAForSet(5, { setLeftTeamOverrides: { 4: 'A' } })).toBe('left')
    // best-of-3: the decider (index 5) follows set 2
    expect(getSideAForSet(5, { bestOf: 3, setLeftTeamOverrides: { 2: 'A', 4: 'B' } })).toBe('left')
    expect(getSideAForSet(5, { bestOf: '3' })).toBe('right')
  })

  it('a manual override (left team A/B) wins in sets 1-4', () => {
    expect(getSideAForSet(2, { setLeftTeamOverrides: { 2: 'A' } })).toBe('left')
    expect(getSideAForSet(1, { setLeftTeamOverrides: { 1: 'B' } })).toBe('right')
    // an empty / null entry is no override
    expect(getSideAForSet(2, { setLeftTeamOverrides: { 2: null } })).toBe('right')
  })

  // Every set 5 setup (the inline setup, its Switch sides, the corrections
  // card) writes set5LeftTeam, the field the scorer's court reads; an older
  // match's override [5] counts only without it. Both flip at 8.
  it('set 5: set5LeftTeam wins over an older override [5]; the override alone counts, flipped at 8', () => {
    expect(getSideAForSet(5, { setLeftTeamOverrides: { 5: 'B' }, set5LeftTeam: 'A' })).toBe('left')
    expect(getSideAForSet(5, { setLeftTeamOverrides: { 5: 'B' } })).toBe('right')
    expect(getSideAForSet(5, { setLeftTeamOverrides: { 5: 'B' }, set5CourtSwitched: true })).toBe('left')
  })

  it('getLeftTeamLabelForSet names the left team A/B', () => {
    expect(getLeftTeamLabelForSet(1, {})).toBe('A')
    expect(getLeftTeamLabelForSet(4, {})).toBe('B')
    expect(getLeftTeamLabelForSet(4, { setLeftTeamOverrides: { 4: 'A' } })).toBe('A')
  })
})

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

describe('scoreFromPointEvents', () => {
  const pt = (team, setIndex) => ({ type: 'point', setIndex, payload: { team } })
  it('counts point events of the set per team', () => {
    const events = [pt('home', 1), pt('away', 1), pt('home', 1), pt('home', 2), { type: 'timeout', setIndex: 1, payload: { team: 'home' } }]
    expect(scoreFromPointEvents(events, 1)).toEqual({ homePoints: 2, awayPoints: 1 })
    expect(scoreFromPointEvents(events, 2)).toEqual({ homePoints: 1, awayPoints: 0 })
  })
  it('empty set is 0-0', () => {
    expect(scoreFromPointEvents([], 3)).toEqual({ homePoints: 0, awayPoints: 0 })
  })
})
