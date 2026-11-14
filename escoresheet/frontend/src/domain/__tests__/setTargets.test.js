import { describe, it, expect } from 'vitest'
import { getSetResult, setTargetsOf, pointsToWinFor, courtSwitchPointOf, DEFAULT_SET_TARGETS } from '../rules'
import { forfeitSetPoints, planForfeit } from '../matchEnd'

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
})
