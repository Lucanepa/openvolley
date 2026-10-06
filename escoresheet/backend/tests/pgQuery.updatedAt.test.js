// matches.updated_at / sets.updated_at follow every write (db/006_matches_updated_at.sql
// trigger + lib/pgQuery.js serverTimestamps), and a client-sent value never lands.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createPgQuery } from '../lib/pgQuery.js'
import { SKIP_PG, SCHEMA_SQL, createTestDatabase, quietLogger } from './helpers/pgTestDb.js'

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATION_006 = readFileSync(join(here, '..', 'db', '006_matches_updated_at.sql'), 'utf8')

const W = { proto: 2 }
const STALE = '2001-02-03T04:05:06.000Z'
const eq = (column, value) => ({ type: 'eq', column, value })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let seq = 0
const uniq = (p) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`

/** The pgQuery behaviour, run against a database with or without the 006 trigger. */
function pgQuerySuite (label, schemaSql) {
  describe(`pgQuery updated_at (${label})`, { skip: SKIP_PG }, () => {
    let tdb, db, raw
    const q = (table, action, params = {}, opts = W) => db.runQuery({ table, action, params }, opts)
    const stampOf = async (table, column, value) =>
      (await raw.query(`SELECT updated_at${table === 'matches' ? ', created_at' : ''} FROM public.${table} WHERE ${column} = $1`, [value])).rows[0]

    before(async () => {
      tdb = await createTestDatabase(`upd_${label}`, { schemaSql })
      // The production role: DML only, no function EXECUTE needed for the trigger
      const appUrl = await tdb.createAppRole()
      db = createPgQuery({ connectionString: appUrl, logger: quietLogger() })
      raw = new pg.Client({ connectionString: tdb.url })
      await raw.connect()
    })
    after(async () => {
      await raw?.end()
      await db?.close()
      await tdb?.drop()
    })

    it('an insert keeps the server default, not a client-sent updated_at', async () => {
      const ext = uniq('M')
      const r = await q('matches', 'insert', { data: { external_id: ext, game_n: 1, status: 'setup', updated_at: STALE } })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      const row = await stampOf('matches', 'external_id', ext)
      assert.notEqual(row.updated_at.toISOString(), STALE)
      assert.ok(Math.abs(row.updated_at - row.created_at) < 1000)
    })

    it('an update moves updated_at to now, whatever the client sent', async () => {
      const ext = uniq('M')
      await q('matches', 'insert', { data: { external_id: ext, game_n: 1, status: 'setup' } })
      const before0 = await stampOf('matches', 'external_id', ext)
      await sleep(20)
      const r = await q('matches', 'update', { data: { status: 'live', updated_at: STALE }, filters: [eq('external_id', ext)] })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      const after1 = await stampOf('matches', 'external_id', ext)
      assert.ok(after1.updated_at > before0.updated_at, `${after1.updated_at} > ${before0.updated_at}`)
      assert.equal(after1.created_at.getTime(), before0.created_at.getTime())
    })

    it('an upsert that hits an existing match moves updated_at too', async () => {
      const ext = uniq('M')
      await q('matches', 'upsert', { data: { external_id: ext, game_n: 1, status: 'setup' }, onConflict: 'external_id' })
      const first = await stampOf('matches', 'external_id', ext)
      await sleep(20)
      const r = await q('matches', 'upsert', { data: { external_id: ext, game_n: 1, status: 'ended', updated_at: STALE }, onConflict: 'external_id' })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      const second = await stampOf('matches', 'external_id', ext)
      assert.ok(second.updated_at > first.updated_at)
    })

    it('an update that only carries updated_at changes nothing', async () => {
      const ext = uniq('M')
      await q('matches', 'insert', { data: { external_id: ext, game_n: 1 } })
      const first = await stampOf('matches', 'external_id', ext)
      const r = await q('matches', 'update', { data: { updated_at: STALE }, filters: [eq('external_id', ext)] })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      const second = await stampOf('matches', 'external_id', ext)
      assert.equal(second.updated_at.getTime(), first.updated_at.getTime())
    })

    it('sets get the same treatment', async () => {
      const ext = uniq('M')
      const m = await q('matches', 'insert', { data: { external_id: ext, game_n: 1 }, returning: 'id', single: true })
      const setExt = `${ext}:s:1`
      await q('sets', 'insert', { data: { external_id: setExt, match_id: m.body.data.id, index: 1, updated_at: STALE } })
      const first = await stampOf('sets', 'external_id', setExt)
      assert.notEqual(first.updated_at.toISOString(), STALE)
      await sleep(20)
      const r = await q('sets', 'update', { data: { start_time: '2026-10-06T08:22:00Z' }, filters: [eq('match_id', m.body.data.id), eq('external_id', setExt)] })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      const second = await stampOf('sets', 'external_id', setExt)
      assert.ok(second.updated_at > first.updated_at)
    })

    it('leaves match_live_state.updated_at to the client (the realtime feed orders by it)', async () => {
      const ext = uniq('M')
      const m = await q('matches', 'insert', { data: { external_id: ext, game_n: 1 }, returning: 'id', single: true })
      const r = await q('match_live_state', 'upsert', { data: { match_id: m.body.data.id, points_a: 1, updated_at: STALE }, onConflict: 'match_id' })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      const row = (await raw.query('SELECT updated_at FROM public.match_live_state WHERE match_id = $1', [m.body.data.id])).rows[0]
      assert.equal(row.updated_at.toISOString(), STALE)
    })

    it('a trusted internal write may still set updated_at itself', async () => {
      const ext = uniq('M')
      await q('matches', 'insert', { data: { external_id: ext, game_n: 1, updated_at: STALE } }, { ...W, internal: true })
      const row = await stampOf('matches', 'external_id', ext)
      assert.equal(row.updated_at.toISOString(), STALE)
    })
  })
}

pgQuerySuite('no_trigger', SCHEMA_SQL)
pgQuerySuite('trigger', SCHEMA_SQL + '\n' + MIGRATION_006)

describe('db/006_matches_updated_at.sql', { skip: SKIP_PG }, () => {
  let tdb, raw
  before(async () => {
    tdb = await createTestDatabase('mig006', { schemaSql: SCHEMA_SQL })
    raw = new pg.Client({ connectionString: tdb.url })
    await raw.connect()
  })
  after(async () => {
    await raw?.end()
    await tdb?.drop()
  })

  it('is idempotent and bumps updated_at on any UPDATE of matches and sets (plain SQL)', async () => {
    await raw.query(MIGRATION_006)
    await raw.query(MIGRATION_006)
    const { rows: triggers } = await raw.query(`SELECT tgrelid::regclass::text AS tbl, tgname FROM pg_trigger
      WHERE NOT tgisinternal AND tgname LIKE '%touch_updated_at' ORDER BY 1`)
    assert.deepEqual(triggers.map((r) => r.tbl), ['matches', 'sets'])

    const { rows: [m] } = await raw.query(`INSERT INTO public.matches (external_id, updated_at) VALUES ('mig1', '${STALE}') RETURNING id, updated_at`)
    assert.equal(m.updated_at.toISOString(), STALE) // an INSERT keeps what it was given
    await raw.query("UPDATE public.matches SET status = 'ended' WHERE id = $1", [m.id])
    const { rows: [m2] } = await raw.query('SELECT updated_at FROM public.matches WHERE id = $1', [m.id])
    assert.ok(Date.now() - m2.updated_at.getTime() < 60000)

    // Even an UPDATE that tries to write an old value gets now()
    await raw.query(`UPDATE public.matches SET updated_at = '${STALE}' WHERE id = $1`, [m.id])
    const { rows: [m3] } = await raw.query('SELECT updated_at FROM public.matches WHERE id = $1', [m.id])
    assert.notEqual(m3.updated_at.toISOString(), STALE)

    const { rows: [s] } = await raw.query(`INSERT INTO public.sets (external_id, match_id, index, updated_at) VALUES ('mig1:s:1', $1, 1, '${STALE}') RETURNING id`, [m.id])
    await raw.query('UPDATE public.sets SET home_points = 3 WHERE id = $1', [s.id])
    const { rows: [s2] } = await raw.query('SELECT updated_at FROM public.sets WHERE id = $1', [s.id])
    assert.notEqual(s2.updated_at.toISOString(), STALE)
  })

  it('does not touch match_live_state', async () => {
    const { rows } = await raw.query(`SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = 'public.match_live_state'::regclass`)
    assert.equal(rows.length, 0)
  })
})
