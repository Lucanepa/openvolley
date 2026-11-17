// @vitest-environment node
/**
 * The live-state fields every viewer gets, PIN or not (domain/livePublicFields):
 * per-team substitution counts of the set the push names, and the finished
 * sets' scores, kept right through set ends, undo and corrections.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { livePublicFields, liveSetResultsOf, regularSubstitutionCount } from '../livePublicFields'

const sub = (playerOut, playerIn, exceptional = false) => ({ playerIn, playerOut, position: 'I', exceptional, ts: 't' })
const set = (index, homePoints, awayPoints, finished) => ({ id: index, matchId: 1, index, homePoints, awayPoints, finished })

describe('regularSubstitutionCount', () => {
  it('counts the regular substitutions, not the exceptional ones (FIVB 15.6 / 15.7)', () => {
    expect(regularSubstitutionCount([sub(1, 2), sub(3, 4), sub(5, 6, true)])).toBe(2)
    expect(regularSubstitutionCount([])).toBe(0)
    expect(regularSubstitutionCount(null)).toBe(0)
    expect(regularSubstitutionCount(undefined)).toBe(0)
    expect(regularSubstitutionCount([null, 'x', sub(1, 2)])).toBe(1)
  })
})

describe('liveSetResultsOf', () => {
  const sets = [set(1, 27, 25, true), set(2, 12, 25, true), set(3, 10, 8, false)]
  it('the finished sets, oldest first, by home/away and by Team A/B', () => {
    expect(liveSetResultsOf(sets, { teamAKey: 'home' })).toEqual([
      { set: 1, home: 27, away: 25, a: 27, b: 25 },
      { set: 2, home: 12, away: 25, a: 12, b: 25 }
    ])
    // Team A is the away team: a / b turn round, home / away stay
    expect(liveSetResultsOf([...sets].reverse(), { teamAKey: 'away' })).toEqual([
      { set: 1, home: 27, away: 25, a: 25, b: 27 },
      { set: 2, home: 12, away: 25, a: 25, b: 12 }
    ])
  })
  it('[] before the first set ends', () => {
    expect(liveSetResultsOf([set(1, 3, 1, false)])).toEqual([])
    expect(liveSetResultsOf(null)).toEqual([])
  })
  it('a set that ends with this push counts from its row, once', () => {
    const ending = [set(1, 25, 20, true), set(2, 25, 23, false)]
    expect(liveSetResultsOf(ending, { endingSetIndex: 2 }).map((s) => [s.set, s.home, s.away])).toEqual([[1, 25, 20], [2, 25, 23]])
    // already finished: not twice
    expect(liveSetResultsOf([set(1, 25, 20, true)], { endingSetIndex: 1 })).toHaveLength(1)
    // no row: the snapshot's Team A/B points
    expect(liveSetResultsOf([], { teamAKey: 'away', endingSetIndex: 1, endingSetPoints: { a: 25, b: 18 } }))
      .toEqual([{ set: 1, home: 18, away: 25, a: 25, b: 18 }])
  })
  it('a best-of-3 decider keeps its stored index 5, as on the match row', () => {
    const bo3 = [set(1, 25, 20, true), set(2, 20, 25, true), set(5, 15, 13, true)]
    expect(liveSetResultsOf(bo3).map((s) => s.set)).toEqual([1, 2, 5])
  })
})

describe('livePublicFields', () => {
  const snapshotOfSet2 = {
    currentSetIndex: 2, teamAKey: 'home', pointsA: 18, pointsB: 16,
    subsA: [sub(4, 9), sub(7, 11), sub(8, 12, true)], subsB: [sub(2, 14)]
  }
  const sets = [set(1, 25, 21, true), set(2, 18, 16, false)]

  it('during a set: the regular substitutions of that set per team, the finished sets', () => {
    expect(livePublicFields({ snapshot: snapshotOfSet2, sets, pushedSetIndex: 2 })).toEqual({
      subs_count_a: 2,
      subs_count_b: 1,
      set_results: [{ set: 1, home: 25, away: 21, a: 25, b: 21 }]
    })
  })

  it('Team A is the away team: counts and a / b by Team A', () => {
    const snapshot = { ...snapshotOfSet2, teamAKey: 'away' }
    const out = livePublicFields({ snapshot, sets, pushedSetIndex: 2 })
    expect([out.subs_count_a, out.subs_count_b]).toEqual([2, 1])
    expect(out.set_results).toEqual([{ set: 1, home: 25, away: 21, a: 21, b: 25 }])
  })

  it('the set end push names the next set: no substitution there yet, the ended set in the results', () => {
    const end = { ...snapshotOfSet2, pointsA: 25, pointsB: 23 }
    const atEnd = [set(1, 25, 21, true), set(2, 25, 23, false)]
    expect(livePublicFields({ snapshot: end, sets: atEnd, pushedSetIndex: 3, countFinishedSet: true })).toEqual({
      subs_count_a: 0,
      subs_count_b: 0,
      set_results: [{ set: 1, home: 25, away: 21, a: 25, b: 21 }, { set: 2, home: 25, away: 23, a: 25, b: 23 }]
    })
  })

  it('the match end push stays on the last set: its counts stay, every set is in', () => {
    const last = { ...snapshotOfSet2, currentSetIndex: 3, subsA: [sub(1, 2)], subsB: [] }
    const atEnd = [set(1, 25, 21, true), set(2, 25, 23, true), set(3, 25, 10, false)]
    const out = livePublicFields({ snapshot: last, sets: atEnd, pushedSetIndex: 3, countFinishedSet: true })
    expect([out.subs_count_a, out.subs_count_b]).toEqual([1, 0])
    expect(out.set_results.map((s) => s.set)).toEqual([1, 2, 3])
  })

  it('undo of a set end: the reopened set is gone from the next push, its substitutions are back', () => {
    // after the undo: set 2 open again (finished false), the snapshot of set 2
    const reopened = [set(1, 25, 21, true), set(2, 24, 23, false)]
    const snapshot = { ...snapshotOfSet2, pointsA: 24, pointsB: 23 }
    expect(livePublicFields({ snapshot, sets: reopened, pushedSetIndex: 2, countFinishedSet: false })).toEqual({
      subs_count_a: 2,
      subs_count_b: 1,
      set_results: [{ set: 1, home: 25, away: 21, a: 25, b: 21 }]
    })
  })

  it('undo of a substitution: the count follows the snapshot it is pushed with', () => {
    const undone = { ...snapshotOfSet2, subsA: [sub(4, 9)] }
    expect(livePublicFields({ snapshot: undone, sets, pushedSetIndex: 2 }).subs_count_a).toBe(1)
  })

  it('a corrected set score (rectification, manual correction) is the next push\'s', () => {
    const corrected = [set(1, 25, 23, true), set(2, 18, 16, false)]
    expect(livePublicFields({ snapshot: snapshotOfSet2, sets: corrected, pushedSetIndex: 2 }).set_results)
      .toEqual([{ set: 1, home: 25, away: 23, a: 25, b: 23 }])
  })

  it('a snapshot without substitution lists (older stored snapshots): 0', () => {
    expect(livePublicFields({ snapshot: { currentSetIndex: 1 }, sets: [], pushedSetIndex: 1 }))
      .toEqual({ subs_count_a: 0, subs_count_b: 0, set_results: [] })
  })
})

describe('Scoreboard live-state wiring', () => {
  const sb = readFileSync(resolve(__dirname, '../../components/Scoreboard.jsx'), 'utf8')
  it('every live-state push carries the public fields, from the push\'s snapshot, sets and current_set', () => {
    expect(sb).toMatch(/\.\.\.livePublicFields\(\{ snapshot, sets: matchSets, pushedSetIndex: finalSetIndex, countFinishedSet \}\)/)
    // the private substitution lists stay as they were
    expect(sb).toMatch(/subs_a: snapshot\.subsA\?\.length > 0 \? snapshot\.subsA : null/)
    // the sets are read at the push itself, not from a cached list
    expect(sb).toMatch(/const matchSets = await db\.sets\.where\(\{ matchId \}\)\.toArray\(\)/)
  })
})
