/**
 * POST /api/match/send-pin (and send-info, which takes the same way) end to
 * end: server.js against a real Postgres (PG_TEST_URL, or OV_E2E_DOCKER=1 for
 * a throwaway container; see tests/server.e2e.test.js), mailing as production
 * does: over the account-email mailbox, a local SMTP sink here
 * (helpers/fakeSmtp.js, STARTTLS, its throwaway certificate trusted through
 * NODE_EXTRA_CA_CERTS), without RESEND_API_KEY. The Resend API, the fallback
 * of a backend without SMTP, is answered by helpers/fakeResend.mjs:
 *
 *   - a session only (401), a scorer only (403), a match the account created
 *     or edits only (404)
 *   - the PIN is checked against the stored (hashed) one: a wrong PIN, a
 *     malformed one or a match without a stored PIN mails nothing
 *   - the mail goes to the account's own confirmed address, never to one in
 *     the request; an unconfirmed address gets nothing (409)
 *   - over SMTP without RESEND_API_KEY (production, 23.11.2026: "The email
 *     could not be sent" because only Resend was tried); Resend only without
 *     SMTP; 503 with neither
 *   - EMAIL_RATE_LIMIT_MAX (3 a minute) per address and per account, in
 *     counters of its own (send-info does not use them up)
 *   - the mailer's cap per inbox (5 an hour, whatever the spelling, apart from
 *     the reset mails): the sixth answers 429 OV_MAIL_LIMIT, nothing is sent
 *   - no PIN and no address in the server's log, a failed send included
 *
 * Made-up names and addresses only.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'
import { startFakeSmtp } from './helpers/fakeSmtp.js'
import { PIN_MAIL_SENTENCE } from '../lib/matchPinMail.js'

const FAKE_RESEND = new URL('./helpers/fakeResend.mjs', import.meta.url).href
const PIN_SECRET = randomBytes(32).toString('base64url')
const GAME_PIN = '583920'
const NO_SMTP = { SMTP_HOST: '', SMTP_PASS: '' }

describe('POST /api/match/send-pin', { skip: SKIP }, () => {
  let db
  let srv
  let smtp
  let sql
  let dir
  let resendLog
  let ipSeq = 1
  const nextIp = () => `198.51.100.${ipSeq++}`
  const users = {}
  const run = randomBytes(3).toString('hex')
  const ext = `match_${Date.now()}_${run}`
  const extNoPin = `${ext}-nopin`
  // addresses the sink answers "550 <address>: Recipient address rejected"
  const rejected = new Set()

  // the mails of the routes (the sink also gets the sign-ups' confirmation links)
  const mails = () => smtp.mails.filter((m) => /eScoresheet/.test(m.subject))
  const resendMails = () => existsSync(resendLog) ? readFileSync(resendLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  const sendPin = (user, body, ip = nextIp(), base = srv.base) =>
    api(base, '/api/match/send-pin', { token: user?.token, proto: null, body, headers: { 'cf-connecting-ip': ip } })
  const sendInfo = (user, body, ip = nextIp(), base = srv.base) =>
    api(base, '/api/match/send-info', { token: user?.token, proto: null, body, headers: { 'cf-connecting-ip': ip } })

  // A confirmed account (the link is mailed at sign-up; confirmed here directly)
  async function account(name, { roles = ['scorer'], email = `${name}-${run}@example.ch` } = {}) {
    const password = 'correct-horse-battery'
    const ip = nextIp()
    const up = await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password, metadata: { first_name: name } } })
    assert.equal(up.status, 200, up.text)
    const inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password } })
    assert.equal(inn.status, 200, inn.text)
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, email }
    await sql.query('UPDATE auth.users SET email_confirmed_at = now() WHERE id = $1', [u.id])
    await grantRoles(sql, u.id, roles)
    return u
  }

  // A fresh scorer that edits the match (as a game-PIN take-over makes one):
  // each check below spends a request of its own account's 3 a minute
  let editors = 0
  const makeEditor = async (u, externalId) => {
    await sql.query(`INSERT INTO public.match_editors (match_id, user_id) SELECT id, $2 FROM public.matches WHERE external_id = $1`, [externalId, u.id])
    return u
  }
  const editorOf = async (externalId, opts) => makeEditor(await account(`ed${++editors}`, opts), externalId)

  const serverEnv = (extra = {}) => ({
    DATABASE_URL: db.url,
    STORAGE_ROOT: dir,
    STATUS_DIR: dir,
    TRUST_PROXY: 'cloudflare',
    TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
    STORAGE_BACKUP_MIN_FREE_MB: '1',
    STORAGE_SCORESHEETS_MIN_FREE_MB: '1',
    OV_PIN_SECRET: PIN_SECRET,
    ...smtp.env(),
    // production: the SMTP mailbox, no Resend key
    RESEND_API_KEY: '',
    // a Resend call is recorded (and must not happen while SMTP is on)
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${FAKE_RESEND}`].filter(Boolean).join(' '),
    OV_TEST_RESEND_LOG: resendLog,
    ...extra
  })

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    dir = mkdtempSync(join(tmpdir(), 'ov-send-pin-'))
    writeFileSync(join(dir, '.ovdata'), '')
    writeFileSync(join(dir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
    resendLog = join(dir, 'resend.jsonl')
    smtp = await startFakeSmtp({ implicitTls: false, rejectRcpt: (a) => rejected.has(a) })
    srv = await bootServer(serverEnv())
    users.alice = await account('alice') // created the match
    users.bob = await account('bob') // another scorer
    users.pat = await account('pat', { roles: [] }) // no role
    users.una = await account('una') // created a match, address unconfirmed

    const upsert = (user, data) => api(srv.base, '/api/db', {
      token: user.token,
      body: { table: 'matches', action: 'upsert', params: { data, onConflict: 'external_id', returning: 'id', single: true } }
    })
    const match = {
      game_n: 991501,
      status: 'setup',
      sport_type: 'indoor',
      home_team: { name: 'Alpha VC', short_name: 'ALP' },
      away_team: { name: 'Beta VC', short_name: 'BET' },
      match_info: { hall: 'Halle A', city: 'Musterdorf', league: '3L' },
      scheduled_at: '2026-11-21T18:00:00.000Z'
    }
    for (const [user, data] of [
      [users.alice, { ...match, external_id: ext, game_pin: GAME_PIN }],
      [users.alice, { ...match, external_id: extNoPin, game_n: 991502 }],
      [users.una, { ...match, external_id: `${ext}-una`, game_n: 991503, game_pin: GAME_PIN }]
    ]) {
      const r = await upsert(user, data)
      assert.equal(r.status, 200, r.text)
    }
    const { rows: [row] } = await sql.query('SELECT game_pin FROM matches WHERE external_id = $1', [ext])
    assert.match(row.game_pin, /^h1:/, 'the game PIN is stored hashed')
    // una's address: unconfirmed, as an account made with a confirmation link
    await sql.query(
      `UPDATE auth.users SET email_confirmed_at = NULL,
              raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"ov_email_confirmation":"link"}'::jsonb
        WHERE id = $1`, [users.una.id])
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await smtp?.close()
    await db?.drop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('needs a session and mails nothing without one', async () => {
    const r = await sendPin(null, { externalId: ext, gamePin: GAME_PIN, email: 'someone@example.ch' })
    assert.equal(r.status, 401, r.text)
    assert.equal(mails().length, 0)
  })

  it('mails the checked PIN over SMTP to the account\'s own address only, never to one in the request', async () => {
    const r = await sendPin(users.alice, { externalId: ext, gamePin: GAME_PIN, email: 'someone@example.ch', to: 'other@example.ch' })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.success, true)
    assert.equal(r.text.includes(GAME_PIN), false, 'the answer repeats the PIN')
    assert.equal(r.text.includes(users.alice.email), false, 'the answer names the address')
    const sent = mails()
    assert.equal(sent.length, 1)
    assert.deepEqual(sent[0].envelope.to, [users.alice.email])
    assert.equal(sent[0].secure, true, 'STARTTLS was used')
    assert.match(sent[0].from, /^OpenVolley Test <noreply@example\.test>$/, 'the account emails\' sender')
    assert.equal(sent[0].headers['auto-submitted'], 'auto-generated')
    assert.match(sent[0].subject, /^Game 991501 eScoresheet: game PIN$/)
    assert.ok(sent[0].text.includes(`Game PIN: ${GAME_PIN}`), sent[0].text)
    assert.ok(sent[0].text.includes(PIN_MAIL_SENTENCE))
    assert.ok(sent[0].text.includes('Home: Alpha VC (ALP)'))
    assert.ok(sent[0].text.includes('Away: Beta VC (BET)'))
    assert.ok(sent[0].text.includes('League: 3L'))
    assert.ok(sent[0].text.includes('Date: 21.11.2026'))
    assert.ok(sent[0].text.includes('Time: 19:00'), 'the match time in Zurich')
    assert.equal(sent[0].html, '', 'plain text only')
    const all = JSON.stringify(smtp.mails.map((m) => [m.envelope, m.raw]))
    assert.equal(all.includes('someone@example.ch') || all.includes('other@example.ch'), false)
    assert.equal(resendMails().length, 0, 'Resend is not asked')
  })

  it('send-info: the match information over SMTP to the own address, without the PIN', async () => {
    const before = mails().length
    const r = await sendInfo(users.alice, { externalId: ext, email: 'someone@example.ch' })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.success, true)
    const sent = mails()
    assert.equal(sent.length, before + 1)
    const mail = sent.at(-1)
    assert.deepEqual(mail.envelope.to, [users.alice.email])
    assert.equal(mail.subject, 'Game 991501 eScoresheet')
    assert.ok(mail.text.includes('Match Information'), mail.text)
    assert.ok(mail.text.includes('Venue: Halle A'))
    assert.ok(mail.text.includes('City: Musterdorf'))
    assert.equal(mail.text.includes(GAME_PIN), false, 'no PIN in the match information')
    assert.equal(resendMails().length, 0)
  })

  it('never mails an unchecked PIN: a wrong one, a malformed one, none stored', async () => {
    const before = mails().length
    const wrong = await sendPin(await editorOf(ext), { externalId: ext, gamePin: '111111' })
    assert.equal(wrong.status, 409, wrong.text)
    assert.equal(wrong.json.code, 'OV_PIN_MISMATCH')
    // the stored value itself (from a dump) is not a PIN
    const { rows: [row] } = await sql.query('SELECT game_pin FROM matches WHERE external_id = $1', [ext])
    assert.equal((await sendPin(await editorOf(ext), { externalId: ext, gamePin: row.game_pin })).status, 400)
    for (const gamePin of [undefined, '', '12', 'abcdef', '12345678901234', { pin: GAME_PIN }, [GAME_PIN]]) {
      const r = await sendPin(await editorOf(ext), { externalId: ext, gamePin })
      assert.equal(r.status, 400, `${JSON.stringify(gamePin)}: ${r.text}`)
    }
    const noPin = await sendPin(await editorOf(extNoPin), { externalId: extNoPin, gamePin: GAME_PIN })
    assert.equal(noPin.status, 409, noPin.text)
    assert.equal(noPin.json.code, 'OV_PIN_MISMATCH')
    assert.equal((await sendPin(await editorOf(ext), { gamePin: GAME_PIN })).status, 400, 'no externalId')
    // an editor (not the creator) with the right PIN: its own address
    const editor = await editorOf(ext)
    const ok = await sendPin(editor, { externalId: ext, gamePin: Number(GAME_PIN) })
    assert.equal(ok.status, 200, ok.text)
    const sent = mails()
    assert.equal(sent.length, before + 1)
    assert.deepEqual(sent.at(-1).envelope.to, [editor.email])
  })

  it('only for a match the account created or edits, and only for a scorer', async () => {
    const before = mails().length
    const other = await sendPin(users.bob, { externalId: ext, gamePin: GAME_PIN })
    assert.equal(other.status, 404, other.text)
    const unknown = await sendPin(users.alice, { externalId: `${ext}-gone`, gamePin: GAME_PIN })
    assert.equal(unknown.status, 404, unknown.text)
    const noRole = await sendPin(users.pat, { externalId: ext, gamePin: GAME_PIN })
    assert.equal(noRole.status, 403, noRole.text)
    assert.equal(mails().length, before)
  })

  it('an unconfirmed address gets nothing', async () => {
    const before = mails().length
    const r = await sendPin(users.una, { externalId: `${ext}-una`, gamePin: GAME_PIN })
    assert.equal(r.status, 409, r.text)
    assert.equal(r.json.code, 'OV_EMAIL_UNCONFIRMED')
    assert.equal(mails().length, before)
  })

  it('3 a minute per account (from any address) and per address (any account), apart from send-info', async () => {
    // one account: three requests from three addresses, the fourth is refused before anything is read
    const eve = await account('eve')
    for (let i = 0; i < 3; i++) assert.equal((await sendPin(eve, { externalId: ext, gamePin: GAME_PIN })).status, 404)
    const fourth = await sendPin(eve, { externalId: ext, gamePin: GAME_PIN })
    assert.equal(fourth.status, 429, fourth.text)
    assert.equal(fourth.headers.get('retry-after'), '60')
    // send-info keeps its own counters: eve may still ask for the match info
    const info = await sendInfo(eve, { externalId: ext })
    assert.equal(info.status, 404, info.text)
    // one address: the fourth request is refused, whichever account sends it
    const ip = nextIp()
    const carl = await account('carl')
    const dana = await account('dana')
    for (const u of [carl, dana, carl]) assert.equal((await sendPin(u, { externalId: ext, gamePin: GAME_PIN }, ip)).status, 404)
    assert.equal((await sendPin(dana, { externalId: ext, gamePin: GAME_PIN }, ip)).status, 429)
    assert.equal((await sendPin(null, { externalId: ext, gamePin: GAME_PIN }, ip)).status, 429, 'counted before the session')
  })

  it('5 mails an hour to one inbox, whatever the spelling: the sixth is 429 OV_MAIL_LIMIT; the inbox\'s reset link still goes', async () => {
    // two accounts on one inbox (a plus-tag apart), 3 a minute each
    const box = `ivy-${run}@example.ch`
    const ivy = await editorOf(ext, { email: `ivy-${run}+a@example.ch` })
    const ivo = await editorOf(ext, { email: `ivy-${run}+b@example.ch` })
    Object.assign(users, { ivy, ivo })
    const before = mails().length
    for (const u of [ivy, ivy, ivy, ivo, ivo]) {
      const r = await sendPin(u, { externalId: ext, gamePin: GAME_PIN })
      assert.equal(r.status, 200, r.text)
    }
    const sixth = await sendPin(ivo, { externalId: ext, gamePin: GAME_PIN })
    assert.equal(sixth.status, 429, sixth.text)
    assert.equal(sixth.json.code, 'OV_MAIL_LIMIT', 'the app says "too many emails", never "sent"')
    assert.equal(sixth.json.success, false)
    assert.equal(mails().length, before + 5, 'the sixth mail is not sent')
    assert.equal(mails().slice(before).every((m) => m.envelope.to[0].startsWith(`ivy-${run}+`)), true)
    // send-info counts in the same cap (another account's request counter)
    const info = await sendInfo(ivy, { externalId: ext })
    assert.equal(info.status, 429, info.text)
    assert.equal(info.json.code, 'OV_MAIL_LIMIT')
    // the cap is the user mails' own: a password reset of that inbox still goes
    const reset = await api(srv.base, '/api/auth/reset-password', { proto: null, body: { email: ivy.email }, headers: { 'cf-connecting-ip': nextIp() } })
    assert.equal(reset.status, 200, reset.text)
    await smtp.waitForMail((m) => m.envelope.to.includes(ivy.email) && /password/i.test(m.subject))
    // other inboxes are not affected
    assert.equal((await sendPin(await editorOf(ext), { externalId: ext, gamePin: GAME_PIN })).status, 200)
    const out = srv.output.join('')
    assert.match(out, /\[mail\] 5 user mails per hour to one inbox reached; mail to iv\*\*\*@example\.ch dropped/)
    assert.equal(out.includes(box), false, 'the inbox is in the log')
  })

  it('the log names neither the PIN nor an address, a failed send included', async () => {
    const rex = await editorOf(ext)
    rejected.add(rex.email)
    const r = await sendPin(rex, { externalId: ext, gamePin: GAME_PIN })
    assert.equal(r.status, 500, r.text)
    assert.equal(r.text.includes(rex.email), false)
    const info = await sendInfo(rex, { externalId: ext })
    assert.equal(info.status, 500, info.text)
    const out = srv.output.join('')
    assert.match(out, /\[Match PIN Email\] send failed req=[0-9a-f]+ reason=EENVELOPE\/550/)
    assert.match(out, /\[Match Email\] send failed req=[0-9a-f]+ reason=EENVELOPE\/550/)
    assert.equal(out.includes(GAME_PIN), false, 'the PIN is in the log')
    for (const u of [...Object.values(users), rex]) assert.equal(out.includes(u.email), false, `${u.email} is in the log`)
  })

  it('without SMTP: Resend (RESEND_API_KEY), as before', async () => {
    const resend = await bootServer(serverEnv({ ...NO_SMTP, RESEND_API_KEY: 'example-resend-key' }))
    try {
      assert.match(resend.output.join(''), /\[Mail\] account emails off/)
      const before = mails().length
      const editor = await editorOf(ext)
      const r = await sendPin(editor, { externalId: ext, gamePin: GAME_PIN }, nextIp(), resend.base)
      assert.equal(r.status, 200, r.text)
      const info = await sendInfo(editor, { externalId: ext }, nextIp(), resend.base)
      assert.equal(info.status, 200, info.text)
      const sent = resendMails()
      assert.equal(sent.length, 2)
      assert.deepEqual(sent.map((m) => m.to), [[editor.email], [editor.email]])
      assert.equal(sent[0].authorization, 'Bearer example-resend-key')
      assert.match(sent[0].subject, /^Game 991501 eScoresheet: game PIN$/)
      assert.ok(sent[0].text.includes(`Game PIN: ${GAME_PIN}`))
      assert.equal(sent[1].subject, 'Game 991501 eScoresheet')
      assert.equal(mails().length, before, 'nothing over SMTP')
    } finally {
      await resend.stop()
    }
  })

  it('503 without a mailer (neither SMTP nor Resend), after the session check', async () => {
    const noMail = await bootServer(serverEnv({ ...NO_SMTP, RESEND_API_KEY: '' }))
    try {
      assert.equal((await sendPin(null, { externalId: ext, gamePin: GAME_PIN }, nextIp(), noMail.base)).status, 401)
      assert.equal((await sendPin(users.alice, { externalId: ext, gamePin: GAME_PIN }, nextIp(), noMail.base)).status, 503)
      assert.equal((await sendInfo(users.alice, { externalId: ext }, nextIp(), noMail.base)).status, 503)
    } finally {
      await noMail.stop()
    }
  })
})
