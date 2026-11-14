import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeBenchRequest, normalizeBenchResponse, createBenchRequestStore, currentSetOfBundle, createWindowLimiter, benchView, refereeInfo } from '../lib/benchRequests.js'
import { pinRoleOf, tokenRoleOf } from '../lib/matchAccess.js'

const LINEUP = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 }

describe('bench request validation', () => {
  it('keeps the known fields of a line-up, numbers as integers', () => {
    const r = normalizeBenchRequest({ id: 'a-1', kind: 'lineup', setIndex: 2, lineup: { ...LINEUP, I: '1' }, gameCaptain: 4, extra: 'x', pin: '123456' })
    assert.deepEqual(r, { ok: true, request: { id: 'a-1', kind: 'lineup', setIndex: 2, lineup: LINEUP, gameCaptain: 4 } })
  })
  it('refuses incomplete, duplicate or out-of-range line-ups and a game captain off court', () => {
    assert.equal(normalizeBenchRequest({ id: 'a', kind: 'lineup', setIndex: 1, lineup: { I: 1, II: 2, III: 3, IV: 4, V: 5 } }).reason, 'bad-lineup')
    assert.equal(normalizeBenchRequest({ id: 'a', kind: 'lineup', setIndex: 1, lineup: { ...LINEUP, VI: 1 } }).reason, 'bad-lineup')
    assert.equal(normalizeBenchRequest({ id: 'a', kind: 'lineup', setIndex: 1, lineup: { ...LINEUP, VI: 100 } }).reason, 'bad-lineup')
    assert.equal(normalizeBenchRequest({ id: 'a', kind: 'lineup', setIndex: 1, lineup: { ...LINEUP, VI: 2.5 } }).reason, 'bad-lineup')
    assert.equal(normalizeBenchRequest({ id: 'a', kind: 'lineup', setIndex: 1, lineup: LINEUP, gameCaptain: 9 }).reason, 'bad-captain')
  })
  it('checks ids, kinds and sets', () => {
    assert.equal(normalizeBenchRequest(null).reason, 'bad-request')
    assert.equal(normalizeBenchRequest({ id: 'x'.repeat(65), kind: 'timeout', setIndex: 1 }).reason, 'bad-id')
    assert.equal(normalizeBenchRequest({ id: 'a b', kind: 'timeout', setIndex: 1 }).reason, 'bad-id')
    for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      assert.equal(normalizeBenchRequest({ id, kind: 'timeout', setIndex: 1 }).reason, 'bad-id', id)
      assert.equal(normalizeBenchRequest({ id: 'a', kind: 'cancel', cancelId: id, setIndex: 1 }).reason, 'bad-cancel', id)
    }
    assert.equal(normalizeBenchRequest({ id: 'a', kind: 'challenge', setIndex: 1 }).reason, 'bad-kind')
    assert.equal(normalizeBenchRequest({ id: 'a', kind: 'timeout', setIndex: 6 }).reason, 'bad-set')
    assert.equal(normalizeBenchRequest({ id: 'a', kind: 'timeout', setIndex: '1' }).reason, 'bad-set')
    assert.deepEqual(normalizeBenchRequest({ id: 'a', kind: 'timeout', setIndex: 1, pairs: [{ out: 1, in: 2 }] }).request, { id: 'a', kind: 'timeout', setIndex: 1 })
    assert.equal(normalizeBenchRequest({ id: 'a', kind: 'cancel', setIndex: 1 }).reason, 'bad-cancel')
  })
  it('substitution pairs: 1 to 6, nobody twice, no captain going off', () => {
    const ok = normalizeBenchRequest({ id: 's', kind: 'substitution', setIndex: 1, pairs: [{ out: 1, in: 7 }, { out: 2, in: 8 }], gameCaptain: 7 })
    assert.deepEqual(ok.request.pairs, [{ out: 1, in: 7 }, { out: 2, in: 8 }])
    assert.equal(ok.request.gameCaptain, 7)
    for (const pairs of [[], [{ out: 1, in: 1 }], [{ out: 1, in: 7 }, { out: 1, in: 8 }], [{ out: 1, in: 7 }, { out: 7, in: 8 }], Array.from({ length: 7 }, (_, i) => ({ out: i + 1, in: i + 20 }))]) {
      assert.equal(normalizeBenchRequest({ id: 's', kind: 'substitution', setIndex: 1, pairs }).reason, 'bad-pairs', JSON.stringify(pairs))
    }
    assert.equal(normalizeBenchRequest({ id: 's', kind: 'substitution', setIndex: 1, pairs: [{ out: 1, in: 7 }], gameCaptain: 1 }).reason, 'bad-captain')
  })
  it('responses: status and a short reason', () => {
    assert.deepEqual(normalizeBenchResponse({ id: 'a', status: 'declined', reason: '  ' + 'r'.repeat(300) }).response.reason.length, 200)
    assert.equal(normalizeBenchResponse({ id: 'a', status: 'maybe' }).reason, 'bad-status')
    assert.deepEqual(normalizeBenchResponse({ id: 'a', status: 'accepted', reason: '' }).response, { id: 'a', status: 'accepted' })
  })
})

describe('bench request store', () => {
  const lu = (id, setIndex = 1) => ({ id, kind: 'lineup', setIndex, lineup: LINEUP })
  it('a new line-up replaces the open one of that set, an accepted one locks it', () => {
    const s = createBenchRequestStore()
    s.add('m', 'home', lu('a'))
    const b = s.add('m', 'home', lu('b'))
    assert.deepEqual(b.superseded.map((e) => e.request.id), ['a'])
    assert.equal(s.add('m', 'home', lu('c', 2)).superseded.length, 0, 'another set is another line-up')
    assert.equal(s.add('m', 'away', lu('d')).superseded.length, 0, 'another team')
    assert.ok(s.answer('m', 'home', 'b', 'accepted'))
    assert.equal(s.add('m', 'home', lu('e')).reason, 'lineup-locked')
    assert.equal(s.answer('m', 'home', 'b', 'declined'), null, 'answered once')
    assert.equal(s.answer('m', 'away', 'c', 'accepted'), null, 'not the other team')
    assert.deepEqual(s.open('m').map((e) => e.request.id), ['c', 'd'])
    assert.deepEqual(s.ofTeam('m', 'home').map(benchView).map((v) => [v.id, v.status]), [['b', 'accepted'], ['c', 'pending']])
  })
  it('seen keeps it open, a decline keeps its reason, cancel drops an open one of the team', () => {
    const s = createBenchRequestStore()
    s.add('m', 'away', { id: 't', kind: 'timeout', setIndex: 1 })
    s.answer('m', 'away', 't', 'seen')
    assert.equal(s.open('m')[0].status, 'seen')
    assert.equal(s.add('m', 'home', { id: 'x', kind: 'cancel', setIndex: 1, cancelId: 't' }).reason, 'nothing-to-cancel')
    const c = s.add('m', 'away', { id: 'x', kind: 'cancel', setIndex: 1, cancelId: 't' })
    assert.equal(c.cancelled.request.id, 't')
    assert.equal(s.open('m').length, 0)
    s.add('m', 'away', { id: 'u', kind: 'timeout', setIndex: 1 })
    assert.equal(s.answer('m', 'away', 'u', 'declined', 'Both time-outs used').reason, 'Both time-outs used')
    assert.equal(s.add('m', 'home', { id: 'u', kind: 'timeout', setIndex: 1 }).reason, 'duplicate-id')
  })
  it('drops the requests of a set that is over and old ones', () => {
    const s = createBenchRequestStore({ ttlMs: 1000 })
    s.add('m', 'home', lu('a', 1), 0)
    s.add('m', 'home', lu('b', 2), 0)
    s.prune('m', 2, 10)
    assert.deepEqual(s.open('m').map((e) => e.request.id), ['b'])
    s.prune('m', 2, 2000)
    assert.equal(s.open('m').length, 0)
    assert.equal(s.size(), 0)
  })
  it('keeps at most a dozen per team, answered ones go first', () => {
    const s = createBenchRequestStore({ maxPerTeam: 3 })
    s.add('m', 'home', { id: 'l', kind: 'lineup', setIndex: 1, lineup: LINEUP })
    s.answer('m', 'home', 'l', 'accepted')
    s.add('m', 'home', { id: 't', kind: 'timeout', setIndex: 1 })
    s.add('m', 'home', { id: 's', kind: 'substitution', setIndex: 1, pairs: [{ out: 1, in: 7 }] })
    s.add('m', 'home', { id: 'l2', kind: 'lineup', setIndex: 2, lineup: LINEUP })
    assert.deepEqual(s.ofTeam('m', 'home').map((e) => e.request.id), ['t', 's', 'l2'])
  })
  it('the referee note never carries a line-up', () => {
    const s = createBenchRequestStore()
    const { entry } = s.add('m', 'home', { id: 's', kind: 'substitution', setIndex: 1, pairs: [{ out: 1, in: 7 }] })
    assert.deepEqual(refereeInfo('m', entry), { type: 'bench-request-info', matchId: 'm', team: 'home', id: 's', kind: 'substitution', setIndex: 1, pairs: [{ out: 1, in: 7 }], status: 'pending' })
  })
})

describe('helpers', () => {
  it('the current set of a relayed bundle', () => {
    assert.equal(currentSetOfBundle({ sets: [] }), 1)
    assert.equal(currentSetOfBundle({ sets: [{ index: 1, finished: true }, { index: 2, finished: false }] }), 2)
    assert.equal(currentSetOfBundle({ sets: [{ index: 1, finished: true }] }), 2)
  })
  it('which role a PIN or a token proves', () => {
    const m = { homeTeamPin: '111111', awayTeamPin: '222222', refereePin: '333333', gamePin: '444444', homeTeamConnectionEnabled: true, awayTeamConnectionEnabled: false, refereeConnectionEnabled: true }
    assert.equal(pinRoleOf(m, '111111'), 'home')
    assert.equal(pinRoleOf(m, '222222'), null, 'a bench switched off')
    assert.equal(pinRoleOf(m, '333333'), 'referee')
    assert.equal(pinRoleOf(m, '444444'), null, 'the game PIN is no bench')
    assert.equal(tokenRoleOf({ r: 'bench_away' }), 'away')
    assert.equal(tokenRoleOf({ r: 'homeTeam' }), 'home')
    assert.equal(tokenRoleOf({ r: 'viewer' }), null)
  })
  it('30 a minute per key', () => {
    const l = createWindowLimiter({ max: 2, windowMs: 1000 })
    assert.equal(l.hit('a', 0), false)
    assert.equal(l.hit('a', 1), false)
    assert.equal(l.hit('a', 2), true)
    assert.equal(l.hit('a', 1001), false)
  })
})
