/** lib/publicApi.js against a real schema: the SQL, test rows hidden, voided events skipped. */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { SKIP_PG, createTestDatabase } from './helpers/pgTestDb.js'
import { createPublicApi } from '../lib/publicApi.js'

describe('public API on Postgres', { skip: SKIP_PG }, () => {
  let tdb, pool, api, mid
  before(async () => {
    tdb = await createTestDatabase('publicapi')
    pool = new pg.Pool({ connectionString: await tdb.createAppRole() })
    api = createPublicApi({ pool })
    const admin = new pg.Client({ connectionString: tdb.url })
    await admin.connect()
    let gn = 0
    const ins = (ext, status, test = false) => admin.query(
      `INSERT INTO public.matches (external_id, status, test, game_n, scheduled_at, home_team, away_team, officials, players_home, final_score, winner)
       VALUES ($1,$2,$3,${++gn}, now(), '{"name":"VBC Home"}', '{"name":"VBC Away"}',
         '[{"role":"1st referee","firstName":"Anna","lastName":"Muster"}]', '[{"number":7,"first_name":"Anna","dob":"1990-01-01"}]', '3:0', 'home') RETURNING id`, [ext, status, test])
    mid = (await ins('pub_fin', 'finished')).rows[0].id
    await ins('pub_live', 'live')
    await ins('pub_test', 'live', true)
    const ev = (type, set, seq, payload, voided = false) => admin.query(
      `INSERT INTO public.events (match_id, type, set_index, seq, payload, voided_at) VALUES ($1,$2,$3,$4,$5, ${voided ? 'now()' : 'NULL'})`,
      [mid, type, set, seq, JSON.stringify(payload)])
    await ev('point', 1, 1, { team: 'home' })
    await ev('point', 1, 2, { team: 'away' }, true)
    await ev('point', 1, 3, { team: 'home' })
    await ev('set_end', 1, 4, { team: 'home' })
    await admin.query(`INSERT INTO public.match_live_state (match_id, current_set, points_a, points_b, sets_won_a, sets_won_b, team_a_name, team_b_name, match_status)
      SELECT id, 1, 12, 9, 0, 0, 'VBC Home', 'VBC Away', 'live' FROM public.matches WHERE external_id = 'pub_live'`)
    await admin.end()
  })
  after(async () => { await pool?.end(); await tdb?.drop() })

  it('lists public matches, never test rows', async () => {
    const r = await api.list({ from: new Date(Date.now() - 3600e3).toISOString() })
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.matches.map((m) => m.id).sort(), ['pub_fin', 'pub_live'])
    assert.deepEqual((await api.list({ status: 'live', from: new Date(Date.now() - 3600e3).toISOString() })).body.matches.map((m) => m.id), ['pub_live'])
  })
  it('info: roles only', async () => {
    const r = await api.info('pub_fin')
    assert.deepEqual(r.body.officials, [{ role: '1st referee' }])
    assert.deepEqual(r.body.home.players, [{ number: 7, captain: false, libero: false }])
    assert.ok(!JSON.stringify(r.body).includes('Anna'))
    assert.equal((await api.info('pub_test')).status, 404)
  })
  it('live: the score, and zeros for a match without a live row', async () => {
    assert.equal((await api.live('pub_live')).body.score.pointsA, 12)
    assert.equal((await api.live('pub_fin')).body.score.pointsA, 0)
    assert.equal((await api.live('pub_test')).status, 404)
  })
  it('stats: only finished, voided events left out', async () => {
    assert.equal((await api.stats('pub_live')).status, 409)
    const r = await api.stats('pub_fin')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.stats.sets[0].points, { home: 2, away: 0 })
    assert.equal(r.body.stats.sets[0].winner, 'home')
  })
})
