/**
 * The final scoresheet by email (db/021, lib/finalMail.js; ~/ov-ops/club-
 * manager-home-email-PLAN.md step 4), end to end over a fake SMTP server:
 * the switch (admins and competition managers, off by default), the mail of
 * a closed official match to the scorer, a referee's typed address and the
 * clubs' contacts with the PDF attached, once; a reopened and closed again
 * match as "corrected"; nothing while the switch is off or for matches closed
 * before it was turned on; a test match's PDF to its scorer only.
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
import { grantRoles } from './helpers/pgTestDb.js'
import { startFakeSmtp } from './helpers/fakeSmtp.js'
import { recipientList, refereeAddresses, zurichDate } from '../lib/finalMail.js'

const PDF = Buffer.from('%PDF-1.4\n% final scoresheet\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n')

describe('final mail (unit)', () => {
  it('recipients: distinct valid addresses, lower-case, at most twelve', () => {
    assert.deepEqual(recipientList(['A@x.ch', 'a@x.ch ', 'nope', null, 'b@y.ch']), ['a@x.ch', 'b@y.ch'])
    assert.equal(recipientList(Array.from({ length: 20 }, (_, i) => `p${i}@x.ch`)).length, 12)
  })
  it('the referees\' typed addresses only (not the scorer\'s, not line judges)', () => {
    assert.deepEqual(refereeAddresses([
      { role: '1st referee', email: 'r1@x.ch' }, { role: '2nd referee' }, { role: 'scorer', email: 's@x.ch' }, { role: 'line judge 1', name: 'L' }
    ]), ['r1@x.ch'])
    assert.deepEqual(refereeAddresses(null), [])
  })
  it('the date in Zurich', () => {
    assert.equal(zurichDate('2026-10-29T23:30:00Z'), '30.10.2026')
    assert.equal(zurichDate(null), '')
  })
})

describe('final mail end to end', { skip: SKIP }, () => {
  let db, srv, sql, smtp, storageRoot, statusDir
  let ipSeq = 1
  const users = {}
  const mailsTo = (to) => smtp.mails.filter((m) => m.envelope.to.includes(to))

  async function account (name, roles) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const ip = `198.51.100.${ipSeq++}`
    await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password: 'correct-horse-battery', metadata: { first_name: name, last_name: 'Test' } } })
    // the mailer is on: confirm the address in the database (no link click)
    await sql.query('UPDATE auth.users SET email_confirmed_at = now() WHERE lower(email) = lower($1)', [email])
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

  /** An official match of `scorer`, its PDF stored, closed `closedMinAgo` minutes ago. */
  async function closedMatch ({ gameN, closedMinAgo = 5, refereeEmail = null }) {
    const scheduledAt = new Date(Date.now() - 3 * 3600 * 1000).toISOString()
    const ins = await api(srv.base, '/api/db', { token: users.scorer.token, body: { table: 'matches', action: 'insert', params: { data: {
      external_id: `match_${Date.now()}_${randomBytes(3).toString('hex')}`, status: 'live', game_n: gameN, scheduled_at: scheduledAt,
      home_team: { name: 'KSC Wiedikon H1' }, away_team: { name: 'VBC Other H1' },
      officials: [{ role: '1st referee', first_name: 'Rita', last_name: 'Ref', email: refereeEmail }]
    }, returning: 'id', single: true } } })
    assert.equal(ins.status, 200, ins.text)
    const id = ins.json.data.id
    const day = scheduledAt.slice(0, 10)
    const up = await api(srv.base, '/api/storage/upload', { token: users.scorer.token, body: { bucket: 'scoresheets', path: `${day}/game${gameN}_k${randomBytes(16).toString('hex')}.pdf`, fileBase64: PDF.toString('base64'), contentType: 'application/pdf' } })
    assert.equal(up.status, 200, up.text)
    await closeAgo(id, closedMinAgo)
    return id
  }
  // Closed `minAgo` minutes ago: the closed-match guard (db/007) stamps
  // closed_at with now() and refuses to touch a closed row, so the close is
  // backdated with the triggers off (superuser, this statement only)
  async function closeAgo (id, minAgo) {
    await sql.query(`UPDATE public.matches SET status = 'final', closed_by = $2 WHERE id = $1`, [id, users.scorer.id])
    await sql.query('SET session_replication_role = replica')
    try {
      // microseconds, as the guard writes them in production
      await sql.query("UPDATE public.matches SET closed_by = $3, closed_at = now() - make_interval(mins => $2) + interval '123 microseconds' WHERE id = $1", [id, minAgo, users.scorer.id])
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
      STORAGE_BACKUP_MIN_FREE_MB: '1', STORAGE_SCORESHEETS_MIN_FREE_MB: '1', ...smtp.env(), FINAL_MAIL_SWEEP_MS: '1000'
    })
    const admin = await account('admin', ['admin'])
    await account('scorer', ['scorer'])
    await account('cm', ['competition_manager'])
    const ksc = (await call(admin, 'POST', '/api/admin/clubs', { name: 'KSC Wiedikon', teams: ['KSC Wiedikon H1'] })).json.data.club
    const other = (await call(admin, 'POST', '/api/admin/clubs', { name: 'VBC Other', teams: ['VBC Other H1'] })).json.data.club
    await call(admin, 'PATCH', `/api/admin/clubs/${ksc.id}`, { contact_email: 'contact@ksc.example.ch' })
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
    early = await closedMatch({ gameN: 940001, closedMinAgo: 90 }) // closed before the switch: never mailed
    const got = await call(users.cm, 'GET', '/api/settings')
    assert.equal(got.status, 200, got.text)
    assert.equal(got.json.data.settings.send_final_email, false)
    assert.equal(got.json.data.mail, true)
    expectCode(await call(users.scorer, 'PUT', '/api/settings', { send_final_email: true }), 403, 'OV_FORBIDDEN')
    expectCode(await call(users.cm, 'PUT', '/api/settings', { send_final_email: 'yes' }), 400, 'OV_INVALID_REQUEST')
    await sleep(2500)
    assert.equal(mailsTo('contact@ksc.example.ch').length, 0, 'nothing while the switch is off')
    const on = await call(users.cm, 'PUT', '/api/settings', { send_final_email: true })
    assert.equal(on.status, 200, on.text)
    assert.equal(on.json.data.settings.send_final_email, true)
    const { rows } = await sql.query(`SELECT actor_id, details FROM public.audit_log WHERE action = 'settings.final_email'`)
    assert.equal(rows[0].actor_id, users.cm.id)
    // as if it had been on for an hour: the matches below close (backdated a
    // few minutes) after it, the one above (90 minutes ago) before it
    await sql.query(`UPDATE public.app_settings SET changed_at = now() - interval '60 minutes'`)
  })

  let matchId
  it('a closed official match: the PDF to the scorer, the referee and both clubs, once', async () => {
    matchId = await closedMatch({ gameN: 940002, closedMinAgo: 3, refereeEmail: 'Rita.Ref@example.ch' })
    for (const to of [users.scorer.email, 'rita.ref@example.ch', 'contact@ksc.example.ch', 'contact@other.example.ch']) {
      const mail = await smtp.waitForMail((m) => m.envelope.to.includes(to) && /940002|KSC Wiedikon H1/.test(m.text))
      assert.match(mail.subject, /^Matchblatt: KSC Wiedikon H1 – VBC Other H1$/)
      assert.match(mail.raw, /application\/pdf/)
      assert.match(mail.raw, /filename="?[^"\r\n]*\.pdf/)
      assert.equal(mail.envelope.to.length, 1, 'one mail per address: nobody sees the others')
    }
    await sleep(2500)
    assert.equal(mailsTo('contact@ksc.example.ch').length, 1, 'once')
    const { rows: [row] } = await sql.query('SELECT outcome, recipients, corrected FROM public.match_final_mails WHERE match_id = $1', [matchId])
    assert.deepEqual(row, { outcome: 'sent', recipients: 4, corrected: false })
    const { rows: [entry] } = await sql.query(`SELECT details FROM public.audit_log WHERE action = 'match.final_mail' AND match_id = $1`, [matchId])
    assert.equal(entry.details.recipients, 4)
    assert.ok(!JSON.stringify(entry.details).includes('@'), 'no address in the audit log')
    assert.equal(mailsTo('contact@ksc.example.ch').filter((m) => /940001/.test(m.text)).length, 0, 'closed before the switch: never')
    assert.equal((await sql.query('SELECT 1 FROM public.match_final_mails WHERE match_id = $1', [early])).rows.length, 0)
  })

  it('reopened and closed again: mailed again as corrected', async () => {
    const reopened = await call(users.admin, 'POST', `/api/admin/matches/${matchId}/reopen`, { reason: 'wrong final score' })
    assert.equal(reopened.status, 200, reopened.text)
    await closeAgo(matchId, 3)
    const mail = await smtp.waitForMail((m) => m.envelope.to.includes('contact@ksc.example.ch') && /^Korrigiertes Matchblatt/.test(m.subject))
    assert.match(mail.text, /korrigierte/)
    await sleep(3000)
    assert.equal(mailsTo('contact@ksc.example.ch').filter((m) => /^Korrigiertes/.test(m.subject)).length, 1, 'once, not on every sweep')
  })

  it('switched off: nothing more goes out', async () => {
    assert.equal((await call(users.admin, 'PUT', '/api/settings', { send_final_email: false })).status, 200)
    await closedMatch({ gameN: 940003, closedMinAgo: 3 })
    await sleep(3000)
    assert.equal(mailsTo('contact@ksc.example.ch').filter((m) => /940003/.test(m.text)).length, 0)
  })

  it('a test match: its PDF to the scorer\'s own address only, never stored, whatever the switch', async () => {
    assert.equal((await api(srv.base, '/api/scoresheet/test-mail', { body: { pdf: PDF.toString('base64') } })).status, 401)
    expectCode(await call(users.scorer, 'POST', '/api/scoresheet/test-mail', { pdf: Buffer.from('not a pdf').toString('base64') }), 400, 'OV_INVALID_REQUEST')
    const r = await call(users.scorer, 'POST', '/api/scoresheet/test-mail', { pdf: PDF.toString('base64'), teams: 'Home – Away', result: '3:1' }, { 'accept-language': 'de-CH' })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.data.to, users.scorer.email.toLowerCase())
    const mail = await smtp.waitForMail((m) => m.envelope.to.includes(users.scorer.email.toLowerCase()) && /^Test-Matchblatt/.test(m.subject))
    assert.match(mail.raw, /application\/pdf/)
    assert.match(mail.text, /Resultat: 3:1/)
  })
})
