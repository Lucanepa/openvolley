// An expulsion bars the player for the set only (FIVB 21.3.2), also when he
// was replaced by an exceptional substitution beyond the 6 (15.8). Only a
// disqualification (21.3.3) or an exceptional substitution of an injured
// player (15.7) keeps him out for the rest of the match. Every rule that asks
// "may this player play" agrees: the line-up entry, the next-set count, the
// Rosters dialog and the substitution guard. And a typed line-up number is
// checked against an expulsion of the same set.
import { describe, it, expect } from 'vitest'
import { substitutionBarsForMatch } from '../substitutions'
import { lineupEntryErrors, lineupCandidates, LINEUP_ERRORS } from '../lineupEntry'
import { playersAvailableForNextSet } from '../matchEnd'
import { playerPlayStatus } from '../rosterLive'
import { isSentOff, isForcedSubstitution } from '../interruptionRequests'

const P = (number, extra = {}) => ({ number, libero: '', isCaptain: false, ...extra })
// seven players and a libero
const roster = [P(1), P(2), P(3), P(4), P(5), P(6), P(8), P(12, { libero: 'libero1' })]
// [IV, III, II, V, VI, I]
const at = (values) => values.map(v => (v == null ? '' : String(v)))

const sub = (setIndex, playerOut, playerIn, flags = {}) => ({
  type: 'substitution', setIndex, seq: 10, payload: { team: 'home', position: 'IV', playerOut, playerIn, isExceptional: false, isExpelled: false, isDisqualified: false, ...flags }
})
const sanction = (setIndex, playerNumber, type) => ({
  type: 'sanction', setIndex, seq: 9, payload: { team: 'home', type, playerType: 'player', playerNumber, position: 'IV' }
})

// Set 3: #4 expelled, the 6 regular substitutions used: replaced exceptionally by #8
const expelledExceptionally = [sanction(3, 4, 'expulsion'), sub(3, 4, 8, { isExpelled: true, isExceptional: true })]
// Set 3: #4 injured, replaced exceptionally by #8
const injuredExceptionally = [sub(3, 4, 8, { isExceptional: true, autoRemark: 'Set 3, B 12:10, #4 substituted due to injury' })]

describe('substitutionBarsForMatch', () => {
  it('a disqualification or an injury exceptional substitution: out for the match', () => {
    expect(substitutionBarsForMatch({ isDisqualified: true })).toBe(true)
    expect(substitutionBarsForMatch({ isDisqualified: true, isExceptional: true })).toBe(true)
    expect(substitutionBarsForMatch({ isExceptional: true })).toBe(true)
  })

  it('an expulsion, exceptional or not, and a regular substitution: not', () => {
    expect(substitutionBarsForMatch({ isExpelled: true, isExceptional: true })).toBe(false)
    expect(substitutionBarsForMatch({ isExpelled: true })).toBe(false)
    expect(substitutionBarsForMatch({})).toBe(false)
    expect(substitutionBarsForMatch(null)).toBe(false)
  })
})

describe('line-up entry after an exceptional substitution (FIVB 15.7, 21.3.2)', () => {
  it('the player expelled in set 3 and replaced exceptionally is in the set 4 line-up', () => {
    const errors = lineupEntryErrors({ lineup: at([4, 3, 2, 5, 6, 1]), players: roster, events: expelledExceptionally, team: 'home', setIndex: 4 })
    expect(errors).toEqual({})
    const pool = lineupCandidates({ players: roster, lineup: at([null, 3, 2, 5, 6, 1]), events: expelledExceptionally, team: 'home', setIndex: 4 })
    expect(pool.map(p => p.number)).toEqual([4, 8])
  })

  it('the injured player replaced exceptionally stays out', () => {
    const errors = lineupEntryErrors({ lineup: at([4, 3, 2, 5, 6, 1]), players: roster, events: injuredExceptionally, team: 'home', setIndex: 4 })
    expect(errors).toStrictEqual({ 0: LINEUP_ERRORS.exceptionallySubstituted })
    const pool = lineupCandidates({ players: roster, lineup: at([null, 3, 2, 5, 6, 1]), events: injuredExceptionally, team: 'home', setIndex: 4 })
    expect(pool.map(p => p.number)).toEqual([8])
  })
})

describe('a typed line-up number expelled in that set (FIVB 21.3.2, 21.5)', () => {
  // the expulsion in the interval before set 3 is recorded in set 3
  const events = [sanction(3, 4, 'expulsion')]

  it('is flagged expelled, so the line-up cannot be saved', () => {
    const errors = lineupEntryErrors({ lineup: at([4, 3, 2, 5, 6, 1]), players: roster, events, team: 'home', setIndex: 3 })
    expect(errors).toStrictEqual({ 0: 'expelled' })
  })

  it('also in an easy match, where any number may be typed', () => {
    const errors = lineupEntryErrors({ lineup: at([4, 3, 2, 5, 6, 1]), players: [], events, team: 'home', setIndex: 3, allowUnknown: true })
    expect(errors).toStrictEqual({ 0: 'expelled' })
  })

  it('the next set he may play again', () => {
    expect(lineupEntryErrors({ lineup: at([4, 3, 2, 5, 6, 1]), players: roster, events, team: 'home', setIndex: 4 })).toEqual({})
  })

  it('the other team is not concerned', () => {
    expect(lineupEntryErrors({ lineup: at([4, 3, 2, 5, 6, 1]), players: roster, events, team: 'away', setIndex: 3 })).toEqual({})
  })
})

describe('players for the next set (forfeit scope)', () => {
  it('counts the player expelled and replaced exceptionally', () => {
    const events = [...expelledExceptionally, sanction(3, 5, 'disqualification')]
    // 7 players: #5 disqualified, #4 back next set -> 6 left, the set and not the match
    expect(playersAvailableForNextSet(roster, events, 'home').map(p => p.number)).toEqual([1, 2, 3, 4, 6, 8])
  })

  it('does not count the injured player replaced exceptionally', () => {
    expect(playersAvailableForNextSet(roster, injuredExceptionally, 'home').map(p => p.number)).toEqual([1, 2, 3, 5, 6, 8])
  })
})

describe('the Rosters dialog and the substitution guard', () => {
  it('expelled and replaced exceptionally: out in that set only', () => {
    expect(playerPlayStatus(expelledExceptionally, 'home', P(4), 3).out).toBe('expelled')
    expect(playerPlayStatus(expelledExceptionally, 'home', P(4), 4).out).toBe(null)
    expect(isSentOff(expelledExceptionally, 'home', 4, 3)).toBe(true)
    expect(isSentOff(expelledExceptionally, 'home', 4, 4)).toBe(false)
  })

  it('injured and replaced exceptionally: out for the match', () => {
    expect(playerPlayStatus(injuredExceptionally, 'home', P(4), 4).out).toBe('exceptional')
    expect(isSentOff(injuredExceptionally, 'home', 4, 4)).toBe(true)
  })
})

describe('an injury substitution is a forced one (CB 4.9)', () => {
  it('with isInjury', () => {
    expect(isForcedSubstitution(sub(2, 4, 9, { isInjury: true }))).toBe(true)
  })

  it('recorded before isInjury was stored: by its automatic remark', () => {
    expect(isForcedSubstitution(sub(2, 4, 9, { autoRemark: 'Set 2, A 10:8, #4 substituted due to injury' }))).toBe(true)
  })

  it('a regular one is not', () => {
    expect(isForcedSubstitution(sub(2, 4, 9))).toBe(false)
  })
})
