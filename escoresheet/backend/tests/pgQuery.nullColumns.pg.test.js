/**
 * lib/pgQuery.js cfg.nullColumns (server.js: publicColumns DOB_COLUMNS): the
 * date-of-birth columns read as NULL, named or with '*', and are never
 * written, filtered, ordered on or used as a conflict target, whether the
 * table still has them or not. So db/049 can drop them while installed apps
 * still select them, also while a running backend's catalog still lists
 * them (the deploy runs the migration before the backend switches).
 * Made-up people only.
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { createPgQuery } from '../lib/pgQuery.js'
import { DOB_COLUMNS } from '../lib/publicColumns.js'
import { SKIP_PG, createTestDatabase, quietLogger } from './helpers/pgTestDb.js'

describe('pgQuery nullColumns: the dates of birth read as NULL, before and after the columns go', { skip: SKIP_PG }, () => {
  let tdb, raw, db, logger
  const W = { proto: 2 }
  const q = (table, action, params = {}, opts = {}) => db.runQuery({ table, action, params }, opts)
  const eq = (column, value) => ({ type: 'eq', column, value })
  const refused = (r, code = 'OV_DOB_FILTER') => {
    assert.equal(r.status, 400, JSON.stringify(r.body))
    assert.equal(r.body.error.code, code)
  }
  let userId

  before(async () => {
    tdb = await createTestDatabase('null_columns')
    raw = new pg.Client({ connectionString: tdb.url })
    await raw.connect()
    logger = quietLogger()
    db = createPgQuery({ connectionString: tdb.url, logger, nullColumns: DOB_COLUMNS })
    // a value an older backend might have left: never read
    await raw.query(`INSERT INTO public.referee_database (first_name, last_name, country, dob, sport_type)
      VALUES ('Rita', 'Musterfrau', 'CHE', '1980-02-03', '["indoor"]')`)
    await raw.query(`INSERT INTO public.svrz_games (game_number, team_home, team_away, referee_1_first_name, referee_1_dob, referee_2_dob)
      VALUES ('991001', 'VBC Musterdorf H1', 'VBC Beispiel H2', 'Rita', '1980-02-03', '1981-04-05')`)
    const { rows: [u] } = await raw.query("INSERT INTO auth.users (email) VALUES ('null-columns@example.invalid') RETURNING id")
    userId = u.id
    await raw.query("INSERT INTO public.profiles (user_id, first_name, last_name, dob) VALUES ($1, 'Mia', 'Beispiel', '1990-06-07')", [userId])
  })

  after(async () => {
    await db?.close()
    await raw?.end()
    await tdb?.drop()
  })

  /** Everything an installed app does with the columns, on the database as it is now. */
  async function oldAppCalls ({ dropped }) {
    // the referee picker of apps before db/048: dob named in the select
    let r = await q('referee_database', 'select', { columns: 'id, first_name, last_name, country, dob, created_at', order: [{ column: 'last_name' }] })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.ok(r.body.data.length >= 1)
    for (const row of r.body.data) {
      assert.ok('dob' in row, 'the key is there')
      assert.equal(row.dob, null)
    }
    // '*': the key is there too, null
    r = await q('referee_database', 'select', { columns: '*' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.ok(r.body.data.every((row) => 'dob' in row && row.dob === null && row.last_name))
    // the official-match loader: '*' and the named columns
    r = await q('svrz_games', 'select', { columns: '*', filters: [eq('game_number', '991001')] })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual([r.body.data[0].referee_1_first_name, r.body.data[0].referee_1_dob, r.body.data[0].referee_2_dob], ['Rita', null, null])
    r = await q('svrz_games', 'select', { columns: 'game_number, referee_1_dob, referee_2_dob', filters: [eq('game_number', '991001')], single: true })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.data, { game_number: '991001', referee_1_dob: null, referee_2_dob: null })
    // the profile: '*' and dob, the owner's row (internal callers get NULL too)
    r = await q('profiles', 'select', { columns: 'first_name, dob', single: true }, { scope: { column: 'user_id', value: userId } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.data, { first_name: 'Mia', dob: null })
    r = await q('profiles', 'select', { columns: '*', single: true }, { internal: true, scope: { column: 'user_id', value: userId } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.data.dob, null)
    assert.equal(r.body.data.first_name, 'Mia')

    // no filter, no order on them
    refused(await q('referee_database', 'select', { columns: 'id', filters: [eq('dob', '1980-02-03')] }))
    refused(await q('referee_database', 'select', { columns: 'id', filters: [{ type: 'is', column: 'dob', value: null }] }))
    refused(await q('svrz_games', 'select', { columns: 'id', order: [{ column: 'referee_1_dob' }] }))
    refused(await q('profiles', 'select', { columns: 'id', filters: [eq('dob', '1990-06-07')] }, { internal: true }))

    // writes with a dob: written without it, answered as null
    const last = `Neu${dropped ? 'Nach' : 'Vor'}`
    r = await q('referee_database', 'insert', { data: { first_name: 'Ada', last_name: last, country: 'CHE', dob: '2001-01-01', sport_type: ['indoor'] }, returning: '*', single: true }, W)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.data.dob, null)
    assert.equal(r.body.data.last_name, last)
    const id = r.body.data.id
    r = await q('referee_database', 'update', { data: { country: 'ITA', dob: '2002-02-02' }, filters: [eq('id', id)], returning: 'id, country, dob' }, W)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.data, [{ id, country: 'ITA', dob: null }])
    // an update with nothing but a dob: nothing to write
    r = await q('referee_database', 'update', { data: { dob: '2003-03-03' }, filters: [eq('id', id)] }, W)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    r = await q('referee_database', 'upsert', { data: { id, first_name: 'Ada', last_name: last, dob: '2004-04-04' }, onConflict: 'id', returning: 'dob' }, W)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.data, [{ dob: null }])
    refused(await q('referee_database', 'upsert', { data: { first_name: 'Ada', last_name: last }, onConflict: 'first_name,last_name,dob' }, W))
    r = await q('profiles', 'update', { data: { first_name: 'Mia', dob: '1990-06-08' }, returning: 'first_name, dob' }, { ...W, scope: { column: 'user_id', value: userId } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.data, [{ first_name: 'Mia', dob: null }])
    // nothing was "dropped" as an unknown column (no migration is missing)
    assert.equal(Object.keys(db.droppedColumns().columns).filter((k) => /dob/.test(k)).length, 0)
    assert.ok(!logger.lines.some((l) => /unknown column/.test(l) && /dob/.test(l)), logger.lines.join('\n'))
    return id
  }

  it('while the tables have the columns: NULL (a stored value is never read), never written', async () => {
    const id = await oldAppCalls({ dropped: false })
    const { rows: [r] } = await raw.query('SELECT dob FROM public.referee_database WHERE id = $1', [id])
    assert.equal(r.dob, null, 'not written')
    const { rows: [p] } = await raw.query('SELECT dob FROM public.profiles WHERE user_id = $1', [userId])
    assert.equal(p.dob.getUTCFullYear(), 1990, 'the stored value stays as it was (db/048 cleared them in production)')
  })

  it('the columns dropped (db/049) under a backend whose catalog still lists them: the same answers', async () => {
    await raw.query(`ALTER TABLE public.referee_database DROP COLUMN dob;
      ALTER TABLE public.profiles DROP COLUMN dob;
      ALTER TABLE public.svrz_games DROP COLUMN referee_1_dob, DROP COLUMN referee_2_dob`)
    // the catalog loaded before: no SQL names the dropped columns
    await oldAppCalls({ dropped: true })
    // and a catalog read afresh
    db.invalidateCatalog()
    await oldAppCalls({ dropped: true })
  })

  it('a column that is not a null column still has to exist', async () => {
    const r = await q('referee_database', 'select', { columns: 'id, birthday' })
    assert.equal(r.body.error.code, 'PGRST204')
  })

  it('a nullColumns entry that is no identifier is refused at creation', () => {
    assert.throws(() => createPgQuery({ connectionString: tdb.url, logger, nullColumns: { profiles: ['dob; drop'] } }), /invalid column name/)
  })
})
