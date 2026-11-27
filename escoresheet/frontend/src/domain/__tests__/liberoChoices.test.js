// The libero dropdowns of the roster editors (owner 27.11.2026): "it is
// either nothing, Libero 1, Libero 2. one libero -> only Libero 1".
import { describe, it, expect } from 'vitest'
import { liberoChoices, liberoValueOf, liberosInRecord, withLoneLiberoAsL1 } from '../liberoChoices'

const P = (number, libero = '') => ({ number, lastName: `P${number}`, libero })

describe('liberoChoices', () => {
  it('no libero yet: none or Libero 1, never Libero 2 (a new player and a row alike)', () => {
    const team = [P(1), P(2), P(3)]
    expect(liberoChoices(team, null)).toEqual(['', 'libero1'])
    expect(liberoChoices(team, 1)).toEqual(['', 'libero1'])
    expect(liberoChoices([], null)).toEqual(['', 'libero1'])
  })

  it('one L1: the others may be L2 only; the L1 row keeps none or L1', () => {
    const team = [P(1), P(9, 'libero1'), P(3)]
    expect(liberoChoices(team, null)).toEqual(['', 'libero2'])
    expect(liberoChoices(team, 0)).toEqual(['', 'libero2'])
    expect(liberoChoices(team, 1)).toEqual(['', 'libero1'])
  })

  it('L1 and L2: nothing more to give; each libero row keeps its own value', () => {
    const team = [P(1), P(9, 'libero1'), P(10, 'libero2')]
    expect(liberoChoices(team, null)).toEqual([''])
    expect(liberoChoices(team, 0)).toEqual([''])
    expect(liberoChoices(team, 1)).toEqual(['', 'libero1'])
    expect(liberoChoices(team, 2)).toEqual(['', 'libero2'])
  })

  it('a lone L2 (its L1 cleared in a running match): its row keeps L2 and may become L1; the others get L1 only', () => {
    const team = [P(1), P(10, 'libero2')]
    expect(liberoChoices(team, 1)).toEqual(['', 'libero1', 'libero2'])
    expect(liberoChoices(team, 0)).toEqual(['', 'libero1'])
    expect(liberoChoices(team, null)).toEqual(['', 'libero1'])
  })

  it("the row's own value: an add row's pending L2 stays shown, a re-designated or unable libero keeps that state", () => {
    expect(liberoChoices([P(1)], null, 'libero2')).toEqual(['', 'libero1', 'libero2'])
    const team = [P(9, 'libero1'), P(12, 'redesignated'), P(4, 'unable')]
    expect(liberoChoices(team, 1)).toEqual(['', 'libero2', 'redesignated'])
    expect(liberoChoices(team, 2)).toEqual(['', 'libero2', 'unable'])
  })

  it('a legacy `libero: true` counts as L1', () => {
    const team = [P(1), P(9, true)]
    expect(liberoValueOf(team[1])).toBe('libero1')
    expect(liberoChoices(team, 0)).toEqual(['', 'libero2'])
    expect(liberoChoices(team, 1)).toEqual(['', 'libero1'])
    expect(liberoValueOf({})).toBe('')
    expect(liberoValueOf(null)).toBe('')
  })
})

describe('withLoneLiberoAsL1', () => {
  it('the L1 deleted or set to none: the L2 left becomes L1', () => {
    expect(withLoneLiberoAsL1([P(1), P(10, 'libero2')]).map(liberoValueOf)).toEqual(['', 'libero1'])
    expect(withLoneLiberoAsL1([P(9, ''), P(10, 'libero2')])[1]).toEqual({ number: 10, lastName: 'P10', libero: 'libero1' })
  })

  it('changes nothing with an L1 (or no libero): the same array', () => {
    const both = [P(9, 'libero1'), P(10, 'libero2')]
    expect(withLoneLiberoAsL1(both)).toBe(both)
    const legacy = [P(9, true), P(10, 'libero2')]
    expect(withLoneLiberoAsL1(legacy)).toBe(legacy)
    const none = [P(1), P(2)]
    expect(withLoneLiberoAsL1(none)).toBe(none)
    expect(withLoneLiberoAsL1(undefined)).toEqual([])
  })

  it('two L2 without an L1 (old data): the first becomes L1', () => {
    expect(withLoneLiberoAsL1([P(10, 'libero2'), P(11, 'libero2')]).map(liberoValueOf)).toEqual(['libero1', 'libero2'])
  })
})

describe('liberosInRecord', () => {
  const team = [P(1), P(2), P(9, 'libero1'), P(10, 'libero2')]
  const lineup = { type: 'lineup', payload: { team: 'home', lineup: { I: '1', II: '2' } } }

  it('nothing yet about the liberos: false (a line-up and a point of other players)', () => {
    const events = [lineup, { type: 'point', payload: { team: 'home' } }, { type: 'substitution', payload: { team: 'home', playerOut: 2, playerIn: 3 } }]
    expect(liberosInRecord(events, 'home', team)).toBe(false)
    expect(liberosInRecord([], 'home', team)).toBe(false)
  })

  it('a libero replacement, a line-up with a libero, an L1 / L2 named or a libero sanctioned: true', () => {
    expect(liberosInRecord([lineup, { type: 'libero_entry', payload: { team: 'home', playerOut: 1, liberoIn: 9 } }], 'home', team)).toBe(true)
    expect(liberosInRecord([{ type: 'lineup', payload: { team: 'home', lineup: { I: '9' }, liberoSubstitution: { liberoNumber: 9, playerNumber: 1 } } }], 'home', team)).toBe(true)
    expect(liberosInRecord([{ type: 'lineup', payload: { team: 'home', lineup: {}, liberoType: 'libero2' } }], 'home', team)).toBe(true)
    expect(liberosInRecord([{ type: 'sanction', payload: { team: 'home', type: 'warning', playerType: 'player', playerNumber: 10 } }], 'home', team)).toBe(true)
    expect(liberosInRecord([{ type: 'decision_change', payload: { removedSubEvents: [{ type: 'libero_exit', payload: { team: 'home', liberoOut: 9 } }] } }], 'home', team)).toBe(true)
  })

  it("the other team's libero events do not count", () => {
    expect(liberosInRecord([{ type: 'libero_entry', payload: { team: 'away', playerOut: 1, liberoIn: 9 } }], 'home', team)).toBe(false)
  })
})
