import { describe, it, expect } from 'vitest'
import {
  nextDelaySanction,
  improperRequestConsequence,
  resolveSanction,
  isDelaySanction,
  awardsPoint,
  deriveTeamSanctionFlags,
  deferredPenaltyPoints,
} from '../sanctions'

describe('nextDelaySanction (FIVB 16.2)', () => {
  it('first delay in the match is a warning', () => {
    expect(nextDelaySanction(0)).toBe('delay_warning')
  })
  it('every subsequent delay is a penalty', () => {
    expect(nextDelaySanction(1)).toBe('delay_penalty')
    expect(nextDelaySanction(2)).toBe('delay_penalty')
    expect(nextDelaySanction(5)).toBe('delay_penalty')
  })
})

describe('improperRequestConsequence (FIVB 15.11)', () => {
  it('first improper request is recorded with no other consequence', () => {
    expect(improperRequestConsequence(0, 0)).toBe('improper_request')
  })
  it('a second improper request becomes a delay (enters the ladder)', () => {
    // no prior delay -> the delay is a warning
    expect(improperRequestConsequence(1, 0)).toBe('delay_warning')
    // team already had a delay -> the delay is a penalty
    expect(improperRequestConsequence(1, 1)).toBe('delay_penalty')
    expect(improperRequestConsequence(2, 2)).toBe('delay_penalty')
  })
})

describe('resolveSanction (enforces the ladder from scorer intent + history)', () => {
  it('a requested delay is forced to a warning first, penalty after', () => {
    expect(resolveSanction('delay_penalty', { priorDelayCount: 0 })).toBe('delay_warning')
    expect(resolveSanction('delay_warning', { priorDelayCount: 1 })).toBe('delay_penalty')
  })
  it('a first improper request stays an improper request', () => {
    expect(resolveSanction('improper_request', { priorImproperCount: 0 })).toBe('improper_request')
  })
  it('a repeat improper request escalates through the delay ladder', () => {
    expect(resolveSanction('improper_request', { priorImproperCount: 1, priorDelayCount: 0 })).toBe('delay_warning')
    expect(resolveSanction('improper_request', { priorImproperCount: 1, priorDelayCount: 1 })).toBe('delay_penalty')
  })
  it('passes through unrelated types unchanged', () => {
    expect(resolveSanction('penalty', {})).toBe('penalty')
  })
})

describe('helpers', () => {
  it('isDelaySanction', () => {
    expect(isDelaySanction('delay_warning')).toBe(true)
    expect(isDelaySanction('delay_penalty')).toBe(true)
    expect(isDelaySanction('improper_request')).toBe(false)
  })
  it('awardsPoint: only delay_penalty and misconduct penalty award a point', () => {
    expect(awardsPoint('delay_penalty')).toBe(true)
    expect(awardsPoint('penalty')).toBe(true)
    expect(awardsPoint('delay_warning')).toBe(false)
    expect(awardsPoint('improper_request')).toBe(false)
  })
})

describe('deriveTeamSanctionFlags', () => {
  const sanc = (team, type) => ({ type: 'sanction', payload: { team, type } })
  it('all false with no sanctions', () => {
    expect(deriveTeamSanctionFlags([])).toEqual({ improperRequestHome: false, improperRequestAway: false, delayWarningHome: false, delayWarningAway: false })
  })
  it('flags follow the events per team', () => {
    const flags = deriveTeamSanctionFlags([sanc('home', 'improper_request'), sanc('away', 'delay_warning')])
    expect(flags).toEqual({ improperRequestHome: true, improperRequestAway: false, delayWarningHome: false, delayWarningAway: true })
  })
  it('a delay penalty also means the warning is used', () => {
    expect(deriveTeamSanctionFlags([sanc('home', 'delay_penalty')]).delayWarningHome).toBe(true)
  })
  it('individual sanctions do not set team flags', () => {
    const flags = deriveTeamSanctionFlags([sanc('home', 'warning'), sanc('away', 'penalty'), { type: 'timeout', payload: { team: 'home' } }])
    expect(Object.values(flags).some(Boolean)).toBe(false)
  })
  it('removing the event (undo / manual delete) clears the flag', () => {
    const events = [sanc('home', 'delay_warning')]
    expect(deriveTeamSanctionFlags(events).delayWarningHome).toBe(true)
    expect(deriveTeamSanctionFlags(events.slice(1)).delayWarningHome).toBe(false)
  })
})

describe('deferredPenaltyPoints (FIVB 16.2.3 / 21.3.1: a penalty gives the opponent a point)', () => {
  // A penalty given before both starting line-ups are in is recorded first;
  // its point is awarded when the second line-up is saved.
  const lineup = (id, team, setIndex = 2) => ({ id, seq: id, setIndex, type: 'lineup', payload: { team, lineup: {}, isInitial: true } })
  const sanction = (id, team, type, setIndex = 2) => ({ id, seq: id, setIndex, type: 'sanction', payload: { team, type } })

  it('nothing is due until both starting line-ups of the set are in', () => {
    const events = [sanction(1, 'away', 'delay_penalty'), lineup(2, 'home')]
    expect(deferredPenaltyPoints(events, 2)).toEqual([])
    // the second line-up, once it is part of the events, makes the point due
    expect(deferredPenaltyPoints([...events, lineup(3, 'away')], 2)).toEqual(['home'])
  })

  it('one point to the opponent per penalty and delay penalty, in order; warnings give none', () => {
    const events = [
      lineup(1, 'home'), lineup(2, 'away'),
      sanction(3, 'home', 'penalty'),
      sanction(4, 'home', 'warning'),
      sanction(5, 'away', 'delay_warning'),
      sanction(6, 'away', 'delay_penalty')
    ]
    expect(deferredPenaltyPoints(events, 2)).toEqual(['away', 'home'])
  })

  it('nothing once the set has a point (the points were given), and other sets do not count', () => {
    const due = [lineup(1, 'home'), lineup(2, 'away'), sanction(3, 'away', 'penalty')]
    expect(deferredPenaltyPoints([...due, { id: 4, seq: 4, setIndex: 2, type: 'point', payload: { team: 'home' } }], 2)).toEqual([])
    expect(deferredPenaltyPoints([...due, sanction(5, 'home', 'penalty', 1)], 2)).toEqual(['home'])
    expect(deferredPenaltyPoints(due, 3)).toEqual([])
    // a corrected (non-initial) line-up does not stand for a starting line-up
    const corrected = { ...lineup(2, 'away'), payload: { team: 'away', lineup: {}, isInitial: false } }
    expect(deferredPenaltyPoints([lineup(1, 'home'), corrected, sanction(3, 'away', 'penalty')], 2)).toEqual([])
  })
})
