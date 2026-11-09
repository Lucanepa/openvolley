import { describe, it, expect, beforeEach } from 'vitest'
import {
  isForcedSubstitution,
  lastCompletedRallySeq,
  interruptionEvents,
  isReplayPending,
  substitutionRequestThisInterruption,
  isSecondSubstitutionRequest,
  delayWarnedThisInterruption,
  entryWithoutCompletedRally,
  substitutionRequestIssues,
  timeoutRequestIssues,
  requestBlockReason,
  substituteInIllegalReason,
  REQUEST_ISSUES,
  lateRequestOutcome,
  decisionChangeTakeBack
} from '../interruptionRequests'
import { teamSanctionCounts, resolveSanction } from '../sanctions'
import { describeEvent } from '../describe'
import { planRemoveSubstitution, applyPlanToEvents } from '../manualCorrections'

let seq = 0
const ev = (type, payload = {}, setIndex = 1) => ({ type, payload, setIndex, seq: ++seq })
// A sub-event of the event just written (seq N.1), as the live engine writes them
const sub = (type, payload = {}, setIndex = 1) => ({ type, payload, setIndex, seq: seq + 0.1 })
const point = (team = 'home', setIndex = 1) => ev('point', { team }, setIndex)
const subst = (team, playerOut, playerIn, extra = {}, setIndex = 1) => ev('substitution', { team, playerOut, playerIn, ...extra }, setIndex)
// A substitution with its lineup sub-event, as confirmSubstitution writes it
const substWithLineup = (team, playerOut, playerIn, extra = {}) => {
  const s = subst(team, playerOut, playerIn, extra)
  return [s, sub('lineup', { team, fromSubstitution: true })]
}
const timeout = (team) => ev('timeout', { team })
const sanction = (team, type) => ev('sanction', { team, type })
const reasons = (issues) => issues.map(i => i.reason)

beforeEach(() => { seq = 0 })

describe('completed rally and the interruption', () => {
  it('no point yet: the whole set is the interruption', () => {
    const events = [ev('lineup', { team: 'home', isInitial: true }), subst('home', 1, 7)]
    expect(lastCompletedRallySeq(events, 1)).toBe(-Infinity)
    expect(interruptionEvents(events, 1)).toHaveLength(2)
  })

  it('the interruption starts after the latest point, of this set only', () => {
    const events = [point('home'), subst('home', 1, 7), point('away'), timeout('away'), point('home', 2), ev('timeout', { team: 'home' }, 2)]
    expect(interruptionEvents(events, 1).map(e => e.type)).toEqual(['timeout'])
    expect(interruptionEvents(events, 2).map(e => e.type)).toEqual(['timeout'])
  })

  it('a penalty point is a completed rally (CB 4.23, 4.25)', () => {
    const events = [subst('home', 1, 7), sanction('home', 'delay_penalty'), ev('point', { team: 'away', penaltySeq: seq })]
    expect(interruptionEvents(events, 1)).toHaveLength(0)
    expect(substitutionRequestIssues(events, 1, 'home')).toEqual([])
  })
})

describe('isForcedSubstitution', () => {
  it('injury, expulsion, disqualification and exceptional are forced', () => {
    for (const flag of ['isInjury', 'isExpelled', 'isDisqualified', 'isExceptional']) {
      expect(isForcedSubstitution({ [flag]: true })).toBe(true)
      expect(isForcedSubstitution({ payload: { [flag]: true } })).toBe(true)
    }
    expect(isForcedSubstitution({})).toBe(false)
    expect(isForcedSubstitution(null)).toBe(false)
  })
})

describe('isReplayPending (row 7)', () => {
  it('after an in-play replay with no point since', () => {
    const events = [point('home'), ev('rally_start'), ev('replay')]
    expect(isReplayPending(events, 1)).toBe(true)
  })

  it('still pending when something was recorded after the replay (a delay warning, a forced sub)', () => {
    const events = [point('home'), ev('rally_start'), ev('replay'), sanction('away', 'delay_warning'), subst('home', 4, 9, { isInjury: true })]
    expect(isReplayPending(events, 1)).toBe(true)
  })

  it('over once the replayed rally is completed', () => {
    const events = [point('home'), ev('rally_start'), ev('replay'), ev('rally_start'), point('away')]
    expect(isReplayPending(events, 1)).toBe(false)
  })

  it('a decision change "replay the rally" (the point removed, reason point_replay) is pending', () => {
    // point 2 was written, then removed by the decision change; only the replay is left
    const events = [point('home'), ev('rally_start'), ev('replay', { reason: 'point_replay' })]
    expect(isReplayPending(events, 1)).toBe(true)
  })

  it('a replay at 0:0 before any point is pending', () => {
    expect(isReplayPending([ev('set_start'), ev('rally_start'), ev('replay')], 1)).toBe(true)
  })

  it('a replay in another set does not count', () => {
    const events = [ev('rally_start', {}, 1), ev('replay', {}, 1), ev('lineup', { team: 'home' }, 2)]
    expect(isReplayPending(events, 2)).toBe(false)
  })

  it('no replay: not pending', () => {
    expect(isReplayPending([point('home')], 1)).toBe(false)
    expect(isReplayPending([], 1)).toBe(false)
    expect(isReplayPending(undefined, 1)).toBe(false)
  })
})

describe('second substitution request (rows 1, 2, 3, 8, 15, 17, 18)', () => {
  it('sub A, time-out A, sub A: the second is a second request (CB 4.28, Q160)', () => {
    const events = [point('home'), ...substWithLineup('home', 1, 7), timeout('home')]
    expect(isSecondSubstitutionRequest(events, 1, 'home')).toBe(true)
    expect(reasons(substitutionRequestIssues(events, 1, 'home', { playerOut: 2 }))).toEqual(['second_substitution_request'])
  })

  it('sub A, time-out B, sub A: a time-out of either team ends the request', () => {
    const events = [point('home'), subst('home', 1, 7), timeout('away')]
    expect(isSecondSubstitutionRequest(events, 1, 'home')).toBe(true)
  })

  it('sub A, sub B, sub A: the other team\'s substitution ends the request (Q122)', () => {
    const events = [point('home'), ...substWithLineup('home', 1, 7), ...substWithLineup('away', 3, 12)]
    expect(isSecondSubstitutionRequest(events, 1, 'home')).toBe(true)
    // ...but B may still be in its own request
    expect(isSecondSubstitutionRequest(events, 1, 'away')).toBe(false)
  })

  it('sub A, a sanction, sub A: a sanction ends the request', () => {
    const events = [point('home'), subst('home', 1, 7), sanction('away', 'warning')]
    expect(isSecondSubstitutionRequest(events, 1, 'home')).toBe(true)
  })

  it('sub A, rally_start, replay, sub A: the replayed rally ends the request (CB 4.4, row 8)', () => {
    const events = [point('home'), subst('home', 1, 7), ev('rally_start'), ev('replay')]
    expect(isSecondSubstitutionRequest(events, 1, 'home')).toBe(true)
    // and the replay blocks it anyway (row 7): the block comes first
    expect(reasons(substitutionRequestIssues(events, 1, 'home'))).toEqual(['replay_pending'])
  })

  it('a completed rally between two requests: no warning', () => {
    const events = [subst('home', 1, 7), timeout('home'), ev('rally_start'), point('away')]
    expect(isSecondSubstitutionRequest(events, 1, 'home')).toBe(false)
    expect(substitutionRequestIssues(events, 1, 'home')).toEqual([])
  })

  it('a penalty point between two requests: no warning (CB 4.25, Q93)', () => {
    const events = [point('away'), subst('home', 1, 7), sanction('home', 'delay_penalty'), ev('point', { team: 'away', penaltySeq: seq })]
    expect(isSecondSubstitutionRequest(events, 1, 'home')).toBe(false)
  })

  it('several players in one request (back to back, lineup sub-events between): one request, no warning (R15.2.2, Q31)', () => {
    const events = [point('home'), ...substWithLineup('home', 1, 7), ...substWithLineup('home', 2, 8)]
    expect(substitutionRequestThisInterruption(events, 1, 'home')).toMatchObject({ closed: false })
    expect(substitutionRequestIssues(events, 1, 'home', { playerOut: 3 })).toEqual([])
  })

  it('a libero replacement of either team between the subs does not end the request (row 18)', () => {
    const events = [
      point('home'), subst('home', 1, 7),
      ev('libero_entry', { team: 'home', playerOut: 5, liberoIn: 10 }), sub('lineup', { team: 'home', liberoSubstitution: {} }),
      ev('libero_exit', { team: 'away', playerIn: 4, liberoOut: 11 })
    ]
    expect(isSecondSubstitutionRequest(events, 1, 'home')).toBe(false)
  })

  it('remarks and other bookkeeping do not end the request', () => {
    const events = [point('home'), subst('home', 1, 7), ev('remark', { text: 'x' }), ev('court_captain_designation', { team: 'home' })]
    expect(isSecondSubstitutionRequest(events, 1, 'home')).toBe(false)
  })

  it('a forced substitution neither opens nor closes a request (row 3, CB 4.9)', () => {
    // injury first, then a regular request: legal
    const injuryFirst = [point('home'), subst('home', 4, 9, { isInjury: true }), timeout('home')]
    expect(isSecondSubstitutionRequest(injuryFirst, 1, 'home')).toBe(false)
    // regular, then the other team's forced sub, then regular: still one request
    const forcedBetween = [point('home'), subst('home', 1, 7), subst('away', 3, 12, { isExpelled: true }), subst('home', 2, 8)]
    expect(isSecondSubstitutionRequest(forcedBetween, 1, 'home')).toBe(false)
    // regular, time-out, and now a forced substitution: no warning for the forced one
    const forcedAfter = [point('home'), subst('home', 1, 7), timeout('home')]
    expect(substitutionRequestIssues(forcedAfter, 1, 'home', { isInjury: true })).toEqual([])
    expect(substitutionRequestIssues(forcedAfter, 1, 'home', { isDisqualified: true })).toEqual([])
    expect(substitutionRequestIssues(forcedAfter, 1, 'home', { isExceptional: true })).toEqual([])
  })

  it('0:0 before the first service: the rule applies to the whole set so far (row 15)', () => {
    const events = [
      ev('lineup', { team: 'home', isInitial: true }), ev('lineup', { team: 'away', isInitial: true }),
      subst('home', 1, 7), timeout('away')
    ]
    expect(isSecondSubstitutionRequest(events, 1, 'home')).toBe(true)
  })

  it('the deciding set has the same rule (row 17)', () => {
    const events = [point('home', 5), subst('home', 1, 7, {}, 5), ev('timeout', { team: 'home' }, 5)]
    expect(isSecondSubstitutionRequest(events, 5, 'home')).toBe(true)
    expect(isSecondSubstitutionRequest(events, 4, 'home')).toBe(false)
  })

  it('no substitution in this interruption: nothing to warn', () => {
    expect(substitutionRequestThisInterruption([point('home'), timeout('home')], 1, 'home')).toBeNull()
  })
})

describe('the player who just came in (row 13)', () => {
  it('cannot go out again before a completed rally: warns with the player who may return', () => {
    const events = [point('home'), ...substWithLineup('home', 1, 7)]
    expect(entryWithoutCompletedRally(events, 1, 'home', 7)).toMatchObject({ payload: { playerIn: 7 } })
    const issues = substitutionRequestIssues(events, 1, 'home', { playerOut: 7 })
    expect(reasons(issues)).toEqual(['no_rally_since_entry'])
    expect(issues[0].playerIn).toBe(1)
    expect(issues[0].options).toContain('continue')
  })

  it('is free once a rally was completed', () => {
    const events = [subst('home', 1, 7), point('away')]
    expect(entryWithoutCompletedRally(events, 1, 'home', 7)).toBeNull()
    expect(substitutionRequestIssues(events, 1, 'home', { playerOut: 7 })).toEqual([])
  })

  it('a player who never came in is not concerned', () => {
    expect(entryWithoutCompletedRally([subst('home', 1, 7)], 1, 'home', 2)).toBeNull()
  })
})

describe('substitution limit (row 4)', () => {
  const sixSubs = () => [1, 2, 3, 4, 5, 6].map(n => subst('home', n, n + 10))

  it('the 7th regular substitution is a limit warning without "Continue anyway"', () => {
    const events = [...sixSubs(), point('away')]
    const issues = substitutionRequestIssues(events, 1, 'home')
    expect(reasons(issues)).toEqual(['substitution_limit'])
    expect(issues[0].options).toEqual(['improper', 'delay', 'cancel'])
    expect(issues[0].kind).toBe('warn')
  })

  it('the second player of a double request after 5 is the 7th (CB 4.14, Q14)', () => {
    const events = [...[1, 2, 3, 4, 5].map(n => subst('home', n, n + 10)), point('away'), subst('home', 6, 16)]
    expect(reasons(substitutionRequestIssues(events, 1, 'home', { playerOut: 7 }))).toEqual(['substitution_limit'])
  })

  it('exceptional substitutions do not count against the limit (R15.7)', () => {
    const events = [...[1, 2, 3, 4, 5].map(n => subst('home', n, n + 10)), subst('home', 6, 16, { isExceptional: true }), point('away')]
    expect(substitutionRequestIssues(events, 1, 'home')).toEqual([])
  })

  it('a forced substitution beyond the limit has no warning (it becomes exceptional)', () => {
    const events = [...sixSubs(), point('away')]
    expect(substitutionRequestIssues(events, 1, 'home', { isInjury: true })).toEqual([])
  })

  it('the limit is per team and per set', () => {
    const events = [...sixSubs(), point('away')]
    expect(substitutionRequestIssues(events, 1, 'away')).toEqual([])
    expect(substitutionRequestIssues(events, 2, 'home')).toEqual([])
  })

  it('a limit warning comes before the second-request warning', () => {
    const events = [...[1, 2, 3, 4, 5].map(n => subst('home', n, n + 10)), point('away'), subst('home', 6, 16), timeout('home')]
    expect(reasons(substitutionRequestIssues(events, 1, 'home'))).toEqual(['substitution_limit'])
  })
})

describe('after a delay warning in the same interruption (row 9, R15.2.4)', () => {
  it('a request after the team\'s delay warning: notice first, Cancel / Continue anyway', () => {
    const events = [point('away'), sanction('home', 'delay_warning')]
    expect(delayWarnedThisInterruption(events, 1, 'home')).toBe(true)
    const subIssues = substitutionRequestIssues(events, 1, 'home')
    expect(reasons(subIssues)).toEqual(['after_delay_warning'])
    expect(subIssues[0].options).toEqual(['cancel', 'continue'])
    expect(reasons(timeoutRequestIssues(events, 1, 'home'))).toEqual(['after_delay_warning'])
  })

  it('the other team\'s delay warning does not concern this team', () => {
    expect(delayWarnedThisInterruption([point('away'), sanction('away', 'delay_warning')], 1, 'home')).toBe(false)
  })

  it('a delay warning in an earlier interruption does not count', () => {
    expect(delayWarnedThisInterruption([sanction('home', 'delay_warning'), point('away')], 1, 'home')).toBe(false)
  })

  it('after a delay penalty (a point), requests are open again (CB 4.25)', () => {
    const events = [sanction('home', 'delay_penalty'), ev('point', { team: 'away', penaltySeq: seq })]
    expect(substitutionRequestIssues(events, 1, 'home')).toEqual([])
    expect(timeoutRequestIssues(events, 1, 'home')).toEqual([])
  })

  it('the notice comes first, then the other issue for "Continue anyway"', () => {
    const events = [point('away'), subst('home', 1, 7), sanction('home', 'delay_warning')]
    expect(reasons(substitutionRequestIssues(events, 1, 'home'))).toEqual(['after_delay_warning', 'second_substitution_request'])
    const toEvents = [timeout('home'), timeout('home'), point('away'), sanction('home', 'delay_warning')]
    expect(reasons(timeoutRequestIssues(toEvents, 1, 'home'))).toEqual(['after_delay_warning', 'third_timeout'])
  })

  it('a forced substitution after a delay warning has no notice', () => {
    expect(substitutionRequestIssues([point('away'), sanction('home', 'delay_warning')], 1, 'home', { isInjury: true })).toEqual([])
  })
})

describe('time-outs (rows 5, 6, 7, 14, 16)', () => {
  it('0:0 before the first service: allowed, no warning (owner D2)', () => {
    const events = [ev('lineup', { team: 'home', isInitial: true }), ev('lineup', { team: 'away', isInitial: true })]
    expect(timeoutRequestIssues(events, 1, 'home')).toEqual([])
  })

  it('a second time-out in the same interruption is legal (Q161)', () => {
    expect(timeoutRequestIssues([point('away'), timeout('home')], 1, 'home')).toEqual([])
  })

  it('sub, then two time-outs: legal (Q161)', () => {
    expect(timeoutRequestIssues([point('away'), subst('home', 1, 7), timeout('home')], 1, 'home')).toEqual([])
  })

  it('the 3rd time-out is a warning with the "already started" delay option (CB 4.29, Q40)', () => {
    const events = [timeout('home'), point('away'), timeout('home'), point('away')]
    const issues = timeoutRequestIssues(events, 1, 'home')
    expect(reasons(issues)).toEqual(['third_timeout'])
    expect(issues[0].options).toEqual(['improper', 'timeoutStarted', 'cancel'])
  })

  it('time-outs are counted per set', () => {
    const events = [timeout('home'), timeout('home'), point('away')]
    expect(timeoutRequestIssues(events, 2, 'home')).toEqual([])
  })

  it('while a replay is pending: blocked', () => {
    const events = [point('away'), ev('rally_start'), ev('replay')]
    expect(reasons(timeoutRequestIssues(events, 1, 'home'))).toEqual(['replay_pending'])
    expect(timeoutRequestIssues(events, 1, 'home')[0].kind).toBe('block')
  })

  it('during the set interval: blocked (it would count in the next set)', () => {
    const issues = timeoutRequestIssues([], 2, 'home', { intervalRunning: true })
    expect(reasons(issues)).toEqual(['set_interval'])
    expect(issues[0].kind).toBe('block')
  })
})

describe('requestBlockReason (the disabled buttons)', () => {
  it('replay pending blocks both regular requests', () => {
    const events = [point('away'), ev('rally_start'), ev('replay')]
    expect(requestBlockReason(events, 1, 'home', 'timeout')).toBe('replay_pending')
    expect(requestBlockReason(events, 1, 'home', 'substitution')).toBe('replay_pending')
  })

  it('the set interval blocks only the time-out', () => {
    expect(requestBlockReason([], 2, 'home', 'timeout', { intervalRunning: true })).toBe('set_interval')
    expect(requestBlockReason([], 2, 'home', 'substitution', { intervalRunning: true })).toBeNull()
  })

  it('a warning is not a block', () => {
    const events = [point('away'), subst('home', 1, 7), timeout('home')]
    expect(requestBlockReason(events, 1, 'home', 'substitution')).toBeNull()
  })

  it('open after the replayed rally was completed', () => {
    const events = [point('away'), ev('rally_start'), ev('replay'), ev('rally_start'), point('home')]
    expect(requestBlockReason(events, 1, 'home', 'timeout')).toBeNull()
    expect(requestBlockReason(events, 1, 'home', 'substitution')).toBeNull()
  })
})

describe('REQUEST_ISSUES', () => {
  it('every warn / notice can be cancelled; only the request warnings offer "Continue anyway"', () => {
    for (const [reason, spec] of Object.entries(REQUEST_ISSUES)) {
      if (spec.kind === 'block') { expect(spec.options).toEqual([]); continue }
      expect(spec.options).toContain('cancel')
      const continues = ['after_delay_warning', 'second_substitution_request', 'no_rally_since_entry'].includes(reason)
      expect(spec.options.includes('continue')).toBe(continues)
    }
  })
})

describe('the improper-request ladder from a warning (section C)', () => {
  it('first improper request: recorded without consequence; then a delay warning, then a penalty', () => {
    const resolve = (events) => resolveSanction('improper_request', teamSanctionCounts(events, 'home'))
    expect(resolve([])).toBe('improper_request')
    expect(resolve([sanction('home', 'improper_request')])).toBe('delay_warning')
    expect(resolve([sanction('home', 'improper_request'), sanction('home', 'delay_warning')])).toBe('delay_penalty')
    // the other team's history does not count
    expect(resolve([sanction('away', 'improper_request')])).toBe('improper_request')
  })

  it('"Game was delayed" goes straight to the delay ladder and keeps the free improper request (GL)', () => {
    const delay = (events) => resolveSanction('delay_warning', teamSanctionCounts(events, 'home'))
    expect(delay([])).toBe('delay_warning')
    expect(delay([sanction('home', 'delay_warning')])).toBe('delay_penalty')
    expect(teamSanctionCounts([sanction('home', 'delay_warning')], 'home')).toEqual({ priorDelayCount: 1, priorImproperCount: 0 })
  })
})

describe('substituteInIllegalReason (row 12)', () => {
  it('a libero or a player sent off can never come in', () => {
    expect(substituteInIllegalReason([], 1, 'home', 1, 10, { isLibero: true })).toBe('libero')
    expect(substituteInIllegalReason([], 1, 'home', 1, 10, { sentOff: true })).toBe('sent_off')
  })

  it('a fresh bench player may come in', () => {
    expect(substituteInIllegalReason([], 1, 'home', 1, 7)).toBeNull()
  })

  it('a substitute may only be replaced by the starter he came in for (15.6.2)', () => {
    const events = [subst('home', 1, 7), point('away')]
    expect(substituteInIllegalReason(events, 1, 'home', 7, 8)).toBe('wrong_partner')
    expect(substituteInIllegalReason(events, 1, 'home', 7, 1)).toBeNull()
  })

  it('a starter who went out may only return for his substitute', () => {
    const events = [subst('home', 1, 7), point('away')]
    expect(substituteInIllegalReason(events, 1, 'home', 2, 1)).toBe('wrong_partner')
  })

  it('a starter who went out cannot return before a completed rally', () => {
    expect(substituteInIllegalReason([subst('home', 1, 7)], 1, 'home', 7, 1)).toBe('no_rally_since_out')
  })

  it('a substitute who already came in and went out cannot enter again this set', () => {
    const events = [subst('home', 1, 7), point('away'), subst('home', 7, 1), point('away')]
    expect(substituteInIllegalReason(events, 1, 'home', 2, 7)).toBe('played_out')
    // the next set starts afresh
    expect(substituteInIllegalReason(events, 2, 'home', 2, 7)).toBeNull()
  })
})

describe('a team sanction keeps no reason (row 11; owner 2026-11-09)', () => {
  // "for improper requests: no reason, no need, same for delays". Events
  // written while a reason was asked (payload.reason) still read as before:
  // the field is ignored.
  it('an old improper request or delay with payload.reason describes as one without', () => {
    const at = (payload) => describeEvent({ type: 'sanction', setIndex: 1, seq: 9, payload: { team: 'home', ...payload } }, [], {})
    for (const [type, reason] of [['improper_request', 'wrong_person'], ['improper_request', 'other'], ['delay_warning', 'during_rally'], ['delay_penalty', 'illegal_substitution']]) {
      expect(at({ type, reason })).toEqual(at({ type }))
    }
    expect(at({ type: 'improper_request', reason: 'wrong_person' }).detail).toBe('')
    expect(at({ type: 'improper_request', reason: 'during_rally' }).text).not.toContain('During the rally')
    // a delay penalty says its point, nothing before it
    expect(at({ type: 'delay_penalty', reason: 'illegal_substitution' }).detail).toMatch(/^\+1 point to /)
  })
})

describe('a late request stopped the rally (row 10)', () => {
  it('the first delay: a delay warning and the rally is replayed (Q182)', () => {
    const events = [point('home'), ev('rally_start')]
    expect(lateRequestOutcome(events, 'away')).toEqual({ sanction: 'delay_warning', replay: true })
  })

  it('after a delay warning (any set): a delay penalty, no replay: the point decides the rally (16.2.3)', () => {
    const events = [sanction('away', 'delay_warning'), point('home'), point('home', 2), ev('rally_start', {}, 2)]
    expect(lateRequestOutcome(events, 'away')).toEqual({ sanction: 'delay_penalty', replay: false })
    // the other team still has its warning to come
    expect(lateRequestOutcome(events, 'home').sanction).toBe('delay_warning')
  })

  it('an improper request on record does not make it a penalty (only delays count, 16.2)', () => {
    const events = [sanction('away', 'improper_request'), point('home'), ev('rally_start')]
    expect(lateRequestOutcome(events, 'away').sanction).toBe('delay_warning')
  })

  it('after the replay and the delay warning, requests stay closed for both teams until the rally is completed (row 7)', () => {
    const events = [point('home'), ev('rally_start'), ev('replay'), sanction('away', 'delay_warning')]
    for (const team of ['home', 'away']) {
      expect(requestBlockReason(events, 1, team, 'timeout')).toBe('replay_pending')
      expect(requestBlockReason(events, 1, team, 'substitution')).toBe('replay_pending')
    }
    // an injury substitution is still possible
    expect(substitutionRequestIssues(events, 1, 'away', { isInjury: true })).toEqual([])
    events.push(ev('rally_start'), point('away'))
    expect(requestBlockReason(events, 1, 'away', 'timeout')).toBeNull()
  })

  it('after a delay penalty (no replay), the penalty point is the completed rally: requests are open', () => {
    const events = [point('home'), ev('rally_start'), sanction('away', 'delay_penalty'), ev('point', { team: 'home', penaltySeq: seq })]
    expect(requestBlockReason(events, 1, 'away', 'timeout')).toBeNull()
    expect(requestBlockReason(events, 1, 'away', 'substitution')).toBeNull()
  })
})

describe('decision change after a substitution or time-out (row 19)', () => {
  it('nothing after the point: nothing to take back (the plain decision change)', () => {
    const events = [point('home'), sub('lineup', { team: 'home', fromRotation: true })]
    expect(decisionChangeTakeBack(events, 1)).toBeNull()
  })

  it('no point in the set: nothing to change', () => {
    expect(decisionChangeTakeBack([...substWithLineup('home', 1, 7)], 1)).toBeNull()
  })

  it('a substitution with its line-up row after the point: taken back (CB 8.5)', () => {
    const p = point('away')
    const rotation = sub('lineup', { team: 'away', fromRotation: true })
    const [s1, l1] = substWithLineup('home', 3, 7)
    const take = decisionChangeTakeBack([p, rotation, s1, l1], 1)
    expect(take.point).toBe(p)
    expect(take.requests).toEqual([s1])
  })

  it('time-outs and substitutions of both teams: all of them, newest first (as Undo takes them)', () => {
    const p = point('home')
    const t1 = timeout('away')
    const [s1, l1] = substWithLineup('away', 2, 8)
    const t2 = timeout('home')
    const [s2, l2] = substWithLineup('home', 4, 9)
    const take = decisionChangeTakeBack([p, t1, s1, l1, t2, s2, l2], 1)
    expect(take.requests).toEqual([s2, t2, s1, t1])
  })

  it('a forced substitution after the point: not offered (the player must be replaced whatever the decision)', () => {
    const events = [point('home'), timeout('away'), ...substWithLineup('away', 2, 8, { isInjury: true })]
    expect(decisionChangeTakeBack(events, 1)).toBeNull()
  })

  it('a libero replacement, a sanction, a started rally or a replay after the point: not offered (Undo)', () => {
    for (const other of [
      () => ev('libero_entry', { team: 'home', liberoIn: 9, playerOut: 5 }),
      () => sanction('home', 'improper_request'),
      () => ev('rally_start'),
      () => ev('replay')
    ]) {
      seq = 0
      const events = [point('home'), timeout('away'), other()]
      expect(decisionChangeTakeBack(events, 1)).toBeNull()
    }
  })

  it('a line-up row of the other team under a substitution is not its own: not offered', () => {
    const events = [point('home'), subst('away', 2, 8), sub('lineup', { team: 'home' })]
    expect(decisionChangeTakeBack(events, 1)).toBeNull()
  })

  it('only the current set counts', () => {
    const events = [point('home', 1), timeout('away'), point('home', 2)]
    expect(decisionChangeTakeBack(events, 2)).toBeNull()
    expect(decisionChangeTakeBack(events, 1).requests).toHaveLength(1)
  })

  it('the substitution taken back is not counted: the team\'s next one is its first request again', () => {
    const p = point('home')
    const [s1, l1] = substWithLineup('home', 3, 7)
    const t1 = timeout('home')
    const events = [p, s1, l1, t1]
    expect(isSecondSubstitutionRequest(events, 1, 'home')).toBe(true)
    const take = decisionChangeTakeBack(events, 1)
    const gone = new Set(take.requests.map(e => e.seq))
    const after = events.filter(e => !gone.has(Math.floor(e.seq)))
    expect(after).toEqual([p])
    expect(substitutionRequestIssues(after, 1, 'home')).toEqual([])
  })
})

describe('rectifying an illegal substitution (row 20, R15.9.2)', () => {
  // The app has no live "rectify" action: the scorer removes the illegal
  // substitution in the corrections (planRemoveSubstitution). That path never
  // asks the request rules, and what it leaves is not a substitution (CB 4.13):
  // neither the limit (row 4) nor the second-request rule (row 1) counts it.
  it('the removed substitution no longer counts for the limit or as a request', () => {
    let id = 0
    const withId = (e) => ({ ...e, id: ++id })
    const events = [
      withId(ev('lineup', { team: 'home', isInitial: true, lineup: { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6' } })),
      withId(point('home'))
    ]
    const pairs = [[1, 7], [2, 8], [3, 9], [4, 10], [5, 11]]
    for (const [o, i] of pairs) {
      events.push(withId(subst('home', o, i)), withId(sub('lineup', { team: 'home', fromSubstitution: true })))
      events.push(withId(point('away')))
    }
    // the 6th: illegal (#12 is not on the roster); with it the limit is reached
    const illegal = withId(subst('home', 6, 12))
    events.push(illegal, withId(sub('lineup', { team: 'home', fromSubstitution: true })), withId(timeout('away')))
    expect(reasons(substitutionRequestIssues(events, 1, 'home'))).toEqual(['substitution_limit'])
    const plan = planRemoveSubstitution(events, illegal.id, { raw: true })
    expect(plan.error).toBeUndefined()
    const rectified = applyPlanToEvents(events, plan)
    expect(rectified.some(e => e.id === illegal.id)).toBe(false)
    // not the 7th, and not a second request (the time-out after it is no longer after a substitution)
    expect(substitutionRequestIssues(rectified, 1, 'home')).toEqual([])
  })
})
