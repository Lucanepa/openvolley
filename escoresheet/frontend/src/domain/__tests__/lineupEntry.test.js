import { describe, it, expect } from 'vitest'
import {
  lineupEntryErrors, lineupCandidates, LINEUP_ERRORS,
  teamCaptainNumber, lineupCaptainStatus, gameCaptainOptions, initialGameCaptainChoice, lineupGameCaptainDecision
} from '../lineupEntry'

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

describe('game captain chosen in the line-up (FIVB 5.2)', () => {
  // roster: 1 = team captain, 12 = libero; lineup order [IV, III, II, V, VI, I]
  const withCaptain = at([4, 3, 2, 6, 7, 1])
  const withoutCaptain = at([4, 3, 2, 6, 7, 10])

  it('teamCaptainNumber reads the C of the roster', () => {
    expect(teamCaptainNumber(roster)).toBe('1')
    expect(teamCaptainNumber([P(5, { captain: true })])).toBe('5')
    expect(teamCaptainNumber([P(5)])).toBe(null)
  })

  it('lineupCaptainStatus: on court, off court, no captain', () => {
    expect(lineupCaptainStatus({ lineup: withCaptain, players: roster })).toBe('onCourt')
    expect(lineupCaptainStatus({ lineup: withoutCaptain, players: roster })).toBe('offCourt')
    expect(lineupCaptainStatus({ lineup: ['01', '', '', '', '', ''], players: roster })).toBe('onCourt')
    expect(lineupCaptainStatus({ lineup: withCaptain, players: roster.map(p => ({ ...p, isCaptain: false })) })).toBe('noCaptain')
  })

  it('offers the valid boxes only, without the team captain, sorted', () => {
    expect(gameCaptainOptions({ lineup: withCaptain, players: roster })).toEqual(['2', '3', '4', '6', '7'])
    expect(gameCaptainOptions({ lineup: withoutCaptain, players: roster })).toEqual(['2', '3', '4', '6', '7', '10'])
  })

  it('never offers a libero, a duplicate, an unknown number or an empty box', () => {
    // III = 12 (libero), II and V = 6 (duplicate), VI = 99 (not on roster), I empty
    const lineup = ['4', '12', '6', '6', '99', '']
    expect(gameCaptainOptions({ lineup, players: roster })).toEqual(['4'])
  })

  it('never offers a disqualified player', () => {
    const events = [{ type: 'sanction', payload: { team: 'home', playerNumber: 3, type: 'disqualification' } }]
    expect(gameCaptainOptions({ lineup: withoutCaptain, players: roster, events, team: 'home' })).not.toContain('3')
  })

  it('offers nothing when the roster has no team captain', () => {
    const noC = roster.map(p => ({ ...p, isCaptain: false }))
    expect(gameCaptainOptions({ lineup: withoutCaptain, players: noC })).toEqual([])
  })

  it('empty choice keeps today\'s behaviour (prompt later)', () => {
    for (const choice of ['', null, undefined]) {
      expect(lineupGameCaptainDecision({ lineup: withoutCaptain, players: roster, team: 'home', choice }))
        .toEqual({ action: 'none', playerNumber: null, matchUpdate: {}, event: null, undo: {} })
    }
  })

  it('a choice that is no longer valid is ignored', () => {
    // 5 is not in the line-up; 1 is the team captain himself; 12 is the libero
    for (const choice of ['5', '1', '12']) {
      expect(lineupGameCaptainDecision({ lineup: withoutCaptain, players: roster, team: 'home', choice }).action).toBe('none')
    }
  })

  it('captain NOT among the six: designate from the first rally (field + remembered + event)', () => {
    const d = lineupGameCaptainDecision({ lineup: withoutCaptain, players: roster, team: 'home', choice: '7' })
    expect(d).toEqual({
      action: 'designate',
      playerNumber: 7,
      matchUpdate: { homeCourtCaptain: 7, homeRememberedCourtCaptain: 7 },
      event: { team: 'home', playerNumber: 7, previousCourtCaptain: null, previousRememberedCourtCaptain: null, fromLineup: true },
      undo: { previousRememberedCourtCaptain: null }
    })
  })

  it('designate keeps the previous game captain in the event, for undo', () => {
    const d = lineupGameCaptainDecision({ lineup: withoutCaptain, players: roster, team: 'away', choice: '10', currentCourtCaptain: 4, rememberedCourtCaptain: 4 })
    expect(d.matchUpdate).toEqual({ awayCourtCaptain: 10, awayRememberedCourtCaptain: 10 })
    expect(d.event).toEqual({ team: 'away', playerNumber: 10, previousCourtCaptain: 4, previousRememberedCourtCaptain: 4, fromLineup: true })
    expect(d.undo).toEqual({ previousRememberedCourtCaptain: 4 })
  })

  it('designate of the player already acting as game captain logs no second event', () => {
    const d = lineupGameCaptainDecision({ lineup: withoutCaptain, players: roster, team: 'home', choice: '7', currentCourtCaptain: 7, rememberedCourtCaptain: '7' })
    expect(d).toEqual({ action: 'designate', playerNumber: 7, matchUpdate: {}, event: null, undo: {} })
  })

  it('captain among the six: only remembered for when the captain leaves the court', () => {
    const d = lineupGameCaptainDecision({ lineup: withCaptain, players: roster, team: 'home', choice: '3', currentCourtCaptain: 6 })
    expect(d).toEqual({ action: 'remember', playerNumber: 3, matchUpdate: { homeRememberedCourtCaptain: 3 }, event: null, undo: { previousRememberedCourtCaptain: null } })
    const same = lineupGameCaptainDecision({ lineup: withCaptain, players: roster, team: 'home', choice: '3', rememberedCourtCaptain: 3 })
    expect(same.matchUpdate).toEqual({})
    expect(same.undo).toEqual({})
  })

  it('initial choice for an existing line-up: acting game captain, else the remembered one', () => {
    const base = { players: roster, team: 'home' }
    expect(initialGameCaptainChoice({ ...base, lineup: withoutCaptain, currentCourtCaptain: 10, rememberedCourtCaptain: 4 })).toBe('10')
    expect(initialGameCaptainChoice({ ...base, lineup: withoutCaptain, currentCourtCaptain: null, rememberedCourtCaptain: 4 })).toBe('4')
    // captain on court: the acting one does not count, only the remembered one
    expect(initialGameCaptainChoice({ ...base, lineup: withCaptain, currentCourtCaptain: 6, rememberedCourtCaptain: null })).toBe('')
    expect(initialGameCaptainChoice({ ...base, lineup: withCaptain, rememberedCourtCaptain: 6 })).toBe('6')
    // not an option (not in the six)
    expect(initialGameCaptainChoice({ ...base, lineup: withoutCaptain, currentCourtCaptain: 5 })).toBe('')
  })

  it('undo record: the remembered game captain the choice replaced', () => {
    const d = lineupGameCaptainDecision({ lineup: withCaptain, players: roster, team: 'away', choice: '4', rememberedCourtCaptain: 6 })
    expect(d.matchUpdate).toEqual({ awayRememberedCourtCaptain: 4 })
    expect(d.undo).toEqual({ previousRememberedCourtCaptain: 6 })
  })
})
