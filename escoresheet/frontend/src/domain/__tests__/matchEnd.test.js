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
  planForfeitReversal,
  matchForfeitOf,
  restoredSetWrites,
  opensAtMatchEnd
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

  it('a bench player disqualified counts too, so the next court disqualification ends the match', () => {
    // 7 non-liberos: bench #7 disqualified (logged playerType 'bench'), then
    // court #1 with no legal substitute: only 5 can play
    const events = [
      { type: 'sanction', payload: { team: 'home', type: 'disqualification', playerType: 'bench', playerNumber: 7 } },
      { type: 'sanction', payload: { team: 'home', type: 'disqualification', playerType: 'official', playerNumber: 2 } }
    ]
    const ok = playersAvailableForNextSet(roster, events, 'home', { exclude: [1] })
    expect(ok.map(p => p.number)).toEqual([2, 3, 4, 5, 6])
    expect(forfeitScope('disqualification', { playersAvailableNextSet: ok.length })).toBe('match')
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

describe('opensAtMatchEnd (a match restored or continued from the cloud)', () => {
  it('a stopped match (status ended, its sets undecided) opens at Match End', () => {
    expect(opensAtMatchEnd({ status: 'ended', homeSetsWon: 1, awaySetsWon: 1, bestOf: 5 })).toBe(true)
  })
  it('approved and final too, and a match its sets decided', () => {
    expect(opensAtMatchEnd({ status: 'approved', homeSetsWon: 0, awaySetsWon: 0 })).toBe(true)
    expect(opensAtMatchEnd({ status: 'final', homeSetsWon: 0, awaySetsWon: 0 })).toBe(true)
    expect(opensAtMatchEnd({ status: 'live', homeSetsWon: 2, awaySetsWon: 0, bestOf: 3 })).toBe(true)
  })
  it('a live match its sets have not decided is scored on', () => {
    expect(opensAtMatchEnd({ status: 'live', homeSetsWon: 2, awaySetsWon: 1, bestOf: 5 })).toBe(false)
    expect(opensAtMatchEnd({ status: undefined, homeSetsWon: 0, awaySetsWon: 0 })).toBe(false)
  })
})

describe('planForfeit inDefault (FIVB 6.4.1-2: 0:3, 0:25 in every set)', () => {
  const applied = (sets, plan) => {
    const byIndex = new Map(sets.map(s => [s.index, { ...s }]))
    for (const p of plan.sets) {
      if (p.voided) byIndex.set(p.index, { ...byIndex.get(p.index), finished: false })
      else byIndex.set(p.index, { ...(byIndex.get(p.index) || {}), index: p.index, homePoints: p.homePoints, awayPoints: p.awayPoints, finished: true })
    }
    return [...byIndex.values()]
  }

  it('bo5, home won set 1 and refuses to play on in set 2: sets 1-3 are 0:25, set 1 included', () => {
    const sets = [set(1, 25, 20), set(2, 10, 12, false)]
    const plan = planForfeit({ sets, forfeitingTeam: 'home', currentSetIndex: 2, bestOf: 5, inDefault: true })
    expect(plan.winner).toBe('away')
    expect(plan.sets.map(s => [s.index, s.homePoints, s.awayPoints])).toEqual([[1, 0, 25], [2, 0, 25], [3, 0, 25]])
    expect(plan.sets[0]).toMatchObject({ id: 10, wasFinished: true, isCurrent: false, awardedPoints: 0 })
    expect(plan.sets[1]).toMatchObject({ id: 20, wasFinished: false, isCurrent: true, awardedPoints: 0 })
    expect(plan.sets[2]).toMatchObject({ id: null, wasFinished: false })
    expect(countSetsWon(applied(sets, plan))).toEqual({ home: 0, away: 3 })
    expect(getMatchWinner(applied(sets, plan), 5)).toBe('away')
  })

  it('a refusal at 2:2: sets 1-3 are 0:25, set 4 no longer counts, set 5 stays as it is (0:3, not 3:2)', () => {
    const sets = [set(1, 25, 20), set(2, 20, 25), set(3, 25, 20), set(4, 20, 25), set(5, 8, 5, false)]
    const plan = planForfeit({ sets, forfeitingTeam: 'home', currentSetIndex: 5, bestOf: 5, inDefault: true })
    expect(plan.sets.map(s => [s.index, s.homePoints, s.awayPoints, !!s.voided])).toEqual([
      [1, 0, 25, false], [2, 0, 25, false], [3, 0, 25, false], [4, 20, 25, true]
    ])
    expect(countSetsWon(applied(sets, plan))).toEqual({ home: 0, away: 3 })
  })

  it('bo3 at 1:1 in the deciding set: 0:2 with sets 1 and 2 at 0:25', () => {
    const sets = [set(1, 25, 20), set(2, 20, 25), set(5, 3, 6, false)]
    const plan = planForfeit({ sets, forfeitingTeam: 'away', currentSetIndex: 5, bestOf: 3, inDefault: true })
    expect(plan.winner).toBe('home')
    expect(plan.sets.map(s => [s.index, s.homePoints, s.awayPoints])).toEqual([[1, 25, 0], [2, 25, 0]])
    expect(countSetsWon(applied(sets, plan))).toEqual({ home: 2, away: 0 })
  })

  it('a default before the first rally: 0:25 in sets 1-3, no points awarded', () => {
    const plan = planForfeit({ sets: [set(1, 0, 0, false)], forfeitingTeam: 'home', currentSetIndex: 1, bestOf: 5, inDefault: true })
    expect(plan.sets.map(s => [s.index, s.id, s.homePoints, s.awayPoints, s.awardedPoints])).toEqual([
      [1, 10, 0, 25, 0], [2, null, 0, 25, 0], [3, null, 0, 25, 0]
    ])
  })

  it('without inDefault (incomplete for the match, 6.4.3) the team keeps its points and sets', () => {
    const sets = [set(1, 25, 20), set(2, 10, 12, false)]
    const plan = planForfeit({ sets, forfeitingTeam: 'home', currentSetIndex: 2, bestOf: 5 })
    expect(plan.sets.map(s => [s.index, s.homePoints, s.awayPoints])).toEqual([[2, 10, 25], [3, 0, 25], [4, 0, 25]])
  })
})

describe('matchForfeitOf', () => {
  it('the match forfeit from its forfait event (scope match), not one of a set', () => {
    const events = [
      { id: 1, setIndex: 1, seq: 1, type: 'forfait', payload: { team: 'home', scope: 'set', setIndex: 1 } },
      { id: 2, setIndex: 3, seq: 2, type: 'forfait', payload: { team: 'away', scope: 'match', setIndex: 3, inDefault: true } }
    ]
    expect(matchForfeitOf(events)).toEqual({ team: 'away', setIndex: 3, inDefault: true })
    expect(matchForfeitOf(events.slice(0, 1))).toBeNull()
    expect(matchForfeitOf([])).toBeNull()
  })
  it('an older forfait event without a scope is a match forfeit; without inDefault, by its reason', () => {
    expect(matchForfeitOf([{ id: 1, setIndex: 2, type: 'forfait', payload: { team: 'home', reason: 'forfeit' } }]))
      .toEqual({ team: 'home', setIndex: 2, inDefault: true })
    expect(matchForfeitOf([{ id: 1, setIndex: 2, type: 'forfait', payload: { team: 'home', reason: 'injury', scope: 'match' } }]))
      .toEqual({ team: 'home', setIndex: 2, inDefault: false })
  })
})

describe('planForfeitReversal on a copy continued from the cloud (no forfeitCreated flags)', () => {
  // as the scoring device wrote it (planForfeitReversal tests above), the
  // created set 5 without its local flag
  const sets = [
    { id: 1, index: 1, homePoints: 25, awayPoints: 20, finished: true },
    { id: 2, index: 2, homePoints: 25, awayPoints: 8, finished: true },
    { id: 3, index: 5, homePoints: 15, awayPoints: 0, finished: true }
  ]
  const events = [
    { id: 1, setIndex: 1, seq: 1, type: 'point', payload: { team: 'home' } },
    { id: 2, setIndex: 1, seq: 2, type: 'set_end', payload: { team: 'home' } },
    { id: 3, setIndex: 2, seq: 3, type: 'point', payload: { team: 'home' } },
    { id: 5, setIndex: 2, seq: 5, type: 'point', payload: { team: 'home', forfeitAwarded: true } },
    { id: 7, setIndex: 2, seq: 7, type: 'set_end', payload: { team: 'home', reason: 'forfait' } },
    { id: 8, setIndex: 5, seq: 8, type: 'set_end', payload: { team: 'home', reason: 'forfait' } },
    { id: 9, setIndex: 2, seq: 9, type: 'forfait', payload: { team: 'away', scope: 'match', setsBefore: [{ id: 2, index: 2, homePoints: 10, awayPoints: 8 }] } }
  ]

  it('a set the forfeit created is known by its events: only a forfeit set end, no point', () => {
    const plan = planForfeitReversal({ events, sets, fromSetIndex: 2 })
    expect(plan.deleteSetIds).toEqual([3])
    expect(plan.restoreSets).toEqual([{ id: 2, index: 2, homePoints: 10, awayPoints: 8 }])
    expect(plan.reopenSetIndex).toBe(2)
  })

  it('a set the forfeit finished without a point but did not create (listed in setsBefore) is restored, not deleted', () => {
    const atZero = [
      { id: 1, index: 1, homePoints: 0, awayPoints: 25, finished: true },
      { id: 2, index: 2, homePoints: 0, awayPoints: 25, finished: true }
    ]
    const ev = [
      { id: 1, setIndex: 1, seq: 1, type: 'set_end', payload: { team: 'away', reason: 'forfait' } },
      { id: 2, setIndex: 2, seq: 2, type: 'set_end', payload: { team: 'away', reason: 'forfait' } },
      { id: 3, setIndex: 1, seq: 3, type: 'forfait', payload: { team: 'home', scope: 'match', inDefault: true, setsBefore: [{ id: 1, index: 1, homePoints: 0, awayPoints: 0 }] } }
    ]
    const plan = planForfeitReversal({ events: ev, sets: atZero, fromSetIndex: 1 })
    expect(plan.deleteSetIds).toEqual([2])
    expect(plan.restoreSets).toEqual([{ id: 1, index: 1, homePoints: 0, awayPoints: 0 }])
  })
})

describe('planForfeitReversal of a default after sets were played', () => {
  // bo5: home won set 1 25:20 (ended at END1); at 10:12 in set 2 home is in
  // default: set 1 rewritten 0:25 (still finished), set 2 0:25, set 3 created
  const END1 = '2026-10-05T18:30:00.000Z'
  const sets = [
    { id: 1, index: 1, homePoints: 0, awayPoints: 25, finished: true, endTime: END1 },
    { id: 2, index: 2, homePoints: 0, awayPoints: 25, finished: true },
    { id: 3, index: 3, homePoints: 0, awayPoints: 25, finished: true, forfeitCreated: true }
  ]
  const events = [
    { id: 1, setIndex: 1, seq: 1, type: 'point', payload: { team: 'home' } },
    { id: 2, setIndex: 1, seq: 2, type: 'set_end', payload: { team: 'home', homePoints: 25, awayPoints: 20 } },
    { id: 3, setIndex: 2, seq: 3, type: 'point', payload: { team: 'away' } },
    { id: 4, setIndex: 2, seq: 4, type: 'set_end', payload: { team: 'away', reason: 'forfait' } },
    { id: 5, setIndex: 3, seq: 5, type: 'set_end', payload: { team: 'away', reason: 'forfait' } },
    {
      id: 6, setIndex: 2, seq: 6, type: 'forfait', payload: {
        team: 'home', scope: 'match', inDefault: true,
        setsBefore: [
          { id: 1, index: 1, homePoints: 25, awayPoints: 20, finished: true, endTime: END1 },
          { id: 2, index: 2, homePoints: 10, awayPoints: 12 }
        ]
      }
    }
  ]

  it('gives the played set its score back, still finished; reopens the set the default was declared in', () => {
    const plan = planForfeitReversal({ events, sets, fromSetIndex: 2 })
    expect(plan.deleteSetIds).toEqual([3])
    expect(plan.deleteEventIds.sort((a, b) => a - b)).toEqual([4, 5, 6])
    expect(plan.restoreSets).toEqual([
      { id: 1, index: 1, homePoints: 25, awayPoints: 20, finished: true, endTime: END1 },
      { id: 2, index: 2, homePoints: 10, awayPoints: 12 }
    ])
    expect(plan.reopenSetIndex).toBe(2)
  })

  it('a set 4 a refusal at 2:2 set aside is finished again', () => {
    const plan = planForfeitReversal({
      events: [
        { id: 1, setIndex: 5, seq: 1, type: 'forfait', payload: { team: 'home', scope: 'match', inDefault: true, setsBefore: [{ id: 4, index: 4, homePoints: 20, awayPoints: 25, finished: true, endTime: END1 }] } }
      ],
      sets: [{ id: 4, index: 4, homePoints: 20, awayPoints: 25, finished: false }, { id: 5, index: 5, homePoints: 8, awayPoints: 5, finished: false }],
      fromSetIndex: 5
    })
    expect(plan.restoreSets).toEqual([{ id: 4, index: 4, homePoints: 20, awayPoints: 25, finished: true, endTime: END1 }])
    expect(plan.reopenSetIndex).toBeNull()
  })
})

describe('restoredSetWrites', () => {
  it('a set the forfeit finished goes back unfinished, here and in the cloud', () => {
    expect(restoredSetWrites({ id: 2, index: 2, homePoints: 10, awayPoints: 12 })).toEqual({
      local: { homePoints: 10, awayPoints: 12, finished: false, endTime: null },
      cloud: { home_points: 10, away_points: 12, finished: false, end_time: null }
    })
  })
  it('a set finished before a default keeps its end', () => {
    expect(restoredSetWrites({ id: 1, index: 1, homePoints: 25, awayPoints: 20, finished: true, endTime: 'T' })).toEqual({
      local: { homePoints: 25, awayPoints: 20, finished: true, endTime: 'T' },
      cloud: { home_points: 25, away_points: 20, finished: true, end_time: 'T' }
    })
  })
})
