/**
 * One backend for the scoresheet suites (tests/scoresheets.*.e2e.test.js):
 * server.js against a throwaway database and storage, optionally beside a
 * stand-in of the render service (escoresheet/render) that answers a small
 * PDF, keeps what it was sent and can report missing pictures; accounts by
 * role; the steps the apps and the manager take (a match, its sets and
 * points, the approval's PDF, the close, an admin's reopen and rebuild).
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js) or OV_E2E_DOCKER=1.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { bootServer, api, provisionDatabase, sleep, freePort } from './e2eServer.js'
import { grantRoles } from './pgTestDb.js'

export const RENDER_TOKEN = 'scoresheets-e2e-token-'.padEnd(40, 'x')
export const key = () => `k${randomBytes(16).toString('hex')}`
export const pdfBytes = (label) => Buffer.from(`%PDF-1.4\n% ${label}\n%%EOF\n`)
export const VECTOR = pdfBytes('vector from the render service')

/**
 * @param {{ render?: boolean, vectorTimes?: object, ipBase?: string, gameBase?: number }} o
 * render: a render service stand-in (OV_RENDER_URL); its `mode` 'ok' | 'fail',
 * `missingPictures` (the x-ov-missing-pictures header) and `calls`.
 */
export async function startScoresheetsStack ({ render: withRender = false, vectorTimes = null, ipBase = '203.0.113', gameBase = 96100 } = {}) {
  const st = { users: {}, render: { mode: 'ok', missingPictures: 0, calls: [] } }
  let ipSeq = 10
  let gameSeq = gameBase
  let renderServer = null
  let renderPort = null
  if (withRender) {
    renderPort = await freePort()
    renderServer = createServer((req, res) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        st.render.calls.push({ token: req.headers['x-ov-render-token'], body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        if (st.render.mode === 'fail') {
          res.writeHead(503, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ error: 'render failed', code: 'OV_RENDER_FAILED' }))
        }
        res.writeHead(200, { 'content-type': 'application/pdf', 'x-ov-filename': 'game_vector.pdf', 'x-ov-missing-pictures': String(st.render.missingPictures) })
        res.end(VECTOR)
      })
    })
    await new Promise((r) => renderServer.listen(renderPort, '127.0.0.1', r))
  }
  st.db = await provisionDatabase()
  st.sql = new pg.Client({ connectionString: st.db.url })
  await st.sql.connect()
  st.storageRoot = mkdtempSync(join(tmpdir(), 'ov-sheets-e2e-storage-'))
  writeFileSync(join(st.storageRoot, '.ovdata'), '')
  st.statusDir = mkdtempSync(join(tmpdir(), 'ov-sheets-e2e-status-'))
  writeFileSync(join(st.statusDir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
  st.srv = await bootServer({
    DATABASE_URL: st.db.url,
    STORAGE_ROOT: st.storageRoot,
    STATUS_DIR: st.statusDir,
    TRUST_PROXY: 'cloudflare',
    TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
    STORAGE_BACKUP_MIN_FREE_MB: '1',
    STORAGE_SCORESHEETS_MIN_FREE_MB: '1',
    ...(withRender
      ? {
          OV_RENDER_URL: `http://127.0.0.1:${renderPort}`,
          OV_RENDER_TOKEN: RENDER_TOKEN,
          OV_VECTOR_TEST_TIMES: JSON.stringify(vectorTimes || { quietMs: 300, recheckMs: 200, graceMs: 1200, retryMs: 200, maxTries: 2, maxWaitMs: 30000 })
        }
      : {})
  })
  const base = st.srv.base
  const nextIp = () => `${ipBase}.${ipSeq++}`

  st.account = async (name, roles) => {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const password = 'correct-horse-battery'
    const ip = nextIp()
    const up = await api(base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password, metadata: { first_name: name, last_name: 'Test' } } })
    assert.equal(up.status, 200, up.text)
    let inn
    for (let attempt = 0; attempt < 10; attempt++) {
      inn = await api(base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password } })
      if (!(inn.status === 503 && inn.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    assert.equal(inn.status, 200, inn.text)
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, email }
    if (roles) await grantRoles(st.sql, u.id, roles)
    st.users[name] = u
    return u
  }
  st.call = (user, method, path, body) => api(base, path, { method, token: user?.token, body, proto: method === 'GET' ? null : '2' })
  st.expectCode = (r, status, code) => {
    assert.equal(r.status, status, r.text)
    assert.equal(r.json?.error?.code, code, r.text)
  }

  /**
   * A match of `owner`; `sets`: [[home, away], ...] played and finished, each
   * with its last point at its score, and the result the match end writes
   * (set_results, final_score, winner), as the scorer app sends them.
   */
  st.newMatch = async (owner, { sport = 'indoor', sets = [], scheduledAt = '2026-11-20T14:00:00Z', result = true } = {}) => {
    const ext = `match_${Date.now()}_${randomBytes(3).toString('hex')}`
    const n = gameSeq++
    const won = { home: sets.filter(([h, a]) => h > a).length, away: sets.filter(([h, a]) => a > h).length }
    const end = sets.length && result
      ? { set_results: sets.map(([home, away], i) => ({ set: i + 1, home, away })), final_score: `${won.home}-${won.away}`, winner: won.home > won.away ? 'home' : 'away' }
      : {}
    const teams = sport === 'beach'
      ? { sport_type: 'beach', team1_data: { name: `Muster/Beispiel ${n}` }, team2_data: { name: `Sand/Strand ${n}` } }
      : { home_team: { name: `Home ${n}` }, away_team: { name: `Away ${n}` } }
    const data = { external_id: ext, game_n: n, status: 'live', scheduled_at: scheduledAt, ...teams, ...end }
    const r = await api(base, '/api/db', { token: owner.token, body: { table: 'matches', action: 'insert', params: { data, returning: 'id', single: true } } })
    assert.equal(r.status, 200, r.text)
    const id = r.json.data.id
    let seq = 0
    for (const [i, [home, away]] of sets.entries()) {
      const s = await api(base, '/api/db', { token: owner.token, body: { table: 'sets', action: 'insert', params: { data: { match_id: id, external_id: `${ext}:set:${i + 1}`, index: i + 1, home_points: home, away_points: away, finished: true } } } })
      assert.equal(s.status, 200, s.text)
      seq += home + away
      await st.sql.query("INSERT INTO public.events (external_id, match_id, set_index, type, payload, seq) VALUES ($1, $2, $3, 'point', $4::json, $5)",
        [`${ext}:e:${seq}`, id, i + 1, JSON.stringify({ team: home > away ? 'home' : 'away', score: { home, away } }), seq])
    }
    return { ext, n, id, day: scheduledAt.slice(0, 10) }
  }
  st.uploadPdf = (owner, path, label, ext = undefined) => api(base, '/api/storage/upload', {
    token: owner.token,
    body: { bucket: 'scoresheets', path, fileBase64: pdfBytes(label).toString('base64'), contentType: 'application/pdf', ...(ext ? { match_external_id: ext } : {}) }
  })
  st.close = async (user, id, status = 'final') => {
    const r = await api(base, '/api/db', { token: user.token, body: { table: 'matches', action: 'update', params: { data: { status }, filters: [{ type: 'eq', column: 'id', value: id }] } } })
    assert.equal(r.status, 200, r.text)
  }
  st.reopen = async (admin, id, reason = 'Wrong set start times') => {
    const r = await api(base, `/api/admin/matches/${id}/reopen`, { token: admin.token, body: { reason } })
    assert.equal(r.status, 200, r.text)
  }
  st.newestPdf = async (user, id) => {
    const r = await fetch(`${base}/api/scoresheets/${id}/pdf`, { headers: { Authorization: `Bearer ${user.token}` } })
    assert.equal(r.status, 200)
    return Buffer.from(await r.arrayBuffer())
  }
  st.records = async (id) => (await st.sql.query('SELECT path, sha256, stored_at FROM public.match_scoresheets WHERE match_id = $1 ORDER BY stored_at, path', [id])).rows
  st.stop = async () => {
    await st.sql?.end().catch(() => {})
    await st.srv?.stop()
    await st.db?.drop()
    await new Promise((r) => (renderServer ? renderServer.close(r) : r()))
    if (st.storageRoot) rmSync(st.storageRoot, { recursive: true, force: true })
    if (st.statusDir) rmSync(st.statusDir, { recursive: true, force: true })
  }
  return st
}
