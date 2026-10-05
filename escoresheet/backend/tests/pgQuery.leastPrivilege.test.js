// The other Postgres suites connect as a superuser. This one runs as a role
// with only DML grants (like the production `ov_app`), so it catches anything
// that silently depends on superuser rights: catalog visibility through
// information_schema, SET LOCAL in a transaction, identity sequences, the
// scope guard's read of matches, json_populate_recordset on the table type.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createPgQuery } from '../lib/pgQuery.js'
import { createMatchRestore } from '../lib/matchRestore.js'
import { SKIP_PG, createTestDatabase, quietLogger } from './helpers/pgTestDb.js'

describe('pgQuery as a least-privilege role', { skip: SKIP_PG }, () => {
  let tdb, db, restore
  const W = { proto: 2 }
  const ext = `LP${Date.now().toString(36)}`
  const q = (table, action, params = {}, opts = W) => db.runQuery({ table, action, params }, opts)

  before(async () => {
    tdb = await createTestDatabase('leastpriv')
    const url = await tdb.createAppRole()
    const logger = quietLogger()
    db = createPgQuery({ connectionString: url, logger })
    restore = createMatchRestore(db, { logger })
  })

  after(async () => {
    await db?.close()
    await tdb?.drop()
  })

  it('loads the catalog of the granted tables only', async () => {
    const cat = await db.ensureCatalog()
    assert.ok(cat.tables.has('matches'))
    assert.ok(cat.tables.get('matches').columns.has('connection_pins'))
    assert.deepEqual(cat.tables.get('events').pk, ['id'])
    assert.equal(cat.tables.has('internal_notes'), false)
    assert.equal(db.catalogStatus().tables, 9) // every allowlisted table of the synthetic schema (it has no `teams`)
  })

  it('runs every action, including the JSON merge and the scope guard', async () => {
    let r = await q('matches', 'insert', { data: { external_id: ext, game_pin: '1', connection_pins: { referee: '1' } }, returning: 'id', single: true })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const id = r.body.data.id
    r = await q('matches', 'update', { data: { connection_pins: { bench_a: '2' } }, filters: [{ type: 'eq', column: 'id', value: id }] })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    r = await q('events', 'upsert', { data: [{ external_id: `${ext}:e:1`, match_id: id, seq: 1 }], onConflict: 'external_id', returning: 'id' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(typeof r.body.data[0].id, 'number')
    r = await q('events', 'insert', { data: { external_id: 'x:e:1', match_id: id } })
    assert.equal(r.body.error.code, 'OV_UNSCOPED_EXTERNAL_ID')
    r = await q('match_live_state', 'select', { columns: '*, matches!match_live_state_match_id_fkey_cascade(set_results)' }, {})
    assert.equal(r.status, 200, JSON.stringify(r.body))
    r = await q('matches', 'select', { columns: 'connection_pins', filters: [{ type: 'eq', column: 'id', value: id }], single: true }, { internal: true })
    assert.deepEqual(r.body.data.connection_pins, { referee: '1', bench_a: '2' })
    r = await q('events', 'delete', { filters: [{ type: 'eq', column: 'match_id', value: id }], count: 'exact' })
    assert.equal(r.body.count, 1)
  })

  it('SET LOCAL statement_timeout works inside a transaction', async () => {
    const v = await db.withTransaction(async (c) => (await c.query('SHOW statement_timeout')).rows[0].statement_timeout, { statementTimeoutMs: 1234 })
    assert.equal(v, '1234ms')
  })

  it('restores a match and finds it by PIN', async () => {
    const e2 = `${ext}R`
    const r = await restore.restoreMatch({
      match: { external_id: e2, game_n: 4711, game_pin: '777777' },
      sets: [{ external_id: `${e2}:s:1`, index: 1 }],
      events: [{ external_id: `${e2}:e:1`, seq: 1 }],
      liveState: { points_a: 1, status: 'live' }
    }, W)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const p = await restore.restoreByPin({ gameN: 4711, pin: '777777' }, { limitKey: 'lp' })
    assert.equal(p.status, 200, JSON.stringify(p.body))
    assert.equal(p.body.data.liveState.match_status, 'live')
    assert.equal(p.body.data.events.length, 1)
  })

  it('cannot reach tables it has no grant on, even when allowlisted by mistake', async () => {
    const wide = createPgQuery({ connectionString: db.pool.options.connectionString, logger: quietLogger(), allowedTables: ['matches', 'internal_notes'] })
    try {
      const r = await wide.runQuery({ table: 'internal_notes', action: 'select', params: {} })
      assert.equal(r.status, 400)
      assert.equal(r.body.error.code, '42P01')
    } finally {
      await wide.close()
    }
  })
})
