/**
 * SEC-32 (audit 26.11): wrong approval PINs must not let a scorer send
 * "approval PIN locked" mails carrying its own team names to any PIN holder,
 * nor use up the budget of the "your approval PIN was used" alerts.
 *   - a lock or block notice names the game by its number and the
 *     schedule's team names, never the names the scoring side typed;
 *   - a lock notice goes to one approver at most once an hour (a block
 *     notice always goes);
 *   - the lock and block notices have their own hourly budget (pin_lock):
 *     used up, the "your PIN was used" alert still goes (security);
 *   - a caller that typed PIN_CALLER_DAY_MAX wrong PINs within a day, for
 *     whichever officials, sends no approval until the oldest is a day old;
 *   - the sender's self-chosen name in an approval mail is letters, spaces
 *     and hyphens only (SEC-34).
 *
 * lib/approvals.js on Postgres with the real mailer (lib/mailer.js) over the
 * local fake SMTP sink. Needs PG_TEST_URL (see tests/helpers/pgTestDb.js).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { createAccessResolver } from '../lib/access.js'
import { createAuth } from '../lib/auth.js'
import { createMailer } from '../lib/mailer.js'
import { createApprovals, PIN_CALLER_DAY_MAX, PIN_LOCK_EVERY, LOCK_NOTICE_EVERY_MS } from '../lib/approvals.js'
import { SKIP_PG, SCHEMA_SQL, createTestDatabase, quietLogger } from './helpers/pgTestDb.js'
import { startFakeSmtp, SMTP_USER, SMTP_PASS } from './helpers/fakeSmtp.js'

const SESSIONS_SQL = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'db', '002_app_sessions.sql'), 'utf8')
const SECRET = 'y'.repeat(40)
const PW = 'Pw-correct-9d2f'
const SETS = [[1, 25, 20], [2, 23, 25], [3, 25, 18], [4, 25, 22]]
const LURE_HOME = 'Security notice: confirm your PIN at'
const LURE_AWAY = 'ov-pin-check (dot) ch today'

describe('the approval notices\' budgets (mailer, stub transport)', () => {
  const silent = { log () {}, warn () {}, error () {} }
  const stubMailer = (o = {}) => createMailer({ transport: { async sendMail () {}, close () {} }, from: 'x <x@example.test>', logger: silent, ...o })
  const lockVars = { game: '#1', until: '01.01.2027 10:00', disabled: false }

  it('lock notices used up leave the "your PIN was used" alerts their whole budget', async () => {
    const m = stubMailer({ budgets: { pin_lock: 3, security: 3 } })
    for (let i = 0; i < 3; i++) assert.deepEqual(await m.send('approval_pin_locked', { to: `ref${i}@example.ch`, link: 'https://x.test', vars: lockVars }), { sent: true })
    assert.deepEqual(await m.send('approval_pin_locked', { to: 'ref9@example.ch', link: 'https://x.test', vars: lockVars }), { sent: false, skipped: 'budget' })
    for (let i = 0; i < 3; i++) assert.deepEqual(await m.send('approval', { to: `ref${i}@example.ch`, link: 'https://x.test', vars: {} }), { sent: true })
  })

  it('per inbox and hour: 10 "your PIN was used" alerts, 2 lock or block notices', async () => {
    let t = 0
    const m = stubMailer({ now: () => t })
    for (let i = 0; i < 10; i++) assert.equal((await m.send('approval', { to: 'ref@example.ch', link: 'https://x.test', vars: {} })).sent, true)
    assert.deepEqual(await m.send('approval', { to: 'REF+tag@example.ch', link: 'https://x.test', vars: {} }), { sent: false, skipped: 'inbox' })
    assert.equal((await m.send('approval', { to: 'other@example.ch', link: 'https://x.test', vars: {} })).sent, true)
    for (let i = 0; i < 2; i++) assert.equal((await m.send('approval_pin_locked', { to: 'ref@example.ch', link: 'https://x.test', vars: lockVars })).sent, true)
    assert.equal((await m.send('approval_pin_locked', { to: 'ref@example.ch', link: 'https://x.test', vars: lockVars })).skipped, 'inbox')
    t += 60 * 60 * 1000
    assert.equal((await m.send('approval', { to: 'ref@example.ch', link: 'https://x.test', vars: {} })).sent, true, 'a new hour')
  })
})

describe('approval PIN lock notices (SEC-32)', { skip: SKIP_PG }, () => {
  let tdb, pool, access, auth, approvals, smtp, mailer
  let clock = Date.now()
  const U = {}
  let gameSeq = 93000
  let pinSeq = 100000
  const logger = quietLogger()
  const mailsTo = (email) => smtp.mails.filter((m) => m.envelope.to.includes(email.toLowerCase()))

  async function user (name, roles, { first = name, last = 'Test', pin } = {}) {
    const id = randomUUID()
    const email = `${name.toLowerCase()}-${randomBytes(3).toString('hex')}@example.ch`
    await pool.query('INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at) VALUES ($1, $2, $3, now())', [id, email, await auth._hashPassword(PW)])
    await pool.query('INSERT INTO public.profiles (user_id, first_name, last_name, roles) VALUES ($1, $2, $3, $4)', [id, first, last, roles])
    U[name] = { id, email, pin }
    if (pin) {
      const r = await approvals.setPin({ userId: id, body: { password: PW, pin } })
      assert.equal(r.status, 200, `${name}: ${JSON.stringify(r.body)}`)
    }
    return U[name]
  }
  /** An ended match of `owner` in the schedule (Alpha H1 – Beta H1) whose teams the scorer renamed to the lure, `official` named as 1st referee. */
  async function lureMatch (owner, official) {
    const gameN = gameSeq++
    await pool.query("INSERT INTO public.svrz_games (game_number, datetime, team_home, team_away) VALUES ($1, '2026-11-23T18:00:00', 'Alpha H1', 'Beta H1')", [String(gameN)])
    const ext = `lock_${gameN}_${randomBytes(2).toString('hex')}`
    const { rows: [m] } = await pool.query(
      `INSERT INTO public.matches (external_id, status, created_by, sport_type, game_n, home_team, away_team, officials)
       VALUES ($1, 'ended', $2, 'indoor', $3, $4, $5, $6) RETURNING id`,
      [ext, U[owner].id, gameN, { name: LURE_HOME }, { name: LURE_AWAY }, JSON.stringify([{ role: '1st referee', email: U[official].email }])])
    for (const [index, h, a] of SETS) await pool.query('INSERT INTO public.sets (match_id, index, home_points, away_points, sport_type, finished) VALUES ($1, $2, $3, $4, $5, true)', [m.id, index, h, a, 'indoor'])
    return { id: m.id, ext, gameN }
  }
  const approve = async (caller, m, official, pin) => approvals.approve({
    callerId: U[caller].id, access: await access.get(U[caller].id),
    body: { external_id: m.ext, slot: 'referee1', email: U[official].email, pin, result: { sets: SETS } }, ip: '203.0.113.7'
  })
  async function wrongPins (caller, m, official, n = PIN_LOCK_EVERY) {
    for (let i = 0; i < n; i++) {
      const r = await approve(caller, m, official, String(pinSeq++))
      assert.equal(r.body.error?.code, 'OV_APPROVAL_PIN_INVALID', JSON.stringify(r.body))
    }
    await approvals.settle()
  }

  before(async () => {
    tdb = await createTestDatabase('mail_locknotices', { schemaSql: SCHEMA_SQL + '\n' + SESSIONS_SQL })
    pool = new pg.Pool({ connectionString: tdb.url, options: '-c TimeZone=UTC', max: 8 })
    access = createAccessResolver({ pool, ttlMs: 0 })
    auth = createAuth({ pool, bcryptCost: 4, logger })
    smtp = await startFakeSmtp({ implicitTls: true })
    mailer = createMailer({
      host: 'localhost', port: smtp.port, secure: true, user: SMTP_USER, pass: SMTP_PASS, from: 'OpenVolley <noreply@example.test>',
      managerUrl: 'https://manager.example.test', tls: { ca: smtp.ca }, logger, budgets: { pin_lock: 2, security: 50 }, now: () => clock
    })
    approvals = createApprovals({ pool, auth, secret: SECRET, mailer, logger, now: () => clock })
    for (let i = 1; i <= 6; i++) await user(`scorer${i}`, ['scorer'], { first: `Scorer${i}` })
    await user('ref', ['referee'], { first: 'Rita', last: 'Ref', pin: '482917' })
    await user('ref2', ['referee'], { first: 'Remo', last: 'Zweit', pin: '730164' })
    await user('ref3', ['referee'], { first: 'Rosa', last: 'Dritt', pin: '615038' })
    await user('ref4', ['referee'], { first: 'Ruth', last: 'Viert', pin: '864297' })
  })
  after(async () => {
    mailer?.close()
    await smtp?.close?.()
    await pool?.end().catch(() => {})
    await tdb?.drop()
  })

  it('the lock notice names the game by its number and the schedule\'s teams, never the scorer\'s typed names', async () => {
    const m = await lureMatch('scorer1', 'ref')
    await wrongPins('scorer1', m, 'ref')
    const mails = mailsTo(U.ref.email)
    assert.equal(mails.length, 1)
    assert.equal(mails[0].subject, 'Your OpenVolley approval PIN was locked')
    assert.ok(mails[0].text.includes(`while approving #${m.gameN} Alpha H1 – Beta H1.`), mails[0].text)
    assert.doesNotMatch(mails[0].text, /Security notice|ov-pin-check/)
  })

  it('a second lock of the same approver within the hour sends no second notice; after the hour it does', async () => {
    const m = await lureMatch('scorer2', 'ref')
    await wrongPins('scorer2', m, 'ref')
    assert.equal(mailsTo(U.ref.email).length, 1, 'still one: at most one lock notice an hour')
    clock += LOCK_NOTICE_EVERY_MS + 60 * 1000
    const m3 = await lureMatch('scorer3', 'ref')
    await wrongPins('scorer3', m3, 'ref')
    assert.equal(mailsTo(U.ref.email).length, 2, 'the next hour: a notice again')
  })

  it('a blocked PIN is told even within the hour of a lock notice', async () => {
    // ref already has 15 failures from three callers: the 20th (a fourth caller) blocks it
    const m = await lureMatch('scorer4', 'ref')
    await wrongPins('scorer4', m, 'ref')
    const mails = mailsTo(U.ref.email)
    assert.equal(mails.length, 3)
    assert.equal(mails.at(-1).subject, 'Your OpenVolley approval PIN was blocked')
    assert.ok(mails.at(-1).text.includes(`while approving #${m.gameN} Alpha H1 – Beta H1.`))
  })

  it('the lock notices have their own budget: used up, "your PIN was used" still goes', async () => {
    // pin_lock is 2 an hour here: ref's lock and block notices of this hour used it up
    const m = await lureMatch('scorer5', 'ref2')
    await wrongPins('scorer5', m, 'ref2')
    assert.equal(mailsTo(U.ref2.email).length, 0, 'the lock notice is dropped: its budget is used up')
    assert.ok(logger.lines.some((l) => /hourly pin_lock budget \(2\) used up/.test(l)))
    // an approval with ref3's own PIN: its alert is on the security budget
    const ok = await lureMatch('scorer6', 'ref3')
    const r = await approve('scorer6', ok, 'ref3', U.ref3.pin)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    await approvals.settle()
    const [alert] = mailsTo(U.ref3.email)
    assert.ok(alert, 'the alert of a PIN that was used is mailed')
    assert.match(alert.subject, /^Your approval PIN was used: /)
    assert.ok(alert.text.includes(`#${ok.gameN}`))
  })

  it(`a caller with ${PIN_CALLER_DAY_MAX} wrong PINs within a day, whichever officials: 429 for now, also with a right PIN; another caller is not held`, async () => {
    const caller = await user('roguescorer', ['scorer'], { first: 'Rogue' })
    // its wrong PINs of the last day, for other officials (as countFailure writes them)
    for (let i = 0; i < PIN_CALLER_DAY_MAX; i++) {
      await pool.query(`INSERT INTO public.audit_log (actor_id, action, target_user_id, details, at) VALUES ($1, 'approval_pin.failed', $2, '{"failures":1}', now() - interval '2 hours')`,
        [caller.id, U.ref3.id])
    }
    const m = await lureMatch('roguescorer', 'ref4')
    const r = await approve('roguescorer', m, 'ref4', U.ref4.pin)
    assert.equal(r.status, 429, JSON.stringify(r.body))
    assert.equal(r.body.error.code, 'OV_TOO_MANY_ATTEMPTS')
    assert.ok(Number(r.headers['Retry-After']) > 20 * 3600, 'until the oldest is a day old')
    const wrong = await approve('roguescorer', m, 'ref4', '111111')
    assert.equal(wrong.status, 429, 'a wrong PIN is not counted either')
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM public.audit_log WHERE action = 'approval_pin.failed' AND actor_id = $1", [caller.id])).rows[0].n, PIN_CALLER_DAY_MAX)
    // a day later the caller may again
    await pool.query("UPDATE public.audit_log SET at = now() - interval '25 hours' WHERE actor_id = $1 AND action = 'approval_pin.failed'", [caller.id])
    assert.equal((await approve('roguescorer', m, 'ref4', U.ref4.pin)).status, 200)
  })

  it('the sender\'s self-chosen name in an approval mail: no link, letters, spaces and hyphens only (SEC-34)', async () => {
    const caller = await user('lurer', ['scorer'], { first: 'Club office: pay at', last: 'evil.example/pay +41 79 000' })
    const m = await lureMatch('lurer', 'ref2')
    assert.equal((await approve('lurer', m, 'ref2', U.ref2.pin)).status, 200)
    await approvals.settle()
    const [mail] = mailsTo(U.ref2.email).filter((x) => /was used/.test(x.subject))
    assert.ok(mail)
    const line = mail.text.split(/\r?\n/).find((l) => l.startsWith('Sent by the account of'))
    assert.equal(line, 'Sent by the account of Club office pay at.')
    assert.ok(caller)
  })
})
