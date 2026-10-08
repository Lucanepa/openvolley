// createStateSnapshot counted sets won by s.winner, a field no set has: the
// debug snapshot always said 0 : 0. Sets carry their points and `finished`.
import { describe, it, expect } from 'vitest'
import { createStateSnapshot } from '../debugLogger'

describe('debugLogger createStateSnapshot', () => {
  it('counts the finished sets each team won and reads the set score', () => {
    const sets = [
      { index: 1, homePoints: 25, awayPoints: 20, finished: true },
      { index: 2, homePoints: 23, awayPoints: 25, finished: true },
      { index: 3, homePoints: 25, awayPoints: 18, finished: true },
      { index: 4, homePoints: 7, awayPoints: 4, finished: false }
    ]
    const snap = createStateSnapshot({ match: { id: 1 }, sets, currentSet: sets[3], events: [] })
    expect(snap).toMatchObject({ setIndex: 4, homeScore: 7, awayScore: 4, homeSetsWon: 2, awaySetsWon: 1 })
  })
})
