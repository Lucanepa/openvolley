// The Global cloud copy's PIN failure budget (audit 2026-11-23 SEC-30): with a
// leaked backup code (the key), its 4 to 8 digit PIN could be guessed without
// a limit, from as many addresses as the guesser had. Every wrong PIN of a
// copy is counted in its row (db/053); each 10th locks the copy for the
// networks that guessed (owner 2026-11-23: lock the guessers only), the
// right PIN from any other network still works. Needs PG_TEST_URL.
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import { SKIP_PG, createTestDatabase } from './helpers/pgTestDb.js'
import { createGlobalMatches, keyHash, pinLockMs, PIN_LOCK_AFTER, PIN_LOCK_BASE_MS, PIN_LOCK_MAX_MS, guesserNetwork } from '../lib/globalMatches.js'

const silent = { error() {}, warn() {}, log() {} }
const summary = { home: { name: 'Bergtal IS' }, away: { name: 'Seeblick IS' } }
const newKey = () => crypto.randomBytes(16).toString('base64url')
// a guesser that rotates its address in its /48 (an IPv6 subscriber has 65,536 /64s)
const rotating = (i) => ({ ip: `2001:db8:77:${(i + 1).toString(16)}::${(i % 7) + 1}` })
const PIN = '4711'
const wrong = (i) => String(1000 + i) // incrementing PINs, never 4711

describe('the lock\'s length', () => {
  it('10 wrong PINs lock for 15 minutes, each further 10 doubles it, a day at most', () => {
    assert.equal(PIN_LOCK_AFTER, 10)
    assert.equal(pinLockMs(10), PIN_LOCK_BASE_MS)
    assert.equal(pinLockMs(20), 2 * PIN_LOCK_BASE_MS)
    assert.equal(pinLockMs(30), 4 * PIN_LOCK_BASE_MS)
    assert.equal(pinLockMs(10 * 30), PIN_LOCK_MAX_MS)
    assert.equal(guesserNetwork('2001:db8:77:1::1'), guesserNetwork('2001:db8:77:ffff::9'), 'one /48')
    assert.notEqual(guesserNetwork('2001:db8:77::1'), guesserNetwork('2001:db8:78::1'))
    assert.equal(guesserNetwork('192.0.2.7'), guesserNetwork('192.0.2.200'), 'one IPv4 /24')
  })
})

describe('Global cloud: wrong PINs (SEC-30)', { skip: SKIP_PG }, () => {
  let tdb, pool, owner
  before(async () => {
    tdb = await createTestDatabase('globalpin')
    pool = new pg.Pool({ connectionString: await tdb.createAppRole() })
    owner = new pg.Client({ connectionString: tdb.url })
    await owner.connect()
  })
  after(async () => { await owner?.end(); await pool?.end(); await tdb?.drop() })
  beforeEach(async () => { await owner.query('DELETE FROM public.global_matches') })
  const row = async (key) => (await owner.query('SELECT pin_failures, locked_until, locked_until - now() AS left FROM public.global_matches WHERE key_hash = $1', [keyHash(key)])).rows[0]

  it('incrementing PINs from rotating addresses: locked after 10 for the guessers, the right PIN from elsewhere still loads', async () => {
    const gm = createGlobalMatches({ pool, logger: silent })
    const key = newKey()
    const scorer = { ip: '198.51.100.20' }
    assert.equal((await gm.save(key, PIN, { bundle: { match: { id: 1 } }, summary }, scorer)).status, 200)
    const answers = []
    for (let i = 0; i < 14; i++) answers.push((await gm.load(key, wrong(i), rotating(i))).status)
    assert.deepEqual(answers, [403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 429, 429, 429, 429])
    // the guessers are refused even with the right PIN: no oracle while locked
    const locked = await gm.load(key, PIN, rotating(20))
    assert.equal(locked.status, 429)
    assert.equal(locked.body.error.code, 'OV_GLOBAL_PIN_LOCKED')
    assert.ok(locked.retryAfter > 800 && locked.retryAfter <= 900, String(locked.retryAfter))
    // the scorer's other device elsewhere: loads, saves, shares
    assert.equal((await gm.load(key, PIN, { ip: '203.0.113.9' })).status, 200)
    assert.equal((await gm.save(key, PIN, { bundle: { match: { id: 2 } }, summary }, scorer)).status, 200)
    assert.equal((await gm.setShare(key, PIN, true, scorer)).status, 200)
    const r = await row(key)
    assert.equal(r.pin_failures, 10)
    assert.ok(r.locked_until, 'locked in the row')
  })

  it('the count is in the row: a restart (no memory) does not reset it, and each new network gets one guess at most while locked', async () => {
    const key = newKey()
    const first = createGlobalMatches({ pool, logger: silent })
    await first.save(key, PIN, { bundle: {}, summary }, { ip: '198.51.100.21' })
    for (let i = 0; i < 10; i++) await first.load(key, wrong(i), { ip: `192.0.2.${i + 1}` })
    // a new process: it does not know who guessed, the row is still locked
    const gm = createGlobalMatches({ pool, logger: silent })
    assert.equal((await gm.load(key, wrong(50), { ip: '192.0.2.77' })).status, 403, 'one guess for a network it does not know yet')
    assert.equal((await gm.load(key, PIN, { ip: '192.0.2.77' })).status, 429, 'then that network is held off, the right PIN too')
    assert.equal((await gm.load(key, PIN, { ip: '203.0.113.30' })).status, 200, 'another network with the right PIN')
    assert.equal((await row(key)).pin_failures, 11)
  })

  it('every 10 more wrong PINs lock it longer (doubled), also from networks that never guessed before', async () => {
    const gm = createGlobalMatches({ pool, logger: silent })
    const key = newKey()
    await gm.save(key, PIN, { bundle: {}, summary }, { ip: '198.51.100.22' })
    for (let i = 0; i < 10; i++) await gm.load(key, wrong(i), { ip: '192.0.2.10' })
    // a distributed guesser: one wrong PIN from each of 10 more networks
    for (let i = 0; i < 10; i++) assert.equal((await gm.load(key, wrong(100 + i), { ip: `2001:db8:${i + 1}::1` })).status, 403)
    const r = await row(key)
    assert.equal(r.pin_failures, 20)
    const leftMin = (r.left.hours || 0) * 60 + (r.left.minutes || 0)
    assert.ok(leftMin >= 29 && leftMin <= 30, `about 30 min: ${JSON.stringify(r.left)}`)
  })

  it('a save with a wrong PIN is counted too, never overwrites, and is held off while locked', async () => {
    const gm = createGlobalMatches({ pool, logger: silent })
    const key = newKey()
    await gm.save(key, PIN, { bundle: { mine: true }, summary }, { ip: '198.51.100.23' })
    for (let i = 0; i < 10; i++) assert.equal((await gm.save(key, wrong(i), { bundle: { evil: true }, summary }, { ip: '192.0.2.40' })).status, 403)
    assert.equal((await gm.save(key, PIN, { bundle: { evil: true }, summary }, { ip: '192.0.2.40' })).status, 429)
    assert.equal((await gm.del(key, PIN, { ip: '192.0.2.40' })).status, 429)
    assert.deepEqual((await gm.load(key, PIN, { ip: '198.51.100.23' })).body.data.bundle, { mine: true })
  })

  it('once the lock ends the guesser may try again (and is counted); a day without a wrong PIN starts the count over', async () => {
    const gm = createGlobalMatches({ pool, logger: silent })
    const key = newKey()
    await gm.save(key, PIN, { bundle: {}, summary }, { ip: '198.51.100.24' })
    for (let i = 0; i < 10; i++) await gm.load(key, wrong(i), { ip: '192.0.2.50' })
    assert.equal((await gm.load(key, PIN, { ip: '192.0.2.50' })).status, 429)
    await owner.query("UPDATE public.global_matches SET locked_until = now() - interval '1 second' WHERE key_hash = $1", [keyHash(key)])
    assert.equal((await gm.load(key, wrong(11), { ip: '192.0.2.50' })).status, 403)
    assert.equal((await row(key)).pin_failures, 11)
    await owner.query("UPDATE public.global_matches SET pin_failed_at = now() - interval '25 hours' WHERE key_hash = $1", [keyHash(key)])
    assert.equal((await gm.load(key, wrong(12), { ip: '192.0.2.51' })).status, 403)
    assert.equal((await row(key)).pin_failures, 1)
  })

  it('more than 64 networks in turn (an IPv4 /24 each): once locked every one is held off, the PIN is not found; the scorer still saves (GCS-R3)', async () => {
    const gm = createGlobalMatches({ pool, logger: silent })
    const key = newKey()
    const scorer = { ip: '198.51.100.30' }
    assert.equal((await gm.save(key, PIN, { bundle: { match: { id: 1 } }, summary }, scorer)).status, 200)
    // 100 proxies, a /24 each, in turn: before the fix the 65th pushed the
    // first out of the copy's list, so each came back as a fresh network and
    // every guess was compared
    const proxy = (i) => ({ ip: `198.18.${i % 100}.7` })
    const tally = {}
    for (let i = 0; i < 200; i++) {
      const s = (await gm.load(key, wrong(i), proxy(i))).status
      tally[s] = (tally[s] || 0) + 1
    }
    // 10 before the lock, then one each for the networks the list still
    // takes (64 in all), and one for the network that found it full
    assert.deepEqual(tally, { 403: 65, 429: 135 })
    assert.equal((await gm.load(key, PIN, proxy(200))).status, 429, 'the right PIN from a guesser: held off')
    assert.equal((await row(key)).pin_failures, 65)
    // the scorer's network gave the right PIN: it still saves and loads
    assert.equal((await gm.save(key, PIN, { bundle: { match: { id: 2 } }, summary }, scorer)).status, 200)
    assert.equal((await gm.load(key, PIN, scorer)).status, 200)
    // a network nobody has seen is held off while the list is full and the
    // copy locked (it cannot be told from the 101st proxy); the lock ends
    // within a day, and then it loads
    assert.equal((await gm.load(key, PIN, { ip: '203.0.113.31' })).status, 429)
    await owner.query("UPDATE public.global_matches SET locked_until = now() - interval '1 second' WHERE key_hash = $1", [keyHash(key)])
    assert.equal((await gm.load(key, PIN, { ip: '203.0.113.31' })).status, 200)
  })

  it('a typo, then the right PIN: that network is not held against the copy (old 4-digit PINs keep working)', async () => {
    const gm = createGlobalMatches({ pool, logger: silent })
    const key = newKey()
    const hall = { ip: '198.51.100.25' }
    await gm.save(key, '1234', { bundle: {}, summary }, hall)
    assert.equal((await gm.load(key, '1243', hall)).status, 403)
    assert.equal((await gm.load(key, '1234', hall)).status, 200)
    // a guesser elsewhere locks the copy: the hall, right since its typo, still loads
    for (let i = 0; i < 10; i++) await gm.load(key, wrong(i), { ip: '203.0.113.60' })
    assert.equal((await gm.load(key, '1234', { ip: '203.0.113.60' })).status, 429)
    assert.equal((await gm.load(key, '1234', hall)).status, 200)
    // 8 digits too
    const k8 = newKey()
    assert.equal((await gm.save(k8, '12345678', { bundle: {}, summary }, hall)).status, 200)
    assert.equal((await gm.load(k8, '12345678', hall)).status, 200)
  })
})
