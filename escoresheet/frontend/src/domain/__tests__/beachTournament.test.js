// The pure helpers of the OpenBeach tournament console (domain/beachTournament.js):
// the Zurich wall clock of the inputs, sets text, the bracket sections, the
// schedule grid, the seed order and the ranking file name.
import { describe, it, expect } from 'vitest'
import {
  toZurichInput, fromZurichInput, parseSource, parseSets, setsText, setsWinner,
  bracketSections, scheduleGrid, zurichDay, rankingFileName, seedOrderOf, moveItem
} from '../beachTournament'

describe('beachTournament helpers', () => {
  it('datetime inputs on the Zurich clock, summer and winter', () => {
    expect(toZurichInput('2026-07-11T07:00:00.000Z')).toBe('2026-07-11T09:00')
    expect(toZurichInput('2026-01-10T08:00:00Z')).toBe('2026-01-10T09:00')
    expect(toZurichInput(null)).toBe('')
    expect(toZurichInput('nonsense')).toBe('')
    expect(fromZurichInput('2026-07-11T09:00')).toBe('2026-07-11T07:00:00.000Z')
    expect(fromZurichInput('2026-01-10T09:00')).toBe('2026-01-10T08:00:00.000Z')
    expect(fromZurichInput('')).toBe(null)
    expect(zurichDay('2026-07-11T22:30:00Z')).toBe('2026-07-12')
  })

  it('sources and sets', () => {
    expect(parseSource('seed:4')).toEqual({ kind: 'seed', value: '4' })
    expect(parseSource('loser:W3')).toEqual({ kind: 'loser', value: 'W3' })
    expect(parseSource('x')).toBe(null)
    expect(parseSets('21:17 19:21, 15-12')).toEqual([[21, 17], [19, 21], [15, 12]])
    expect(parseSets('')).toEqual([])
    expect(parseSets('21:17 abc')).toBe(null)
    expect(parseSets('1:0 1:0 1:0 1:0')).toBe(null)
    expect(setsText([[21, 17], [19, 21]])).toBe('21:17 19:21')
    expect(setsText(null)).toBe('')
    expect(setsWinner([[21, 17], [19, 21], [15, 12]])).toBe(1)
    expect(setsWinner([[17, 21], [19, 21]])).toBe(2)
    expect(setsWinner([[21, 17], [19, 21]])).toBe(null)
  })

  it('bracket sections in bracket order', () => {
    const m = (game_n, phase, round) => ({ game_n, phase, round })
    const s = bracketSections([m(5, 'final', 1), m(3, 'losers', 1), m(1, 'winners', 1), m(2, 'winners', 1), m(4, 'winners', 2), m(6, 'placement', 2)])
    expect(s.map(x => `${x.phase}${x.round}:${x.matches.map(y => y.game_n).join(',')}`))
      .toEqual(['winners1:1,2', 'winners2:4', 'losers1:3', 'final1:5', 'placement2:6'])
    // rounds counted within the phase (a bracket with byes starts the losers at board round 2)
    expect(bracketSections([m(1, 'losers', 2), m(2, 'losers', 3), m(3, 'winners', 2)]).map(x => `${x.phase}${x.index}`))
      .toEqual(['winners1', 'losers1', 'losers2'])
  })

  it('schedule grid: times x courts, the unplanned apart', () => {
    const courts = [{ id: 'c2', number: 2 }, { id: 'c1', number: 1 }]
    const g = scheduleGrid([
      { id: 'a', game_n: 1, court_id: 'c1', scheduled_at: '2026-07-11T07:00:00Z' },
      { id: 'b', game_n: 2, court_id: 'c2', scheduled_at: '2026-07-11T07:00:00.000Z' },
      { id: 'c', game_n: 3, court_id: 'c1', scheduled_at: '2026-07-11T07:50:00Z' },
      { id: 'd', game_n: 5, court_id: null, scheduled_at: null },
      { id: 'e', game_n: 4, court_id: null, scheduled_at: null }
    ], courts)
    expect(g.courts.map(c => c.number)).toEqual([1, 2])
    expect(g.times).toEqual(['2026-07-11T07:00:00.000Z', '2026-07-11T07:50:00.000Z'])
    expect(g.cell(g.times[0], 'c2').id).toBe('b')
    expect(g.cell(g.times[1], 'c2')).toBe(null)
    expect(g.unscheduled.map(m => m.id)).toEqual(['e', 'd'])
  })

  it('seed order, moving, file names', () => {
    const e = [
      { id: 'x', seed: null, name: 'Zeta', status: 'registered' },
      { id: 'y', seed: 2, name: 'B', status: 'registered' },
      { id: 'z', seed: 1, name: 'A', status: 'registered' },
      { id: 'w', seed: null, name: 'Alpha', status: 'withdrawn' }
    ]
    expect(seedOrderOf(e).map(x => x.id)).toEqual(['z', 'y', 'x'])
    expect(moveItem(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b'])
    expect(moveItem(['a', 'b'], 0, -1)).toEqual(['a', 'b'])
    expect(rankingFileName({ slug: 'zuri-open-2026' }, { category: 'A1', gender: 'women' })).toBe('zuri-open-2026-a1-women-ranking.csv')
    expect(rankingFileName({ title: 'Züri Open' }, { category: 'B 2', gender: 'men' })).toBe('zuri-open-b-2-men-ranking.csv')
  })
})
