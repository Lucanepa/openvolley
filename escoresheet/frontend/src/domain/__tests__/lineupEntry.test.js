import { describe, it, expect } from 'vitest'
import { lineupEntryErrors, lineupCandidates, LINEUP_ERRORS } from '../lineupEntry'

const P = (number, extra = {}) => ({ number, libero: '', isCaptain: false, ...extra })
const roster = [P(1, { isCaptain: true }), P(2), P(3), P(4), P(6), P(7), P(10), P(12, { libero: 'libero1' })]
// [IV, III, II, V, VI, I]
const at = (values) => values.map(v => (v == null ? '' : String(v)))

describe('lineupEntryErrors', () => {
  it('flags both boxes of a duplicate', () => {
    const errors = lineupEntryErrors({ lineup: at([4, 3, 2, 6, 7, 3]), players: roster })
    expect(errors).toEqual({ 1: LINEUP_ERRORS.duplicate, 5: LINEUP_ERRORS.duplicate })
  })

  it('editing the OTHER box clears the duplicate in both boxes', () => {
    // III and I both hold 3; the scorer changes I (not III) to 10
    const before = at([4, 3, 2, 6, 7, 3])
    expect(Object.keys(lineupEntryErrors({ lineup: before, players: roster }))).toEqual(['1', '5'])
    const after = [...before]
    after[5] = '10'
    expect(lineupEntryErrors({ lineup: after, players: roster })).toEqual({})
  })

  it('clears a duplicate when one of the boxes is emptied', () => {
    const errors = lineupEntryErrors({ lineup: at([4, 3, 2, 6, 7, null]), players: roster })
    expect(errors).toEqual({})
  })

  it('treats 03 and 3 as the same number', () => {
    const errors = lineupEntryErrors({ lineup: ['03', '3', '', '', '', ''], players: roster })
    expect(errors).toEqual({ 0: LINEUP_ERRORS.duplicate, 1: LINEUP_ERRORS.duplicate })
  })

  it('flags numbers not on the roster and liberos, and clears them once fixed', () => {
    const lineup = at([99, 12, 2, null, null, null])
    expect(lineupEntryErrors({ lineup, players: roster })).toEqual({ 0: LINEUP_ERRORS.notOnRoster, 1: LINEUP_ERRORS.libero })
    lineup[0] = '4'
    lineup[1] = '3'
    expect(lineupEntryErrors({ lineup, players: roster })).toEqual({})
  })

  it('only requires empty boxes once the scorer tried to confirm', () => {
    const lineup = at([4, 3, 2, null, null, 1])
    expect(lineupEntryErrors({ lineup, players: roster })).toEqual({})
    expect(lineupEntryErrors({ lineup, players: roster, requireAll: true })).toEqual({ 3: LINEUP_ERRORS.required, 4: LINEUP_ERRORS.required })
    lineup[3] = '6'
    expect(lineupEntryErrors({ lineup, players: roster, requireAll: true })).toEqual({ 4: LINEUP_ERRORS.required })
  })

  it('flags disqualified and exceptionally substituted players of the same team only', () => {
    const events = [
      { type: 'sanction', payload: { team: 'home', type: 'disqualification', playerNumber: 6 } },
      { type: 'substitution', payload: { team: 'home', playerOut: '7', isExceptional: true } },
      { type: 'sanction', payload: { team: 'away', type: 'disqualification', playerNumber: 2 } }
    ]
    const errors = lineupEntryErrors({ lineup: at([4, 3, 2, 6, 7, 1]), players: roster, events, team: 'home' })
    expect(errors).toEqual({ 3: LINEUP_ERRORS.disqualified, 4: LINEUP_ERRORS.exceptionallySubstituted })
  })
})

describe('lineupCandidates', () => {
  it('lists non-libero players not yet in the line-up, by number', () => {
    const numbers = lineupCandidates({ players: [...roster].reverse(), lineup: at([3, null, null, null, null, 1]) }).map(p => p.number)
    expect(numbers).toEqual([2, 4, 6, 7, 10])
  })

  it('leaves out players who cannot take part', () => {
    const events = [
      { type: 'sanction', payload: { team: 'home', type: 'disqualification', playerNumber: 2 } },
      { type: 'substitution', payload: { team: 'home', playerOut: 4, isExceptional: true } },
      { type: 'sanction', setIndex: 2, payload: { team: 'home', type: 'expulsion', playerNumber: 6 } },
      { type: 'sanction', setIndex: 1, payload: { team: 'home', type: 'expulsion', playerNumber: 7 } }
    ]
    const numbers = lineupCandidates({ players: roster, lineup: at([]), events, team: 'home', setIndex: 2 }).map(p => p.number)
    expect(numbers).toEqual([1, 3, 7, 10])
  })
})
