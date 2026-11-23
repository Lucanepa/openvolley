/**
 * SEC-11 (audit 26.11, owner decision 4): the final mail must not turn into a
 * relay for the scorer's own text. The accounts of the close, confirmed
 * accounts and the clubs' contacts get it as before (the technical remarks
 * included); an address typed in the match setup that belongs to no account
 * gets the official mail and the PDF with a fixed text: no technical
 * remarks, the schedule's team names (outside the schedule: the typed names
 * without links) and the result only as a score. The sweep mails at most
 * MAX_TYPED_PER_CLOSER_DAY typed addresses per closing account and day; an
 * admin's closes are not capped.
 *
 * The sweep on a real database, the real mailer (lib/mailer.js) over the
 * local fake SMTP sink. Needs PG_TEST_URL (see tests/helpers/pgTestDb.js).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP_PG, createTestDatabase, grantRoles, quietLogger } from './helpers/pgTestDb.js'
import { startFakeSmtp, SMTP_USER, SMTP_PASS } from './helpers/fakeSmtp.js'
import { createMailer } from '../lib/mailer.js'
import { createFinalMail, MAX_TYPED_PER_CLOSER_DAY, linkFreeText, plainResult } from '../lib/finalMail.js'

const PDF = Buffer.from('%PDF-1.4\n% final scoresheet\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n')
const LURE = 'ACTION REQUIRED: your Swiss Volley licence expires today. Pay the CHF 45 renewal at swissvolley-licence dot ch/pay'

describe('final mail: typed addresses (unit)', () => {
  it('typed team names lose links and addresses, keep what a team name is', () => {
    assert.equal(linkFreeText('VBC St. Gallen H1'), 'VBC St. Gallen H1')
    assert.equal(linkFreeText('Gamma H1 visit https://evil.example/pay now'), 'Gamma H1 visit now')
    assert.equal(linkFreeText('Gamma pay at evil.example/x or evil。example or pay@evil.example'), 'Gamma pay at or or')
    assert.equal(linkFreeText('Delta www.evil.example H1'), 'Delta H1')
    assert.equal(linkFreeText('x'.repeat(200)).length, 80)
  })
  it('the result only as a score', () => {
    assert.equal(plainResult('3-1'), '3-1')
    assert.equal(plainResult('3:2'), '3:2')
    assert.equal(plainResult('3-1 call +41 79 000 00 00'), '')
    assert.equal(plainResult(null), '')
  })
})

describe('final mail: typed addresses get the fixed text, capped per closing account (SEC-11)', { skip: SKIP_PG }, () => {
  let db, sql, pool, fm, smtp, mailer
  let clock = Date.now()
  const minutes = (n) => n * 60 * 1000
  const ts = (ms) => new Date(ms).toISOString()
  const pdfs = new Map()
  const audits = []
  const scoresheets = { async latestPdf (m) { return pdfs.get(m.id) ?? null } }
  const people = {}
  const logger = quietLogger()
  let gameSeq = 970000
  const mailsTo = (to, game) => smtp.mails.filter((m) => m.envelope.to.includes(to) && (!game || m.text.includes(String(game))))

  async function person (name, { roles, confirmed = true } = {}) {
    const email = `${name}@example.ch`
    const { rows: [u] } = await sql.query(
      'INSERT INTO auth.users (email, email_confirmed_at) VALUES ($1, $2) RETURNING id', [email, confirmed ? ts(clock) : null])
    if (roles) await grantRoles(sql, u.id, roles)
    people[name] = { id: u.id, email }
    return people[name]
  }
  async function replica (fn) {
    await sql.query('SET session_replication_role = replica')
    try { return await fn() } finally { await sql.query('SET session_replication_role = origin') }
  }
  /** An official match closed 3 minutes ago by `by`, of the technical-remarks model, with the lure in its correction log. */
  async function closed ({ gameN, by = people.scorer, home = 'Alpha H1', away = 'Beta H1', officials = [], scheduled = true, finalScore = '3-1' }) {
    if (scheduled) {
      await sql.query('INSERT INTO public.svrz_games (game_number, datetime, team_home, team_away) VALUES ($1, $2, $3, $4)',
        [String(gameN), ts(clock).slice(0, 19), 'Alpha H1', 'Beta H1'])
    }
    const id = await replica(async () => {
      const { rows: [m] } = await sql.query(
        `INSERT INTO public.matches (external_id, status, game_n, scheduled_at, home_team, away_team, officials, created_by, closed_by, closed_at,
                                     match_info, manual_changes, final_score)
         VALUES ($1, 'final', $2, $3, $4, $5, $6, $7, $7, $8::timestamptz + interval '123 microseconds', $9, $10, $11) RETURNING id`,
        [`match_${randomBytes(6).toString('hex')}`, gameN, ts(clock - minutes(90)), { name: home }, { name: away }, JSON.stringify(officials),
          by.id, ts(clock - minutes(3)), JSON.stringify({ league: '3L A', remarks_model: 2 }),
          JSON.stringify([{ ts: ts(clock - minutes(20)), category: 'technical', text: LURE }]), finalScore])
      return m.id
    })
    pdfs.set(id, { data: PDF, filename: 'Scoresheet.pdf', mtimeMs: clock })
    return id
  }
  const strangers = (n) => [
    { role: '1st referee', email: `stranger-ref-${n}@outside.example` },
    { role: '2nd referee', email: `stranger-ref2-${n}@outside.example` },
    { role: 'team contact', team: 'home', email: `stranger-home-${n}@outside.example` },
    { role: 'team contact', team: 'away', email: `stranger-away-${n}@outside.example` }
  ]

  before(async () => {
    db = await createTestDatabase('mail_typed')
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    pool = new pg.Pool({ connectionString: db.url, max: 4 })
    smtp = await startFakeSmtp({ implicitTls: true })
    mailer = createMailer({ host: 'localhost', port: smtp.port, secure: true, user: SMTP_USER, pass: SMTP_PASS, from: 'OpenVolley <noreply@example.test>', tls: { ca: smtp.ca }, logger })
    fm = createFinalMail({ pool, mailer, scoresheets, audit: async (_c, entry) => { audits.push(entry) }, logger, now: () => clock })
    await person('scorer', { roles: ['scorer'] })
    await person('scorer2', { roles: ['scorer'] })
    await person('admin', { roles: ['admin'] })
    await person('refaccount', { roles: ['referee'] })
    await person('unconfirmed', { roles: ['referee'], confirmed: false })
    const { rows: [a] } = await sql.query("INSERT INTO public.clubs (name, contact_email) VALUES ('Alpha club', 'contact@alpha.example.ch') RETURNING id")
    const { rows: [b] } = await sql.query("INSERT INTO public.clubs (name, contact_email) VALUES ('Beta club', 'contact@beta.example.ch') RETURNING id")
    await sql.query("INSERT INTO public.club_teams (club_id, team_name) VALUES ($1, 'Alpha H1'), ($2, 'Beta H1')", [a.id, b.id])
    await sql.query('UPDATE public.app_settings SET send_final_email = true, changed_at = $1', [ts(clock - minutes(24 * 60))])
  })
  after(async () => {
    mailer?.close()
    await smtp?.close?.()
    await pool?.end().catch(() => {})
    await sql?.end().catch(() => {})
    await db?.drop()
  })

  it('accounts and club contacts get the technical remarks; a typed address of no account the fixed text and the PDF', async () => {
    const gameN = ++gameSeq
    await closed({
      gameN,
      officials: [
        { role: '1st referee', email: 'stranger-ref@outside.example' },
        { role: '2nd referee', email: people.refaccount.email }, // a confirmed account: as before
        { role: 'team contact', team: 'home', email: 'stranger-home@outside.example' },
        { role: 'team contact', team: 'away', email: people.unconfirmed.email } // an unconfirmed account: a stranger
      ]
    })
    await fm.sweep()
    for (const to of [people.scorer.email, people.refaccount.email, 'contact@alpha.example.ch', 'contact@beta.example.ch']) {
      const [mail] = mailsTo(to, gameN)
      assert.ok(mail, `${to} mailed`)
      assert.match(mail.text, /Technical remarks \(not printed on the scoresheet\):/, to)
      assert.ok(mail.text.includes('ACTION REQUIRED'), `${to}: the remarks as today`)
    }
    for (const to of ['stranger-ref@outside.example', 'stranger-home@outside.example', people.unconfirmed.email]) {
      const mails = mailsTo(to, gameN)
      assert.equal(mails.length, 1, `${to} mailed once`)
      const [mail] = mails
      assert.equal(mail.subject, 'Scoresheet: Alpha H1 – Beta H1', 'the official mail, the schedule\'s names')
      assert.match(mail.raw, /application\/pdf/, 'with the PDF')
      assert.ok(mail.raw.includes(PDF.toString('base64').slice(0, 60)))
      assert.doesNotMatch(mail.text, /Technical remarks|ACTION REQUIRED|licence/, `${to}: none of the scorer's text`)
      assert.match(mail.text, /Result: 3-1/)
    }
  })

  it('outside the schedule: a typed address gets the typed team names without links, and no free-text result', async () => {
    const gameN = ++gameSeq
    await closed({
      gameN,
      scheduled: false,
      home: 'Gamma H1 pay at https://evil.example/pay',
      away: 'Delta H1 (evil。example)',
      finalScore: '3-1, call +41 79 000 00 00',
      officials: [{ role: 'team contact', team: 'home', email: 'stranger-offschedule@outside.example' }]
    })
    await fm.sweep()
    const [typed] = mailsTo('stranger-offschedule@outside.example', gameN)
    assert.ok(typed, 'mailed')
    assert.equal(typed.subject, 'Scoresheet: Gamma H1 pay at – Delta H1')
    assert.doesNotMatch(typed.text, /evil|https|\+41|Result:/)
    const [own] = mailsTo(people.scorer.email, gameN)
    assert.ok(own.text.includes('ACTION REQUIRED'), 'the scorer\'s own account as today')
  })

  it(`at most ${MAX_TYPED_PER_CLOSER_DAY} typed addresses a day per closing account; the accounts and club contacts are not capped; a new day mails them again`, async () => {
    const per = 4
    const full = Math.floor(MAX_TYPED_PER_CLOSER_DAY / per)
    const games = []
    for (let i = 0; i < full + 1; i++) {
      const gameN = ++gameSeq
      games.push(gameN)
      await closed({ gameN, by: people.scorer2, officials: strangers(gameN) })
    }
    await fm.sweep()
    const typedOf = (gameN) => strangers(gameN).filter((o) => mailsTo(o.email, gameN).length).length
    // the sweep takes closes of the same time in id order: whichever comes last is over the cap
    assert.equal(games.reduce((n, g) => n + typedOf(g), 0), MAX_TYPED_PER_CLOSER_DAY, 'the day\'s typed addresses: the cap')
    const over = games.filter((g) => typedOf(g) < per)
    assert.equal(over.length, 1, 'one close over the cap')
    const last = over[0]
    assert.equal(typedOf(last), 0, 'its typed addresses left out')
    assert.equal(mailsTo(people.scorer2.email, last).length, 1, 'the closing account itself still gets it')
    assert.equal(mailsTo('contact@alpha.example.ch', last).length, 1, 'the club contacts still get it')
    assert.ok(audits.some((a) => a.action === 'match.final_mail' && a.details.game_n === last && a.details.capped === per), 'counted in the audit entry')
    assert.ok(logger.lines.some((l) => /typed address\(es\) left out/.test(l)))
    // the next day: the closing account's typed addresses go out again
    clock += 24 * 60 * minutes(1) + minutes(1)
    const next = ++gameSeq
    await closed({ gameN: next, by: people.scorer2, officials: strangers(next) })
    await fm.sweep()
    assert.equal(typedOf(next), per)
  })

  it('an admin\'s closes are not capped', async () => {
    const per = 4
    const games = []
    for (let i = 0; i < Math.floor(MAX_TYPED_PER_CLOSER_DAY / per) + 1; i++) {
      const gameN = ++gameSeq
      games.push(gameN)
      await closed({ gameN, by: people.admin, officials: strangers(gameN) })
    }
    await fm.sweep()
    for (const g of games) assert.equal(strangers(g).filter((o) => mailsTo(o.email, g).length).length, per, `game ${g}`)
  })
})
