/**
 * "Send the final mail now" (lib/finalMail.js status + sendNow; owner
 * 2026-11-15: the switch mails only the closes after it was turned on, so the
 * matches closed before it never got their mail).
 *
 * On a real database with a fake mailer and storage: a close before the
 * switch (and with the switch off) mailed by hand to the sweep's recipients,
 * with the approval's PDF, or without it (saying that it follows) and the
 * PDF following once it is stored; the sweep never mails it again; a close
 * already mailed goes again to everyone, marked as a resend; a round still
 * open is finished, nobody mailed twice; test, beach, numberless, released
 * and open matches refused; counts only in the audit.
 *
 * End to end over a fake SMTP server: admins only (a competition manager and
 * a scorer get 403), the state and the count in the console's read (never an
 * address), a backlog match mailed, a test match refused, the sweep does not
 * mail it again, a resend marked as such.
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js) or OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { SKIP_PG, createTestDatabase, grantRoles, quietLogger } from './helpers/pgTestDb.js'
import { startFakeSmtp } from './helpers/fakeSmtp.js'
import { createFinalMail } from '../lib/finalMail.js'

const PDF = Buffer.from('%PDF-1.4\n% final scoresheet\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n')

describe('send the final mail now (database, fake mailer and storage)', { skip: SKIP_PG }, () => {
  let db, sql, pool, fm
  let clock = Date.now()
  const minutes = (n) => n * 60 * 1000
  const ts = (ms) => new Date(ms).toISOString()
  const mails = []
  const pdfs = new Map()
  let refuse = null
  const mailer = {
    enabled: true,
    async send (kind, { to, lang, vars, attachments } = {}) {
      const r = refuse?.(kind, to, vars)
      if (r === 'budget') return { sent: false, skipped: 'budget' }
      mails.push({ kind, to, lang, vars, attachments: attachments || [] })
      return { sent: true }
    }
  }
  const scoresheets = { async latestPdf (m) { return pdfs.get(m.id) ?? null } }
  const of = (game, kind = 'scoresheet') => mails.filter((m) => m.kind === kind && m.vars?.game === String(game))
  const people = {}
  // the audit log as lib/accounts.js writes it, at the test's clock (the sweep reads the manual entries)
  const audit = async (_client, e) => {
    await sql.query('INSERT INTO public.audit_log (actor_id, action, match_id, details, at) VALUES ($1, $2, $3, $4, $5)',
      [e.actorId ?? null, e.action, e.matchId ?? null, JSON.stringify(e.details || {}), ts(clock)])
  }
  const auditsOf = async (id, action = 'match.final_mail_manual') => (await sql.query(
    'SELECT actor_id, details FROM public.audit_log WHERE action = $1 AND match_id = $2 ORDER BY id', [action, id])).rows
  const rowOf = async (id) => (await sql.query('SELECT outcome, recipients FROM public.match_final_mails WHERE match_id = $1', [id])).rows[0]
  const replica = async (fn) => {
    await sql.query('SET session_replication_role = replica')
    try { return await fn() } finally { await sql.query('SET session_replication_role = origin') }
  }
  async function person (name, roles) {
    const email = `${name}@example.ch`
    const { rows: [u] } = await sql.query('INSERT INTO auth.users (email, email_confirmed_at) VALUES ($1, now()) RETURNING id', [email])
    if (roles) await grantRoles(sql, u.id, roles)
    people[name] = { id: u.id, email }
  }
  async function closed ({ gameN, closedMinAgo, test = false, beach = false, released = false, open = false, officials = [] }) {
    return replica(async () => {
      const { rows: [m] } = await sql.query(
        `INSERT INTO public.matches (external_id, status, game_n, scheduled_at, home_team, away_team, officials, created_by, closed_by, closed_at, test, sport_type, official_game_exempt, released_at)
         VALUES ($1, $2, $3, $4, '{"name":"Alpha H1"}', '{"name":"Beta H1"}', $5, $6, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [`match_${randomBytes(6).toString('hex')}`, open ? 'ended' : 'final', gameN, ts(clock - minutes(closedMinAgo + 90)), JSON.stringify(officials), people.scorer.id,
          open ? null : ts(clock - minutes(closedMinAgo)), test, beach ? 'beach' : null, released, released ? ts(clock - minutes(closedMinAgo + 10)) : null])
      return m.id
    })
  }

  before(async () => {
    db = await createTestDatabase('finalmail_manual')
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    pool = new pg.Pool({ connectionString: db.url, max: 4 })
    fm = createFinalMail({ pool, mailer, scoresheets, audit, logger: quietLogger(), now: () => clock })
    await person('scorer', ['scorer'])
    await person('admin', ['admin'])
    const { rows: [c] } = await sql.query("INSERT INTO public.clubs (name, contact_email) VALUES ('Alpha club', 'contact@alpha.example.ch') RETURNING id")
    await sql.query("INSERT INTO public.club_teams (club_id, team_name) VALUES ($1, 'Alpha H1')", [c.id])
    // the switch was turned on an hour ago: everything below closed earlier (the backlog)
    await sql.query('UPDATE public.app_settings SET send_final_email = true, changed_at = $1', [ts(clock - minutes(60))])
  })
  after(async () => {
    await pool?.end().catch(() => {})
    await sql?.end().catch(() => {})
    await db?.drop()
  })

  it('a close before the switch: the sweep leaves it, the admin mails it, with the PDF, and the sweep does not mail it again', async () => {
    await sql.query("INSERT INTO public.svrz_games (game_number, datetime, team_home, team_away) VALUES ('960001', $1, 'Alpha H1', 'Beta H1')", [ts(clock).slice(0, 19)])
    const id = await closed({ gameN: 960001, closedMinAgo: 180, officials: [{ role: '1st referee', email: 'rita.ref@example.ch' }] })
    pdfs.set(id, { data: PDF, filename: 'Scoresheet.pdf', mtimeMs: clock - minutes(181) })
    await fm.sweep()
    assert.equal(of(960001).length, 0, 'the backlog: never by the sweep')
    const look = await fm.status({ matchId: id })
    assert.equal(look.status, 200)
    assert.deepEqual({ sendable: look.body.data.sendable, recipients: look.body.data.recipients, pdf: look.body.data.pdf, outcome: look.body.data.state.outcome, resend: look.body.data.resend },
      { sendable: true, recipients: 3, pdf: true, outcome: null, resend: false })
    assert.ok(!JSON.stringify(look.body).includes('@'), 'a count, never an address')
    const r = await fm.sendNow({ actorId: people.admin.id, matchId: id })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual({ outcome: r.body.data.outcome, recipients: r.body.data.recipients, reached: r.body.data.reached, pdf: r.body.data.pdf, resend: r.body.data.resend },
      { outcome: 'sent', recipients: 3, reached: 3, pdf: true, resend: false })
    assert.deepEqual(of(960001).map((m) => m.to).sort(), ['contact@alpha.example.ch', people.scorer.email, 'rita.ref@example.ch'].sort(), 'the sweep\'s recipients')
    assert.ok(of(960001).every((m) => m.attachments[0]?.content.equals(PDF)))
    assert.deepEqual(await rowOf(id), { outcome: 'sent', recipients: 3 })
    const [entry] = await auditsOf(id)
    assert.equal(entry.actor_id, people.admin.id)
    assert.deepEqual(entry.details, { outcome: 'sent', recipients: 3, reached: 3, pdf: true, resend: false, corrected: false, game_n: 960001 })
    assert.equal((await auditsOf(id, 'match.final_mail')).length, 0, 'one entry: the manual one')
    assert.ok((await fm.status({ matchId: id })).body.data.state.sent_at, 'sent at')
    clock += minutes(11)
    await fm.sweep()
    assert.equal(of(960001).length, 3, 'the sweep does not mail it again')
  })

  it('without a PDF: mailed without it (saying that it follows) whatever the switch, and the PDF follows once it is stored', async () => {
    await sql.query('UPDATE public.app_settings SET send_final_email = false')
    const id = await closed({ gameN: 960002, closedMinAgo: 120 })
    assert.equal((await fm.status({ matchId: id })).body.data.pdf, false)
    const r = await fm.sendNow({ actorId: people.admin.id, matchId: id })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.data.outcome, 'sent_no_pdf')
    assert.equal(of(960002).length, 1)
    assert.ok(of(960002).every((m) => m.attachments.length === 0 && m.vars.pdf === false), 'says the PDF follows')
    assert.equal((await rowOf(id)).outcome, 'sent_no_pdf')
    await sql.query('UPDATE public.app_settings SET send_final_email = true')
    pdfs.set(id, { data: PDF, filename: 'Scoresheet.pdf', mtimeMs: clock })
    clock += minutes(11)
    await fm.sweep()
    const late = of(960002).filter((m) => m.attachments.length === 1)
    assert.equal(late.length, 1, 'the PDF follows (a close before the switch, mailed by hand)')
    assert.equal(late[0].vars.late, true)
    assert.equal((await rowOf(id)).outcome, 'sent')
  })

  it('a close already mailed: everyone again, marked as a resend', async () => {
    const id = await closed({ gameN: 960003, closedMinAgo: 100 })
    pdfs.set(id, { data: PDF, filename: 'Scoresheet.pdf', mtimeMs: clock - minutes(101) })
    assert.equal((await fm.sendNow({ actorId: people.admin.id, matchId: id })).body.data.resend, false)
    assert.equal((await fm.status({ matchId: id })).body.data.resend, true)
    const again = await fm.sendNow({ actorId: people.admin.id, matchId: id })
    assert.equal(again.status, 200)
    assert.equal(again.body.data.outcome, 'sent')
    assert.equal(again.body.data.resend, true)
    assert.equal(of(960003).length, 2, 'the scorer twice')
    assert.deepEqual((await auditsOf(id)).map((a) => a.details.resend), [false, true])
  })

  it('a round still open (the budget held it back) is finished: nobody twice, not a resend', async () => {
    const id = await closed({ gameN: 960004, closedMinAgo: 90, officials: [{ role: 'team contact', team: 'home', email: 'home@alpha.example.ch' }] })
    pdfs.set(id, { data: PDF, filename: 'Scoresheet.pdf', mtimeMs: clock - minutes(91) })
    let left = 1
    refuse = (kind, to, vars) => (vars?.game === '960004' && left-- <= 0 ? 'budget' : null)
    const held = await fm.sendNow({ actorId: people.admin.id, matchId: id })
    refuse = null
    assert.equal(held.body.data.outcome, 'deferred')
    assert.equal(held.body.data.reached, 1)
    assert.equal((await rowOf(id)).outcome, 'deferred')
    const done = await fm.sendNow({ actorId: people.admin.id, matchId: id })
    assert.equal(done.body.data.outcome, 'sent')
    assert.equal(done.body.data.resend, false)
    assert.deepEqual(of(960004).map((m) => m.to).sort(), [people.scorer.email, 'home@alpha.example.ch'].sort(), 'each once')
  })

  it('test, beach, numberless, released and open matches are refused, as the sweep leaves them out', async () => {
    const cases = [
      [await closed({ gameN: 960005, closedMinAgo: 30, test: true }), 'test'],
      [await closed({ gameN: 960006, closedMinAgo: 30, beach: true }), 'beach'],
      [await closed({ gameN: null, closedMinAgo: 30 }), 'no_game_number'],
      [await closed({ gameN: 960007, closedMinAgo: 30, released: true }), 'released']
    ]
    for (const [id, reason] of cases) {
      const r = await fm.sendNow({ actorId: people.admin.id, matchId: id })
      assert.equal(r.status, 409, reason)
      assert.equal(r.body.error.code, 'OV_FINAL_MAIL_REFUSED')
      assert.equal(r.body.error.details.reason, reason)
      const look = (await fm.status({ matchId: id })).body.data
      assert.deepEqual({ sendable: look.sendable, reason: look.reason }, { sendable: false, reason })
      assert.equal(await rowOf(id), undefined, 'nothing recorded')
    }
    const open = await closed({ gameN: 960008, closedMinAgo: 0, open: true })
    assert.equal((await fm.sendNow({ actorId: people.admin.id, matchId: open })).body.error.code, 'OV_NOT_CLOSED')
    assert.equal((await fm.sendNow({ actorId: people.admin.id, matchId: '00000000-0000-4000-8000-000000000000' })).status, 404)
    assert.equal(mails.filter((m) => ['960005', '960006', '960007', '960008'].includes(m.vars?.game)).length, 0)
  })
})

describe('send the final mail now, end to end', { skip: SKIP }, () => {
  let db, srv, sql, smtp, storageRoot, statusDir
  let ipSeq = 1
  const users = {}
  const mailsTo = (to) => smtp.mails.filter((m) => m.envelope.to.includes(to))

  async function account (name, roles) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const ip = `198.51.100.${ipSeq++}`
    await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password: 'correct-horse-battery', metadata: { first_name: name, last_name: 'Test' } } })
    await sql.query('UPDATE auth.users SET email_confirmed_at = now() WHERE lower(email) = lower($1)', [email])
    let inn
    for (let attempt = 0; attempt < 10; attempt++) {
      inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password: 'correct-horse-battery' } })
      if (!(inn.status === 503 && inn.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    assert.equal(inn.status, 200, inn.text)
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, email: email.toLowerCase() }
    if (roles) await grantRoles(sql, u.id, roles)
    users[name] = u
    return u
  }
  const call = (user, method, path, body) => api(srv.base, path, { method, token: user?.token, body, proto: method === 'GET' ? null : '2' })

  /** An official match of the scorer, its game in the schedule, its PDF stored, closed `minAgo` minutes ago. */
  async function closedMatch (gameN, minAgo, { test = false } = {}) {
    const scheduledAt = new Date(Date.now() - (minAgo + 120) * 60 * 1000).toISOString()
    await sql.query('INSERT INTO public.svrz_games (game_number, datetime, team_home, team_away) VALUES ($1, $2, $3, $4)', [String(gameN), scheduledAt.slice(0, 19), 'VBC Musterdorf H1', 'VBC Other H1'])
    const ins = await api(srv.base, '/api/db', { token: users.scorer.token, body: { table: 'matches', action: 'insert', params: { data: {
      external_id: `match_${Date.now()}_${randomBytes(3).toString('hex')}`, status: 'live', game_n: gameN, scheduled_at: scheduledAt,
      home_team: { name: 'VBC Musterdorf H1' }, away_team: { name: 'VBC Other H1' },
      officials: [{ role: '1st referee', first_name: 'Rita', last_name: 'Ref', email: 'rita.ref@example.ch' }]
    }, returning: 'id', single: true } } })
    assert.equal(ins.status, 200, ins.text)
    const id = ins.json.data.id
    const up = await api(srv.base, '/api/storage/upload', { token: users.scorer.token, body: { bucket: 'scoresheets', path: `${scheduledAt.slice(0, 10)}/game${gameN}_k${randomBytes(16).toString('hex')}.pdf`, fileBase64: PDF.toString('base64'), contentType: 'application/pdf' } })
    assert.equal(up.status, 200, up.text)
    await sql.query("UPDATE public.matches SET status = 'final', closed_by = $2 WHERE id = $1", [id, users.scorer.id])
    await sql.query('SET session_replication_role = replica')
    try {
      // the guard stamps the close itself: backdated (and closed_by kept) with the triggers off
      await sql.query("UPDATE public.matches SET closed_by = $4, closed_at = now() - make_interval(secs => $2) + interval '123 microseconds', test = $3 WHERE id = $1", [id, minAgo * 60, test, users.scorer.id])
    } finally {
      await sql.query('SET session_replication_role = origin')
    }
    return id
  }

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = await mkdtemp(join(tmpdir(), 'ov-finalmail-manual-'))
    await writeFile(join(storageRoot, '.ovdata'), '')
    statusDir = await mkdtemp(join(tmpdir(), 'ov-finalmail-manual-status-'))
    await writeFile(join(statusDir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
    smtp = await startFakeSmtp({ implicitTls: false })
    srv = await bootServer({
      DATABASE_URL: db.url, STORAGE_ROOT: storageRoot, STATUS_DIR: statusDir, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
      STORAGE_BACKUP_MIN_FREE_MB: '1', STORAGE_SCORESHEETS_MIN_FREE_MB: '1', ...smtp.env(), FINAL_MAIL_SWEEP_MS: '1000'
    })
    const admin = await account('admin', ['admin'])
    await account('scorer', ['scorer'])
    await account('cm', ['competition_manager'])
    const club = (await call(admin, 'POST', '/api/admin/clubs', { name: 'VBC Musterdorf', teams: ['VBC Musterdorf H1'] })).json.data.club
    await call(admin, 'PATCH', `/api/admin/clubs/${club.id}`, { contact_email: 'contact@musterdorf.example.ch' })
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await smtp?.close?.()
    await db?.drop()
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
    if (statusDir) await rm(statusDir, { recursive: true, force: true })
  })

  let backlog
  it('admins only: a competition manager and a scorer get 403, nothing is mailed', async () => {
    backlog = await closedMatch(970001, 240)
    for (const who of [users.cm, users.scorer]) {
      for (const method of ['GET', 'POST']) {
        const r = await call(who, method, `/api/admin/matches/${backlog}/final-mail`, method === 'POST' ? {} : undefined)
        assert.equal(r.status, 403, r.text)
        assert.equal(r.json.error.code, 'OV_FORBIDDEN')
      }
    }
    assert.equal(mailsTo('contact@musterdorf.example.ch').length, 0)
  })

  it('a match closed before the switch was on: the admin sees the count and mails it; the sweep does not mail it again', async () => {
    assert.equal((await call(users.admin, 'PUT', '/api/settings', { send_final_email: true })).status, 200)
    await sleep(2500)
    assert.equal(mailsTo('contact@musterdorf.example.ch').length, 0, 'the backlog: never by the sweep')
    const look = await call(users.admin, 'GET', `/api/admin/matches/${backlog}/final-mail`)
    assert.equal(look.status, 200, look.text)
    assert.equal(look.json.data.sendable, true)
    assert.equal(look.json.data.recipients, 3)
    assert.equal(look.json.data.pdf, true)
    assert.equal(look.json.data.state.outcome, null)
    assert.ok(!look.text.includes('@'), 'a count, never an address')
    const sent = await call(users.admin, 'POST', `/api/admin/matches/${backlog}/final-mail`, {})
    assert.equal(sent.status, 200, sent.text)
    assert.deepEqual({ outcome: sent.json.data.outcome, reached: sent.json.data.reached, pdf: sent.json.data.pdf, resend: sent.json.data.resend }, { outcome: 'sent', reached: 3, pdf: true, resend: false })
    for (const to of [users.scorer.email, 'rita.ref@example.ch', 'contact@musterdorf.example.ch']) {
      const mail = await smtp.waitForMail((m) => m.envelope.to.includes(to) && /970001|VBC Musterdorf H1/.test(m.text))
      assert.match(mail.raw, /application\/pdf/)
    }
    const { rows: [row] } = await sql.query('SELECT outcome, recipients FROM public.match_final_mails WHERE match_id = $1', [backlog])
    assert.deepEqual(row, { outcome: 'sent', recipients: 3 })
    const { rows: [entry] } = await sql.query("SELECT actor_id, details FROM public.audit_log WHERE action = 'match.final_mail_manual' AND match_id = $1", [backlog])
    assert.equal(entry.actor_id, users.admin.id)
    assert.equal(entry.details.recipients, 3)
    assert.equal(entry.details.resend, false)
    assert.ok(!JSON.stringify(entry.details).includes('@'), 'no address in the audit log')
    await sleep(2500)
    assert.equal(mailsTo('contact@musterdorf.example.ch').length, 1, 'the sweep does not mail it again')
    const after = await call(users.admin, 'GET', `/api/admin/matches/${backlog}/final-mail`)
    assert.equal(after.json.data.state.outcome, 'sent')
    assert.ok(after.json.data.state.sent_at)
    assert.equal(after.json.data.resend, true)
  })

  it('again: a resend, marked as such in the audit', async () => {
    const again = await call(users.admin, 'POST', `/api/admin/matches/${backlog}/final-mail`, {})
    assert.equal(again.status, 200, again.text)
    assert.equal(again.json.data.resend, true)
    await smtp.waitForMail(() => mailsTo('contact@musterdorf.example.ch').length === 2)
    const { rows } = await sql.query("SELECT details FROM public.audit_log WHERE action = 'match.final_mail_manual' AND match_id = $1 ORDER BY id", [backlog])
    assert.deepEqual(rows.map((r) => r.details.resend), [false, true])
  })

  it('a test match is refused, nothing mailed or recorded', async () => {
    const id = await closedMatch(970002, 30, { test: true })
    const r = await call(users.admin, 'POST', `/api/admin/matches/${id}/final-mail`, {})
    assert.equal(r.status, 409, r.text)
    assert.equal(r.json.error.code, 'OV_FINAL_MAIL_REFUSED')
    assert.equal(r.json.error.details.reason, 'test')
    assert.equal((await sql.query('SELECT 1 FROM public.match_final_mails WHERE match_id = $1', [id])).rows.length, 0)
    assert.equal(mailsTo('contact@musterdorf.example.ch').filter((m) => /970002/.test(m.text)).length, 0)
  })
})
