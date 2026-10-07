/**
 * db/013_beach_official_index.sql and db/014_beach_tournaments.sql on a
 * database in the state before them (005 to 012, with an indoor and a beach
 * match holding game 1 of season 2026), the way they will meet production.
 * Both run twice. 013: indoor keeps one match per game and season, beach game
 * numbers restart with every tournament. 014: the tournament tables and their
 * CHECKs, one game number per tournament, one scored match per tournament
 * match (beach only), and the app role reaches the new tables.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { SKIP_PG, SCHEMA_SQL_005_ONLY, createTestDatabase } from './helpers/pgTestDb.js'

const here = dirname(fileURLToPath(import.meta.url))
const sqlOf = (f) => readFileSync(join(here, '..', 'db', f), 'utf8')
const M013 = sqlOf('013_beach_official_index.sql')
const M014 = sqlOf('014_beach_tournaments.sql')

describe('db/013 and db/014 (beach tournaments)', { skip: SKIP_PG }, () => {
  let tdb, raw, app
  const ids = {}

  const expectCode = async (client, sql, params, code) => {
    await assert.rejects(() => client.query(sql, params), (err) => {
      assert.equal(err.code, code, err.message)
      return true
    })
  }
  const match = async (ext, extra = {}) => {
    const row = { external_id: ext, status: 'live', ...extra }
    const cols = Object.keys(row)
    const { rows: [m] } = await raw.query(
      `INSERT INTO public.matches (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      cols.map((c) => row[c]))
    return m.id
  }

  before(async () => {
    tdb = await createTestDatabase('mig014', {
      schemaSql: [SCHEMA_SQL_005_ONLY, ...['006_matches_updated_at.sql', '007_scorer_accounts.sql', '008_live_state_tto.sql',
        '009_beach_saved_teams.sql', '010_auth_tokens.sql', '012_app_memberships.sql'].map(sqlOf)].join('\n')
    })
    raw = new pg.Client({ connectionString: tdb.url, options: '-c TimeZone=UTC' })
    await raw.connect()
    ids.user = randomUUID()
    await raw.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [ids.user, `m014-${ids.user}@example.ch`])
    ids.indoor1 = await match('m014_indoor_1', { game_n: 1, scheduled_at: '2026-10-10T16:00:00Z' })
    ids.beach1 = await match('m014_beach_1', { game_n: 1, sport_type: 'beach', scheduled_at: '2026-07-10T09:00:00Z' })
  })

  after(async () => {
    await app?.end().catch(() => {})
    await raw?.end()
    await tdb?.drop()
  })

  it('before 013: game 1 of a second beach tournament in the season is refused', async () => {
    await expectCode(raw, "INSERT INTO public.matches (external_id, game_n, sport_type, scheduled_at) VALUES ('m014_beach_pre', 1, 'beach', '2026-08-14T09:00:00Z')", [], '23505')
  })

  it('013 and 014 run twice', async () => {
    for (let i = 0; i < 2; i++) {
      await raw.query(M013)
      await raw.query(M014)
    }
    const { rows: [ix] } = await raw.query(
      `SELECT pg_get_expr(i.indpred, i.indrelid) AS pred FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = 'matches_official_game_uidx'`)
    assert.match(ix.pred, /beach/)
    const { rows } = await raw.query(`SELECT count(*)::int AS n FROM pg_class WHERE relname = 'matches_official_game_uidx'`)
    assert.equal(rows[0].n, 1)
  })

  it('013: indoor keeps one match per game and season; beach game numbers restart', async () => {
    await expectCode(raw, "INSERT INTO public.matches (external_id, game_n, scheduled_at) VALUES ('m014_indoor_dup', 1, '2027-02-01T16:00:00Z')", [], '23505')
    await match('m014_indoor_next', { game_n: 1, scheduled_at: '2027-08-01T16:00:00Z' })
    await match('m014_beach_2', { game_n: 1, sport_type: 'beach', scheduled_at: '2026-08-14T09:00:00Z' })
    await match('m014_beach_3', { game_n: 1, sport_type: 'beach', scheduled_at: '2026-08-14T10:00:00Z' })
  })

  it('014: tournaments, courts, draws, entries and their checks', async () => {
    const { rows: [t] } = await raw.query(
      `INSERT INTO public.beach_tournaments (slug, title, starts_on, ends_on, created_by)
       VALUES ('zuri-open-2026', 'Züri Open', '2026-07-11', '2026-07-12', $1) RETURNING id, status, public, source, day_start::text, day_end::text`, [ids.user])
    assert.deepEqual({ ...t, id: undefined }, { id: undefined, status: 'draft', public: false, source: 'manual', day_start: '09:00:00', day_end: '19:00:00' })
    ids.t = t.id
    await expectCode(raw, "INSERT INTO public.beach_tournaments (slug, title, starts_on, ends_on) VALUES ('Bad Slug', 'x', '2026-07-11', '2026-07-11')", [], '23514')
    await expectCode(raw, "INSERT INTO public.beach_tournaments (slug, title, starts_on, ends_on) VALUES ('back-in-time', 'x', '2026-07-11', '2026-07-10')", [], '23514')
    await expectCode(raw, "INSERT INTO public.beach_tournaments (slug, title, starts_on, ends_on) VALUES ('zuri-open-2026', 'x', '2026-07-11', '2026-07-11')", [], '23505')
    await raw.query('INSERT INTO public.beach_courts (tournament_id, number) VALUES ($1, 1), ($1, 2)', [ids.t])
    await expectCode(raw, 'INSERT INTO public.beach_courts (tournament_id, number) VALUES ($1, 1)', [ids.t], '23505')
    const { rows: [d] } = await raw.query(
      "INSERT INTO public.beach_draws (tournament_id, gender, category) VALUES ($1, 'women', 'A1') RETURNING id, format, status, slot_minutes, scoring", [ids.t])
    assert.equal(d.format, 'DE')
    assert.equal(d.status, 'entries')
    assert.equal(d.slot_minutes, 50)
    assert.deepEqual(d.scoring, { best_of: 3, points: [21, 21, 15] })
    ids.d = d.id
    await expectCode(raw, "INSERT INTO public.beach_draws (tournament_id, gender, category, board_size) VALUES ($1, 'men', 'A1', 12)", [ids.t], '23514')
    const e = []
    for (let i = 1; i <= 3; i++) {
      const { rows: [r] } = await raw.query('INSERT INTO public.beach_entries (draw_id, seed, name) VALUES ($1, $2, $3) RETURNING id', [ids.d, i, `Pair ${i}`])
      e.push(r.id)
    }
    ids.entries = e
    await expectCode(raw, "INSERT INTO public.beach_entries (draw_id, seed, name) VALUES ($1, 1, 'Dup')", [ids.d], '23505')
    // two seeds swap in one transaction (the unique key is deferred)
    await raw.query('BEGIN')
    await raw.query('UPDATE public.beach_entries SET seed = 2 WHERE id = $1', [e[0]])
    await raw.query('UPDATE public.beach_entries SET seed = 1 WHERE id = $1', [e[1]])
    await raw.query('COMMIT')
  })

  it('014: one game number per tournament, codes and sources are checked', async () => {
    const ins = (gameN, code, s1 = 'seed:1', s2 = 'seed:2') => raw.query(
      `INSERT INTO public.beach_tmatches (tournament_id, draw_id, game_n, code, phase, round, position, wave, source1, source2)
       VALUES ($1, $2, $3, $4, 'winners', 1, 1, 1, $5, $6) RETURNING id`, [ids.t, ids.d, gameN, code, s1, s2])
    const { rows: [m] } = await ins(1, 'W1')
    ids.tm1 = m.id
    await expectCode(raw, `INSERT INTO public.beach_tmatches (tournament_id, draw_id, game_n, code, phase, round, position, wave, source1, source2)
       VALUES ($1, $2, 1, 'W2', 'winners', 1, 2, 1, 'seed:3', 'seed:4')`, [ids.t, ids.d], '23505')
    await expectCode(raw, `INSERT INTO public.beach_tmatches (tournament_id, draw_id, game_n, code, phase, round, position, wave, source1, source2)
       VALUES ($1, $2, 2, 'W2', 'winners', 1, 2, 1, 'seed:3', 'whoever')`, [ids.t, ids.d], '23514')
    const { rows: [m2] } = await ins(2, 'L1', 'loser:W1', 'winner:W1')
    ids.tm2 = m2.id
  })

  it('014: matches.tournament_match_id is unique and beach only; a linked tournament match cannot be deleted', async () => {
    await raw.query('UPDATE public.matches SET tournament_match_id = $1 WHERE id = $2', [ids.tm1, ids.beach1])
    await expectCode(raw, 'UPDATE public.matches SET tournament_match_id = $1 WHERE external_id = $2', [ids.tm1, 'm014_beach_2'], '23505')
    await expectCode(raw, 'UPDATE public.matches SET tournament_match_id = $1 WHERE id = $2', [ids.tm2, ids.indoor1], '23514')
    await expectCode(raw, 'DELETE FROM public.beach_tmatches WHERE id = $1', [ids.tm1], '23503')
    // the tournament match points at its scored match; deleting that match unlinks it
    await raw.query('UPDATE public.matches SET tournament_match_id = NULL WHERE id = $1', [ids.beach1])
    await raw.query('UPDATE public.beach_tmatches SET match_id = $1 WHERE id = $2', [ids.beach1, ids.tm1])
    await raw.query('DELETE FROM public.matches WHERE id = $1', [ids.beach1])
    assert.equal((await raw.query('SELECT match_id FROM public.beach_tmatches WHERE id = $1', [ids.tm1])).rows[0].match_id, null)
  })

  it('014: updated_at follows updates; deleting a tournament removes its draws, entries and matches', async () => {
    const before = (await raw.query('SELECT updated_at FROM public.beach_draws WHERE id = $1', [ids.d])).rows[0].updated_at
    await raw.query("UPDATE public.beach_draws SET status = 'seeded' WHERE id = $1", [ids.d])
    const afterU = (await raw.query('SELECT updated_at FROM public.beach_draws WHERE id = $1', [ids.d])).rows[0].updated_at
    assert.ok(afterU >= before)
    await raw.query('DELETE FROM public.beach_tournaments WHERE id = $1', [ids.t])
    for (const t of ['beach_courts', 'beach_draws', 'beach_entries', 'beach_tmatches']) {
      assert.equal((await raw.query(`SELECT count(*)::int AS n FROM public.${t}`)).rows[0].n, 0, t)
    }
  })

  it('the app role reaches the new tables', async () => {
    app = new pg.Client({ connectionString: await tdb.createAppRole() })
    await app.connect()
    const { rows: [t] } = await app.query(
      "INSERT INTO public.beach_tournaments (slug, title, starts_on, ends_on) VALUES ('app-role-cup', 'Cup', '2026-08-01', '2026-08-01') RETURNING id")
    await app.query('INSERT INTO public.beach_courts (tournament_id, number) VALUES ($1, 1)', [t.id])
    await app.query('DELETE FROM public.beach_tournaments WHERE id = $1', [t.id])
  })
})
