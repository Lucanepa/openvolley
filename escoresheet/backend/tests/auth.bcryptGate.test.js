/**
 * Audit 2611 SEC-03: a flood of wrong sign-ins from fresh sources filled the
 * one FIFO bcrypt gate (2 running, 16 waiting), so a scorer signing in at
 * that moment got 503 auth_busy (poc/auth-sessions/p05-gate-saturation.mjs,
 * poc/sec-03/burst-repeat.mjs). Now bcrypt runs in worker threads
 * (lib/bcryptPool.js) and the gate is fair between clients (createFairGate):
 * one job per client lane (an IPv6 /48, an IPv4 address), the lane served
 * least recently first, a source that signed in to the account before ahead,
 * a short wait, a quick 503 when there is no place, and an ops alert when the
 * gate stays at capacity.
 *
 * The unit parts always run; the sign-in floods need PG_TEST_URL
 * (tests/helpers/pgTestDb.js).
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import bcryptjs from 'bcryptjs'
import pg from 'pg'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { SKIP_PG, SCHEMA_SQL, createTestDatabase } from './helpers/pgTestDb.js'
import { createAuth, createFairGate, ipLaneKey } from '../lib/auth.js'
import { createBcryptPool } from '../lib/bcryptPool.js'

const here = dirname(fileURLToPath(import.meta.url))
const SESSIONS_SQL = readFileSync(join(here, '..', 'db', '002_app_sessions.sql'), 'utf8')
const silent = { log() {}, warn() {}, error() {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A job that holds its slot until released; records the order jobs started in. */
function controlled(gate, order) {
  return (name, opts) => {
    let release
    const held = new Promise((r) => { release = r })
    const p = gate.run(async () => { order.push(name); await held; return name }, opts)
    p.catch(() => {})
    return { p, release: () => release() }
  }
}

describe('ipLaneKey', () => {
  it('one lane per IPv6 /48 and per IPv4 address', () => {
    assert.equal(ipLaneKey('2001:db8:5151:1::9'), '2001:db8:5151::/48')
    assert.equal(ipLaneKey('2001:db8:5151:ffff:1:2:3:4'), '2001:db8:5151::/48')
    assert.notEqual(ipLaneKey('2001:db8:5152:1::9'), ipLaneKey('2001:db8:5151:1::9'))
    assert.equal(ipLaneKey('203.0.113.5'), '203.0.113.5')
    assert.equal(ipLaneKey('::ffff:203.0.113.5'), '203.0.113.5')
    assert.equal(ipLaneKey(undefined), 'unknown')
  })
})

describe('createFairGate', () => {
  // the gate's timers are unref()'d (they never hold the backend open)
  let keepAlive
  beforeEach(() => { keepAlive = setInterval(() => {}, 1000) })
  afterEach(() => clearInterval(keepAlive))

  it('one job at a time per lane, even with free slots', async () => {
    const gate = createFairGate({ maxConcurrent: 4, maxQueue: 8 })
    const order = []
    const job = controlled(gate, order)
    const a1 = job('a1', { lane: 'A' })
    const a2 = job('a2', { lane: 'A' })
    const b1 = job('b1', { lane: 'B' })
    await sleep(5)
    assert.deepEqual(order, ['a1', 'b1'], 'a second job of lane A waits although slots are free')
    assert.equal(gate.active, 2)
    a1.release(); await a1.p
    await sleep(5)
    assert.deepEqual(order, ['a1', 'b1', 'a2'])
    a2.release(); b1.release()
    await Promise.all([a2.p, b1.p])
    assert.equal(gate.active, 0)
    assert.equal(gate.lanes, 0, 'idle lanes are forgotten')
  })

  it('a flood from one lane cannot keep another lane waiting: it takes the flood\'s newest place and goes next', async () => {
    const reasons = []
    const gate = createFairGate({ maxConcurrent: 1, maxQueue: 4, onReject: (r) => reasons.push(r) })
    const order = []
    const job = controlled(gate, order)
    const flood = Array.from({ length: 10 }, (_, i) => job(`f${i}`, { lane: 'flood' }))
    await sleep(5)
    assert.deepEqual(order, ['f0'])
    const settled = await Promise.allSettled(flood.slice(5).map((j) => j.p))
    assert.ok(settled.every((s) => s.status === 'rejected' && s.reason.code === 'AUTH_BUSY'), 'beyond the queue: 503 at once')
    const legit = job('legit', { lane: 'legit' })
    const evicted = await Promise.allSettled([flood[4].p])
    assert.equal(evicted[0].status, 'rejected', 'the flood\'s newest waiting job made room')
    assert.equal(evicted[0].reason.code, 'AUTH_BUSY')
    assert.deepEqual(reasons, ['full', 'full', 'full', 'full', 'full', 'evicted'])
    flood[0].release(); await flood[0].p
    await sleep(5)
    assert.deepEqual(order, ['f0', 'legit'], 'the other lane goes before the flood\'s next job')
    legit.release(); await legit.p
    for (const j of flood.slice(1, 4)) j.release()
    await Promise.all(flood.slice(1, 4).map((j) => j.p))
    assert.deepEqual(order, ['f0', 'legit', 'f1', 'f2', 'f3'])
  })

  it('lanes take turns: the lane served least recently goes first', async () => {
    const gate = createFairGate({ maxConcurrent: 1, maxQueue: 16 })
    const order = []
    const job = controlled(gate, order)
    const jobs = [job('a1', { lane: 'A' }), job('a2', { lane: 'A' }), job('a3', { lane: 'A' }), job('b1', { lane: 'B' }), job('b2', { lane: 'B' }), job('c1', { lane: 'C' })]
    for (const j of jobs) { await sleep(2); j.release(); await sleep(2) }
    await Promise.all(jobs.map((j) => j.p))
    assert.deepEqual(order, ['a1', 'b1', 'c1', 'a2', 'b2', 'a3'])
  })

  it('a full queue of many lanes: a newcomer gets 503, a priority newcomer takes the newest place and goes first', async () => {
    const gate = createFairGate({ maxConcurrent: 1, maxQueue: 3 })
    const order = []
    const job = controlled(gate, order)
    const running = job('run', { lane: 'R' })
    const waiting = ['x', 'y', 'z'].map((l) => job(l, { lane: l }))
    await sleep(5)
    const stranger = job('stranger', { lane: 'S' })
    await assert.rejects(stranger.p, (e) => e.code === 'AUTH_BUSY', 'no lane waits with more than one: no place')
    const owner = job('owner', { lane: 'O', priority: true })
    await assert.rejects(waiting[2].p, (e) => e.code === 'AUTH_BUSY', 'the newest waiting job made room')
    running.release(); await running.p
    await sleep(5)
    assert.deepEqual(order, ['run', 'owner'])
    owner.release()
    for (const j of waiting.slice(0, 2)) j.release()
    await Promise.all([owner.p, ...waiting.slice(0, 2).map((j) => j.p)])
    assert.deepEqual(order, ['run', 'owner', 'x', 'y'])
  })

  it('maxWaitMs: a job that waited that long answers AUTH_BUSY quickly and leaves the queue', async () => {
    const reasons = []
    const gate = createFairGate({ maxConcurrent: 1, maxQueue: 8, maxWaitMs: 60, onReject: (r) => reasons.push(r) })
    const order = []
    const job = controlled(gate, order)
    const first = job('first', { lane: 'A' })
    const t0 = Date.now()
    const late = job('late', { lane: 'B' })
    await assert.rejects(late.p, (e) => e.code === 'AUTH_BUSY')
    assert.ok(Date.now() - t0 < 1000, 'shed in about maxWaitMs, not seconds')
    assert.equal(gate.queued, 0)
    assert.deepEqual(reasons, ['timeout'])
    first.release(); await first.p
    assert.equal(gate.rejected, 1)
  })

  it('jobs without a lane (scripts, the dummy hash) have no lane limit', async () => {
    const gate = createFairGate({ maxConcurrent: 3, maxQueue: 0 })
    const order = []
    const job = controlled(gate, order)
    const jobs = [job('s1'), job('s2'), job('s3')]
    await sleep(5)
    assert.equal(gate.active, 3)
    for (const j of jobs) j.release()
    await Promise.all(jobs.map((j) => j.p))
  })
})

describe('lib/bcryptPool.js: bcrypt in worker threads', () => {
  it('hashes and compares exactly like bcryptjs, in a worker thread', async () => {
    const pool = createBcryptPool({ size: 2, logger: silent })
    assert.ok(pool, 'bcryptjs is on disk here')
    try {
      const h = await pool.hash('a-password-1', 4)
      assert.equal(bcryptjs.compareSync('a-password-1', h), true)
      assert.equal(await pool.compare('a-password-1', h), true)
      assert.equal(await pool.compare('wrong', h), false)
      // a hash made elsewhere (Python bcrypt 4.2, as in auth.test.js)
      assert.equal(await pool.compare('old-supabase-pw', '$2b$10$K2WRqFYWaZt0EwftvRmNcez7AOgzMxXzcKTTRc80mAIxg1FLEj14.'), true)
      const s = pool.stats()
      assert.ok(s.workers >= 1 && s.workers <= 2)
      assert.equal(s.fallbacks, 0, 'nothing ran on the main thread')
      await assert.rejects(pool.compare('x', 12345), 'a bad argument rejects, as bcryptjs does')
    } finally {
      await pool.close()
    }
  })

  it('keeps the event loop free while it hashes', async () => {
    const pool = createBcryptPool({ size: 1, logger: silent })
    try {
      await pool.hash('warm-up', 4)
      let ticks = 0
      let maxGap = 0
      let last = Date.now()
      const timer = setInterval(() => { const t = Date.now(); maxGap = Math.max(maxGap, t - last); last = t; ticks++ }, 5)
      const t0 = Date.now()
      await pool.hash('a-long-hash', 12)
      const took = Date.now() - t0
      clearInterval(timer)
      assert.equal(pool.stats().fallbacks, 0)
      assert.ok(ticks >= 3, `the main thread kept running (${ticks} ticks in ${took} ms)`)
      assert.ok(maxGap < Math.max(150, took / 2), `no long block of the event loop (largest gap ${maxGap} ms of ${took} ms)`)
    } finally {
      await pool.close()
    }
  })

  it('a thread that cannot start or dies never fails a sign-in: the job runs on the main thread', async () => {
    const log = { lines: [], log() {}, warn(m) { this.lines.push(m) }, error(m) { this.lines.push(m) } }
    let made = 0
    const broken = createBcryptPool({ size: 1, logger: log, workerFactory: () => { made++; throw new Error('no threads here') } })
    const h = bcryptjs.hashSync('pw-1', 4)
    for (let i = 0; i < 4; i++) assert.equal(await broken.compare('pw-1', h), true)
    assert.equal(broken.stats().broken, true, 'gives up after a few failed starts')
    assert.equal(made, 3)
    assert.ok(log.lines.some((l) => /worker threads unavailable/.test(l)))
    // a worker that crashes with a job in flight
    const crashing = createBcryptPool({
      size: 1,
      logger: log,
      workerFactory: () => {
        const w = new EventEmitter()
        w.postMessage = () => setImmediate(() => w.emit('error', new Error('boom')))
        w.terminate = async () => {}
        w.ref = w.unref = () => {}
        return w
      }
    })
    assert.equal(await crashing.compare('pw-1', h), true)
    assert.equal(await crashing.compare('nope', h), false)
    assert.ok(crashing.stats().fallbacks >= 2)
  })
})

describe('sign-in floods (audit 2611 SEC-03)', { skip: SKIP_PG }, () => {
  let tdb, pool
  let seq = 0
  const v4 = () => `198.18.${Math.floor(++seq / 250)}.${(seq % 250) + 1}`
  before(async () => {
    tdb = await createTestDatabase('authsignin_gate', { schemaSql: SCHEMA_SQL + '\n' + SESSIONS_SQL })
    pool = new pg.Pool({ connectionString: tdb.url, max: 8 })
    pool.on('connect', (c) => c.on('error', () => {}))
    pool.on('error', () => {})
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
    await pool.query(`INSERT INTO auth.users (email, encrypted_password, email_confirmed_at) VALUES ('scorer@example.ch', crypt('scorer-password-1', gen_salt('bf', 4)), now())`)
  })
  after(async () => {
    await pool?.end()
    await tdb?.drop()
  })

  /** bcryptjs, but every compare takes at least `ms` (the gate's work, made slow and steady). */
  const slowBcrypt = (ms) => ({
    hash: bcryptjs.hash,
    compare: async (pw, h) => { const [r] = await Promise.all([bcryptjs.compare(pw, h), sleep(ms)]); return r }
  })
  const makeAuth = (opts = {}) => createAuth({
    pool, logger: silent, bcryptCost: 4, ...opts,
    limits: { signInGlobal: false, signInIp: false, signInEmail: false, ...(opts.limits || {}) }
  })
  const signIn = (auth, email, password, ip) => auth.handleAuthRequest('sign-in', { email, password }, { ip })
  const tally = (rs) => rs.reduce((t, r) => { const k = `${r.status}:${r.body.error?.code || 'ok'}`; t[k] = (t[k] || 0) + 1; return t }, {})

  for (const maxConcurrent of [2, 1]) {
    it(`30 wrong sign-ins from fresh /64s of one /48 do not turn away a scorer signing in at the same moment (${maxConcurrent} running)`, async () => {
      const auth = makeAuth({ bcrypt: slowBcrypt(40), bcryptMaxConcurrent: maxConcurrent, bcryptMaxQueue: 16 })
      await signIn(auth, 'warm-up@example.ch', 'x', v4()) // builds the dummy hash
      const flood = Array.from({ length: 30 }, (_, i) =>
        signIn(auth, `flood-${maxConcurrent}-${i}@example.ch`, 'x'.repeat(12), `2001:db8:5151:${(i + 1).toString(16)}::9`))
      await sleep(5)
      const legit = await signIn(auth, 'scorer@example.ch', 'scorer-password-1', '2001:db8:9000:1::7')
      const rs = await Promise.all(flood)
      const t = tally(rs)
      assert.equal(legit.status, 200, `the scorer signs in (${JSON.stringify(legit.body.error)}; flood ${JSON.stringify(t)})`)
      assert.ok(legit.body.data.session.access_token)
      assert.ok((t['503:auth_busy'] || 0) > 0, `the flood is shed with 503 auth_busy: ${JSON.stringify(t)}`)
      assert.equal((t['400:invalid_credentials'] || 0) + (t['503:auth_busy'] || 0), 30)
    })
  }

  it('a flood from many /48s at once (a botnet) does not turn away a scorer who signed in from that place before', async () => {
    const auth = makeAuth({ bcrypt: slowBcrypt(40), bcryptMaxConcurrent: 1, bcryptMaxQueue: 8 })
    const home = '2001:db8:7777:1::5'
    assert.equal((await signIn(auth, 'scorer@example.ch', 'scorer-password-1', home)).status, 200)
    const flood = Array.from({ length: 20 }, (_, i) =>
      signIn(auth, `botnet-${i}@example.ch`, 'x'.repeat(12), `2001:db8:${(0x6000 + i).toString(16)}:1::9`))
    await sleep(5)
    const legit = await signIn(auth, 'scorer@example.ch', 'scorer-password-1', home)
    const t = tally(await Promise.all(flood))
    assert.equal(legit.status, 200, `the scorer from a known source goes first (${JSON.stringify(legit.body.error)}; flood ${JSON.stringify(t)})`)
    assert.ok((t['503:auth_busy'] || 0) > 0)
  })

  it('the queue sheds quickly: a waiting sign-in answers 503 auth_busy after bcryptMaxWaitMs, not seconds later', async () => {
    const auth = makeAuth({ bcrypt: slowBcrypt(150), bcryptMaxConcurrent: 1, bcryptMaxQueue: 16, bcryptMaxWaitMs: 200 })
    await signIn(auth, 'warm-up@example.ch', 'x', v4())
    const started = Date.now()
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      signIn(auth, `shed-${i}@example.ch`, 'x'.repeat(12), v4()).then((r) => ({ r, ms: Date.now() - started }))))
    const busy = rs.filter(({ r }) => r.status === 503)
    assert.ok(busy.length >= 5, `most of them are shed (${busy.length})`)
    for (const { r, ms } of busy) {
      assert.equal(r.body.error.code, 'auth_busy')
      assert.ok(Number(r.headers['Retry-After']) > 0)
      assert.ok(ms < 1500, `answered after ${ms} ms`)
    }
    assert.equal(auth.bcryptGate.queued, 0)
  })

  it('an ops alert when sign-ins keep being turned away; once per cooldown', async () => {
    const alerts = []
    const errors = []
    const auth = makeAuth({
      logger: { log() {}, warn() {}, error: (m) => errors.push(m) },
      bcrypt: slowBcrypt(30), bcryptMaxConcurrent: 1, bcryptMaxQueue: 0,
      bcryptSaturatedMs: 150, bcryptAlertCooldownMs: 60_000,
      onGateSaturated: (info) => alerts.push(info)
    })
    await signIn(auth, 'warm-up@example.ch', 'x', v4())
    const until = Date.now() + 400
    while (Date.now() < until) {
      await Promise.all(Array.from({ length: 4 }, (_, i) => signIn(auth, `alert-${i}@example.ch`, 'x'.repeat(12), v4())))
    }
    assert.equal(alerts.length, 1, 'one alert')
    assert.ok(alerts[0].rejected > 0 && alerts[0].seconds >= 0)
    assert.ok(errors.some((m) => /sign-in gate at capacity/.test(m)))
  })

  it('bcryptWorkers: sign-in, sign-up and the dummy hash run in a worker thread', async () => {
    const auth = makeAuth({ bcryptWorkers: 1, bcryptCost: 4 })
    try {
      assert.equal(auth.bcryptGate.maxConcurrent, 1, 'one job per thread')
      assert.equal((await signIn(auth, 'scorer@example.ch', 'scorer-password-1', v4())).status, 200)
      assert.equal((await signIn(auth, 'scorer@example.ch', 'wrong-password', v4())).status, 400)
      assert.equal((await signIn(auth, 'nobody@example.ch', 'wrong-password', v4())).status, 400)
      const su = await auth.handleAuthRequest('sign-up', { email: 'worker-made@example.ch', password: 'worker-password-1' }, { ip: v4() })
      assert.equal(su.status, 200, JSON.stringify(su.body))
      assert.equal((await signIn(auth, 'worker-made@example.ch', 'worker-password-1', v4())).status, 200)
      const s = auth.bcryptStats()
      assert.equal(s.workers, 1)
      assert.equal(s.fallbacks, 0, 'nothing ran on the main thread')
    } finally {
      await auth.close()
    }
  })
})
