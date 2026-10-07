import { describe, it, expect } from 'vitest'
import {
  isMatchOverStatus,
  POST_MATCH_SIGNATURE_FIELDS,
  clearedPostMatchSignatures,
  countSetsWon,
  getMatchWinner,
  findPreviousSet,
  forfeitSetPoints,
  planForfeit,
  forfeitScope,
  playersAvailableForNextSet,
  planForfeitReversal
} from '../matchEnd'

const set = (index, homePoints, awayPoints, finished = true, id = index * 10) =>
  ({ id, index, homePoints, awayPoints, finished })

describe('isMatchOverStatus', () => {
  it('ended, approved and final are over', () => {
    expect(isMatchOverStatus('ended')).toBe(true)
    expect(isMatchOverStatus('approved')).toBe(true)
    expect(isMatchOverStatus('final')).toBe(true)
  })
  it('live, setup and missing are not', () => {
    expect(isMatchOverStatus('live')).toBe(false)
    expect(isMatchOverStatus('setup')).toBe(false)
    expect(isMatchOverStatus(undefined)).toBe(false)
  })
})

describe('post-match signatures', () => {
  it('lists the field names MatchEnd reads and writes', () => {
    expect(POST_MATCH_SIGNATURE_FIELDS).toEqual([
      'homePostGameCaptainSignature',
      'awayPostGameCaptainSignature',
      'asstScorerSignature',
      'scorerSignature',
      'ref2Signature',
      'ref1Signature'
    ])
  })
  it('clearedPostMatchSignatures nulls every one of them, their "signed on phone" records, and the account approvals', () => {
    const cleared = clearedPostMatchSignatures()
    expect(Object.keys(cleared)).toEqual([
      ...POST_MATCH_SIGNATURE_FIELDS,
      ...POST_MATCH_SIGNATURE_FIELDS.map(f => `signatureSources.${f}`),
      'accountApprovals'
    ])
    expect(cleared.accountApprovals).toBeNull()
    expect(Object.values(cleared).every(v => v === null)).toBe(true)
  })
})

describe('countSetsWon / getMatchWinner', () => {
  it('counts finished sets only', () => {
    expect(countSetsWon([set(1, 25, 20), set(2, 10, 12, false)])).toEqual({ home: 1, away: 0 })
  })
  it('winner is the team that reached the sets needed (bo5)', () => {
    expect(getMatchWinner([set(1, 25, 20), set(2, 25, 20), set(3, 25, 20)], 5)).toBe('home')
    expect(getMatchWinner([set(1, 20, 25), set(2, 25, 20), set(3, 20, 25), set(4, 20, 25)], 5)).toBe('away')
  })
  it('winner in bo3 after 2 sets', () => {
    expect(getMatchWinner([set(1, 20, 25), set(2, 20, 25)], 3)).toBe('away')
  })
  it('a sets tie (stopped match) has no winner', () => {
    expect(getMatchWinner([set(1, 25, 20), set(2, 20, 25), set(3, 10, 8, false)], 5)).toBeNull()
  })
  it('a lead without the sets needed has no winner', () => {
    expect(getMatchWinner([set(1, 25, 20), set(2, 25, 20)], 5)).toBeNull()
  })
  it('forfeit gives the match to the opponent regardless of sets', () => {
    expect(getMatchWinner([set(1, 25, 20)], 5, { forfeitTeam: 'away' })).toBe('home')
    expect(getMatchWinner([], 5, { forfeitTeam: 'home' })).toBe('away')
  })
})

describe('findPreviousSet', () => {
  it('finds index - 1 in a normal sequence', () => {
    expect(findPreviousSet([set(1, 25, 20), set(2, 25, 20), set(3, 0, 0, false)], 3).index).toBe(2)
  })
  it('finds set 2 before the best-of-3 decider (index 5)', () => {
    expect(findPreviousSet([set(1, 25, 20), set(2, 20, 25), set(5, 0, 0, false)], 5).index).toBe(2)
  })
  it('returns null before set 1', () => {
    expect(findPreviousSet([set(1, 0, 0, false)], 1)).toBeNull()
  })
  it('does not depend on array order', () => {
    expect(findPreviousSet([set(2, 25, 20), set(4, 0, 0, false), set(1, 25, 20), set(3, 20, 25)], 4).index).toBe(3)
  })
})

describe('forfeitSetPoints', () => {
  it('25 in a regular set, 15 in the deciding set', () => {
    expect(forfeitSetPoints(10, 12, 1)).toBe(25)
    expect(forfeitSetPoints(3, 2, 5)).toBe(15)
  })
  it('keeps a 2-point lead over the forfeiting team at deuce', () => {
    expect(forfeitSetPoints(24, 20, 2)).toBe(26)
    expect(forfeitSetPoints(27, 27, 3)).toBe(29)
    expect(forfeitSetPoints(14, 14, 5)).toBe(16)
  })
})

describe('planForfeit', () => {
  it('bo5, forfeit in set 1: awards set 1 and creates sets 2 and 3', () => {
    const plan = planForfeit({ sets: [set(1, 8, 5, false)], forfeitingTeam: 'home', currentSetIndex: 1, bestOf: 5 })
    expect(plan.winner).toBe('away')
    expect(plan.sets.map(s => s.index)).toEqual([1, 2, 3])
    expect(plan.sets[0]).toMatchObject({ id: 10, homePoints: 8, awayPoints: 25, awardedPoints: 20, isCurrent: true })
    expect(plan.sets[1]).toMatchObject({ id: null, homePoints: 0, awayPoints: 25, isCurrent: false })
    expect(plan.sets[2]).toMatchObject({ id: null, homePoints: 0, awayPoints: 25 })
  })

  it('bo5 at 2-1 for the opponent: only the current set is needed', () => {
    const sets = [set(1, 20, 25), set(2, 25, 20), set(3, 20, 25), set(4, 3, 4, false)]
    const plan = planForfeit({ sets, forfeitingTeam: 'home', currentSetIndex: 4, bestOf: 5 })
    expect(plan.sets.map(s => s.index)).toEqual([4])
  })

  it('bo5 at 2-1 for the forfeiting team: sets 4 and 5 (to 15)', () => {
    const sets = [set(1, 25, 20), set(2, 25, 20), set(3, 20, 25), set(4, 3, 4, false)]
    const plan = planForfeit({ sets, forfeitingTeam: 'home', currentSetIndex: 4, bestOf: 5 })
    expect(plan.sets.map(s => s.index)).toEqual([4, 5])
    expect(plan.sets[1]).toMatchObject({ homePoints: 0, awayPoints: 15 })
  })

  it('bo3 at 1-0 for the forfeiting team: set 2 then the decider at index 5', () => {
    const sets = [set(1, 25, 20), set(2, 10, 10, false)]
    const plan = planForfeit({ sets, forfeitingTeam: 'home', currentSetIndex: 2, bestOf: 3 })
    expect(plan.sets.map(s => s.index)).toEqual([2, 5])
    expect(plan.sets[1]).toMatchObject({ homePoints: 0, awayPoints: 15 })
  })

  it('bo3 forfeit in set 1 creates set 2 only', () => {
    const plan = planForfeit({ sets: [set(1, 0, 0, false)], forfeitingTeam: 'away', currentSetIndex: 1, bestOf: 3 })
    expect(plan.winner).toBe('home')
    expect(plan.sets.map(s => s.index)).toEqual([1, 2])
    expect(plan.sets[0]).toMatchObject({ homePoints: 25, awayPoints: 0 })
  })

  it('forfeiting team keeps its points; deuce gets a 2-point lead', () => {
    const plan = planForfeit({ sets: [set(1, 25, 24, false)], forfeitingTeam: 'home', currentSetIndex: 1, bestOf: 3 })
    expect(plan.sets[0]).toMatchObject({ homePoints: 25, awayPoints: 27, awardedPoints: 3 })
  })

  it('reuses an existing unfinished later set row instead of creating it', () => {
    const sets = [set(1, 5, 5, false), set(2, 0, 0, false, 99)]
    const plan = planForfeit({ sets, forfeitingTeam: 'home', currentSetIndex: 1, bestOf: 3 })
    expect(plan.sets[1]).toMatchObject({ index: 2, id: 99 })
  })

  it('no set in progress (current already finished): continues after the last finished set', () => {
    const sets = [set(1, 25, 20), set(2, 20, 25)]
    const plan = planForfeit({ sets, forfeitingTeam: 'away', currentSetIndex: 2, bestOf: 3 })
    expect(plan.sets.map(s => s.index)).toEqual([5])
    expect(plan.winner).toBe('home')
  })

  it('never plans past set 5', () => {
    const plan = planForfeit({ sets: [set(1, 0, 0, false)], forfeitingTeam: 'home', currentSetIndex: 1, bestOf: 5 })
    expect(Math.max(...plan.sets.map(s => s.index))).toBeLessThanOrEqual(5)
  })
})

describe('planForfeit setOnly (incomplete for the set)', () => {
  it('awards only the set in progress, even when more sets would be needed', () => {
    const plan = planForfeit({ sets: [set(1, 8, 5, false)], forfeitingTeam: 'home', currentSetIndex: 1, bestOf: 5, setOnly: true })
    expect(plan.sets).toHaveLength(1)
    expect(plan.sets[0]).toMatchObject({ index: 1, id: 10, homePoints: 8, awayPoints: 25, awardedPoints: 20, isCurrent: true })
  })

  it('deciding set to 15 with a 2-point lead', () => {
    const sets = [set(1, 25, 20), set(2, 20, 25), set(5, 14, 13, false)]
    const plan = planForfeit({ sets, forfeitingTeam: 'home', currentSetIndex: 5, bestOf: 3, setOnly: true })
    expect(plan.sets).toEqual([expect.objectContaining({ index: 5, homePoints: 14, awayPoints: 16, awardedPoints: 3 })])
  })

  it('plans nothing when no set is in progress', () => {
    const plan = planForfeit({ sets: [set(1, 25, 20)], forfeitingTeam: 'home', currentSetIndex: 1, bestOf: 5, setOnly: true })
    expect(plan.sets).toEqual([])
  })
})

describe('forfeitScope / playersAvailableForNextSet', () => {
  const roster = [1, 2, 3, 4, 5, 6, 7].map(n => ({ number: n, libero: '' })).concat([{ number: 9, libero: 'libero1' }])

  it('the manual forfeit always ends the match', () => {
    expect(forfeitScope('forfeit', { playersAvailableNextSet: 12 })).toBe('match')
  })

  it('injury, expulsion and disqualification end the set when six can play next set', () => {
    expect(forfeitScope('injury', { playersAvailableNextSet: 6 })).toBe('set')
    expect(forfeitScope('expulsion', { playersAvailableNextSet: 7 })).toBe('set')
    expect(forfeitScope('disqualification', { playersAvailableNextSet: 6 })).toBe('set')
  })

  it('any reason ends the match when fewer than six can play next set', () => {
    expect(forfeitScope('disqualification', { playersAvailableNextSet: 5 })).toBe('match')
    expect(forfeitScope('injury', { playersAvailableNextSet: 5 })).toBe('match')
  })

  it('counts non-liberos minus disqualified and exceptionally / disqualification-substituted players', () => {
    const events = [
      { type: 'sanction', payload: { team: 'home', type: 'disqualification', playerType: 'player', playerNumber: 1 } },
      { type: 'sanction', payload: { team: 'home', type: 'expulsion', playerType: 'player', playerNumber: 2 } },
      { type: 'substitution', payload: { team: 'home', playerOut: 3, playerIn: 7, isExceptional: true } },
      { type: 'substitution', payload: { team: 'home', playerOut: 4, playerIn: 6 } },
      { type: 'sanction', payload: { team: 'away', type: 'disqualification', playerType: 'player', playerNumber: 5 } },
      { type: 'sanction', payload: { team: 'home', type: 'disqualification', playerType: 'coach', playerNumber: 6 } }
    ]
    const ok = playersAvailableForNextSet(roster, events, 'home').map(p => p.number)
    expect(ok).toEqual([2, 4, 5, 6, 7]) // 1 disq., 3 exceptional sub, 9 libero
    expect(playersAvailableForNextSet(roster, events, 'home', { exclude: [7] }).map(p => p.number)).toEqual([2, 4, 5, 6])
  })
})

describe('planForfeitReversal', () => {
  // bo3, set 1 won by home 25-20, away forfeits in set 2 at 10-8 (home):
  // home is awarded 15 points in set 2 and set 5 is created at 15-0.
  const sets = [
    { id: 1, index: 1, homePoints: 25, awayPoints: 20, finished: true },
    { id: 2, index: 2, homePoints: 25, awayPoints: 8, finished: true },
    { id: 3, index: 5, homePoints: 15, awayPoints: 0, finished: true, forfeitCreated: true }
  ]
  const rally = (id, setIndex, team) => ({ id, setIndex, seq: id, type: 'point', payload: { team } })
  const events = [
    rally(1, 1, 'home'),
    { id: 2, setIndex: 1, seq: 2, type: 'set_end', payload: { team: 'home' } },
    rally(3, 2, 'home'), rally(4, 2, 'away'),
    { id: 5, setIndex: 2, seq: 5, type: 'point', payload: { team: 'home', forfeitAwarded: true } },
    { id: 6, setIndex: 2, seq: 6, type: 'point', payload: { team: 'home', forfeitAwarded: true } },
    { id: 7, setIndex: 2, seq: 7, type: 'set_end', payload: { team: 'home', reason: 'forfait' } },
    { id: 8, setIndex: 5, seq: 8, type: 'set_end', payload: { team: 'home', reason: 'forfait' } },
    { id: 9, setIndex: 2, seq: 9, type: 'forfait', payload: { team: 'away', scope: 'match', setsBefore: [{ id: 2, index: 2, homePoints: 10, awayPoints: 8 }] } }
  ]

  it('removes the created sets, the awarded points, the forfeit set_ends and the forfait event', () => {
    const plan = planForfeitReversal({ events, sets })
    expect(plan.hasForfeit).toBe(true)
    expect(plan.deleteSetIds).toEqual([3])
    expect(plan.deleteEventIds.sort((a, b) => a - b)).toEqual([5, 6, 7, 8, 9])
  })

  it('restores the forfeit set to its pre-forfeit score, unfinished', () => {
    const plan = planForfeitReversal({ events, sets })
    expect(plan.restoreSets).toEqual([{ id: 2, index: 2, homePoints: 10, awayPoints: 8 }])
    expect(plan.reopenSetIndex).toBe(2)
  })

  it('without setsBefore, counts the score from the remaining point events', () => {
    const legacy = events.map(e => (e.type === 'forfait' ? { ...e, payload: { team: 'away' } } : e))
    const plan = planForfeitReversal({ events: legacy, sets })
    expect(plan.restoreSets).toEqual([{ id: 2, index: 2, homePoints: 1, awayPoints: 1 }])
  })

  it('leaves earlier sets and normal events alone, and honours fromSetIndex', () => {
    const plan = planForfeitReversal({ events, sets, fromSetIndex: 5 })
    expect(plan.deleteSetIds).toEqual([3])
    expect(plan.deleteEventIds).toEqual([8])
    expect(plan.restoreSets).toEqual([])
    expect(plan.reopenSetIndex).toBeNull()
  })

  it('a match without a forfeit plans nothing', () => {
    const plan = planForfeitReversal({ events: events.slice(0, 4), sets: sets.slice(0, 2) })
    expect(plan).toEqual({ hasForfeit: false, deleteEventIds: [], deleteSetIds: [], restoreSets: [], reopenSetIndex: null })
  })
})
