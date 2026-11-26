import { describe, it, expect } from 'vitest'
import { counterTone, counterPips, teamSanctionsForDisplay, TIMEOUT_LIMIT, SUBSTITUTION_LIMIT } from '../benchLayout.js'

describe('counterTone', () => {
  it('marks a used-up limit', () => {
    expect(counterTone(2, TIMEOUT_LIMIT)).toBe('max')
    expect(counterTone(6, SUBSTITUTION_LIMIT, { warnNear: true })).toBe('max')
    expect(counterTone(7, SUBSTITUTION_LIMIT)).toBe('max')
  })
  it('warns one before the limit only when asked (the fifth substitution)', () => {
    expect(counterTone(5, SUBSTITUTION_LIMIT, { warnNear: true })).toBe('near')
    expect(counterTone(1, TIMEOUT_LIMIT)).toBe(null)
    expect(counterTone(4, SUBSTITUTION_LIMIT, { warnNear: true })).toBe(null)
  })
  it('reads a missing count as none used', () => {
    expect(counterTone(undefined, TIMEOUT_LIMIT)).toBe(null)
  })
})

describe('counterPips', () => {
  it('fills one pip per used request', () => {
    expect(counterPips(1, 2)).toEqual([true, false])
    expect(counterPips(0, 6)).toEqual([false, false, false, false, false, false])
  })
  it('never draws more pips than the limit', () => {
    expect(counterPips(9, 2)).toEqual([true, true])
    expect(counterPips(-1, 2)).toEqual([false, false])
  })
})

describe('teamSanctionsForDisplay', () => {
  const s = (payload, extra = {}) => ({ type: 'sanction', setIndex: 1, payload, ...extra })

  it("lists the team's sanctions once each, in event order", () => {
    const events = [
      s({ team: 'home', type: 'warning', playerType: 'official', role: 'Coach' }, { id: 1, seq: 1 }),
      s({ team: 'away', type: 'penalty', playerType: 'player', playerNumber: 4 }, { id: 2, seq: 2 }),
      { type: 'point', setIndex: 1, id: 3, seq: 3, payload: { team: 'home' } },
      s({ team: 'home', type: 'penalty', playerType: 'player', playerNumber: '14' }, { id: 4, seq: 4 }),
      s({ team: 'home', type: 'warning', playerType: 'official', role: 'Coach' }, { id: 1, seq: 1 })
    ]
    expect(teamSanctionsForDisplay(events, 'home').map(x => [x.type, x.number ?? x.role, x.sanctionType])).toEqual([
      ['team', 'Coach', 'warning'],
      ['player', '14', 'penalty']
    ])
  })

  it('a delay (also an old row with "D" as the number), an improper request and a team sanction', () => {
    const events = [
      s({ team: 'home', type: 'delay_warning' }, { seq: 1 }),
      s({ team: 'home', type: 'penalty', playerNumber: 'D' }, { seq: 2 }),
      s({ team: 'home', type: 'improper_request' }, { seq: 3 }),
      s({ team: 'home', type: 'warning', playerType: 'team' }, { seq: 4 })
    ]
    expect(teamSanctionsForDisplay(events, 'home').map(x => [x.type, x.role, !!x.delay, x.sanctionType])).toEqual([
      ['team', 'Team', false, 'delay_warning'],
      ['team', 'Team', true, 'penalty'],
      ['team', 'Team', false, 'improper_request'],
      ['team', 'Team', false, 'warning']
    ])
  })

  it('a live-state projection (no id, no seq): one item per recorded sanction', () => {
    const events = [
      s({ team: 'home', type: 'warning', playerType: 'player', playerNumber: 7 }, { ts: 'a' }),
      s({ team: 'home', type: 'warning', playerType: 'player', playerNumber: 7 }, { ts: 'a' }),
      s({ team: 'home', type: 'delay_penalty' }, { ts: 'b' }),
      s({ team: 'home', type: 'delay_penalty' }, { ts: 'c' })
    ]
    expect(teamSanctionsForDisplay(events, 'home').map(x => x.sanctionType)).toEqual(['warning', 'delay_penalty', 'delay_penalty'])
  })

  it('no events: none', () => {
    expect(teamSanctionsForDisplay(undefined, 'home')).toEqual([])
  })

  // A playing coach (domain/playerOfficials): each sanction where it was
  // given, once; the coach's records his number (plays) and stays the coach's
  it('a playing coach: #7 and C each once, where given', () => {
    const events = [
      s({ team: 'home', type: 'warning', playerType: 'player', playerNumber: 7 }, { id: 1, seq: 1 }),
      s({ team: 'home', type: 'penalty', playerType: 'official', role: 'Coach', plays: 7 }, { id: 2, seq: 2 })
    ]
    expect(teamSanctionsForDisplay(events, 'home').map(x => [x.type, x.number ?? x.role, x.sanctionType])).toEqual([
      ['player', 7, 'warning'],
      ['team', 'Coach', 'penalty']
    ])
  })
})
