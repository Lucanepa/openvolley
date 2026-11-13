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
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, utimesSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep, waitUntil } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'
import { startFakeSmtp } from './helpers/fakeSmtp.js'
import { CLOSED_REPLACE_GRACE_MS, LATE_EDITOR_WINDOW_MS } from '../lib/scoresheets.js'

const key = () => `k${randomBytes(16).toString('hex')}`
const pdfBytes = (label) => Buffer.from(`%PDF-1.4\n% ${label}\n%%EOF\n`)
const execFileP = promisify(execFile)
const RECORDS_SCRIPT = fileURLToPath(new URL('../scripts/scoresheet-records.mjs', import.meta.url))
const PATHS_SCRIPT = fileURLToPath(new URL('../scripts/scoresheet-paths.mjs', import.meta.url))

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
  /** A JSON file as the apps send it (the final JSON, OpenBeach's coin toss copy). */
  const uploadJson = (user, path, json) =>
    api(srv.base, '/api/storage/upload', { token: user.token, body: { bucket: 'scoresheets', path, fileBase64: Buffer.from(JSON.stringify(json)).toString('base64'), contentType: 'application/json', upsert: true } })
  /** Any upload to the bucket. */
  const put = (user, path, buf, contentType) =>
    api(srv.base, '/api/storage/upload', { token: user.token, body: { bucket: 'scoresheets', path, fileBase64: buf.toString('base64'), contentType, upsert: true } })
  /** The caller's own download: { status, code, text } (a missing file answers 200 with a code). */
  const download = async (user, path) => {
    const r = await api(srv.base, '/api/storage/download', { token: user.token, body: { bucket: 'scoresheets', path } })
    return { status: r.status, code: r.json?.error?.code ?? null, text: r.json?.data ? Buffer.from(r.json.data, 'base64').toString() : null }
  }
  const remove = (user, paths) => api(srv.base, '/api/storage/remove', { token: user.token, body: { bucket: 'scoresheets', paths } })
  const readAs = async (user, id) => {
    const r = await fetch(`${srv.base}/api/scoresheets/${id}/pdf?download=1`, { headers: { Authorization: `Bearer ${user.token}` } })
    return { status: r.status, body: Buffer.from(await r.arrayBuffer()).toString() }
  }
  /** A match row as an app inserts it (/api/db); game_n only when given. */
  async function insertMatch (owner, { ext, gameN = null, scheduledAt, sport = 'indoor', home = 'VBC Musterdorf H1', away = 'VBC Other H1', test = false }) {
    const teams = sport === 'beach'
      ? { sport_type: 'beach', team1_data: { name: home }, team2_data: { name: away } }
      : { home_team: { name: home }, away_team: { name: away } }
    const data = { external_id: ext, status: 'live', scheduled_at: scheduledAt, ...teams, ...(gameN != null ? { game_n: gameN } : {}), ...(test ? { test: true } : {}) }
    const r = await call(owner, 'POST', '/api/db', { table: 'matches', action: 'insert', params: { data, returning: 'id', single: true } })
    assert.equal(r.status, 200, r.text)
    return r.json.data.id
  }
  async function newMatch (owner, { sport = 'indoor', hoursAgo = 3, home, away, ext = `match_${Date.now()}_${randomBytes(3).toString('hex')}` } = {}) {
    const n = gameSeq++
    const scheduledAt = new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString()
    const id = await insertMatch(owner, { ext, gameN: n, scheduledAt, sport, home, away })
    const day = scheduledAt.slice(0, 10)
    return { ext, n, id, day, scheduledAt, folder: sport === 'beach' ? `beach/${day}` : day }
  }
  /** The scorer's write of a status; 'approved' and 'final' close the match (db/007 sets closed_at and closed_by). */
  async function setStatus (user, id, status) {
    const r = await call(user, 'POST', '/api/db', { table: 'matches', action: 'update', params: { data: { status }, filters: [{ type: 'eq', column: 'id', value: id }] } })
    assert.equal(r.status, 200, r.text)
  }
  const close = (user, id) => setStatus(user, id, 'final')
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
  /** The close and the match's stored PDFs `secs` seconds earlier (the grace after the close has passed). */
  async function backdate (id, secs) {
    await sql.query('SET session_replication_role = replica')
    try {
      await sql.query('UPDATE public.matches SET closed_at = closed_at - make_interval(secs => $2) WHERE id = $1', [id, secs])
    } finally {
      await sql.query('SET session_replication_role = origin')
    }
    await sql.query(`UPDATE public.match_scoresheets SET stored_at = stored_at - make_interval(secs => $2),
                       first_stored_at = first_stored_at - make_interval(secs => $2) WHERE match_id = $1`, [id, secs])
  }
  const PAST_GRACE = CLOSED_REPLACE_GRACE_MS / 1000 + 1
  /** The close of match `id`, in seconds since 1970. */
  const closedAtSec = async (id) => Number((await sql.query('SELECT extract(epoch FROM closed_at) AS t FROM public.matches WHERE id = $1', [id])).rows[0].t)
  /** `user` an editor of closed match `id` from `secs` seconds after its close (the game PIN proved then). */
  const editorAfterClose = (id, user, secs) => sql.query(
    `INSERT INTO public.match_editors (match_id, user_id, granted_via, created_at)
     SELECT id, $2, 'claim', closed_at + make_interval(secs => $3) FROM public.matches WHERE id = $1`, [id, user.id, secs])
  /** The app's sync queue deleting a match (/api/db; an open or test match only). */
  const deleteMatch = (user, id) => call(user, 'POST', '/api/db', { table: 'matches', action: 'delete', params: { filters: [{ type: 'eq', column: 'id', value: id }] } })
  /** A file time well before db/033 ran (as this suite started). */
  const BEFORE_033 = () => Math.floor(Date.now() / 1000) - 3 * 86400
  /**
   * Another match of closed match `x`'s name that the same scorer writes (a
   * test match of its game number, or an open match whose external id is the
   * game number) takes a new file in x's folder and is then deleted (/api/db,
   * as the app's sync queue): the file's record stays, without its match.
   * The file's path.
   */
  async function storeForDeletedMatch (x, kind) {
    const ext = kind === 'test match' ? `match_${Date.now()}_${randomBytes(3).toString('hex')}` : String(x.n)
    const other = await insertMatch(users.ivan, kind === 'test match'
      ? { ext, gameN: x.n, scheduledAt: new Date().toISOString(), test: true }
      : { ext, scheduledAt: new Date().toISOString() })
    const fp = `${x.day}/game${x.n}_${key()}.pdf`
    const up = await upload(users.ivan, fp, pdfBytes(`stored for the ${kind} 0:3`), { matchExternalId: ext })
    assert.equal(up.status, 200, up.text)
    const del = await deleteMatch(users.ivan, other)
    assert.equal(del.status, 200, del.text)
    assert.deepEqual((await sql.query('SELECT match_id FROM public.match_scoresheets WHERE path = $1', [fp])).rows, [{ match_id: null }], 'the record stays without its match')
    return fp
  }
  /** scripts/scoresheet-records.mjs (dry run without `--apply`): its stdout. */
  const runRecords = async (...args) =>
    (await execFileP(process.execPath, [RECORDS_SCRIPT, ...args], { env: { ...process.env, DATABASE_URL: db.url, STORAGE_ROOT: storageRoot } })).stdout
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
    await account('erin', ['scorer']) // signed in on the scorer's tablet after it (an editor once the app takes the match over)
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
    // a game number no match has (yet)
    expectCode(await upload(users.mallory, `${m.day}/game${m.n + 900}_${key()}.pdf`, forged), 503, 'OV_MATCH_NOT_FOUND')

    assert.deepEqual(await readAs(users.cm, m.id), { status: 200, body: real.toString() })
    const { rows } = await sql.query('SELECT stored_by, sha256 FROM public.match_scoresheets WHERE match_id = $1', [m.id])
    assert.deepEqual(rows, [{ stored_by: users.ivan.id, sha256: createHash('sha256').update(real).digest('hex') }])

    // the game in the imported schedule: the final mail goes to its clubs (lib/finalMail.js)
    await sql.query('INSERT INTO public.svrz_games (game_number, datetime, team_home, team_away) VALUES ($1, $2, $3, $4)',
      [String(m.n), m.scheduledAt.slice(0, 19), 'VBC Musterdorf H1', 'VBC Other H1'])
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

  it('after the close: the closing account stores the approval\'s PDF once; that file only briefly, then it stays as it is', async () => {
    const m = await newMatch(users.ivan)
    await close(users.ivan, m.id)
    // the sync queue stores the approval's PDF after the close (MatchEnd)
    const p = `${m.day}/game${m.n}_${key()}.pdf`
    const approval = pdfBytes('approved 3:1')
    assert.equal((await upload(users.ivan, p, approval, { matchExternalId: m.ext })).status, 200)
    // the same job again (the answer was lost): accepted, nothing changes
    assert.equal((await upload(users.ivan, p, approval, { matchExternalId: m.ext })).status, 200)
    assert.equal((await upload(users.ivan, p, approval)).status, 200)
    const firstStore = async () => (await sql.query('SELECT first_stored_at FROM public.match_scoresheets WHERE path = $1', [p])).rows[0].first_stored_at

    // another file after the close: refused (the new app's request and an older app's)
    expectCode(await upload(users.ivan, `${m.day}/game${m.n}_${key()}.pdf`, pdfBytes('second file after the close'), { matchExternalId: m.ext }), 409, 'OV_MATCH_CLOSED')
    expectCode(await upload(users.ivan, `${m.day}/game${m.n}_${key()}.pdf`, pdfBytes('second file, older app')), 409, 'OV_MATCH_CLOSED')
    expectCode(await remove(users.ivan, [p]), 409, 'OV_MATCH_CLOSED')

    // that same file, right after (the next queued approval file): replaced;
    // its first store's time stays, so the grace is not drawn out
    const first = await firstStore()
    assert.ok(first instanceof Date, 'the first store of the approval is noted')
    const queuedNext = pdfBytes('approved 3:1, the later queued file')
    assert.equal((await upload(users.ivan, p, queuedNext)).status, 200)
    assert.equal((await firstStore()).getTime(), first.getTime())
    assert.equal((await readAs(users.cm, m.id)).body, queuedNext.toString())

    // after the grace (days later, a dispute): that file stays as it is too
    await backdate(m.id, PAST_GRACE)
    expectCode(await upload(users.ivan, p, pdfBytes('changed after the close 0:3'), { matchExternalId: m.ext }), 409, 'OV_MATCH_CLOSED')
    expectCode(await upload(users.ivan, p, pdfBytes('changed after the close, older app 0:3')), 409, 'OV_MATCH_CLOSED')
    assert.equal((await upload(users.ivan, p, queuedNext, { matchExternalId: m.ext })).status, 200, 'a resent job is still answered')
    assert.equal((await readAs(users.cm, m.id)).body, queuedNext.toString())
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

  // The approval's PDF can also arrive just before the approval's write
  // closes the match (the two go in separate lanes): it is the approval's too
  it('a PDF stored just before the close is the approval\'s: later it is not changed, and no other file is added', async () => {
    const m = await newMatch(users.ivan)
    const p = `${m.day}/game${m.n}_${key()}.pdf`
    const approval = pdfBytes('approved 3:1, stored before the close')
    assert.equal((await upload(users.ivan, p, approval, { matchExternalId: m.ext })).status, 200)
    await setStatus(users.ivan, m.id, 'approved')
    // days later, a dispute
    await backdate(m.id, PAST_GRACE)
    expectCode(await upload(users.ivan, p, pdfBytes('changed after the close 0:3')), 409, 'OV_MATCH_CLOSED')
    expectCode(await upload(users.ivan, p, pdfBytes('changed after the close 0:3'), { matchExternalId: m.ext }), 409, 'OV_MATCH_CLOSED')
    expectCode(await upload(users.ivan, `${m.day}/game${m.n}_${key()}.pdf`, pdfBytes('a new file 0:3'), { matchExternalId: m.ext }), 409, 'OV_MATCH_CLOSED')
    expectCode(await upload(users.ivan, `${m.day}/game${m.n}_${key()}.pdf`, pdfBytes('a new file, older app 0:3')), 409, 'OV_MATCH_CLOSED')
    expectCode(await remove(users.ivan, [p]), 409, 'OV_MATCH_CLOSED')
    assert.equal((await readAs(users.cm, m.id)).body, approval.toString())

    // two files before the close (two tablets): a resent job of either is answered as stored
    const two = await newMatch(users.ivan)
    const [p1, p2] = [`${two.day}/game${two.n}_${key()}.pdf`, `${two.day}/game${two.n}_${key()}.pdf`]
    assert.equal((await upload(users.ivan, p1, pdfBytes('one'), { matchExternalId: two.ext })).status, 200)
    assert.equal((await upload(users.ivan, p2, pdfBytes('two'), { matchExternalId: two.ext })).status, 200)
    await setStatus(users.ivan, two.id, 'approved')
    assert.equal((await upload(users.ivan, p2, pdfBytes('two'), { matchExternalId: two.ext })).status, 200)
    expectCode(await upload(users.ivan, p2, pdfBytes('two, changed'), { matchExternalId: two.ext }), 409, 'OV_MATCH_CLOSED')
  })

  it('after the close the approval\'s PDF is stored once, by an account that writes the match; an admin stores any', async () => {
    const m = await newMatch(users.ivan)
    await close(users.admin, m.id)
    const first = await upload(users.ivan, `${m.day}/game${m.n}_${key()}.pdf`, pdfBytes('creator, not the closer'), { matchExternalId: m.ext })
    assert.equal(first.status, 200, first.text)
    expectCode(await upload(users.ivan, `${m.day}/game${m.n}_${key()}.pdf`, pdfBytes('creator, a second file'), { matchExternalId: m.ext }), 409, 'OV_MATCH_CLOSED')
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

  // An OpenBeach seed is match_<time>_<random>: its tails are external ids of
  // their own, and a match made with one must not take the real match's name
  it('beach: a match made to fit the tail of the real seed, or to clean to it, does not take the name', async () => {
    const m = await newMatch(users.bea, { sport: 'beach' })
    const p = `beach/${m.day}/game${m.n}_${m.ext}.pdf`
    for (const tail of [m.ext.slice(m.ext.lastIndexOf('_') + 1), m.ext.slice(m.ext.indexOf('_') + 1)]) {
      await insertMatch(users.bob, { ext: tail, scheduledAt: m.scheduledAt, sport: 'beach' })
      // OpenBeach's request (no match named) and the new app's (bob's own match named)
      expectCode(await upload(users.bob, p, pdfBytes('another beach scorer')), 403, 'OV_NOT_MATCH_OWNER')
      expectCode(await upload(users.bob, p, pdfBytes('another beach scorer'), { matchExternalId: tail }), 400, 'OV_INVALID_REQUEST')
    }
    const ok = await upload(users.bea, p, pdfBytes('the real beach sheet'))
    assert.equal(ok.status, 200, ok.text)
    assert.equal((await readAs(users.bcm, m.id)).body, pdfBytes('the real beach sheet').toString())

    // an external id with '-' (an imported one): another that cleans to the same seed is not its match
    const dashed = await newMatch(users.bea, { sport: 'beach', ext: `bt-${Date.now()}-x1` })
    const look = dashed.ext.replace(/-/g, '.')
    await insertMatch(users.bob, { ext: look, scheduledAt: dashed.scheduledAt, sport: 'beach' })
    const q = `beach/${dashed.day}/game${dashed.n}_${dashed.ext}.pdf`
    expectCode(await upload(users.bob, q, pdfBytes('another beach scorer')), 403, 'OV_NOT_MATCH_OWNER')
    expectCode(await upload(users.bob, q, pdfBytes('another beach scorer'), { matchExternalId: look }), 400, 'OV_INVALID_REQUEST')
    assert.equal((await upload(users.bea, q, pdfBytes('imported match sheet'))).status, 200)
    const { rows } = await sql.query('SELECT path FROM public.match_scoresheets s JOIN public.matches x ON x.id = s.match_id WHERE x.created_by = $1', [users.bob.id])
    assert.deepEqual(rows, [], 'nothing stored for the made-up matches')
  })

  it('matches another account adds under the game number do not hide the scorer\'s own (older apps)', async () => {
    const m = await newMatch(users.ivan)
    // external ids that clean to the game number, scheduled later or the same day
    const later = new Date(Date.now() + 30 * 86400 * 1000).toISOString()
    for (let k = 1; k <= 24; k++) await insertMatch(users.mallory, { ext: `${' '.repeat(k)}${m.n}`, scheduledAt: k > 21 ? m.scheduledAt : later })
    const up = await upload(users.ivan, `${m.day}/game${m.n}_${key()}.pdf`, pdfBytes('the scorer\'s sheet, older app'))
    assert.equal(up.status, 200, up.text)
    assert.equal((await readAs(users.cm, m.id)).body, pdfBytes('the scorer\'s sheet, older app').toString())
    // and mallory's own upload under that name is recorded for a match of hers, never served for this one
    assert.equal((await upload(users.mallory, `${m.day}/game${m.n}_${key()}.pdf`, pdfBytes('forged 0:3'))).status, 200)
    assert.equal((await readAs(users.cm, m.id)).body, pdfBytes('the scorer\'s sheet, older app').toString())
  })

  it('a closed match\'s PDF from before db/033 is not removed, whatever matches are added under its name', async () => {
    const m = await newMatch(users.ivan)
    const p = `${m.day}/game${m.n}_${key()}.pdf`
    plantFile(p, pdfBytes('approved before db/033'), [users.ivan.id], BEFORE_033())
    await close(users.ivan, m.id)
    const later = new Date(Date.now() + 30 * 86400 * 1000).toISOString()
    for (let k = 1; k <= 22; k++) await insertMatch(users.ivan, { ext: `${' '.repeat(k)}${m.n}`, scheduledAt: later })
    expectCode(await remove(users.ivan, [p]), 409, 'OV_MATCH_CLOSED')
    assert.deepEqual(await readAs(users.cm, m.id), { status: 200, body: pdfBytes('approved before db/033').toString() })
  })

  // The app sends every queued job in turn: approved (PDF 1 queued, the
  // match closed), the upload waits (hall Wi-Fi), an admin reopens, the
  // scorer corrects and approves again (PDF 2 queued, the same path), and
  // then both go, PDF 1 first. The new app drops PDF 1 when it queues PDF 2;
  // older apps and OpenBeach send both.
  it('after a reopen and a new approval, the corrected PDF sent after the older queued one is the stored one', async () => {
    const m = await newMatch(users.ivan)
    const p = `${m.day}/game${m.n}_${key()}.pdf`
    await setStatus(users.ivan, m.id, 'approved')
    const reopened = await call(users.admin, 'POST', `/api/admin/matches/${m.id}/reopen`, { reason: 'wrong final score' })
    assert.equal(reopened.status, 200, reopened.text)
    await setStatus(users.ivan, m.id, 'approved')
    const stale = pdfBytes('first approval 3:1 (wrong)')
    const corrected = pdfBytes('second approval 3:2 (corrected)')
    assert.equal((await upload(users.ivan, p, stale)).status, 200)
    assert.equal((await upload(users.ivan, p, corrected)).status, 200)
    assert.equal((await readAs(users.cm, m.id)).body, corrected.toString())
    // the new app's request alike
    const n = await newMatch(users.ivan)
    const q = `${n.day}/game${n.n}_${key()}.pdf`
    await setStatus(users.ivan, n.id, 'approved')
    assert.equal((await upload(users.ivan, q, stale, { matchExternalId: n.ext })).status, 200)
    assert.equal((await upload(users.ivan, q, corrected, { matchExternalId: n.ext })).status, 200)
    assert.equal((await readAs(users.cm, n.id)).body, corrected.toString())
    // the older PDF arrives while the match is reopened, the corrected one right after the new approval
    const o = await newMatch(users.ivan)
    const r = `${o.day}/game${o.n}_${key()}.pdf`
    await setStatus(users.ivan, o.id, 'approved')
    assert.equal((await call(users.admin, 'POST', `/api/admin/matches/${o.id}/reopen`, { reason: 'wrong final score' })).status, 200)
    assert.equal((await upload(users.ivan, r, stale)).status, 200)
    await setStatus(users.ivan, o.id, 'approved')
    assert.equal((await upload(users.ivan, r, corrected)).status, 200)
    assert.equal((await readAs(users.cm, o.id)).body, corrected.toString())
  })

  it('a PDF of a match not in the cloud yet: an app that names no match is asked to retry soon', async () => {
    const ext = `match_${Date.now()}_${randomBytes(3).toString('hex')}`
    const n = gameSeq++
    const scheduledAt = new Date(Date.now() - 3600 * 1000).toISOString()
    const p = `${scheduledAt.slice(0, 10)}/game${n}_${key()}.pdf`
    // older apps and OpenBeach park a 4xx for an hour: 503, retryable
    const early = await upload(users.ivan, p, pdfBytes('before the match row'))
    expectCode(early, 503, 'OV_MATCH_NOT_FOUND')
    assert.equal(early.json.error.retryable, true)
    assert.equal(early.headers.get('retry-after'), '5')
    const beachEarly = await upload(users.bea, `beach/${scheduledAt.slice(0, 10)}/game${n}_${ext}.pdf`, pdfBytes('beach, before the match row'))
    expectCode(beachEarly, 503, 'OV_MATCH_NOT_FOUND')
    // the new app names the match: 404, which it retries itself
    expectCode(await upload(users.ivan, p, pdfBytes('before the match row'), { matchExternalId: ext }), 404, 'OV_MATCH_NOT_FOUND')

    const id = await insertMatch(users.ivan, { ext, gameN: n, scheduledAt })
    assert.equal((await upload(users.ivan, p, pdfBytes('after the match row'))).status, 200)
    assert.equal((await readAs(users.cm, id)).body, pdfBytes('after the match row').toString())
  })

  // Every official match closed before db/033: its PDF is on disk without a
  // record, and it is the one the managers open (by its name and owner)
  it('a match closed before db/033 keeps the PDF it has: days later no other file, and that file only with its own bytes', async () => {
    const m = await newMatch(users.ivan, { hoursAgo: 72 })
    const p = `${m.day}/game${m.n}_${key()}.pdf`
    const approved = pdfBytes('approved before db/033 3:1')
    const mtime = Math.floor(Date.now() / 1000) - 3 * 86400
    plantFile(p, approved, [users.ivan.id], mtime)
    await closeAgo(m.id, 3 * 24 * 60, users.ivan.id)
    assert.equal((await readAs(users.cm, m.id)).body, approved.toString())

    // the closing account, days later: a new file (the new app's request and an older app's), new bytes at its path
    expectCode(await upload(users.ivan, `${m.day}/game${m.n}_${key()}.pdf`, pdfBytes('changed days later 0:3'), { matchExternalId: m.ext }), 409, 'OV_MATCH_CLOSED')
    expectCode(await upload(users.ivan, `${m.day}/game${m.n}_${key()}.pdf`, pdfBytes('changed days later, older app 0:3')), 409, 'OV_MATCH_CLOSED')
    expectCode(await upload(users.ivan, p, pdfBytes('changed days later at its path 0:3'), { matchExternalId: m.ext }), 409, 'OV_MATCH_CLOSED')
    assert.equal((await readAs(users.cm, m.id)).body, approved.toString())
    assert.equal((await sql.query('SELECT 1 FROM public.match_scoresheets WHERE match_id = $1', [m.id])).rows.length, 0)

    // its own bytes again (a job still queued from before): taken, and the file is now recorded for the match
    assert.equal((await upload(users.ivan, p, approved, { matchExternalId: m.ext })).status, 200)
    const { rows } = await sql.query('SELECT path, stored_by, first_stored_at FROM public.match_scoresheets WHERE match_id = $1', [m.id])
    assert.deepEqual(rows, [{ path: p, stored_by: users.ivan.id, first_stored_at: new Date(mtime * 1000) }])
    expectCode(await upload(users.ivan, p, pdfBytes('changed days later at its path 0:3')), 409, 'OV_MATCH_CLOSED')
    assert.equal((await readAs(users.cm, m.id)).body, approved.toString())

    // a file on disk that is not the match's (its owner did not create, edit or close it) does not count
    const o = await newMatch(users.ivan, { hoursAgo: 72 })
    plantFile(`${o.day}/game${o.n}_${key()}.pdf`, pdfBytes('another account, before db/033'), [users.mallory.id], mtime)
    await closeAgo(o.id, 3 * 24 * 60, users.ivan.id)
    const first = await upload(users.ivan, `${o.day}/game${o.n}_${key()}.pdf`, pdfBytes('the approval\'s PDF, late'), { matchExternalId: o.ext })
    assert.equal(first.status, 200, first.text)
    assert.equal((await readAs(users.cm, o.id)).body, pdfBytes('the approval\'s PDF, late').toString())

    // reopened by an admin: the old file is not the next approval's
    const r = await newMatch(users.ivan, { hoursAgo: 72 })
    plantFile(`${r.day}/game${r.n}_${key()}.pdf`, pdfBytes('first approval, before db/033'), [users.ivan.id], mtime)
    await closeAgo(r.id, 3 * 24 * 60, users.ivan.id)
    assert.equal((await call(users.admin, 'POST', `/api/admin/matches/${r.id}/reopen`, { reason: 'wrong final score' })).status, 200)
    await close(users.ivan, r.id)
    assert.equal((await upload(users.ivan, `${r.day}/game${r.n}_${key()}.pdf`, pdfBytes('corrected 3:2'), { matchExternalId: r.ext })).status, 200)
    assert.equal((await readAs(users.cm, r.id)).body, pdfBytes('corrected 3:2').toString())
  })

  // A club tablet: ivan approves (the small write closes the match), the PDF
  // upload waits, ivan signs out and erin signs in; the queue sends ivan's PDF
  // with erin's session, after taking the match over with the local game PIN
  it('after the close the approval\'s first PDF may come from another account that writes the match; then nothing else', async () => {
    const m = await newMatch(users.ivan)
    await setStatus(users.ivan, m.id, 'approved')
    await sql.query("INSERT INTO public.match_editors (match_id, user_id, granted_via) VALUES ($1, $2, 'claim')", [m.id, users.erin.id])
    // an account that may not write the match: refused as ever
    expectCode(await upload(users.mallory, `${m.day}/game${m.n}_${key()}.pdf`, pdfBytes('forged 0:3'), { matchExternalId: m.ext }), 403, 'OV_NOT_MATCH_OWNER')
    const p = `${m.day}/game${m.n}_${key()}.pdf`
    const approval = pdfBytes('approved 3:1, sent under the next account')
    const up = await upload(users.erin, p, approval, { matchExternalId: m.ext })
    assert.equal(up.status, 200, up.text)
    assert.equal((await readAs(users.cm, m.id)).body, approval.toString())
    // once per approval: another file from either account is refused
    expectCode(await upload(users.ivan, `${m.day}/game${m.n}_${key()}.pdf`, pdfBytes('another file 0:3'), { matchExternalId: m.ext }), 409, 'OV_MATCH_CLOSED')
    expectCode(await upload(users.erin, `${m.day}/game${m.n}_${key()}.pdf`, pdfBytes('another file 0:3'), { matchExternalId: m.ext }), 409, 'OV_MATCH_CLOSED')
    // that file in the grace (the next queued approval file), then never
    assert.equal((await upload(users.erin, p, pdfBytes('approved 3:1, the later queued file'), { matchExternalId: m.ext })).status, 200)
    await backdate(m.id, PAST_GRACE)
    expectCode(await upload(users.erin, p, pdfBytes('changed after the close 0:3'), { matchExternalId: m.ext }), 409, 'OV_MATCH_CLOSED')
    expectCode(await upload(users.ivan, p, pdfBytes('changed after the close 0:3'), { matchExternalId: m.ext }), 409, 'OV_MATCH_CLOSED')
    assert.equal((await readAs(users.cm, m.id)).body, pdfBytes('approved 3:1, the later queued file').toString())
  })

  it('the uploader removes its own PDF of an open match, whatever closed matches others make under its name', async () => {
    const m = await newMatch(users.ivan)
    const p = `${m.day}/game${m.n}_${key()}.pdf`
    assert.equal((await upload(users.ivan, p, pdfBytes('draft'), { matchExternalId: m.ext })).status, 200)
    const id = await insertMatch(users.mallory, { ext: ` ${m.n}`, scheduledAt: m.scheduledAt })
    await setStatus(users.mallory, id, 'final')
    const rm = await remove(users.ivan, [p])
    assert.equal(rm.status, 200, rm.text)
    assert.deepEqual(rm.json.data, [{ name: p }])
    expectCode(await call(users.cm, 'GET', `/api/scoresheets/${m.id}/pdf`), 404, 'OV_SCORESHEET_NOT_FOUND')
  })

  // OpenBeach names its files beach/{day}/game{n}_{seed}[_final].{pdf,json}:
  // no secret part, so the path of a match's files is public
  it('beach: another beach scorer cannot take the final JSON\'s path either', async () => {
    const m = await newMatch(users.bea, { sport: 'beach' })
    const finalJson = `beach/${m.day}/game${m.n}_${m.ext}_final.json`
    const tossJson = `beach/${m.day}/game${m.n}_${m.ext}.json`
    expectCode(await uploadJson(users.bob, finalJson, { forged: true }), 403, 'OV_NOT_MATCH_OWNER')
    expectCode(await uploadJson(users.bob, tossJson, { forged: true }), 403, 'OV_NOT_MATCH_OWNER')
    assert.equal((await uploadJson(users.bea, finalJson, { real: true })).status, 200)
    assert.equal((await uploadJson(users.bea, tossJson, { real: true })).status, 200)
    assert.deepEqual(await download(users.bea, finalJson), { status: 200, code: null, text: '{"real":true}' })
    expectCode(await uploadJson(users.bob, finalJson, { forged: true }), 403, 'OV_NOT_MATCH_OWNER')

    // a match not in the cloud yet (OpenBeach's coin toss copy can come first): stored as before
    const ext = `match_${Date.now()}_${randomBytes(3).toString('hex')}`
    const n = gameSeq++
    const scheduledAt = new Date(Date.now() - 3600 * 1000).toISOString()
    const early = `beach/${scheduledAt.slice(0, 10)}/game${n}_${ext}.json`
    assert.equal((await uploadJson(users.bea, early, { toss: 1 })).status, 200)
    await insertMatch(users.bea, { ext, gameN: n, scheduledAt, sport: 'beach' })
    assert.equal((await uploadJson(users.bea, early, { toss: 2 })).status, 200)
    expectCode(await uploadJson(users.bob, early, { forged: true }), 403, 'OV_NOT_MATCH_OWNER')
    // indoor JSON files carry a random part: unchanged
    const indoor = await newMatch(users.ivan)
    assert.equal((await uploadJson(users.mallory, `${indoor.day}/game${indoor.n}_${key()}_final.json`, { own: true })).status, 200)
  })

  // Taken before this release (another beach scorer uploaded the match's
  // public paths first): the real scorer's upload replaces the file, and the
  // other account loses it
  it('beach: a path another scorer took before this release goes to the match\'s scorer', async () => {
    const m = await newMatch(users.bea, { sport: 'beach' })
    const pdf = `beach/${m.day}/game${m.n}_${m.ext}.pdf`
    const finalJson = `beach/${m.day}/game${m.n}_${m.ext}_final.json`
    const now = Math.floor(Date.now() / 1000)
    plantFile(pdf, pdfBytes('squatted by another beach scorer 0:2'), [users.bob.id], now - 600)
    plantFile(finalJson, Buffer.from('{"forged":true}'), [users.bob.id], now - 600)
    expectCode(await call(users.bcm, 'GET', `/api/scoresheets/${m.id}/pdf`), 404, 'OV_SCORESHEET_NOT_FOUND')

    const up = await upload(users.bea, pdf, pdfBytes('the real beach sheet 2:0'))
    assert.equal(up.status, 200, up.text)
    assert.equal((await uploadJson(users.bea, finalJson, { real: true })).status, 200)
    assert.equal((await readAs(users.bcm, m.id)).body, pdfBytes('the real beach sheet 2:0').toString())
    assert.deepEqual(await download(users.bea, finalJson), { status: 200, code: null, text: '{"real":true}' })
    assert.equal((await download(users.bea, pdf)).text, pdfBytes('the real beach sheet 2:0').toString())
    // the other account can no longer read, replace or remove them
    for (const p of [pdf, finalJson]) assert.deepEqual(await download(users.bob, p), { status: 403, code: 'OV_STORAGE_FORBIDDEN', text: null })
    expectCode(await upload(users.bob, pdf, pdfBytes('again 0:2')), 403, 'OV_NOT_MATCH_OWNER')
    expectCode(await remove(users.bob, [pdf, finalJson]), 403, 'OV_STORAGE_FORBIDDEN')
    assert.equal((await readAs(users.bcm, m.id)).body, pdfBytes('the real beach sheet 2:0').toString())

    // a match made to clean to an imported match's seed before that match was in the cloud:
    // what its scorer stored at the seed's paths goes to the real match's scorer
    const ext = `bt-${Date.now()}-x2`
    const n = gameSeq++
    const scheduledAt = new Date(Date.now() - 3600 * 1000).toISOString()
    const day = scheduledAt.slice(0, 10)
    await insertMatch(users.bob, { ext: ext.replace(/-/g, '.'), scheduledAt, sport: 'beach' })
    const lpdf = `beach/${day}/game${n}_${ext}.pdf`
    const ljson = `beach/${day}/game${n}_${ext}_final.json`
    assert.equal((await upload(users.bob, lpdf, pdfBytes('made to fit 0:2'))).status, 200)
    assert.equal((await uploadJson(users.bob, ljson, { forged: true })).status, 200)
    const real = await insertMatch(users.bea, { ext, gameN: n, scheduledAt, sport: 'beach' })
    const taken = await upload(users.bea, lpdf, pdfBytes('the imported match\'s sheet 2:1'))
    assert.equal(taken.status, 200, taken.text)
    assert.equal((await uploadJson(users.bea, ljson, { real: true })).status, 200)
    assert.equal((await readAs(users.bcm, real)).body, pdfBytes('the imported match\'s sheet 2:1').toString())
    assert.deepEqual((await sql.query('SELECT match_id::text AS id, stored_by FROM public.match_scoresheets WHERE path = $1', [lpdf])).rows, [{ id: real, stored_by: users.bea.id }])
    for (const p of [lpdf, ljson]) assert.deepEqual(await download(users.bob, p), { status: 403, code: 'OV_STORAGE_FORBIDDEN', text: null })

    // the match's own accounts share the one path (a second tablet took the match over): both keep it
    const t = await newMatch(users.bea, { sport: 'beach' })
    const tp = `beach/${t.day}/game${t.n}_${t.ext}.pdf`
    assert.equal((await upload(users.bea, tp, pdfBytes('first tablet, a draft'))).status, 200)
    await sql.query("INSERT INTO public.match_editors (match_id, user_id, granted_via) VALUES ($1, $2, 'claim')", [t.id, users.bob.id])
    const second = await upload(users.bob, tp, pdfBytes('second tablet, approved 2:1'))
    assert.equal(second.status, 200, second.text)
    assert.equal((await readAs(users.bcm, t.id)).body, pdfBytes('second tablet, approved 2:1').toString())
    assert.equal((await download(users.bea, tp)).text, pdfBytes('second tablet, approved 2:1').toString())
  })

  // A match closed before db/033 has no record: its PDF is the file of its
  // name. Other matches of that name the same scorer writes (a test match,
  // one whose external id cleans to the game number, a later one that day)
  // are open, so their uploads come under no closed-match rule
  it('a match closed before db/033: uploads for another match of its name neither change, take nor hide its PDF', async () => {
    const mtime = Math.floor(Date.now() / 1000) - 3 * 86400
    const x = await newMatch(users.ivan, { hoursAgo: 72 })
    const p = `${x.day}/game${x.n}_${key()}.pdf`
    const approved = pdfBytes('approved before db/033 3:1')
    plantFile(p, approved, [users.ivan.id], mtime)
    await closeAgo(x.id, 3 * 24 * 60, users.ivan.id)
    const onDisk = (path) => readFileSync(join(storageRoot, 'scoresheets', ...path.split('/'))).toString()
    const kept = async () => assert.deepEqual(await readAs(users.cm, x.id), { status: 200, body: approved.toString() })
    await kept()

    // a test match of the game number (the new app names it): not at the closed match's file
    const test = `match_${Date.now()}_test`
    const ins = await call(users.ivan, 'POST', '/api/db', { table: 'matches', action: 'insert', params: { data: { external_id: test, status: 'live', scheduled_at: new Date().toISOString(), test: true, game_n: x.n, home_team: { name: 'Home' }, away_team: { name: 'Away' } }, returning: 'id', single: true } })
    assert.equal(ins.status, 200, ins.text)
    expectCode(await upload(users.ivan, p, pdfBytes('changed days later 0:3'), { matchExternalId: test }), 409, 'OV_MATCH_CLOSED')
    expectCode(await upload(users.ivan, p, approved, { matchExternalId: test }), 409, 'OV_MATCH_CLOSED')
    expectCode(await remove(users.ivan, [p]), 409, 'OV_MATCH_CLOSED')
    assert.equal(onDisk(p), approved.toString())
    assert.equal((await sql.query('SELECT 1 FROM public.match_scoresheets WHERE path = $1', [p])).rows.length, 0)
    await kept()

    // a match without a game number whose external id cleans to it: its new file is its own
    const bare = String(x.n)
    await insertMatch(users.ivan, { ext: bare, scheduledAt: new Date().toISOString() })
    assert.equal((await upload(users.ivan, `${x.day}/game${x.n}_${key()}.pdf`, pdfBytes('a new file days later 0:3'), { matchExternalId: bare })).status, 200)
    await kept()
    // an older app names no match: a later match of the scorer's that day takes the upload, as its own
    await insertMatch(users.ivan, { ext: ` ${x.n}`, scheduledAt: new Date(new Date(x.scheduledAt).getTime() + 60_000).toISOString() })
    assert.equal((await upload(users.ivan, `${x.day}/game${x.n}_${key()}.pdf`, pdfBytes('older app, days later 0:3'))).status, 200)
    expectCode(await upload(users.ivan, p, pdfBytes('older app, at its path 0:3')), 409, 'OV_MATCH_CLOSED')
    await kept()
    expectCode(await remove(users.ivan, [p]), 409, 'OV_MATCH_CLOSED')
    await kept()

    // beach, the older name without a seed: another beach match of the scorer with the game number
    const b = await newMatch(users.bea, { sport: 'beach', hoursAgo: 72 })
    const bp = `beach/${b.day}/game${b.n}.pdf`
    plantFile(bp, pdfBytes('beach approved before db/033 2:0'), [users.bea.id], mtime)
    await closeAgo(b.id, 3 * 24 * 60, users.bea.id)
    const twin = `match_${Date.now()}_twin`
    await insertMatch(users.bea, { ext: twin, gameN: b.n, scheduledAt: b.scheduledAt, sport: 'beach' })
    expectCode(await upload(users.bea, bp, pdfBytes('beach changed 0:2'), { matchExternalId: twin }), 409, 'OV_MATCH_CLOSED')
    expectCode(await upload(users.bea, bp, pdfBytes('beach changed, OpenBeach 0:2')), 409, 'OV_MATCH_CLOSED')
    assert.equal(onDisk(bp), pdfBytes('beach approved before db/033 2:0').toString())
    assert.equal((await readAs(users.bcm, b.id)).body, pdfBytes('beach approved before db/033 2:0').toString())
  })

  // The app's sync queue deletes an open or test match with an ordinary
  // /api/db delete. The record of a file stored for it stays (match_id NULL):
  // the file must not become the PDF of a closed match of the same name.
  it('a match closed before db/033: a file stored for another match of its name stays out once that match is deleted', async () => {
    const approved = pdfBytes('approved before db/033 3:1')
    const mtime = BEFORE_033()
    for (const kind of ['test match', 'open match']) {
      const x = await newMatch(users.ivan, { hoursAgo: 72 })
      plantFile(`${x.day}/game${x.n}_${key()}.pdf`, approved, [users.ivan.id], mtime)
      await closeAgo(x.id, 3 * 24 * 60, users.ivan.id)
      const fp = await storeForDeletedMatch(x, kind)
      assert.deepEqual(await readAs(users.cm, x.id), { status: 200, body: approved.toString() }, kind)
      const listed = (await call(users.cm, 'GET', `/api/scoresheets?app=indoor&q=${x.n}`)).json.data.matches.find((r) => r.id === x.id)
      assert.equal(listed.pdf_updated_at, new Date(mtime * 1000).toISOString(), 'the list shows the old file too')
      // nor does it hold the closed match: its own file stays, and the other cannot be stored for it
      expectCode(await upload(users.ivan, fp, pdfBytes(`stored for the ${kind} 0:3`), { matchExternalId: x.ext }), 409, 'OV_MATCH_CLOSED')
      // that file is no match's now: its uploader may withdraw it, and its record goes with it
      const rm = await remove(users.ivan, [fp])
      assert.equal(rm.status, 200, rm.text)
      assert.deepEqual(rm.json.data, [{ name: fp }])
      assert.equal((await sql.query('SELECT 1 FROM public.match_scoresheets WHERE path = $1', [fp])).rows.length, 0)
    }

    // an admin reopens a match with a PDF, and its scorer deletes it while
    // it is open: its file stays out of the names of a closed match too
    const y = await newMatch(users.ivan, { hoursAgo: 72 })
    plantFile(`${y.day}/game${y.n}_${key()}.pdf`, approved, [users.ivan.id], mtime)
    await closeAgo(y.id, 3 * 24 * 60, users.ivan.id)
    const z = await insertMatch(users.ivan, { ext: String(y.n), scheduledAt: y.scheduledAt })
    const zp = `${y.day}/game${y.n}_${key()}.pdf`
    assert.equal((await upload(users.ivan, zp, pdfBytes('the other match\'s sheet 0:3'), { matchExternalId: String(y.n) })).status, 200)
    await setStatus(users.ivan, z, 'approved')
    assert.equal((await call(users.admin, 'POST', `/api/admin/matches/${z}/reopen`, { reason: 'wrong final score' })).status, 200)
    assert.equal((await deleteMatch(users.ivan, z)).status, 200)
    assert.deepEqual(await readAs(users.cm, y.id), { status: 200, body: approved.toString() })
  })

  // matches.external_id is nullable (old rows): such a closed match is found
  // by its game number, and its PDF stays its own as any closed match's
  it('a closed match without an external id keeps its PDF from before db/033', async () => {
    const n = gameSeq++
    const scheduledAt = new Date(Date.now() - 72 * 3600 * 1000).toISOString()
    const day = scheduledAt.slice(0, 10)
    const { rows: [{ id }] } = await sql.query(
      `INSERT INTO public.matches (status, scheduled_at, game_n, created_by, home_team, away_team)
       VALUES ('live', $1, $2, $3, '{"name":"VBC Musterdorf H1"}', '{"name":"VBC Other H1"}') RETURNING id::text`, [scheduledAt, n, users.ivan.id])
    const p = `${day}/game${n}_${key()}.pdf`
    const approved = pdfBytes('approved, an old row 3:1')
    plantFile(p, approved, [users.ivan.id], BEFORE_033())
    await closeAgo(id, 3 * 24 * 60, users.ivan.id)
    assert.deepEqual(await readAs(users.cm, id), { status: 200, body: approved.toString() })
    // another match of the scorer's whose external id is the game number
    const ext = String(n)
    await insertMatch(users.ivan, { ext, scheduledAt })
    expectCode(await upload(users.ivan, p, pdfBytes('changed days later 0:3'), { matchExternalId: ext }), 409, 'OV_MATCH_CLOSED')
    expectCode(await upload(users.ivan, p, pdfBytes('changed days later, older app 0:3')), 409, 'OV_MATCH_CLOSED')
    expectCode(await remove(users.ivan, [p]), 409, 'OV_MATCH_CLOSED')
    assert.equal(readFileSync(join(storageRoot, 'scoresheets', ...p.split('/'))).toString(), approved.toString())
    assert.deepEqual(await readAs(users.cm, id), { status: 200, body: approved.toString() })
  })

  // An admin releases a duplicate (release-game) and the scorer enters the
  // game again in a new match: the same game number, the same day
  it('a game entered again after its duplicate was released: the new match\'s PDF after its close is its own', async () => {
    for (const named of [true, false]) {
      const a = await newMatch(users.ivan)
      assert.equal((await upload(users.ivan, `${a.day}/game${a.n}_${key()}.pdf`, pdfBytes('the duplicate, wrong 0:3'), { matchExternalId: a.ext })).status, 200)
      await setStatus(users.ivan, a.id, 'approved')
      const rel = await call(users.admin, 'POST', `/api/admin/matches/${a.id}/release-game`, { reason: 'Duplicate' })
      assert.equal(rel.status, 200, rel.text)
      const ext = `match_${Date.now()}_${randomBytes(3).toString('hex')}`
      const b = await insertMatch(users.ivan, { ext, gameN: a.n, scheduledAt: a.scheduledAt })
      await setStatus(users.ivan, b, 'approved')
      // the new app names the match; an older app does not
      const up = await upload(users.ivan, `${a.day}/game${a.n}_${key()}.pdf`, pdfBytes('entered again 3:1'), named ? { matchExternalId: ext } : {})
      assert.equal(up.status, 200, up.text)
      assert.equal((await readAs(users.cm, b)).body, pdfBytes('entered again 3:1').toString())
      assert.equal((await readAs(users.cm, a.id)).body, pdfBytes('the duplicate, wrong 0:3').toString())
    }
  })

  // The other order: the duplicate was approved (closed) with its PDF still
  // queued on an older app (no match named), and that PDF comes once the game
  // has been entered again, while the new match is open
  it('a released duplicate\'s late PDF (older app) is the duplicate\'s; the game entered again stores its own after its close', async () => {
    for (const named of [true, false]) {
      const a = await newMatch(users.ivan)
      await setStatus(users.ivan, a.id, 'approved')
      const rel = await call(users.admin, 'POST', `/api/admin/matches/${a.id}/release-game`, { reason: 'Duplicate' })
      assert.equal(rel.status, 200, rel.text)
      const ext = `match_${Date.now()}_${randomBytes(3).toString('hex')}`
      const b = await insertMatch(users.ivan, { ext, gameN: a.n, scheduledAt: a.scheduledAt })
      const late = await upload(users.ivan, `${a.day}/game${a.n}_${key()}.pdf`, pdfBytes('the duplicate, wrong 0:3'))
      assert.equal(late.status, 200, late.text)
      const recorded = (await sql.query('SELECT match_id::text AS id FROM public.match_scoresheets WHERE match_id IN ($1, $2)', [a.id, b])).rows.map((r) => r.id)
      assert.deepEqual(recorded, [a.id], 'the late PDF is the closed duplicate\'s')
      await setStatus(users.ivan, b, 'approved')
      const own = await upload(users.ivan, `${a.day}/game${a.n}_${key()}.pdf`, pdfBytes('entered again 3:1'), named ? { matchExternalId: ext } : {})
      assert.equal(own.status, 200, own.text)
      assert.equal((await readAs(users.cm, b)).body, pdfBytes('entered again 3:1').toString())
      assert.equal((await readAs(users.cm, a.id)).body, pdfBytes('the duplicate, wrong 0:3').toString())
    }
  })

  it('a closed match\'s PDF without an owner record (stored before owner records, or its uploader\'s account deleted) is not overwritten', async () => {
    const m = await newMatch(users.ivan, { hoursAgo: 72 })
    const p = `${m.day}/game${m.n}_${key()}.pdf`
    plantFile(p, pdfBytes('approved, the uploader gone 3:1'), null, Math.floor(Date.now() / 1000) - 3 * 86400)
    await closeAgo(m.id, 3 * 24 * 60, users.ivan.id)
    expectCode(await upload(users.ivan, p, pdfBytes('overwritten days later 0:3'), { matchExternalId: m.ext }), 403, 'OV_STORAGE_FORBIDDEN')
    expectCode(await upload(users.ivan, p, pdfBytes('overwritten days later, older app 0:3')), 403, 'OV_STORAGE_FORBIDDEN')
    assert.equal(readFileSync(join(storageRoot, 'scoresheets', ...p.split('/'))).toString(), pdfBytes('approved, the uploader gone 3:1').toString())
  })

  // A day folder's and a scoresheet's path are public (game numbers, days,
  // beach seeds), and lib/storage.js never replaces a folder with a file or
  // the other way round: a file at a day's name, or one below a scoresheet's
  // name, would refuse the real uploads there for good
  it('uploads go only to the apps\' paths: no file at a day folder\'s name, no folder at a scoresheet\'s name', async () => {
    const soon = new Date(Date.now() + 3 * 86400 * 1000).toISOString().slice(0, 10)
    const b = await newMatch(users.bea, { sport: 'beach' })
    const bpdf = `beach/${b.day}/game${b.n}_${b.ext}.pdf`
    const bjson = `beach/${b.day}/game${b.n}_${b.ext}_final.json`
    const squats = [
      [users.bob, `${bpdf}/x.json`, 'application/json'],
      [users.bob, `${bjson}/x.json`, 'application/json'],
      [users.erin, soon, 'text/plain'],
      [users.bob, `beach/${soon}`, 'text/plain'],
      [users.bob, 'beach', 'text/plain'],
      [users.bob, `beach/${soon}/x/game1.json`, 'application/json'],
      [users.bob, `beach/game${b.n}_${b.ext}.pdf`, 'application/pdf'],
      [users.erin, `${soon}/game1.pdf/x.pdf`, 'application/pdf'],
      [users.erin, `${soon}/notes.txt`, 'text/plain'],
      [users.erin, `${soon}/game1_final.json.txt`, 'text/plain']
    ]
    for (const [who, p, ct] of squats) expectCode(await put(who, p, Buffer.from('x'), ct), 400, 'OV_STORAGE_INVALID_PATH')
    // a beach scorer's path that names the indoor sport is still the scorer check's
    expectCode(await put(users.bob, `${soon}/game1_final.json`, Buffer.from('{}'), 'application/json'), 403, 'OV_SCORER_REQUIRED')

    // the apps' own files, of every version, are stored as before
    assert.equal((await upload(users.bea, bpdf, pdfBytes('the real beach sheet'))).status, 200)
    assert.equal((await uploadJson(users.bea, bjson, { real: true })).status, 200)
    assert.equal((await uploadJson(users.bea, `beach/${b.day}/game${b.n}_final.json`, { older: true })).status, 200)
    assert.equal((await readAs(users.bcm, b.id)).body, pdfBytes('the real beach sheet').toString())
    const m = await newMatch(users.ivan, { hoursAgo: -72 })
    assert.equal((await upload(users.ivan, `${m.day}/game${m.n}_${key()}.pdf`, pdfBytes('indoor sheet'), { matchExternalId: m.ext })).status, 200)
    assert.equal((await uploadJson(users.ivan, `${m.day}/game${m.n}_${key()}_final.json`, { real: true })).status, 200)
    assert.equal((await uploadJson(users.ivan, `${m.day}/game${m.n}_final.json`, { older: true })).status, 200)
    assert.equal((await uploadJson(users.ivan, `${m.day}/gameunknown.json`, { older: true })).status, 200)
  })

  // Entries an upload of any path left before this release: the deploy step
  // scripts/scoresheet-paths.mjs removes them, and nothing else
  it('scripts/scoresheet-paths.mjs removes what an upload of another path left in the way of the apps\' paths', async () => {
    const run = async (...args) => (await execFileP(process.execPath, [PATHS_SCRIPT, ...args], { env: { ...process.env, STORAGE_ROOT: storageRoot } })).stdout
    const onDisk = (p) => existsSync(join(storageRoot, 'scoresheets', ...p.split('/')))
    const ownerRecord = (p) => existsSync(join(storageRoot, '.owners', 'scoresheets', `${createHash('sha256').update(p).digest('hex')}.json`))
    const [day, beachDay] = ['2031-02-03', '2031-02-04']
    const ext = `match_${Date.now()}_paths`
    const n = gameSeq++
    await insertMatch(users.ivan, { ext, gameN: n, scheduledAt: `${day}T10:00:00Z` })
    const bext = `match_${Date.now()}_pathsb`
    const bn = gameSeq++
    await insertMatch(users.bea, { ext: bext, gameN: bn, scheduledAt: `${beachDay}T10:00:00Z`, sport: 'beach' })
    const b = await newMatch(users.bea, { sport: 'beach' })
    const bpdf = `beach/${b.day}/game${b.n}_${b.ext}.pdf`
    const legacyJson = `${b.day}/game${b.n}_final.json`
    // as the server stored them before: a file at a day folder's name (indoor,
    // beach), a file below a beach PDF's name, and two levels below an indoor JSON's
    plantFile(day, Buffer.from('x'), [users.erin.id])
    plantFile(`beach/${beachDay}`, Buffer.from('x'), [users.bob.id])
    plantFile(`${bpdf}/x.json`, Buffer.from('{}'), [users.bob.id])
    plantFile(`${legacyJson}/a/b.json`, Buffer.from('{}'), [users.erin.id])
    // off the apps' paths, but in nobody's way: left as it is
    plantFile(`${b.day}/notes.txt`, Buffer.from('x'), [users.erin.id])
    const uploads = async () => [
      await upload(users.ivan, `${day}/game${n}_${key()}.pdf`, pdfBytes('indoor sheet'), { matchExternalId: ext }),
      await upload(users.bea, bpdf, pdfBytes('the real beach sheet')),
      await upload(users.bea, `beach/${beachDay}/game${bn}_${bext}.pdf`, pdfBytes('beach sheet of that day')),
      await uploadJson(users.ivan, legacyJson, { older: true })
    ]
    for (const r of await uploads()) expectCode(r, 409, 'OV_STORAGE_CONFLICT')

    const dry = await run()
    for (const line of [`file ${day}`, `file beach/${beachDay}`, `folder ${bpdf}`, `folder ${legacyJson}`]) assert.ok(dry.split('\n').includes(line), `${line}\n${dry}`)
    assert.match(dry, /^4 entries in the way of the apps' scoresheet paths: to remove \(dry run/m)
    assert.equal(onDisk(day) && onDisk(`${bpdf}/x.json`), true, 'a dry run removes nothing')

    assert.match(await run('--apply'), /^4 entries in the way of the apps' scoresheet paths: removed/m)
    for (const p of [day, `beach/${beachDay}`, bpdf, legacyJson]) assert.equal(onDisk(p), false, p)
    for (const p of [day, `${bpdf}/x.json`, `${legacyJson}/a/b.json`]) assert.equal(ownerRecord(p), false, `the owner record of ${p} went with it`)
    assert.equal(onDisk(`${b.day}/notes.txt`), true)
    for (const r of await uploads()) assert.equal(r.status, 200, r.text)
    assert.equal((await readAs(users.bcm, b.id)).body, pdfBytes('the real beach sheet').toString())
    assert.match(await run(), /^0 entries/m)
  })

  // The game PIN shows on the scorer's tablet during the match. An account
  // that proves it after the close becomes an editor (POST /api/match/claim:
  // a shared tablet's next account sends the approval's PDF so), but its own
  // older file of the match's name does not become the closed match's sheet
  it('a match closed before db/033: an editor added after the close does not make its older file of the name the match\'s', async () => {
    const mtime = BEFORE_033()
    const approved = pdfBytes('approved before db/033 3:1')
    const closedMatch = async () => {
      const x = await newMatch(users.ivan, { hoursAgo: 72 })
      const pin = String(100000 + (x.n % 899999))
      await sql.query('UPDATE public.matches SET game_pin = $2 WHERE id = $1', [x.id, pin])
      const p = `${x.day}/game${x.n}_${key()}.pdf`
      plantFile(p, approved, [users.ivan.id], mtime)
      // another scorer's file of the name, newer, also from before db/033 (any scorer could store one then)
      const forged = `${x.day}/game${x.n}_${key()}.pdf`
      plantFile(forged, pdfBytes('another scorer, before db/033 0:3'), [users.mallory.id], mtime + 3600)
      await closeAgo(x.id, 3 * 24 * 60, users.ivan.id)
      return { ...x, pin, p, forged }
    }
    const claim = async (x) => {
      const r = await call(users.mallory, 'POST', '/api/match/claim', { externalId: x.ext, pin: x.pin })
      assert.equal(r.status, 200, r.text)
      assert.equal(r.json.data.role, 'editor')
    }
    const kept = async (x) => assert.deepEqual(await readAs(users.cm, x.id), { status: 200, body: approved.toString() })

    // the claim before the deploy step
    const x = await closedMatch()
    await claim(x)
    await kept(x)
    const listed = (await call(users.cm, 'GET', `/api/scoresheets?app=indoor&q=${x.n}`)).json.data.matches.find((r) => r.id === x.id)
    assert.equal(listed.pdf_updated_at, new Date(mtime * 1000).toISOString())
    expectCode(await upload(users.mallory, x.forged, pdfBytes('another scorer, before db/033 0:3'), { matchExternalId: x.ext }), 409, 'OV_MATCH_CLOSED')
    expectCode(await upload(users.mallory, `${x.day}/game${x.n}_${key()}.pdf`, pdfBytes('another scorer, now 0:3'), { matchExternalId: x.ext }), 409, 'OV_MATCH_CLOSED')
    // a shared tablet before db/033: the next account claimed the closed
    // match soon after the close and its queue stored the PDF then; the
    // names no longer give that file, the step counts it
    const h = await newMatch(users.ivan, { hoursAgo: 72 })
    await closeAgo(h.id, 3 * 24 * 60, users.ivan.id)
    await editorAfterClose(h.id, users.erin, 300)
    plantFile(`${h.day}/game${h.n}_${key()}.pdf`, pdfBytes('sent under the next account 3:1'), [users.erin.id], Math.floor(await closedAtSec(h.id)) + 600)
    expectCode(await call(users.cm, 'GET', `/api/scoresheets/${h.id}/pdf`), 404, 'OV_SCORESHEET_NOT_FOUND')
    // and no other file takes its place
    expectCode(await upload(users.ivan, `${h.day}/game${h.n}_${key()}.pdf`, pdfBytes('a new file days later 0:3'), { matchExternalId: h.ext }), 409, 'OV_MATCH_CLOSED')

    assert.match(await runRecords(), /, [1-9]\d* only with a file of an editor added after the close/)
    await runRecords('--apply')
    assert.deepEqual((await sql.query('SELECT path, stored_by FROM public.match_scoresheets WHERE match_id = $1', [x.id])).rows, [{ path: x.p, stored_by: users.ivan.id }])
    assert.deepEqual((await sql.query('SELECT 1 FROM public.match_scoresheets WHERE match_id = $1', [h.id])).rows, [])
    await kept(x)

    // the claim after the step
    const y = await closedMatch()
    await runRecords('--apply')
    await claim(y)
    await kept(y)
    expectCode(await upload(users.mallory, y.forged, pdfBytes('another scorer, before db/033 0:3'), { matchExternalId: y.ext }), 409, 'OV_MATCH_CLOSED')
    await kept(y)
  })

  // A shared tablet's queue sends the approval's PDF under the next account
  // signed in there, which proves the game PIN after the close. That is
  // allowed for LATE_EDITOR_WINDOW_MS after the close; later the PIN gives
  // no say over the closed match's sheet
  it('an account that takes a closed match over with the game PIN stores its first PDF only soon after the close', async () => {
    const closedAndClaimed = async (minAgo) => {
      const x = await newMatch(users.ivan, { hoursAgo: 72 })
      const pin = String(100000 + (x.n % 899999))
      await sql.query('UPDATE public.matches SET game_pin = $2 WHERE id = $1', [x.id, pin])
      await closeAgo(x.id, minAgo, users.ivan.id)
      const r = await call(users.mallory, 'POST', '/api/match/claim', { externalId: x.ext, pin })
      assert.equal(r.status, 200, r.text)
      assert.equal(r.json.data.role, 'editor')
      return x
    }
    const windowMin = LATE_EDITOR_WINDOW_MS / 60000
    // closed days ago, no PDF on the server at all
    const x = await closedAndClaimed(3 * 24 * 60)
    expectCode(await upload(users.mallory, `${x.day}/game${x.n}_${key()}.pdf`, pdfBytes('late claimer 0:3'), { matchExternalId: x.ext }), 409, 'OV_MATCH_CLOSED')
    expectCode(await upload(users.mallory, `${x.day}/game${x.n}_${key()}.pdf`, pdfBytes('late claimer, older app 0:3')), 409, 'OV_MATCH_CLOSED')
    expectCode(await call(users.cm, 'GET', `/api/scoresheets/${x.id}/pdf`), 404, 'OV_SCORESHEET_NOT_FOUND')
    // the scorer's approval PDF, whenever it comes
    const real = pdfBytes('the scorer\'s approval 3:1')
    assert.equal((await upload(users.ivan, `${x.day}/game${x.n}_${key()}.pdf`, real, { matchExternalId: x.ext })).status, 200)
    assert.deepEqual(await readAs(users.cm, x.id), { status: 200, body: real.toString() })
    // just past the window: the same
    const y = await closedAndClaimed(windowMin + 1)
    expectCode(await upload(users.mallory, `${y.day}/game${y.n}_${key()}.pdf`, pdfBytes('late claimer 0:3'), { matchExternalId: y.ext }), 409, 'OV_MATCH_CLOSED')
    // within it: the approval's first PDF, as a shared tablet's queue sends it
    const z = await closedAndClaimed(windowMin - 5)
    const sent = pdfBytes('approved 3:1, sent under the next account')
    assert.equal((await upload(users.mallory, `${z.day}/game${z.n}_${key()}.pdf`, sent, { matchExternalId: z.ext })).status, 200)
    assert.deepEqual(await readAs(users.cm, z.id), { status: 200, body: sent.toString() })
  })

  // Support: an admin adds the account a tablet's queue sends the PDF under
  // (the admin console's "Add editor", POST /api/admin/matches/:id/editors).
  // A deliberate grant, not the game PIN: it counts at any time
  it('an editor an admin adds to a closed match stores its first PDF also long after the close', async () => {
    const addEditor = async (x, user) => {
      const r = await call(users.admin, 'POST', `/api/admin/matches/${x.id}/editors`, { email: user.email })
      assert.equal(r.status, 200, r.text)
      assert.equal(r.json.data.role, 'editor')
      assert.deepEqual((await sql.query('SELECT granted_via FROM public.match_editors WHERE match_id = $1 AND user_id = $2', [x.id, user.id])).rows, [{ granted_via: 'admin' }])
    }
    // a day after the close, no PDF on the server: the new app (match named) and an older app (path only)
    for (const named of [true, false]) {
      const x = await newMatch(users.ivan, { hoursAgo: 72 })
      await closeAgo(x.id, 24 * 60, users.ivan.id)
      await addEditor(x, users.erin)
      const sent = pdfBytes(`queued on the tablet 3:1, ${named ? 'match named' : 'older app'}`)
      const up = await upload(users.erin, `${x.day}/game${x.n}_${key()}.pdf`, sent, named ? { matchExternalId: x.ext } : {})
      assert.equal(up.status, 200, up.text)
      assert.deepEqual(await readAs(users.cm, x.id), { status: 200, body: sent.toString() })
      // then once per approval, as for every account
      expectCode(await upload(users.erin, `${x.day}/game${x.n}_${key()}.pdf`, pdfBytes('another file 0:3'), { matchExternalId: x.ext }), 409, 'OV_MATCH_CLOSED')
    }
    // the account had taken the match over with the game PIN days after the
    // close (refused); the admin's grant then counts for it
    const y = await newMatch(users.ivan, { hoursAgo: 72 })
    const pin = String(100000 + (y.n % 899999))
    await sql.query('UPDATE public.matches SET game_pin = $2 WHERE id = $1', [y.id, pin])
    await closeAgo(y.id, 2 * 24 * 60, users.ivan.id)
    assert.equal((await call(users.erin, 'POST', '/api/match/claim', { externalId: y.ext, pin })).status, 200)
    const fp = `${y.day}/game${y.n}_${key()}.pdf`
    const sent = pdfBytes('queued on the tablet 3:1, claimed before')
    expectCode(await upload(users.erin, fp, sent, { matchExternalId: y.ext }), 409, 'OV_MATCH_CLOSED')
    await addEditor(y, users.erin)
    assert.equal((await upload(users.erin, fp, sent, { matchExternalId: y.ext })).status, 200)
    assert.deepEqual(await readAs(users.cm, y.id), { status: 200, body: sent.toString() })
    // the game PIN alone still gives no say: another account that proves it now
    assert.equal((await call(users.mallory, 'POST', '/api/match/claim', { externalId: y.ext, pin })).status, 200)
    expectCode(await upload(users.mallory, fp, pdfBytes('late claimer 0:3'), { matchExternalId: y.ext }), 409, 'OV_MATCH_CLOSED')
    // a match closed before db/033 whose file of its name is that account's
    // (stored days after the close): the admin's grant makes it the match's
    const h = await newMatch(users.ivan, { hoursAgo: 96 })
    await closeAgo(h.id, 4 * 24 * 60, users.ivan.id)
    const queued = pdfBytes('sent under the next account before db/033 3:1')
    plantFile(`${h.day}/game${h.n}_${key()}.pdf`, queued, [users.erin.id], Math.floor(await closedAtSec(h.id)) + 86400)
    expectCode(await call(users.cm, 'GET', `/api/scoresheets/${h.id}/pdf`), 404, 'OV_SCORESHEET_NOT_FOUND')
    await addEditor(h, users.erin)
    assert.deepEqual(await readAs(users.cm, h.id), { status: 200, body: queued.toString() })
    expectCode(await upload(users.ivan, `${h.day}/game${h.n}_${key()}.pdf`, pdfBytes('a new file days later 0:3'), { matchExternalId: h.ext }), 409, 'OV_MATCH_CLOSED')
  })

  // The window bounds the first PDF of an account that proved the game PIN
  // after the close; the file it stored within it is replaced as any
  // uploader's (CLOSED_REPLACE_GRACE_MS after its first store)
  it('an account that took a closed match over with the game PIN replaces its PDF within the grace, also just past the window', async () => {
    const x = await newMatch(users.ivan, { hoursAgo: 72 })
    const pin = String(100000 + (x.n % 899999))
    await sql.query('UPDATE public.matches SET game_pin = $2 WHERE id = $1', [x.id, pin])
    await closeAgo(x.id, LATE_EDITOR_WINDOW_MS / 60000 - 3, users.ivan.id)
    assert.equal((await call(users.erin, 'POST', '/api/match/claim', { externalId: x.ext, pin })).status, 200)
    const fp = `${x.day}/game${x.n}_${key()}.pdf`
    const first = pdfBytes('approved 3:1, sent under the next account')
    assert.equal((await upload(users.erin, fp, first, { matchExternalId: x.ext })).status, 200)
    // five minutes on: the window has ended, the grace has not
    await backdate(x.id, 300)
    assert.equal((await upload(users.erin, fp, first, { matchExternalId: x.ext })).status, 200, 'a resent job')
    const corrected = pdfBytes('corrected approval 3:2, sent under the next account')
    const up = await upload(users.erin, fp, corrected, { matchExternalId: x.ext })
    assert.equal(up.status, 200, up.text)
    assert.deepEqual(await readAs(users.cm, x.id), { status: 200, body: corrected.toString() })
    // nothing else: another file, another account that proves the PIN now, that file after the grace
    expectCode(await upload(users.erin, `${x.day}/game${x.n}_${key()}.pdf`, pdfBytes('another file 0:3'), { matchExternalId: x.ext }), 409, 'OV_MATCH_CLOSED')
    assert.equal((await call(users.mallory, 'POST', '/api/match/claim', { externalId: x.ext, pin })).status, 200)
    expectCode(await upload(users.mallory, fp, pdfBytes('late claimer 0:3'), { matchExternalId: x.ext }), 409, 'OV_MATCH_CLOSED')
    await backdate(x.id, PAST_GRACE)
    expectCode(await upload(users.erin, fp, pdfBytes('changed later 0:3'), { matchExternalId: x.ext }), 409, 'OV_MATCH_CLOSED')
    assert.deepEqual(await readAs(users.cm, x.id), { status: 200, body: corrected.toString() })
  })

  // A file of the match's name without a record (any scorer could store one
  // before db/033) holds a closed match's PDF back only as the approval's
  // PDF of a shared tablet: stored by an account added after the close,
  // after it was added and within LATE_EDITOR_WINDOW_MS of the close
  it('a file of an account added after the close holds the closed match\'s PDF back only when that account stored it soon after the close', async () => {
    // closed a minute ago, its PDF still queued on the scorer's tablet; the
    // other account has a file of the name from days before and takes the
    // match over with the game PIN
    const x = await newMatch(users.ivan, { hoursAgo: 2 })
    const pin = String(100000 + (x.n % 899999))
    await sql.query('UPDATE public.matches SET game_pin = $2 WHERE id = $1', [x.id, pin])
    plantFile(`${x.day}/game${x.n}_${key()}.pdf`, pdfBytes('stored before db/033 0:3'), [users.mallory.id], BEFORE_033() - 2 * 86400)
    await closeAgo(x.id, 1, users.ivan.id)
    const claim = await call(users.mallory, 'POST', '/api/match/claim', { externalId: x.ext, pin })
    assert.equal(claim.status, 200, claim.text)
    const real = pdfBytes('the scorer\'s approval 3:1')
    const up = await upload(users.ivan, `${x.day}/game${x.n}_${key()}.pdf`, real, { matchExternalId: x.ext })
    assert.equal(up.status, 200, up.text)
    assert.deepEqual(await readAs(users.cm, x.id), { status: 200, body: real.toString() })
    // a match closed before db/033 with only such a file: stored before its
    // account was added, or later than the window
    for (const [kind, addedSecs, storedSecs] of [['before its account was added', 600, 300], ['after the window', 300, LATE_EDITOR_WINDOW_MS / 1000 + 60]]) {
      const h = await newMatch(users.ivan, { hoursAgo: 72 })
      await closeAgo(h.id, 3 * 24 * 60, users.ivan.id)
      await editorAfterClose(h.id, users.erin, addedSecs)
      plantFile(`${h.day}/game${h.n}_${key()}.pdf`, pdfBytes(`the other account, ${kind} 0:3`), [users.erin.id], Math.floor(await closedAtSec(h.id)) + storedSecs)
      expectCode(await call(users.cm, 'GET', `/api/scoresheets/${h.id}/pdf`), 404, 'OV_SCORESHEET_NOT_FOUND')
      const own = pdfBytes(`the scorer's approval, ${kind} 3:1`)
      const r = await upload(users.ivan, `${h.day}/game${h.n}_${key()}.pdf`, own, { matchExternalId: h.ext })
      assert.equal(r.status, 200, `${kind}: ${r.text}`)
      assert.deepEqual(await readAs(users.cm, h.id), { status: 200, body: own.toString() }, kind)
    }
  })

  // RUNBOOK "Restore the database" (a dump older than a PDF's record; the
  // storage is kept) and "Bad backend release" (the previous image stores
  // PDFs without a record): the closed match's PDF is still found by its
  // name and held as before, and the deploy step records it again
  it('a closed match\'s PDF whose record is gone (database restore) or was never written (older backend) stays its PDF', async () => {
    const hoursAgo = Math.floor(Date.now() / 1000) - 3 * 3600
    const done = []
    for (const kind of ['restore', 'rollback']) {
      const x = await newMatch(users.ivan, { hoursAgo: 4 })
      const p = `${x.day}/game${x.n}_${key()}.pdf`
      const real = pdfBytes(`the real sheet, ${kind} 3:1`)
      if (kind === 'restore') {
        assert.equal((await upload(users.ivan, p, real, { matchExternalId: x.ext })).status, 200)
        await setStatus(users.ivan, x.id, 'approved')
        await sql.query('DELETE FROM public.match_scoresheets WHERE match_id = $1', [x.id])
      } else {
        await setStatus(users.ivan, x.id, 'approved')
        plantFile(p, real, [users.ivan.id])
      }
      // a file stored well after db/033 ran
      assert.deepEqual(await readAs(users.cm, x.id), { status: 200, body: real.toString() }, kind)
      // hours after the close
      utimesSync(join(storageRoot, 'scoresheets', ...p.split('/')), hoursAgo, hoursAgo)
      await backdate(x.id, 3 * 3600)
      expectCode(await upload(users.ivan, `${x.day}/game${x.n}_${key()}.pdf`, pdfBytes('changed hours later 0:3'), { matchExternalId: x.ext }), 409, 'OV_MATCH_CLOSED')
      expectCode(await upload(users.ivan, `${x.day}/game${x.n}_${key()}.pdf`, pdfBytes('changed hours later, older app 0:3')), 409, 'OV_MATCH_CLOSED')
      expectCode(await upload(users.ivan, p, pdfBytes('changed hours later 0:3')), 409, 'OV_MATCH_CLOSED')
      expectCode(await remove(users.ivan, [p]), 409, 'OV_MATCH_CLOSED')
      assert.deepEqual(await readAs(users.cm, x.id), { status: 200, body: real.toString() }, kind)
      done.push({ ...x, p })
    }
    await runRecords('--apply')
    for (const x of done) {
      assert.deepEqual((await sql.query('SELECT path, stored_by FROM public.match_scoresheets WHERE match_id = $1', [x.id])).rows, [{ path: x.p, stored_by: users.ivan.id }])
    }
  })

  // The operator step after db/033 (deploy): every match closed before it
  // gets the record of the PDF the managers already see. Last in this file:
  // it records the old files of every closed match of the database.
  it('scripts/scoresheet-records.mjs records the PDF of each match closed before db/033; the record then holds it', async () => {
    const mtime = Math.floor(Date.now() / 1000) - 3 * 86400
    const x = await newMatch(users.ivan, { hoursAgo: 72 })
    const p = `${x.day}/game${x.n}_${key()}.pdf`
    const approved = pdfBytes('approved before db/033 3:1')
    plantFile(p, approved, [users.ivan.id], mtime)
    plantFile(`${x.day}/game${x.n}_${key()}.pdf`, pdfBytes('another account, newer 0:3'), [users.mallory.id], mtime + 60)
    await closeAgo(x.id, 3 * 24 * 60, users.ivan.id)
    // one file that two closed matches have by their names (the second one's
    // external id cleans to the game number): left to the names
    const y = await newMatch(users.ivan, { hoursAgo: 72 })
    plantFile(`${y.day}/game${y.n}_${key()}.pdf`, pdfBytes('of which match?'), [users.ivan.id], mtime)
    await closeAgo(y.id, 3 * 24 * 60, users.ivan.id)
    const y2 = await insertMatch(users.ivan, { ext: String(y.n), scheduledAt: y.scheduledAt })
    await closeAgo(y2, 3 * 24 * 60, users.ivan.id)
    // before the step: a newer file of the scorer's in x's folder, stored for
    // a test match of x's game number that was deleted since (its record stays)
    const orphan = await storeForDeletedMatch(x, 'test match')
    const recordsOf = async (id) => (await sql.query('SELECT path, stored_by, sha256, size, stored_at, first_stored_at FROM public.match_scoresheets WHERE match_id = $1', [id])).rows

    assert.match(await runRecords(), /dry run/)
    assert.deepEqual(await recordsOf(x.id), [])
    assert.match(await runRecords('--apply'), /[1-9]\d* recorded, [1-9]\d* shared with another match/)
    assert.deepEqual((await sql.query('SELECT match_id FROM public.match_scoresheets WHERE path = $1', [orphan])).rows, [{ match_id: null }], 'a file of a deleted match is never recorded for another')
    assert.deepEqual(await recordsOf(x.id), [{
      path: p, stored_by: users.ivan.id, sha256: createHash('sha256').update(approved).digest('hex'), size: approved.length,
      stored_at: new Date(mtime * 1000), first_stored_at: new Date(mtime * 1000)
    }])
    assert.deepEqual([...await recordsOf(y.id), ...await recordsOf(y2)], [])
    assert.match(await runRecords('--apply'), /: 0 recorded,/)

    // the managers get what they got before, now by the record
    assert.deepEqual(await readAs(users.cm, x.id), { status: 200, body: approved.toString() })
    // after the step: another match of the name stored for and deleted, as
    // above, reaches neither the recorded match nor the shared one
    await storeForDeletedMatch(x, 'open match')
    await storeForDeletedMatch(y, 'test match')
    assert.deepEqual(await readAs(users.cm, x.id), { status: 200, body: approved.toString() })
    for (const id of [y.id, y2]) assert.deepEqual(await readAs(users.cm, id), { status: 200, body: pdfBytes('of which match?').toString() })
    // the shared one is still served by its name: logged
    await waitUntil(() => srv.output.join('').includes(`closed match ${y.id} has no recorded PDF: served by its file name`), { what: 'the by-name log line' })
    expectCode(await upload(users.ivan, p, pdfBytes('changed days later 0:3'), { matchExternalId: x.ext }), 409, 'OV_MATCH_CLOSED')
    expectCode(await upload(users.ivan, `${x.day}/game${x.n}_${key()}.pdf`, pdfBytes('a new file days later 0:3'), { matchExternalId: x.ext }), 409, 'OV_MATCH_CLOSED')
    assert.equal((await upload(users.ivan, p, approved, { matchExternalId: x.ext })).status, 200, 'a resent job is still answered')
    expectCode(await remove(users.ivan, [p]), 409, 'OV_MATCH_CLOSED')
    // released as a duplicate, the game entered again: the new match's PDF is its own
    assert.equal((await call(users.admin, 'POST', `/api/admin/matches/${x.id}/release-game`, { reason: 'Duplicate' })).status, 200)
    const ext = `match_${Date.now()}_${randomBytes(3).toString('hex')}`
    const again = await insertMatch(users.ivan, { ext, gameN: x.n, scheduledAt: x.scheduledAt })
    await setStatus(users.ivan, again, 'approved')
    const up = await upload(users.ivan, `${x.day}/game${x.n}_${key()}.pdf`, pdfBytes('entered again 3:1'), { matchExternalId: ext })
    assert.equal(up.status, 200, up.text)
    assert.equal((await readAs(users.cm, again)).body, pdfBytes('entered again 3:1').toString())
    assert.equal((await readAs(users.cm, x.id)).body, approved.toString())
  })
})
