import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { createPgQuery } from '../lib/pgQuery.js'
import { createMatchRestore, createAttemptLimiter, createPinFailureBudget, pinRangesOf, pinRangeLabel, pinScope, PIN_RANGE_FAILURE_MAX } from '../lib/matchRestore.js'
import { SKIP_PG, createTestDatabase, quietLogger } from './helpers/pgTestDb.js'
import { redactText } from '../lib/errorTracker.js'

describe('createAttemptLimiter', () => {
  it('allows max attempts per key and window, then limits', () => {
    const l = createAttemptLimiter({ max: 2, windowMs: 60000 })
    assert.equal(l.isLimited('a'), false)
    assert.equal(l.isLimited('a'), false)
    assert.equal(l.isLimited('a'), true)
    assert.equal(l.isLimited('b'), false)
    l.reset('a')
    assert.equal(l.isLimited('a'), false)
  })

  it('keeps the key map bounded, evicting the oldest windows first', () => {
    const l = createAttemptLimiter({ max: 1, windowMs: 60000, maxKeys: 3 })
    for (let i = 0; i < 1000; i++) l.isLimited(`k${i}`)
    assert.equal(l.size, 3)
    // The newest keys are still counted, the oldest were evicted.
    assert.equal(l.isLimited('k999'), true)
    assert.equal(l.isLimited('k0'), false)
  })

  it('refund takes one attempt back', () => {
    const l = createAttemptLimiter({ max: 1, windowMs: 60000 })
    assert.equal(l.isLimited('a'), false)
    l.refund('a')
    assert.equal(l.isLimited('a'), false)
    assert.equal(l.isLimited('a'), true)
  })

  it('opens again after the window', async () => {
    const l = createAttemptLimiter({ max: 1, windowMs: 20 })
    assert.equal(l.isLimited('k'), false)
    assert.equal(l.isLimited('k'), true)
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(l.isLimited('k'), false)
  })
})

describe('createPinFailureBudget', () => {
  it('locks one scope of an address, for the right PIN too; other scopes and addresses go on', () => {
    const b = createPinFailureBudget({ max: 3, ipMax: 10, windowMs: 60000 })
    for (let i = 0; i < 3; i++) assert.equal(b.isLimited('hall', 'any:indoor:referee'), false)
    // the 4th attempt of that scope is refused before anything is compared
    assert.equal(b.isLimited('hall', 'any:indoor:referee'), true)
    assert.equal(b.isLimited('hall', 'any:indoor:bench_home'), false)
    assert.equal(b.isLimited('hall', 'm:game:match-1'), false)
    assert.equal(b.isLimited('elsewhere', 'any:indoor:referee'), false)
  })

  it('a ceiling per address across scopes; refused attempts do not count toward it', () => {
    const b = createPinFailureBudget({ max: 3, ipMax: 5, windowMs: 60000 })
    for (let i = 0; i < 3; i++) b.isLimited('hall', 'a')
    // refused by the scope: not compared, not counted in the ceiling
    for (let i = 0; i < 10; i++) assert.equal(b.isLimited('hall', 'a'), true)
    assert.equal(b.isLimited('hall', 'b'), false)
    assert.equal(b.isLimited('hall', 'c'), false)
    // 5 counted: every scope of the address is refused now
    assert.equal(b.isLimited('hall', 'd'), true)
    assert.equal(b.isLimited('elsewhere', 'd'), false)
  })

  it('refund gives the attempt back to the scope and the ceiling', () => {
    const b = createPinFailureBudget({ max: 1, ipMax: 1, windowMs: 60000 })
    assert.equal(b.isLimited('hall', 'a'), false)
    b.refund('hall', 'a')
    assert.equal(b.isLimited('hall', 'b'), false)
    b.refund('hall', 'b')
    assert.equal(b.isLimited('hall', 'a'), false)
    assert.equal(b.isLimited('hall', 'a'), true)
  })

  it('the same wrong PIN again in the same scope is not a new guess', () => {
    const b = createPinFailureBudget({ max: 3, ipMax: 10, windowMs: 60000 })
    // one typo checked twice (the backend, then the relay)
    for (const pin of ['111111', '222222']) {
      assert.equal(b.isLimited('hall', 'any:indoor:referee'), false)
      assert.equal(b.repeated('hall', 'any:indoor:referee', pin), false)
      assert.equal(b.isLimited('hall', 'any:indoor:referee'), false)
      assert.equal(b.repeated('hall', 'any:indoor:referee', pin), true)
    }
    // two typos counted, not four: one more attempt, then the scope is locked
    assert.equal(b.isLimited('hall', 'any:indoor:referee'), false)
    assert.equal(b.isLimited('hall', 'any:indoor:referee'), true)
    // the same PIN in another scope, or from another address, is a guess of its own
    assert.equal(b.isLimited('hall', 'any:indoor:bench_home'), false)
    assert.equal(b.repeated('hall', 'any:indoor:bench_home', '111111'), false)
    assert.equal(b.isLimited('other', 'any:indoor:referee'), false)
    assert.equal(b.repeated('other', 'any:indoor:referee', '111111'), false)
  })

  // 2026-10-26: a hall's wrong PINs for other matches spent the address's
  // ceiling, and the scoreboard re-proving its own match was refused
  it('scopeOnly: the scope\'s limit alone, the ceiling neither asked nor counted', () => {
    const b = createPinFailureBudget({ max: 3, ipMax: 3, windowMs: 60000 })
    for (const scope of ['a', 'b', 'c']) assert.equal(b.isLimited('hall', scope), false)
    assert.equal(b.isLimited('hall', 'm:game:1'), true, 'the ceiling is spent')
    // the trusted check of that scope still goes, and is still limited by it
    for (let i = 0; i < 3; i++) assert.equal(b.isLimited('hall', 'm:game:1', { scopeOnly: true }), false)
    assert.equal(b.isLimited('hall', 'm:game:1', { scopeOnly: true }), true)
    // its refunds give the ceiling nothing back it did not take
    const c = createPinFailureBudget({ max: 3, ipMax: 2, windowMs: 60000 })
    assert.equal(c.isLimited('hall', 'a'), false)
    assert.equal(c.isLimited('hall', 'm:game:1', { scopeOnly: true }), false)
    c.refund('hall', 'm:game:1', { scopeOnly: true })
    assert.equal(c.isLimited('hall', 'b'), false)
    assert.equal(c.isLimited('hall', 'c'), true)
  })

  it('opens again after the window', async () => {
    const b = createPinFailureBudget({ max: 1, ipMax: 1, windowMs: 20 })
    assert.equal(b.isLimited('hall', 'a'), false)
    assert.equal(b.isLimited('hall', 'a'), true)
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(b.isLimited('hall', 'a'), false)
  })
})

// Wrong PINs per match and PIN type, per game number and per PIN-only search,
// counted across address buckets (an attacker with many buckets never
// reaches a per-address limit). Owner decision 1 (audit 2026-11, SEC-05 /
// SEC-06): only the guessing address ranges are refused; every caller
// together raises an ops alert, never a refusal. The old rule refused the
// right PIN to everyone once 30 wrong ones were counted for a match (100
// for a PIN-only search), and these tests pinned that.
describe('pinRangesOf', () => {
  it('IPv4: the address and its /24; IPv6: the /64, its /56 and /48; anything else one range', () => {
    assert.deepEqual(pinRangesOf('203.0.113.7', 10), [{ range: '203.0.113.7', max: 10 }, { range: '203.0.113.0/24', max: 20 }])
    assert.deepEqual(pinRangesOf('2001:db8:7a00:1ff::/64', 10), [
      { range: '2001:db8:7a00:1ff::/64', max: 10 },
      { range: '2001:db8:7a00:100::/56', max: 15 },
      { range: '2001:db8:7a00::/48', max: 20 }
    ])
    assert.deepEqual(pinRangesOf('hall', 10), [{ range: 'hall', max: 10 }])
    assert.deepEqual(pinRangesOf(undefined), [{ range: 'unknown', max: PIN_RANGE_FAILURE_MAX }])
  })
})

describe('createPinFailureBudget across addresses', () => {
  const quiet = () => {}
  // a fresh /64 of the /48 2001:db8:aa00::/48 (one /56 per 256 of them)
  const inA = (i) => `2001:db8:aa00:${i.toString(16)}::/64`
  const inB = (i) => `2001:db8:bb00:${i.toString(16)}::/64`

  it('wrong PINs from one range lock that range for the match and PIN type, the right PIN too; other ranges go on; one log line', () => {
    const lines = []
    const b = createPinFailureBudget({ rangeMax: 3, matchMax: 1000, log: (l) => lines.push(l) })
    // 6 wrong PINs from 6 /64s of one /48 (a /56 each: share 5 never reached,
    // /48 share 6): no address, no /56 is over its share
    for (let i = 0; i < 6; i++) assert.equal(b.isLimited(inA(i * 256), 'm:referee:match-1'), false)
    // the 7th from that /48, whatever /64: refused before anything is compared
    assert.equal(b.isLimited(inA(9 * 256), 'm:referee:match-1'), true)
    assert.equal(b.locked('match-1', 'referee', inA(10 * 256)), true)
    assert.equal(lines.length, 1)
    // the range by its width and pseudonym, never its address (PL-R3)
    assert.ok(lines[0].startsWith(`[PIN] match match-1: 6 wrong referee PINs from ${b.rangeLabel('2001:db8:aa00::/48')} within 10 min`), lines[0])
    assert.match(b.rangeLabel('2001:db8:aa00::/48'), /^IPv6 \/48 #[b-z]{8}$/)
    // another range: the right PIN passes (counted up front, refunded)
    assert.equal(b.locked('match-1', 'referee', inB(0)), false)
    assert.equal(b.isLimited(inB(0), 'm:referee:match-1'), false)
    b.refund(inB(0), 'm:referee:match-1')
    assert.equal(b.isLimited('198.51.100.7', 'm:referee:match-1'), false)
    // the match's other PIN types, and another match, go on for the guessing range too
    assert.equal(b.isLimited(inA(11 * 256), 'm:bench_home:match-1'), false)
    assert.equal(b.isLimited(inA(11 * 256), 'm:referee:match-2'), false)
    // refused by its range: the address's ceiling was not charged for it
    const c = createPinFailureBudget({ max: 5, ipMax: 2, rangeMax: 1, log: quiet })
    assert.equal(c.isLimited('ip-1', 'm:referee:match-1'), false)
    assert.equal(c.isLimited('ip-1', 'm:referee:match-1'), true, 'its range is at its share')
    assert.equal(c.isLimited('ip-1', 'm:referee:match-2'), false)
    assert.equal(c.isLimited('ip-1', 'm:referee:match-3'), true, 'the ceiling (2) is spent')
  })

  it('an address locks before its wider ranges; an IPv4 /24 locks at twice an address\'s share', () => {
    const b = createPinFailureBudget({ rangeMax: 3, matchMax: 1000, log: quiet })
    for (let i = 0; i < 3; i++) assert.equal(b.isLimited('203.0.113.1', 'm:game:match-1'), false)
    assert.equal(b.isLimited('203.0.113.1', 'm:game:match-1'), true, 'the address is at its share')
    // the rest of its /24: 3 more (6 in all), then the /24 is locked
    for (let i = 2; i < 5; i++) assert.equal(b.isLimited(`203.0.113.${i}`, 'm:game:match-1'), false)
    assert.equal(b.isLimited('203.0.113.9', 'm:game:match-1'), true)
    assert.equal(b.isLimited('203.0.114.9', 'm:game:match-1'), false, 'another /24')
  })

  it('all callers past the threshold raise one ops alert per window; nobody is refused for it', () => {
    let t = 1000000
    const alerts = []
    const lines = []
    const b = createPinFailureBudget({ rangeMax: 2, matchMax: 4, windowMs: 60000, now: () => t, log: (l) => lines.push(l), alert: (a) => alerts.push(a) })
    for (let i = 0; i < 10; i++) assert.equal(b.isLimited(`198.51.${i}.1`, 'm:referee:match-1'), false, `caller ${i}`)
    assert.equal(alerts.length, 1)
    assert.deepEqual({ ...alerts[0], ranges: undefined, message: undefined }, { scope: 'match', key: 'match-1', type: 'referee', types: [{ type: 'referee', count: 4 }], count: 4, windowMinutes: 1, ranges: undefined, otherRanges: 0, message: undefined })
    assert.deepEqual(alerts[0].ranges.map((r) => r.range).sort(), ['198.51.0.0/24', '198.51.1.0/24', '198.51.2.0/24', '198.51.3.0/24'].map((r) => b.rangeLabel(r)).sort())
    assert.match(alerts[0].message, /^\[PIN\] match match-1: 4 wrong referee PINs from all callers within 1 min \(IPv4 \/24 #[b-z]{8} x1/)
    assert.doesNotMatch(JSON.stringify(alerts) + lines.join('\n'), /198\.51/, 'never an address (PL-R3)')
    assert.doesNotMatch(JSON.stringify(alerts), /\b\d{6}\b/, 'never a PIN')
    assert.equal(lines.filter((l) => l.includes('from all callers')).length, 1)
    // the right PIN from yet another range still passes
    assert.equal(b.isLimited('192.0.2.1', 'm:referee:match-1'), false)
    // a check of all the match's PINs counts each type: one alert for the match all the same
    const m2 = createPinFailureBudget({ rangeMax: 2, matchMax: 2, log: quiet, alert: (a) => alerts.push(a) })
    for (let i = 0; i < 3; i++) m2.isLimited(`198.52.${i}.1`, 'm:all:match-2', { kinds: ['referee', 'bench_home', 'game'] })
    assert.equal(alerts.length, 2)
    assert.equal(alerts[1].type, 'referee/bench_home/game')
    assert.deepEqual(alerts[1].types, [{ type: 'referee', count: 2 }, { type: 'bench_home', count: 2 }, { type: 'game', count: 2 }])
    assert.match(alerts[1].message, /^\[PIN\] match match-2: 2 wrong referee\/bench_home\/game PINs from all callers/)
    // a new window: a new alert once the threshold is reached again
    t += 61000
    for (let i = 20; i < 24; i++) b.isLimited(`198.51.${i}.1`, 'm:referee:match-1')
    assert.equal(alerts.length, 3)
    // a PIN-only search has a threshold of its own
    const s = []
    const c = createPinFailureBudget({ rangeMax: 2, searchMax: 3, log: quiet, alert: (a) => s.push(a) })
    for (let i = 0; i < 5; i++) assert.equal(c.isLimited(`198.51.${i}.1`, 'any:beach:referee'), false)
    assert.equal(s.length, 1)
    assert.equal(s[0].scope, 'search')
    assert.equal(s[0].type, 'beach:referee')
    assert.match(s[0].message, /lookups without a match from all callers/)
  })

  it('right PINs are refunded and never add up', () => {
    const alerts = []
    const b = createPinFailureBudget({ rangeMax: 2, matchMax: 2, log: quiet, alert: (a) => alerts.push(a) })
    for (let i = 0; i < 10; i++) {
      assert.equal(b.isLimited('hall', 'm:game:match-1'), false)
      b.refund('hall', 'm:game:match-1')
    }
    assert.equal(b.locked('match-1', 'game', 'hall'), false)
    assert.equal(b.tracks('match-1'), false, 'a key refunded to nothing is dropped')
    assert.equal(alerts.length, 0)
  })

  it('the lock of a range ends after its cool-down', () => {
    let t = 1000000
    const b = createPinFailureBudget({ rangeMax: 2, windowMs: 60000, lockMs: 120000, now: () => t, log: quiet })
    assert.equal(b.isLimited('ip-1', 'm:game:match-1'), false)
    assert.equal(b.isLimited('ip-1', 'm:game:match-1'), false)
    assert.equal(b.isLimited('ip-1', 'm:game:match-1'), true)
    t += 119000
    assert.equal(b.locked('match-1', 'game', 'ip-1'), true, 'still in the cool-down')
    assert.equal(b.locked('match-1', 'game', 'ip-2'), false)
    t += 2000
    assert.equal(b.locked('match-1', 'game', 'ip-1'), false)
  })

  it('a new PIN starts its counter again', () => {
    const b = createPinFailureBudget({ rangeMax: 2, log: quiet })
    for (let i = 0; i < 3; i++) b.isLimited('ip-1', 'm:referee:match-1')
    b.isLimited('ip-1', 'm:bench_home:match-1')
    assert.equal(b.locked('match-1', 'referee', 'ip-1'), true)
    b.pinChanged('match-1', ['referee'])
    assert.equal(b.locked('match-1', 'referee', 'ip-1'), false)
    // the PIN types not changed keep their count
    b.isLimited('ip-1', 'm:bench_home:match-1')
    assert.equal(b.isLimited('ip-1', 'm:bench_home:match-1'), true)
  })

  it('PIN-only searches have counts of their own, apart from the matches; a lookup from another range goes on', () => {
    const lines = []
    const b = createPinFailureBudget({ rangeMax: 2, max: 100, ipMax: 100, log: (l) => lines.push(l) })
    for (let i = 0; i < 4; i++) assert.equal(b.isLimited(inA(i * 256), 'any:beach:referee'), false)
    assert.equal(b.isLimited(inA(7 * 256), 'any:beach:referee'), true, 'the guessing /48')
    assert.equal(lines.length, 1)
    assert.ok(lines[0].startsWith(`[PIN] 4 wrong beach:referee PINs in lookups without a match from ${b.rangeLabel('2001:db8:aa00::/48')}`), lines[0])
    // the right PIN of an OpenBeach referee elsewhere (OB names no match)
    assert.equal(b.isLimited(inB(0), 'any:beach:referee'), false)
    assert.equal(b.isLimited('198.51.100.9', 'any:beach:referee'), false)
    // another PIN type is another search; no match was locked by them
    assert.equal(b.isLimited(inA(7 * 256), 'any:beach:bench_team1'), false)
    assert.equal(b.isLimited(inA(7 * 256), 'any:indoor:referee'), false)
    assert.equal(b.isLimited(inA(7 * 256), 'm:referee:match-1'), false)
    // and a match locked for a range leaves the search alone
    b.isLimited('ip-5', 'm:bench_home:match-1')
    b.isLimited('ip-5', 'm:bench_home:match-1')
    assert.equal(b.locked('match-1', 'bench_home', 'ip-5'), true)
    assert.equal(b.isLimited('ip-5', 'any:indoor:bench_home'), false)
  })

  it('the same wrong PIN again from the same address is no new guess across addresses either', () => {
    const b = createPinFailureBudget({ rangeMax: 2, log: quiet })
    for (let i = 0; i < 3; i++) {
      assert.equal(b.isLimited('ip-1', 'm:referee:match-1'), false)
      b.repeated('ip-1', 'm:referee:match-1', '111111')
    }
    assert.equal(b.isLimited('ip-1', 'm:referee:match-1'), false)
    assert.equal(b.isLimited('ip-1', 'm:referee:match-1'), true)
  })

  // the scoreboard of the device the database names as the match's scorer,
  // re-proving its own match on the relay (server.js verifyRelayClaim)
  it('scopeOnly: neither refused nor counted across addresses', () => {
    const b = createPinFailureBudget({ rangeMax: 2, log: quiet })
    for (let i = 0; i < 3; i++) b.isLimited('hall', 'm:game:match-1')
    assert.equal(b.isLimited('hall', 'm:game:match-1'), true)
    assert.equal(b.isLimited('hall', 'm:game:match-1', { scopeOnly: true }), false)
    b.refund('hall', 'm:game:match-1', { scopeOnly: true })
    assert.equal(b.locked('match-1', 'game', 'hall'), true)
    const c = createPinFailureBudget({ rangeMax: 1, log: quiet })
    for (let i = 0; i < 3; i++) assert.equal(c.isLimited('hall', 'm:game:match-1', { scopeOnly: true }), false)
    assert.equal(c.tracks('match-1'), false)
  })

  it('a check of several PIN types at once counts each, and leaves out the ones locked for the caller', () => {
    const b = createPinFailureBudget({ rangeMax: 2, log: quiet })
    const kinds = ['referee', 'bench_home', 'game']
    // two wrong game PINs from this range lock its game PIN checks
    b.isLimited('ip-1', 'm:game:match-1')
    b.isLimited('ip-1', 'm:game:match-1')
    const open = b.openKinds('match-1', kinds, 'ip-1')
    assert.deepEqual(open, ['referee', 'bench_home'])
    assert.deepEqual(b.openKinds('match-1', kinds, 'ip-2'), kinds, 'another range: all open')
    // a wrong PIN compared with the open ones counts against each of them
    assert.equal(b.isLimited('ip-1', 'm:all:match-1', { kinds: open }), false)
    assert.equal(b.isLimited('ip-1', 'm:all:match-1', { kinds: open }), false)
    assert.deepEqual(b.openKinds('match-1', kinds, 'ip-1'), [])
    assert.equal(b.isLimited('ip-1', 'm:referee:match-1'), true)
    assert.equal(b.isLimited('ip-2', 'm:referee:match-1'), false)
    // a right one gives back what it took
    const c = createPinFailureBudget({ rangeMax: 1, log: quiet })
    assert.equal(c.isLimited('ip-1', 'm:all:match-1', { kinds }), false)
    c.refund('ip-1', 'm:all:match-1', { kinds })
    assert.deepEqual(c.openKinds('match-1', kinds, 'ip-1'), kinds)
  })

  // restore-by-pin compares one PIN with every match of a game number
  it('restore-by-pin counts per game number and range, apart from the matches\' own PINs', () => {
    const lines = []
    const alerts = []
    const b = createPinFailureBudget({ rangeMax: 3, matchMax: 5, log: (l) => lines.push(l), alert: (a) => alerts.push(a) })
    for (let i = 0; i < 6; i++) assert.equal(b.gameLimited(8181, `198.18.12.${i}`), false)
    assert.equal(b.gameLimited(8181, '198.18.12.200'), true, 'the guessing /24')
    assert.equal(lines.filter((l) => l.startsWith(`[PIN] game number 8181: 6 wrong game PINs in restore-by-pin from ${b.rangeLabel('198.18.12.0/24')}`)).length, 1)
    assert.equal(alerts.length, 1)
    assert.equal(alerts[0].scope, 'game')
    // the right PIN from another range, another game number, and every match's own checks, go on
    assert.equal(b.gameLimited(8181, '198.18.13.1'), false)
    b.gameRefund(8181, '198.18.13.1')
    assert.equal(b.gameLimited(8282, '198.18.12.200'), false)
    assert.equal(b.tracksAny(), false)
    assert.equal(b.isLimited('198.18.12.200', 'm:game:match-1'), false)
    // a right PIN gives its attempt back
    const c = createPinFailureBudget({ rangeMax: 1, log: quiet })
    for (let i = 0; i < 3; i++) {
      assert.equal(c.gameLimited(5, 'ip-1'), false)
      c.gameRefund(5, 'ip-1')
    }
  })

  // the relay's database check of a scoreboard claim: the room key is the
  // caller's choice, the rows it compares with are not
  it('across: the matches named are counted, not the scope\'s own', () => {
    const b = createPinFailureBudget({ rangeMax: 2, log: quiet })
    const across = [['row-1', 'game'], ['row-2', 'game']]
    assert.equal(b.isLimited('ip-1', 'm:game:room-a', { across }), false)
    assert.equal(b.isLimited('ip-1', 'm:game:room-b', { across: [['row-1', 'game']] }), false)
    assert.equal(b.tracks('room-a'), false)
    assert.equal(b.tracks('room-b'), false)
    // row-1 is locked for that range in every scope that compares it, its own included
    assert.equal(b.isLimited('ip-1', 'm:game:room-c', { across: [['row-1', 'game']] }), true)
    assert.equal(b.isLimited('ip-1', 'm:game:row-1'), true)
    assert.equal(b.isLimited('ip-2', 'm:game:row-1'), false)
    assert.equal(b.locked('row-2', 'game', 'ip-1'), false)
    // a right PIN gives back what it took; scopeOnly counts nothing across addresses
    b.refund('ip-1', 'm:game:room-a', { across: [['row-2', 'game']] })
    b.refund('ip-2', 'm:game:row-1')
    assert.equal(b.tracks('row-2'), false)
    for (let i = 0; i < 3; i++) assert.equal(b.isLimited(`ip-s${i}`, 'm:game:room-d', { scopeOnly: true, across: [['row-2', 'game']] }), false)
    assert.equal(b.tracks('row-2'), false)
  })

  // Audit 2026-11 review, PL-R2: a full table counted no new key, so a fresh
  // range was neither counted nor refused (this test pinned that). Now a
  // full table makes room by dropping what counts least.
  it('a full table makes room by dropping what counts least: a fresh /48 is still refused after its 40th wrong PIN', () => {
    const alerts = []
    const lines = []
    // production shares (an IPv6 /48: 40), a table of 300 keys
    const b = createPinFailureBudget({ lockKeys: 300, alertKeys: 100, max: 1e9, ipMax: 1e9, log: (l) => lines.push(l), alert: (a) => alerts.push(a) })
    // the flood: wrong restore-by-pin guesses at 200 game numbers from fresh
    // /64s (each in a /56 of its own) of ten /48s, until the table is full
    let n = 0
    const flood = (k) => { for (let i = 0; i < k; i++, n++) b.gameLimited(1000 + (n % 200), `2001:db8:${(n % 10).toString(16)}:${((n >> 4) & 0xffff).toString(16)}::/64`) }
    flood(2000)
    assert.equal(alerts.filter((a) => /the game counts are full/.test(a.message)).length, 1, 'one alert per window')
    // a fresh /48 guesses game 7, one /64 in each of 40 /56s (the /64 and /56 never reach their shares), the flood going on
    const fresh = (i) => `2001:db8:ffff:${(i << 8).toString(16)}::/64`
    for (let i = 0; i < 40; i++) {
      flood(50)
      assert.equal(b.gameLimited(7, fresh(i)), false, `guess ${i + 1} is compared`)
    }
    flood(50)
    assert.equal(b.gameLimited(7, fresh(40)), true, 'past its share: refused')
    assert.equal(b.gameLimited(7, fresh(41)), true, 'the right PIN too')
    assert.equal(lines.filter((l) => l.startsWith(`[PIN] game number 7: 40 wrong game PINs in restore-by-pin from ${b.rangeLabel('2001:db8:ffff::/48')}`)).length, 1)
    // other ranges are not refused for it
    assert.equal(b.gameLimited(7, '198.51.100.7'), false)
    // the reviewer's PoC (matches family): fill it with GET /api/match/:id
    // wrong PINs of 25 rooms, then a fresh /48 guesses one room's referee PIN
    const m = createPinFailureBudget({ lockKeys: 300, alertKeys: 100, max: 1e9, ipMax: 1e9, log: () => {} })
    const kinds = ['referee', 'bench_home', 'bench_away', 'game']
    for (let p = 1; p <= 10; p++) for (let r = 0; r < 25; r++) for (let i = 0; i < 8; i++) m.isLimited(`2001:db8:${p.toString(16)}:${(i << 8).toString(16)}::/64`, pinScope.match('room' + r), { kinds })
    let refused = 0
    for (let i = 0; i < 100; i++) if (m.isLimited(fresh(i), pinScope.match('room0', 'referee'))) refused++
    // at most 40 compared (its entry took the place of a wide count and starts from it)
    assert.ok(refused >= 60, `refused ${refused} of 100`)
    assert.ok(refused < 100, 'its first guess was compared')
  })

  it('a guesser cannot keep its count down by sending a fresh key after each guess', () => {
    // shares: an IPv6 /48 40; a table of 50 keys, filled with wide counts of 2
    const b = createPinFailureBudget({ lockKeys: 50, alertKeys: 1000, max: 1e9, ipMax: 1e9, log: () => {} })
    const wide = (p) => `2001:db8:${p.toString(16)}::/64`
    for (let g = 0; g < 50; g++) for (let k = 0; k < 2; k++) b.gameLimited(5000 + g, wide(1))
    // each guess at game 7 from the guessing /48, then one guess at a fresh game number from another /48
    let compared = 0
    for (let i = 0; i < 100; i++) {
      if (!b.gameLimited(7, `2001:db8:ffff:${(i << 8).toString(16)}::/64`)) compared++
      b.gameLimited(6000 + i, wide(2 + i))
    }
    assert.ok(compared <= 40, `${compared} guesses compared`)
  })

  it('a full table drops narrow ranges before wide ones, the lowest count first, a lock last', () => {
    const alerts = []
    // production shares (a /64 20, a /56 30, a /48 40); room for every wide count, not for the narrow ones
    const b = createPinFailureBudget({ lockKeys: 20, max: 1e9, ipMax: 1e9, log: () => {}, alert: (a) => alerts.push(a) })
    // the guesser: 39 wrong PINs at match-1, a /56 of its /48 each
    for (let i = 0; i < 39; i++) assert.equal(b.isLimited(inA(i * 256), 'm:referee:match-1'), false)
    // a flood at ten other matches from fresh /56s of another /48 (39 each, below its share): hundreds of narrow keys
    for (let k = 2; k <= 11; k++) for (let i = 0; i < 39; i++) assert.equal(b.isLimited(inB(i * 256 + k), `m:referee:match-${k}`), false)
    assert.equal(alerts.filter((a) => /the match counts are full/.test(a.message)).length, 1)
    // every wide count was kept: the 40th is compared, the 41st refused, for the guesser and the flood alike
    assert.equal(b.isLimited(inA(200 * 256), 'm:referee:match-1'), false)
    assert.equal(b.isLimited(inA(201 * 256), 'm:referee:match-1'), true)
    assert.equal(b.isLimited(inB(200 * 256), 'm:referee:match-5'), false)
    assert.equal(b.isLimited(inB(201 * 256), 'm:referee:match-5'), true)
    // wide counts only: the lowest count makes room first, and a count that
    // makes room passes on to the new key, so a guesser's count is never under
    // its true value (share 5 here: refused at its 6th guess, flood or not)
    const c = createPinFailureBudget({ rangeMax: 5, lockKeys: 3, max: 1e9, ipMax: 1e9, log: () => {} })
    for (let i = 0; i < 3; i++) assert.equal(c.isLimited('hall-1', 'm:game:match-1'), false)
    for (let i = 2; i < 30; i++) c.isLimited(`hall-${i}`, 'm:game:match-2')
    let compared = 0
    while (!c.isLimited('hall-1', 'm:game:match-1')) compared++
    assert.ok(compared <= 2, `${compared} more compared`)
    // a lock is kept while there are unlocked counts to drop
    const d = createPinFailureBudget({ rangeMax: 1, lockKeys: 3, max: 1e9, ipMax: 1e9, log: () => {} })
    d.isLimited('hall-1', 'm:game:match-1')
    assert.equal(d.isLimited('hall-1', 'm:game:match-1'), true)
    for (let i = 2; i < 30; i++) d.isLimited(`hall-${i}`, 'm:game:match-2')
    assert.equal(d.locked('match-1', 'game', 'hall-1'), true, 'the lock is kept')
    // a table of locks only: a new range takes the place of the lock that ends first
    const e = createPinFailureBudget({ rangeMax: 1, lockKeys: 2, max: 1e9, ipMax: 1e9, log: () => {} })
    for (const k of ['hall-1', 'hall-2']) {
      e.isLimited(k, 'm:game:match-1')
      assert.equal(e.isLimited(k, 'm:game:match-1'), true)
    }
    assert.equal(e.isLimited('hall-3', 'm:game:match-1'), false, 'counted')
    assert.equal(e.locked('match-1', 'game', 'hall-1'), false, 'the oldest lock made room')
    assert.equal(e.locked('match-1', 'game', 'hall-2'), true)
    assert.equal(e.isLimited('hall-3', 'm:game:match-1'), true)
  })

  it('expired counts make room first; the alert of a full table comes once per window', () => {
    let t = 1000000
    const alerts = []
    const b = createPinFailureBudget({ rangeMax: 5, lockKeys: 10, windowMs: 60000, now: () => t, max: 1e9, ipMax: 1e9, log: () => {}, alert: (a) => alerts.push(a) })
    for (let i = 0; i < 10; i++) b.isLimited(`hall-${i}`, 'm:game:match-1')
    t += 61000
    // the old window has ended: room without dropping a live count, no alert
    for (let i = 10; i < 20; i++) b.isLimited(`hall-${i}`, 'm:game:match-1')
    assert.equal(alerts.length, 0)
    for (let i = 20; i < 40; i++) b.isLimited(`hall-${i}`, 'm:game:match-1')
    assert.equal(alerts.filter((a) => /counts are full/.test(a.message)).length, 1)
    t += 61000
    for (let i = 40; i < 50; i++) b.isLimited(`hall-${i}`, 'm:game:match-1')
    for (let i = 50; i < 70; i++) b.isLimited(`hall-${i}`, 'm:game:match-1')
    assert.equal(alerts.filter((a) => /counts are full/.test(a.message)).length, 2, 'a new window, a new alert')
  })

  // Audit 2026-11 review, PL-R3: the lock lines named the address (an IPv4
  // address, an IPv6 /64) and the alerts (stored as error reports) the /24 or /48
  it('the log lines and the alerts name a range by its width and a pseudonym, never by its address', () => {
    const lines = []
    const alerts = []
    const b = createPinFailureBudget({ rangeMax: 2, matchMax: 2, log: (l) => lines.push(l), alert: (a) => alerts.push(a) })
    // a tablet behind one IPv4 address, an IPv6 /64, and two addresses of one /24
    for (let i = 0; i < 4; i++) b.isLimited('198.51.100.23', 'm:all:room1', { kinds: ['referee'] })
    for (let i = 0; i < 4; i++) b.isLimited('2a02:1210:5c03:ab00::/64', 'm:referee:room2')
    for (const ip of ['198.51.100.24', '198.51.100.24', '198.51.100.25', '198.51.100.25', '198.51.100.26']) b.isLimited(ip, 'm:referee:room3')
    assert.equal(lines.filter((l) => l.includes('PIN checks from that range are refused')).length, 3, lines.join('\n'))
    assert.equal(alerts.length, 3)
    assert.ok(lines.some((l) => l.includes(`from ${b.rangeLabel('198.51.100.0/24')} within`)), 'the /24 level')
    const text = lines.join('\n') + JSON.stringify(alerts)
    for (const leak of ['198.51.100', '198.51', '2a02', '1210', '5c03', 'ab00']) assert.ok(!text.includes(leak), leak)
    assert.ok(lines.some((l) => l.includes(`from ${b.rangeLabel('198.51.100.23')} within`)), 'the address level')
    assert.ok(lines.some((l) => l.includes(`from ${b.rangeLabel('2a02:1210:5c03:ab00::/64')} within`)), 'the /64 level')
    assert.match(alerts[0].ranges[0].range, /^IPv4 \/24 #[b-z]{8}$/)
    // one name per range while the process runs; another process (key), another name
    assert.equal(b.rangeLabel('198.51.100.0/24'), b.rangeLabel('198.51.100.0/24'))
    assert.notEqual(b.rangeLabel('198.51.100.0/24'), b.rangeLabel('198.51.101.0/24'))
    assert.notEqual(createPinFailureBudget({ log: () => {} }).rangeLabel('198.51.100.0/24'), b.rangeLabel('198.51.100.0/24'))
    const key = Buffer.alloc(32, 7)
    assert.equal(createPinFailureBudget({ labelKey: key, log: () => {} }).rangeLabel('198.51.100.0/24'), pinRangeLabel('198.51.100.0/24', key))
    assert.deepEqual(['203.0.113.7', '203.0.113.0/24', '2001:db8::/48', '2001:db8:0:100::/56', '2001:db8::1:0:0/64', 'hall'].map((r) => pinRangeLabel(r, key).split(' #')[0]),
      ['IPv4 /32', 'IPv4 /24', 'IPv6 /48', 'IPv6 /56', 'range', 'range'])
    assert.equal(pinRangeLabel('2001:db8:0:1::/64', key).split(' #')[0], 'IPv6 /64')
    // the error tracker stores them as they are (no digits for its PIN masking)
    for (let i = 0; i < 2000; i++) {
      const l = pinRangeLabel(`198.${i >> 8}.${i & 255}.0/24`, key)
      assert.match(l, /^IPv4 \/24 #[b-z]{8}$/)
      assert.equal(redactText(l), l)
    }
  })
})

describe('matchRestore on Postgres', { skip: SKIP_PG }, () => {
  let tdb, db, restore, raw
  let seq = 0
  const uniq = (p = 'R') => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`
  const W = { proto: 2 }
  const count = async (table, matchId) => (await raw.query(`SELECT count(*)::int n FROM ${table} WHERE match_id = $1`, [matchId])).rows[0].n
  // A match of an earlier season: db/034 gives a new match the season of the
  // server's clock (no VolleyManager row here), so a test back-dates the key
  // with the user triggers off.
  async function earlierSeason (matchId, years = 1) {
    await raw.query('BEGIN')
    await raw.query("SET LOCAL session_replication_role = 'replica'")
    await raw.query('UPDATE matches SET official_season = official_season - $2::int WHERE id = $1', [matchId, years])
    await raw.query('COMMIT')
  }

  // One cloud match per official game (db/007): each backup its own game number by default
  let gameSeq = 70000
  function backup (ext, { sets = 2, events = 5, gameN = gameSeq++, pin = '424242', scheduledAt } = {}) {
    return {
      match: {
        external_id: ext,
        game_n: gameN,
        game_pin: pin,
        status: 'live',
        ...(scheduledAt ? { scheduled_at: scheduledAt } : {}),
        connection_pins: { referee: '111111' },
        home_team: { name: 'Home' },
        id: '00000000-0000-0000-0000-00000000dead' // ignored: keyed by external_id
      },
      sets: Array.from({ length: sets }, (_, i) => ({ id: 'ignored', external_id: `${ext}:s:${i + 1}`, index: i + 1, home_points: 25, away_points: 20 + i, sport_type: 'indoor' })),
      events: Array.from({ length: events }, (_, i) => ({ id: 123, external_id: `${ext}:e:${i + 1}`, set_index: 1, type: 'point', seq: i + 1, payload: { n: i }, sport_type: 'indoor' })),
      liveState: { points_a: 3, points_b: 2, current_set: 1, match_status: 'live', lineup_a: { I: 7 } }
    }
  }

  before(async () => {
    tdb = await createTestDatabase('restore')
    const logger = quietLogger()
    db = createPgQuery({ connectionString: tdb.url, logger })
    restore = createMatchRestore(db, { logger })
    raw = new pg.Client({ connectionString: tdb.url })
    await raw.connect()
  })

  after(async () => {
    await raw?.end()
    await db?.close()
    await tdb?.drop()
  })

  describe('restoreMatch', () => {
    it('creates the match with its sets, events and live state in one go', async () => {
      const ext = uniq()
      const r = await restore.restoreMatch(backup(ext), W)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.deepEqual(r.body.data.counts, { sets: 2, events: 5, liveState: 1 })
      const id = r.body.data.id
      assert.notEqual(id, '00000000-0000-0000-0000-00000000dead')
      assert.equal(await count('sets', id), 2)
      assert.equal(await count('events', id), 5)
      assert.equal(await count('match_live_state', id), 1)
      const m = (await raw.query('SELECT external_id, game_pin, connection_pins FROM matches WHERE id = $1', [id])).rows[0]
      assert.deepEqual(m, { external_id: ext, game_pin: '424242', connection_pins: { referee: '111111' } })
      // Write-through feed: redacted rows for the realtime broadcast.
      assert.ok(r.changes.some(c => c.table === 'matches' && c.eventType === 'INSERT'))
      assert.ok(r.changes.every(c => !('game_pin' in c.row) && !('connection_pins' in c.row)))
      assert.equal(r.changes.filter(c => c.table === 'events').length, 5)
    })

    it('replaces the children of an existing match (and only of that match)', async () => {
      const ext = uniq(); const other = uniq()
      const first = await restore.restoreMatch(backup(ext, { sets: 3, events: 10 }), W)
      const keep = await restore.restoreMatch(backup(other, { sets: 1, events: 4 }), W)
      const again = await restore.restoreMatch(backup(ext, { sets: 1, events: 2 }), W)
      assert.equal(again.status, 200, JSON.stringify(again.body))
      assert.equal(again.body.data.id, first.body.data.id)
      assert.deepEqual(again.body.data.counts, { sets: 1, events: 2, liveState: 1 })
      assert.equal(await count('events', first.body.data.id), 2)
      assert.equal(await count('sets', first.body.data.id), 1)
      assert.equal(await count('events', keep.body.data.id), 4)
      assert.ok(again.changes.some(c => c.table === 'matches' && c.eventType === 'UPDATE'))
    })

    it('rolls back everything when one event row is invalid', async () => {
      const ext = uniq()
      const ok = await restore.restoreMatch(backup(ext, { sets: 2, events: 3 }), W)
      const id = ok.body.data.id
      const bad = backup(ext, { sets: 1, events: 6 })
      bad.match.status = 'final'
      bad.events[4].set_index = 'not-a-number'
      const r = await restore.restoreMatch(bad, W)
      assert.equal(r.status, 400)
      assert.equal(r.body.error.code, '22P02')
      assert.match(r.body.error.details, /^events:/)
      assert.equal((await raw.query('SELECT status FROM matches WHERE id = $1', [id])).rows[0].status, 'live')
      assert.equal(await count('sets', id), 2)
      assert.equal(await count('events', id), 3)
      assert.equal(await count('match_live_state', id), 1)
    })

    it('rolls back when an event id is not scoped to the match', async () => {
      const ext = uniq()
      const ok = await restore.restoreMatch(backup(ext, { sets: 1, events: 2 }), W)
      const bad = backup(ext, { sets: 1, events: 3 })
      bad.events[2].external_id = '3' // a bare Dexie id
      const r = await restore.restoreMatch(bad, W)
      assert.equal(r.body.error.code, 'OV_UNSCOPED_EXTERNAL_ID')
      assert.equal(await count('events', ok.body.data.id), 2)
    })

    it('a brand-new match is not left behind when the restore fails', async () => {
      const ext = uniq()
      const bad = backup(ext)
      bad.liveState.points_a = 'x'
      const r = await restore.restoreMatch(bad, W)
      assert.equal(r.status, 400)
      assert.match(r.body.error.details, /^liveState:/)
      assert.equal((await raw.query('SELECT count(*)::int n FROM matches WHERE external_id = $1', [ext])).rows[0].n, 0)
    })

    it('needs X-OV-Proto >= 2', async () => {
      const r = await restore.restoreMatch(backup(uniq()), {})
      assert.equal(r.status, 426)
      assert.equal(r.body.error.code, 'OV_CLIENT_TOO_OLD')
    })

    it('refuses malformed payloads', async () => {
      const base = backup(uniq())
      for (const p of [null, 'x', {}, { match: {} }, { match: { external_id: '' } }, { match: { external_id: 5 } },
        { ...base, sets: 'x' }, { ...base, events: [1] }, { ...base, liveState: [] }, { ...base, events: [{ nope: 1 }] }]) {
        const r = await restore.restoreMatch(p, W)
        assert.equal(r.status, 400, JSON.stringify(p))
      }
    })

    // 2026-10-26: a hand-over on a device whose local ids were taken by its
    // older matches queued a whole-match restore to move the cloud rows to
    // its own ids; it deleted the match's voided events and the rows the
    // previous device sent after the read
    it('rekey: renames the rows named in place and deletes nothing else', async () => {
      const ext = uniq('REKEY')
      const made = await restore.restoreMatch(backup(ext, { sets: 2, events: 5 }), W)
      const id = made.body.data.id
      const row = async (key) => (await raw.query('SELECT id, external_id, voided_at, payload FROM events WHERE match_id = $1 AND external_id = $2', [id, key])).rows[0]
      const e1 = await row(`${ext}:e:1`)
      // event 3 voided after the device read the match; 6 voided before
      // (never read); 7 sent by the previous device after the read
      await raw.query('UPDATE events SET voided_at = now(), void_reason = $3 WHERE match_id = $1 AND external_id = $2', [id, `${ext}:e:3`, 'undo'])
      await raw.query(`INSERT INTO events (match_id, external_id, set_index, type, seq, payload, sport_type, voided_at, void_reason)
                       VALUES ($1, $2, 1, 'point', 6, '{}', 'indoor', now(), 'undo'), ($1, $3, 1, 'point', 7, '{}', 'indoor', NULL, NULL),
                              ($1, $4, 1, 'point', 99, '{"stale":true}', 'indoor', NULL, NULL)`,
      [id, `${ext}:e:6`, `${ext}:e:7`, `${ext}:e:205`])

      // what the device read: sets 1-2, events 1-5 (and 9, gone since), moved to its own ids
      const b = backup(ext, { sets: 2, events: 5 })
      b.events.push({ external_id: `${ext}:e:9`, set_index: 1, type: 'point', seq: 9, payload: {}, sport_type: 'indoor' })
      const to = (key) => key.replace(/:(s|e):(\d+)$/, (_, k, n) => `:${k}:${Number(n) + (k === 's' ? 100 : 200)}`)
      const rekey = { sets: {}, events: {} }
      b.sets = b.sets.map((r) => { rekey.sets[to(r.external_id)] = r.external_id; return { ...r, external_id: to(r.external_id) } })
      b.events = b.events.map((r) => { rekey.events[to(r.external_id)] = r.external_id; return { ...r, external_id: to(r.external_id) } })
      b.liveState = { ...b.liveState, points_a: 0, points_b: 0 }
      const r = await restore.restoreMatch({ ...b, rekey }, W)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.deepEqual(r.body.data.counts, { sets: 2, events: 6, liveState: 0, rekeyed: 7 })

      const keys = (await raw.query('SELECT external_id, voided_at IS NOT NULL AS voided FROM events WHERE match_id = $1 ORDER BY seq', [id])).rows
      assert.deepEqual(keys, [
        { external_id: `${ext}:e:201`, voided: false },
        { external_id: `${ext}:e:202`, voided: false },
        { external_id: `${ext}:e:203`, voided: true },
        { external_id: `${ext}:e:204`, voided: false },
        { external_id: `${ext}:e:205`, voided: false },
        { external_id: `${ext}:e:6`, voided: true },
        { external_id: `${ext}:e:7`, voided: false },
        { external_id: `${ext}:e:209`, voided: false }
      ])
      // in place: the same row under its new id; the stale row under the new id is gone
      assert.equal((await row(`${ext}:e:201`)).id, e1.id)
      assert.deepEqual((await row(`${ext}:e:205`)).payload, { n: 4 })
      assert.deepEqual((await raw.query('SELECT external_id FROM sets WHERE match_id = $1 ORDER BY index', [id])).rows.map((x) => x.external_id), [`${ext}:s:101`, `${ext}:s:102`])
      // the live state is not keyed by the device's ids: left as it is
      assert.equal((await raw.query('SELECT points_a FROM match_live_state WHERE match_id = $1', [id])).rows[0].points_a, 3)
      assert.ok(r.changes.some((c) => c.table === 'events' && c.eventType === 'UPDATE' && c.row.external_id === `${ext}:e:201`))

      // a rekey naming another match's id or an unscoped new id is refused as a whole
      const bad = { ...b, rekey, events: [...b.events, { external_id: '12', set_index: 1, type: 'point', seq: 12, payload: {}, sport_type: 'indoor' }] }
      assert.equal((await restore.restoreMatch(bad, W)).body.error.code, 'OV_UNSCOPED_EXTERNAL_ID')
      assert.equal(await count('events', id), 8)
    })

    // the device's new ids continue its own counter: they may be old ids of
    // this same match (renamed one by one, rows still to be moved were
    // deleted and others moved twice)
    it('rekey: new ids that are old ids of the same match move every row once', async () => {
      const ext = uniq('REKEY2')
      const made = await restore.restoreMatch(backup(ext, { sets: 2, events: 5 }), W)
      const id = made.body.data.id
      await raw.query('UPDATE events SET voided_at = now(), void_reason = $3 WHERE match_id = $1 AND external_id = $2', [id, `${ext}:e:3`, 'undo'])
      const before = (await raw.query('SELECT id, external_id FROM events WHERE match_id = $1', [id])).rows
      const idOf = Object.fromEntries(before.map((r) => [r.external_id, r.id]))
      // cloud e:1..e:5 and s:1..s:2 to the device's e:3..e:7 and s:2..s:3
      const b = backup(ext, { sets: 2, events: 5 })
      const to = (key) => key.replace(/:(s|e):(\d+)$/, (_, k, n) => `:${k}:${Number(n) + (k === 's' ? 1 : 2)}`)
      const rekey = { sets: {}, events: {} }
      b.sets = b.sets.map((r) => { rekey.sets[to(r.external_id)] = r.external_id; return { ...r, external_id: to(r.external_id) } })
      b.events = b.events.map((r) => { rekey.events[to(r.external_id)] = r.external_id; return { ...r, external_id: to(r.external_id) } })
      const r = await restore.restoreMatch({ ...b, rekey }, W)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.equal(r.body.data.counts.rekeyed, 7)
      const after = (await raw.query('SELECT id, external_id, voided_at IS NOT NULL AS voided FROM events WHERE match_id = $1 ORDER BY seq', [id])).rows
      assert.deepEqual(after.map((x) => [x.external_id, x.voided]), [3, 4, 5, 6, 7].map((n) => [`${ext}:e:${n}`, n === 5]))
      // each row in place: the row of cloud e:n is the device's e:n+2
      for (let n = 1; n <= 5; n++) assert.equal(after.find((x) => x.external_id === `${ext}:e:${n + 2}`).id, idOf[`${ext}:e:${n}`], `e:${n}`)
      assert.deepEqual((await raw.query('SELECT external_id, index FROM sets WHERE match_id = $1 ORDER BY index', [id])).rows.map((x) => [x.external_id, x.index]), [[`${ext}:s:2`, 1], [`${ext}:s:3`, 2]])
      assert.equal(await count('events', id), 5)
    })

    // fe-sync-7: support sends a refused restore in parts (frontend
    // utils/refusedRestore splitRefusedRestore): each part must leave the
    // cloud as the whole one would have
    it('a backup restore in parts: the first replaces the match\'s rows, the later ones add theirs', async () => {
      const ext = uniq('PARTS')
      const made = await restore.restoreMatch(backup(ext, { sets: 3, events: 8 }), W)
      const id = made.body.data.id
      // sent after the backup was saved: the whole restore deletes it
      await raw.query(`INSERT INTO events (match_id, external_id, set_index, type, seq, payload, sport_type)
                       VALUES ($1, $2, 1, 'point', 20, '{}', 'indoor')`, [id, `${ext}:e:20`])
      const b = backup(ext, { sets: 2, events: 5 })
      const first = await restore.restoreMatch({ ...b, events: b.events.slice(0, 2) }, W)
      assert.equal(first.status, 200, JSON.stringify(first.body))
      const second = await restore.restoreMatch({ ...b, sets: [], events: b.events.slice(2), liveState: null, rekey: { sets: {}, events: {} } }, W)
      assert.equal(second.status, 200, JSON.stringify(second.body))
      const keys = (await raw.query('SELECT external_id FROM events WHERE match_id = $1 ORDER BY seq', [id])).rows.map((x) => x.external_id)
      assert.deepEqual(keys, [1, 2, 3, 4, 5].map((n) => `${ext}:e:${n}`))
      assert.equal(await count('sets', id), 2)
      assert.equal((await raw.query('SELECT points_a FROM match_live_state WHERE match_id = $1', [id])).rows[0].points_a, 3)
    })

    it('a hand-over in parts, each with the re-key entries of its rows: every row renamed in place, none twice', async () => {
      const ext = uniq('PARTSRK')
      const made = await restore.restoreMatch(backup(ext, { sets: 2, events: 5 }), W)
      const id = made.body.data.id
      const idOf = Object.fromEntries((await raw.query('SELECT id, external_id FROM events WHERE match_id = $1', [id])).rows.map((r) => [r.external_id, r.id]))
      const b = backup(ext, { sets: 2, events: 5 })
      const to = (key) => key.replace(/:(s|e):(\d+)$/, (_, k, n) => `:${k}:${Number(n) + (k === 's' ? 100 : 200)}`)
      const entries = (rows) => Object.fromEntries(rows.map((r) => [to(r.external_id), r.external_id]))
      const moved = (rows) => rows.map((r) => ({ ...r, external_id: to(r.external_id) }))
      const parts = [
        { ...b, sets: moved(b.sets), events: moved(b.events.slice(0, 3)), rekey: { sets: entries(b.sets), events: entries(b.events.slice(0, 3)) } },
        { ...b, sets: [], events: moved(b.events.slice(3)), liveState: null, rekey: { sets: {}, events: entries(b.events.slice(3)) } }
      ]
      for (const part of parts) {
        const r = await restore.restoreMatch(part, W)
        assert.equal(r.status, 200, JSON.stringify(r.body))
      }
      const after = (await raw.query('SELECT id, external_id FROM events WHERE match_id = $1 ORDER BY seq', [id])).rows
      assert.deepEqual(after.map((x) => x.external_id), [201, 202, 203, 204, 205].map((n) => `${ext}:e:${n}`))
      for (let n = 1; n <= 5; n++) assert.equal(after[n - 1].id, idOf[`${ext}:e:${n}`], `e:${n}`)
      assert.deepEqual((await raw.query('SELECT external_id FROM sets WHERE match_id = $1 ORDER BY index', [id])).rows.map((x) => x.external_id), [`${ext}:s:101`, `${ext}:s:102`])
    })

    it('restores a match without sets, events or live state', async () => {
      const ext = uniq()
      const r = await restore.restoreMatch({ match: { external_id: ext } }, W)
      assert.equal(r.status, 200)
      assert.deepEqual(r.body.data.counts, { sets: 0, events: 0, liveState: 0 })
    })
  })

  describe('restoreMatch with real client payloads', () => {
    // Exactly what backupManager.js restoreMatchInPlace queues (match after filterMatchPayload).
    function backupManagerPayload (ext, { sportType } = {}) {
      return {
        match: {
          external_id: ext,
          game_n: 88000 + (seq++),
          game_pin: '246810',
          status: 'live',
          home_team: { name: 'Home', short_name: 'HOM', color: '#f00' },
          away_team: { name: 'Away', short_name: 'AWY', color: '#00f' },
          players_home: [{ number: 7 }],
          players_away: [],
          match_info: { hall: 'Halle', league: '2L' },
          coin_toss: { confirmed: true, first_serve: 'home' },
          ...(sportType ? { sport_type: sportType } : {})
        },
        sets: [1, 2].map(i => ({ external_id: `${ext}_set_${i}`, index: i, home_points: 25, away_points: 18, finished: i === 1, start_time: '2026-10-05T10:00:00Z', end_time: undefined })),
        events: [1, 2, 3].map(seq => ({ external_id: `${ext}_event_${seq}`, set_index: 1, type: 'point', payload: { team: 'home' }, ts: '2026-10-05T10:01:00Z', seq })),
        liveState: { current_set: 2, points_a: 25, points_b: 18, sets_won_a: 1, sets_won_b: 0, status: 'live' }
      }
    }

    it('restores the restore-in-place payload: live state `status` becomes match_status, children get sport_type', async () => {
      const ext = uniq('BM')
      const r = await restore.restoreMatch(backupManagerPayload(ext), W)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.deepEqual(r.body.data.counts, { sets: 2, events: 3, liveState: 1 })
      assert.deepEqual(r.body.data.dropped, {})
      const id = r.body.data.id
      const ls = (await raw.query('SELECT match_status, current_set, sets_won_a FROM match_live_state WHERE match_id = $1', [id])).rows[0]
      assert.deepEqual(ls, { match_status: 'live', current_set: 2, sets_won_a: 1 })
      const sports = (await raw.query("SELECT DISTINCT sport_type::text FROM (SELECT sport_type FROM sets WHERE match_id = $1 UNION ALL SELECT sport_type FROM events WHERE match_id = $1) x", [id])).rows
      assert.deepEqual(sports, [{ sport_type: 'indoor' }])
      // A beach match passes its own sport type down.
      const b = await restore.restoreMatch(backupManagerPayload(uniq('BB'), { sportType: 'beach' }), W)
      assert.equal((await raw.query('SELECT DISTINCT sport_type::text s FROM events WHERE match_id = $1', [b.body.data.id])).rows[0].s, 'beach')
    })

    it('drops and reports keys that are not columns instead of rolling back', async () => {
      const ext = uniq('BX')
      const p = backupManagerPayload(ext)
      p.match.coinTossConfirmed = true
      p.match.legacy_field = 1
      p.events[0].stateSnapshot = {}
      p.liveState.status = 'final'
      p.liveState.match_status = 'live' // both present: the real column wins, the legacy key is dropped
      const r = await restore.restoreMatch(p, W)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.deepEqual(r.body.data.dropped, { match: ['coinTossConfirmed', 'legacy_field'], events: ['stateSnapshot'], liveState: ['status'] })
      assert.equal((await raw.query('SELECT match_status FROM match_live_state WHERE match_id = $1', [r.body.data.id])).rows[0].match_status, 'live')
    })

    it('keeps stored PINs when the backup omits or nulls them and merges connection_pins', async () => {
      const ext = uniq('PK')
      const p = backupManagerPayload(ext)
      p.match.connection_pins = { referee: '111111', bench_a: '222222' }
      const first = await restore.restoreMatch(p, W)
      const id = first.body.data.id
      const pins = async () => (await raw.query('SELECT game_pin, connection_pins FROM matches WHERE id = $1', [id])).rows[0]
      p.match.game_pin = null
      p.match.connection_pins = { referee: '999999' }
      assert.equal((await restore.restoreMatch(p, W)).status, 200)
      assert.deepEqual(await pins(), { game_pin: '246810', connection_pins: { referee: '999999', bench_a: '222222' } })
      delete p.match.game_pin
      delete p.match.connection_pins
      assert.equal((await restore.restoreMatch(p, W)).status, 200)
      assert.deepEqual(await pins(), { game_pin: '246810', connection_pins: { referee: '999999', bench_a: '222222' } })
      p.match.game_pin = ''
      p.match.connection_pins = null
      assert.equal((await restore.restoreMatch(p, W)).status, 200)
      assert.equal((await pins()).game_pin, '246810')
    })

    it('reports the removed children as DELETE changes (keys only) before the new INSERTs', async () => {
      const ext = uniq('CH')
      const first = await restore.restoreMatch(backup(ext, { sets: 2, events: 3 }), W)
      const old = (await raw.query('SELECT id::text FROM events WHERE match_id = $1 ORDER BY id', [first.body.data.id])).rows.map(r => r.id)
      const again = await restore.restoreMatch(backup(ext, { sets: 1, events: 1 }), W)
      const kinds = again.changes.map(c => `${c.table}:${c.eventType}`)
      const dels = again.changes.filter(c => c.eventType === 'DELETE')
      assert.deepEqual(dels.filter(c => c.table === 'events').map(c => String(c.row.id)).sort(), old.sort())
      assert.equal(dels.filter(c => c.table === 'sets').length, 2)
      assert.equal(dels.filter(c => c.table === 'match_live_state').length, 1)
      for (const d of dels) assert.deepEqual(Object.keys(d.row).sort(), d.table === 'match_live_state' ? ['id', 'match_id'] : ['external_id', 'id', 'match_id'])
      assert.ok(kinds.lastIndexOf('events:DELETE') < kinds.indexOf('events:INSERT'))
    })

    it('refuses duplicate external_ids inside one payload with a clear error', async () => {
      const p = backup(uniq('DUP'), { events: 3 })
      p.events[2].external_id = p.events[1].external_id
      const r = await restore.restoreMatch(p, W)
      assert.equal(r.status, 400)
      assert.equal(r.body.error.code, 'OV_INVALID_REQUEST')
      assert.match(r.body.error.details, /^events: duplicate external_id/)
    })

    it('cannot take over a set of another match through the restore', async () => {
      const a = uniq('TA'); const b = uniq('TB')
      const ra = await restore.restoreMatch(backup(a, { sets: 1, events: 0 }), W)
      // b's backup carries a set whose external_id collides with a row of match a.
      const collided = `${b}:s:1`
      await raw.query('INSERT INTO sets (external_id, match_id) VALUES ($1, $2)', [collided, ra.body.data.id])
      const r = await restore.restoreMatch(backup(b, { sets: 1, events: 0 }), W)
      assert.equal(r.status, 400)
      assert.equal(r.body.error.code, '23505')
      assert.match(r.body.error.details, /^sets:/)
      assert.equal((await raw.query('SELECT match_id FROM sets WHERE external_id = $1', [collided])).rows[0].match_id, ra.body.data.id)
      assert.equal((await raw.query('SELECT count(*)::int n FROM matches WHERE external_id = $1', [b])).rows[0].n, 0)
    })
  })

  describe('restoreByPin', () => {
    let ext, id
    before(async () => {
      ext = uniq('PIN')
      const r = await restore.restoreMatch(backup(ext, { gameN: 31337, pin: '135790', sets: 2, events: 3 }), W)
      id = r.body.data.id
    })

    it('returns the match without secrets, plus sets, events and live state', async () => {
      const r = await restore.restoreByPin({ gameN: 31337, pin: '135790' }, { limitKey: 'ip-ok' })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      const { match, sets, events, liveState } = r.body.data
      assert.equal(match.id, id)
      assert.equal(match.external_id, ext)
      assert.ok(!('game_pin' in match))
      assert.ok(!('connection_pins' in match))
      assert.deepEqual(sets.map(s => s.index), [1, 2])
      assert.deepEqual(events.map(e => e.seq), [1, 2, 3])
      assert.equal(liveState.points_a, 3)
      // String inputs from a form are accepted.
      const r2 = await restore.restoreByPin({ gameN: '31337', pin: ' 135790 ' }, { limitKey: 'ip-ok2' })
      assert.equal(r2.status, 200)
    })

    it('needs an exact game number AND PIN', async () => {
      for (const [gameN, pin] of [[31337, '135791'], [31336, '135790'], [31337, '13579'], [31337, '1357900']]) {
        const r = await restore.restoreByPin({ gameN, pin }, { limitKey: `ip-${gameN}-${pin}` })
        assert.equal(r.status, 404, `${gameN}/${pin}`)
        assert.equal(r.body.error.code, 'OV_NOT_FOUND')
      }
    })

    it('refuses wildcard and injection PINs before touching the database', async () => {
      for (const pin of ['%', '*', "' OR '1'='1", '1357%', '', null, '1'.repeat(40)]) {
        const r = await restore.restoreByPin({ gameN: 31337, pin }, { limitKey: 'ip-inj' })
        assert.equal(r.status, 400, String(pin))
      }
      for (const gameN of [undefined, 'x', -1, 1.5, '1 OR 1=1']) {
        const r = await restore.restoreByPin({ gameN, pin: '135790' }, { limitKey: 'ip-inj2' })
        assert.equal(r.status, 400, String(gameN))
      }
    })

    it('limits attempts per caller and game number', async () => {
      const key = 'ip-brute'
      for (let i = 0; i < 5; i++) {
        const r = await restore.restoreByPin({ gameN: 31337, pin: String(100000 + i) }, { limitKey: key })
        assert.equal(r.status, 404)
      }
      const blocked = await restore.restoreByPin({ gameN: 31337, pin: '135790' }, { limitKey: key })
      assert.equal(blocked.status, 429)
      assert.equal(blocked.body.error.code, 'OV_TOO_MANY_ATTEMPTS')
      const otherGame = await restore.restoreByPin({ gameN: 1, pin: '135790' }, { limitKey: key })
      assert.equal(otherGame.status, 404)
    })

    it('limits attempts per caller across all game numbers', async () => {
      const r2 = createMatchRestore(db, { logger: quietLogger(), callerAttempts: { max: 3, windowMs: 60000 } })
      for (let g = 1; g <= 3; g++) {
        assert.equal((await r2.restoreByPin({ gameN: 900000 + g, pin: '135790' }, { limitKey: 'ip-spray' })).status, 404)
      }
      const blocked = await r2.restoreByPin({ gameN: 31337, pin: '135790' }, { limitKey: 'ip-spray' })
      assert.equal(blocked.status, 429)
      assert.equal((await r2.restoreByPin({ gameN: 31337, pin: '135790' }, { limitKey: 'ip-other' })).status, 200)
      // A blocked caller does not create per-game keys.
      const before = r2.pinLimiter.size
      for (let g = 0; g < 50; g++) await r2.restoreByPin({ gameN: g, pin: '1' }, { limitKey: 'ip-spray' })
      assert.equal(r2.pinLimiter.size, before)
    })

    // Owner decision 1 (audit 2026-11, SEC-05): only the guessing address
    // range is refused. These two tests pinned the old rule (30 wrong PINs
    // from anyone refused the right PIN to everyone).
    it('wrong game PINs from one address range lock restore-by-pin of that game number for that range, the right PIN too; another range gets in; the match itself is not locked', async () => {
      const lines = []
      const alerts = []
      const budget = createPinFailureBudget({ rangeMax: 2, matchMax: 3, log: (l) => lines.push(l), alert: (a) => alerts.push(a) })
      const r3 = createMatchRestore(db, { logger: quietLogger(), pinBudget: budget })
      const locked = uniq('LOCK')
      await restore.restoreMatch(backup(locked, { gameN: 8181, pin: '818181' }), W)
      await restore.restoreMatch(backup(uniq('FREE'), { gameN: 8282, pin: '828282' }), W)
      // four wrong PINs from four addresses of one /24 (the share of a /24: twice an address's)
      for (const [i, pin] of ['100001', '100002', '100003', '100004'].entries()) {
        assert.equal((await r3.restoreByPin({ gameN: 8181, pin }, { limitKey: `198.18.12.${i + 1}` })).status, 404, pin)
      }
      // the right PIN from that range: refused before it is compared
      const right = await r3.restoreByPin({ gameN: 8181, pin: '818181' }, { limitKey: '198.18.12.9' })
      assert.equal(right.status, 429)
      assert.equal(right.body.error.code, 'OV_TOO_MANY_ATTEMPTS')
      assert.equal(lines.filter((l) => l.startsWith(`[PIN] game number 8181: 4 wrong game PINs in restore-by-pin from ${budget.rangeLabel('198.18.12.0/24')}`)).length, 1)
      // every caller together past 3: one ops alert, and nobody is refused for it
      assert.equal(alerts.length, 1)
      assert.equal(alerts[0].scope, 'game')
      assert.equal(alerts[0].key, '8181')
      // the right PIN from another range gets the match
      const elsewhere = await r3.restoreByPin({ gameN: 8181, pin: '818181' }, { limitKey: '198.18.13.1' })
      assert.equal(elsewhere.status, 200, JSON.stringify(elsewhere.body))
      assert.equal(elsewhere.body.data.match.external_id, locked)
      // counted once for the game number, never against the match's own game
      // PIN: claim (and the relay, the scorer's reconnects) still prove it.
      // (Proved: claim gets as far as recording the editor, 503 in this test
      // database without ownership.)
      assert.equal(budget.tracks(locked), false)
      const claimed = await r3.claimMatch({ externalId: locked, pin: '818181' }, { limitKey: '198.18.12.10' })
      assert.equal(claimed.status, 503, JSON.stringify(claimed.body))
      // another game number is not affected, from the guessing range either
      assert.equal((await r3.restoreByPin({ gameN: 8282, pin: '828282' }, { limitKey: '198.18.12.9' })).status, 200)
      // a game number no match has, or a match that does not exist: nothing to guess, nothing counted
      for (let i = 0; i < 6; i++) {
        assert.equal((await r3.restoreByPin({ gameN: 8383, pin: '100001' }, { limitKey: `198.18.14.${i}` })).status, 404)
        assert.equal((await r3.claimMatch({ externalId: 'NOSUCH', pin: '100001' }, { limitKey: `198.18.14.${i}` })).status, 404)
      }
      assert.equal((await r3.restoreByPin({ gameN: 8383, pin: '100001' }, { limitKey: '198.18.14.99' })).status, 404)
      assert.equal(budget.tracks('NOSUCH'), false)
      assert.equal(lines.filter((l) => !l.includes('from all callers')).length, 1)
    })

    it('wrong claims lock that match\'s game PIN for the guessing range; restore-by-pin from there never proves it, from elsewhere it does', async () => {
      const budget = createPinFailureBudget({ rangeMax: 1, log: () => {} })
      const r3 = createMatchRestore(db, { logger: quietLogger(), pinBudget: budget })
      // game numbers repeat across seasons (db/007: one cloud match per game and season)
      const older = uniq('OLD')
      const newer = uniq('NEW')
      const o = await restore.restoreMatch(backup(older, { gameN: 8484, pin: '848484', scheduledAt: '2024-10-05T16:00:00Z' }), W)
      await earlierSeason(o.body.data.id)
      await restore.restoreMatch(backup(newer, { gameN: 8484, pin: '858585', scheduledAt: '2025-10-05T16:00:00Z' }), W)
      // two wrong claims from two addresses of one /24 (its share: 2)
      for (const [i, pin] of ['100001', '100002'].entries()) {
        assert.equal((await r3.claimMatch({ externalId: older, pin }, { limitKey: `198.18.20.${i + 1}` })).status, 404, pin)
      }
      assert.equal((await r3.claimMatch({ externalId: older, pin: '848484' }, { limitKey: '198.18.20.9' })).status, 429)
      assert.equal(budget.locked(older, 'game', '198.18.20.9'), true)
      assert.equal(budget.locked(older, 'game', '198.18.21.1'), false)
      // from that range the locked match's right PIN is answered as a wrong one, not as 429 (no oracle)
      const viaRestore = await r3.restoreByPin({ gameN: 8484, pin: '848484' }, { limitKey: '198.18.20.10' })
      assert.equal(viaRestore.status, 404, JSON.stringify(viaRestore.body))
      const other = await r3.restoreByPin({ gameN: 8484, pin: '858585' }, { limitKey: '198.18.20.11' })
      assert.equal(other.status, 200, JSON.stringify(other.body))
      assert.equal(other.body.data.match.external_id, newer)
      // another range proves it
      const elsewhere = await r3.restoreByPin({ gameN: 8484, pin: '848484' }, { limitKey: '198.18.21.1' })
      assert.equal(elsewhere.status, 200, JSON.stringify(elsewhere.body))
      assert.equal(elsewhere.body.data.match.external_id, older)
    })

    it('a caller trusted beyond the PIN is not refused by a range lock: an admin, the creator or an editor, the match\'s scorer device', async () => {
      const budget = createPinFailureBudget({ rangeMax: 1, log: () => {} })
      const r3 = createMatchRestore(db, { logger: quietLogger(), pinBudget: budget })
      const ext = uniq('TRUST')
      const m = await restore.restoreMatch(backup(ext, { gameN: 8787, pin: '878787' }), W)
      const matchId = m.body.data.id
      const [creator, editor, stranger] = [randomUUID(), randomUUID(), randomUUID()]
      for (const u of [creator, editor, stranger]) await raw.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [u, `${u}@example.ch`])
      await raw.query('BEGIN')
      await raw.query("SET LOCAL session_replication_role = 'replica'")
      await raw.query('UPDATE matches SET created_by = $2 WHERE id = $1', [matchId, creator])
      await raw.query('COMMIT')
      await raw.query("INSERT INTO match_editors (match_id, user_id, granted_via) VALUES ($1, $2, 'claim')", [matchId, editor])
      const device = randomUUID()
      await raw.query("INSERT INTO match_scorer_devices (match_id, device_id, platform) VALUES ($1, $2, 'web')", [matchId, device])
      // the guessing range locks the game number and the match's game PIN
      const guesser = '198.18.30.1'
      assert.equal((await r3.restoreByPin({ gameN: 8787, pin: '100001' }, { limitKey: guesser })).status, 404)
      assert.equal((await r3.claimMatch({ externalId: ext, pin: '100001' }, { limitKey: guesser })).status, 404)
      const lockedRestore = (trust) => r3.restoreByPin({ gameN: 8787, pin: '878787' }, { limitKey: guesser, trust })
      const lockedClaim = (trust) => r3.claimMatch({ externalId: ext, pin: '878787' }, { limitKey: guesser, trust })
      assert.equal((await lockedRestore(null)).status, 429)
      assert.equal((await lockedClaim(null)).status, 429)
      // a stranger, a device the database does not name, a failed roles read: still refused
      assert.equal((await lockedRestore({ userId: stranger, isAdmin: async () => false })).status, 429)
      assert.equal((await lockedRestore({ deviceId: randomUUID() })).status, 429)
      assert.equal((await lockedClaim({ userId: stranger, isAdmin: async () => { throw new Error('roles down') } })).status, 429)
      // trusted: the right PIN gets through the range lock
      assert.equal((await lockedRestore({ userId: stranger, isAdmin: async () => true })).status, 200)
      assert.equal((await lockedRestore({ userId: creator, isAdmin: async () => false })).status, 200)
      assert.equal((await lockedRestore({ userId: editor })).status, 200)
      assert.equal((await lockedRestore({ deviceId: device })).status, 200)
      // claim records the editor (503 in this test database), past the lock
      assert.equal((await lockedClaim({ userId: creator })).status, 503)
      // a trusted caller's wrong PIN from the refused range: compared with its
      // own match only, and answered as for the rest of the range (PL-R1;
      // this pinned 404 while the trust held for the whole game number)
      assert.equal((await r3.restoreByPin({ gameN: 8787, pin: '100002' }, { limitKey: guesser, trust: { userId: creator } })).status, 429)
      // the lock stands for everyone else of the range
      assert.equal((await lockedRestore(null)).status, 429)
      // a range locked out of the match's game PIN only (wrong claims): restore-by-pin
      // answers its match as a wrong PIN, except to a caller trusted for it
      const claimer = '198.18.31.1'
      assert.equal((await r3.claimMatch({ externalId: ext, pin: '100003' }, { limitKey: claimer })).status, 404)
      const viaRestore = (t) => r3.restoreByPin({ gameN: 8787, pin: '878787' }, { limitKey: claimer, trust: t })
      assert.equal((await viaRestore({ userId: creator })).status, 200)
      assert.equal((await viaRestore({ deviceId: device })).status, 200)
      assert.equal((await viaRestore({ userId: stranger })).status, 404)
      // that answer counted as a wrong PIN for the game number (share 1 here): now refused
      assert.equal((await viaRestore(null)).status, 429)
    })

    // Audit 2026-11 review, PL-R1: the trust held for the whole game number.
    // Owning any match of it (a test match of one's own: any account may make
    // one), or scoring one on the caller's device, let a locked range guess on
    // uncounted and take over everyone else's match of that number.
    it('trust is per match: owning another match of the game number lets a refused range prove that match only', async () => {
      const budget = createPinFailureBudget({ rangeMax: 1, log: () => {} })
      const r3 = createMatchRestore(db, { logger: quietLogger(), pinBudget: budget })
      const victimExt = uniq('VICTIM')
      const ownExt = uniq('OWN')
      const v = await restore.restoreMatch(backup(victimExt, { gameN: 8989, pin: '898989' }), W)
      // the attacker's own: a test match with the victim's game number
      const own = backup(ownExt, { gameN: 8989, pin: '121212' })
      own.match.test = true
      const o = await restore.restoreMatch(own, W)
      assert.equal(o.status, 200, JSON.stringify(o.body))
      const [victimOwner, attacker] = [randomUUID(), randomUUID()]
      for (const u of [victimOwner, attacker]) await raw.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [u, `${u}@example.ch`])
      await raw.query('BEGIN')
      await raw.query("SET LOCAL session_replication_role = 'replica'")
      await raw.query('UPDATE matches SET created_by = $2 WHERE id = $1', [v.body.data.id, victimOwner])
      await raw.query('UPDATE matches SET created_by = $2 WHERE id = $1', [o.body.data.id, attacker])
      await raw.query('COMMIT')
      const attackerDevice = randomUUID()
      await raw.query("INSERT INTO match_scorer_devices (match_id, device_id, platform) VALUES ($1, $2, 'web')", [o.body.data.id, attackerDevice])
      // count what is asked of the database: the answer and the work must not depend on whose PIN it is
      let queries = 0
      const counted = { ...db, runQuery: (...a) => { queries++; return db.runQuery(...a) }, pool: { query: (...a) => { queries++; return db.pool.query(...a) } } }
      const r4 = createMatchRestore(counted, { logger: quietLogger(), pinBudget: budget })
      // the guessing range (an IPv4 /24, share 2 here) locks the game number
      const range = '198.18.40.1'
      assert.equal((await r3.restoreByPin({ gameN: 8989, pin: '100001' }, { limitKey: range })).status, 404)
      assert.equal((await r3.restoreByPin({ gameN: 8989, pin: '100002' }, { limitKey: '198.18.40.2' })).status, 404)
      assert.equal((await r3.restoreByPin({ gameN: 8989, pin: '898989' }, { limitKey: '198.18.40.3' })).status, 429)
      for (const trust of [{ userId: attacker, isAdmin: async () => false }, { deviceId: attackerDevice }, { userId: attacker, deviceId: attackerDevice }]) {
        const what = JSON.stringify(Object.keys(trust))
        // a wrong PIN and the victim's right PIN: the same answer, the same work
        const q0 = queries
        const wrong = await r4.restoreByPin({ gameN: 8989, pin: '100009' }, { limitKey: `198.18.40.${10 + queries % 50}`, trust })
        const q1 = queries
        const theirs = await r4.restoreByPin({ gameN: 8989, pin: '898989' }, { limitKey: `198.18.40.${60 + queries % 50}`, trust })
        const q2 = queries
        assert.equal(wrong.status, 429, what)
        assert.equal(theirs.status, 429, what)
        assert.deepEqual(theirs.body, wrong.body, what)
        assert.equal(q2 - q1, q1 - q0, `${what}: as many queries for the victim's PIN as for a wrong one`)
        // its own match: proved
        const mine = await r4.restoreByPin({ gameN: 8989, pin: '121212' }, { limitKey: `198.18.40.${120 + queries % 50}`, trust })
        assert.equal(mine.status, 200, what)
        assert.equal(mine.body.data.match.external_id, ownExt)
      }
      // the victim's match took no editor and no scorer from there
      assert.equal((await raw.query('SELECT count(*)::int n FROM match_editors WHERE match_id = $1', [v.body.data.id])).rows[0].n, 0)
      assert.equal((await raw.query('SELECT count(*)::int n FROM match_scorer_devices WHERE match_id = $1', [v.body.data.id])).rows[0].n, 0)
      // a range locked out of the victim's game PIN only (wrong claims): the
      // victim's match is passed over for the attacker, given to its owner
      const claimer = '198.18.41.1'
      assert.equal((await r3.claimMatch({ externalId: victimExt, pin: '100003' }, { limitKey: claimer })).status, 404)
      assert.equal((await r3.restoreByPin({ gameN: 8989, pin: '898989' }, { limitKey: claimer, trust: { userId: attacker } })).status, 404)
      assert.equal((await r3.restoreByPin({ gameN: 8989, pin: '898989' }, { limitKey: '198.18.41.2', trust: { userId: victimOwner } })).status, 200)
      // an admin is trusted for every match of the number
      assert.equal((await r3.restoreByPin({ gameN: 8989, pin: '898989' }, { limitKey: range, trust: { userId: attacker, isAdmin: async () => true } })).status, 200)
      // and another range proves the victim's match with its PIN
      assert.equal((await r3.restoreByPin({ gameN: 8989, pin: '898989' }, { limitKey: '198.18.42.1' })).status, 200)
    })

    it('finds an older match of its game number however many newer ones there are', async () => {
      // beach game numbers start again in every tournament
      const oldest = uniq('FIRST')
      const first = await restore.restoreMatch(backup(oldest, { gameN: 8686, pin: '868686', sets: 0, events: 0 }), W)
      await raw.query('BEGIN')
      await raw.query("SET LOCAL session_replication_role = 'replica'")
      await raw.query("UPDATE matches SET updated_at = now() - interval '30 days' WHERE id = $1", [first.body.data.id])
      await raw.query('COMMIT')
      await raw.query(
        `INSERT INTO matches (external_id, game_n, game_pin, test, status)
         SELECT $1 || g, 8686, '000000', true, 'live' FROM generate_series(1, 60) g`, [uniq('LATER')])
      const r = await restore.restoreByPin({ gameN: 8686, pin: '868686' }, { limitKey: 'ip-oldest' })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.equal(r.body.data.match.external_id, oldest)
    })

    it('successful lookups do not count against the caller', async () => {
      for (let i = 0; i < 25; i++) {
        const r = await restore.restoreByPin({ gameN: 31337, pin: '135790' }, { limitKey: 'ip-repeat' })
        assert.equal(r.status, 200, `attempt ${i}`)
      }
    })

    it('picks the most recently updated match when game number and PIN repeat', async () => {
      // Game numbers repeat across seasons (db/007 allows one cloud match per game and season)
      const older = await restore.restoreMatch(backup(uniq(), { gameN: 4242, pin: '999999', scheduledAt: '2024-10-05T16:00:00Z' }), W)
      await earlierSeason(older.body.data.id)
      const newer = await restore.restoreMatch(backup(uniq(), { gameN: 4242, pin: '999999', scheduledAt: '2025-10-05T16:00:00Z' }), W)
      // (db/006's trigger would reset updated_at: back-date it with the user triggers off)
      await raw.query('BEGIN')
      await raw.query("SET LOCAL session_replication_role = 'replica'")
      await raw.query("UPDATE matches SET updated_at = now() - interval '1 day' WHERE id = $1", [older.body.data.id])
      await raw.query('COMMIT')
      const r = await restore.restoreByPin({ gameN: 4242, pin: '999999' }, { limitKey: 'ip-dup' })
      assert.equal(r.body.data.match.id, newer.body.data.id)
    })

    it('returns every event of a long match (above the 1000-row /api/db cap)', async () => {
      const ext2 = uniq('LONG')
      const r = await restore.restoreMatch(backup(ext2, { gameN: 5150, pin: '515151', events: 1200 }), W)
      assert.equal(r.body.data.counts.events, 1200)
      const p = await restore.restoreByPin({ gameN: 5150, pin: '515151' }, { limitKey: 'ip-long' })
      assert.equal(p.body.data.events.length, 1200)
    })

    // The device continuing the match keeps the cloud ids and gives out new
    // ones above idFloor (frontend importMatchFromSupabase): a rally under the
    // id of a voided event, or of an undo that reached the server before its
    // event, would be born voided (db/015)
    // 2026-10-26: the device that continues the match becomes its scorer
    // (server.js takeOverByPin) before the match is read for it: a rally of
    // the previous device is in what it reads, or refused after the claim
    it('takeOver runs once the PIN is proved, before the sets and events are read; its answer is `scorer`', async () => {
      const ext4 = uniq('TAKE')
      const made = await restore.restoreMatch(backup(ext4, { gameN: 7170, pin: '717171', sets: 1, events: 2 }), W)
      const seen = []
      const takeOver = async (m) => {
        seen.push(m)
        // the previous device's rally that reached the server just before the claim
        await raw.query(`INSERT INTO events (match_id, external_id, set_index, type, seq, payload, sport_type)
                         VALUES ($1, $2, 1, 'point', 3, '{}', 'indoor')`, [m.id, `${ext4}:e:3`])
        return { mine: true, moved: true }
      }
      const r = await restore.restoreByPin({ gameN: 7170, pin: '717171' }, { limitKey: 'ip-take', takeOver })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.deepEqual(seen, [{ id: made.body.data.id, external_id: ext4 }])
      assert.deepEqual(r.body.data.events.map(e => e.seq), [1, 2, 3])
      assert.deepEqual(r.body.data.scorer, { mine: true, moved: true })

      // a wrong PIN never gets that far; a failing take-over leaves the lookup as it was
      assert.equal((await restore.restoreByPin({ gameN: 7170, pin: '000000' }, { limitKey: 'ip-take-2', takeOver })).status, 404)
      assert.equal(seen.length, 1)
      const failing = await restore.restoreByPin({ gameN: 7170, pin: '717171' }, { limitKey: 'ip-take-3', takeOver: async () => { throw new Error('db down') } })
      assert.equal(failing.status, 200)
      assert.equal(failing.body.data.scorer, undefined)
      const none = await restore.restoreByPin({ gameN: 7170, pin: '717171' }, { limitKey: 'ip-take-4', takeOver: async () => null })
      assert.equal(none.body.data.scorer, undefined)
    })

    it('idFloor: the highest set / event ids the match used, voided events and revisions included', async () => {
      const ext3 = uniq('FLOOR')
      const b = backup(ext3, { gameN: 6160, pin: '616161', sets: 2, events: 3 })
      b.events.push({ external_id: `${ext3}_event_9`, set_index: 1, type: 'point', seq: 9, payload: {}, sport_type: 'indoor' })
      const r = await restore.restoreMatch(b, W)
      const matchId = r.body.data.id
      const floorOf = async (key) => (await restore.restoreByPin({ gameN: 6160, pin: '616161' }, { limitKey: key })).body.data.idFloor
      assert.deepEqual(await floorOf('ip-floor-1'), { set: 2, event: 3 })

      // event 12 voided on the server: left out of the events, not of the floor
      await raw.query(`INSERT INTO events (match_id, external_id, set_index, type, seq, payload, sport_type, voided_at, void_reason)
                       VALUES ($1, $2, 1, 'point', 12, '{}', 'indoor', now(), 'undo')`, [matchId, `${ext3}:e:12`])
      // event 40 undone before it was uploaded: only its revision is there
      await raw.query(`INSERT INTO event_revisions (rev_uid, match_id, event_external_id, op, reason, applied, client_ts)
                       VALUES (gen_random_uuid(), $1, $2, 'void', 'undo', false, now())`, [matchId, `${ext3}:e:40`])
      // another match's ids do not count
      const other = await restore.restoreMatch(backup(uniq('OTHER'), { gameN: 6161, events: 2 }), W)
      await raw.query(`INSERT INTO event_revisions (rev_uid, match_id, event_external_id, op, reason, applied, client_ts)
                       VALUES (gen_random_uuid(), $1, $2, 'void', 'undo', false, now())`, [other.body.data.id, `${ext3}:e:900`])

      const p = await restore.restoreByPin({ gameN: 6160, pin: '616161' }, { limitKey: 'ip-floor-2' })
      assert.deepEqual(p.body.data.events.map(e => e.seq).sort((x, y) => x - y), [1, 2, 3, 9])
      assert.deepEqual(p.body.data.idFloor, { set: 2, event: 40 })
    })
  })
})
