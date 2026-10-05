import { describe, it, expect } from 'vitest'
import { validateManualSubstitution, getSetSubstitutions, validateManualTimeout, planSubstitutionDeletion } from '../substitutions'

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

describe('validateManualTimeout (FIVB 15.4.1)', () => {
  const to = (team, setIndex) => ({ type: 'timeout', setIndex, payload: { team } })
  it('allows the first and second timeout of a team in a set', () => {
    expect(validateManualTimeout([], 'home', 1).legal).toBe(true)
    expect(validateManualTimeout([to('home', 1)], 'home', 1).legal).toBe(true)
  })
  it('refuses a third timeout of the same team in the same set', () => {
    const r = validateManualTimeout([to('home', 1), to('home', 1)], 'home', 1)
    expect(r.legal).toBe(false)
    expect(r.reason).toMatch(/limit/i)
  })
  it('counts per team and per set', () => {
    const events = [to('home', 1), to('home', 1), to('away', 1), to('home', 2)]
    expect(validateManualTimeout(events, 'away', 1).legal).toBe(true)
    expect(validateManualTimeout(events, 'home', 2).legal).toBe(true)
  })
})

describe('planSubstitutionDeletion', () => {
  const L = (id, seq, lineup, extra = {}) => ({ id, type: 'lineup', setIndex: 1, seq, payload: { team: 'home', lineup, ...extra } })
  const start = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' }
  const subEv = { id: 's1', type: 'substitution', setIndex: 1, seq: 10, payload: { team: 'home', position: 'III', playerOut: 3, playerIn: 13 } }
  const subLineup = L('l10', 10.1, { ...start, III: '13' }, { fromSubstitution: true })

  it('deletes the substitution and its own lineup sub-event, not the latest lineup', () => {
    // a later rotation lineup (seq 12.1) must be corrected, not deleted
    const rotation = L('l12', 12.1, { I: '2', II: '13', III: '4', IV: '5', V: '6', VI: '1' })
    const plan = planSubstitutionDeletion([L('l0', 1, start), subEv, subLineup, rotation], subEv)
    expect(plan.blocked).toBe(false)
    expect(plan.deleteIds).toEqual(['s1', 'l10'])
    expect(plan.updates).toEqual([{ id: 'l12', payload: { team: 'home', lineup: { I: '2', II: '3', III: '4', IV: '5', V: '6', VI: '1' } } }])
  })

  it('maps the player by number wherever he has rotated to', () => {
    const later = L('l20', 20.1, { I: '13', II: '4', III: '5', IV: '6', V: '1', VI: '2' })
    const plan = planSubstitutionDeletion([subEv, subLineup, later], subEv)
    expect(plan.updates[0].payload.lineup.I).toBe('3')
  })

  it('does not touch earlier lineups or the other team', () => {
    const other = { ...L('a1', 11.1, { I: '13' }), payload: { team: 'away', lineup: { I: '13' } } }
    const plan = planSubstitutionDeletion([L('l0', 1, start), subEv, subLineup, other], subEv)
    expect(plan.updates).toEqual([])
    expect(plan.deleteIds).toEqual(['s1', 'l10'])
  })

  it('corrects libero records that reference the substitute', () => {
    const liberoLineup = L('l15', 15.1, { ...start, III: '13', I: '9' }, { liberoSubstitution: { position: 'I', liberoNumber: 9, playerNumber: 13 } })
    const entry = { id: 'e15', type: 'libero_entry', setIndex: 1, seq: 15, payload: { team: 'home', playerOut: 13, liberoIn: 9 } }
    const exit = { id: 'x16', type: 'libero_exit', setIndex: 1, seq: 16, payload: { team: 'home', playerIn: '13', liberoOut: 9 } }
    const plan = planSubstitutionDeletion([subEv, subLineup, liberoLineup, entry, exit], subEv)
    const byId = Object.fromEntries(plan.updates.map(u => [u.id, u.payload]))
    expect(byId.l15.liberoSubstitution.playerNumber).toBe(3)
    expect(byId.l15.lineup.III).toBe('3')
    expect(byId.e15.playerOut).toBe(3)
    expect(byId.x16.playerIn).toBe('3')
  })

  it('refuses when a later substitution involves either player (return substitution)', () => {
    const back = { id: 's2', type: 'substitution', setIndex: 1, seq: 30, payload: { team: 'home', position: 'IV', playerOut: 13, playerIn: 3 } }
    const plan = planSubstitutionDeletion([subEv, subLineup, back], subEv)
    expect(plan.blocked).toBe(true)
    expect(plan.reason).toMatch(/later substitution/)
  })

  it('works for legacy data without the lineup sub-event', () => {
    const later = L('l20', 20, { ...start, III: '13' })
    const plan = planSubstitutionDeletion([subEv, later], subEv)
    expect(plan.deleteIds).toEqual(['s1'])
    expect(plan.updates[0].payload.lineup.III).toBe('3')
  })
})
