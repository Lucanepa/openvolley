/**
 * The vector scoresheet PDF end to end (lib/vectorPdf.js, lib/scoresheets.js
 * rebuildVector / queueVectorCopy; field-spec 17.20), against a stand-in for
 * the render service (escoresheet/render) that answers a small PDF and keeps
 * what it was sent:
 *  - an admin's Rebuild PDF on the server: admins only, audited, stored as
 *    the closed match's newest; a failed render stores nothing;
 *  - the server's own vector copy after the approval's PDF: once the match is
 *    closed and quiet, stored as the newest, the device's PDF kept;
 *  - a backend without the service answers 503 OV_RENDER_UNAVAILABLE.
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js) or OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep, freePort, waitUntil } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'

const TOKEN = 'vector-e2e-token-'.padEnd(40, 'x')
const key = () => `k${randomBytes(16).toString('hex')}`
const pdfBytes = (label) => Buffer.from(`%PDF-1.4\n% ${label}\n%%EOF\n`)
const VECTOR = pdfBytes('vector from the render service')

describe('vector PDF end to end', { skip: SKIP }, () => {
  let db
  let sql
  let srv
  let bare
  let storageRoot
  let statusDir
  let render
  const renderCalls = []
  let renderMode = 'ok'
  const users = {}
  let ipSeq = 10
  let gameSeq = 95100
  const nextIp = () => `203.0.113.${ipSeq++}`

  async function account (name, roles) {
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
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, email }
    if (roles) await grantRoles(sql, u.id, roles)
    users[name] = u
    return u
  }
  const expectCode = (r, status, code) => {
    assert.equal(r.status, status, r.text)
    assert.equal(r.json?.error?.code, code, r.text)
  }
  async function newMatch (owner, { sport = 'indoor', set = true } = {}) {
    const ext = `match_${Date.now()}_${randomBytes(3).toString('hex')}`
    const n = gameSeq++
    // a set played: the record ends as its close says (the result the close wrote, the last
    // point at the set's score; lib/scoresheets.js recordGate, owner decision 3)
    const result = set ? { set_results: [{ set: 1, home: 25, away: 20 }], final_score: '1-0', winner: 'home' } : {}
    const data = { external_id: ext, game_n: n, status: 'live', scheduled_at: '2026-11-15T14:00:00Z', home_team: { name: `Home ${n}` }, away_team: { name: `Away ${n}` }, ...result, ...(sport === 'beach' ? { sport_type: 'beach' } : {}) }
    const r = await api(srv.base, '/api/db', { token: owner.token, body: { table: 'matches', action: 'insert', params: { data, returning: 'id', single: true } } })
    assert.equal(r.status, 200, r.text)
    if (set) {
      const s = await api(srv.base, '/api/db', { token: owner.token, body: { table: 'sets', action: 'insert', params: { data: { match_id: r.json.data.id, external_id: `${ext}:set:1`, index: 1, home_points: 25, away_points: 20, finished: true } } } })
      assert.equal(s.status, 200, s.text)
      await sql.query("INSERT INTO public.events (external_id, match_id, set_index, type, payload, seq) VALUES ($1, $2, 1, 'point', $3::json, 45)",
        [`${ext}:e:45`, r.json.data.id, JSON.stringify({ team: 'home', score: { home: 25, away: 20 } })])
    }
    return { ext, n, id: r.json.data.id }
  }
  async function uploadPdf (owner, path, label) {
    const r = await api(srv.base, '/api/storage/upload', { token: owner.token, body: { bucket: 'scoresheets', path, fileBase64: pdfBytes(label).toString('base64'), contentType: 'application/pdf' } })
    assert.equal(r.status, 200, r.text)
  }
  const closeNow = async (user, id) => {
    const r = await api(srv.base, '/api/db', { token: user.token, body: { table: 'matches', action: 'update', params: { data: { status: 'final' }, filters: [{ type: 'eq', column: 'id', value: id }] } } })
    assert.equal(r.status, 200, r.text)
  }
  const newestPdf = async (user, id) => {
    const r = await fetch(`${srv.base}/api/scoresheets/${id}/pdf`, { headers: { Authorization: `Bearer ${user.token}` } })
    assert.equal(r.status, 200)
    return Buffer.from(await r.arrayBuffer())
  }

  before(async () => {
    const port = await freePort()
    render = createServer((req, res) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        renderCalls.push({ token: req.headers['x-ov-render-token'], body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        if (renderMode === 'fail') {
          res.writeHead(503, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ error: 'render failed', code: 'OV_RENDER_FAILED' }))
        }
        res.writeHead(200, { 'content-type': 'application/pdf', 'x-ov-filename': 'game_vector.pdf' })
        res.end(VECTOR)
      })
    })
    await new Promise((r) => render.listen(port, '127.0.0.1', r))
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-vector-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-vector-status-'))
    writeFileSync(join(statusDir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
    const env = {
      DATABASE_URL: db.url,
      STORAGE_ROOT: storageRoot,
      STATUS_DIR: statusDir,
      TRUST_PROXY: 'cloudflare',
      TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
      STORAGE_BACKUP_MIN_FREE_MB: '1',
      STORAGE_SCORESHEETS_MIN_FREE_MB: '1'
    }
    srv = await bootServer({
      ...env,
      OV_RENDER_URL: `http://127.0.0.1:${port}`,
      OV_RENDER_TOKEN: TOKEN,
      OV_VECTOR_TEST_TIMES: JSON.stringify({ quietMs: 300, recheckMs: 200, graceMs: 1200, retryMs: 200, maxTries: 2, maxWaitMs: 30000 })
    })
    bare = await bootServer(env)
    await account('admin', ['admin'])
    await account('ivan', ['scorer'])
    await account('bea', ['beach:scorer'])
    await account('cm', ['competition_manager'])
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await bare?.stop()
    await db?.drop()
    await new Promise((r) => (render ? render.close(r) : r()))
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
    if (statusDir) rmSync(statusDir, { recursive: true, force: true })
  })

  it('an admin\'s Rebuild PDF on the server: admins only, audited, the vector PDF stored as the newest', async () => {
    const m = await newMatch(users.ivan, { set: false })
    const firstPath = `2026-11-15/game${m.n}_${key()}.pdf`
    await uploadPdf(users.ivan, firstPath, 'approval')
    await closeNow(users.ivan, m.id)
    const rebuild = (user, body) => api(srv.base, `/api/scoresheets/${m.id}/rebuild-vector`, { token: user?.token, body })
    expectCode(await rebuild(users.ivan, { reason: 'times' }), 403, 'OV_FORBIDDEN')
    expectCode(await rebuild(users.cm, { reason: 'times' }), 403, 'OV_FORBIDDEN')
    assert.equal((await rebuild(null, { reason: 'times' })).status, 401)
    expectCode(await rebuild(users.admin, { reason: '  ' }), 400, 'OV_INVALID_REQUEST')
    expectCode(await api(srv.base, '/api/scoresheets/00000000-0000-4000-8000-000000000000/rebuild-vector', { token: users.admin.token, body: { reason: 'x' } }), 404, 'OV_NOT_FOUND')

    // a failed render: nothing stored, the manager then captures it itself
    renderMode = 'fail'
    const before = renderCalls.length
    expectCode(await rebuild(users.admin, { reason: 'times' }), 503, 'OV_RENDER_FAILED')
    assert.equal(renderCalls.length, before + 1)
    assert.equal((await sql.query('SELECT count(*)::int n FROM public.match_scoresheets WHERE match_id = $1', [m.id])).rows[0].n, 1)

    renderMode = 'ok'
    const ok = await rebuild(users.admin, { reason: 'Set start times corrected' })
    assert.equal(ok.status, 200, ok.text)
    assert.equal(ok.json.data.mode, 'vector')
    const sent = renderCalls.at(-1)
    assert.equal(sent.token, TOKEN)
    assert.equal(sent.body.record.match.id, m.id)
    assert.equal(sent.body.record.match.game_pin, undefined, 'no PIN goes to the render service')
    assert.ok(Array.isArray(sent.body.record.sets) && Array.isArray(sent.body.record.events) && Array.isArray(sent.body.record.approvals))
    assert.equal(sent.body.rebuildReason, 'Set start times corrected')
    assert.ok(Date.parse(sent.body.rebuiltAt) > Date.now() - 60_000)
    // the closed match's newest PDF is the vector one; the approval's stays
    assert.ok((await newestPdf(users.cm, m.id)).equals(VECTOR))
    const recs = await sql.query('SELECT path FROM public.match_scoresheets WHERE match_id = $1 ORDER BY stored_at', [m.id])
    assert.equal(recs.rows.length, 2)
    assert.equal(recs.rows[0].path, firstPath)
    const audit = await sql.query("SELECT action, actor_id, details FROM audit_log WHERE match_id = $1 AND actor_id = $2 AND action IN ('scoresheet.read', 'scoresheet.rebuild') ORDER BY at", [m.id, users.admin.id])
    assert.deepEqual(audit.rows.map((x) => [x.action, x.actor_id, x.details.purpose ?? x.details.mode]), [
      ['scoresheet.read', users.admin.id, 'rebuild'],
      ['scoresheet.read', users.admin.id, 'rebuild'],
      ['scoresheet.rebuild', users.admin.id, 'vector']
    ])
    assert.equal(audit.rows[2].details.reason, 'Set start times corrected')
    assert.equal(JSON.stringify(audit.rows[2].details).includes('_k'), false, 'the random part stays out of the log')
  })

  it('after the approval\'s PDF the server makes its own vector copy once the match is closed and quiet', async () => {
    const m = await newMatch(users.ivan)
    const before = renderCalls.length
    await uploadPdf(users.ivan, `2026-11-15/game${m.n}_${key()}.pdf`, 'approval')
    // not closed yet: no copy
    await sleep(1800)
    assert.equal(renderCalls.length, before)
    await closeNow(users.ivan, m.id)
    await waitUntil(async () => (await sql.query('SELECT count(*)::int n FROM public.match_scoresheets WHERE match_id = $1', [m.id])).rows[0].n === 2,
      { timeoutMs: 20000, what: 'the vector copy stored' }).catch((err) => {
      throw new Error(`${err.message}\n--- server output ---\n${srv.output.join('').split('\n').filter((l) => /vector|scoresheets|render/i.test(l)).slice(-30).join('\n')}`)
    })
    assert.equal(renderCalls.length, before + 1)
    assert.equal(renderCalls.at(-1).body.rebuildReason, null)
    assert.ok((await newestPdf(users.cm, m.id)).equals(VECTOR))
    const audit = await sql.query("SELECT actor_id, details FROM audit_log WHERE match_id = $1 AND action = 'scoresheet.vector'", [m.id])
    assert.equal(audit.rows.length, 1)
    assert.equal(audit.rows[0].actor_id, null, 'made by the server, not by a person')
    assert.equal(audit.rows[0].details.mode, 'approval')
    // the stored file is the uploader's, like their own upload
    const rec = await sql.query('SELECT stored_by FROM public.match_scoresheets WHERE match_id = $1 ORDER BY stored_at DESC LIMIT 1', [m.id])
    assert.equal(rec.rows[0].stored_by, users.ivan.id)
  })

  it('no copy for a beach match, nor for one whose sets the close does not carry', async () => {
    const before = renderCalls.length
    const beach = await newMatch(users.bea, { sport: 'beach', set: false })
    await uploadPdf(users.bea, `beach/2026-11-15/game${beach.n}_${beach.ext}.pdf`, 'beach')
    const noSets = await newMatch(users.ivan, { set: false })
    await uploadPdf(users.ivan, `2026-11-15/game${noSets.n}_${key()}.pdf`, 'approval')
    await closeNow(users.bea, beach.id)
    await closeNow(users.ivan, noSets.id)
    await sleep(3000)
    assert.equal(renderCalls.length, before, 'nothing sent to the render service')
    assert.equal((await sql.query('SELECT count(*)::int n FROM public.match_scoresheets WHERE match_id = $1', [noSets.id])).rows[0].n, 1)
  })

  it('a backend without the render service: 503 OV_RENDER_UNAVAILABLE (the manager captures the sheet itself)', async () => {
    const m = await newMatch(users.ivan, { set: false })
    const r = await api(bare.base, `/api/scoresheets/${m.id}/rebuild-vector`, { token: users.admin.token, body: { reason: 'times' } })
    expectCode(r, 503, 'OV_RENDER_UNAVAILABLE')
  })
})
