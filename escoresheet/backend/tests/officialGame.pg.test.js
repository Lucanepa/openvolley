// lib/officialGame.js: the JS season agrees with the SQL season (db/007), and
// findClaim finds the match that holds an official game without leaking
// anything but the claimant's name and the match status.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { SEASON_SQL, seasonOf, officialRowsOf, findClaim, publicClaim, OFFICIAL_INDEX } from '../lib/officialGame.js'
import { SKIP_PG, createTestDatabase } from './helpers/pgTestDb.js'

describe('seasonOf / officialRowsOf (pure)', () => {
  it('turns on 1 July, Zurich time', () => {
    assert.equal(seasonOf('2026-06-30T21:59:59Z'), 2025) // 23:59:59 CEST on 30 June
    assert.equal(seasonOf('2026-06-30T22:00:00Z'), 2026) // 00:00 CEST on 1 July
    assert.equal(seasonOf('2026-07-01T12:00:00Z'), 2026)
    assert.equal(seasonOf('2027-01-15T18:00:00Z'), 2026)
    assert.equal(seasonOf('2026-12-31T23:30:00Z'), 2026) // already 2027 in Zurich, still season 2026
    assert.equal(seasonOf(new Date('2025-09-01T00:00:00Z')), 2025)
    assert.equal(seasonOf(null), null)
    assert.equal(seasonOf('not a date'), null)
  })
  it('officialRowsOf keeps non-test rows with a positive game number', () => {
    const rows = [
      { game_n: 12 }, { game_n: '13' }, { game_n: 14, test: true }, { game_n: 0 }, { game_n: null },
      { game_n: 'x' }, { game_n: 1.5 }, { game_n: 15, test: false }, null
    ]
    assert.deepEqual(officialRowsOf(rows).map((r) => r.game_n), [12, '13', 15])
    assert.deepEqual(officialRowsOf({ game_n: 7 }).length, 1)
  })
  it('the index name is the one 007 creates', () => {
    assert.equal(OFFICIAL_INDEX, 'matches_official_game_uidx')
  })
})

describe('officialGame on Postgres', { skip: SKIP_PG }, () => {
  let tdb, pool
  const users = {}
  let seq = 0
  const ext = () => `og_${Date.now().toString(36)}_${seq++}`

  async function user (name, first, last) {
    const { rows: [u] } = await pool.query("INSERT INTO auth.users (email) VALUES ($1) RETURNING id", [`${name}@example.ch`])
    await pool.query('INSERT INTO public.profiles (user_id, first_name, last_name, roles) VALUES ($1, $2, $3, $4)', [u.id, first, last, ['scorer']])
    users[name] = u.id
    return u.id
  }
  async function match (row) {
    const cols = Object.keys(row)
    const { rows: [m] } = await pool.query(
      `INSERT INTO public.matches (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      cols.map((c) => row[c]))
    return m.id
  }

  before(async () => {
    tdb = await createTestDatabase('officialgame')
    pool = new pg.Pool({ connectionString: tdb.url, options: '-c TimeZone=UTC' })
    await user('anna', 'Anna', 'Muster')
    await user('ben', 'Ben', 'Beispiel')
    await user('noname', null, null)
  })
  after(async () => {
    await pool?.end()
    await tdb?.drop()
  })

  it('SEASON_SQL agrees with seasonOf at the July and DST edges', async () => {
    const stamps = ['2026-06-30T21:59:59Z', '2026-06-30T22:00:00Z', '2026-07-01T00:00:00Z', '2027-01-15T18:00:00Z',
      '2026-03-29T00:59:59Z', '2026-03-29T01:00:00Z', '2026-10-25T00:59:59Z', '2026-10-25T01:00:00Z', '2026-12-31T23:30:00Z']
    for (const s of stamps) {
      const { rows: [r] } = await pool.query(`SELECT ${SEASON_SQL('$1::timestamptz')} AS season`, [s])
      assert.equal(r.season, seasonOf(s), s)
    }
    const { rows: [n] } = await pool.query(`SELECT ${SEASON_SQL('$1::timestamptz')} AS season`, [null])
    assert.equal(n.season, seasonOf(null))
  })

  it('finds the claim, with the claimant name and mine for the creator and editors only', async () => {
    const e = ext()
    const id = await match({ external_id: e, game_n: 51001, status: 'live', created_by: users.anna, scheduled_at: '2026-10-10T16:00:00Z', game_pin: '123456' })
    const q = { gameN: 51001, scheduledAt: '2026-11-01T18:00:00Z', sportType: 'indoor' }

    const forBen = await findClaim(pool, { ...q, callerId: users.ben })
    assert.deepEqual(forBen, {
      match_id: id, game_n: 51001, season: 2026, sport: 'indoor', status: 'live',
      scorer_name: 'Anna Muster', mine: false, scheduled_at: '2026-10-10T16:00:00.000Z'
    })
    assert.equal((await findClaim(pool, { ...q, callerId: users.anna })).mine, true)
    await pool.query("INSERT INTO public.match_editors (match_id, user_id, granted_via) VALUES ($1, $2, 'claim')", [id, users.ben])
    assert.equal((await findClaim(pool, { ...q, callerId: users.ben })).mine, true, 'editor')
    // The match itself (same external_id) is not a conflict with itself
    assert.equal(await findClaim(pool, { ...q, excludeExternalId: e }), null)
    // No PIN, email, user id or external_id anywhere in the output
    const text = JSON.stringify(forBen)
    for (const secret of ['123456', '@example.ch', users.anna, e]) assert.equal(text.includes(secret), false, secret)
    assert.deepEqual(Object.keys(publicClaim(forBen)).sort(), ['game_n', 'mine', 'scheduled_at', 'scorer_name', 'season', 'sport', 'status'])
  })

  it('ignores test and exempt matches, separates beach and seasons, null name without a profile name', async () => {
    await match({ external_id: ext(), game_n: 51002, status: 'live', test: true, scheduled_at: '2026-10-10T16:00:00Z' })
    assert.equal(await findClaim(pool, { gameN: 51002, scheduledAt: '2026-10-10T16:00:00Z' }), null, 'test')

    await match({ external_id: ext(), game_n: 51003, status: 'live', official_game_exempt: true, scheduled_at: '2026-10-10T16:00:00Z' })
    assert.equal(await findClaim(pool, { gameN: 51003, scheduledAt: '2026-10-10T16:00:00Z' }), null, 'exempt')

    await match({ external_id: ext(), game_n: 51004, status: 'setup', sport_type: 'beach', created_by: users.noname, scheduled_at: '2026-10-10T16:00:00Z' })
    assert.equal(await findClaim(pool, { gameN: 51004, scheduledAt: '2026-10-10T16:00:00Z', sportType: 'indoor' }), null, 'beach vs indoor')
    const beach = await findClaim(pool, { gameN: 51004, scheduledAt: '2026-10-10T16:00:00Z', sportType: 'beach' })
    assert.equal(beach.sport, 'beach')
    assert.equal(beach.scorer_name, null)

    await match({ external_id: ext(), game_n: 51005, status: 'live', scheduled_at: '2025-10-10T16:00:00Z' })
    assert.equal(await findClaim(pool, { gameN: 51005, scheduledAt: '2026-10-10T16:00:00Z' }), null, 'other season')
    assert.equal((await findClaim(pool, { gameN: 51005, scheduledAt: '2026-05-10T16:00:00Z' })).season, 2025, 'same season, before July')

    // Without scheduled_at: the season of now() on both sides
    await match({ external_id: ext(), game_n: 51006, status: 'live' })
    assert.ok(await findClaim(pool, { gameN: 51006, scheduledAt: null }))
    assert.equal(await findClaim(pool, { gameN: 0 }), null)
    assert.equal(await findClaim(pool, { gameN: 'x' }), null)
  })
})
