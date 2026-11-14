/**
 * The final scoresheet by email (db/021 + db/040, lib/finalMail.js;
 * ~/ov-ops/club-manager-home-email-PLAN.md step 4).
 *
 * The sweep on a real database with a fake mailer and storage: one state
 * machine per close (a mail the budget holds back is deferred and sent later
 * to whoever it missed, failed sends are tried again and then recorded as
 * failed), the PDF of the close's approval (also one stored long before the
 * close; after an admin reopen only one stored since; after the grace the
 * mail goes without it, the scorer and the admins are told, and the PDF
 * follows on its own), the officials of a reopened close are told, a close
 * still waiting holds back no other, released and numberless matches are not
 * mailed, the clubs come from the schedule's teams and only real PDFs are
 * attached.
 *
 * End to end over a fake SMTP server: the switch (admins and competition
 * managers, off by default), the mail of a closed official match to the
 * scorer, a referee's typed address and the clubs' contacts with the PDF
 * attached, once, each account's in the language of its sign-up and the
 * other addresses in English; a reopened and closed again match as
 * "corrected" with the new approval's PDF; nothing while the switch is off
 * or for matches closed before it was turned on; release-game; a test
 * match's PDF to its scorer only (a confirmed address and the scorer role,
 * its own budget).
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js) or OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { SKIP_PG, createTestDatabase, grantRoles, quietLogger } from './helpers/pgTestDb.js'
import { startFakeSmtp } from './helpers/fakeSmtp.js'
import * as finalMail from '../lib/finalMail.js'

const { createFinalMail, recipientList, refereeAddresses, zurichDate } = finalMail
const PDF = Buffer.from('%PDF-1.4\n% final scoresheet\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n')
const PDF_V2 = Buffer.from('%PDF-1.4\n% corrected scoresheet, the second approval\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n')

describe('final mail (unit)', () => {
  it('recipients: distinct valid addresses, lower-case, at most twelve', () => {
    assert.deepEqual(recipientList(['A@x.ch', 'a@x.ch ', 'nope', null, 'b@y.ch']), ['a@x.ch', 'b@y.ch'])
    assert.equal(recipientList(Array.from({ length: 20 }, (_, i) => `p${i}@x.ch`)).length, 12)
  })
  it('the referees\' typed addresses only (not the scorer\'s, not line judges), one per referee', () => {
    assert.deepEqual(refereeAddresses([
      { role: '1st referee', email: 'r1@x.ch' }, { role: '2nd referee' }, { role: 'scorer', email: 's@x.ch' }, { role: 'line judge 1', name: 'L' }
    ]), ['r1@x.ch'])
    assert.deepEqual(refereeAddresses([
      { role: '1st referee', email: 'r1@x.ch' }, { role: '1st referee', email: 'other@x.ch' }, { role: '2nd referee', email: 'r2@x.ch' }, { role: '2nd referee', email: 'more@x.ch' }
    ]), ['r1@x.ch', 'r2@x.ch'])
    assert.deepEqual(refereeAddresses(null), [])
  })
  it('the date in Zurich', () => {
    assert.equal(zurichDate('2026-10-29T23:30:00Z'), '30.10.2026')
    assert.equal(zurichDate(null), '')
  })
  it('only a real PDF is attached: the PDF header, an end marker, a size a mail carries', () => {
    const isMailablePdf = finalMail.isMailablePdf
    assert.equal(typeof isMailablePdf, 'function')
    assert.equal(isMailablePdf(PDF), true)
    assert.equal(isMailablePdf(Buffer.from('NOT-A-PDF forged: result 0:3')), false)
    assert.equal(isMailablePdf(Buffer.from('%PDF-1.4\n truncated upload')), false)
    assert.equal(isMailablePdf(Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(11 * 1024 * 1024, 32), Buffer.from('%%EOF\n')])), false)
    assert.equal(isMailablePdf(null), false)
  })
})

describe('final mail sweep: one state machine per close (database, fake mailer and storage)', { skip: SKIP_PG }, () => {
  let db, sql, pool, fm
  let clock = Date.now()
  const minutes = (n) => n * 60 * 1000
  const ts = (ms) => new Date(ms).toISOString()
  const GRACE_MS = finalMail.PDF_GRACE_MS ?? finalMail.NO_PDF_AFTER_MS
  const mails = []
  const audits = []
  const pdfs = new Map() // match id -> { data, filename, mtimeMs }
  let refuse = null // (kind, to, vars) -> 'budget' | 'throw' | null
  const mailer = {
    enabled: true,
    async send (kind, { to, lang, vars, attachments } = {}) {
      const r = refuse?.(kind, to, vars)
      if (r === 'budget') return { sent: false, skipped: 'budget' }
      if (r === 'throw') throw Object.assign(new Error('421 4.7.0 try again later'), { code: 'EENVELOPE' })
      mails.push({ kind, to, lang, vars, attachments: attachments || [] })
      return { sent: true }
    }
  }
  const scoresheets = { async latestPdf (m) { return pdfs.get(m.id) ?? null } }
  const of = (game, kind = 'scoresheet') => mails.filter((m) => m.kind === kind && m.vars?.game === String(game))
  const outcomeOf = async (id) => (await sql.query(
    `SELECT outcome, recipients, to_jsonb(f) -> 'attempts' AS attempts, coalesce(jsonb_array_length(to_jsonb(f) -> 'delivered'), 0) AS held
       FROM public.match_final_mails f WHERE match_id = $1 ORDER BY closed_at DESC LIMIT 1`, [id])).rows[0]
  const people = {}

  async function person (name, { roles, lang } = {}) {
    const email = `${name}@example.ch`
    const { rows: [u] } = await sql.query(
      'INSERT INTO auth.users (email, email_confirmed_at, raw_user_meta_data) VALUES ($1, now(), $2) RETURNING id', [email, lang ? { mail_lang: lang } : {}])
    if (roles) await grantRoles(sql, u.id, roles)
    people[name] = { id: u.id, email }
    return people[name]
  }
  async function club (name, teams, contact) {
    const { rows: [c] } = await sql.query('INSERT INTO public.clubs (name, contact_email) VALUES ($1, $2) RETURNING id', [name, contact])
    for (const t of teams) await sql.query('INSERT INTO public.club_teams (club_id, team_name) VALUES ($1, $2)', [c.id, t])
  }
  const scheduled = (gameN, home, away) => sql.query(
    'INSERT INTO public.svrz_games (game_number, datetime, team_home, team_away) VALUES ($1, $2, $3, $4)', [String(gameN), ts(clock).slice(0, 19), home, away])
  // The triggers off (superuser, these statements only): rows at the times of
  // the test's clock, as the guards would write them
  async function replica (fn) {
    await sql.query('SET session_replication_role = replica')
    try { return await fn() } finally { await sql.query('SET session_replication_role = origin') }
  }
  /** An official indoor match closed `closedMinAgo` minutes ago (test clock) by people.scorer. */
  async function closed ({ gameN, closedMinAgo = 5, home = 'Alpha H1', away = 'Beta H1', officials = [], exempt = false, released = false }) {
    return replica(async () => {
      const { rows: [m] } = await sql.query(
        `INSERT INTO public.matches (external_id, status, game_n, scheduled_at, home_team, away_team, officials, created_by, closed_by, closed_at, official_game_exempt, released_at)
         VALUES ($1, 'final', $2, $3, $4, $5, $6, $7, $7, $8::timestamptz + interval '123 microseconds', $9, $10) RETURNING id`,
        [`match_${randomBytes(6).toString('hex')}`, gameN, ts(clock - minutes(90)), { name: home }, { name: away }, JSON.stringify(officials),
          people.scorer.id, ts(clock - minutes(closedMinAgo)), exempt, released ? ts(clock - minutes(60)) : null])
      return m.id
    })
  }
  const approve = (matchId, slot, who) => replica(() => sql.query(
    `INSERT INTO public.match_approvals (match_id, slot, user_id, display_name, approved_at, match_status, result_key, result_hash)
     VALUES ($1, $2, $3, 'Official', $4, 'ended', '3:0', $5)`, [matchId, slot, who.id, ts(clock - minutes(30)), createHash('sha256').update('3:0').digest()]))
  // An admin reopen as lib/accounts.js reopenMatch and db/011's trigger write it, at the test's clock
  const reopen = (matchId) => replica(async () => {
    await sql.query("UPDATE public.matches SET closed_at = NULL, closed_by = NULL, status = 'ended' WHERE id = $1", [matchId])
    await sql.query("UPDATE public.match_approvals SET revoked_at = $2, revoked_reason = 'match_reopened' WHERE match_id = $1 AND revoked_at IS NULL", [matchId, ts(clock)])
    await sql.query(`INSERT INTO public.audit_log (action, match_id, details, at) VALUES ('match.reopen', $1, '{"reason":"wrong final score"}', $2)`, [matchId, ts(clock)])
  })
  const recloseAgo = (matchId, minAgo) => replica(() => sql.query(
    "UPDATE public.matches SET status = 'final', closed_by = $3, closed_at = $2::timestamptz + interval '77 microseconds' WHERE id = $1", [matchId, ts(clock - minutes(minAgo)), people.scorer.id]))
  const storePdf = (matchId, data = PDF, atMs = clock) => pdfs.set(matchId, { data, filename: 'Scoresheet.pdf', mtimeMs: atMs })

  before(async () => {
    db = await createTestDatabase('finalmail_sweep')
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    pool = new pg.Pool({ connectionString: db.url, max: 4 })
    fm = createFinalMail({ pool, mailer, scoresheets, audit: async (_client, entry) => { audits.push(entry) }, logger: quietLogger(), now: () => clock })
    await person('scorer', { roles: ['scorer'], lang: 'de' })
    await person('admin', { roles: ['admin'] })
    await person('ref', { roles: ['referee'], lang: 'fr' })
    await club('Alpha club', ['Alpha H1'], 'contact@alpha.example.ch')
    await club('Beta club', ['Beta H1'], 'contact@beta.example.ch')
    await club('Gamma club', ['Gamma H1'], 'contact@gamma.example.ch')
    await sql.query('UPDATE public.app_settings SET send_final_email = true, changed_at = $1', [ts(clock - minutes(24 * 60))])
  })
  after(async () => {
    await pool?.end().catch(() => {})
    await sql?.end().catch(() => {})
    await db?.drop()
  })

  it('a mail the hourly budget holds back is deferred, then sent to whoever it missed, once', async () => {
    await scheduled(950001, 'Alpha H1', 'Beta H1')
    const id = await closed({ gameN: 950001, officials: [{ role: '1st referee', email: 'rita.ref@example.ch' }] })
    storePdf(id)
    let left = 2
    refuse = (kind, to, vars) => (vars?.game === '950001' && left-- <= 0 ? 'budget' : null)
    await fm.sweep()
    assert.equal(of(950001).length, 2)
    const held = await outcomeOf(id)
    assert.equal(held.outcome, 'deferred', 'never recorded as sent')
    assert.equal(held.recipients, 2)
    assert.equal(held.attempts, 0, 'a budget hold is not a failed try')
    await fm.sweep()
    assert.equal(of(950001).length, 2, 'not before its time')
    refuse = null
    clock += minutes(6)
    await fm.sweep()
    const to = of(950001).map((m) => m.to).sort()
    assert.deepEqual(to, ['contact@alpha.example.ch', 'contact@beta.example.ch', people.scorer.email, 'rita.ref@example.ch'].sort(), 'everyone once')
    assert.ok(of(950001).every((m) => m.attachments.length === 1 && m.attachments[0].content.equals(PDF)))
    const done = await outcomeOf(id)
    assert.deepEqual({ outcome: done.outcome, recipients: done.recipients, held: done.held }, { outcome: 'sent', recipients: 4, held: 0 })
    assert.ok(audits.some((a) => a.action === 'match.final_mail' && a.matchId === id && a.details.recipients === 4))
  })

  it('sends that keep failing are tried again with a pause, then recorded as failed (not sent)', async () => {
    const id = await closed({ gameN: 950002 })
    storePdf(id)
    refuse = (kind, to, vars) => (vars?.game === '950002' ? 'throw' : null)
    for (let i = 0; i < 12; i++) {
      await fm.sweep()
      const r = await outcomeOf(id)
      if (r.outcome !== 'pending') break
      clock += minutes(61)
    }
    refuse = null
    const r = await outcomeOf(id)
    assert.equal(r.outcome, 'failed')
    assert.equal(r.recipients, 0)
    assert.ok(r.attempts >= 5)
    assert.ok(audits.some((a) => a.action === 'match.final_mail' && a.matchId === id && a.details.outcome === 'failed'))
    await fm.sweep()
    assert.equal(of(950002).length, 0)
  })

  it('a PDF stored long before the close is the approval\'s: mailed', async () => {
    await scheduled(950004, 'Alpha H1', 'Beta H1')
    const id = await closed({ gameN: 950004, closedMinAgo: 3 })
    storePdf(id, PDF, clock - minutes(80)) // the close came an hour after its PDF (the club rule held it)
    await fm.sweep()
    assert.equal(of(950004).length, 3)
    assert.ok(of(950004).every((m) => m.attachments.length === 1))
    assert.equal((await outcomeOf(id)).outcome, 'sent')
  })

  it('no PDF within the grace: mailed without it, the scorer and the admins told; the PDF follows once it is stored', async () => {
    await scheduled(950003, 'Alpha H1', 'Beta H1')
    const id = await closed({ gameN: 950003, closedMinAgo: 5 })
    await fm.sweep()
    assert.equal(of(950003).length, 0, 'waiting for the PDF')
    assert.equal((await outcomeOf(id)).outcome, 'pending')
    clock += GRACE_MS
    await fm.sweep()
    const first = of(950003)
    assert.equal(first.length, 3)
    assert.ok(first.every((m) => m.attachments.length === 0 && m.vars.pdf === false), 'without the PDF, and saying so')
    assert.equal((await outcomeOf(id)).outcome, 'sent_no_pdf')
    const told = of(950003, 'scoresheet_no_pdf').map((m) => m.to).sort()
    assert.deepEqual(told, [people.admin.email, people.scorer.email].sort())
    // the laptop comes back online the next morning
    clock += minutes(14 * 60)
    storePdf(id)
    clock += minutes(11)
    await fm.sweep()
    const late = of(950003).filter((m) => m.attachments.length === 1)
    assert.equal(late.length, 3, 'the PDF to everyone')
    assert.ok(late.every((m) => m.vars.late === true && m.attachments[0].content.equals(PDF)))
    assert.equal((await outcomeOf(id)).outcome, 'sent')
    clock += minutes(11)
    await fm.sweep()
    assert.equal(of(950003).length, 6, 'once')
  })

  it('no PDF and one address that always fails: the others were told the PDF follows, so it still does', async () => {
    await scheduled(950013, 'Alpha H1', 'Beta H1')
    const id = await closed({ gameN: 950013, officials: [{ role: '1st referee', email: 'ref@typo.invalid' }] })
    refuse = (kind, to) => (to === 'ref@typo.invalid' ? 'throw' : null)
    await fm.sweep()
    clock += GRACE_MS
    for (let i = 0; i < 12; i++) {
      await fm.sweep()
      clock += minutes(61)
    }
    const r = await outcomeOf(id)
    assert.equal(r.outcome, 'sent_no_pdf')
    const told = of(950013).map((m) => m.to).sort()
    assert.equal(told.length, 3, 'the mail without the PDF, once each')
    assert.ok(of(950013, 'scoresheet_no_pdf').length >= 1, 'the scorer and the admins told')
    storePdf(id)
    clock += minutes(11)
    await fm.sweep()
    const late = of(950013).filter((m) => m.attachments.length === 1).map((m) => m.to).sort()
    assert.deepEqual(late, told, 'the PDF to those told it follows')
    refuse = null
  })

  // A close mailed with the first approval's PDF, its referee and scorer approving by account
  async function mailedClose (gameN) {
    await scheduled(gameN, 'Alpha H1', 'Beta H1')
    const id = await closed({ gameN, closedMinAgo: 5 })
    await approve(id, 'referee1', people.ref)
    await approve(id, 'scorer', people.scorer)
    storePdf(id, PDF, clock - minutes(6))
    await fm.sweep()
    assert.ok(of(gameN).some((m) => m.to === people.ref.email && m.lang === 'fr'), 'the referee who approved, in the language of its sign-up')
    return id
  }

  it('after an admin reopen the corrected mail waits for the new approval\'s PDF, and goes to the officials whose approvals were voided', async () => {
    const id = await mailedClose(950005)
    const firstCount = of(950005).length
    // a quick correction: the old PDF is 11 minutes older than the new close
    clock += minutes(3)
    await reopen(id)
    // corrected and closed again (signatures drawn this time), on a slow uplink: the close first
    clock += minutes(5)
    await recloseAgo(id, 3)
    await fm.sweep()
    assert.equal(of(950005).length, firstCount, 'the old PDF is not the corrected one')
    clock += minutes(2)
    storePdf(id, PDF_V2)
    await fm.sweep()
    const corrected = of(950005).slice(firstCount)
    assert.ok(corrected.length >= 3, `corrected mails: ${corrected.length}`)
    assert.ok(corrected.every((m) => m.vars.corrected === true && m.attachments[0]?.content.equals(PDF_V2)), 'the new approval\'s PDF')
    assert.ok(corrected.some((m) => m.to === people.ref.email), 'the referee whose approval was voided gets the corrected sheet')
  })

  it('an admin reopen of a mailed match: the officials who signed it are told, once', async () => {
    const id = await mailedClose(950015)
    clock += minutes(10)
    await reopen(id)
    await fm.sweep()
    const told = of(950015, 'scoresheet_reopened')
    assert.deepEqual(told.map((m) => m.to).sort(), [people.ref.email, people.scorer.email].sort(), 'the voided approvals\' officials')
    assert.equal(told[0].vars.reason, 'wrong final score')
    clock += minutes(2)
    await fm.sweep()
    assert.equal(of(950015, 'scoresheet_reopened').length, 2, 'told once')
  })

  it('closes still waiting for their PDF hold back no later one', async () => {
    const waiting = []
    for (let i = 0; i < 25; i++) waiting.push(await closed({ gameN: 951001 + i, closedMinAgo: 10 }))
    const id = await closed({ gameN: 950006, closedMinAgo: 3 })
    storePdf(id)
    await fm.sweep()
    assert.equal(of(950006).length, 1, 'mailed in the first sweep')
    // (the closed-match guard off: their rows go first, the cascade is off too)
    await sql.query('DELETE FROM public.match_final_mails WHERE match_id = ANY($1::uuid[])', [waiting])
    await replica(() => sql.query('DELETE FROM public.matches WHERE id = ANY($1::uuid[])', [waiting]))
  })

  it('released and numberless matches are not mailed; an exemption alone (a duplicate found at 007) still is', async () => {
    const released = await closed({ gameN: 950007, exempt: true, released: true })
    const numberless = await closed({ gameN: null, home: 'Friendly', away: 'Other' })
    const exempt = await closed({ gameN: 950017, exempt: true })
    for (const id of [released, numberless, exempt]) storePdf(id)
    await fm.sweep()
    assert.equal(of(950007).length, 0)
    assert.equal(mails.filter((m) => m.vars?.teams?.includes('Friendly')).length, 0)
    assert.equal(of(950017).length, 1)
  })

  it('the clubs of the schedule\'s teams, never of the typed names; typed referee addresses only for a scheduled game, one per referee', async () => {
    await scheduled(950008, 'Alpha H1', 'Beta H1')
    const id = await closed({ gameN: 950008, home: 'Gamma H1', away: 'Beta H1: result annulled, see attachment',
      officials: [{ role: '1st referee', email: 'r1@example.ch' }, { role: '1st referee', email: 'extra1@example.org' }, { role: '2nd referee', email: 'r2@example.ch' }] })
    storePdf(id)
    const off = await closed({ gameN: 950009, home: 'Alpha H1', away: 'Beta H1', officials: [{ role: '1st referee', email: 'typed@example.org' }] })
    storePdf(off)
    await fm.sweep()
    assert.deepEqual(of(950008).map((m) => m.to).sort(), ['contact@alpha.example.ch', 'contact@beta.example.ch', people.scorer.email, 'r1@example.ch', 'r2@example.ch'].sort())
    assert.ok(of(950008).every((m) => m.vars.teams === 'Alpha H1 – Beta H1'), 'the schedule\'s names')
    assert.deepEqual(of(950009).map((m) => m.to), [people.scorer.email], 'not in the schedule: the match\'s own accounts only')
  })

  it('stored bytes that are not a PDF are never attached', async () => {
    await scheduled(950010, 'Alpha H1', 'Beta H1')
    const id = await closed({ gameN: 950010, closedMinAgo: 3 })
    storePdf(id, Buffer.from('NOT-A-PDF forged by another account: result 0:3'))
    await fm.sweep()
    assert.equal(of(950010).length, 0)
    assert.equal((await outcomeOf(id)).outcome, 'pending', 'waits as for a missing PDF')
  })
})

describe('final mail end to end', { skip: SKIP }, () => {
  let db, srv, sql, smtp, storageRoot, statusDir
  let ipSeq = 1
  const users = {}
  const mailsTo = (to) => smtp.mails.filter((m) => m.envelope.to.includes(to))

  async function account (name, roles, lang, { confirm = true } = {}) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const ip = `198.51.100.${ipSeq++}`
    await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password: 'correct-horse-battery', ...(lang ? { lang } : {}), metadata: { first_name: name, last_name: 'Test' } } })
    // the mailer is on: confirm the address in the database (no link click)
    if (confirm) await sql.query('UPDATE auth.users SET email_confirmed_at = now() WHERE lower(email) = lower($1)', [email])
    let inn
    for (let attempt = 0; attempt < 10; attempt++) {
      inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password: 'correct-horse-battery' } })
      if (!(inn.status === 503 && inn.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    assert.equal(inn.status, 200, inn.text)
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, email }
    if (roles) await grantRoles(sql, u.id, roles)
    users[name] = u
    return u
  }
  const call = (user, method, path, body, headers) => api(srv.base, path, { method, token: user?.token, body, headers, proto: method === 'GET' ? null : '2' })
  const expectCode = (r, status, code) => {
    assert.equal(r.status, status, r.text)
    assert.equal(r.json?.error?.code, code, r.text)
  }
  const upload = (scheduledAt, gameN, pdf = PDF) => api(srv.base, '/api/storage/upload', { token: users.scorer.token, body: { bucket: 'scoresheets', path: `${scheduledAt.slice(0, 10)}/game${gameN}_k${randomBytes(16).toString('hex')}.pdf`, fileBase64: pdf.toString('base64'), contentType: 'application/pdf' } })
  // the first line of an attachment's base64 in the raw mail
  const attached = (mail, pdf) => mail.raw.includes(pdf.toString('base64').slice(0, 60))

  /** An official match of `scorer`, its game in the schedule, its PDF stored, closed `closedMinAgo` minutes ago. */
  async function closedMatch ({ gameN, closedMinAgo = 5, refereeEmail = null }) {
    const scheduledAt = new Date(Date.now() - 3 * 3600 * 1000).toISOString()
    await sql.query('INSERT INTO public.svrz_games (game_number, datetime, team_home, team_away) VALUES ($1, $2, $3, $4)', [String(gameN), scheduledAt.slice(0, 19), 'VBC Musterdorf H1', 'VBC Other H1'])
    const ins = await api(srv.base, '/api/db', { token: users.scorer.token, body: { table: 'matches', action: 'insert', params: { data: {
      external_id: `match_${Date.now()}_${randomBytes(3).toString('hex')}`, status: 'live', game_n: gameN, scheduled_at: scheduledAt,
      home_team: { name: 'VBC Musterdorf H1' }, away_team: { name: 'VBC Other H1' },
      officials: [{ role: '1st referee', first_name: 'Rita', last_name: 'Ref', email: refereeEmail }]
    }, returning: 'id', single: true } } })
    assert.equal(ins.status, 200, ins.text)
    const id = ins.json.data.id
    const up = await upload(scheduledAt, gameN)
    assert.equal(up.status, 200, up.text)
    await closeAgo(id, closedMinAgo)
    return { id, scheduledAt }
  }
  // Closed `minAgo` minutes ago: the closed-match guard (db/007) stamps
  // closed_at with now() and refuses to touch a closed row, so the close is
  // backdated with the triggers off (superuser, this statement only)
  async function closeAgo (id, minAgo) {
    await sql.query(`UPDATE public.matches SET status = 'final', closed_by = $2 WHERE id = $1`, [id, users.scorer.id])
    await sql.query('SET session_replication_role = replica')
    try {
      // microseconds, as the guard writes them in production
      await sql.query("UPDATE public.matches SET closed_by = $3, closed_at = now() - make_interval(secs => $2) + interval '123 microseconds' WHERE id = $1", [id, minAgo * 60, users.scorer.id])
    } finally {
      await sql.query('SET session_replication_role = origin')
    }
  }

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = await mkdtemp(join(tmpdir(), 'ov-finalmail-'))
    await writeFile(join(storageRoot, '.ovdata'), '') // the storage's mount sentinel
    statusDir = await mkdtemp(join(tmpdir(), 'ov-finalmail-status-'))
    await writeFile(join(statusDir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
    smtp = await startFakeSmtp({ implicitTls: false })
    srv = await bootServer({
      DATABASE_URL: db.url, STORAGE_ROOT: storageRoot, STATUS_DIR: statusDir, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
      STORAGE_BACKUP_MIN_FREE_MB: '1', STORAGE_SCORESHEETS_MIN_FREE_MB: '1', ...smtp.env(), FINAL_MAIL_SWEEP_MS: '1000',
      // the test mails' own hourly budget (lib/mailer.js budgetsFromEnv)
      MAIL_BUDGET_TEST: '3'
    })
    const admin = await account('admin', ['admin'])
    await account('scorer', ['scorer'], 'de') // signed up in German
    await account('cm', ['competition_manager'])
    const musterdorf = (await call(admin, 'POST', '/api/admin/clubs', { name: 'VBC Musterdorf', teams: ['VBC Musterdorf H1'] })).json.data.club
    const other = (await call(admin, 'POST', '/api/admin/clubs', { name: 'VBC Other', teams: ['VBC Other H1'] })).json.data.club
    await call(admin, 'PATCH', `/api/admin/clubs/${musterdorf.id}`, { contact_email: 'contact@musterdorf.example.ch' })
    await call(admin, 'PATCH', `/api/admin/clubs/${other.id}`, { contact_email: 'contact@other.example.ch' })
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await smtp?.close?.()
    await db?.drop()
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
    if (statusDir) await rm(statusDir, { recursive: true, force: true })
  })

  let early
  it('the switch: off by default; admins and competition managers only; audited', async () => {
    early = (await closedMatch({ gameN: 940001, closedMinAgo: 90 })).id // closed before the switch: never mailed
    const got = await call(users.cm, 'GET', '/api/settings')
    assert.equal(got.status, 200, got.text)
    assert.equal(got.json.data.settings.send_final_email, false)
    assert.equal(got.json.data.mail, true)
    expectCode(await call(users.scorer, 'PUT', '/api/settings', { send_final_email: true }), 403, 'OV_FORBIDDEN')
    expectCode(await call(users.cm, 'PUT', '/api/settings', { send_final_email: 'yes' }), 400, 'OV_INVALID_REQUEST')
    await sleep(2500)
    assert.equal(mailsTo('contact@musterdorf.example.ch').length, 0, 'nothing while the switch is off')
    const on = await call(users.cm, 'PUT', '/api/settings', { send_final_email: true })
    assert.equal(on.status, 200, on.text)
    assert.equal(on.json.data.settings.send_final_email, true)
    const { rows } = await sql.query(`SELECT actor_id, details FROM public.audit_log WHERE action = 'settings.final_email'`)
    assert.equal(rows[0].actor_id, users.cm.id)
    // as if it had been on for an hour: the matches below close (backdated a
    // few minutes) after it, the one above (90 minutes ago) before it
    await sql.query(`UPDATE public.app_settings SET changed_at = now() - interval '60 minutes'`)
  })

  let match
  it('a closed official match: the PDF to the scorer, the referee and both clubs, once', async () => {
    match = await closedMatch({ gameN: 940002, closedMinAgo: 3, refereeEmail: 'Rita.Ref@example.ch' })
    const matchId = match.id
    // the scorer's account in the language of its sign-up, the others in English
    for (const [to, subject] of [[users.scorer.email, 'Matchblatt'], ['rita.ref@example.ch', 'Scoresheet'], ['contact@musterdorf.example.ch', 'Scoresheet'], ['contact@other.example.ch', 'Scoresheet']]) {
      const mail = await smtp.waitForMail((m) => m.envelope.to.includes(to) && /940002|VBC Musterdorf H1/.test(m.text))
      assert.equal(mail.subject, `${subject}: VBC Musterdorf H1 – VBC Other H1`)
      assert.match(mail.raw, /application\/pdf/)
      assert.match(mail.raw, /filename="?[^"\r\n]*\.pdf/)
      assert.equal(mail.envelope.to.length, 1, 'one mail per address: nobody sees the others')
    }
    await sleep(2500)
    assert.equal(mailsTo('contact@musterdorf.example.ch').length, 1, 'once')
    const { rows: [row] } = await sql.query('SELECT outcome, recipients, corrected FROM public.match_final_mails WHERE match_id = $1', [matchId])
    assert.deepEqual(row, { outcome: 'sent', recipients: 4, corrected: false })
    const { rows: [entry] } = await sql.query(`SELECT details FROM public.audit_log WHERE action = 'match.final_mail' AND match_id = $1`, [matchId])
    assert.equal(entry.details.recipients, 4)
    assert.ok(!JSON.stringify(entry.details).includes('@'), 'no address in the audit log')
    assert.equal(mailsTo('contact@musterdorf.example.ch').filter((m) => /940001/.test(m.text)).length, 0, 'closed before the switch: never')
    assert.equal((await sql.query('SELECT 1 FROM public.match_final_mails WHERE match_id = $1', [early])).rows.length, 0)
  })

  it('reopened and closed again: mailed again as corrected, with the new approval\'s PDF', async () => {
    const reopened = await call(users.admin, 'POST', `/api/admin/matches/${match.id}/reopen`, { reason: 'wrong final score' })
    assert.equal(reopened.status, 200, reopened.text)
    // the reopen after the first close (3 minutes ago and some seconds), before the new one
    await sql.query("UPDATE public.audit_log SET at = now() - interval '170 seconds' WHERE action = 'match.reopen' AND match_id = $1", [match.id])
    const up = await upload(match.scheduledAt, 940002, PDF_V2)
    assert.equal(up.status, 200, up.text)
    await closeAgo(match.id, 2.5)
    const mail = await smtp.waitForMail((m) => m.envelope.to.includes('contact@musterdorf.example.ch') && /^Corrected scoresheet/.test(m.subject))
    assert.match(mail.text, /corrected final scoresheet/)
    assert.ok(attached(mail, PDF_V2), 'the corrected sheet, not the first one')
    assert.ok(!attached(mail, PDF))
    await sleep(3000)
    assert.equal(mailsTo('contact@musterdorf.example.ch').filter((m) => /^Corrected/.test(m.subject)).length, 1, 'once, not on every sweep')
  })

  it('release-game: the released match is marked in the managers\' list and its close is not mailed', async () => {
    const m = await closedMatch({ gameN: 940004, closedMinAgo: 90 }) // closed before the switch: no mail of its own
    const reopened = await call(users.admin, 'POST', `/api/admin/matches/${m.id}/reopen`, { reason: 'game entered twice' })
    assert.equal(reopened.status, 200, reopened.text)
    const released = await call(users.admin, 'POST', `/api/admin/matches/${m.id}/release-game`, { reason: 'a duplicate of the home scorer\'s match' })
    assert.equal(released.status, 200, released.text)
    const { rows: [row] } = await sql.query('SELECT official_game_exempt, released_at FROM public.matches WHERE id = $1', [m.id])
    assert.equal(row.official_game_exempt, true)
    assert.ok(row.released_at, 'stamped')
    // the released match's scorer goes on and closes it
    await closeAgo(m.id, 3)
    const list = await call(users.cm, 'GET', '/api/scoresheets?app=indoor&q=940004')
    assert.equal(list.status, 200, list.text)
    assert.equal(list.json.data.matches.length, 1)
    assert.equal(list.json.data.matches[0].released, true)
    const other = await call(users.cm, 'GET', '/api/scoresheets?app=indoor&q=940002')
    assert.equal(other.json.data.matches[0].released, false)
    await sleep(3000)
    assert.equal(mailsTo('contact@musterdorf.example.ch').filter((x) => /940004/.test(x.text)).length, 0)
    assert.equal((await sql.query('SELECT 1 FROM public.match_final_mails WHERE match_id = $1', [m.id])).rows.length, 0)
  })

  it('switched off: nothing more goes out', async () => {
    assert.equal((await call(users.admin, 'PUT', '/api/settings', { send_final_email: false })).status, 200)
    await closedMatch({ gameN: 940003, closedMinAgo: 3 })
    await sleep(3000)
    assert.equal(mailsTo('contact@musterdorf.example.ch').filter((m) => /940003/.test(m.text)).length, 0)
  })

  it('a test match: its PDF to the scorer\'s own address only, never stored, whatever the switch', async () => {
    assert.equal((await api(srv.base, '/api/scoresheet/test-mail', { body: { pdf: PDF.toString('base64') } })).status, 401)
    expectCode(await call(users.scorer, 'POST', '/api/scoresheet/test-mail', { pdf: Buffer.from('not a pdf').toString('base64') }), 400, 'OV_INVALID_REQUEST')
    const r = await call(users.scorer, 'POST', '/api/scoresheet/test-mail', { pdf: PDF.toString('base64'), teams: 'URGENT: your licence is suspended', result: '3:1' }, { 'accept-language': 'en' }) // the account's language wins
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.data.to, users.scorer.email.toLowerCase())
    const mail = await smtp.waitForMail((m) => m.envelope.to.includes(users.scorer.email.toLowerCase()) && /^Test-Matchblatt/.test(m.subject))
    assert.match(mail.raw, /application\/pdf/)
    assert.match(mail.text, /Resultat: 3:1/)
    assert.equal(mail.subject, 'Test-Matchblatt', 'a fixed subject: the caller\'s text in the body only')
    assert.match(mail.text, /URGENT: your licence is suspended/)
  })

  it('a test mail needs a confirmed address and the scorer role', async () => {
    const pending = await account('pending', null)
    expectCode(await call(pending, 'POST', '/api/scoresheet/test-mail', { pdf: PDF.toString('base64'), teams: 'A – B' }), 403, 'OV_SCORER_REQUIRED')
    const unconfirmed = await account('unconfirmed', ['scorer'], null, { confirm: false })
    expectCode(await call(unconfirmed, 'POST', '/api/scoresheet/test-mail', { pdf: PDF.toString('base64'), teams: 'A – B' }), 409, 'OV_EMAIL_UNCONFIRMED')
    assert.equal(mailsTo(unconfirmed.email.toLowerCase()).filter((m) => /Test/.test(m.subject)).length, 0)
  })

  it('test mails have their own budget: used up, the final scoresheet still goes out', async () => {
    // one test mail went out above; MAIL_BUDGET_TEST is 3
    const second = await account('scorer2', ['scorer'])
    const answers = []
    for (const u of [users.scorer, users.scorer, second, second]) {
      answers.push((await call(u, 'POST', '/api/scoresheet/test-mail', { pdf: PDF.toString('base64'), teams: 'A – B' })).status)
    }
    assert.deepEqual(answers, [200, 200, 429, 429])
    assert.equal((await call(users.admin, 'PUT', '/api/settings', { send_final_email: true })).status, 200)
    await sql.query(`UPDATE public.app_settings SET changed_at = now() - interval '60 minutes'`)
    await closedMatch({ gameN: 940005, closedMinAgo: 3 })
    await smtp.waitForMail((m) => m.envelope.to.includes('contact@musterdorf.example.ch') && /940005/.test(m.text))
  })
})
