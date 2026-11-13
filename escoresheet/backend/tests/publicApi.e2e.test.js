/** The public match API through server.js: CORS for any origin without credentials, JSON, SSE, widget. */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { SKIP, bootServer, provisionDatabase, sleep } from './helpers/e2eServer.js'

describe('public match API (server.js)', { skip: SKIP }, () => {
  let db, sql, srv, storageRoot, statusDir
  const get = (path, headers = {}) => fetch(srv.base + path, { headers: { Origin: 'https://club-site.example', ...headers } })

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-pub-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-pub-status-'))
    writeFileSync(join(statusDir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
    srv = await bootServer({ DATABASE_URL: db.url, STORAGE_ROOT: storageRoot, STATUS_DIR: statusDir, STORAGE_BACKUP_MIN_FREE_MB: '1', STORAGE_SCORESHEETS_MIN_FREE_MB: '1' })
    await sql.query(`INSERT INTO public.matches (external_id, status, game_n, scheduled_at, home_team, away_team, officials)
      VALUES ('pub_e2e','live',1, now(), '{"name":"VBC Home"}', '{"name":"VBC Away"}', '[{"role":"1st referee","firstName":"Anna","lastName":"Muster"}]')`)
    await sql.query(`INSERT INTO public.match_live_state (match_id, current_set, points_a, points_b, sets_won_a, sets_won_b, team_a_name, team_b_name, match_status)
      SELECT id, 1, 3, 2, 0, 0, 'VBC Home', 'VBC Away', 'live' FROM public.matches WHERE external_id = 'pub_e2e'`)
  })
  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
    for (const d of [storageRoot, statusDir]) if (d) rmSync(d, { recursive: true, force: true })
  })

  it('answers any origin with * and no credentials', async () => {
    const r = await get('/api/public/v1/matches/pub_e2e')
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('access-control-allow-origin'), '*')
    assert.equal(r.headers.get('access-control-allow-credentials'), null)
    const b = await r.json()
    assert.deepEqual(b.officials, [{ role: '1st referee' }])
    assert.ok(!JSON.stringify(b).includes('Anna'))
  })
  it('lists, serves live, 404s and 400s', async () => {
    assert.deepEqual((await (await get('/api/public/v1/matches')).json()).matches.map((m) => m.id), ['pub_e2e'])
    assert.equal((await (await get('/api/public/v1/matches/pub_e2e/live')).json()).score.pointsA, 3)
    assert.equal((await get('/api/public/v1/matches/nope')).status, 404)
    assert.equal((await get('/api/public/v1/matches/a%20b')).status, 400)
    assert.equal((await get('/api/public/v1/matches/pub_e2e/stats')).status, 409)
  })
  it('streams a change as Server-Sent Events', async () => {
    const ac = new AbortController()
    const r = await fetch(srv.base + '/api/public/v1/matches/pub_e2e/stream', { signal: ac.signal, headers: { Origin: 'https://club-site.example' } })
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type'), /text\/event-stream/)
    assert.equal(r.headers.get('access-control-allow-origin'), '*')
    const dec = new TextDecoder()
    let text = ''
    const reader = r.body.getReader()
    const read = async (until) => {
      const t0 = Date.now()
      while (!until(text) && Date.now() - t0 < 8000) {
        const { value, done } = await reader.read()
        if (done) break
        text += dec.decode(value)
      }
    }
    await read((t) => t.includes('"pointsA":3'))
    await sql.query(`UPDATE public.match_live_state SET points_a = 4 WHERE match_id = (SELECT id FROM public.matches WHERE external_id = 'pub_e2e')`)
    await read((t) => t.includes('"pointsA":4'))
    ac.abort()
    assert.ok(text.includes('"pointsA":3') && text.includes('"pointsA":4'), text)
    await sleep(50)
  })
  it('serves the widget script cross-origin', async () => {
    const r = await get('/embed/livescore.js')
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type'), /javascript/)
    assert.equal(r.headers.get('access-control-allow-origin'), '*')
    assert.match(await r.text(), /ov-livescore/)
  })
})
