/**
 * db/034_official_game_season.sql on a database in the state before it (005
 * to 033, with official matches already stored), the way it meets
 * production. It runs twice.
 *   - Season: every stored row keeps the key it had (no row refused or freed,
 *     nothing else of it touched); from now on the server sets the season
 *     (VolleyManager's kick-off, else its clock), also for the app role, which
 *     may call no function (roles.sql); lib/officialGame.js officialSeasonOf
 *     agrees with the trigger.
 *   - Club rule (db/018): on, unless an admin switched it off.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { SKIP_PG, SCHEMA_SQL_005_ONLY, createTestDatabase } from './helpers/pgTestDb.js'
import { officialSeasonOf, seasonOf, OFFICIAL_INDEX } from '../lib/officialGame.js'

const here = dirname(fileURLToPath(import.meta.url))
const dbDir = join(here, '..', 'db')
const sqlOf = (f) => readFileSync(join(dbDir, f), 'utf8')
const M034 = sqlOf('034_official_game_season.sql')
// 006 to 033 and the current definitions: the database before this file
const AT_033_SQL = [SCHEMA_SQL_005_ONLY,
  ...readdirSync(dbDir).filter((f) => /^\d{3}_/.test(f) && Number(f.slice(0, 3)) >= 6 && Number(f.slice(0, 3)) <= 33).sort().map(sqlOf),
  sqlOf('current_definitions.sql')].join('\n')

describe('db/034 (official-game season, club rule on)', { skip: SKIP_PG }, () => {
  let tdb, raw, app
  const ids = {}
  let before034

  const match = async (client, ext, extra = {}) => {
    const row = { external_id: ext, status: 'live', ...extra }
    const cols = Object.keys(row)
    const { rows: [m] } = await client.query(
      `INSERT INTO public.matches (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      cols.map((c) => row[c]))
    return m.id
  }
  const seasonOfRow = async (id) => (await raw.query('SELECT official_season FROM public.matches WHERE id = $1', [id])).rows[0].official_season
  const rule = async () => (await raw.query('SELECT enabled, changed_at FROM public.club_rule WHERE id')).rows[0]

  before(async () => {
    tdb = await createTestDatabase('mig034', { schemaSql: AT_033_SQL })
    raw = new pg.Client({ connectionString: tdb.url, options: '-c TimeZone=UTC' })
    await raw.connect()
    ids.user = randomUUID()
    await raw.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [ids.user, `m034-${ids.user}@example.ch`])
    // Game 1 in two seasons by their scheduled_at (allowed before), one exempt
    // duplicate, one closed match, one without any date (no key before)
    ids.g1a = await match(raw, 'm034_g1_2025', { game_n: 1, scheduled_at: '2025-10-10T16:00:00Z' })
    ids.g1b = await match(raw, 'm034_g1_2026', { game_n: 1, scheduled_at: '2026-10-10T16:00:00Z' })
    ids.g1dup = await match(raw, 'm034_g1_dup', { game_n: 1, scheduled_at: '2026-10-11T16:00:00Z', official_game_exempt: true })
    ids.closed = await match(raw, 'm034_closed', { game_n: 2, scheduled_at: '2026-05-10T16:00:00Z', status: 'final' })
    ids.undated = await match(raw, 'm034_undated', { game_n: 3, created_at: null })
    before034 = (await raw.query('SELECT id, updated_at, closed_at FROM public.matches ORDER BY id')).rows
  })

  after(async () => {
    await app?.end().catch(() => {})
    await raw?.end()
    await tdb?.drop()
  })

  it('before 034: the club rule is off, and a kick-off in another season files a second match of a game', async () => {
    assert.equal((await rule()).enabled, false)
    const second = await match(raw, 'm034_g2_2024', { game_n: 2, scheduled_at: '2025-05-10T16:00:00Z' })
    await raw.query('DELETE FROM public.matches WHERE id = $1', [second])
  })

  it('runs twice; every stored row keeps its key, and nothing else of it changes', async () => {
    await raw.query(M034)
    await raw.query(M034)
    assert.equal(await seasonOfRow(ids.g1a), 2025)
    assert.equal(await seasonOfRow(ids.g1b), 2026)
    assert.equal(await seasonOfRow(ids.g1dup), 2026)
    assert.equal(await seasonOfRow(ids.closed), 2025)
    assert.equal(await seasonOfRow(ids.undated), null, 'no date: no key, as before')
    assert.deepEqual((await raw.query('SELECT id, updated_at, closed_at FROM public.matches ORDER BY id')).rows, before034)
    const { rows: [idx] } = await raw.query("SELECT pg_get_indexdef(to_regclass('public.matches_official_game_uidx')) AS def")
    assert.match(idx.def, /official_season/)
    assert.match(idx.def, /UNIQUE/)
    const { rows: [trg] } = await raw.query(
      "SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'public.matches'::regclass AND tgname = 'matches_derive_official_season'")
    assert.equal(trg.tgenabled, 'O')
  })

  it('the server sets the season, also for the app role, which may call no function', async () => {
    const role = `${tdb.name}_app`.slice(0, 63)
    await raw.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'app'`)
    await raw.query(`GRANT USAGE ON SCHEMA public, auth TO "${role}"; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}";
      REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, "${role}";`)
    const u = new URL(tdb.url)
    u.username = role
    u.password = 'app'
    app = new pg.Client({ connectionString: u.toString(), options: '-c TimeZone=UTC' })
    await app.connect()
    try {
      await raw.query("INSERT INTO public.svrz_games (game_number, datetime) VALUES ('7', '2025-11-14T18:00:00'), ('8', '2026-06-30T23:30:00'), ('9', '2026-06-30T22:30:00Z')")
      const a = await match(app, 'm034_app_7', { game_n: 7, scheduled_at: '2026-11-14T17:00:00Z', official_season: 2030 })
      assert.equal(await seasonOfRow(a), 2025, 'VolleyManager\'s kick-off, not the scheduled_at or a client value')
      // the existing key of game 1 in 2026 (the clock's season here) holds
      if (seasonOf(new Date()) === 2026) {
        await assert.rejects(match(app, 'm034_app_1', { game_n: 1, scheduled_at: '2027-10-10T16:00:00Z' }), (err) => err.code === '23505' && err.constraint === OFFICIAL_INDEX)
      }
      // an update keeps the key; a new game number takes its own
      await app.query("UPDATE public.matches SET scheduled_at = '2020-01-01T00:00:00Z', official_season = 2001 WHERE id = $1", [a])
      assert.equal(await seasonOfRow(a), 2025)
      await app.query('UPDATE public.matches SET game_n = 8 WHERE id = $1', [a])
      assert.equal(await seasonOfRow(a), 2025, '23:30 on 30 June in Zurich')
      await app.query('UPDATE public.matches SET game_n = 9 WHERE id = $1', [a])
      assert.equal(await seasonOfRow(a), 2026, '00:30 on 1 July in Zurich')
    } finally {
      await app.end()
      app = null
      await raw.query(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`)
    }
  })

  it('officialSeasonOf agrees with the trigger', async () => {
    const cases = [['101', '2026-11-14T18:00:00'], ['102', '2026-07-01T00:30:00'], ['103', '2026-06-30T23:59:00'],
      ['104', '2026-06-30T22:30:00Z'], ['105', '2026-06-30T23:30:00+02:00'], ['106', '2026-02-30T18:00:00'], ['107', 'Saturday 18:00']]
    for (const [n, dt] of cases) await raw.query('INSERT INTO public.svrz_games (game_number, datetime) VALUES ($1, $2)', [n, dt])
    for (const [n] of [...cases, ['108', null]]) {
      const id = await match(raw, `m034_twin_${n}`, { game_n: Number(n), test: true })
      assert.equal(await officialSeasonOf(raw, { gameN: Number(n) }), await seasonOfRow(id), `game ${n}`)
    }
    // beach is not season-official: the clock
    const b = await match(raw, 'm034_beach', { game_n: 101, sport_type: 'beach' })
    assert.equal(await officialSeasonOf(raw, { gameN: 101, sportType: 'beach' }), await seasonOfRow(b))
  })

  it('the club rule is on unless an admin switched it off', async () => {
    assert.equal((await rule()).enabled, true, 'the row no admin changed is on')
    const { rows: [col] } = await raw.query(
      "SELECT column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'club_rule' AND column_name = 'enabled'")
    assert.equal(col.column_default, 'true')
    // an admin switches it off: a second run leaves it off
    await raw.query('UPDATE public.club_rule SET enabled = false, changed_at = now() WHERE id')
    await raw.query(M034)
    assert.equal((await rule()).enabled, false)
    // a missing row comes back on
    await raw.query('DELETE FROM public.club_rule')
    await raw.query(M034)
    assert.equal((await rule()).enabled, true)
  })
})
