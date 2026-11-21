// The referee between two sets (referee/setBreak.js): the next set, its
// sides and its first server. Full-match test 21.11.2026: the scorer's
// bundle after a set end has no row for the next set yet (and often no
// other bundle follows before the next line-ups); the referee kept the
// previous set's sides and gave the SERVE box to the team that had served
// last.
import { describe, it, expect } from 'vitest'
import { refereeSetBreak, pendingSetIndex, decidingTossDone, setsWonOf } from '../referee/setBreak.js'

// Team A = home, home serves first in set 1 (A on the left in set 1)
const match = { bestOf: 5, coinTossTeamA: 'home', coinTossTeamB: 'away', firstServe: 'home' }
const fin = (index, homePoints, awayPoints) => ({ index, homePoints, awayPoints, finished: true })
const open = (index, homePoints = 0, awayPoints = 0) => ({ index, homePoints, awayPoints, finished: false })
const point = (setIndex, team, seq) => ({ type: 'point', setIndex, seq, payload: { team } })
// the scorer's live state pushed with the set end (Scoreboard syncLiveStateToSupabase 'set_end')
const setEndPush = (nextSet, sideA, servingSide) => ({
  current_set: nextSet, side_a: sideA, serving_team: servingSide, set_interval_active: true,
  points_a: 0, points_b: 0, last_event_type: 'set_end', match_status: 'interval'
})
// the last point's push (older than the set end)
const pointPush = (set, sideA, servingSide) => ({
  current_set: set, side_a: sideA, serving_team: servingSide, set_interval_active: false,
  points_a: 25, points_b: 0, last_event_type: 'point', match_status: 'in_progress'
})

describe('pendingSetIndex / setsWonOf', () => {
  it('the set after the last finished one while no set row is open', () => {
    expect(pendingSetIndex([fin(1, 25, 0)], 5)).toBe(2)
    expect(pendingSetIndex([fin(1, 25, 0), fin(2, 20, 25), fin(3, 25, 23)], 5)).toBe(4)
  })
  it('a best-of-3 at 1:1 goes on with set 5 (the deciding set slot)', () => {
    expect(pendingSetIndex([fin(1, 25, 0), fin(2, 20, 25)], 3)).toBe(5)
  })
  it('none while a set is open, before any set and after the match', () => {
    expect(pendingSetIndex([fin(1, 25, 0), open(2)], 5)).toBe(null)
    expect(pendingSetIndex([], 5)).toBe(null)
    expect(pendingSetIndex([fin(1, 25, 0), fin(2, 25, 20), fin(3, 25, 10)], 5)).toBe(null)
    expect(pendingSetIndex([fin(1, 25, 0), fin(2, 25, 20)], 3)).toBe(null)
  })
  it('counts the sets won from the finished rows', () => {
    expect(setsWonOf([fin(1, 25, 0), fin(2, 20, 25), open(3, 4, 4)])).toEqual({ home: 1, away: 1 })
  })
})

describe('refereeSetBreak', () => {
  it('a set under way, before set 1 and after the match: no break', () => {
    expect(refereeSetBreak({ sets: [open(1, 3, 2)], currentSet: open(1, 3, 2), events: [point(1, 'home', 1)], match })).toBe(null)
    expect(refereeSetBreak({ sets: [open(1)], currentSet: open(1), events: [], match })).toBe(null)
    const done = [fin(1, 25, 0), fin(2, 25, 20), fin(3, 25, 10)]
    expect(refereeSetBreak({ sets: done, currentSet: null, events: [], match })).toBe(null)
  })

  it('set 1 ended, set 2 not in the bundle yet: set 2, its sides (B left) and its server (away), from the set end push', () => {
    const b = refereeSetBreak({
      sets: [fin(1, 25, 0)], currentSet: null, events: [point(1, 'home', 1)], match,
      liveState: setEndPush(2, 'right', 'left'), teamAKey: 'home', liveTeamAKey: 'home'
    })
    expect(b).toEqual({ setIndex: 2, betweenSets: true, homeLeft: false, servingTeam: 'away' })
  })

  it('the same with only the last point\'s live state (older, set 1): the scorer\'s rule, not set 1\'s sides', () => {
    const b = refereeSetBreak({
      sets: [fin(1, 25, 0)], currentSet: null, events: [point(1, 'home', 1)], match,
      liveState: pointPush(1, 'left', 'left'), teamAKey: 'home'
    })
    expect(b).toEqual({ setIndex: 2, betweenSets: true, homeLeft: false, servingTeam: 'away' })
  })

  it('set 2 -> 3: A back on the left, set 1\'s server serves again', () => {
    const b = refereeSetBreak({
      sets: [fin(1, 25, 0), fin(2, 20, 25)], currentSet: null, events: [], match, liveState: null
    })
    expect(b).toEqual({ setIndex: 3, betweenSets: true, homeLeft: true, servingTeam: 'home' })
  })

  it('the next set\'s row is there but not started: the same set, its sides and server', () => {
    const b = refereeSetBreak({
      sets: [fin(1, 25, 0), open(2)], currentSet: open(2), events: [point(1, 'home', 1)], match,
      liveState: setEndPush(2, 'right', 'left'), liveTeamAKey: 'home'
    })
    expect(b).toEqual({ setIndex: 2, betweenSets: true, homeLeft: false, servingTeam: 'away' })
  })

  it('a penalty point before the first serve of the next set gives that team the serve, and does not end the break', () => {
    const penalty = { type: 'point', setIndex: 2, seq: 5, payload: { team: 'home', penaltySeq: 4 } }
    const b = refereeSetBreak({ sets: [fin(1, 25, 0), open(2, 1, 0)], currentSet: open(2, 1, 0), events: [point(1, 'home', 1), penalty], match })
    expect(b?.setIndex).toBe(2)
    expect(b?.servingTeam).toBe('home')
  })

  it('the live state\'s Team A wins over the match\'s for its side_a (a Swap A/B the row does not know)', () => {
    const b = refereeSetBreak({
      sets: [fin(1, 25, 0)], currentSet: null, events: [], match,
      liveState: setEndPush(2, 'right', 'left'), teamAKey: 'home', liveTeamAKey: 'away'
    })
    // the row's Team A (away) on the right: home on the left
    expect(b.homeLeft).toBe(true)
  })

  it('only the live state\'s break flag (a bundle not yet past the set): its set', () => {
    const b = refereeSetBreak({
      sets: [open(2, 24, 20)], currentSet: open(2, 24, 20), events: [point(2, 'home', 9)], match,
      liveState: setEndPush(3, 'left', 'left'), liveTeamAKey: 'home'
    })
    expect(b).toEqual({ setIndex: 3, betweenSets: false, homeLeft: true, servingTeam: 'home' })
  })

  it('a view built from the live state alone serves from its serving_team', () => {
    const b = refereeSetBreak({
      sets: [open(2)], currentSet: open(2), events: [], match: { coinTossTeamA: 'home' },
      liveState: setEndPush(2, 'right', 'left'), liveTeamAKey: 'home', liveStateOnly: true
    })
    expect(b).toEqual({ setIndex: 2, betweenSets: false, homeLeft: false, servingTeam: 'away' })
  })

  describe('the deciding set', () => {
    const four = [fin(1, 25, 0), fin(2, 20, 25), fin(3, 25, 20), fin(4, 22, 25)]
    // the set 4 end writes set 5 defaults on the match (not a coin toss yet)
    const proposed = { ...match, set5LeftTeam: 'A', set5FirstServe: 'B' }

    it('before its coin toss: the sides set 4 ended on (A right) and nobody serving', () => {
      const b = refereeSetBreak({ sets: four, currentSet: null, events: [], match: proposed, liveState: setEndPush(5, 'right', 'right'), liveTeamAKey: 'home' })
      expect(b).toEqual({ setIndex: 5, betweenSets: true, homeLeft: false, servingTeam: null })
      const withRow = refereeSetBreak({ sets: [...four, open(5)], currentSet: open(5), events: [], match: proposed, liveState: { ...setEndPush(5, 'left', 'left'), last_event_type: 'manual_set5_setup' }, liveTeamAKey: 'home' })
      expect(withRow).toEqual({ setIndex: 5, betweenSets: true, homeLeft: false, servingTeam: null })
    })

    it('after its coin toss (set5_coin_toss): its sides and its first server', () => {
      const toss = { type: 'set5_coin_toss', setIndex: 5, seq: 90, payload: { leftTeam: 'A', firstServe: 'B' } }
      const confirmed = { current_set: 5, side_a: 'left', serving_team: 'right', set_interval_active: false, last_event_type: 'manual_set5_setup' }
      const b = refereeSetBreak({ sets: [...four, open(5)], currentSet: open(5), events: [toss], match: proposed, liveState: confirmed, liveTeamAKey: 'home' })
      expect(b).toEqual({ setIndex: 5, betweenSets: true, homeLeft: true, servingTeam: 'away' })
    })

    it('best of 3: set 5 comes after set 2, before its toss on set 2\'s sides', () => {
      const b = refereeSetBreak({ sets: [fin(1, 25, 0), fin(2, 20, 25)], currentSet: null, events: [], match: { ...match, bestOf: 3 }, bestOf: 3 })
      expect(b).toEqual({ setIndex: 5, betweenSets: true, homeLeft: false, servingTeam: null })
    })

    it('decidingTossDone: the event, or a live-state-only view whose break ended on set 5', () => {
      expect(decidingTossDone({ events: [{ type: 'set5_coin_toss', setIndex: 5 }] })).toBe(true)
      expect(decidingTossDone({ events: [], liveState: { current_set: 5, set_interval_active: false } })).toBe(false)
      expect(decidingTossDone({ events: [], liveState: { current_set: 5, set_interval_active: false }, liveStateOnly: true })).toBe(true)
      expect(decidingTossDone({ events: [], liveState: { current_set: 5, set_interval_active: true }, liveStateOnly: true })).toBe(false)
    })
  })
})
