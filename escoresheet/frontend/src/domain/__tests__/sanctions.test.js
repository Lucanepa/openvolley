import { describe, it, expect } from 'vitest'
import {
  nextDelaySanction,
  improperRequestConsequence,
  resolveSanction,
  isDelaySanction,
  awardsPoint,
  deriveTeamSanctionFlags,
  deferredPenaltyPoints,
  penaltyOfPoint,
  validateMemberSanction,
  heaviestMemberSanction,
  memberSanctionOptions,
  MEMBER_SANCTION_SCALE,
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
    expect(deferredPenaltyPoints([...events, lineup(3, 'away')], 2)).toEqual([{ team: 'home', penaltySeq: 1 }])
  })

  it('one point to the opponent per penalty and delay penalty, in order; warnings give none', () => {
    const events = [
      lineup(1, 'home'), lineup(2, 'away'),
      sanction(3, 'home', 'penalty'),
      sanction(4, 'home', 'warning'),
      sanction(5, 'away', 'delay_warning'),
      sanction(6, 'away', 'delay_penalty')
    ]
    expect(deferredPenaltyPoints(events, 2)).toEqual([{ team: 'away', penaltySeq: 3 }, { team: 'home', penaltySeq: 6 }])
  })

  it('nothing once the set has a point (the points were given), and other sets do not count', () => {
    const due = [lineup(1, 'home'), lineup(2, 'away'), sanction(3, 'away', 'penalty')]
    expect(deferredPenaltyPoints([...due, { id: 4, seq: 4, setIndex: 2, type: 'point', payload: { team: 'home' } }], 2)).toEqual([])
    expect(deferredPenaltyPoints([...due, sanction(5, 'home', 'penalty', 1)], 2)).toEqual([{ team: 'home', penaltySeq: 3 }])
    expect(deferredPenaltyPoints(due, 3)).toEqual([])
    // a corrected (non-initial) line-up does not stand for a starting line-up
    const corrected = { ...lineup(2, 'away'), payload: { team: 'away', lineup: {}, isInitial: false } }
    expect(deferredPenaltyPoints([lineup(1, 'home'), corrected, sanction(3, 'away', 'penalty')], 2)).toEqual([])
  })
})

describe('penaltyOfPoint (Undo takes a penalty back with its point)', () => {
  const sanction = (seq, team, type, setIndex = 1) => ({ id: seq, seq, setIndex, type: 'sanction', payload: { team, type } })
  const point = (seq, team, penaltySeq, setIndex = 1) => ({ id: seq, seq, setIndex, type: 'point', payload: { team, ...(penaltySeq !== undefined ? { penaltySeq } : {}) } })

  it('finds the penalty or delay penalty the point names', () => {
    const events = [sanction(10, 'home', 'penalty'), point(11, 'away', 10), sanction(12, 'away', 'delay_penalty'), point(13, 'home', 12)]
    expect(penaltyOfPoint(events, events[1])).toBe(events[0])
    expect(penaltyOfPoint(events, events[3])).toBe(events[2])
  })

  it('null for a rally point, an unlinked (older or deferred) penalty point and a link that does not fit', () => {
    const events = [sanction(10, 'home', 'penalty'), point(11, 'away'), sanction(12, 'home', 'warning'), sanction(14, 'home', 'penalty', 2)]
    expect(penaltyOfPoint(events, events[1])).toBeNull()
    // a warning gives no point, a penalty of the scoring team or another set is not this point's
    expect(penaltyOfPoint(events, point(13, 'away', 12))).toBeNull()
    expect(penaltyOfPoint(events, point(13, 'home', 10))).toBeNull()
    expect(penaltyOfPoint(events, point(13, 'away', 14))).toBeNull()
    expect(penaltyOfPoint(events, events[0])).toBeNull()
    expect(penaltyOfPoint(events, null)).toBeNull()
  })
})

describe('member sanctions are progressive (FIVB 21.3 scale, 21.4.2)', () => {
  const player = (seq, setIndex, team, playerNumber, type, playerType = 'player') => ({ seq, setIndex, type: 'sanction', payload: { team, type, playerType, playerNumber } })
  const official = (seq, setIndex, team, role, type) => ({ seq, setIndex, type: 'sanction', payload: { team, type, playerType: 'official', role } })
  const legalTypes = (events, member) => Object.entries(memberSanctionOptions(events, member)).filter(([, v]) => v.legal).map(([k]) => k)

  it('the scale runs warning < penalty < expulsion < disqualification', () => {
    expect(MEMBER_SANCTION_SCALE).toEqual(['warning', 'penalty', 'expulsion', 'disqualification'])
  })

  it('heaviestMemberSanction: the heaviest of the member, by number or by role', () => {
    const events = [player(1, 1, 'away', 6, 'expulsion'), player(2, 2, 'away', 6, 'warning'), official(3, 1, 'away', 'Coach', 'penalty'), player(4, 1, 'away', 7, 'delay_warning')]
    expect(heaviestMemberSanction(events, { team: 'away', playerNumber: 6 })).toBe('expulsion')
    expect(heaviestMemberSanction(events, { team: 'away', playerNumber: '6' })).toBe('expulsion')
    expect(heaviestMemberSanction(events, { team: 'away', role: 'Coach' })).toBe('penalty')
    expect(heaviestMemberSanction(events, { team: 'home', playerNumber: 6 })).toBeNull()
    expect(heaviestMemberSanction(events, { team: 'away', playerNumber: 7 })).toBeNull() // a delay is a team sanction
    expect(heaviestMemberSanction(null, { team: 'away', playerNumber: 6 })).toBeNull()
  })

  it('expelled in set 1: in set 2 only a disqualification is left, never a penalty (the 21.11 test, away #6)', () => {
    const events = [player(10, 1, 'away', 6, 'expulsion')]
    expect(validateMemberSanction(events, { team: 'away', playerNumber: 6, type: 'penalty' })).toEqual({ legal: false, reason: 'lighterSanction', heaviest: 'expulsion' })
    expect(validateMemberSanction(events, { team: 'away', playerNumber: 6, type: 'warning' })).toEqual({ legal: false, reason: 'lighterSanction', heaviest: 'expulsion' })
    expect(validateMemberSanction(events, { team: 'away', playerNumber: 6, type: 'expulsion' })).toEqual({ legal: false, reason: 'sameSanctionTwice' })
    expect(validateMemberSanction(events, { team: 'away', playerNumber: 6, type: 'disqualification' })).toEqual({ legal: true })
    expect(legalTypes(events, { team: 'away', playerNumber: 6 })).toEqual(['disqualification'])
  })

  it('after a penalty: expulsion or disqualification, no warning even while the team is not warned', () => {
    const events = [player(3, 1, 'away', 5, 'penalty')]
    expect(legalTypes(events, { team: 'away', playerNumber: 5 })).toEqual(['expulsion', 'disqualification'])
    // another member of the team may still be warned
    expect(legalTypes(events, { team: 'away', playerNumber: 4 })).toEqual(['warning', 'penalty', 'expulsion', 'disqualification'])
  })

  it('after a warning: anything heavier; the team warning is spent for everyone (one per team per match)', () => {
    const events = [player(2, 1, 'home', 5, 'warning')]
    expect(legalTypes(events, { team: 'home', playerNumber: 5 })).toEqual(['penalty', 'expulsion', 'disqualification'])
    expect(validateMemberSanction(events, { team: 'home', playerNumber: 7, type: 'warning' })).toEqual({ legal: false, reason: 'teamAlreadyWarned' })
    expect(legalTypes(events, { team: 'home', playerNumber: 7 })).toEqual(['penalty', 'expulsion', 'disqualification'])
    expect(legalTypes(events, { team: 'away', playerNumber: 7 })).toEqual(['warning', 'penalty', 'expulsion', 'disqualification'])
  })

  it('an expulsion or disqualification needs no earlier sanction (21.4.3); a disqualified member gets nothing more', () => {
    expect(legalTypes([], { team: 'home', playerNumber: 9 })).toEqual(['warning', 'penalty', 'expulsion', 'disqualification'])
    expect(legalTypes([player(4, 2, 'home', 9, 'disqualification')], { team: 'home', playerNumber: 9 })).toEqual([])
  })

  it('applies to bench officials by role and to liberos and bench players by number, match-wide', () => {
    const events = [official(5, 1, 'away', 'Coach', 'expulsion'), player(6, 1, 'away', 1, 'penalty', 'libero'), player(7, 2, 'away', 10, 'penalty', 'bench')]
    expect(legalTypes(events, { team: 'away', role: 'Coach' })).toEqual(['disqualification'])
    expect(legalTypes(events, { team: 'away', role: 'Assistant Coach 1' })).toEqual(['warning', 'penalty', 'expulsion', 'disqualification'])
    expect(legalTypes(events, { team: 'away', playerNumber: 1 })).toEqual(['expulsion', 'disqualification'])
    // set 4: the set-2 penalty still counts
    expect(validateMemberSanction(events, { team: 'away', playerNumber: 10, type: 'warning' })).toEqual({ legal: false, reason: 'lighterSanction', heaviest: 'penalty' })
  })

  it('team delay sanctions and improper requests stay out of the member scale', () => {
    const events = [{ seq: 1, setIndex: 1, type: 'sanction', payload: { team: 'home', type: 'delay_penalty' } }, { seq: 2, setIndex: 1, type: 'sanction', payload: { team: 'home', type: 'improper_request' } }]
    expect(legalTypes(events, { team: 'home', playerNumber: 3 })).toEqual(['warning', 'penalty', 'expulsion', 'disqualification'])
    expect(validateMemberSanction([player(1, 1, 'home', 3, 'expulsion')], { team: 'home', playerNumber: 3, type: 'delay_warning' })).toEqual({ legal: true })
  })
})
