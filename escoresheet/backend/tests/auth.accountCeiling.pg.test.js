/**
 * Audit 2611 SEC-13: the account-wide ceiling of failed sign-ins lived in
 * memory (gone with a restart), and past it every new source still got three
 * tries: 1020 wrong guesses from 312 /64s of one /48 were never refused, and
 * the right password then signed in (poc/auth-sessions/p03-distributed-guessing.mjs).
 * Now each failure counts in auth.sign_in_failures (db/057): past the ceiling
 * only a source that signed in before goes on as usual, all new sources
 * together get one try per (growing) interval, the account is mailed and the
 * admins told once per window, and a restart forgets nothing.
 *
 * Review of the fix (I-2): the owner's known sources lived in memory only, so
 * after a restart (a deploy) the owner waited with the guessers; and a try
 * taken by a sign-in the bcrypt gate then turned away (auth_busy) was lost.
 * Now the known sources are in auth.sign_in_sources too (keyed HMAC, no
 * address, no IP), the try goes back when the password was not checked, and
 * accountCeiling.slots 'lane' (one try per client lane, for the owner to
 * choose) is there next to the shared try.
 *
 * Needs PG_TEST_URL (tests/helpers/pgTestDb.js).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import pg from 'pg'
import bcryptjs from 'bcryptjs'
import { SKIP_PG, SCHEMA_SQL, PG_TEST_URL, createTestDatabase, applyRolesSql, dropRoles, readonlyRoleOf } from './helpers/pgTestDb.js'
import { createAuth, ipBucketKey } from '../lib/auth.js'

const here = dirname(fileURLToPath(import.meta.url))
const SESSIONS_SQL = readFileSync(join(here, '..', 'db', '002_app_sessions.sql'), 'utf8')
const M057 = readFileSync(join(here, '..', 'db', '057_sign_in_failures.sql'), 'utf8')
const silent = { log() {}, warn() {}, error() {} }
const PW = 'right-password-1'

function memoryMailer() {
  const mails = []
  return { enabled: true, reason: null, managerUrl: 'https://manager.example.test', mails, async send(kind, m) { mails.push({ kind, ...m }); return { sent: true } }, close() {} }
}
const keyOf = (email) => createHash('sha256').update(`ov-sign-in-failures:${email}`, 'utf8').digest()
const SECRET = 'test-pin-secret-'.padEnd(48, 'x')
const bcryptjsHash = (pw, c) => bcryptjs.hash(pw, c)
const bcryptjsCompare = (pw, h) => bcryptjs.compare(pw, h)

describe('the account-wide sign-in ceiling in the database (db/057, SEC-13)', { skip: SKIP_PG }, () => {
  let tdb, pool
  // one /48 of the attacker, a new /64 per source (as the PoC)
  const src = (tag, i) => `2001:db8:${tag.toString(16)}:${i.toString(16)}::1`
  const CEILING = { maxFailures: 20, windowMs: 60 * 60 * 1000, newSourceIntervalMs: 60 * 1000, maxIntervalMs: 60 * 60 * 1000 }
  const makeAuth = (opts = {}) => createAuth({
    pool, logger: silent, bcryptCost: 4, accountCeiling: CEILING, ...opts,
    limits: { signInGlobal: false, ...(opts.limits || {}) }
  })
  const signIn = (auth, email, password, ip) => auth.handleAuthRequest('sign-in', { email, password }, { ip })
  async function addUser(email, { lang = 'de' } = {}) {
    const { rows: [u] } = await pool.query(
      `INSERT INTO auth.users (email, encrypted_password, email_confirmed_at, raw_user_meta_data)
       VALUES ($1, crypt($2, gen_salt('bf', 4)), now(), $3::jsonb) RETURNING id`, [email, PW, JSON.stringify({ mail_lang: lang })])
    return u.id
  }
  const rowOf = async (email) => (await pool.query(
    `SELECT failures, next_try_at, alerted_at, window_start, extract(epoch FROM next_try_at - now())::int AS wait FROM auth.sign_in_failures WHERE email_key = $1`, [keyOf(email)])).rows[0]
  /** Wrong guesses from `sources` new /64s, `per` each. */
  async function guess(auth, email, tag, sources, per) {
    const tally = {}
    for (let i = 0; i < sources; i++) {
      for (let k = 0; k < per; k++) {
        const r = await signIn(auth, email, `guess-${tag}-${i}-${k}`, src(tag, i))
        const t = `${r.status}:${r.body.error?.code}`
        tally[t] = (tally[t] || 0) + 1
      }
    }
    return tally
  }

  // roles.sql's roles of the last test: dropped after the database (they own objects in it)
  const extraRoles = []
  before(async () => {
    tdb = await createTestDatabase('authsignin_ceiling', { schemaSql: SCHEMA_SQL + '\n' + SESSIONS_SQL })
    pool = new pg.Pool({ connectionString: tdb.url, max: 5 })
    pool.on('connect', (c) => c.on('error', () => {}))
    pool.on('error', () => {})
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
  })
  after(async () => {
    await pool?.end()
    await tdb?.drop()
    if (extraRoles.length) {
      const admin = new pg.Client({ connectionString: PG_TEST_URL })
      await admin.connect()
      try { await dropRoles(admin, extraRoles) } finally { await admin.end() }
    }
  })

  it('migration 057 is idempotent and keeps rows on a re-run', async () => {
    await pool.query(`INSERT INTO auth.sign_in_failures (email_key, failures) VALUES ($1, 3) ON CONFLICT DO NOTHING`, [keyOf('mig057@example.ch')])
    await pool.query(`INSERT INTO auth.sign_in_sources (email_key, source_key) VALUES ($1, $1) ON CONFLICT DO NOTHING`, [keyOf('mig057@example.ch')])
    await pool.query(M057)
    await pool.query(M057)
    assert.equal((await rowOf('mig057@example.ch')).failures, 3)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM auth.sign_in_sources WHERE email_key = $1', [keyOf('mig057@example.ch')])).rows[0].n, 1)
    await assert.rejects(pool.query(`INSERT INTO auth.sign_in_failures (email_key) VALUES ('\\x00')`), /sign_in_failures_email_key_check/)
    await assert.rejects(pool.query(`INSERT INTO auth.sign_in_sources (email_key, source_key) VALUES ($1, '\\x00')`, [keyOf('mig057@example.ch')]), /sign_in_sources_source_key_check/)
    await pool.query('DELETE FROM auth.sign_in_sources')
  })

  it('rotating sources stop at the ceiling; the owner\'s known source still gets in; one alert; a restart forgets nothing', async () => {
    const id = await addUser('referee@example.ch')
    const mailer = memoryMailer()
    const alerts = []
    let auth = makeAuth({ mailer, onSignInAttack: (a) => alerts.push(a) })
    const home = '2001:db8:aaaa:1::5'
    assert.equal((await signIn(auth, 'referee@example.ch', PW, home)).status, 200, 'the owner signs in at home')

    // phase 1: 20 wrong guesses from 4 sources (5 each) reach the ceiling
    assert.deepEqual(await guess(auth, 'referee@example.ch', 0x4242, 4, 5), { '400:invalid_credentials': 20 })
    assert.equal((await rowOf('referee@example.ch')).failures, 20)
    await auth.settle()
    assert.equal(alerts.length, 1, 'the admins are told once the ceiling is reached')
    assert.equal(alerts[0].userId, id)
    assert.equal(alerts[0].failures, 20)
    const told = mailer.mails.filter((m) => m.kind === 'sign_in_attempts')
    assert.equal(told.length, 1, 'the account is mailed')
    assert.equal(told[0].to, 'referee@example.ch')
    assert.equal(told[0].lang, 'de', 'in the account\'s language')
    assert.equal(told[0].vars.count, 20)

    // phase 2: 30 new sources, one guess each: one try for all of them, then 429
    const t2 = await guess(auth, 'referee@example.ch', 0x4343, 30, 1)
    assert.equal(t2['400:invalid_credentials'], 1, `one new source gets the try (${JSON.stringify(t2)})`)
    assert.equal(t2['429:account_locked'], 29, 'the others are refused without a password check')
    const locked = await signIn(auth, 'referee@example.ch', PW, src(0x4444, 1))
    assert.equal(locked.status, 429, 'even the right password from a new source waits')
    const retry = Number(locked.headers['Retry-After'])
    assert.ok(retry > 0 && retry <= 60, `Retry-After ${retry}`)
    assert.equal((await signIn(auth, 'referee@example.ch', PW, home)).status, 200, 'a source that signed in before passes the ceiling')

    // a restart: the in-memory counters and known sources are gone, the database is not
    auth = makeAuth({ mailer, onSignInAttack: (a) => alerts.push(a) })
    assert.deepEqual(await guess(auth, 'referee@example.ch', 0x4545, 10, 1), { '429:account_locked': 10 }, 'after a restart new sources are still refused')
    // more failures in the same window tell nobody again
    await pool.query('UPDATE auth.sign_in_failures SET next_try_at = NULL WHERE email_key = $1', [keyOf('referee@example.ch')])
    assert.equal((await signIn(auth, 'referee@example.ch', 'one-more-guess', src(0x4646, 1))).status, 400)
    await auth.settle()
    assert.equal(alerts.length, 1, 'one alert per window')
    assert.equal(mailer.mails.filter((m) => m.kind === 'sign_in_attempts').length, 1)
    assert.equal((await rowOf('referee@example.ch')).failures, 22)
  })

  const sourcesOf = async (email) => (await pool.query('SELECT source_key, last_ok_at FROM auth.sign_in_sources WHERE email_key = $1', [keyOf(email)])).rows

  it('a restart keeps the owner\'s known sources (auth.sign_in_sources): the right password from home still gets in', async () => {
    await addUser('restart@example.ch')
    let auth = makeAuth({ signInSourceSecret: SECRET })
    const home = '198.51.100.7'
    assert.equal((await signIn(auth, 'restart@example.ch', PW, home)).status, 200, 'the owner signs in at home')
    const rows = await sourcesOf('restart@example.ch')
    assert.equal(rows.length, 1, 'the source is written')
    const plain = createHash('sha256').update(`restart@example.ch\u0000${ipBucketKey(home)}`, 'utf8').digest()
    assert.notDeepEqual(rows[0].source_key, plain, 'a keyed HMAC, not a hash anyone can recompute')
    assert.equal(rows[0].source_key.length, 32)
    // the review's restart.mjs: 20 wrong guesses from 4 addresses, then one request takes the try
    for (let i = 0; i < 4; i++) for (let k = 0; k < 5; k++) await signIn(auth, 'restart@example.ch', `x${i}${k}`, `203.0.113.${i + 1}`)
    assert.equal((await signIn(auth, 'restart@example.ch', 'guess', '203.0.113.99')).status, 400, 'the attacker takes the try')
    assert.equal((await signIn(auth, 'restart@example.ch', PW, home)).status, 200)
    auth = makeAuth({ signInSourceSecret: SECRET }) // a deploy
    assert.equal((await signIn(auth, 'restart@example.ch', PW, '203.0.113.100')).status, 429, 'a new source still waits')
    assert.equal((await signIn(auth, 'restart@example.ch', PW, home)).status, 200, 'the owner at home gets in after the restart')
    // without the secret nothing is written (and nothing read)
    await addUser('nosecret@example.ch')
    assert.equal((await signIn(makeAuth(), 'nosecret@example.ch', PW, home)).status, 200)
    assert.deepEqual(await sourcesOf('nosecret@example.ch'), [])
  })

  it('known sources: at most 20 per address, gone with the account and after 60 days', async () => {
    const id = await addUser('many@example.ch')
    const auth = makeAuth({ signInSourceSecret: SECRET })
    for (let i = 0; i < 23; i++) assert.equal((await signIn(auth, 'many@example.ch', PW, `198.51.100.${i + 10}`)).status, 200)
    assert.equal((await sourcesOf('many@example.ch')).length, 20)
    await pool.query(`UPDATE auth.sign_in_sources SET last_ok_at = now() - interval '61 days' WHERE email_key = $1 AND source_key = (SELECT source_key FROM auth.sign_in_sources WHERE email_key = $1 ORDER BY source_key LIMIT 1)`, [keyOf('many@example.ch')])
    await auth.sweepExpiredSessions()
    assert.equal((await sourcesOf('many@example.ch')).length, 19, 'the sweep removes a source not seen for 60 days')
    await auth.eraseAccount(id)
    assert.deepEqual(await sourcesOf('many@example.ch'), [], 'deleting the account deletes them')
  })

  it('a try taken by a sign-in the bcrypt gate turns away (auth_busy) goes back', async () => {
    await addUser('busy@example.ch')
    await addUser('other@example.ch')
    let hold
    const held = new Promise((r) => { hold = r })
    let blockNext = false
    const bcrypt = {
      hash: (pw, c) => bcryptjsHash(pw, c),
      compare: async (pw, h) => { if (blockNext) { blockNext = false; await held } return bcryptjsCompare(pw, h) }
    }
    const auth = makeAuth({ bcrypt, bcryptMaxConcurrent: 1, bcryptMaxQueue: 0 })
    await pool.query(`INSERT INTO auth.sign_in_failures (email_key, window_start, failures) VALUES ($1, now(), 25)`, [keyOf('busy@example.ch')])
    blockNext = true
    const blocker = signIn(auth, 'other@example.ch', PW, '198.51.100.200') // holds the one slot
    await new Promise((r) => setTimeout(r, 20))
    const busy = await signIn(auth, 'busy@example.ch', PW, '203.0.113.50')
    assert.equal(busy.status, 503, JSON.stringify(busy.body))
    assert.equal(busy.body.error.code, 'auth_busy')
    assert.equal((await rowOf('busy@example.ch')).next_try_at, null, 'the try is free again')
    hold()
    assert.equal((await blocker).status, 200)
    assert.equal((await signIn(auth, 'busy@example.ch', PW, '203.0.113.50')).status, 200, 'the retry has the try')
  })

  it('slots "lane": past the ceiling each client lane gets its own try (an attacker holds only its own)', async () => {
    await addUser('lanes@example.ch')
    const auth = makeAuth({ accountCeiling: { ...CEILING, slots: 'lane' } })
    // 20 wrong guesses from 4 /64s of the attacker's /48
    assert.deepEqual(await guess(auth, 'lanes@example.ch', 0xb0b0, 4, 5), { '400:invalid_credentials': 20 })
    assert.equal((await signIn(auth, 'lanes@example.ch', 'guess', src(0xb0b0, 9))).status, 400, 'the attacker\'s lane has one try')
    const again = await signIn(auth, 'lanes@example.ch', 'guess', src(0xb0b0, 10))
    assert.equal(again.status, 429, 'then waits, from any /64 of its /48')
    assert.ok(Number(again.headers['Retry-After']) > 0)
    assert.equal((await signIn(auth, 'lanes@example.ch', PW, '2001:db8:c0c0:1::5')).status, 200, 'the owner on another network has a try of its own')
    assert.equal((await signIn(auth, 'lanes@example.ch', 'guess', '198.51.100.250')).status, 400, 'one per IPv4 address too')
    assert.equal((await signIn(auth, 'lanes@example.ch', 'guess', '198.51.100.250')).status, 429)
  })

  // 2611 review, SIGNIN-CEILING-OWNER-LOCKOUT: past the ceiling the owner's
  // new devices and networks waited with the guessers, and a reset only
  // cleared the count until the guesser started again. A source that opens
  // one of the address's links holds its mailbox: it is a known source now.
  const linkToken = (mail) => /[?&]token=([A-Za-z0-9_-]{43})/.exec(mail?.link || '')?.[1]
  it('a source that opens a reset link passes the ceiling from then on, a restart included', async () => {
    await addUser('mailbox@example.ch')
    const mailer = memoryMailer()
    const auth = makeAuth({ mailer, signInSourceSecret: SECRET })
    const phone = '198.51.100.77' // the owner's phone on a network it never signed in from
    assert.deepEqual(await guess(auth, 'mailbox@example.ch', 0xd0d0, 4, 5), { '400:invalid_credentials': 20 })
    assert.equal((await signIn(auth, 'mailbox@example.ch', 'guess', src(0xd0d0, 9))).status, 400, 'the guesser takes the try')
    assert.equal((await signIn(auth, 'mailbox@example.ch', PW, phone)).status, 429, 'the owner on a new network waits with the guessers')
    // the owner resets the password from the phone
    assert.equal((await auth.handleAuthRequest('reset-password', { email: 'mailbox@example.ch' }, { ip: phone })).status, 200)
    await auth.settle()
    const token = linkToken(mailer.mails.find((m) => m.kind === 'reset' && m.to === 'mailbox@example.ch'))
    assert.ok(token, 'the reset mail carries its link')
    const rs = await auth.handleAuthRequest('reset-password/confirm', { token, password: 'a-new-password-3' }, { ip: phone })
    assert.equal(rs.status, 200, JSON.stringify(rs.body))
    assert.equal((await sourcesOf('mailbox@example.ch')).length, 1, 'the source of the link is written (db/057)')
    // the guesser starts again within minutes
    assert.deepEqual(await guess(auth, 'mailbox@example.ch', 0xd1d1, 4, 5), { '400:invalid_credentials': 20 })
    assert.equal((await signIn(auth, 'mailbox@example.ch', 'guess', src(0xd1d1, 9))).status, 400)
    assert.equal((await signIn(auth, 'mailbox@example.ch', 'a-new-password-3', '198.51.100.78')).status, 429, 'another new source still waits')
    assert.equal((await signIn(auth, 'mailbox@example.ch', 'a-new-password-3', phone)).status, 200, 'the source that opened the link gets in')
    const restarted = makeAuth({ signInSourceSecret: SECRET })
    assert.equal((await signIn(restarted, 'mailbox@example.ch', 'a-new-password-3', phone)).status, 200, 'and after a restart')
  })

  it('a source that opens a confirmation link passes the ceiling too', async () => {
    const mailer = memoryMailer()
    const auth = makeAuth({ mailer, signInSourceSecret: SECRET })
    const su = await auth.handleAuthRequest('sign-up', { email: 'confirm-me@example.ch', password: PW, metadata: { first_name: 'Cora', last_name: 'Confirm' } }, { ip: '198.51.100.90' })
    assert.equal(su.status, 200, JSON.stringify(su.body))
    await auth.settle()
    const token = linkToken(mailer.mails.find((m) => m.kind === 'confirm' && m.to === 'confirm-me@example.ch'))
    assert.ok(token, 'the confirmation mail carries its link')
    assert.deepEqual(await guess(auth, 'confirm-me@example.ch', 0xd2d2, 4, 5), { '400:invalid_credentials': 20 })
    assert.equal((await signIn(auth, 'confirm-me@example.ch', 'guess', src(0xd2d2, 9))).status, 400)
    const laptop = '198.51.100.91'
    const cf = await auth.handleAuthRequest('confirm-email', { token, password: PW }, { ip: laptop })
    assert.equal(cf.status, 200, JSON.stringify(cf.body))
    assert.equal(cf.body.data.confirmed, true)
    assert.equal((await signIn(auth, 'confirm-me@example.ch', PW, '198.51.100.92')).status, 429, 'a new source waits')
    assert.equal((await signIn(auth, 'confirm-me@example.ch', PW, laptop)).status, 200, 'the source that opened the link gets in')
  })

  it('OV_SIGN_IN_CEILING_SLOTS: account (default) or lane, anything else the default with a warning', async () => {
    const { ceilingSlotsFromEnv } = await import('../lib/auth.js')
    assert.deepEqual(ceilingSlotsFromEnv({}), { slots: 'account', warning: null })
    assert.deepEqual(ceilingSlotsFromEnv({ OV_SIGN_IN_CEILING_SLOTS: ' Lane ' }), { slots: 'lane', warning: null })
    assert.deepEqual(ceilingSlotsFromEnv({ OV_SIGN_IN_CEILING_SLOTS: 'account' }), { slots: 'account', warning: null })
    const odd = ceilingSlotsFromEnv({ OV_SIGN_IN_CEILING_SLOTS: 'lanes' })
    assert.equal(odd.slots, 'account')
    assert.match(odd.warning, /OV_SIGN_IN_CEILING_SLOTS is not "account" or "lane"/)
  })

  it('the interval grows with each further ceiling of failures, up to maxIntervalMs', async () => {
    await addUser('grow@example.ch')
    const auth = makeAuth()
    await pool.query(
      `INSERT INTO auth.sign_in_failures (email_key, window_start, failures) VALUES ($1, now(), 45)`, [keyOf('grow@example.ch')])
    assert.equal((await signIn(auth, 'grow@example.ch', 'guess', src(0x5000, 1))).status, 400, 'a free try')
    const r = await rowOf('grow@example.ch')
    assert.ok(r.wait > 100 && r.wait <= 120, `45 failures (one ceiling past the first): 2 min (${r.wait} s)`)
    await pool.query('UPDATE auth.sign_in_failures SET failures = 5000, next_try_at = NULL WHERE email_key = $1', [keyOf('grow@example.ch')])
    assert.equal((await signIn(auth, 'grow@example.ch', 'guess', src(0x5000, 2))).status, 400)
    const capped = await rowOf('grow@example.ch')
    assert.ok(capped.wait > 3500 && capped.wait <= 3600, `capped at 1 h (${capped.wait} s)`)
  })

  it('an unknown address is refused the same way (no account oracle) and tells nobody', async () => {
    const mailer = memoryMailer()
    const alerts = []
    const auth = makeAuth({ mailer, onSignInAttack: (a) => alerts.push(a) })
    assert.deepEqual(await guess(auth, 'nobody-here@example.ch', 0x6060, 4, 5), { '400:invalid_credentials': 20 })
    const t = await guess(auth, 'nobody-here@example.ch', 0x6161, 5, 1)
    assert.deepEqual(t, { '400:invalid_credentials': 1, '429:account_locked': 4 })
    await auth.settle()
    assert.equal(alerts.length, 0)
    assert.equal(mailer.mails.length, 0)
  })

  it('a new password, or the window\'s end, starts from zero; the sweep removes old rows', async () => {
    await addUser('reset-me@example.ch')
    const auth = makeAuth()
    await guess(auth, 'reset-me@example.ch', 0x7070, 4, 5)
    assert.equal((await guess(auth, 'reset-me@example.ch', 0x7171, 3, 1))['429:account_locked'], 2)
    await auth.setPassword('reset-me@example.ch', 'a-new-password-2')
    assert.equal(await rowOf('reset-me@example.ch'), undefined, 'a new password forgets the failures')
    assert.equal((await signIn(auth, 'reset-me@example.ch', 'a-new-password-2', src(0x7272, 1))).status, 200)

    // a failure after the window starts a new one
    await addUser('window@example.ch')
    await pool.query(`INSERT INTO auth.sign_in_failures (email_key, window_start, failures, next_try_at) VALUES ($1, now() - interval '2 hours', 50, now() + interval '1 hour')`, [keyOf('window@example.ch')])
    assert.equal((await signIn(auth, 'window@example.ch', PW, src(0x7373, 1))).status, 200, 'an old window does not count')
    assert.equal((await signIn(auth, 'window@example.ch', 'typo', src(0x7373, 2))).status, 400)
    const fresh = await rowOf('window@example.ch')
    assert.equal(fresh.failures, 1)
    assert.equal(fresh.next_try_at, null)

    await pool.query(`INSERT INTO auth.sign_in_failures (email_key, window_start, failures) VALUES ($1, now() - interval '3 hours', 7)`, [keyOf('old@example.ch')])
    assert.ok(await auth.sweepExpiredSessions() >= 0)
    assert.equal(await rowOf('old@example.ch'), undefined, 'the hourly sweep removes rows past their window')
    assert.ok(await rowOf('window@example.ch'), 'a current row stays')
  })

  it('deleting the account deletes its row', async () => {
    const id = await addUser('gone@example.ch')
    const auth = makeAuth()
    assert.equal((await signIn(auth, 'gone@example.ch', 'typo', src(0x8080, 1))).status, 400)
    assert.ok(await rowOf('gone@example.ch'))
    await auth.eraseAccount(id)
    assert.equal(await rowOf('gone@example.ch'), undefined)
  })

  it('without db/057 (or its grant) sign-in works as before, on the in-memory counters', async () => {
    await addUser('no057@example.ch')
    const auth = makeAuth({ signInFailuresTable: 'auth.no_such_table' })
    assert.equal((await signIn(auth, 'no057@example.ch', 'typo', src(0x9090, 1))).status, 400)
    assert.equal((await signIn(auth, 'no057@example.ch', PW, src(0x9090, 2))).status, 200)
  })

  it('runs as the app role with the grants of roles.sql', async () => {
    const base = `ov_ceil_${process.pid}`
    const roles = [`${base}_app`, `${base}_owner`, readonlyRoleOf(`${base}_app`)]
    extraRoles.push(...roles)
    let appPool
    try {
      const appUrl = applyRolesSql(tdb.url, { appRole: roles[0], ownerRole: roles[1] })
      appPool = new pg.Pool({ connectionString: appUrl, max: 3 })
      appPool.on('error', () => {})
      await addUser('approle@example.ch')
      const logged = []
      const auth = createAuth({ pool: appPool, logger: { log() {}, warn: (m) => logged.push(m), error: (m) => logged.push(m) }, bcryptCost: 4, accountCeiling: CEILING, limits: { signInGlobal: false }, signInSourceSecret: SECRET })
      assert.equal((await signIn(auth, 'approle@example.ch', PW, src(0xa2a2, 1))).status, 200)
      assert.equal((await sourcesOf('approle@example.ch')).length, 1, 'the app role writes its known source')
      for (let i = 0; i < 20; i++) await signIn(auth, 'approle@example.ch', `typo-${i}`, src(0xa0a0, i))
      assert.equal((await signIn(auth, 'approle@example.ch', 'typo', src(0xa1a1, 1))).status, 400)
      assert.equal((await signIn(auth, 'approle@example.ch', PW, src(0xa1a1, 2))).status, 429)
      assert.equal((await rowOf('approle@example.ch')).failures, 21)
      assert.equal((await signIn(createAuth({ pool: appPool, logger: silent, bcryptCost: 4, accountCeiling: CEILING, limits: { signInGlobal: false }, signInSourceSecret: SECRET }), 'approle@example.ch', PW, src(0xa2a2, 1))).status, 200, 'after a restart, as the app role')
      await auth.setPassword('approle@example.ch', 'approle-password-2')
      assert.equal(await rowOf('approle@example.ch'), undefined)
      assert.deepEqual(logged.filter((m) => /db\/057/.test(m)), [], 'no grant missing')
    } finally {
      await appPool?.end()
    }
  })
})
