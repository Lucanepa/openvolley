import { describe, it, expect } from 'vitest'
import { referencedPlayerNumbers, validateReopenedRoster } from '../roster'

const P = (id, number, extra = {}) => ({ id, number, lastName: `P${number}`, libero: '', isCaptain: false, ...extra })

describe('referencedPlayerNumbers', () => {
  it('collects numbers from lineups, subs, libero and sanction events of the team', () => {
    const events = [
      { type: 'lineup', payload: { team: 'home', lineup: { I: '1', II: '2' }, liberoSubstitution: { liberoNumber: 9, playerNumber: 5 } } },
      { type: 'substitution', payload: { team: 'home', playerOut: 2, playerIn: 12 } },
      { type: 'libero_entry', payload: { team: 'home', playerOut: 6, liberoIn: 10 } },
      { type: 'sanction', payload: { team: 'home', type: 'warning', playerType: 'player', playerNumber: 7 } },
      { type: 'sanction', payload: { team: 'home', type: 'warning', playerType: 'coach' } },
      { type: 'lineup', payload: { team: 'away', lineup: { I: '33' } } }
    ]
    const nums = referencedPlayerNumbers(events, 'home')
    expect([...nums].sort()).toEqual(['1', '10', '12', '2', '5', '6', '7', '9'])
    expect(nums.has('33')).toBe(false)
  })
})

describe('validateReopenedRoster', () => {
  const original = [P(1, 1), P(2, 2), P(3, 3)]

  it('accepts a valid edit with a new player', () => {
    const r = validateReopenedRoster([...original, { number: 14, lastName: 'New' }], original, new Set(['1']))
    expect(r).toEqual({ valid: true, errors: [] })
  })

  it('rejects number 0 (the old add-player default) and out-of-range numbers', () => {
    expect(validateReopenedRoster([...original, { number: 0 }], original).valid).toBe(false)
    expect(validateReopenedRoster([...original, { number: 100 }], original).valid).toBe(false)
  })

  it('rejects duplicate numbers', () => {
    const r = validateReopenedRoster([...original, { number: 3 }], original)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/#3/)
  })

  it('rejects a third active libero and a second captain', () => {
    const libs = [P(1, 1, { libero: 'libero1' }), P(2, 2, { libero: 'libero2' }), P(3, 3, { libero: 'libero1' })]
    expect(validateReopenedRoster(libs, libs).errors.join()).toMatch(/liberos/)
    const caps = [P(1, 1, { isCaptain: true }), P(2, 2, { isCaptain: true })]
    expect(validateReopenedRoster(caps, caps).errors.join()).toMatch(/captain/)
  })

  it('an unable libero does not count towards the two', () => {
    const libs = [P(1, 1, { libero: 'unable' }), P(2, 2, { libero: 'libero2' }), P(3, 3, { libero: 'redesignated' })]
    expect(validateReopenedRoster(libs, libs).valid).toBe(true)
  })

  it('refuses removing or renumbering a player in the record', () => {
    const refs = new Set(['2'])
    expect(validateReopenedRoster([P(1, 1), P(3, 3)], original, refs).errors.join()).toMatch(/cannot be removed/)
    expect(validateReopenedRoster([P(1, 1), P(2, 22), P(3, 3)], original, refs).errors.join()).toMatch(/cannot be renumbered/)
  })

  it('allows removing or renumbering a player not in the record', () => {
    expect(validateReopenedRoster([P(1, 1), P(2, 2)], original, new Set(['2'])).valid).toBe(true)
    expect(validateReopenedRoster([P(1, 1), P(2, 2), P(3, 13)], original, new Set(['2'])).valid).toBe(true)
  })
})
