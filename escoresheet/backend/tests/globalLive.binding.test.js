/**
 * Who may write a court of the live screen for TVs (lib/globalLive.js put),
 * audit round 3 SEC-07 and LOG-11:
 *
 *   - a court the relay proved for its room (the room key's own court token,
 *     the token the server makes for a room that sends none, or a room whose
 *     scorer proved the database row's game PIN) takes no HTTP push and no
 *     other room: an anonymous push with the token computed from the public
 *     seed key (what apps up to 26.11.x and OpenBeach send) can neither
 *     overwrite it nor push it out;
 *   - courts nobody proved work as before for the apps in the field: the
 *     same token updates the same court, by HTTP push or relay;
 *   - one court per relay room: a first push without the token and later
 *     pushes with it, or a token the room did not start with, stay one court;
 *   - a court's public id says nothing about its token.
 *
 *   cd escoresheet/backend && node --test tests/globalLive.binding.test.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createGlobalLive, legacyCourtToken } from '../lib/globalLive.js'

const CODE = 'ABCD2345'
const live = (over = {}) => ({ team_a_name: 'Bergtal IS', team_b_name: 'Seeblick IS', points_a: 12, points_b: 9, sets_won_a: 1, sets_won_b: 0, current_set: 2, best_of: 5, match_status: 'live', ...over })
const entry = (over = {}) => ({ match: { coinTossTeamA: 'home', hall: 'Hall 1' }, homeTeam: { name: 'Bergtal IS' }, awayTeam: { name: 'Seeblick IS' }, sets: [], ...over })
const forged = () => live({ points_a: 0, points_b: 25, sets_won_a: 0, sets_won_b: 3, match_status: 'final' })
const hex = () => randomBytes(16).toString('hex')
const courts = (store, code = CODE) => store.get(code)?.courts ?? []

describe('a court the relay proved (SEC-07)', () => {
  it('an older app\'s court on the cloud relay (token of the seed key = its room key): no HTTP push with that public token overwrites it', () => {
    const store = createGlobalLive()
    const seed = 'match_1763900000000_league1'
    const token = legacyCourtToken(seed)
    assert.equal(store.put(CODE, token, live(), entry(), { room: seed }).ok, true)
    const before = courts(store)
    // the attacker: the game number on the TV -> the external id in the public API -> the same token
    const r = store.put(CODE, legacyCourtToken(seed), forged(), entry({ match: { hall: 'MATCH CANCELLED' } }), { source: '203.0.113.99' })
    assert.deepEqual(r, { ok: false, reason: 'bound' })
    assert.deepEqual(courts(store), before)
    assert.equal(store.stats().refused.bound, 1)
    // the scorer's next rally still lands
    assert.equal(store.put(CODE, token, live({ points_a: 13 }), entry(), { room: seed }).ok, true)
    assert.equal(courts(store)[0].points.home, 13)
  })

  it('another relay room (one the attacker owns) naming that token is refused too', () => {
    const store = createGlobalLive()
    const seed = 'match_1763900000000_league2'
    const token = legacyCourtToken(seed)
    store.put(CODE, token, live(), entry(), { room: seed })
    const r = store.put(CODE, token, forged(), entry(), { room: 'match_test_attacker', source: '203.0.113.98' })
    assert.equal(r.reason, 'bound')
    assert.equal(courts(store).length, 1)
    assert.equal(courts(store)[0].points.home, 12)
  })

  it('a room whose scorer proved the database row\'s game PIN locks its court whatever its token', () => {
    const store = createGlobalLive()
    const token = hex()
    store.put(CODE, token, live(), entry(), { room: 'match_official_3', official: true })
    assert.equal(store.put(CODE, token, forged(), entry()).reason, 'bound')
    assert.equal(store.put(CODE, token, forged(), entry(), { room: 'match_test_x' }).reason, 'bound')
    assert.equal(courts(store)[0].points.home, 12)
  })

  it('the court of a room that sends no token is the server\'s (keyed): nobody can push to it', () => {
    const store = createGlobalLive({ secret: 's'.repeat(40) })
    const r = store.put(CODE, null, live(), entry(), { room: 'match_old_app' })
    assert.equal(r.ok, true)
    // not the unkeyed hash of the room key any more
    assert.notEqual(r.token, createHash('sha256').update('room\0match_old_app').digest('hex').slice(0, 32))
    assert.equal(store.put(CODE, r.token, forged(), entry()).reason, 'bound')
  })

  it('an unproved new court never pushes out a court that is being updated (24 random courts)', () => {
    let t = 1_000_000
    const store = createGlobalLive({ now: () => t })
    const seed = 'match_1763900000000_league4'
    store.put(CODE, legacyCourtToken(seed), live(), entry(), { room: seed })
    let accepted = 0
    for (let i = 0; i < 24; i++) {
      t += 10
      if (store.put(CODE, hex(), live({ team_a_name: `SPAM ${i}` }), {}, { source: `203.0.113.${100 + (i % 5)}` }).ok) accepted++
    }
    assert.equal(accepted, 23) // the 24th place is the real court's
    assert.ok(courts(store).some((c) => c.home.name === 'Bergtal IS'), 'the real court is still there')
    assert.equal(store.stats().refused.courtsFull, 1)
  })
})

describe('courts nobody proved: the apps in the field keep working', () => {
  it('an HTTP push (desktop app, venue relay forward) with an older app\'s token: the same token updates the same court', () => {
    const store = createGlobalLive()
    const token = legacyCourtToken('match_1763900000000_desk')
    assert.equal(store.put(CODE, token, live({ points_a: 1 }), entry(), { source: '198.51.100.7' }).ok, true)
    assert.equal(store.put(CODE, token, live({ points_a: 2 }), entry(), { source: '198.51.100.7' }).ok, true)
    assert.deepEqual(courts(store).map((c) => c.points.home), [2])
  })

  it('a court first pushed over HTTP and then over the relay with the same token stays one court', () => {
    const store = createGlobalLive()
    const token = hex()
    store.put(CODE, token, live({ points_a: 7 }), entry())
    assert.equal(store.put(CODE, token, live({ points_a: 8 }), entry(), { room: 'match_test_desk' }).ok, true)
    assert.deepEqual(courts(store).map((c) => c.points.home), [8])
  })

  it('the room of an older app\'s league match takes back a court a stranger made first with its public token', () => {
    const store = createGlobalLive()
    const seed = 'match_1763900000000_league5'
    store.put(CODE, legacyCourtToken(seed), forged(), entry(), { source: '203.0.113.97' })
    assert.equal(store.put(CODE, legacyCourtToken(seed), live(), entry(), { room: seed }).ok, true)
    assert.equal(courts(store)[0].points.home, 12)
    assert.equal(store.put(CODE, legacyCourtToken(seed), forged(), entry(), { source: '203.0.113.97' }).reason, 'bound')
  })
})

describe('one court per relay room (LOG-11)', () => {
  it('a first push without the token, then pushes with it: one court, the room\'s first one gone', () => {
    const store = createGlobalLive()
    const room = 'match_1763900000000_ghost'
    const token = hex()
    assert.equal(store.put(CODE, null, live({ points_a: 1, points_b: 0 }), entry(), { room }).ok, true)
    for (let i = 2; i <= 10; i++) store.put(CODE, token, live({ points_a: i, points_b: 0 }), entry(), { room })
    assert.deepEqual(courts(store).map((c) => c.points.home), [10])
  })

  it('pushes without a token after one with it go to the token\'s court; a token the room did not start with too', () => {
    const store = createGlobalLive()
    const room = 'match_1763900000000_two_devices'
    const first = store.put(CODE, hex(), live({ points_a: 1 }), entry(), { room })
    const again = store.put(CODE, null, live({ points_a: 2 }), entry(), { room })
    const other = store.put(CODE, hex(), live({ points_a: 3 }), entry(), { room })
    assert.equal(again.token, first.token)
    assert.equal(other.token, first.token)
    assert.deepEqual(courts(store).map((c) => c.points.home), [3])
  })

  it('a court\'s public id is not the hash of its code and token', () => {
    const store = createGlobalLive()
    const token = hex()
    const { id } = store.put(CODE, token, live(), entry())
    assert.notEqual(id, createHash('sha256').update(`${CODE}\0${token}`).digest('base64url').slice(0, 10))
    assert.equal(JSON.stringify(store.get(CODE)).includes(token), false)
  })
})
