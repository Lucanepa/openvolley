/**
 * Email links of lib/auth.js against Postgres (db/010_auth_tokens.sql):
 * password reset (request, confirm), email confirmation of new accounts,
 * resend, rate limits, no account enumeration, the sweep, and the behaviour
 * without a mailer. The mailer is an in-memory stand-in here; the real SMTP
 * path is covered by tests/mailer.test.js and tests/emailAuth.e2e.test.js.
 *
 * Needs PG_TEST_URL (tests/helpers/pgTestDb.js).
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { SKIP_PG, SCHEMA_SQL, createTestDatabase } from './helpers/pgTestDb.js'
import { createAuth, hashToken, generateToken, EMAIL_CONFIRMATION_MARK } from '../lib/auth.js'
import { linkToken } from './helpers/fakeSmtp.js'
import { renderMail, createMailer } from '../lib/mailer.js'
import { createAccounts } from '../lib/accounts.js'

const here = dirname(fileURLToPath(import.meta.url))
const SESSIONS_SQL = readFileSync(join(here, '..', 'db', '002_app_sessions.sql'), 'utf8')
const M010 = readFileSync(join(here, '..', 'db', '010_auth_tokens.sql'), 'utf8')
const silent = { log() {}, warn() {}, error() {} }

/** In-memory mailer: records what lib/auth.js asks it to send (rendered like the real one). */
function memoryMailer({ fail = false, hang = false } = {}) {
  const mails = []
  return {
    enabled: true,
    reason: null,
    managerUrl: 'https://manager.example.test',
    mails,
    async send(kind, { to, lang, link }) {
      if (hang) await new Promise(() => {})
      if (fail) throw new Error('SMTP down')
      const r = renderMail(kind, lang, { link })
      mails.push({ kind, to, lang, link, text: r.text, subject: r.subject })
      return { sent: true }
    },
    close() {},
    find(kind, to) { return mails.filter((m) => m.kind === kind && m.to === to).at(-1) || null }
  }
}

describe('email links (db/010) against Postgres', { skip: SKIP_PG }, () => {
  let tdb, pool
  let ipSeq = 0
  const nextIp = () => `198.51.100.${(++ipSeq % 250) + 1}`
  const PW = 'old-password-1'
  const NEW_PW = 'new-password-2'

  const makeAuth = (opts = {}) => createAuth({
    pool, logger: silent, ...opts, limits: { signInGlobal: false, ...(opts.limits || {}) }
  })
  async function addUser(email, { confirmed = true, mark = false } = {}) {
    const app = mark ? { provider: 'email', [EMAIL_CONFIRMATION_MARK.key]: EMAIL_CONFIRMATION_MARK.value } : { provider: 'email' }
    const { rows: [u] } = await pool.query(
      `INSERT INTO auth.users (email, encrypted_password, email_confirmed_at, raw_app_meta_data)
       VALUES ($1, crypt($2, gen_salt('bf', 4)), ${confirmed ? 'now()' : 'NULL'}, $3::jsonb) RETURNING id`,
      [email, PW, JSON.stringify(app)])
    return u.id
  }
  const signIn = (auth, email, password, ip = nextIp()) => auth.handleAuthRequest('sign-in', { email, password }, { ip })
  const tokensOf = async (userId, purpose) => (await pool.query(
    'SELECT hash, purpose, used_at, expires_at, created_at, extract(epoch FROM expires_at - created_at)::int AS ttl FROM auth.app_tokens WHERE user_id = $1 AND purpose = $2 ORDER BY created_at, hash',
    [userId, purpose])).rows
  const sessionsOf = async (userId) => (await pool.query('SELECT count(*)::int n FROM auth.app_sessions WHERE user_id = $1', [userId])).rows[0].n
  const auditOf = async (action, userId) => (await pool.query('SELECT * FROM public.audit_log WHERE action = $1 AND target_user_id = $2', [action, userId])).rows
  async function requestReset(auth, email, { ip = nextIp(), lang, headers = {} } = {}) {
    const r = await auth.handleAuthRequest('reset-password', { email, lang }, { ip, headers })
    await auth.settle()
    return r
  }
  const confirmReset = (auth, token, password = NEW_PW, ip = nextIp()) =>
    auth.handleAuthRequest('reset-password/confirm', { token, password }, { ip })

  before(async () => {
    tdb = await createTestDatabase('emailauth', { schemaSql: SCHEMA_SQL + '\n' + SESSIONS_SQL })
    pool = new pg.Pool({ connectionString: tdb.url, max: 5 })
    pool.on('connect', (c) => c.on('error', () => {}))
    pool.on('error', () => {})
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
  })
  after(async () => {
    await pool?.end()
    await tdb?.drop()
  })

  describe('migration 010', () => {
    it('is idempotent and keeps rows on a re-run', async () => {
      const id = await addUser('mig010@example.ch')
      await pool.query(`INSERT INTO auth.app_tokens (hash, purpose, user_id, expires_at) VALUES ($1, 'reset', $2, now() + interval '1 hour')`, [hashToken(generateToken()), id])
      await pool.query(M010)
      await pool.query(M010)
      assert.equal((await tokensOf(id, 'reset')).length, 1)
    })
    it('enforces 32-byte hashes, the purpose and expiry after creation', async () => {
      const id = await addUser('mig010b@example.ch')
      const bad = [
        ["substring($1::bytea from 1 for 1)", "'reset'", "now() + interval '1 hour'"],
        ['$1', "'login'", "now() + interval '1 hour'"],
        ['$1', "'confirm'", "now() - interval '1 second'"]
      ]
      for (const [h, p, e] of bad) {
        await assert.rejects(() => pool.query(`INSERT INTO auth.app_tokens (hash, purpose, user_id, expires_at) VALUES (${h}, ${p}, $2, ${e})`,
          [hashToken(generateToken()), id]), (err) => err.code === '23514')
      }
    })
    it('goes with the account (FK cascade)', async () => {
      const id = await addUser('mig010c@example.ch')
      await pool.query(`INSERT INTO auth.app_tokens (hash, purpose, user_id, expires_at) VALUES ($1, 'confirm', $2, now() + interval '1 hour')`, [hashToken(generateToken()), id])
      await pool.query('DELETE FROM auth.users WHERE id = $1', [id])
      assert.equal((await pool.query('SELECT count(*)::int n FROM auth.app_tokens WHERE user_id = $1', [id])).rows[0].n, 0)
    })
  })

  describe('without a mailer (SMTP not configured)', () => {
    it('reset-password answers 503 with the contact address, as before', async () => {
      await addUser('nomail@example.ch')
      const auth = makeAuth({ contactEmail: 'owner@example.ch' })
      const r = await requestReset(auth, 'nomail@example.ch')
      assert.equal(r.status, 503)
      assert.equal(r.body.error.code, 'reset_unavailable')
      assert.match(r.body.error.message, /temporarily unavailable.*owner@example\.ch/)
      assert.equal((await pool.query("SELECT count(*)::int n FROM auth.app_tokens t JOIN auth.users u ON u.id = t.user_id WHERE u.email = 'nomail@example.ch'")).rows[0].n, 0)
    })
    it('sign-up confirms the account at once and sends nothing', async () => {
      const auth = makeAuth()
      const r = await auth.handleAuthRequest('sign-up', { email: 'nomail-new@example.ch', password: PW }, { ip: nextIp() })
      assert.equal(r.status, 200)
      assert.ok(r.body.data.user.email_confirmed_at)
      assert.equal(r.body.data.email_confirmation, undefined)
      assert.equal(r.body.data.user.app_metadata[EMAIL_CONFIRMATION_MARK.key], undefined)
    })
    it('resend-confirmation is unavailable', async () => {
      const id = await addUser('nomail-resend@example.ch', { confirmed: false, mark: true })
      const auth = makeAuth()
      const s = await signIn(auth, 'nomail-resend@example.ch', PW)
      assert.equal(s.status, 200)
      const r = await auth.handleAuthRequest('resend-confirmation', { access_token: s.body.data.session.access_token }, { ip: nextIp() })
      assert.equal(r.status, 503)
      assert.equal(r.body.error.code, 'confirm_unavailable')
      assert.equal((await tokensOf(id, 'confirm')).length, 0)
    })
  })

  describe('password reset', () => {
    let mailer, auth
    beforeEach(() => {
      mailer = memoryMailer()
      auth = makeAuth({ mailer })
    })

    it('mails a one-time link, stores only its SHA-256, 60 minutes', async () => {
      const id = await addUser('reset1@example.ch')
      const r = await requestReset(auth, 'Reset1@Example.ch', { lang: 'de-CH' })
      assert.equal(r.status, 200)
      assert.deepEqual(r.body, { data: { requested: true }, error: null })
      const mail = mailer.find('reset', 'reset1@example.ch')
      assert.ok(mail, 'mail sent')
      assert.equal(mail.lang, 'de')
      const { token, page, lang, url } = linkToken(mail)
      assert.equal(page, 'reset')
      assert.equal(lang, 'de')
      assert.ok(url.startsWith('https://manager.example.test/#reset?token='))
      const rows = await tokensOf(id, 'reset')
      assert.equal(rows.length, 1)
      assert.deepEqual(rows[0].hash, hashToken(token))
      assert.equal(rows[0].ttl, 3600)
      const raw = (await pool.query("SELECT count(*)::int n FROM auth.app_tokens WHERE encode(hash, 'escape') LIKE '%' || $1 || '%'", [token.slice(0, 20)])).rows[0].n
      assert.equal(raw, 0, 'the token itself is not stored')
      assert.equal((await auditOf('account.password_reset_requested', id)).length, 1)
    })

    it('answers unknown, existing and blocked addresses identically and mails only the existing one', async () => {
      await addUser('exists@example.ch')
      const blocked = await addUser('blocked@example.ch')
      await pool.query('ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz')
      auth.refreshCatalog()
      try {
        await pool.query("UPDATE auth.users SET banned_until = now() + interval '1 day' WHERE id = $1", [blocked])
        const answers = []
        for (const email of ['exists@example.ch', 'nobody@example.ch', 'blocked@example.ch']) {
          const r = await requestReset(auth, email)
          answers.push({ status: r.status, headers: r.headers, body: r.body })
        }
        assert.deepEqual(answers[1], answers[0])
        assert.deepEqual(answers[2], answers[0])
        assert.deepEqual(mailer.mails.map((m) => m.to), ['exists@example.ch'])
      } finally {
        await pool.query('ALTER TABLE auth.users DROP COLUMN IF EXISTS banned_until')
        auth.refreshCatalog()
      }
    })

    it('answers before the mail goes out (a slow or hanging SMTP server changes nothing)', async () => {
      await addUser('slow@example.ch')
      const hanging = makeAuth({ mailer: memoryMailer({ hang: true }) })
      const t0 = Date.now()
      const r = await hanging.handleAuthRequest('reset-password', { email: 'slow@example.ch' }, { ip: nextIp() })
      assert.equal(r.status, 200)
      assert.ok(Date.now() - t0 < 2000)
      const failing = makeAuth({ mailer: memoryMailer({ fail: true }) })
      const r2 = await requestReset(failing, 'slow@example.ch')
      assert.deepEqual(r2.body, r.body, 'a failed send is logged, not reported')
    })

    it('sets the password once: sessions revoked, address confirmed, link spent, notice mailed', async () => {
      const id = await addUser('reset2@example.ch', { confirmed: false })
      // a session made by an older sign-in (the account was confirmed then)
      await pool.query('UPDATE auth.users SET email_confirmed_at = now() WHERE id = $1', [id])
      const s = await signIn(auth, 'reset2@example.ch', PW)
      assert.equal(s.status, 200)
      await pool.query('UPDATE auth.users SET email_confirmed_at = NULL WHERE id = $1', [id])
      assert.equal(await sessionsOf(id), 1)

      await requestReset(auth, 'reset2@example.ch', { lang: 'it' })
      const { token } = linkToken(mailer.find('reset', 'reset2@example.ch'))
      const r = await confirmReset(auth, token)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.deepEqual(r.body, { data: { password_updated: true }, error: null })
      await auth.settle()
      assert.equal(await sessionsOf(id), 0, 'every session revoked')
      const old = await auth.handleAuthRequest('get-user', { access_token: s.body.data.session.access_token }, { ip: nextIp() })
      assert.equal(old.status, 401)
      const { rows: [u] } = await pool.query('SELECT email_confirmed_at FROM auth.users WHERE id = $1', [id])
      assert.ok(u.email_confirmed_at, 'the link proves the address')
      assert.equal((await signIn(auth, 'reset2@example.ch', PW)).status, 400)
      assert.equal((await signIn(auth, 'reset2@example.ch', NEW_PW)).status, 200)
      const notice = mailer.find('password_changed', 'reset2@example.ch')
      assert.ok(notice)
      assert.equal(linkToken(notice), null, 'the notice has no link')
      assert.equal((await auditOf('account.password_reset', id)).length, 1)

      const again = await confirmReset(auth, token, 'third-password-3')
      assert.equal(again.status, 400)
      assert.equal(again.body.error.code, 'invalid_link')
      assert.equal((await signIn(auth, 'reset2@example.ch', NEW_PW)).status, 200, 'the second use changed nothing')
    })

    it('refuses expired, unknown and malformed links, and links of another purpose', async () => {
      const id = await addUser('reset3@example.ch')
      await requestReset(auth, 'reset3@example.ch')
      const { token } = linkToken(mailer.find('reset', 'reset3@example.ch'))
      await pool.query("UPDATE auth.app_tokens SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' WHERE user_id = $1", [id])
      for (const t of [token, generateToken(), 'short', 'x'.repeat(43) + '=', null]) {
        const r = await confirmReset(auth, t)
        assert.equal(r.status, 400, String(t))
        assert.equal(r.body.error.code, 'invalid_link')
      }
      const s = await signIn(auth, 'reset3@example.ch', PW)
      assert.equal(s.status, 200, 'password unchanged')
      // a confirmation link is no reset link
      const sid = await addUser('reset3b@example.ch', { confirmed: false, mark: true })
      const s2 = await signIn(auth, 'reset3b@example.ch', PW)
      await auth.handleAuthRequest('resend-confirmation', { access_token: s2.body.data.session.access_token }, { ip: nextIp() })
      const ct = linkToken(mailer.find('confirm', 'reset3b@example.ch')).token
      assert.equal((await confirmReset(auth, ct)).body.error.code, 'invalid_link')
      assert.equal((await tokensOf(sid, 'confirm')).filter((t) => !t.used_at).length, 1, 'still unused')
    })

    it('a new request spends the older link; a password change spends every open link', async () => {
      const id = await addUser('reset4@example.ch')
      await requestReset(auth, 'reset4@example.ch')
      const first = linkToken(mailer.find('reset', 'reset4@example.ch')).token
      await requestReset(auth, 'reset4@example.ch')
      const second = linkToken(mailer.find('reset', 'reset4@example.ch')).token
      assert.notEqual(first, second)
      assert.equal((await confirmReset(auth, first)).body.error.code, 'invalid_link', 'older link spent')
      await requestReset(auth, 'reset4@example.ch')
      const third = linkToken(mailer.find('reset', 'reset4@example.ch')).token
      await auth.setPassword('reset4@example.ch', 'admin-set-pw-9')
      assert.equal((await confirmReset(auth, third)).body.error.code, 'invalid_link', 'spent by the password change')
      assert.equal((await tokensOf(id, 'reset')).filter((t) => !t.used_at).length, 0)
    })

    it('checks the password policy before spending the link', async () => {
      await addUser('reset5@example.ch')
      await requestReset(auth, 'reset5@example.ch')
      const { token } = linkToken(mailer.find('reset', 'reset5@example.ch'))
      for (const pw of ['123', 'x'.repeat(73), null, 12345678]) {
        const r = await confirmReset(auth, token, pw)
        assert.equal(r.status, 422)
        assert.equal(r.body.error.code, 'weak_password')
      }
      assert.equal((await confirmReset(auth, token)).status, 200, 'the link still works')
    })

    it('two concurrent uses of one link: exactly one wins', async () => {
      await addUser('reset6@example.ch')
      await requestReset(auth, 'reset6@example.ch')
      const { token } = linkToken(mailer.find('reset', 'reset6@example.ch'))
      const rs = await Promise.all([confirmReset(auth, token, 'parallel-pw-1'), confirmReset(auth, token, 'parallel-pw-2')])
      assert.deepEqual(rs.map((r) => r.status).sort(), [200, 400])
    })

    it('a reset link confirms and unlocks an old unconfirmed account', async () => {
      await addUser('legacy-unconfirmed@example.ch', { confirmed: false })
      assert.equal((await signIn(auth, 'legacy-unconfirmed@example.ch', PW)).status, 400, 'refused as before')
      await requestReset(auth, 'legacy-unconfirmed@example.ch')
      const { token } = linkToken(mailer.find('reset', 'legacy-unconfirmed@example.ch'))
      assert.equal((await confirmReset(auth, token)).status, 200)
      assert.equal((await signIn(auth, 'legacy-unconfirmed@example.ch', NEW_PW)).status, 200)
    })

    it('rate limits: 3 per address (plus-tags count as the address), 10 per client, existing or not', async () => {
      await addUser('limited@example.ch')
      for (const email of ['limited@example.ch', 'nobody-limited@example.ch']) {
        const tagged = email.replace('@', '+x@')
        const codes = []
        for (const e of [email, tagged, email, tagged]) codes.push((await requestReset(auth, e)).status)
        assert.deepEqual(codes, [200, 200, 200, 429], email)
      }
      const ip = nextIp()
      const codes = []
      for (let i = 0; i < 11; i++) codes.push((await requestReset(auth, `ip-${i}@example.ch`, { ip })).status)
      assert.deepEqual(codes, [...Array(10).fill(200), 429])
      const r = await requestReset(auth, 'ip-x@example.ch', { ip })
      assert.ok(Number(r.headers['Retry-After']) > 0)
      const ipTok = nextIp()
      const tcodes = []
      for (let i = 0; i < 31; i++) tcodes.push((await confirmReset(auth, generateToken(), NEW_PW, ipTok)).status)
      assert.equal(tcodes.at(-1), 429, 'redeeming is limited per client too')
    })

    it('rejects an invalid address without touching the limits of real ones', async () => {
      const r = await requestReset(auth, 'not-an-address')
      assert.equal(r.status, 422)
      assert.equal(r.body.error.code, 'email_address_invalid')
    })

    it('answers 503 when db/010 is missing', async () => {
      const noTable = makeAuth({ mailer, tokensTable: 'auth.no_such_tokens' })
      const r = await requestReset(noTable, 'exists@example.ch')
      assert.equal(r.status, 503)
      assert.equal(r.body.error.code, 'reset_unavailable')
      assert.equal((await confirmReset(noTable, generateToken())).status, 503)
    })
  })

  describe('email confirmation of new accounts', () => {
    let mailer, auth
    beforeEach(() => {
      mailer = memoryMailer()
      auth = makeAuth({ mailer })
    })

    it('sign-up leaves the address unconfirmed, marks the account and mails a 24 h link', async () => {
      const r = await auth.handleAuthRequest('sign-up', { email: 'New1@example.ch', password: PW, lang: 'fr', metadata: { first_name: 'Nina' } }, { ip: nextIp() })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.equal(r.body.data.email_confirmation, 'sent')
      const user = r.body.data.user
      assert.equal(user.email_confirmed_at, null)
      assert.equal(user.app_metadata[EMAIL_CONFIRMATION_MARK.key], EMAIL_CONFIRMATION_MARK.value)
      await auth.settle()
      const mail = mailer.find('confirm', 'new1@example.ch')
      assert.equal(mail.lang, 'fr')
      const { token, page } = linkToken(mail)
      assert.equal(page, 'confirm')
      const rows = await tokensOf(user.id, 'confirm')
      assert.equal(rows.length, 1)
      assert.equal(rows[0].ttl, 24 * 3600)
      assert.deepEqual(rows[0].hash, hashToken(token))
    })

    it('the new account signs in while unconfirmed; the link confirms it once', async () => {
      await auth.handleAuthRequest('sign-up', { email: 'new2@example.ch', password: PW }, { ip: nextIp(), headers: { 'accept-language': 'it-CH,it;q=0.9' } })
      await auth.settle()
      const mail = mailer.find('confirm', 'new2@example.ch')
      assert.equal(mail.lang, 'it', 'Accept-Language when no lang is sent')
      const s = await signIn(auth, 'new2@example.ch', PW)
      assert.equal(s.status, 200, 'not blocked: approval gates official scoring')
      assert.equal(s.body.data.user.email_confirmed_at, null)
      const { token } = linkToken(mail)
      const c = await auth.handleAuthRequest('confirm-email', { token }, { ip: nextIp() })
      assert.deepEqual(c.body, { data: { confirmed: true, already_confirmed: false }, error: null })
      const g = await auth.handleAuthRequest('get-user', { access_token: s.body.data.session.access_token }, { ip: nextIp() })
      assert.ok(g.body.data.user.email_confirmed_at)
      assert.equal((await auditOf('account.email_confirmed', g.body.data.user.id)).length, 1)
      const again = await auth.handleAuthRequest('confirm-email', { token }, { ip: nextIp() })
      assert.deepEqual(again.body.data, { confirmed: true, already_confirmed: true }, 'a second click is not an error')
      assert.equal((await auditOf('account.email_confirmed', g.body.data.user.id)).length, 1)
    })

    it('refuses unknown, malformed and expired confirmation links', async () => {
      await auth.handleAuthRequest('sign-up', { email: 'new3@example.ch', password: PW }, { ip: nextIp() })
      await auth.settle()
      const { token } = linkToken(mailer.find('confirm', 'new3@example.ch'))
      for (const t of [generateToken(), 'nope', undefined]) {
        const r = await auth.handleAuthRequest('confirm-email', { token: t }, { ip: nextIp() })
        assert.equal(r.status, 400)
        assert.equal(r.body.error.code, 'invalid_link')
      }
      await pool.query("UPDATE auth.app_tokens SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE hash = $1", [hashToken(token)])
      const r = await auth.handleAuthRequest('confirm-email', { token }, { ip: nextIp() })
      assert.equal(r.body.error.code, 'invalid_link')
      const { rows: [u] } = await pool.query("SELECT email_confirmed_at FROM auth.users WHERE email = 'new3@example.ch'")
      assert.equal(u.email_confirmed_at, null)
    })

    it('resend: signed in only, a fresh link replaces the old one, 3 per hour, nothing for confirmed accounts', async () => {
      await auth.handleAuthRequest('sign-up', { email: 'new4@example.ch', password: PW }, { ip: nextIp() })
      await auth.settle()
      const first = linkToken(mailer.find('confirm', 'new4@example.ch')).token
      const noSession = await auth.handleAuthRequest('resend-confirmation', {}, { ip: nextIp() })
      assert.equal(noSession.status, 401)
      const s = await signIn(auth, 'new4@example.ch', PW)
      const access_token = s.body.data.session.access_token
      const codes = []
      for (let i = 0; i < 4; i++) codes.push((await auth.handleAuthRequest('resend-confirmation', { access_token, lang: 'de' }, { ip: nextIp() })).status)
      assert.deepEqual(codes, [200, 200, 200, 429])
      const mails = mailer.mails.filter((m) => m.kind === 'confirm' && m.to === 'new4@example.ch')
      assert.equal(mails.length, 4)
      assert.equal(mails.at(-1).lang, 'de')
      const last = linkToken(mails.at(-1)).token
      assert.equal((await auth.handleAuthRequest('confirm-email', { token: first }, { ip: nextIp() })).body.error.code, 'invalid_link', 'replaced')
      assert.equal((await auth.handleAuthRequest('confirm-email', { token: last }, { ip: nextIp() })).status, 200)
      const done = await auth.handleAuthRequest('resend-confirmation', { access_token }, { ip: nextIp() })
      assert.deepEqual(done.body.data, { sent: false, already_confirmed: true })
    })

    it('resend reports a failed send', async () => {
      await addUser('new5@example.ch', { confirmed: false, mark: true })
      const failing = makeAuth({ mailer: memoryMailer({ fail: true }) })
      const s = await signIn(failing, 'new5@example.ch', PW)
      const r = await failing.handleAuthRequest('resend-confirmation', { access_token: s.body.data.session.access_token }, { ip: nextIp() })
      assert.equal(r.status, 503)
      assert.equal(r.body.error.code, 'confirm_unavailable')
    })

    it('a sign-up whose mail fails still creates the account (resend later)', async () => {
      const failing = makeAuth({ mailer: memoryMailer({ fail: true }) })
      const r = await failing.handleAuthRequest('sign-up', { email: 'new6@example.ch', password: PW }, { ip: nextIp() })
      assert.equal(r.status, 200)
      await failing.settle()
      assert.equal((await signIn(failing, 'new6@example.ch', PW)).status, 200)
    })

    it('existing accounts stay as they are: confirmed ones sign in, old unconfirmed ones stay refused', async () => {
      await addUser('old-confirmed@example.ch')
      await addUser('old-unconfirmed@example.ch', { confirmed: false })
      assert.equal((await signIn(auth, 'old-confirmed@example.ch', PW)).status, 200)
      assert.equal((await signIn(auth, 'old-unconfirmed@example.ch', PW)).status, 400)
    })
  })

  describe('review fixes: mail budgets, inboxes, role grants, log masking', () => {
    // The real mailer (budgets, per-inbox cap) over a stub transport.
    function stubbedMailer(opts = {}) {
      const sent = []
      const warnings = []
      const mailer = createMailer({
        transport: { async sendMail(m) { sent.push(m) }, close() {} },
        from: 'OpenVolley <noreply@example.test>',
        managerUrl: 'https://manager.example.test',
        logger: { ...silent, warn: (w) => warnings.push(w) },
        ...opts
      })
      return { mailer, sent, warnings }
    }
    // A /64 per request, like a spread-out attacker (signUpIp is per /64).
    let net = 0
    const nextV6 = () => `2001:db8:${(++net).toString(16)}::1`

    it('Gmail dot variants of one inbox share the per-address sign-up bucket', async () => {
      const { mailer, sent } = stubbedMailer()
      const auth = makeAuth({ mailer })
      const variants = ['victimname@gmail.com', 'victim.name@gmail.com', 'v.ictimname@googlemail.com', 'vi.ctim.name@gmail.com', 'Victim.Name+x@gmail.com']
      const codes = []
      for (const email of variants) codes.push((await auth.handleAuthRequest('sign-up', { email, password: PW }, { ip: nextV6() })).status)
      await auth.settle()
      assert.deepEqual(codes, [200, 200, 200, 429, 429])
      assert.equal(sent.length, 3, 'at most 3 confirmation mails reach the inbox through sign-up')
    })

    it('Gmail dot variants share the per-address reset bucket', async () => {
      await addUser('resetvictim@gmail.com')
      const { mailer, sent } = stubbedMailer()
      const auth = makeAuth({ mailer })
      const codes = []
      for (const email of ['resetvictim@gmail.com', 'reset.victim@gmail.com', 'r.esetvictim@googlemail.com', 'rese.tvictim@gmail.com']) {
        codes.push((await requestReset(auth, email, { ip: nextV6() })).status)
      }
      assert.deepEqual(codes, [200, 200, 200, 429])
      assert.equal(sent.length, 1, 'only the registered spelling has an account')
    })

    it('sign-ups that use up the confirmation budget leave password reset working, and /health can see it', async () => {
      await addUser('real-user@example.ch')
      const { mailer, sent, warnings } = stubbedMailer({ budgets: { account: 5, confirm: 3 } })
      const auth = makeAuth({ mailer })
      for (let i = 0; i < 6; i++) {
        const r = await auth.handleAuthRequest('sign-up', { email: `drain${i}@example.ch`, password: PW }, { ip: nextV6() })
        assert.equal(r.status, 200)
      }
      await auth.settle()
      assert.equal(sent.filter((m) => /Confirm/.test(m.subject)).length, 3)
      assert.deepEqual(mailer.stats().exhausted, ['confirm'])
      assert.equal(mailer.stats().budgets.confirm.dropped, 3)
      assert.ok(warnings.some((w) => /confirm budget/.test(w)))

      const r = await requestReset(auth, 'real-user@example.ch', { ip: nextV6() })
      assert.equal(r.status, 200)
      const reset = sent.find((m) => m.to === 'real-user@example.ch')
      assert.ok(reset, 'the reset mail went out')
      assert.match(reset.subject, /Reset your OpenVolley password/)
    })

    it('an unconfirmed account (signed up with a link) cannot redeem an invite or be given a role until it confirms', async () => {
      const { mailer, sent } = stubbedMailer()
      const auth = makeAuth({ mailer })
      const accounts = createAccounts({ pool, logger: silent })
      const { rows: [adminRow] } = await pool.query("INSERT INTO auth.users (email, email_confirmed_at) VALUES ('roles-admin@example.ch', now()) RETURNING id")
      const inv = await accounts.createInvite({ actorId: adminRow.id, body: { label: 'Club', role: 'scorer', max_uses: 1 } })
      assert.equal(inv.status, 201, JSON.stringify(inv.body))

      const up = await auth.handleAuthRequest('sign-up', { email: 'someone.else@club.example', password: PW }, { ip: nextV6() })
      assert.equal(up.status, 200)
      await auth.settle()
      const userId = up.body.data.user.id
      const s = await signIn(auth, 'someone.else@club.example', PW)
      assert.equal(s.status, 200, 'may still sign in')
      assert.equal(s.body.data.user.email_confirmed_at, null)

      const redeem = await accounts.redeemInvite({ userId, code: inv.body.data.code })
      assert.equal(redeem.status, 409)
      assert.equal(redeem.body.error.code, 'OV_EMAIL_UNCONFIRMED')
      const { rows: [code] } = await pool.query('SELECT uses FROM public.invite_codes WHERE id = $1', [inv.body.data.invite.id])
      assert.equal(code.uses, 0, 'the code is not used up')
      const { rows: [p] } = await pool.query('SELECT roles FROM public.profiles WHERE user_id = $1', [userId])
      assert.deepEqual(p?.roles ?? [], [])

      const adminActor = { id: adminRow.id, access: { isSuperAdmin: false } }
      const grant = await accounts.setRoles({ actor: adminActor, userId, body: { add: ['scorer'] } })
      assert.equal(grant.status, 409)
      assert.equal(grant.body.error.code, 'OV_EMAIL_UNCONFIRMED')
      assert.equal((await accounts.setRoles({ actor: adminActor, userId, body: { remove: ['scorer'] } })).status, 200, 'removing stays possible')

      const { token } = linkToken(sent.find((m) => m.to === 'someone.else@club.example'))
      assert.equal((await auth.handleAuthRequest('confirm-email', { token }, { ip: nextV6() })).status, 200)
      const ok = await accounts.redeemInvite({ userId, code: inv.body.data.code })
      assert.equal(ok.status, 200, JSON.stringify(ok.body))
      assert.deepEqual(ok.body.data.roles, ['scorer'])
    })

    it('accounts confirmed at sign-up (no mailer) and legacy accounts redeem as before', async () => {
      const auth = makeAuth()
      const accounts = createAccounts({ pool, logger: silent })
      const up = await auth.handleAuthRequest('sign-up', { email: 'nomail-roles@example.ch', password: PW }, { ip: nextV6() })
      const legacy = await addUser('legacy-roles@example.ch', { confirmed: false })
      const inv = await accounts.createInvite({ actorId: null, body: { label: 'Club 2', role: 'referee', max_uses: 5 } })
      for (const userId of [up.body.data.user.id, legacy]) {
        const r = await accounts.redeemInvite({ userId, code: inv.body.data.code })
        assert.equal(r.status, 200, JSON.stringify(r.body))
      }
    })

    it('a failed send is logged without the recipient address', async () => {
      const errors = []
      const smtpError = Object.assign(new Error("Can't send mail - all recipients were rejected: 550 5.1.1 <masked.victim@club.example>: Recipient address rejected"), { code: 'EENVELOPE', responseCode: 550 })
      const mailer = { enabled: true, managerUrl: 'https://manager.example.test', async send() { throw smtpError }, close() {} }
      const auth = makeAuth({ mailer, logger: { ...silent, error: (...a) => errors.push(a.join(' ')) } })
      await addUser('masked.victim@club.example')
      assert.equal((await requestReset(auth, 'masked.victim@club.example', { ip: nextV6() })).status, 200)
      const up = await auth.handleAuthRequest('sign-up', { email: 'masked.newbie@club.example', password: PW }, { ip: nextV6() })
      assert.equal(up.status, 200)
      await auth.settle()
      const s = await signIn(auth, 'masked.newbie@club.example', PW)
      const resend = await auth.handleAuthRequest('resend-confirmation', { access_token: s.body.data.session.access_token }, { ip: nextV6() })
      assert.equal(resend.status, 503)
      assert.equal(errors.length, 3, errors.join('\n'))
      for (const line of errors) {
        assert.equal(line.includes('masked.victim@'), false, line)
        assert.match(line, /EENVELOPE SMTP 550 .*ma\*\*\*@club\.example/)
      }
    })
  })

  describe('sweep and least privilege', () => {
    it('sweeps links a week after they were used or expired', async () => {
      const auth = makeAuth({ mailer: memoryMailer() })
      const id = await addUser('sweep@example.ch')
      const ins = (purpose, created, expires, used) => pool.query(
        `INSERT INTO auth.app_tokens (hash, purpose, user_id, created_at, expires_at, used_at) VALUES ($1, $2, $3, now() - $4::interval, now() - $5::interval, ${used ? 'now() - $6::interval' : 'NULL'})`,
        used ? [hashToken(generateToken()), purpose, id, created, expires, used] : [hashToken(generateToken()), purpose, id, created, expires])
      await ins('reset', '9 days', '8 days', null) // expired 8 days ago: goes
      await ins('reset', '9 days', '-1 hour', '8 days') // used 8 days ago: goes
      await ins('confirm', '3 days', '2 days', null) // expired 2 days ago: stays
      await ins('confirm', '1 hour', '-23 hours', null) // open: stays
      assert.equal(await auth.sweepExpiredTokens(), 2)
      assert.equal((await pool.query('SELECT count(*)::int n FROM auth.app_tokens WHERE user_id = $1', [id])).rows[0].n, 2)
    })

    it('runs the whole flow as an app role with the grants of roles.sql', async () => {
      const role = `ov_app_email_${process.pid}`
      await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD 'test'`)
      let appPool
      try {
        await pool.query(`GRANT USAGE ON SCHEMA public, auth TO ${role}`)
        await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`)
        await pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`)
        await pool.query(`GRANT SELECT, INSERT, DELETE ON auth.users TO ${role}`)
        await pool.query(`GRANT UPDATE (encrypted_password, updated_at, email_confirmed_at, last_sign_in_at) ON auth.users TO ${role}`)
        await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON auth.app_sessions, auth.app_tokens TO ${role}`)
        const u = new URL(tdb.url)
        u.username = role
        u.password = 'test'
        appPool = new pg.Pool({ connectionString: u.toString(), max: 3 })
        appPool.on('error', () => {})
        const mailer = memoryMailer()
        const auth = createAuth({ pool: appPool, logger: silent, mailer, limits: { signInGlobal: false } })
        const ip = nextIp()
        const su = await auth.handleAuthRequest('sign-up', { email: 'approle-mail@example.ch', password: PW }, { ip })
        assert.equal(su.status, 200, JSON.stringify(su.body))
        await auth.settle()
        const c = await auth.handleAuthRequest('confirm-email', { token: linkToken(mailer.find('confirm', 'approle-mail@example.ch')).token }, { ip })
        assert.equal(c.status, 200, JSON.stringify(c.body))
        await auth.handleAuthRequest('reset-password', { email: 'approle-mail@example.ch' }, { ip })
        await auth.settle()
        const r = await auth.handleAuthRequest('reset-password/confirm', { token: linkToken(mailer.find('reset', 'approle-mail@example.ch')).token, password: NEW_PW }, { ip })
        assert.equal(r.status, 200, JSON.stringify(r.body))
        assert.ok(await auth.sweepExpiredTokens() >= 0)
      } finally {
        await appPool?.end()
        await pool.query(`DROP OWNED BY ${role}`)
        await pool.query(`DROP ROLE IF EXISTS ${role}`)
      }
    })
  })
})
