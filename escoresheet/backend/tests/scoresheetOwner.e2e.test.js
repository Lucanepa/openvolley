/**
 * A match's stored scoresheet PDF is the one an account that may write the
 * match stored for it (db/033, lib/scoresheets.js storePdf): the PDF the
 * competition managers open and the final mail sends. Another scorer's file
 * with the match's game number in its name is refused, and is never served
 * when it is on disk from before; after the close the closing account stores
 * the approval's PDF once and nobody but an admin changes or removes it.
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js) or OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'
import { startFakeSmtp } from './helpers/fakeSmtp.js'

const key = () => `k${randomBytes(16).toString('hex')}`
const pdfBytes = (label) => Buffer.from(`%PDF-1.4\n% ${label}\n%%EOF\n`)

describe('scoresheet PDFs belong to their match', { skip: SKIP }, () => {
  let db, srv, sql, smtp, storageRoot, statusDir
  let ipSeq = 1
  let gameSeq = 951000
  const users = {}

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
  const call = (user, method, path, body) => api(srv.base, path, { method, token: user?.token, body, proto: method === 'GET' ? null : '2' })
  const expectCode = (r, status, code) => {
    assert.equal(r.status, status, r.text)
    assert.equal(r.json?.error?.code, code, r.text)
  }
  /** An upload as the apps send it; `matchExternalId`: the app names the match (newer apps). */
  const upload = (user, path, buf, { matchExternalId } = {}) =>
    api(srv.base, '/api/storage/upload', { token: user.token, body: { bucket: 'scoresheets', path, fileBase64: buf.toString('base64'), contentType: 'application/pdf', upsert: true, ...(matchExternalId ? { match_external_id: matchExternalId } : {}) } })
  const remove = (user, paths) => api(srv.base, '/api/storage/remove', { token: user.token, body: { bucket: 'scoresheets', paths } })
  const readAs = async (user, id) => {
    const r = await fetch(`${srv.base}/api/scoresheets/${id}/pdf?download=1`, { headers: { Authorization: `Bearer ${user.token}` } })
    return { status: r.status, body: Buffer.from(await r.arrayBuffer()).toString() }
  }
  async function newMatch (owner, { sport = 'indoor', hoursAgo = 3, home = 'VBC Musterdorf H1', away = 'VBC Other H1' } = {}) {
    const ext = `match_${Date.now()}_${randomBytes(3).toString('hex')}`
    const n = gameSeq++
    const scheduledAt = new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString()
    const teams = sport === 'beach'
      ? { sport_type: 'beach', team1_data: { name: home }, team2_data: { name: away } }
      : { home_team: { name: home }, away_team: { name: away } }
    const r = await call(owner, 'POST', '/api/db', { table: 'matches', action: 'insert', params: { data: { external_id: ext, status: 'live', game_n: n, scheduled_at: scheduledAt, ...teams }, returning: 'id', single: true } })
    assert.equal(r.status, 200, r.text)
    const day = scheduledAt.slice(0, 10)
    return { ext, n, id: r.json.data.id, day, folder: sport === 'beach' ? `beach/${day}` : day }
  }
  /** The real close: the scorer's write of the final status (db/007 sets closed_at and closed_by). */
  async function close (user, id) {
    const r = await call(user, 'POST', '/api/db', { table: 'matches', action: 'update', params: { data: { status: 'final' }, filters: [{ type: 'eq', column: 'id', value: id }] } })
    assert.equal(r.status, 200, r.text)
  }
  // Closed `minAgo` minutes ago (the final mail waits 2 minutes after the
  // close): backdated with the triggers off, as tests/finalMail.e2e.test.js
  async function closeAgo (id, minAgo, by) {
    await sql.query(`UPDATE public.matches SET status = 'final', closed_by = $2 WHERE id = $1`, [id, by])
    await sql.query('SET session_replication_role = replica')
    try {
      await sql.query("UPDATE public.matches SET closed_by = $3, closed_at = now() - make_interval(mins => $2) + interval '123 microseconds' WHERE id = $1", [id, minAgo, by])
    } finally {
      await sql.query('SET session_replication_role = origin')
    }
  }
  /** A file put on disk as an older server stored it: no db/033 record, the owner record of its uploader. */
  function plantFile (path, buf, owners, mtimeSec) {
    const full = join(storageRoot, 'scoresheets', ...path.split('/'))
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, buf)
    if (mtimeSec) utimesSync(full, mtimeSec, mtimeSec)
    if (owners) {
      const dir = join(storageRoot, '.owners', 'scoresheets')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${createHash('sha256').update(path).digest('hex')}.json`), JSON.stringify({ key: path, owners }))
    }
  }

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-sheet-owner-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-sheet-owner-status-'))
    writeFileSync(join(statusDir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
    smtp = await startFakeSmtp({ implicitTls: false })
    srv = await bootServer({
      DATABASE_URL: db.url, STORAGE_ROOT: storageRoot, STATUS_DIR: statusDir, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
      STORAGE_BACKUP_MIN_FREE_MB: '1', STORAGE_SCORESHEETS_MIN_FREE_MB: '1', ...smtp.env(), FINAL_MAIL_SWEEP_MS: '1000'
    })
    const admin = await account('admin', ['admin'])
    await account('ivan', ['scorer']) // the matches' scorer
    await account('mallory', ['scorer']) // an approved scorer of another club: no tie to the matches
    await account('bea', ['beach:scorer'])
    await account('bob', ['beach:scorer'])
    await account('cm', ['competition_manager'])
    await account('bcm', ['beach:competition_manager'])
    const club = (await call(admin, 'POST', '/api/admin/clubs', { name: 'VBC Musterdorf', teams: ['VBC Musterdorf H1'] })).json.data.club
    await call(admin, 'PATCH', `/api/admin/clubs/${club.id}`, { contact_email: 'contact@musterdorf.example.ch' })
    assert.equal((await call(users.cm, 'PUT', '/api/settings', { send_final_email: true })).status, 200)
    await sql.query(`UPDATE public.app_settings SET changed_at = now() - interval '60 minutes'`)
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await smtp?.close?.()
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
    if (statusDir) rmSync(statusDir, { recursive: true, force: true })
  })

  it('another scorer cannot store a PDF for the match; managers and the final mail get the scorer\'s', async () => {
    const m = await newMatch(users.ivan)
    const real = pdfBytes('the real final scoresheet 3:1')
    // an older app: no match named, the server finds it by the path
    assert.equal((await upload(users.ivan, `${m.day}/game${m.n}_${key()}.pdf`, real)).status, 200)

    const forged = pdfBytes('forged by another account 0:3')
    await sleep(20)
    expectCode(await upload(users.mallory, `${m.day}/game${m.n}_${key()}.pdf`, forged), 403, 'OV_NOT_MATCH_OWNER')
    expectCode(await upload(users.mallory, `${m.day}/game${m.n}_${key()}.pdf`, forged, { matchExternalId: m.ext }), 403, 'OV_NOT_MATCH_OWNER')
    // a game number no match has
    expectCode(await upload(users.mallory, `${m.day}/game${m.n + 900}_${key()}.pdf`, forged), 404, 'OV_MATCH_NOT_FOUND')

    assert.deepEqual(await readAs(users.cm, m.id), { status: 200, body: real.toString() })
    const { rows } = await sql.query('SELECT stored_by, sha256 FROM public.match_scoresheets WHERE match_id = $1', [m.id])
    assert.deepEqual(rows, [{ stored_by: users.ivan.id, sha256: createHash('sha256').update(real).digest('hex') }])

    await closeAgo(m.id, 3, users.ivan.id)
    const mail = await smtp.waitForMail((x) => x.envelope.to.includes('contact@musterdorf.example.ch') && x.text.includes(String(m.n)), 15000)
    const raw = mail.raw.replace(/\r?\n/g, '')
    assert.equal(raw.includes(real.toString('base64')), true, 'the club gets the scorer\'s PDF')
    assert.equal(raw.includes(forged.toString('base64')), false)
  })

  it('a file of another account stored before this release is never served', async () => {
    const m = await newMatch(users.ivan)
    const real = pdfBytes('stored by the scorer before db/033')
    const now = Math.floor(Date.now() / 1000)
    plantFile(`${m.day}/game${m.n}_${key()}.pdf`, real, [users.ivan.id], now - 600)
    plantFile(`${m.day}/game${m.n}_${key()}.pdf`, pdfBytes('another account, newer'), [users.mallory.id], now - 60)
    plantFile(`${m.day}/game${m.n}_${key()}.pdf`, pdfBytes('nobody\'s, newest'), null, now - 30)
    assert.deepEqual(await readAs(users.cm, m.id), { status: 200, body: real.toString() })
    const listed = (await call(users.cm, 'GET', '/api/scoresheets?app=indoor')).json.data.matches.find((x) => x.id === m.id)
    assert.equal(listed.pdf, true)
    assert.equal(listed.pdf_updated_at, new Date((now - 600) * 1000).toISOString())

    // only a stranger's file: no PDF for this match
    const other = await newMatch(users.ivan)
    plantFile(`${other.day}/game${other.n}_${key()}.pdf`, pdfBytes('another account only'), [users.mallory.id])
    expectCode(await call(users.cm, 'GET', `/api/scoresheets/${other.id}/pdf`), 404, 'OV_SCORESHEET_NOT_FOUND')
  })

  it('a stored PDF must be a PDF', async () => {
    const m = await newMatch(users.ivan)
    expectCode(await upload(users.ivan, `${m.day}/game${m.n}_${key()}.pdf`, Buffer.from('NOT-A-PDF 0:3\n'), { matchExternalId: m.ext }), 415, 'OV_STORAGE_CONTENT_TYPE')
    expectCode(await call(users.cm, 'GET', `/api/scoresheets/${m.id}/pdf`), 404, 'OV_SCORESHEET_NOT_FOUND')
  })

  it('the match the app names must be the one of the path', async () => {
    const m = await newMatch(users.ivan)
    const other = await newMatch(users.ivan)
    expectCode(await upload(users.ivan, `${m.day}/game${m.n}_${key()}.pdf`, pdfBytes('x'), { matchExternalId: other.ext }), 400, 'OV_INVALID_REQUEST')
    const ok = await upload(users.ivan, `${m.day}/game${m.n}_${key()}.pdf`, pdfBytes('named'), { matchExternalId: m.ext })
    assert.equal(ok.status, 200, ok.text)
    assert.equal((await readAs(users.cm, m.id)).body, pdfBytes('named').toString())

    // a friendly without a game number: the name carries the external id (path-safe)
    const ext = `match_${Date.now()}_friendly`
    const day = new Date().toISOString().slice(0, 10)
    const ins = await call(users.ivan, 'POST', '/api/db', { table: 'matches', action: 'insert', params: { data: { external_id: ext, status: 'live', scheduled_at: `${day}T10:00:00Z`, home_team: { name: 'Home' }, away_team: { name: 'Away' } }, returning: 'id', single: true } })
    assert.equal(ins.status, 200, ins.text)
    const friendly = await upload(users.ivan, `${day}/game${ext.replace(/_/g, '-')}_${key()}.pdf`, pdfBytes('friendly'))
    assert.equal(friendly.status, 200, friendly.text)
    assert.equal((await readAs(users.cm, ins.json.data.id)).body, pdfBytes('friendly').toString())
    expectCode(await upload(users.mallory, `${day}/game${ext.replace(/_/g, '-')}_${key()}.pdf`, pdfBytes('x')), 403, 'OV_NOT_MATCH_OWNER')
  })

  it('after the close: the closing account stores the approval\'s PDF once; then it stays as it is', async () => {
    const m = await newMatch(users.ivan)
    await close(users.ivan, m.id)
    // the sync queue stores the approval's PDF after the close (MatchEnd)
    const p = `${m.day}/game${m.n}_${key()}.pdf`
    const approval = pdfBytes('approved 3:1')
    assert.equal((await upload(users.ivan, p, approval, { matchExternalId: m.ext })).status, 200)
    // the same job again (the answer was lost): accepted, nothing changes
    assert.equal((await upload(users.ivan, p, approval, { matchExternalId: m.ext })).status, 200)
    assert.equal((await upload(users.ivan, p, approval)).status, 200)

    expectCode(await upload(users.ivan, p, pdfBytes('changed after the close 0:3'), { matchExternalId: m.ext }), 409, 'OV_MATCH_CLOSED')
    expectCode(await upload(users.ivan, `${m.day}/game${m.n}_${key()}.pdf`, pdfBytes('second file after the close'), { matchExternalId: m.ext }), 409, 'OV_MATCH_CLOSED')
    expectCode(await upload(users.ivan, `${m.day}/game${m.n}_${key()}.pdf`, pdfBytes('second file, older app')), 409, 'OV_MATCH_CLOSED')
    expectCode(await remove(users.ivan, [p]), 409, 'OV_MATCH_CLOSED')
    assert.equal((await readAs(users.cm, m.id)).body, approval.toString())
    const { rows } = await sql.query('SELECT count(*)::int AS n FROM public.match_scoresheets WHERE match_id = $1', [m.id])
    assert.equal(rows[0].n, 1)

    // reopened by an admin and closed again: the corrected PDF is the new one
    const reopened = await call(users.admin, 'POST', `/api/admin/matches/${m.id}/reopen`, { reason: 'wrong final score' })
    assert.equal(reopened.status, 200, reopened.text)
    await close(users.ivan, m.id)
    const corrected = pdfBytes('corrected 3:2')
    assert.equal((await upload(users.ivan, p, corrected, { matchExternalId: m.ext })).status, 200)
    assert.equal((await readAs(users.cm, m.id)).body, corrected.toString())
  })

  it('after the close only the closing account (or an admin) stores the PDF', async () => {
    const m = await newMatch(users.ivan)
    await close(users.admin, m.id)
    expectCode(await upload(users.ivan, `${m.day}/game${m.n}_${key()}.pdf`, pdfBytes('creator, not the closer'), { matchExternalId: m.ext }), 409, 'OV_MATCH_CLOSED')
    const byAdmin = await upload(users.admin, `${m.day}/game${m.n}_${key()}.pdf`, pdfBytes('admin'), { matchExternalId: m.ext })
    assert.equal(byAdmin.status, 200, byAdmin.text)

    // before the close the scorer withdraws its own file as before
    const open = await newMatch(users.ivan)
    const q = `${open.day}/game${open.n}_${key()}.pdf`
    assert.equal((await upload(users.ivan, q, pdfBytes('draft'), { matchExternalId: open.ext })).status, 200)
    const rm = await remove(users.ivan, [q])
    assert.equal(rm.status, 200, rm.text)
    assert.deepEqual(rm.json.data, [{ name: q }])
    expectCode(await call(users.cm, 'GET', `/api/scoresheets/${open.id}/pdf`), 404, 'OV_SCORESHEET_NOT_FOUND')
    assert.equal((await sql.query('SELECT 1 FROM public.match_scoresheets WHERE match_id = $1', [open.id])).rows.length, 0)
  })

  it('beach (OpenBeach names no match): the path\'s match, its scorer only; nobody claims the name first', async () => {
    const m = await newMatch(users.bea, { sport: 'beach', home: 'Muster / Beispiel', away: 'Rossi / Bianchi' })
    const p = `beach/${m.day}/game${m.n}_${m.ext}.pdf`
    // the name is public (game number, external id): another beach scorer uploads it first
    expectCode(await upload(users.bob, p, pdfBytes('another beach scorer')), 403, 'OV_NOT_MATCH_OWNER')
    const ok = await upload(users.bea, p, pdfBytes('beach sheet'))
    assert.equal(ok.status, 200, ok.text)
    assert.equal((await readAs(users.bcm, m.id)).body, pdfBytes('beach sheet').toString())
  })
})
