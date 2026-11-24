import { describe, it, expect } from 'vitest'
import { getSetResult, setTargetsOf, pointsToWinFor, courtSwitchPointOf, DEFAULT_SET_TARGETS } from '../rules'
import { forfeitSetPoints, planForfeit, resultIssues, isFinalSetScore } from '../matchEnd'

describe('set targets', () => {
  it('default to 25 and 15, whatever the match holds that is not valid', () => {
    expect(setTargetsOf(null)).toEqual({ regular: 25, deciding: 15 })
    expect(setTargetsOf({ setTargets: { regular: 3, deciding: 'x' } })).toEqual({ regular: 25, deciding: 15 })
    expect(setTargetsOf({ setTargets: { regular: 21, deciding: 15 } })).toEqual({ regular: 21, deciding: 15 })
    expect(courtSwitchPointOf(DEFAULT_SET_TARGETS)).toBe(8)
    expect(courtSwitchPointOf({ regular: 21, deciding: 11 })).toBe(6)
  })
  it('a set ends at the match target with two clear, the deciding set at its own', () => {
    const t = { regular: 21, deciding: 11 }
    expect(getSetResult(21, 19, 1, { targets: t }).winner).toBe('home')
    expect(getSetResult(21, 20, 1, { targets: t }).winner).toBeNull()
    expect(getSetResult(11, 9, 5, { targets: t }).winner).toBe('home')
    expect(getSetResult(15, 13, 5, { targets: t }).pointsToWin).toBe(11)
    expect(pointsToWinFor(2, t)).toBe(21)
    // unchanged without targets
    expect(getSetResult(21, 19, 1).winner).toBeNull()
    expect(getSetResult(25, 23, 1).winner).toBe('home')
  })
  it('a forfeit awards the match target', () => {
    expect(forfeitSetPoints(3, 4, 1, { regular: 21, deciding: 15 })).toBe(21)
    expect(forfeitSetPoints(3, 4, 1)).toBe(25)
    const plan = planForfeit({ sets: [], forfeitingTeam: 'home', currentSetIndex: 1, bestOf: 3, targets: { regular: 15, deciding: 15 } })
    expect(plan.sets.every((s) => s.awayPoints === 15)).toBe(true)
  })
  it('a default (6.4.1-2) declares the match target in each set of the result', () => {
    const plan = planForfeit({ sets: [], forfeitingTeam: 'home', currentSetIndex: 1, bestOf: 3, inDefault: true, targets: { regular: 21, deciding: 15 } })
    expect(plan.sets.map((s) => [s.homePoints, s.awayPoints])).toEqual([[0, 21], [0, 21]])
    expect(planForfeit({ sets: [], forfeitingTeam: 'home', currentSetIndex: 1, bestOf: 3, inDefault: true }).sets[0].awayPoints).toBe(25)
  })
  it('Match End checks a Global result against the match targets, a Swiss one against 25/15', () => {
    expect(isFinalSetScore(21, 18, 1, { regular: 21, deciding: 15 })).toBe(true)
    expect(isFinalSetScore(21, 18, 1)).toBe(false)
    const sets = [
      { index: 1, finished: true, homePoints: 21, awayPoints: 15 },
      { index: 2, finished: true, homePoints: 21, awayPoints: 19 }
    ]
    const match = { bestOf: 3, status: 'ended', setTargets: { regular: 21, deciding: 15 } }
    expect(resultIssues({ sets, events: [], match })).toEqual([])
    expect(resultIssues({ sets, events: [], match: { bestOf: 3, status: 'ended' } }).map((i) => i.key)).toContain('setScoreInvalid')
  })
})
