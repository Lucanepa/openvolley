/**
 * /tv/<game number> and the board's game mode (lib/publicApi.js gameLiveRow,
 * lib/globalLive.js gameSummary), audit round 3:
 *   LOG-22  a beach match with that number was taken (OpenBeach numbers its
 *           games per tournament, so another tournament's game 7 too), with
 *           best of 5 for a game not started; best of now comes from the match
 *           (match_info.best_of) when the live row has none;
 *   LOG-20  a best-of-3 decider (stored as set 5) is set 3.
 *
 *   cd escoresheet/backend && PG_TEST_URL=... node --test tests/publicApi.gameLive.pg.test.js
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { SKIP_PG, createTestDatabase } from './helpers/pgTestDb.js'
import { createPublicApi } from '../lib/publicApi.js'
import { gameSummary } from '../lib/globalLive.js'

describe('a game by its number on Postgres', { skip: SKIP_PG }, () => {
  let tdb, pool, api
  before(async () => {
    tdb = await createTestDatabase('live_public_game')
    pool = new pg.Pool({ connectionString: await tdb.createAppRole() })
    api = createPublicApi({ pool })
    const admin = new pg.Client({ connectionString: tdb.url })
    await admin.connect()
    // game 7: an indoor league game tomorrow, and two beach tournaments' game 7, one of them right now
    await admin.query(`INSERT INTO public.matches (external_id, status, sport_type, game_n, scheduled_at, home_team, away_team, match_info)
      VALUES ('idx_7', 'scheduled', 'indoor', 7, now() + interval '1 day', '{"name":"VBC Home"}', '{"name":"VBC Away"}', '{"best_of":3,"hall":"Saalsporthalle"}')`)
    await admin.query(`INSERT INTO public.matches (external_id, status, sport_type, game_n, scheduled_at, team1_data, team2_data)
      VALUES ('beach_a_7', 'live', 'beach', 7, now(), '{"name":"Muster/Beispiel"}', '{"name":"Test/Probe"}'),
             ('beach_b_7', 'live', 'beach', 7, now() + interval '2 hours', '{"name":"Andere/Paar"}', '{"name":"Noch/Eins"}')`)
    await admin.query(`INSERT INTO public.match_live_state (match_id, current_set, points_a, points_b, sets_won_a, sets_won_b, team_a_name, team_b_name, match_status, best_of)
      SELECT id, 1, 12, 9, 0, 0, 'Muster/Beispiel', 'Test/Probe', 'live', 3 FROM public.matches WHERE external_id = 'beach_a_7'`)
    // game 8: an indoor best-of-3 in its decider
    await admin.query(`INSERT INTO public.matches (external_id, status, sport_type, game_n, scheduled_at, home_team, away_team, match_info)
      VALUES ('idx_8', 'live', 'indoor', 8, now(), '{"name":"VBC Home"}', '{"name":"VBC Away"}', '{"best_of":3}')`)
    await admin.query(`INSERT INTO public.match_live_state (match_id, current_set, points_a, points_b, sets_won_a, sets_won_b, team_a_name, team_b_name, match_status, best_of)
      SELECT id, 5, 6, 4, 1, 1, 'VBC Home', 'VBC Away', 'live', 3 FROM public.matches WHERE external_id = 'idx_8'`)
    // game 9: beach only
    await admin.query(`INSERT INTO public.matches (external_id, status, sport_type, game_n, scheduled_at, team1_data, team2_data)
      VALUES ('beach_9', 'live', 'beach', 9, now(), '{"name":"A/B"}', '{"name":"C/D"}')`)
    await admin.end()
  })
  after(async () => { await pool?.end(); await tdb?.drop() })

  it('never a beach match: the indoor game of that number, even when a beach game 7 is closer in time', async () => {
    const row = await api.gameLiveRow(7)
    assert.equal(row.external_id, 'idx_7')
    assert.equal(await api.gameLiveRow(9), null)
  })

  it('best of from the match for a game not started yet', async () => {
    const s = gameSummary(await api.gameLiveRow(7), 'T')
    assert.equal(s.bestOf, 3)
    assert.equal(s.home.name, 'VBC Home')
    assert.equal(s.hall, 'Saalsporthalle')
  })

  it('a best-of-3 decider is set 3', async () => {
    const s = gameSummary(await api.gameLiveRow(8), 'T')
    assert.equal(s.currentSet, 3)
    assert.deepEqual(s.points, { home: 6, away: 4 })
  })
})
