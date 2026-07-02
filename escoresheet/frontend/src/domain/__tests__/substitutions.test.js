import { describe, it, expect } from 'vitest'
import { validateManualSubstitution, getSetSubstitutions } from '../substitutions'

const sub = (team, setIndex, playerOut, playerIn, seq) => ({
  type: 'substitution', setIndex, seq, payload: { team, playerOut, playerIn },
})

describe('validateManualSubstitution (FIVB 15.5-15.6)', () => {
  it('accepts a first, well-formed substitution', () => {
    expect(validateManualSubstitution([], 'home', 1, 5, 12)).toEqual({ legal: true })
  })

  it('rejects self-substitution and missing players', () => {
    expect(validateManualSubstitution([], 'home', 1, 5, 5).legal).toBe(false)
    expect(validateManualSubstitution([], 'home', 1, 0, 12).legal).toBe(false)
    expect(validateManualSubstitution([], 'home', 1, 5, undefined).legal).toBe(false)
  })

  it('enforces the 6-per-set cap', () => {
    const six = [
      sub('home', 1, 1, 11, 1), sub('home', 1, 2, 12, 2), sub('home', 1, 3, 13, 3),
      sub('home', 1, 4, 14, 4), sub('home', 1, 5, 15, 5), sub('home', 1, 6, 16, 6),
    ]
    expect(validateManualSubstitution(six, 'home', 1, 7, 17).legal).toBe(false)
    // a different team / different set is unaffected
    expect(validateManualSubstitution(six, 'away', 1, 7, 17).legal).toBe(true)
    expect(validateManualSubstitution(six, 'home', 2, 7, 17).legal).toBe(true)
  })

  it('rejects substituting the same player in twice', () => {
    const evs = [sub('home', 1, 5, 12, 1)]
    expect(validateManualSubstitution(evs, 'home', 1, 6, 12).legal).toBe(false)
  })

  it('rejects substituting the same player out twice', () => {
    const evs = [sub('home', 1, 5, 12, 1)]
    expect(validateManualSubstitution(evs, 'home', 1, 5, 13).legal).toBe(false)
  })

  it('allows the legal reverse pairing (starter returns for their substitute)', () => {
    const evs = [sub('home', 1, 5, 12, 1)] // 12 came on for 5
    expect(validateManualSubstitution(evs, 'home', 1, 12, 5)).toEqual({ legal: true })
  })

  it('rejects an illegal reverse pairing (wrong starter returns for a substitute)', () => {
    const evs = [sub('home', 1, 5, 12, 1)] // 12 came on for 5
    // 12 goes out but for 9 (not 5) -> illegal
    expect(validateManualSubstitution(evs, 'home', 1, 12, 9).legal).toBe(false)
  })

  it('getSetSubstitutions filters by team + set', () => {
    const evs = [sub('home', 1, 5, 12, 1), sub('away', 1, 3, 10, 2), sub('home', 2, 6, 16, 3)]
    expect(getSetSubstitutions(evs, 'home', 1)).toHaveLength(1)
  })
})
