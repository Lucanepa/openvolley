/**
 * Tests for lib/auth.js.
 *
 * Unit tests (counters, token helpers, failure handling) always run.
 * The Postgres-backed suite runs only when PG_TEST_URL is set; it creates a
 * throwaway database next to the one in the URL, loads
 * tests/fixtures/synthetic_schema.sql + db/002_app_sessions.sql, and drops it
 * at the end. PG_TEST_URL needs a role that may CREATE DATABASE.
 *
 *   docker run -d --rm --name ov-test-auth -e POSTGRES_PASSWORD=test -p 127.0.0.1:0:5432 postgres:17-alpine
 *   PORT=$(docker port ov-test-auth 5432/tcp | head -1 | cut -d: -f2)
 *   PG_TEST_URL=postgres://postgres:test@127.0.0.1:$PORT/postgres npm test
 *   docker stop ov-test-auth
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import bcryptjs from 'bcryptjs'
import {
  createAuth, createRateLimiter, createLockout, sendAuthResult,
  hashToken, generateToken, isWellFormedToken, AUTH_ACTIONS
} from '../lib/auth.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BACKEND = path.resolve(HERE, '..')
const PG_TEST_URL = process.env.PG_TEST_URL
const silent = { error() {}, warn() {}, log() {} }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// Shape of a pre-migration Supabase JWT (header.payload.signature); not a real token.
const FAKE_SUPABASE_JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ4In0', 'c2ln'].join('.')

// Generated with Python's bcrypt 4.2 (an implementation independent of bcryptjs).
const PY_2B_PASSWORD = 'old-supabase-pw'
const PY_2B_HASH = '$2b$10$K2WRqFYWaZt0EwftvRmNcez7AOgzMxXzcKTTRc80mAIxg1FLEj14.'

function fakeRes() {
  return {
    status: null, headers: null, body: null,
    writeHead(s, h) { this.status = s; this.headers = h },
    end(b) { this.body = b ? JSON.parse(b) : null }
  }
}

// ---------------------------------------------------------------------------
// Unit tests (no database)
// ---------------------------------------------------------------------------

describe('auth counters', () => {
  it('rate limiter counts per key and window', () => {
    let t = 0
    const l = createRateLimiter({ max: 2, windowMs: 1000, now: () => t })
    assert.equal(l.hit('a').limited, false)
    assert.equal(l.hit('a').limited, false)
    const third = l.hit('a')
    assert.equal(third.limited, true)
    assert.equal(third.retryAfterSec, 1)
    assert.equal(l.hit('b').limited, false, 'keys are independent')
    t = 1000
    assert.equal(l.hit('a').limited, false, 'new window')
    t = 5000
    l.sweep()
    assert.equal(l.size, 0)
  })

  it('lockout locks after maxFailures and unlocks after lockMs', () => {
    let t = 0
    const lo = createLockout({ maxFailures: 3, windowMs: 10_000, lockMs: 60_000, now: () => t })
    lo.fail('x'); lo.fail('x')
    assert.equal(lo.check('x').locked, false)
    assert.equal(lo.fail('x').locked, true)
    t = 30_000
    const c = lo.check('x')
    assert.equal(c.locked, true)
    assert.equal(c.retryAfterSec, 30)
    t = 60_000
    assert.equal(lo.check('x').locked, false)
  })

  it('lockout failures outside the window do not add up', () => {
    let t = 0
    const lo = createLockout({ maxFailures: 2, windowMs: 1000, lockMs: 1000, now: () => t })
    lo.fail('x')
    t = 1500
    assert.equal(lo.fail('x').locked, false)
    lo.succeed('x')
    assert.equal(lo.check('x').failures, 0)
  })
})

describe('auth token helpers', () => {
  it('generates 43-char base64url tokens and hashes them with SHA-256', () => {
    const t = generateToken()
    assert.ok(isWellFormedToken(t))
    assert.notEqual(generateToken(), t)
    assert.equal(hashToken(t).length, 32)
    assert.deepEqual(hashToken(t), hashToken(t))
  })

  it('rejects JWT-shaped and junk tokens without a lookup', () => {
    assert.equal(isWellFormedToken(FAKE_SUPABASE_JWT), false)
    assert.equal(isWellFormedToken(''), false)
    assert.equal(isWellFormedToken(null), false)
    assert.equal(isWellFormedToken('a'.repeat(44)), false)
  })

  it('lists the supported actions', () => {
    assert.deepEqual([...AUTH_ACTIONS].sort(), [
      'delete-account', 'get-user', 'profile', 'reset-password',
      'sign-in', 'sign-out', 'sign-up', 'update-user'
    ])
  })
})

describe('auth without a working database', () => {
  const brokenPool = {
    query: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) },
    connect: async () => { throw new Error('connect ECONNREFUSED') }
  }
  const auth = createAuth({ pool: brokenPool, logger: silent })

  it('get-user returns 503 auth_unavailable, never 401', async () => {
    const r = await auth.handleAuthRequest('get-user', { access_token: generateToken() }, { ip: '1.1.1.1' })
    assert.equal(r.status, 503)
    assert.equal(r.body.error.code, 'auth_unavailable')
  })

  it('verifyToken throws and requireUser answers 503', async () => {
    const req = { headers: { authorization: `Bearer ${generateToken()}` } }
    await assert.rejects(() => auth.verifyToken(req))
    const res = fakeRes()
    assert.equal(await auth.requireUser(req, res), null)
    assert.equal(res.status, 503)
  })

  it('malformed tokens are 401 invalid_token without touching the database', async () => {
    const r = await auth.handleAuthRequest('get-user', { access_token: FAKE_SUPABASE_JWT }, { ip: '1.1.1.1' })
    assert.equal(r.status, 401)
    assert.equal(r.body.error.code, 'invalid_token')
    const res = fakeRes()
    await auth.requireUser({ headers: { authorization: `Bearer ${FAKE_SUPABASE_JWT}` } }, res)
    assert.equal(res.status, 401)
    assert.equal(res.body.error.code, 'invalid_token')
  })

  it('missing token is 401 missing_token', async () => {
    const res = fakeRes()
    assert.equal(await auth.requireUser({ headers: {} }, res), null)
    assert.equal(res.status, 401)
    assert.equal(res.body.error.code, 'missing_token')
    assert.equal(await auth.verifyToken({ headers: {} }), null)
  })

  it('update-user is 501 and reset-password is temporarily unavailable', async () => {
    const u = await auth.handleAuthRequest('update-user', { email: 'x@y.ch' }, { ip: '1.1.1.1' })
    assert.equal(u.status, 501)
    assert.match(u.body.error.message, /not available/i)
    const r = await auth.handleAuthRequest('reset-password', { email: 'x@y.ch' }, { ip: '1.1.1.1' })
    assert.equal(r.status, 503)
    assert.match(r.body.error.message, /temporarily unavailable.*Contact info@openvolley\.app/)
    const n = await auth.handleAuthRequest('nope', {}, { ip: '1.1.1.1' })
    assert.equal(n.status, 404)
  })

  it('sendAuthResult writes JSON with no-store and extra headers', () => {
    const res = fakeRes()
    sendAuthResult(res, { status: 429, headers: { 'Retry-After': '9' }, body: { data: null, error: { message: 'x' } } })
    assert.equal(res.status, 429)
    assert.equal(res.headers['Cache-Control'], 'no-store')
    assert.equal(res.headers['Retry-After'], '9')
  })
})

// ---------------------------------------------------------------------------
// Postgres-backed suite
// ---------------------------------------------------------------------------

describe('auth against Postgres', { skip: PG_TEST_URL ? false : 'PG_TEST_URL not set' }, () => {
  let pg, admin, pool, dbUrl
  const dbName = `ov_auth_test_${process.pid}_${Date.now()}`
  let ipSeq = 0
  const nextIp = () => `10.0.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`

  const makeAuth = (opts = {}) => createAuth({ pool, logger: silent, ...opts })

  async function insertUser(email, password, { hashSql = "crypt($3, gen_salt('bf', 10))", meta = {} } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
       VALUES (gen_random_uuid(), $1, ${hashSql}, now(), $2::jsonb)
       RETURNING id, encrypted_password`,
      password === undefined ? [email, JSON.stringify(meta)] : [email, JSON.stringify(meta), password]
    )
    return rows[0]
  }

  async function signIn(auth, email, password, ip = nextIp()) {
    return auth.handleAuthRequest('sign-in', { email, password }, { ip })
  }

  async function sessionRows(userId) {
    const { rows } = await pool.query(
      `SELECT token_hash, extract(epoch FROM expires_at)::bigint AS exp,
              extract(epoch FROM created_at)::bigint AS created
         FROM auth.app_sessions WHERE user_id = $1`, [userId])
    return rows
  }

  before(async () => {
    pg = (await import('pg')).default
    admin = new pg.Client({ connectionString: PG_TEST_URL })
    await admin.connect()
    await admin.query(`CREATE DATABASE ${dbName}`)
    const u = new URL(PG_TEST_URL)
    u.pathname = '/' + dbName
    dbUrl = u.toString()
    pool = new pg.Pool({ connectionString: dbUrl, max: 5 })
    await pool.query(await readFile(path.join(HERE, 'fixtures/synthetic_schema.sql'), 'utf8'))
    const migration = await readFile(path.join(BACKEND, 'db/002_app_sessions.sql'), 'utf8')
    await pool.query(migration)
    await pool.query(migration) // idempotent
  })

  after(async () => {
    await pool?.end()
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
      await admin.end()
    }
  })

  describe('sign-in with migrated Supabase hashes', () => {
    it('accepts a $2a$10$ hash made by another bcrypt implementation (pgcrypto)', async () => {
      const u = await insertUser('Old.User@Example.ch', 'hunter22')
      assert.match(u.encrypted_password, /^\$2a\$10\$/)
      const auth = makeAuth()
      const r = await signIn(auth, '  old.user@EXAMPLE.ch ', 'hunter22')
      assert.equal(r.status, 200, JSON.stringify(r.body))
      const { user, session } = r.body.data
      assert.equal(r.body.error, null)
      assert.equal(user.id, u.id, 'Supabase UUID is kept')
      assert.equal(user.email, 'Old.User@Example.ch')
      assert.equal(user.encrypted_password, undefined)
      assert.ok(user.last_sign_in_at)
      assert.ok(isWellFormedToken(session.access_token))
      assert.equal(session.token_type, 'bearer')
      assert.equal(session.user.id, u.id)
      const now = Date.now() / 1000
      assert.ok(Math.abs(session.expires_at - (now + 30 * 86400)) < 60, 'expires in 30 days (seconds)')
      assert.ok(Math.abs(session.expires_in - 30 * 86400) < 60)

      // Only the SHA-256 is stored.
      const rows = await sessionRows(u.id)
      assert.equal(rows.length, 1)
      assert.deepEqual(rows[0].token_hash, hashToken(session.access_token))
      const raw = await pool.query(
        `SELECT count(*)::int AS n FROM auth.app_sessions WHERE encode(token_hash, 'escape') LIKE '%' || $1 || '%'`,
        [session.access_token])
      assert.equal(raw.rows[0].n, 0)
    })

    it('accepts $2b$ (Python bcrypt) and $2y$ hashes', async () => {
      const b = await insertUser('py2b@example.ch', PY_2B_HASH, { hashSql: '$3' })
      const y = await insertUser('py2y@example.ch', PY_2B_HASH.replace('$2b$', '$2y$'), { hashSql: '$3' })
      const auth = makeAuth()
      assert.equal((await signIn(auth, 'py2b@example.ch', PY_2B_PASSWORD)).status, 200)
      assert.equal((await signIn(auth, 'py2y@example.ch', PY_2B_PASSWORD)).status, 200)
      assert.ok(b.id && y.id)
    })

    it('rejects a wrong password and an unknown email with the same answer', async () => {
      await insertUser('wrongpw@example.ch', 'correct-horse')
      const auth = makeAuth()
      const wrong = await signIn(auth, 'wrongpw@example.ch', 'battery-staple')
      const unknown = await signIn(auth, 'nobody@example.ch', 'battery-staple')
      assert.equal(wrong.status, 400)
      assert.deepEqual(wrong.body, unknown.body)
      assert.deepEqual(wrong.body.error, { message: 'Invalid login credentials', code: 'invalid_credentials' })
      assert.equal(wrong.body.data, null)
    })

    it('rejects users without a password hash', async () => {
      await insertUser('nohash@example.ch', undefined, { hashSql: 'NULL' })
      const r = await signIn(makeAuth(), 'nohash@example.ch', '')
      assert.equal(r.status, 400)
      const r2 = await signIn(makeAuth(), 'nohash@example.ch', 'anything')
      assert.equal(r2.body.error.code, 'invalid_credentials')
    })
  })

  describe('timing-safe comparisons', () => {
    it('runs exactly one same-cost bcrypt comparison whether or not the account exists', async () => {
      await insertUser('timing@example.ch', 'right-password')
      await insertUser('timing-nohash@example.ch', undefined, { hashSql: 'NULL' })
      await insertUser('timing-bad@example.ch', 'not-a-bcrypt-hash', { hashSql: '$3' })
      const calls = []
      const spy = {
        hash: bcryptjs.hash,
        compare: async (pw, h) => { calls.push(h); return bcryptjs.compare(pw, h) }
      }
      const auth = makeAuth({ bcrypt: spy, limits: { signInIp: false, signInEmail: false } })
      await signIn(auth, 'warmup@example.ch', 'x') // builds the dummy hash

      const scenarios = {
        wrongPassword: 'timing@example.ch',
        unknownEmail: 'timing-unknown@example.ch',
        noHash: 'timing-nohash@example.ch',
        malformedHash: 'timing-bad@example.ch'
      }
      const times = {}
      for (const [name, email] of Object.entries(scenarios)) {
        const samples = []
        for (let i = 0; i < 3; i++) {
          calls.length = 0
          const t0 = process.hrtime.bigint()
          const r = await signIn(auth, email, 'wrong-password')
          samples.push(Number(process.hrtime.bigint() - t0) / 1e6)
          assert.equal(r.status, 400)
          assert.equal(calls.length, 1, `${name}: exactly one bcrypt compare`)
          assert.match(calls[0], /^\$2[aby]\$10\$.{53}$/, `${name}: compared against a cost-10 hash`)
        }
        times[name] = samples.sort((a, b) => a - b)[1]
        auth.lockout.clear()
      }
      const vals = Object.values(times)
      const ratio = Math.max(...vals) / Math.min(...vals)
      assert.ok(ratio < 2, `median sign-in times should be close: ${JSON.stringify(times)}`)
    })
  })

  describe('get-user, expiry and sliding sessions', () => {
    it('returns the user and session expiry for a valid token', async () => {
      const u = await insertUser('getuser@example.ch', 'pw123456')
      const auth = makeAuth()
      const { access_token } = (await signIn(auth, 'getuser@example.ch', 'pw123456')).body.data.session
      const r = await auth.handleAuthRequest('get-user', { access_token }, { ip: nextIp() })
      assert.equal(r.status, 200)
      assert.equal(r.body.data.user.id, u.id)
      assert.equal(r.body.data.user.email, 'getuser@example.ch')
      assert.ok(r.body.data.session.expires_at > Date.now() / 1000)
      const viaHeader = await auth.verifyToken({ headers: { authorization: `Bearer ${access_token}` } })
      assert.equal(viaHeader.id, u.id)
    })

    it('gives 401 invalid_token for unknown, old-Supabase and expired tokens', async () => {
      const u = await insertUser('expiry@example.ch', 'pw123456')
      const auth = makeAuth()
      const ip = nextIp()
      for (const token of [generateToken(), FAKE_SUPABASE_JWT]) {
        const r = await auth.handleAuthRequest('get-user', { access_token: token }, { ip })
        assert.equal(r.status, 401)
        assert.equal(r.body.error.code, 'invalid_token')
      }
      const { access_token } = (await signIn(auth, 'expiry@example.ch', 'pw123456')).body.data.session
      await pool.query(`UPDATE auth.app_sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [u.id])
      const r = await auth.handleAuthRequest('get-user', { access_token }, { ip })
      assert.equal(r.status, 401)
      assert.equal(r.body.error.code, 'invalid_token')
      assert.equal((await sessionRows(u.id)).length, 0, 'expired row is removed')
      const missing = await auth.handleAuthRequest('get-user', {}, { ip })
      assert.equal(missing.status, 401)
    })

    it('slides the expiry to 30 days once fewer than 15 days remain', async () => {
      const u = await insertUser('slide@example.ch', 'pw123456')
      const auth = makeAuth()
      const { access_token } = (await signIn(auth, 'slide@example.ch', 'pw123456')).body.data.session
      // 20 days left: no slide
      await pool.query(`UPDATE auth.app_sessions SET expires_at = now() + interval '20 days', created_at = now() - interval '10 days' WHERE user_id = $1`, [u.id])
      const r1 = await auth.handleAuthRequest('get-user', { access_token }, { ip: nextIp() })
      assert.ok(Math.abs(r1.body.data.session.expires_at - (Date.now() / 1000 + 20 * 86400)) < 60)
      // 2 days left: slides to now + 30 days
      await pool.query(`UPDATE auth.app_sessions SET expires_at = now() + interval '2 days' WHERE user_id = $1`, [u.id])
      const r2 = await auth.handleAuthRequest('get-user', { access_token }, { ip: nextIp() })
      assert.equal(r2.status, 200)
      const want = Date.now() / 1000 + 30 * 86400
      assert.ok(Math.abs(r2.body.data.session.expires_at - want) < 60)
      assert.ok(Math.abs((await sessionRows(u.id))[0].exp - want) < 60, 'stored expiry moved too')
    })

    it('never slides past created_at + 90 days and rejects sessions past the cap', async () => {
      const u = await insertUser('cap@example.ch', 'pw123456')
      const auth = makeAuth()
      const { access_token } = (await signIn(auth, 'cap@example.ch', 'pw123456')).body.data.session
      await pool.query(`UPDATE auth.app_sessions SET created_at = now() - interval '85 days', expires_at = now() + interval '1 day' WHERE user_id = $1`, [u.id])
      const r = await auth.handleAuthRequest('get-user', { access_token }, { ip: nextIp() })
      assert.equal(r.status, 200)
      const row = (await sessionRows(u.id))[0]
      assert.equal(Number(row.exp), Number(row.created) + 90 * 86400, 'capped at created_at + 90 days')
      assert.ok(Math.abs(r.body.data.session.expires_at - (Date.now() / 1000 + 5 * 86400)) < 60)

      // A row edited beyond the cap is still refused.
      await pool.query(`UPDATE auth.app_sessions SET created_at = now() - interval '91 days', expires_at = now() + interval '10 days' WHERE user_id = $1`, [u.id])
      const r2 = await auth.handleAuthRequest('get-user', { access_token }, { ip: nextIp() })
      assert.equal(r2.status, 401)
      assert.equal(r2.body.error.code, 'invalid_token')
    })

    it('sweepExpiredSessions deletes expired rows only', async () => {
      const u = await insertUser('sweep@example.ch', 'pw123456')
      const auth = makeAuth()
      await signIn(auth, 'sweep@example.ch', 'pw123456')
      await signIn(auth, 'sweep@example.ch', 'pw123456')
      await pool.query(`UPDATE auth.app_sessions SET expires_at = now() - interval '1 minute'
                         WHERE token_hash = (SELECT token_hash FROM auth.app_sessions WHERE user_id = $1 LIMIT 1)`, [u.id])
      assert.ok(await auth.sweepExpiredSessions() >= 1)
      assert.equal((await sessionRows(u.id)).length, 1)
    })
  })

  describe('revocation', () => {
    it('sign-out deletes the session; signing out again is harmless', async () => {
      const u = await insertUser('signout@example.ch', 'pw123456')
      const auth = makeAuth()
      const { access_token } = (await signIn(auth, 'signout@example.ch', 'pw123456')).body.data.session
      const other = (await signIn(auth, 'signout@example.ch', 'pw123456')).body.data.session.access_token
      const out = await auth.handleAuthRequest('sign-out', { access_token }, { ip: nextIp() })
      assert.equal(out.status, 200)
      assert.deepEqual(out.body, { data: null, error: null })
      const r = await auth.handleAuthRequest('get-user', { access_token }, { ip: nextIp() })
      assert.equal(r.status, 401)
      assert.equal(r.body.error.code, 'invalid_token')
      assert.equal((await auth.handleAuthRequest('get-user', { access_token: other }, { ip: nextIp() })).status, 200,
        'other devices stay signed in')
      assert.equal((await auth.handleAuthRequest('sign-out', { access_token }, { ip: nextIp() })).status, 200)
      // Bearer header works for sign-out as well
      const viaHeader = await auth.handleAuthRequest('sign-out', {}, { ip: nextIp(), headers: { authorization: `Bearer ${other}` } })
      assert.equal(viaHeader.status, 200)
      assert.equal((await sessionRows(u.id)).length, 0)
    })

    it('a password change revokes every session and swaps the password', async () => {
      const u = await insertUser('pwchange@example.ch', 'old-password')
      const auth = makeAuth()
      const t1 = (await signIn(auth, 'pwchange@example.ch', 'old-password')).body.data.session.access_token
      await signIn(auth, 'pwchange@example.ch', 'old-password')
      const r = await auth.setPassword('PWChange@example.ch', 'new-password')
      assert.deepEqual({ ...r }, { userId: u.id, email: 'pwchange@example.ch', revokedSessions: 2 })
      assert.equal((await auth.handleAuthRequest('get-user', { access_token: t1 }, { ip: nextIp() })).status, 401)
      assert.equal((await signIn(auth, 'pwchange@example.ch', 'old-password')).status, 400)
      assert.equal((await signIn(auth, 'pwchange@example.ch', 'new-password')).status, 200)
      const { rows } = await pool.query('SELECT encrypted_password FROM auth.users WHERE id = $1', [u.id])
      assert.match(rows[0].encrypted_password, /^\$2b\$10\$/)
      await assert.rejects(() => auth.setPassword('pwchange@example.ch', '123'), /at least 6/)
      await assert.rejects(() => auth.setPassword('ghost@example.ch', 'whatever1'), /User not found/)
    })

    it('delete-account removes the user, profile, user_matches and sessions', async () => {
      const auth = makeAuth()
      const ip = nextIp()
      const su = await auth.handleAuthRequest('sign-up', { email: 'deleteme@example.ch', password: 'pw123456', metadata: { first_name: 'Del' } }, { ip })
      assert.equal(su.status, 200)
      const id = su.body.data.user.id
      await pool.query(`INSERT INTO public.user_matches (user_id, match_external_id, role) VALUES ($1, 'm1', 'scorer')`, [id])
      const t1 = (await signIn(auth, 'deleteme@example.ch', 'pw123456')).body.data.session.access_token
      await signIn(auth, 'deleteme@example.ch', 'pw123456')
      const bad = await auth.handleAuthRequest('delete-account', { access_token: generateToken() }, { ip })
      assert.equal(bad.status, 401)
      const r = await auth.handleAuthRequest('delete-account', { access_token: t1 }, { ip })
      assert.equal(r.status, 200)
      assert.deepEqual(r.body, { data: null, error: null })
      for (const [sql, label] of [
        ['SELECT count(*)::int AS n FROM auth.users WHERE id = $1', 'user'],
        ['SELECT count(*)::int AS n FROM public.profiles WHERE user_id = $1', 'profile'],
        ['SELECT count(*)::int AS n FROM public.user_matches WHERE user_id = $1', 'user_matches'],
        ['SELECT count(*)::int AS n FROM auth.app_sessions WHERE user_id = $1', 'sessions']
      ]) {
        assert.equal((await pool.query(sql, [id])).rows[0].n, 0, `${label} deleted`)
      }
      assert.equal((await auth.handleAuthRequest('get-user', { access_token: t1 }, { ip })).status, 401)
    })
  })

  describe('lockout and rate-limit buckets', () => {
    it('locks an account for 15 minutes after 10 failures, even with the right password', async () => {
      await insertUser('lockme@example.ch', 'right-password')
      const auth = makeAuth()
      for (let i = 0; i < 10; i++) {
        const r = await signIn(auth, 'lockme@example.ch', `wrong-${i}`)
        assert.equal(r.status, 400)
      }
      const r = await signIn(auth, 'LockMe@example.ch', 'right-password')
      assert.equal(r.status, 429)
      assert.equal(r.body.error.code, 'account_locked')
      const retry = Number(r.headers['Retry-After'])
      assert.ok(retry > 14 * 60 && retry <= 15 * 60, `Retry-After ${retry}`)
      // Unknown accounts lock exactly the same way (no account probing).
      for (let i = 0; i < 10; i++) await signIn(auth, 'ghost-lock@example.ch', 'x')
      assert.equal((await signIn(auth, 'ghost-lock@example.ch', 'x')).body.error.code, 'account_locked')
      // Other accounts are unaffected.
      await insertUser('notlocked@example.ch', 'pw123456')
      assert.equal((await signIn(auth, 'notlocked@example.ch', 'pw123456')).status, 200)
    })

    it('unlocks after the lock period, and a success resets the failure count', async () => {
      await insertUser('unlock@example.ch', 'right-password')
      const auth = makeAuth({ lockout: { maxFailures: 3, windowMs: 60_000, lockMs: 300 } })
      for (let i = 0; i < 2; i++) await signIn(auth, 'unlock@example.ch', 'nope')
      assert.equal((await signIn(auth, 'unlock@example.ch', 'right-password')).status, 200)
      assert.equal(auth.lockout.check('unlock@example.ch').failures, 0)
      for (let i = 0; i < 3; i++) await signIn(auth, 'unlock@example.ch', 'nope')
      assert.equal((await signIn(auth, 'unlock@example.ch', 'right-password')).status, 429)
      await sleep(350)
      assert.equal((await signIn(auth, 'unlock@example.ch', 'right-password')).status, 200)
    })

    it('a password reset by the owner clears the lockout', async () => {
      await insertUser('lockreset@example.ch', 'old-password')
      const auth = makeAuth({ lockout: { maxFailures: 2, windowMs: 60_000, lockMs: 60_000 } })
      await signIn(auth, 'lockreset@example.ch', 'x')
      await signIn(auth, 'lockreset@example.ch', 'x')
      assert.equal((await signIn(auth, 'lockreset@example.ch', 'old-password')).status, 429)
      await auth.setPassword('lockreset@example.ch', 'new-password')
      assert.equal((await signIn(auth, 'lockreset@example.ch', 'new-password')).status, 200)
    })

    it('sign-in, sign-up and session checks use separate per-IP buckets', async () => {
      await insertUser('buckets@example.ch', 'pw123456')
      const auth = makeAuth({ limits: { signInIp: { max: 2, windowMs: 60_000 } } })
      const ip = nextIp()
      const { access_token } = (await signIn(auth, 'buckets@example.ch', 'pw123456', ip)).body.data.session
      await signIn(auth, 'buckets@example.ch', 'pw123456', ip)
      const limited = await signIn(auth, 'buckets@example.ch', 'pw123456', ip)
      assert.equal(limited.status, 429)
      assert.equal(limited.body.error.code, 'rate_limited')
      assert.ok(Number(limited.headers['Retry-After']) > 0)
      // Session checks from the same NAT address keep working.
      assert.equal((await auth.handleAuthRequest('get-user', { access_token }, { ip })).status, 200)
      // Another address can still sign in.
      assert.equal((await signIn(auth, 'buckets@example.ch', 'pw123456', nextIp())).status, 200)
    })

    it('limits sign-up to 5 per hour per IP', async () => {
      const auth = makeAuth()
      const ip = nextIp()
      for (let i = 0; i < 5; i++) {
        const r = await auth.handleAuthRequest('sign-up', { email: `bulk${i}@example.ch`, password: 'pw123456' }, { ip })
        assert.equal(r.status, 200, JSON.stringify(r.body))
      }
      const r = await auth.handleAuthRequest('sign-up', { email: 'bulk5@example.ch', password: 'pw123456' }, { ip })
      assert.equal(r.status, 429)
      const other = await auth.handleAuthRequest('sign-up', { email: 'bulk5@example.ch', password: 'pw123456' }, { ip: nextIp() })
      assert.equal(other.status, 200)
    })

    it('the per-email bucket caps attempts on one address across IPs', async () => {
      await insertUser('emailbucket@example.ch', 'pw123456')
      const auth = makeAuth({ limits: { signInEmail: { max: 3, windowMs: 60_000 } } })
      for (let i = 0; i < 3; i++) assert.equal((await signIn(auth, 'emailbucket@example.ch', 'pw123456')).status, 200)
      const r = await signIn(auth, 'emailbucket@example.ch', 'pw123456')
      assert.equal(r.status, 429)
      assert.equal(r.body.error.code, 'rate_limited')
    })
  })

  describe('sign-up', () => {
    it('creates auth.users + profiles in one go, strips roles, mirrors handle_new_user', async () => {
      const auth = makeAuth()
      const r = await auth.handleAuthRequest('sign-up', {
        email: ' New.Scorer@Example.ch ',
        password: 'pw123456',
        metadata: {
          first_name: 'Ada', last_name: 'Lovelace', dob: '1990-02-03',
          roles: ['admin', 'super_admin'], role: 'service_role', sport_type: 'indoor'
        }
      }, { ip: nextIp() })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.equal(r.body.error, null)
      const { user } = r.body.data
      assert.equal(r.body.data.session, undefined, 'no session: the user signs in afterwards')
      assert.equal(user.email, 'new.scorer@example.ch')
      assert.equal(user.user_metadata.roles, undefined)
      assert.equal(user.user_metadata.role, undefined)
      assert.equal(user.role, 'authenticated')

      const { rows: [dbUser] } = await pool.query('SELECT * FROM auth.users WHERE id = $1', [user.id])
      assert.match(dbUser.encrypted_password, /^\$2b\$10\$/)
      assert.ok(dbUser.email_confirmed_at, 'auto-confirmed')
      assert.equal(dbUser.raw_user_meta_data.roles, undefined)
      assert.equal(dbUser.raw_user_meta_data.first_name, 'Ada')
      assert.deepEqual(dbUser.raw_app_meta_data, { provider: 'email', providers: ['email'] })

      const { rows: [p] } = await pool.query(
        `SELECT first_name, last_name, country, to_char(dob, 'YYYY-MM-DD') AS dob, roles, sport_type::text AS sport_type
           FROM public.profiles WHERE user_id = $1`, [user.id])
      assert.deepEqual({ ...p }, {
        first_name: 'Ada', last_name: 'Lovelace', country: 'CHE', dob: '1990-02-03',
        roles: ['scorer'], sport_type: 'indoor'
      })

      assert.equal((await signIn(auth, 'new.scorer@example.ch', 'pw123456')).status, 200)
    })

    it('rejects duplicates (case-insensitive), weak passwords and bad emails', async () => {
      const auth = makeAuth({ limits: { signUpIp: false } })
      const ip = nextIp()
      assert.equal((await auth.handleAuthRequest('sign-up', { email: 'dupe@example.ch', password: 'pw123456' }, { ip })).status, 200)
      const dupe = await auth.handleAuthRequest('sign-up', { email: 'DUPE@example.ch', password: 'pw123456' }, { ip })
      assert.equal(dupe.status, 422)
      assert.equal(dupe.body.error.code, 'user_already_exists')
      const weak = await auth.handleAuthRequest('sign-up', { email: 'weak@example.ch', password: '12345' }, { ip })
      assert.equal(weak.status, 422)
      assert.equal(weak.body.error.code, 'weak_password')
      const long = await auth.handleAuthRequest('sign-up', { email: 'long@example.ch', password: 'x'.repeat(73) }, { ip })
      assert.equal(long.status, 422)
      const bad = await auth.handleAuthRequest('sign-up', { email: 'not-an-email', password: 'pw123456' }, { ip })
      assert.equal(bad.status, 422)
      assert.equal(bad.body.error.code, 'email_address_invalid')
    })

    it('rolls back the user when the profile insert fails', async () => {
      const auth = makeAuth({ limits: { signUpIp: false } })
      const ip = nextIp()
      const r = await auth.handleAuthRequest('sign-up', {
        email: 'badenum@example.ch', password: 'pw123456', metadata: { sport_type: 'snow' }
      }, { ip })
      assert.equal(r.status, 422)
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM auth.users WHERE email = 'badenum@example.ch'`)
      assert.equal(rows[0].n, 0, 'no half-created account')
      const dob = await auth.handleAuthRequest('sign-up', {
        email: 'baddob@example.ch', password: 'pw123456', metadata: { dob: '31.12.1990' }
      }, { ip })
      assert.equal(dob.status, 422)
    })

    it('profile is read-only: updates (including roles) are ignored', async () => {
      const auth = makeAuth()
      const su = await auth.handleAuthRequest('sign-up', { email: 'profile@example.ch', password: 'pw123456', metadata: { first_name: 'Pat' } }, { ip: nextIp() })
      const { access_token } = (await signIn(auth, 'profile@example.ch', 'pw123456')).body.data.session
      const r = await auth.handleAuthRequest('profile', { access_token, updates: { roles: ['super_admin'], first_name: 'Hax' } }, { ip: nextIp() })
      assert.equal(r.status, 200)
      assert.equal(r.body.data.user_id, su.body.data.user.id)
      assert.equal(r.body.data.first_name, 'Pat')
      assert.deepEqual(r.body.data.roles, ['scorer'])
      const { rows } = await pool.query('SELECT roles FROM public.profiles WHERE user_id = $1', [su.body.data.user.id])
      assert.deepEqual(rows[0].roles, ['scorer'])
      const noTok = await auth.handleAuthRequest('profile', { access_token: generateToken() }, { ip: nextIp() })
      assert.equal(noTok.status, 401)
    })
  })

  describe('requireUser on protected routes', () => {
    it('returns the user for a valid bearer token and 401 invalid_token otherwise', async () => {
      const u = await insertUser('route@example.ch', 'pw123456')
      const auth = makeAuth()
      const { access_token } = (await signIn(auth, 'route@example.ch', 'pw123456')).body.data.session
      const ok = await auth.requireUser({ headers: { authorization: `Bearer ${access_token}` } }, fakeRes())
      assert.equal(ok.id, u.id)
      const res = fakeRes()
      assert.equal(await auth.requireUser({ headers: { authorization: `Bearer ${generateToken()}` } }, res), null)
      assert.equal(res.status, 401)
      assert.equal(res.body.error.code, 'invalid_token')
    })
  })

  describe('least-privilege app role (grants as in roles.sql)', () => {
    const role = `ov_app_test_${process.pid}`
    let appPool

    before(async () => {
      await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD 'test'`)
      await pool.query(`GRANT USAGE ON SCHEMA public, auth TO ${role}`)
      await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`)
      await pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`)
      await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON auth.users, auth.app_sessions TO ${role}`)
      const u = new URL(dbUrl)
      u.username = role
      u.password = 'test'
      appPool = new pg.Pool({ connectionString: u.toString(), max: 3 })
    })

    after(async () => {
      await appPool?.end()
      await pool.query(`DROP OWNED BY ${role}`)
      await pool.query(`DROP ROLE IF EXISTS ${role}`)
    })

    it('signs up, signs in, verifies, signs out and deletes without owner rights', async () => {
      const auth = createAuth({ pool: appPool, logger: silent })
      const ip = nextIp()
      const su = await auth.handleAuthRequest('sign-up', { email: 'approle@example.ch', password: 'pw123456', metadata: { sport_type: 'indoor' } }, { ip })
      assert.equal(su.status, 200, JSON.stringify(su.body))
      const si = await auth.handleAuthRequest('sign-in', { email: 'approle@example.ch', password: 'pw123456' }, { ip })
      assert.equal(si.status, 200, JSON.stringify(si.body))
      const { access_token } = si.body.data.session
      await appPool.query(`UPDATE auth.app_sessions SET expires_at = now() + interval '1 day'`)
      assert.equal((await auth.handleAuthRequest('get-user', { access_token }, { ip })).status, 200)
      assert.equal((await auth.handleAuthRequest('profile', { access_token }, { ip })).status, 200)
      assert.ok(await auth.sweepExpiredSessions() >= 0)
      const del = await auth.handleAuthRequest('delete-account', { access_token }, { ip })
      assert.equal(del.status, 200, JSON.stringify(del.body))
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM auth.users WHERE email = 'approle@example.ch'`)
      assert.equal(rows[0].n, 0)
    })
  })

  describe('scripts/set-password.mjs', () => {
    function runCli(args, stdin) {
      return new Promise((resolve) => {
        const child = spawn(process.execPath, ['scripts/set-password.mjs', ...args], {
          cwd: BACKEND,
          env: { ...process.env, DATABASE_URL: dbUrl },
          stdio: ['pipe', 'pipe', 'pipe']
        })
        let out = ''
        let err = ''
        child.stdout.on('data', d => { out += d })
        child.stderr.on('data', d => { err += d })
        child.on('close', code => resolve({ code, out, err }))
        child.stdin.end(stdin ?? '')
      })
    }

    it('sets the password from stdin and revokes all sessions', async () => {
      const u = await insertUser('cli@example.ch', 'old-password')
      const auth = makeAuth()
      const tok = (await signIn(auth, 'cli@example.ch', 'old-password')).body.data.session.access_token
      const r = await runCli(['CLI@example.ch'], 'brand-new-pw\n')
      assert.equal(r.code, 0, r.err)
      assert.match(r.out, /revoked 1 session/)
      assert.equal((await auth.handleAuthRequest('get-user', { access_token: tok }, { ip: nextIp() })).status, 401)
      assert.equal((await signIn(auth, 'cli@example.ch', 'brand-new-pw')).status, 200)
      assert.equal((await sessionRows(u.id)).length, 1)
    })

    it('--revoke-only signs the user out without changing the password', async () => {
      await insertUser('cli-revoke@example.ch', 'keep-password')
      const auth = makeAuth()
      const tok = (await signIn(auth, 'cli-revoke@example.ch', 'keep-password')).body.data.session.access_token
      const r = await runCli(['cli-revoke@example.ch', '--revoke-only'])
      assert.equal(r.code, 0, r.err)
      assert.equal((await auth.handleAuthRequest('get-user', { access_token: tok }, { ip: nextIp() })).status, 401)
      assert.equal((await signIn(auth, 'cli-revoke@example.ch', 'keep-password')).status, 200)
    })

    it('--generate prints a new password; unknown users and bad usage fail', async () => {
      await insertUser('cli-gen@example.ch', 'old-password')
      const r = await runCli(['cli-gen@example.ch', '--generate'])
      assert.equal(r.code, 0, r.err)
      const pw = /Generated password: (\S+)/.exec(r.out)?.[1]
      assert.equal(pw?.length, 20)
      assert.equal((await signIn(makeAuth(), 'cli-gen@example.ch', pw)).status, 200)
      assert.equal((await runCli(['ghost@example.ch'], 'whatever123\n')).code, 1)
      assert.equal((await runCli([])).code, 2)
      assert.equal((await runCli(['a@b.ch', '--bogus'])).code, 2)
      const short = await runCli(['cli-gen@example.ch'], '123\n')
      assert.equal(short.code, 1)
      assert.match(short.err, /at least 6/)
    })
  })
})
