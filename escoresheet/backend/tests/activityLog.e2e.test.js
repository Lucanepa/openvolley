/**
 * The match activity log (db/016_activity_log.sql, lib/activityLog.js):
 * the sanitizer mirrors the app's, uploads are checked (account, match
 * ownership, catalog), the admin lists / exports / deletes on request
 * (audited), retention, and account deletion.
 *
 * The end-to-end part needs PG_TEST_URL (see tests/helpers/pgTestDb.js) or
 * OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'
import * as serverSide from '../lib/activitySanitize.js'
import { checkEntry, csvLine, CSV_COLUMNS, createActivityLog, parseCursor } from '../lib/activityLog.js'

const here = dirname(fileURLToPath(import.meta.url))
const APP_SANITIZER = join(here, '..', '..', 'frontend', 'src', 'domain', 'activitySummary.js')

const entry = (patch = {}) => ({
  uid: randomUUID(), client_ts: '2026-10-07T10:00:00.000Z', kind: 'event.add', level: 'info', app: 'indoor',
  match_external_id: null, account_id: null, device_id: 'dev-1', app_version: '2.4.0', platform: 'web',
  set_index: 1, event_seq: 3, event_external_id: null, data: { type: 'point', team: 'home', scoreA: 1, scoreB: 0 }, ...patch
})

describe('activity log (unit)', () => {
  it('the server sanitizer is the app\'s (same catalog, same results)', { skip: existsSync(APP_SANITIZER) ? false : 'frontend not checked out' }, async () => {
    const app = await import(pathToFileURL(APP_SANITIZER).href)
    assert.deepEqual(serverSide.ACTIVITY_KINDS, app.ACTIVITY_KINDS)
    assert.equal(String(serverSide.DENIED_KEY), String(app.DENIED_KEY))
    const samples = [
      ['match.manual_change', { category: 'player', field: 'dob', before: '1.1.2000', after: '2.1.2000' }],
      ['sync.error', { resource: 'event', code: { gamePin: '1234', ok: 1 }, status: 409 }],
      ['app.error', { message: 'x'.repeat(400), frames: Array.from({ length: 30 }, (_, i) => `f${i}.js:${i}`) }],
      ['event.add', { type: 'point', stateSnapshot: { big: 1 }, team: 'home', image: 'data:image/png;base64,AAAA' }],
      ['nope.kind', { a: 1 }],
      // free text: PINs and long numbers redacted (leftover d)
      ['app.error', { message: 'pin 123456 failed', frames: ['a.js:1:123456', 'b?code=4444:1:2'], source: 'Passwort 98765432' }],
      ['match.manual_change', { category: 'match', field: 'hall', before: 'Halle 1234567', after: 'mot de passe 4321' }]
    ]
    for (const [kind, data] of samples) assert.deepEqual(serverSide.sanitizeActivityData(kind, data), app.sanitizeActivityData(kind, data), kind)
    assert.deepEqual(serverSide.sanitizeActivityData('app.error', { message: 'pin 123456 failed' }), { message: 'pin [redacted] failed' })
    for (const t of ['PIN: 4711', 'game 1234567', 'code=5678 x', 'HTTP 404']) assert.equal(serverSide.redactFreeText(t), app.redactFreeText(t), t)
  })

  it('checkEntry: catalog, account, shapes; the data is sanitized again', () => {
    const me = randomUUID()
    const err = checkEntry(entry({ kind: 'app.error', data: { message: 'pin 123456 failed' } }), me)
    assert.deepEqual(err.row.data, { message: 'pin [redacted] failed' })
    const ok = checkEntry(entry({ account_id: me, data: { type: 'point', gamePin: '1234', stateSnapshot: {} } }), me)
    assert.deepEqual(ok.row.data, { type: 'point' })
    assert.equal(ok.row.account_id, me)
    assert.equal(checkEntry(entry({ account_id: randomUUID() }), me).code, 'OV_ACTIVITY_ACCOUNT')
    assert.equal(checkEntry(entry({ kind: 'event.hack' }), me).code, 'OV_ACTIVITY_INVALID')
    assert.equal(checkEntry(entry({ kind: 'Event.Add' }), me).code, 'OV_ACTIVITY_INVALID')
    assert.equal(checkEntry(entry({ client_ts: 'soon' }), me).code, 'OV_ACTIVITY_INVALID')
    assert.equal(checkEntry(entry({ level: 'fatal' }), me).code, 'OV_ACTIVITY_INVALID')
    assert.equal(checkEntry(entry({ device_id: 'x'.repeat(65) }), me).code, 'OV_ACTIVITY_INVALID')
    assert.equal(checkEntry(entry({ data: [1] }), me).code, 'OV_ACTIVITY_INVALID')
    assert.equal(checkEntry(entry({ uid: 'nope' }), me).code, 'OV_ACTIVITY_INVALID')
  })

  it('page cursors: "<µs>_<id>", or a bare id from an older console', () => {
    assert.deepEqual(parseCursor('1759831201000000_42'), { us: '1759831201000000', id: '42' })
    assert.deepEqual(parseCursor('42'), { id: '42' })
    assert.equal(parseCursor('42; drop'), null)
    assert.equal(parseCursor(''), null)
  })

  it('CSV lines quote, never start a formula, and keep the columns', () => {
    const line = csvLine({ id: 1, kind: 'match.manual_change', data: { field: 'name', after: '=HYPERLINK("x")' }, device_id: '=1+1', game_n: 12 })
    assert.equal(line.split(',').length >= CSV_COLUMNS.length, true)
    assert.match(line, /'=1\+1/)
    assert.match(line, /"\{""field"":""name""/)
  })

  it('purge keeps the retention windows', async () => {
    const calls = []
    const pool = { query: async (sql, values) => { calls.push({ sql, values }); return { rowCount: 2 } } }
    const r = await createActivityLog({ pool }).purge({ now: new Date('2027-01-01T00:00:00Z') })
    assert.deepEqual(r, { unlinked: 2, linked: 2 })
    assert.match(calls[0].sql, /match_external_id IS NULL AND at </)
    assert.deepEqual(calls[0].values, ['2027-01-01T00:00:00.000Z', 90])
    assert.match(calls[1].sql, /months =>/)
    assert.deepEqual(calls[1].values, ['2027-01-01T00:00:00.000Z', 24])
  })
})

describe('activity log end to end', { skip: SKIP }, () => {
  let db, srv, sql, storageRoot, statusDir
  let ipSeq = 1
  const nextIp = () => `198.51.100.${ipSeq++}`
  const users = {}
  let gameSeq = 91100

  async function account (name, { roles = null } = {}) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const password = 'correct-horse-battery'
    const ip = nextIp()
    const up = await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password, metadata: { first_name: name, last_name: 'Test' } } })
    assert.equal(up.status, 200, up.text)
    let inn
    for (let attempt = 0; attempt < 10; attempt++) {
      inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password } })
      if (!(inn.status === 503 && inn.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    assert.equal(inn.status, 200, inn.text)
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, email, ip }
    if (roles) await grantRoles(sql, u.id, roles)
    users[name] = u
    return u
  }
  const call = (user, method, path, body) => api(srv.base, path, { method, token: user?.token, body, proto: null })
  const upload = (user, entries) => call(user, 'POST', '/api/activity', { entries })
  const expectCode = (r, status, code) => {
    assert.equal(r.status, status, r.text)
    assert.equal(r.json?.error?.code, code, r.text)
  }
  async function newMatch (owner) {
    const ext = `match_${Date.now()}_${randomBytes(3).toString('hex')}`
    const n = gameSeq++
    const r = await api(srv.base, '/api/db', { token: owner.token, body: { table: 'matches', action: 'insert', params: { data: { external_id: ext, game_n: n, status: 'live', scheduled_at: '2026-10-10T16:00:00Z' }, returning: 'id', single: true } } })
    assert.equal(r.status, 200, r.text)
    return { ext, n, id: r.json.data.id }
  }

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-act-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-act-status-'))
    writeFileSync(join(statusDir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
    srv = await bootServer({
      DATABASE_URL: db.url,
      STORAGE_ROOT: storageRoot,
      STATUS_DIR: statusDir,
      TRUST_PROXY: 'cloudflare',
      TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
      STORAGE_BACKUP_MIN_FREE_MB: '1',
      STORAGE_SCORESHEETS_MIN_FREE_MB: '1'
    })
    await account('admin', { roles: ['admin'] })
    await account('anna', { roles: ['scorer'] })
    await account('carl', { roles: ['scorer'] })
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
    if (statusDir) rmSync(statusDir, { recursive: true, force: true })
  })

  it('uploads: idempotent, sanitized, account and match ownership checked', async () => {
    const m = await newMatch(users.anna)
    const a = entry({ match_external_id: m.ext, account_id: users.anna.id, data: { type: 'point', team: 'home', gamePin: '123456' } })
    const app = entry({ kind: 'app.start', set_index: null, event_seq: null, data: { version: '2.4.0', platform: 'web' } })
    const forged = entry({ account_id: users.carl.id })
    const bad = entry({ kind: 'event.nope' })
    const pre = entry({ match_external_id: 'match_9999_future' }) // not on the server yet: accepted
    const r = await upload(users.anna, [a, app, forged, bad, pre])
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.data.accepted.sort(), [a.uid, app.uid, pre.uid].sort())
    assert.deepEqual(r.json.data.rejected.map((x) => x.code).sort(), ['OV_ACTIVITY_ACCOUNT', 'OV_ACTIVITY_INVALID'])
    const { rows: [stored] } = await sql.query('SELECT * FROM activity_log WHERE uid = $1', [a.uid])
    assert.deepEqual(stored.data, { type: 'point', team: 'home' })
    assert.equal(stored.uploader_id, users.anna.id)
    assert.equal(JSON.stringify(stored).includes('123456'), false)
    // again: nothing doubles
    assert.equal((await upload(users.anna, [a])).status, 200)
    assert.equal((await sql.query('SELECT count(*)::int n FROM activity_log WHERE uid = $1', [a.uid])).rows[0].n, 1)
    // another account cannot write into Anna's match
    const c = await upload(users.carl, [entry({ match_external_id: m.ext })])
    assert.deepEqual(c.json.data.rejected.map((x) => x.code), ['OV_NOT_MATCH_OWNER'])
    assert.equal((await upload(null, [entry()])).status, 401)
    expectCode(await upload(users.anna, new Array(501).fill(0).map(() => entry())), 400, 'OV_INVALID_REQUEST')
    // not reachable through /api/db
    const viaDb = await api(srv.base, '/api/db', { token: users.admin.token, proto: null, body: { table: 'activity_log', action: 'select', params: { columns: 'id' } } })
    assert.equal(viaDb.status >= 400, true, viaDb.text)
  })

  it('the match owner reads its match; others are refused; the admin lists, filters, exports', async () => {
    const m = await newMatch(users.anna)
    const mine = [entry({ match_external_id: m.ext, kind: 'event.undo', data: { type: 'point', reason: 'undo' } }), entry({ match_external_id: m.ext, kind: 'sync.error', level: 'warn', data: { resource: 'event', status: 409 } })]
    assert.equal((await upload(users.anna, mine)).status, 200)
    const own = await call(users.anna, 'GET', `/api/activity?match=${m.ext}`)
    assert.equal(own.status, 200, own.text)
    assert.equal(own.json.data.entries.length, 2)
    expectCode(await call(users.carl, 'GET', `/api/activity?match=${m.ext}`), 403, 'OV_NOT_MATCH_OWNER')

    const list = await call(users.admin, 'GET', `/api/admin/activity?match=${m.n}&kind=sync.&level=warn`)
    assert.equal(list.status, 200, list.text)
    assert.equal(list.json.data.entries.length, 1)
    assert.equal(list.json.data.entries[0].game_n, m.n)
    expectCode(await call(users.anna, 'GET', '/api/admin/activity'), 403, 'OV_FORBIDDEN')

    const csv = await fetch(`${srv.base}/api/admin/activity/export?match=${encodeURIComponent(m.ext)}&format=csv`, { headers: { Authorization: `Bearer ${users.admin.token}` } })
    assert.equal(csv.status, 200)
    assert.match(csv.headers.get('content-type'), /text\/csv/)
    const lines = (await csv.text()).trim().split('\n')
    assert.equal(lines[0], CSV_COLUMNS.join(','))
    assert.equal(lines.length, 3)
    const nd = await fetch(`${srv.base}/api/admin/activity/export?account=${users.anna.id}`, { headers: { Authorization: `Bearer ${users.admin.token}` } })
    assert.equal(nd.status, 200)
    assert.ok((await nd.text()).trim().split('\n').every((l) => JSON.parse(l).kind))
    const denied = await fetch(`${srv.base}/api/admin/activity/export`, { headers: { Authorization: `Bearer ${users.anna.token}` } })
    assert.equal(denied.status, 403)
  })

  it('lists in the order things happened (client_ts, then id), newest first, across pages (leftover c)', async () => {
    const m = await newMatch(users.anna)
    // uploaded out of order: the second batch happened first
    const late = ['10:00:03', '10:00:04'].map((t) => entry({ match_external_id: m.ext, client_ts: `2026-10-07T${t}.000Z` }))
    const early = ['10:00:01', '10:00:02', '10:00:02'].map((t) => entry({ match_external_id: m.ext, client_ts: `2026-10-07T${t}.000Z` }))
    assert.equal((await upload(users.anna, late)).status, 200)
    assert.equal((await upload(users.anna, early)).status, 200)
    const want = (await sql.query('SELECT uid FROM activity_log WHERE match_external_id = $1 ORDER BY client_ts DESC, id DESC', [m.ext])).rows.map((r) => r.uid)
    assert.deepEqual(want.slice(0, 2), [late[1].uid, late[0].uid])

    const pages = async (path) => {
      const out = []
      let before = null
      for (let i = 0; i < 10; i++) {
        const r = await call(users.admin, 'GET', `${path}&limit=2${before ? `&before=${encodeURIComponent(before)}` : ''}`)
        assert.equal(r.status, 200, r.text)
        out.push(...r.json.data.entries)
        assert.equal(r.json.data.entries.some((e) => 'cursor_us' in e), false)
        before = r.json.data.next
        if (!before) break
      }
      return out
    }
    assert.deepEqual((await pages(`/api/admin/activity?match=${m.ext}`)).map((e) => e.uid), want)
    assert.deepEqual((await pages(`/api/activity?match=${m.ext}`)).map((e) => e.uid), want)
    const nd = await fetch(`${srv.base}/api/admin/activity/export?match=${encodeURIComponent(m.ext)}`, { headers: { Authorization: `Bearer ${users.admin.token}` } })
    assert.deepEqual((await nd.text()).trim().split('\n').map((l) => JSON.parse(l).uid), want)
    expectCode(await call(users.admin, 'GET', `/api/admin/activity?match=${m.ext}&before=abc`), 400, 'OV_INVALID_REQUEST')
  })

  it('delete on request is audited; a deleted match takes its activity along', async () => {
    const m = await newMatch(users.anna)
    await upload(users.anna, [entry({ match_external_id: m.ext }), entry({ match_external_id: m.ext })])
    expectCode(await call(users.admin, 'DELETE', `/api/admin/activity?match=${m.ext}`), 400, 'OV_INVALID_REQUEST')
    const del = await call(users.admin, 'DELETE', `/api/admin/activity?match=${m.ext}&confirm=yes`)
    assert.equal(del.status, 200, del.text)
    assert.equal(del.json.data.deleted, 2)
    const { rows: [audit] } = await sql.query("SELECT * FROM audit_log WHERE action = 'activity.delete' ORDER BY id DESC LIMIT 1")
    assert.equal(audit.actor_id, users.admin.id)
    assert.deepEqual(audit.details, { match: m.ext, account: null, rows: 2 })

    const m2 = await newMatch(users.anna)
    await upload(users.anna, [entry({ match_external_id: m2.ext })])
    await sql.query('DELETE FROM matches WHERE id = $1', [m2.id])
    assert.equal((await sql.query('SELECT count(*)::int n FROM activity_log WHERE match_external_id = $1', [m2.ext])).rows[0].n, 0)
  })

  it('account deletion: device activity goes, match activity stays without the account', async () => {
    const dora = await account('dora', { roles: ['scorer'] })
    const m = await newMatch(dora)
    const dev = entry({ kind: 'app.start', account_id: dora.id, data: { version: '2.4.0' } })
    const inMatch = entry({ match_external_id: m.ext, account_id: dora.id })
    assert.equal((await upload(dora, [dev, inMatch])).status, 200)
    const del = await api(srv.base, '/api/auth/delete-account', { proto: null, body: { access_token: dora.token } })
    assert.equal(del.status, 200, del.text)
    assert.equal((await sql.query('SELECT count(*)::int n FROM activity_log WHERE uid = $1', [dev.uid])).rows[0].n, 0)
    const { rows: [kept] } = await sql.query('SELECT account_id, uploader_id FROM activity_log WHERE uid = $1', [inMatch.uid])
    assert.deepEqual(kept, { account_id: null, uploader_id: null })
  })

  it('retention purges old rows', async () => {
    await sql.query(`INSERT INTO activity_log (uid, client_ts, at, kind, match_external_id) VALUES
      ($1, now() - interval '100 days', now() - interval '100 days', 'app.start', NULL),
      ($2, now() - interval '25 months', now(), 'event.add', 'match_x_old'),
      ($3, now() - interval '1 day', now(), 'event.add', 'match_x_new')`, [randomUUID(), randomUUID(), randomUUID()])
    const purge = createActivityLog({ pool: sql }).purge
    const r = await purge()
    assert.ok(r.unlinked >= 1)
    assert.ok(r.linked >= 1)
    assert.equal((await sql.query("SELECT count(*)::int n FROM activity_log WHERE match_external_id = 'match_x_new'")).rows[0].n, 1)
  })
})
