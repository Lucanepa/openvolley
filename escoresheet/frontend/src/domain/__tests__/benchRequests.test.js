import { describe, it, expect } from 'vitest'
import {
  newBenchRequestId, benchSetIndex, setHasStarted, latestLineup,
  benchLineupAvailability, benchTimeoutAvailability, benchSubstitutionAvailability,
  benchLineupCheck, benchSubstitutionChoices, courtCaptainOf, isSentOff,
  benchRequestsReducer, latestBenchRequest, scorerQueueReducer
} from '../benchRequests'

// VBC Musterdorf: 1-12, captain 7, liberos 13 and 14
const players = [
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((number) => ({ number, isCaptain: number === 7 })),
  { number: 13, libero: 'libero1' },
  { number: 14, libero: 'libero2' }
]
const LU = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 }
let seq = 0
const ev = (type, payload, setIndex = 1) => ({ type, setIndex, seq: ++seq, payload: { team: 'home', ...payload } })
const lineupEv = (lineup = LU, setIndex = 1) => ev('lineup', { lineup, isInitial: true }, setIndex)
const point = (setIndex = 1) => ev('point', { team: 'home' }, setIndex)

describe('when the bench may send', () => {
  const match = { coinTossConfirmed: true }
  it('the line-up: after the coin toss, before the set starts, while the scorer has none', () => {
    expect(benchLineupAvailability({ match: {}, events: [], setIndex: 1, team: 'home' })).toEqual({ allowed: false, reason: 'no_coin_toss' })
    expect(benchLineupAvailability({ match, events: [], setIndex: 1, team: 'home' }).allowed).toBe(true)
    expect(benchLineupAvailability({ match, events: [lineupEv()], setIndex: 1, team: 'home' }).reason).toBe('lineup_entered')
    expect(benchLineupAvailability({ match, events: [lineupEv()], setIndex: 1, team: 'away' }).allowed).toBe(true)
    expect(benchLineupAvailability({ match, events: [ev('rally_start', {})], setIndex: 1, team: 'away' }).reason).toBe('set_started')
    expect(benchLineupAvailability({ match, events: [], setIndex: 1, team: 'home', matchOver: true }).reason).toBe('match_over')
  })
  it('a time-out: after the line-up, not in the interval, not during a replay, not a third', () => {
    const lu = lineupEv()
    expect(benchTimeoutAvailability({ events: [], setIndex: 1, team: 'home' }).reason).toBe('no_lineup')
    expect(benchTimeoutAvailability({ events: [lu], setIndex: 1, team: 'home' }).allowed).toBe(true)
    expect(benchTimeoutAvailability({ events: [lu], setIndex: 1, team: 'home', intervalRunning: true }).reason).toBe('set_interval')
    expect(benchTimeoutAvailability({ events: [lu, point(), ev('replay', {})], setIndex: 1, team: 'home' }).reason).toBe('replay_pending')
    const two = [lu, ev('timeout', {}), point(), ev('timeout', {})]
    expect(benchTimeoutAvailability({ events: two, setIndex: 1, team: 'home' }).reason).toBe('third_timeout')
    expect(benchTimeoutAvailability({ events: [lu, point(), ev('sanction', { type: 'delay_warning' })], setIndex: 1, team: 'home' }).reason).toBe('after_delay_warning')
  })
  it('a substitution: after the line-up, not 7, not a second request in one interruption', () => {
    const lu = lineupEv()
    expect(benchSubstitutionAvailability({ events: [], setIndex: 1, team: 'home' }).reason).toBe('no_lineup')
    expect(benchSubstitutionAvailability({ events: [lu], setIndex: 1, team: 'home' }).allowed).toBe(true)
    const six = [lu, ...[1, 2, 3, 4, 5, 6].map((i) => ev('substitution', { playerOut: i, playerIn: i + 6 }))]
    expect(benchSubstitutionAvailability({ events: six, setIndex: 1, team: 'home' }).reason).toBe('substitution_limit')
    const closed = [lu, point(), ev('substitution', { playerOut: 1, playerIn: 8 }), ev('timeout', { team: 'away' })]
    expect(benchSubstitutionAvailability({ events: closed, setIndex: 1, team: 'home' }).reason).toBe('second_substitution_request')
  })
})

describe('the bench line-up editor', () => {
  it('six different roster players, no libero', () => {
    const r = benchLineupCheck({ lineup: { I: 1, II: 2, III: 3, IV: 7, V: 5, VI: 6 }, players, team: 'home' })
    expect(r.canSend).toBe(true)
    expect(r.payload).toEqual({ lineup: { I: 1, II: 2, III: 3, IV: 7, V: 5, VI: 6 } })
    const dup = benchLineupCheck({ lineup: { I: 1, II: 1, III: 3, IV: 7, V: 5, VI: 6 }, players, team: 'home' })
    expect(dup.errors).toMatchObject({ I: 'duplicate', II: 'duplicate' })
    expect(dup.canSend).toBe(false)
    const lib = benchLineupCheck({ lineup: { I: 13, II: 2, III: 3, IV: 7, V: 5, VI: 6 }, players, team: 'home' })
    expect(lib.errors.I).toBe('libero')
    expect(benchLineupCheck({ lineup: { I: 99, II: 2, III: 3, IV: 7, V: 5, VI: 6 }, players, team: 'home' }).errors.I).toBe('notOnRoster')
    expect(benchLineupCheck({ lineup: { I: 1, II: 2 }, players, team: 'home' }).canSend).toBe(false)
  })
  it('the captain not among the six: a game captain among them (FIVB 5.2)', () => {
    const lineup = LU // no 7
    const none = benchLineupCheck({ lineup, players, team: 'home' })
    expect(none.needsGameCaptain).toBe(true)
    expect(none.canSend).toBe(false)
    expect(none.gameCaptainChoices).toEqual(['1', '2', '3', '4', '5', '6'])
    const off = benchLineupCheck({ lineup, players, team: 'home', gameCaptain: 9 })
    expect(off.canSend).toBe(false)
    const ok = benchLineupCheck({ lineup, players, team: 'home', gameCaptain: '4' })
    expect(ok.canSend).toBe(true)
    expect(ok.payload).toEqual({ lineup: LU, gameCaptain: 4 })
    // with the captain on court no game captain is sent
    expect(benchLineupCheck({ lineup: { ...LU, VI: 7 }, players, team: 'home', gameCaptain: 4 }).payload).toEqual({ lineup: { ...LU, VI: 7 } })
  })
  it('a disqualified player cannot start a set', () => {
    const events = [ev('sanction', { playerNumber: 3, type: 'disqualification' })]
    expect(benchLineupCheck({ lineup: { ...LU, VI: 7 }, players, events, team: 'home' }).errors.III).toBe('disqualified')
  })
})

describe('the prepared substitution', () => {
  it('who may go off and come on, and why not', () => {
    const lu = lineupEv({ ...LU, VI: 7 })
    const events = [lu, point(), ev('substitution', { playerOut: 2, playerIn: 8 }), point(), ev('lineup', { lineup: { ...LU, II: 8, VI: 7 } })]
    const c = benchSubstitutionChoices({ events, setIndex: 1, team: 'home', players })
    expect(c.onCourt.map((p) => p.number)).toEqual([1, 8, 3, 4, 5, 7])
    expect(c.remaining).toBe(5)
    const for1 = Object.fromEntries(c.candidatesFor(1).map((x) => [x.number, x.reason]))
    expect(for1[9]).toBe(null)
    expect(for1[2]).toBe('wrong_partner') // 2 may only come back for 8
    expect(for1[13]).toBe('libero')
    const for8 = Object.fromEntries(c.candidatesFor(8).map((x) => [x.number, x.reason]))
    expect(for8[2]).toBe(null)
    expect(for8[9]).toBe('wrong_partner')
    expect(c.pairIssue({ out: 8, in: 2 })).toBe(null)
    expect(c.pairIssue({ out: 1, in: 2 })).toBe('wrong_partner')
    expect(c.pairIssue({ out: 11, in: 9 })).toBe('not_on_court')
    expect(c.pairIssue({ out: 1, in: 3 })).toBe('not_on_bench')
  })
  it('several pairs: nobody twice, the count goes down, the captain going off asks a game captain', () => {
    const events = [lineupEv({ ...LU, VI: 7 }), point()]
    const pairs = [{ out: 7, in: 9 }, { out: 1, in: 10 }]
    const c = benchSubstitutionChoices({ events, setIndex: 1, team: 'home', players, pairs })
    expect(c.remaining).toBe(4)
    expect(c.onCourt.find((p) => p.number === 7).reason).toBe('paired')
    expect(c.candidatesFor(2).find((x) => x.number === 9).reason).toBe('paired')
    expect(c.captainGoesOff).toBe(true)
    expect(c.gameCaptainChoices).toEqual(['2', '3', '4', '5', '9', '10'])
    // the captain coming back on is game captain again
    const back = benchSubstitutionChoices({ events: [lineupEv({ ...LU }), ev('court_captain_designation', { playerNumber: 4 }), point()], setIndex: 1, team: 'home', players, pairs: [{ out: 4, in: 7 }] })
    expect(back.captainGoesOff).toBe(false)
  })
  it('the player who just came on cannot go off before a rally', () => {
    const events = [lineupEv({ ...LU, VI: 7 }), point(), ev('substitution', { playerOut: 2, playerIn: 8 }), ev('lineup', { lineup: { ...LU, II: 8, VI: 7 } })]
    const c = benchSubstitutionChoices({ events, setIndex: 1, team: 'home', players })
    expect(c.onCourt.find((p) => p.number === 8).reason).toBe('no_rally_since_entry')
  })
  it('sent off and the court captain', () => {
    const events = [lineupEv(), ev('sanction', { playerNumber: 9, type: 'expulsion' }), ev('court_captain_designation', { playerNumber: 5 })]
    expect(isSentOff(events, 'home', 9, 1)).toBe(true)
    expect(isSentOff(events, 'home', 9, 2)).toBe(false)
    expect(courtCaptainOf(events, 1, 'home', players)).toBe('5')
    expect(courtCaptainOf([lineupEv({ ...LU, I: 7 })], 1, 'home', players)).toBe('7')
  })
})

describe('the bench\'s requests', () => {
  const r1 = { id: 'br-1', kind: 'lineup', setIndex: 1, lineup: LU }
  it('sent, acknowledged, declined, sent again, accepted', () => {
    let s = benchRequestsReducer({}, { type: 'sent', request: r1, at: 1 })
    expect(s['br-1'].status).toBe('sending')
    s = benchRequestsReducer(s, { type: 'ack', message: { id: 'br-1', status: 'pending', delivered: 1, superseded: [] } })
    expect(s['br-1']).toMatchObject({ status: 'pending', delivered: 1 })
    s = benchRequestsReducer(s, { type: 'response', message: { id: 'br-1', status: 'declined', reason: 'No 6 is injured' } })
    expect(s['br-1']).toMatchObject({ status: 'declined', reason: 'No 6 is injured' })
    s = benchRequestsReducer(s, { type: 'sent', request: { ...r1, id: 'br-2' }, at: 2 })
    s = benchRequestsReducer(s, { type: 'ack', message: { id: 'br-2', status: 'pending', delivered: 0, superseded: [] } })
    expect(latestBenchRequest(s, 'lineup', 1)).toMatchObject({ id: 'br-2', status: 'pending', delivered: 0 })
    s = benchRequestsReducer(s, { type: 'response', message: { id: 'br-2', status: 'accepted' } })
    expect(latestBenchRequest(s, 'lineup', 1).status).toBe('accepted')
    expect(latestBenchRequest(s, 'lineup', 2)).toBe(null)
  })
  it('no connection: not sent, nothing queued; a refusal says why', () => {
    let s = benchRequestsReducer({}, { type: 'notSent', request: { id: 'x', kind: 'timeout', setIndex: 1 } })
    expect(s.x).toMatchObject({ status: 'not_sent', reason: 'no_connection' })
    s = benchRequestsReducer(s, { type: 'sent', request: { id: 'y', kind: 'timeout', setIndex: 1 }, at: 5 })
    s = benchRequestsReducer(s, { type: 'refused', message: { id: 'y', reason: 'not-this-bench' } })
    expect(s.y).toMatchObject({ status: 'refused', reason: 'not-this-bench' })
    // sent on a socket that no longer answers: not sent once the wait is over
    s = benchRequestsReducer(s, { type: 'sent', request: { id: 'z', kind: 'timeout', setIndex: 1 }, at: 6 })
    s = benchRequestsReducer(s, { type: 'noAck', id: 'z' })
    expect(s.z).toMatchObject({ status: 'not_sent', reason: 'no_answer' })
    // an answer that came in time is kept
    s = benchRequestsReducer(s, { type: 'noAck', id: 'y' })
    expect(s.y.status).toBe('refused')
  })
  it('a newer request supersedes, a cancel goes, the relay\'s state after a reconnect wins', () => {
    let s = benchRequestsReducer({}, { type: 'sent', request: { id: 'a', kind: 'timeout', setIndex: 1 }, at: 1 })
    s = benchRequestsReducer(s, { type: 'sent', request: { id: 'b', kind: 'timeout', setIndex: 1 }, at: 2 })
    s = benchRequestsReducer(s, { type: 'ack', message: { id: 'b', status: 'pending', superseded: ['a'] } })
    expect(s.a.status).toBe('superseded')
    s = benchRequestsReducer(s, { type: 'sent', request: { id: 'c', kind: 'cancel', setIndex: 1, cancelId: 'b' }, at: 3 })
    s = benchRequestsReducer(s, { type: 'ack', message: { id: 'c', status: 'cancelled', cancelId: 'b' } })
    expect(s.b.status).toBe('cancelled')
    expect(s.c).toBeUndefined()
    s = benchRequestsReducer(s, { type: 'sent', request: { id: 'd', kind: 'substitution', setIndex: 1, pairs: [] }, at: 4 })
    s = benchRequestsReducer(s, { type: 'state', message: { requests: [{ id: 'e', kind: 'timeout', setIndex: 2, status: 'seen' }] } })
    expect(s.d.status).toBe('expired')
    expect(s.e).toMatchObject({ kind: 'timeout', status: 'seen' })
  })
})

describe('the scorer\'s queue', () => {
  const msg = (team, request, status = 'pending') => ({ type: 'bench-request', message: { team, request, status, at: 1 } })
  it('one per team and kind, line-ups per set; a cancel and an answer remove', () => {
    let q = scorerQueueReducer([], msg('home', { id: 'a', kind: 'timeout', setIndex: 1 }))
    q = scorerQueueReducer(q, msg('away', { id: 'b', kind: 'timeout', setIndex: 1 }))
    q = scorerQueueReducer(q, msg('home', { id: 'c', kind: 'timeout', setIndex: 1 }))
    expect(q.map((e) => e.request.id)).toEqual(['b', 'c'])
    q = scorerQueueReducer(q, msg('home', { id: 'l1', kind: 'lineup', setIndex: 2, lineup: LU }))
    q = scorerQueueReducer(q, msg('home', { id: 'l2', kind: 'lineup', setIndex: 3, lineup: LU }))
    expect(q).toHaveLength(4)
    q = scorerQueueReducer(q, msg('away', { id: 'x', kind: 'cancel', setIndex: 1, cancelId: 'c' }))
    expect(q).toHaveLength(4) // not the other team's
    q = scorerQueueReducer(q, msg('home', { id: 'x', kind: 'cancel', setIndex: 1, cancelId: 'c' }))
    expect(q.map((e) => e.request.id)).toEqual(['b', 'l1', 'l2'])
    q = scorerQueueReducer(q, { type: 'answered', team: 'away', id: 'b' })
    q = scorerQueueReducer(q, { type: 'prune', setIndex: 3 })
    expect(q.map((e) => e.request.id)).toEqual(['l2'])
    expect(scorerQueueReducer(q, msg('both', { id: 'z', kind: 'timeout', setIndex: 3 }))).toBe(q)
  })
})

describe('helpers', () => {
  it('ids are unique and URL safe without a secure context', () => {
    const a = newBenchRequestId()
    expect(a).toMatch(/^br-[0-9a-f]{24}$/)
    expect(newBenchRequestId()).not.toBe(a)
  })
  it('the set to send for, a started set, the court now', () => {
    expect(benchSetIndex([])).toBe(1)
    expect(benchSetIndex([{ index: 1, finished: true }, { index: 2 }])).toBe(2)
    expect(benchSetIndex([{ index: 1, finished: true }])).toBe(2)
    expect(setHasStarted([point(2)], 2)).toBe(true)
    expect(setHasStarted([point(1)], 2)).toBe(false)
    const a = lineupEv(LU)
    const b = ev('lineup', { lineup: { ...LU, I: 9 } })
    expect(latestLineup([b, a].sort(() => 0), 1, 'home')).toEqual({ ...LU, I: 9 })
  })
})
