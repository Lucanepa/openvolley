/**
 * Account emails end to end: server.js with a real SMTP session to a local
 * sink (tests/helpers/fakeSmtp.js; STARTTLS on a random port, its throwaway
 * certificate trusted through NODE_EXTRA_CA_CERTS, so verification stays on),
 * Postgres with db/010. Follows the links out of the captured mails.
 *
 * Needs PG_TEST_URL (a throwaway Postgres, see tests/helpers/pgTestDb.js) or
 * OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'
import { startFakeSmtp, linkToken, SMTP_PASS } from './helpers/fakeSmtp.js'

const PW = 'first-password-1'
const NEW_PW = 'second-password-2'

describe('account emails end to end', { skip: SKIP }, () => {
  let db, sql, smtp, srv, plain, storageRoot, statusDir
  let ipSeq = 1
  const nextIp = () => `203.0.113.${ipSeq++}`
  const tokensSeen = []

  const auth = (server, action, body, { ip = nextIp(), headers = {} } = {}) =>
    api(server.base, `/api/auth/${action}`, { body, proto: null, headers: { 'cf-connecting-ip': ip, ...headers } })
  async function signIn(server, email, password) {
    let r
    for (let i = 0; i < 10; i++) {
      r = await auth(server, 'sign-in', { email, password })
      if (!(r.status === 503 && r.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    return r
  }
  const mailFor = (to, subjectRe) => smtp.waitForMail((m) => m.envelope.to.includes(to) && (!subjectRe || subjectRe.test(m.subject)))
  const mailsFor = (to) => smtp.mails.filter((m) => m.envelope.to.includes(to))

  const serverEnv = () => ({
    DATABASE_URL: db.url,
    STORAGE_ROOT: storageRoot,
    STATUS_DIR: statusDir,
    TRUST_PROXY: 'cloudflare',
    TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
    STORAGE_BACKUP_MIN_FREE_MB: '1',
    STORAGE_SCORESHEETS_MIN_FREE_MB: '1',
    CONTACT_EMAIL: 'owner@example.test'
  })

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-mail-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-mail-status-'))
    writeFileSync(join(statusDir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
    smtp = await startFakeSmtp({ implicitTls: false })
    srv = await bootServer({ ...serverEnv(), ...smtp.env(), MANAGER_URL_BEACH: 'https://manager-beach.example.test' })
  })

  after(async () => {
    await srv?.stop()
    await plain?.stop()
    await smtp?.close()
    await sql?.end()
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
    if (statusDir) rmSync(statusDir, { recursive: true, force: true })
  })

  it('logs once that account emails are on, without the password', () => {
    const out = srv.output.join('')
    assert.equal(out.match(/\[Mail\] account emails on/g)?.length, 1, out.slice(-2000))
    assert.ok(!out.includes(SMTP_PASS))
    assert.match(out, /OpenBeach from OpenBeach <noreply@example\.test>, links to https:\/\/manager-beach\.example\.test/)
  })

  it('sign-up mails a confirmation link; the account signs in at once; the link confirms it', async () => {
    const email = 'nina.neu@example.ch'
    const up = await auth(srv, 'sign-up', { email, password: PW, lang: 'de', metadata: { first_name: 'Nina', last_name: 'Neu' } })
    assert.equal(up.status, 200, up.text)
    assert.equal(up.json.data.email_confirmation, 'sent')
    assert.equal(up.json.data.user.email_confirmed_at, null)
    const mail = await mailFor(email)
    assert.equal(mail.secure, true, 'STARTTLS was used')
    assert.equal(mail.subject, 'E-Mail-Adresse für OpenVolley bestätigen')
    assert.match(mail.from, /OpenVolley Test <noreply@example\.test>/)
    const link = linkToken(mail)
    assert.equal(link.page, 'confirm')
    assert.ok(link.url.startsWith('https://manager.example.test/#confirm?token='))
    tokensSeen.push(link.token)

    const s = await signIn(srv, email, PW)
    assert.equal(s.status, 200, s.text)
    assert.equal(s.json.data.user.email_confirmed_at, null)

    // The admin list shows the address as unconfirmed, then confirmed
    const admin = await signUpConfirmed('ada.admin@example.ch')
    await grantRoles(sql, admin.id, ['admin'])
    const listed = async () => (await api(srv.base, '/api/admin/accounts?filter=all&q=nina', { method: 'GET', token: admin.token, proto: null })).json.data.accounts[0]
    assert.equal((await listed()).email_confirmed, false)

    const c = await auth(srv, 'confirm-email', { token: link.token })
    assert.equal(c.status, 200, c.text)
    assert.deepEqual(c.json.data, { confirmed: true, already_confirmed: false })
    assert.equal((await listed()).email_confirmed, true)
    const g = await auth(srv, 'get-user', { access_token: s.json.data.session.access_token })
    assert.ok(g.json.data.user.email_confirmed_at)
  })

  async function signUpConfirmed(email) {
    const up = await auth(srv, 'sign-up', { email, password: PW })
    assert.equal(up.status, 200, up.text)
    const { token } = linkToken(await mailFor(email))
    tokensSeen.push(token)
    assert.equal((await auth(srv, 'confirm-email', { token })).status, 200)
    const s = await signIn(srv, email, PW)
    assert.equal(s.status, 200, s.text)
    return { id: s.json.data.user.id, token: s.json.data.session.access_token }
  }

  it('reset: the same answer for known and unknown addresses; the link works once; sessions are revoked', async () => {
    const email = 'rita.reset@example.ch'
    const me = await signUpConfirmed(email)
    const before = smtp.mails.length

    const known = await auth(srv, 'reset-password', { email }, { headers: { 'accept-language': 'it-CH,it;q=0.9,de;q=0.5' } })
    const unknown = await auth(srv, 'reset-password', { email: 'nobody.here@example.ch' }, { headers: { 'accept-language': 'it-CH,it;q=0.9,de;q=0.5' } })
    assert.equal(known.status, 200, known.text)
    assert.equal(unknown.status, known.status)
    assert.equal(unknown.text, known.text, 'identical body')
    assert.equal(unknown.headers.get('content-type'), known.headers.get('content-type'))
    assert.equal(unknown.headers.get('content-length'), known.headers.get('content-length'))

    const mail = await mailFor(email, /password/i)
    assert.equal(mail.subject, 'Reimposta la password di OpenVolley', 'Accept-Language picks Italian')
    await sleep(300)
    assert.equal(smtp.mails.slice(before).filter((m) => m.envelope.to.includes('nobody.here@example.ch')).length, 0, 'no mail for an unknown address')
    const { token, page } = linkToken(mail)
    assert.equal(page, 'reset')
    tokensSeen.push(token)

    const weak = await auth(srv, 'reset-password/confirm', { token, password: '123' })
    assert.equal(weak.status, 422)
    assert.equal(weak.json.error.code, 'weak_password')

    const done = await auth(srv, 'reset-password/confirm', { token, password: NEW_PW, lang: 'it' })
    assert.equal(done.status, 200, done.text)
    assert.equal((await auth(srv, 'get-user', { access_token: me.token })).status, 401, 'old session revoked')
    assert.equal((await signIn(srv, email, PW)).status, 400)
    assert.equal((await signIn(srv, email, NEW_PW)).status, 200)
    const notice = await mailFor(email, /modificata/)
    assert.equal(linkToken(notice), null)

    const reuse = await auth(srv, 'reset-password/confirm', { token, password: 'third-password-3' })
    assert.equal(reuse.status, 400)
    assert.equal(reuse.json.error.code, 'invalid_link')
    const audit = (await sql.query("SELECT action, app FROM public.audit_log WHERE target_user_id = $1 AND action LIKE 'account.%' ORDER BY id", [me.id])).rows
    assert.deepEqual(audit.map((r) => r.action), ['account.email_confirmed', 'account.password_reset_requested', 'account.password_reset'])
    assert.ok(audit.every((r) => r.app === null), 'an OpenVolley account: indoor entries, as before')
  })

  it('an expired link and an older link are refused', async () => {
    const email = 'otto.old@example.ch'
    const me = await signUpConfirmed(email)
    await auth(srv, 'reset-password', { email })
    const first = linkToken(await mailFor(email, /password/i)).token
    await auth(srv, 'reset-password', { email })
    await smtp.waitForMail(() => mailsFor(email).filter((m) => /password/i.test(m.subject)).length >= 2)
    const second = linkToken(mailsFor(email).filter((m) => /password/i.test(m.subject)).at(-1)).token
    tokensSeen.push(first, second)
    assert.notEqual(first, second)
    assert.equal((await auth(srv, 'reset-password/confirm', { token: first, password: NEW_PW })).json.error.code, 'invalid_link')
    await sql.query("UPDATE auth.app_tokens SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' WHERE user_id = $1 AND used_at IS NULL", [me.id])
    assert.equal((await auth(srv, 'reset-password/confirm', { token: second, password: NEW_PW })).json.error.code, 'invalid_link')
    assert.equal((await signIn(srv, email, PW)).status, 200, 'password unchanged')
  })

  it('rate limits reset requests per address, known or not', async () => {
    for (const email of ['lisa.limit@example.ch', 'nobody.limit@example.ch']) {
      if (email.startsWith('lisa')) await signUpConfirmed(email)
      const codes = []
      for (let i = 0; i < 4; i++) codes.push((await auth(srv, 'reset-password', { email })).status)
      assert.deepEqual(codes, [200, 200, 200, 429], email)
    }
  })

  it('resend-confirmation needs a session and sends a fresh link', async () => {
    const email = 'rolf.resend@example.ch'
    await auth(srv, 'sign-up', { email, password: PW })
    const old = linkToken(await mailFor(email)).token
    const s = await signIn(srv, email, PW)
    assert.equal((await auth(srv, 'resend-confirmation', {})).status, 401)
    const r = await auth(srv, 'resend-confirmation', { access_token: s.json.data.session.access_token, lang: 'fr' })
    assert.equal(r.status, 200, r.text)
    const fresh = await smtp.waitForMail((m) => m.envelope.to.includes(email) && /Confirmez/.test(m.subject))
    const token = linkToken(fresh).token
    tokensSeen.push(old, token)
    assert.equal((await auth(srv, 'confirm-email', { token: old })).json.error.code, 'invalid_link')
    assert.equal((await auth(srv, 'confirm-email', { token })).status, 200)
  })

  it('OpenBeach (app: beach): its sender, texts and manager links; the membership; never a host from the client', async () => {
    const email = 'bea.beach@example.ch'
    const up = await auth(srv, 'sign-up', { email, password: PW, lang: 'de', app: 'beach', redirectTo: 'https://evil.test/', metadata: { first_name: 'Bea' } })
    assert.equal(up.status, 200, up.text)
    const id = up.json.data.user.id
    const confirm = await mailFor(email)
    assert.match(confirm.from, /^"?OpenBeach"? <noreply@example\.test>$/)
    assert.equal(confirm.subject, 'E-Mail-Adresse für OpenBeach bestätigen')
    assert.match(confirm.text, /– OpenBeach/)
    const c = linkToken(confirm)
    assert.ok(c.url.startsWith('https://manager-beach.example.test/#confirm?token='), c.url)
    assert.ok(!confirm.text.includes('evil.test'))
    tokensSeen.push(c.token)
    // the account joined OpenBeach at sign-up (and only it)
    const rows = (await sql.query('SELECT app, joined_via FROM auth.app_memberships WHERE user_id = $1', [id])).rows
    assert.deepEqual(rows, [{ app: 'beach', joined_via: 'signup' }])
    // the token works on the backend whichever manager shows it
    assert.equal((await auth(srv, 'confirm-email', { token: c.token, app: 'beach' })).status, 200)

    // resend for an unconfirmed OpenBeach account
    const email2 = 'ben.beach@example.ch'
    await auth(srv, 'sign-up', { email: email2, password: PW, app: 'beach' })
    await mailFor(email2)
    const s2 = await signIn(srv, email2, PW)
    assert.equal((await auth(srv, 'resend-confirmation', { access_token: s2.json.data.session.access_token, lang: 'fr', app: 'beach' })).status, 200)
    const again = await smtp.waitForMail((m) => m.envelope.to.includes(email2) && /Confirmez/.test(m.subject))
    assert.equal(again.subject, 'Confirmez votre adresse e-mail pour OpenBeach')
    const a = linkToken(again)
    assert.ok(a.url.startsWith('https://manager-beach.example.test/#confirm?token='))
    tokensSeen.push(a.token)

    // reset + the password-changed notice, both OpenBeach, saying it is the password of both apps
    const s = await signIn(srv, email, PW)
    assert.equal(s.status, 200, s.text)
    assert.equal((await auth(srv, 'reset-password', { email, lang: 'en', app: 'beach', redirectTo: 'https://evil.test/' })).status, 200)
    const reset = await mailFor(email, /password/i)
    assert.equal(reset.subject, 'Reset your OpenBeach password')
    assert.match(reset.from, /OpenBeach <noreply@example\.test>/)
    assert.match(reset.text, /This changes the password of your account for OpenVolley and OpenBeach\./)
    const r = linkToken(reset)
    assert.ok(r.url.startsWith('https://manager-beach.example.test/#reset?token='), r.url)
    tokensSeen.push(r.token)
    assert.equal((await auth(srv, 'reset-password/confirm', { token: r.token, password: NEW_PW, lang: 'en', app: 'beach' })).status, 200)
    const notice = await mailFor(email, /was changed/)
    assert.equal(notice.subject, 'Your OpenBeach password was changed')
    assert.match(notice.text, /OpenVolley and OpenBeach/)
    // the one password signs in everywhere
    assert.equal((await signIn(srv, email, NEW_PW)).status, 200)

    // an unknown app is OpenVolley (and still a sign-up: it joins indoor)
    const email3 = 'olga.other@example.ch'
    const up3 = await auth(srv, 'sign-up', { email: email3, password: PW, app: 'snow' })
    const plainMail = await mailFor(email3)
    assert.match(plainMail.from, /OpenVolley Test/)
    assert.ok(linkToken(plainMail).url.startsWith('https://manager.example.test/'))
    tokensSeen.push(linkToken(plainMail).token)
    assert.deepEqual((await sql.query('SELECT app FROM auth.app_memberships WHERE user_id = $1', [up3.json.data.user.id])).rows, [{ app: 'indoor' }])
  })

  it('the email-link audit entries go to the app of the account (S2 review)', async () => {
    const authEntries = async (userId) => (await sql.query(
      "SELECT action, app FROM public.audit_log WHERE target_user_id = $1 AND action LIKE 'account.%' ORDER BY id", [userId])).rows
    const waitEntries = async (userId, n) => {
      for (let i = 0; i < 50; i++) {
        const rows = await authEntries(userId)
        if (rows.length >= n) return rows
        await sleep(100)
      }
      return authEntries(userId)
    }
    // the OpenBeach-only account of the test above: confirm and reset are OpenBeach's
    const bea = (await sql.query("SELECT id FROM auth.users WHERE email = 'bea.beach@example.ch'")).rows[0].id
    assert.deepEqual(await authEntries(bea), [
      { action: 'account.email_confirmed', app: 'beach' },
      { action: 'account.password_reset_requested', app: 'beach' },
      { action: 'account.password_reset', app: 'beach' }
    ])
    // so the admin lists put them in OpenBeach's audit and not in OpenVolley's
    const listed = (app) => sql.query(
      "SELECT count(*)::int n FROM public.audit_log WHERE target_user_id = $1 AND action LIKE 'account.%' AND " +
      (app === 'beach' ? "app = 'beach'" : "app IS DISTINCT FROM 'beach'"), [bea])
    assert.equal((await listed('beach')).rows[0].n, 3)
    assert.equal((await listed('indoor')).rows[0].n, 0)

    // a member of both apps: the app of the request (an absent app is OpenVolley)
    const email = 'bo.both@example.ch'
    const up = await auth(srv, 'sign-up', { email, password: PW, app: 'indoor' })
    assert.equal(up.status, 200, up.text)
    const id = up.json.data.user.id
    tokensSeen.push(linkToken(await mailFor(email)).token)
    await sql.query("INSERT INTO auth.app_memberships (user_id, app, joined_via) VALUES ($1, 'beach', 'join')", [id])
    assert.equal((await auth(srv, 'reset-password', { email, app: 'beach' })).status, 200)
    assert.deepEqual(await waitEntries(id, 1), [{ action: 'account.password_reset_requested', app: 'beach' }])
    assert.equal((await auth(srv, 'reset-password', { email })).status, 200)
    assert.deepEqual((await waitEntries(id, 2))[1], { action: 'account.password_reset_requested', app: null })
  })

  it('never writes a link token into the server log', () => {
    const out = srv.output.join('')
    assert.ok(tokensSeen.length >= 6)
    for (const t of tokensSeen) assert.ok(!out.includes(t), 'token in the log')
  })

  it('the internal /health body shows the mail counters (no addresses); the public one does not', async () => {
    const internal = await (await fetch(`${srv.base}/health`)).json()
    assert.equal(internal.mail.enabled, true)
    assert.ok(internal.mail.sent >= 6, JSON.stringify(internal.mail))
    assert.deepEqual(Object.keys(internal.mail.budgets).sort(), ['account', 'confirm', 'notify'])
    assert.deepEqual(internal.mail.exhausted, [])
    assert.equal(JSON.stringify(internal.mail).includes('@'), false)
    const proxied = await (await fetch(`${srv.base}/health`, { headers: { 'cf-connecting-ip': nextIp() } })).json()
    assert.equal(proxied.mail, undefined)
  })

  it('without SMTP settings: reset answers 503 with the contact address, sign-up confirms at once', async () => {
    plain = await bootServer(serverEnv())
    const out = plain.output.join('')
    assert.match(out, /\[Mail\] account emails off \(SMTP_HOST not set\)/)
    const r = await auth(plain, 'reset-password', { email: 'rita.reset@example.ch' })
    assert.equal(r.status, 503)
    assert.equal(r.json.error.code, 'reset_unavailable')
    assert.match(r.json.error.message, /temporarily unavailable\. Contact owner@example\.test/)
    const before = smtp.mails.length
    const up = await auth(plain, 'sign-up', { email: 'paul.plain@example.ch', password: PW })
    assert.equal(up.status, 200, up.text)
    assert.ok(up.json.data.user.email_confirmed_at)
    assert.equal(up.json.data.email_confirmation, undefined)
    await sleep(200)
    assert.equal(smtp.mails.length, before)
  })
})
