import { describe, it, expect } from 'vitest'
import { referencedPlayerNumbers, validateReopenedRoster, renumberPlayerInEvents } from '../roster'

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
    expect(r).toEqual({ valid: true, errors: [], renumbers: [] })
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

  it('refuses removing a player in the record and points to Manual Adjustments', () => {
    const refs = new Set(['2'])
    const err = validateReopenedRoster([P(1, 1), P(3, 3)], original, refs).errors.join()
    expect(err).toMatch(/cannot be removed/)
    expect(err).toMatch(/Manual Adjustments/)
  })

  it('allows renumbering a player in the record to an unused number and reports it', () => {
    const r = validateReopenedRoster([P(1, 1), P(2, 22), P(3, 3)], original, new Set(['2']))
    expect(r.valid).toBe(true)
    expect(r.renumbers).toEqual([{ from: '2', to: '22' }])
  })

  it('refuses renumbering onto a number the record already uses (would merge two players)', () => {
    const refs = new Set(['1', '2'])
    // 2 -> 1 and 1 -> 2 (a swap): both targets are in the record
    const r = validateReopenedRoster([P(1, 2), P(2, 1), P(3, 3)], original, refs)
    expect(r.valid).toBe(false)
    expect(r.errors.join()).toMatch(/already used in the match record/)
    expect(r.errors.join()).toMatch(/Manual Adjustments/)
  })

  it('allows removing or renumbering a player not in the record', () => {
    expect(validateReopenedRoster([P(1, 1), P(2, 2)], original, new Set(['2'])).valid).toBe(true)
    expect(validateReopenedRoster([P(1, 1), P(2, 2), P(3, 13)], original, new Set(['2'])).valid).toBe(true)
  })
})

describe('renumberPlayerInEvents', () => {
  const events = [
    { id: 1, type: 'lineup', payload: { team: 'home', lineup: { I: '2', II: '3' }, liberoSubstitution: { liberoNumber: 9, playerNumber: 2, position: 'I' } } },
    { id: 2, type: 'substitution', payload: { team: 'home', playerOut: 2, playerIn: 12 } },
    { id: 3, type: 'libero_exit', payload: { team: 'home', liberoOut: 9, playerIn: '2' } },
    { id: 4, type: 'sanction', payload: { team: 'home', type: 'warning', playerType: 'player', playerNumber: 2 } },
    { id: 5, type: 'sanction', payload: { team: 'home', type: 'warning', playerType: 'coach', playerNumber: 2 } },
    { id: 6, type: 'lineup', payload: { team: 'away', lineup: { I: '2' } } },
    { id: 7, type: 'point', payload: { team: 'home' } },
    { id: 8, type: 'court_captain_designation', payload: { team: 'home', playerNumber: 3 } }
  ]

  it('rewrites every player-number field of that team, keeping the value type', () => {
    const updates = renumberPlayerInEvents(events, 'home', [{ from: '2', to: '22' }])
    const byId = Object.fromEntries(updates.map(u => [u.id, u.payload]))
    expect(Object.keys(byId).map(Number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4])
    expect(byId[1].lineup).toEqual({ I: '22', II: '3' })
    expect(byId[1].liberoSubstitution).toEqual({ liberoNumber: 9, playerNumber: 22, position: 'I' })
    expect(byId[2]).toMatchObject({ playerOut: 22, playerIn: 12 })
    expect(byId[3]).toMatchObject({ liberoOut: 9, playerIn: '22' })
    expect(byId[4].playerNumber).toBe(22)
  })

  it('applies several renumbers at once without chaining', () => {
    const updates = renumberPlayerInEvents(events, 'home', [{ from: '2', to: '3' }, { from: '3', to: '4' }])
    const lineup = updates.find(u => u.id === 1).payload.lineup
    expect(lineup).toEqual({ I: '3', II: '4' })
    expect(updates.find(u => u.id === 8).payload.playerNumber).toBe(4)
  })

  it('does nothing without renumbers and never touches the other team', () => {
    expect(renumberPlayerInEvents(events, 'home', [])).toEqual([])
    expect(renumberPlayerInEvents(events, 'home', [{ from: '2', to: '22' }]).some(u => u.id === 6)).toBe(false)
  })
})
