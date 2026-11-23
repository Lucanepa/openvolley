/**
 * Audit 2611 SEC-15: a stranger signs up with someone else's address, a name,
 * a licence number and a scorer request for a club. The owner confirms the
 * address without the stranger's password: the password, sessions and
 * passkeys went (be-auth-3), but the planted name, licence number and the
 * open request stayed, and the approvers were told of the "new sign-up", so
 * a club manager could approve it on the owner's account
 * (poc/auth-sessions/p01-signup-oracle-and-confirm.mjs). Now that branch
 * clears them in the same transaction and tells no approver; a confirmation
 * with the password (the one who signed up) keeps everything, as before.
 *
 * Needs PG_TEST_URL (tests/helpers/pgTestDb.js).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { SKIP_PG, SCHEMA_SQL, createTestDatabase } from './helpers/pgTestDb.js'
import { linkToken } from './helpers/fakeSmtp.js'
import { renderMail } from '../lib/mailer.js'
import { createAuth } from '../lib/auth.js'
import { parseSignUpRequests, storeSignUpRequests } from '../lib/accountRequests.js'

const here = dirname(fileURLToPath(import.meta.url))
const SESSIONS_SQL = readFileSync(join(here, '..', 'db', '002_app_sessions.sql'), 'utf8')
const silent = { log() {}, warn() {}, error() {} }
const STRANGER_PW = 'stranger-pass-123'

function memoryMailer() {
  const mails = []
  return {
    enabled: true, reason: null, managerUrl: 'https://manager.example.test', mails,
    async send(kind, { to, lang, link }) { mails.push({ kind, to, text: renderMail(kind, lang, { link }).text }); return { sent: true } },
    close() {},
    find(kind, to) { return mails.filter((m) => m.kind === kind && m.to === to).at(-1) || null }
  }
}

describe('confirm-email without the password clears what the sign-up planted (SEC-15)', { skip: SKIP_PG }, () => {
  let tdb, pool, clubId
  let ipSeq = 0
  const nextIp = () => `198.51.100.${(++ipSeq % 250) + 1}`
  before(async () => {
    tdb = await createTestDatabase('authsignin_planted', { schemaSql: SCHEMA_SQL + '\n' + SESSIONS_SQL })
    pool = new pg.Pool({ connectionString: tdb.url, max: 5 })
    pool.on('connect', (c) => c.on('error', () => {}))
    pool.on('error', () => {})
    clubId = (await pool.query(`INSERT INTO public.clubs (name) VALUES ('VBC Musterdorf') RETURNING id`)).rows[0].id
  })
  after(async () => {
    await pool?.end()
    await tdb?.drop()
  })

  function makeAuth() {
    const mailer = memoryMailer()
    const confirmed = []
    const auth = createAuth({
      pool, logger: silent, mailer, bcryptCost: 4,
      signUpRequests: { parse: parseSignUpRequests, store: (client, userId, rows) => storeSignUpRequests(client, userId, rows) },
      onAccountConfirmed: (userId) => { confirmed.push(userId) },
      limits: { signInGlobal: false }
    })
    return { auth, mailer, confirmed }
  }
  async function plant(auth, mailer, email) {
    const su = await auth.handleAuthRequest('sign-up', {
      email, password: STRANGER_PW, app: 'indoor',
      metadata: { first_name: 'Evil', last_name: 'Stranger', license_number: '123456' },
      requests: [{ kind: 'scorer', club_id: clubId }]
    }, { ip: nextIp() })
    assert.equal(su.status, 200, JSON.stringify(su.body))
    await auth.settle()
    const id = su.body.data.user.id
    return { id, token: linkToken(mailer.find('confirm', email)).token }
  }
  const profileOf = async (id) => (await pool.query('SELECT first_name, last_name, license_number FROM public.profiles WHERE user_id = $1', [id])).rows[0]
  const requestsOf = async (id) => (await pool.query('SELECT kind, club_id FROM public.account_requests WHERE user_id = $1', [id])).rows

  it('the owner confirms without the password: the name, licence number and requests go, and no approver is told', async () => {
    const { auth, mailer, confirmed } = makeAuth()
    const victim = `victim-${Date.now()}@example.ch`
    const { id, token } = await plant(auth, mailer, victim)
    assert.deepEqual(await profileOf(id), { first_name: 'Evil', last_name: 'Stranger', license_number: '123456' })
    assert.equal((await requestsOf(id)).length, 1)

    const cf = await auth.handleAuthRequest('confirm-email', { token }, { ip: nextIp() })
    assert.equal(cf.status, 200, JSON.stringify(cf.body))
    assert.ok(cf.body.data.set_password_token, 'the clicker chooses a password')
    await auth.settle()
    assert.deepEqual(await profileOf(id), { first_name: null, last_name: null, license_number: null }, 'nothing of the stranger\'s stays')
    assert.deepEqual(await requestsOf(id), [], 'no request to approve on the owner\'s account')
    assert.deepEqual(confirmed, [], 'no sign-up notice to the approvers')
    const { rows: [a] } = await pool.query(`SELECT details FROM public.audit_log WHERE action = 'account.email_confirmed' AND target_user_id = $1`, [id])
    assert.deepEqual(a.details, { password_cleared: true, details_cleared: true })

    // the owner sets a password and sees an empty account of their own
    const rs = await auth.handleAuthRequest('reset-password/confirm', { token: cf.body.data.set_password_token, password: 'owner-real-pass-987' }, { ip: nextIp() })
    assert.equal(rs.status, 200, JSON.stringify(rs.body))
    const si = await auth.handleAuthRequest('sign-in', { email: victim, password: 'owner-real-pass-987' }, { ip: nextIp() })
    assert.equal(si.status, 200)
    const prof = await auth.handleAuthRequest('profile', { access_token: si.body.data.session.access_token }, { ip: nextIp() })
    assert.equal(prof.body.data.first_name, null)
    assert.equal(prof.body.data.license_number, null, 'the licence question asks the owner again')
    assert.equal((await auth.handleAuthRequest('sign-in', { email: victim, password: STRANGER_PW }, { ip: nextIp() })).status, 400)
  })

  it('the one who signed up confirms with the password: everything stays and the approvers are told, as before', async () => {
    const { auth, mailer, confirmed } = makeAuth()
    const self = `self-${Date.now()}@example.ch`
    const { id, token } = await plant(auth, mailer, self)
    const cf = await auth.handleAuthRequest('confirm-email', { token, password: STRANGER_PW }, { ip: nextIp() })
    assert.equal(cf.status, 200, JSON.stringify(cf.body))
    assert.equal(cf.body.data.set_password_token, undefined)
    await auth.settle()
    assert.deepEqual(await profileOf(id), { first_name: 'Evil', last_name: 'Stranger', license_number: '123456' })
    assert.equal((await requestsOf(id)).length, 1)
    assert.deepEqual(confirmed, [id])
  })

  it('a failure while clearing rolls the whole confirmation back (one transaction)', async () => {
    const { auth, mailer } = makeAuth()
    const email = `rollback-${Date.now()}@example.ch`
    const { id, token } = await plant(auth, mailer, email)
    // make the request delete fail inside the transaction
    await pool.query(`CREATE OR REPLACE FUNCTION pg_temp_never() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'no'; END $$`)
    await pool.query('CREATE TRIGGER account_requests_no_delete BEFORE DELETE ON public.account_requests FOR EACH ROW EXECUTE FUNCTION pg_temp_never()')
    try {
      const cf = await auth.handleAuthRequest('confirm-email', { token }, { ip: nextIp() })
      assert.equal(cf.status, 503)
      const { rows: [u] } = await pool.query('SELECT email_confirmed_at, encrypted_password FROM auth.users WHERE id = $1', [id])
      assert.equal(u.email_confirmed_at, null, 'not confirmed')
      assert.ok(!u.encrypted_password.startsWith('!unset:'), 'the password was not cleared either')
      assert.equal((await profileOf(id)).first_name, 'Evil')
    } finally {
      await pool.query('DROP TRIGGER account_requests_no_delete ON public.account_requests')
      await pool.query('DROP FUNCTION pg_temp_never()')
    }
    const again = await auth.handleAuthRequest('confirm-email', { token }, { ip: nextIp() })
    assert.equal(again.status, 200, 'the link still works once the trouble is gone')
    assert.deepEqual(await requestsOf(id), [])
  })
})
