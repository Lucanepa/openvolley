/**
 * Audit 2611 SEC-15: a stranger signs up with someone else's address, a name,
 * a licence number and a scorer request for a club. The owner confirms the
 * address without the stranger's password: the password, sessions and
 * passkeys went (be-auth-3), but the planted name, licence number and the
 * open request stayed, and the approvers were told of the "new sign-up", so
 * a club manager could approve it on the owner's account
 * (poc/auth-sessions/p01-signup-oracle-and-confirm.mjs).
 *
 * The first fix cleared them at the click; its review (I-3) found that a
 * real user who confirms on another device without the password then lost
 * their name, licence and requests, and no approver was ever told. Now the
 * click without the password only takes the account from whoever signed up
 * (password, sessions, passkeys); the address is confirmed with the new
 * password the clicker chooses, on a page that shows what the sign-up gave
 * (reset-password/details) and keeps only what the clicker keeps
 * (reset-password/confirm `keep`; nothing without it); the approvers are
 * told then. Until then the address stays unconfirmed, so nothing of it can
 * be approved. A reset link (forgot password) of an unconfirmed address
 * works the same way. A confirmation with the password (the one who signed
 * up) keeps everything, as before.
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
import { createAccountRequests, parseSignUpRequests, storeSignUpRequests } from '../lib/accountRequests.js'

const here = dirname(fileURLToPath(import.meta.url))
const SESSIONS_SQL = readFileSync(join(here, '..', 'db', '002_app_sessions.sql'), 'utf8')
const silent = { log() {}, warn() {}, error() {} }
const STRANGER_PW = 'stranger-pass-123'

function memoryMailer() {
  const mails = []
  return {
    enabled: true, reason: null, managerUrl: 'https://manager.example.test', mails,
    async send(kind, { to, lang, link }) { mails.push({ kind, to, text: link ? renderMail(kind, lang, { link }).text : '' }); return { sent: true } },
    close() {},
    find(kind, to) { return mails.filter((m) => m.kind === kind && m.to === to).at(-1) || null }
  }
}

describe('confirming without the password: the owner keeps or drops what the sign-up gave (SEC-15, review I-3)', { skip: SKIP_PG }, () => {
  let tdb, pool, clubId, otherClubId
  let ipSeq = 0
  const nextIp = () => `198.51.100.${(++ipSeq % 250) + 1}`
  before(async () => {
    tdb = await createTestDatabase('authsignin_planted', { schemaSql: SCHEMA_SQL + '\n' + SESSIONS_SQL })
    pool = new pg.Pool({ connectionString: tdb.url, max: 5 })
    pool.on('connect', (c) => c.on('error', () => {}))
    pool.on('error', () => {})
    clubId = (await pool.query(`INSERT INTO public.clubs (name) VALUES ('VBC Musterdorf') RETURNING id`)).rows[0].id
    otherClubId = (await pool.query(`INSERT INTO public.clubs (name) VALUES ('VC Beispielstadt') RETURNING id`)).rows[0].id
  })
  after(async () => {
    await pool?.end()
    await tdb?.drop()
  })

  function makeAuth() {
    const mailer = memoryMailer()
    const confirmed = []
    const arq = createAccountRequests({ pool })
    const auth = createAuth({
      pool, logger: silent, mailer, bcryptCost: 4,
      signUpRequests: { parse: parseSignUpRequests, store: (client, userId, rows) => storeSignUpRequests(client, userId, rows), list: (client, userId) => arq.mine(client, userId) },
      onAccountConfirmed: (userId) => { confirmed.push(userId) },
      limits: { signInGlobal: false }
    })
    return { auth, mailer, confirmed }
  }
  async function plant(auth, mailer, email, { requests = [{ kind: 'scorer', club_id: clubId }], names = { first_name: 'Evil', last_name: 'Stranger', license_number: '123456' } } = {}) {
    const su = await auth.handleAuthRequest('sign-up', {
      email, password: STRANGER_PW, app: 'indoor', metadata: names, requests
    }, { ip: nextIp() })
    assert.equal(su.status, 200, JSON.stringify(su.body))
    await auth.settle()
    return { id: su.body.data.user.id, token: linkToken(mailer.find('confirm', email)).token, session: su.body.data.session?.access_token }
  }
  const call = (auth, action, body) => auth.handleAuthRequest(action, body, { ip: nextIp() })
  const profileOf = async (id) => (await pool.query('SELECT first_name, last_name, license_number FROM public.profiles WHERE user_id = $1', [id])).rows[0]
  const requestsOf = async (id) => (await pool.query('SELECT id, kind, club_id FROM public.account_requests WHERE user_id = $1 ORDER BY kind', [id])).rows
  const userOf = async (id) => (await pool.query('SELECT email_confirmed_at, encrypted_password FROM auth.users WHERE id = $1', [id])).rows[0]
  const auditOf = async (id, action) => (await pool.query('SELECT details FROM public.audit_log WHERE action = $1 AND target_user_id = $2 ORDER BY id', [action, id])).rows.map((r) => r.details)

  it('the owner confirms without the password: the stranger loses the account, the address waits for the owner\'s password, no approver is told yet', async () => {
    const { auth, mailer, confirmed } = makeAuth()
    const victim = `victim-${Date.now()}@example.ch`
    const { id, token } = await plant(auth, mailer, victim)
    const stranger = await call(auth, 'sign-in', { email: victim, password: STRANGER_PW })
    assert.equal(stranger.status, 200, 'an account made with a link signs in while unconfirmed')
    const cf = await call(auth, 'confirm-email', { token })
    assert.equal(cf.status, 200, JSON.stringify(cf.body))
    const setToken = cf.body.data.set_password_token
    assert.equal((await call(auth, 'get-user', { access_token: stranger.body.data.session.access_token })).status, 401, 'the stranger\'s session is gone')
    assert.ok(setToken, 'the clicker chooses a password')
    await auth.settle()
    const u = await userOf(id)
    assert.ok(u.encrypted_password.startsWith('!unset:'), 'the stranger\'s password is gone')
    assert.equal(u.email_confirmed_at, null, 'not confirmed yet: nothing of it can be approved')
    assert.equal((await call(auth, 'sign-in', { email: victim, password: STRANGER_PW })).status, 400)
    assert.deepEqual(confirmed, [], 'no approver is told yet')
    assert.deepEqual(await auditOf(id, 'account.password_reset'), [{ password_cleared: true, sessions_revoked: 1 }])
    assert.deepEqual(await auditOf(id, 'account.email_confirmed'), [])

    // the set-password page shows what the sign-up gave
    const d = await call(auth, 'reset-password/details', { token: setToken })
    assert.equal(d.status, 200, JSON.stringify(d.body))
    assert.deepEqual({ ...d.body.data.signup_details, requests: undefined }, { first_name: 'Evil', last_name: 'Stranger', license_number: '123456', requests: undefined })
    assert.equal(d.body.data.signup_details.requests.length, 1)
    assert.equal(d.body.data.signup_details.requests[0].kind, 'scorer')
    assert.equal(d.body.data.signup_details.requests[0].club_name, 'VBC Musterdorf')

    // the owner keeps nothing of it
    const rs = await call(auth, 'reset-password/confirm', { token: setToken, password: 'owner-real-pass-987', keep: { name: false, licence: false, requests: [] } })
    assert.equal(rs.status, 200, JSON.stringify(rs.body))
    await auth.settle()
    assert.deepEqual(await profileOf(id), { first_name: null, last_name: null, license_number: null }, 'nothing of the stranger\'s stays')
    assert.deepEqual(await requestsOf(id), [], 'no request to approve on the owner\'s account')
    assert.ok((await userOf(id)).email_confirmed_at, 'confirmed with the owner\'s password')
    assert.deepEqual(confirmed, [id], 'the admins hear of the account now')
    assert.deepEqual(await auditOf(id, 'account.email_confirmed'), [{ with_password_reset: true, name: false, licence: false, requests_kept: 0, requests_dropped: 1 }])
    const si = await call(auth, 'sign-in', { email: victim, password: 'owner-real-pass-987' })
    assert.equal(si.status, 200)
    const prof = await call(auth, 'profile', { access_token: si.body.data.session.access_token })
    assert.equal(prof.body.data.license_number, null, 'the licence question asks the owner again')
  })

  it('the one who signed up, on another device without the password: keeps what is theirs, and the approvers are told of it', async () => {
    const { auth, mailer, confirmed } = makeAuth()
    const self = `phone-${Date.now()}@example.ch`
    const { id, token } = await plant(auth, mailer, self, {
      names: { first_name: 'Anna', last_name: 'Muster', license_number: '765432' },
      requests: [{ kind: 'scorer', club_id: clubId }, { kind: 'scorer', club_id: otherClubId }, { kind: 'referee' }]
    })
    const cf = await call(auth, 'confirm-email', { token })
    const setToken = cf.body.data.set_password_token
    const d = await call(auth, 'reset-password/details', { token: setToken })
    const parts = d.body.data.signup_details.requests
    assert.equal(parts.length, 3)
    const keepIds = parts.filter((p) => p.kind === 'referee' || p.club_name === 'VBC Musterdorf').map((p) => p.id)
    assert.equal(keepIds.length, 2)
    const rs = await call(auth, 'reset-password/confirm', { token: setToken, password: 'annas-new-pass-1', keep: { name: true, licence: true, requests: [...keepIds, '00000000-0000-0000-0000-000000000000', 'junk'] } })
    assert.equal(rs.status, 200, JSON.stringify(rs.body))
    await auth.settle()
    assert.deepEqual(await profileOf(id), { first_name: 'Anna', last_name: 'Muster', license_number: '765432' })
    const left = await requestsOf(id)
    assert.deepEqual(left.map((r) => r.id).sort(), [...keepIds].sort(), 'the kept parts stay, the other goes')
    assert.deepEqual(confirmed, [id])
    // the confirmation is done: the page shows nothing any more
    assert.equal((await call(auth, 'reset-password/details', { token: setToken })).status, 400, 'a spent link')
  })

  it('an older page (no `keep`) keeps nothing of an unconfirmed address\'s sign-up', async () => {
    const { auth, mailer, confirmed } = makeAuth()
    const email = `old-page-${Date.now()}@example.ch`
    const { id, token } = await plant(auth, mailer, email)
    const cf = await call(auth, 'confirm-email', { token })
    const rs = await call(auth, 'reset-password/confirm', { token: cf.body.data.set_password_token, password: 'owner-real-pass-987' })
    assert.equal(rs.status, 200)
    await auth.settle()
    assert.deepEqual(await profileOf(id), { first_name: null, last_name: null, license_number: null })
    assert.deepEqual(await requestsOf(id), [])
    assert.deepEqual(confirmed, [id])
  })

  it('forgot password on an address a stranger signed up with: the reset link confirms it the same way', async () => {
    const { auth, mailer, confirmed } = makeAuth()
    const victim = `forgot-${Date.now()}@example.ch`
    const { id } = await plant(auth, mailer, victim)
    assert.equal((await call(auth, 'reset-password', { email: victim })).status, 200)
    await auth.settle()
    const { token } = linkToken(mailer.find('reset', victim))
    const d = await call(auth, 'reset-password/details', { token })
    assert.equal(d.body.data.signup_details.first_name, 'Evil')
    const rs = await call(auth, 'reset-password/confirm', { token, password: 'owner-real-pass-987', keep: { name: false, licence: false, requests: [] } })
    assert.equal(rs.status, 200)
    await auth.settle()
    assert.deepEqual(await profileOf(id), { first_name: null, last_name: null, license_number: null })
    assert.deepEqual(await requestsOf(id), [])
    assert.ok((await userOf(id)).email_confirmed_at)
    assert.deepEqual(confirmed, [id])
  })

  it('a confirmed account\'s reset link: no details to show, nothing changes, nobody is told', async () => {
    const { auth, mailer, confirmed } = makeAuth()
    const email = `confirmed-${Date.now()}@example.ch`
    const { id, token } = await plant(auth, mailer, email, { names: { first_name: 'Beat', last_name: 'Beispiel', license_number: '4444' } })
    assert.equal((await call(auth, 'confirm-email', { token, password: STRANGER_PW })).status, 200)
    await auth.settle()
    confirmed.length = 0
    await call(auth, 'reset-password', { email })
    await auth.settle()
    const reset = linkToken(mailer.find('reset', email)).token
    const d = await call(auth, 'reset-password/details', { token: reset })
    assert.equal(d.status, 200)
    assert.equal(d.body.data.signup_details, null)
    assert.equal((await call(auth, 'reset-password/confirm', { token: reset, password: 'beats-new-pass-1' })).status, 200)
    await auth.settle()
    assert.deepEqual(await profileOf(id), { first_name: 'Beat', last_name: 'Beispiel', license_number: '4444' })
    assert.equal((await requestsOf(id)).length, 1)
    assert.deepEqual(confirmed, [])
  })

  it('reset-password/details refuses junk and unknown links', async () => {
    const { auth } = makeAuth()
    assert.equal((await call(auth, 'reset-password/details', { token: 'nope' })).status, 400)
    assert.equal((await call(auth, 'reset-password/details', {})).status, 400)
    assert.equal((await call(auth, 'reset-password/details', { token: 'A'.repeat(43) })).body.error.code, 'invalid_link')
  })

  it('the one who signed up confirms with the password: everything stays and the approvers are told, as before', async () => {
    const { auth, mailer, confirmed } = makeAuth()
    const self = `self-${Date.now()}@example.ch`
    const { id, token } = await plant(auth, mailer, self)
    const cf = await call(auth, 'confirm-email', { token, password: STRANGER_PW })
    assert.equal(cf.status, 200, JSON.stringify(cf.body))
    assert.equal(cf.body.data.set_password_token, undefined)
    await auth.settle()
    assert.deepEqual(await profileOf(id), { first_name: 'Evil', last_name: 'Stranger', license_number: '123456' })
    assert.equal((await requestsOf(id)).length, 1)
    assert.deepEqual(confirmed, [id])
  })

  it('a failure while dropping rolls the whole password step back (one transaction)', async () => {
    const { auth, mailer, confirmed } = makeAuth()
    const email = `rollback-${Date.now()}@example.ch`
    const { id, token } = await plant(auth, mailer, email)
    const setToken = (await call(auth, 'confirm-email', { token })).body.data.set_password_token
    // make the request delete fail inside the transaction
    await pool.query(`CREATE OR REPLACE FUNCTION pg_temp_never() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'no'; END $$`)
    await pool.query('CREATE TRIGGER account_requests_no_delete BEFORE DELETE ON public.account_requests FOR EACH ROW EXECUTE FUNCTION pg_temp_never()')
    try {
      const rs = await call(auth, 'reset-password/confirm', { token: setToken, password: 'owner-real-pass-987' })
      assert.equal(rs.status, 503)
      const u = await userOf(id)
      assert.equal(u.email_confirmed_at, null, 'not confirmed')
      assert.ok(u.encrypted_password.startsWith('!unset:'), 'no password set either')
      assert.equal((await profileOf(id)).first_name, 'Evil')
    } finally {
      await pool.query('DROP TRIGGER account_requests_no_delete ON public.account_requests')
      await pool.query('DROP FUNCTION pg_temp_never()')
    }
    const again = await call(auth, 'reset-password/confirm', { token: setToken, password: 'owner-real-pass-987' })
    assert.equal(again.status, 200, 'the link still works once the trouble is gone')
    assert.deepEqual(await requestsOf(id), [])
    await auth.settle()
    assert.deepEqual(confirmed, [id])
  })
})
