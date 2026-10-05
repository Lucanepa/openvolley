import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { createPgQuery, parseColumnRef, parseColumnList, mentionsSecret, quoteIdent, sqlstateStatus } from '../lib/pgQuery.js'
import { SKIP_PG, createTestDatabase, quietLogger } from './helpers/pgTestDb.js'

// ---------------------------------------------------------------------------
// Pure helpers (no database needed)
// ---------------------------------------------------------------------------

describe('pgQuery helpers', () => {
  it('parseColumnRef accepts plain columns and one ->> key only', () => {
    assert.deepEqual(parseColumnRef('external_id'), { column: 'external_id', jsonKey: null })
    assert.deepEqual(parseColumnRef('match_info->>competition_name'), { column: 'match_info', jsonKey: 'competition_name' })
    for (const bad of ['id::text', 'a:id', '"id"', 'id desc', 'match_info->competition_name', 'match_info->>x->>y',
      "match_info->>'x'", 'id;drop table x', '', ' ', 'match_info->>X', 'id)', 'lower(id)', 1, null]) {
      assert.equal(parseColumnRef(bad), null, `should reject ${String(bad)}`)
    }
  })

  it('parseColumnList allows identifiers and * only', () => {
    assert.deepEqual(parseColumnList('*'), ['*'])
    assert.deepEqual(parseColumnList(undefined), ['*'])
    assert.deepEqual(parseColumnList('id, external_id'), ['id', 'external_id'])
    for (const bad of ['id,(select 1)', 'a:id', 'id::text', '*,matches(*)', 'count()', 'id as x', '"id"', 'id,']) {
      assert.throws(() => parseColumnList(bad), (e) => e.code === 'OV_INVALID_SELECT', bad)
    }
  })

  it('mentionsSecret sees through aliases, casts, quoting and JSON paths', () => {
    const s = new Set(['game_pin', 'connection_pins'])
    for (const raw of ['game_pin', 'GAME_PIN', '"game_pin"', 'game_pin::text', 'x:game_pin', 'connection_pins->>referee', 'connection_pins->referee', 'a,game_pin']) {
      assert.equal(mentionsSecret(raw, s), true, raw)
    }
    assert.equal(mentionsSecret('game_n', s), false)
    assert.equal(mentionsSecret('match_info->>competition_name', s), false)
  })

  it('quoteIdent doubles embedded quotes', () => {
    assert.equal(quoteIdent('a"b'), '"a""b"')
  })
})

// ---------------------------------------------------------------------------
// Against a real Postgres with the synthetic schema
// ---------------------------------------------------------------------------

describe('pgQuery on Postgres', { skip: SKIP_PG }, () => {
  let tdb, db, logger, raw
  const W = { proto: 2 }
  let seq = 0
  const uniq = (p = 'm') => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`
  const q = (table, action, params = {}, opts = {}) => db.runQuery({ table, action, params }, opts)
  const eq = (column, value) => ({ type: 'eq', column, value })

  async function newMatch (extra = {}) {
    const external_id = extra.external_id || uniq('M')
    const r = await q('matches', 'insert', { data: { external_id, game_n: 1, status: 'live', ...extra }, returning: 'id', single: true }, W)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    return { id: r.body.data.id, external_id }
  }

  before(async () => {
    tdb = await createTestDatabase('pgquery')
    logger = quietLogger()
    db = createPgQuery({ connectionString: tdb.url, logger })
    raw = new pg.Client({ connectionString: tdb.url })
    await raw.connect()
  })

  after(async () => {
    await raw?.end()
    await db?.close()
    await tdb?.drop()
  })

  describe('catalog', () => {
    it('is not loaded until first use, then lists allowlisted tables', async () => {
      const fresh = createPgQuery({ connectionString: tdb.url, logger })
      assert.equal(fresh.pool.totalCount, 0)
      assert.equal(fresh.catalogStatus().ok, false)
      const r = await fresh.runQuery({ table: 'matches', action: 'select', params: { limit: 0 } })
      assert.equal(r.status, 200)
      const st = fresh.catalogStatus()
      assert.equal(st.ok, true)
      assert.equal(st.tables, 9) // allowlist has 10 entries; `teams` does not exist
      await fresh.close()
    })

    it('answers 503 while the database is down and retries with backoff', async () => {
      const down = createPgQuery({ connectionString: 'postgres://nobody:x@127.0.0.1:1/none', logger, catalogRetryInitialMs: 60000 })
      const r1 = await down.runQuery({ table: 'matches', action: 'select' })
      assert.equal(r1.status, 503)
      assert.equal(r1.body.error.code, 'OV_DB_UNAVAILABLE')
      assert.equal(down.catalogStatus().ok, false)
      assert.ok(down.catalogStatus().error)
      // Inside the backoff window no new connection attempt is made.
      const r2 = await down.runQuery({ table: 'matches', action: 'select' })
      assert.equal(r2.status, 503)
      await down.close()
    })

    it('recovers once tables appear (empty database first)', async () => {
      const empty = await createTestDatabase('pgquery_empty', { schemaSql: '' })
      const lazy = createPgQuery({ connectionString: empty.url, logger, catalogRetryInitialMs: 20 })
      try {
        const r1 = await lazy.runQuery({ table: 'matches', action: 'select' })
        assert.equal(r1.status, 503)
        const c = new pg.Client({ connectionString: empty.url })
        await c.connect()
        await c.query('CREATE TABLE matches (id serial PRIMARY KEY, external_id text)')
        await c.end()
        await new Promise(resolve => setTimeout(resolve, 60))
        const r2 = await lazy.runQuery({ table: 'matches', action: 'select' })
        assert.equal(r2.status, 200)
        assert.deepEqual(r2.body.data, [])
      } finally {
        await lazy.close()
        await empty.drop()
      }
    })

    it('a database without any allowlisted table is not a usable catalog', async () => {
      const other = await createTestDatabase('pgquery_other', { schemaSql: 'CREATE TABLE unrelated (id int)' })
      const wrong = createPgQuery({ connectionString: other.url, logger, catalogRetryInitialMs: 60000 })
      try {
        const r = await wrong.runQuery({ table: 'matches', action: 'select' })
        assert.equal(r.status, 503)
        assert.match(wrong.catalogStatus().error, /no allowlisted tables/)
      } finally {
        await wrong.close()
        await other.drop()
      }
    })

    it('refreshes in the background when a column appears after startup', async () => {
      const fresh = createPgQuery({ connectionString: tdb.url, logger, catalogRefreshMinMs: 0 })
      try {
        assert.equal((await fresh.runQuery({ table: 'beach_competition_matches', action: 'select', params: { limit: 0 } })).status, 200)
        await raw.query('ALTER TABLE beach_competition_matches ADD COLUMN court text')
        const r1 = await fresh.runQuery({ table: 'beach_competition_matches', action: 'select', params: { columns: 'court', limit: 0 } })
        assert.equal(r1.body.error.code, 'PGRST204')
        await new Promise(resolve => setTimeout(resolve, 100))
        const r2 = await fresh.runQuery({ table: 'beach_competition_matches', action: 'select', params: { columns: 'court', limit: 0 } })
        assert.equal(r2.status, 200, JSON.stringify(r2.body))
      } finally {
        await raw.query('ALTER TABLE beach_competition_matches DROP COLUMN IF EXISTS court')
        await fresh.close()
      }
    })

    it('allowlisted table missing from the database gives 42P01', async () => {
      const r = await q('teams', 'select')
      assert.equal(r.status, 400)
      assert.equal(r.body.error.code, '42P01')
    })

    it('tables outside the allowlist are refused, existing or not', async () => {
      for (const table of ['internal_notes', 'users', 'auth.users', 'public.matches', '"matches"', 'matches;', 'pg_user', 'MATCHES', '', null, 42]) {
        const r = await q(table, 'select')
        assert.equal(r.status, 400, String(table))
        assert.equal(r.body.error.code, 'OV_TABLE_NOT_ALLOWED', String(table))
      }
    })

    it('unknown actions are refused', async () => {
      for (const action of ['rpc', 'truncate', 'SELECT', undefined]) {
        const r = await q('matches', action)
        assert.equal(r.body.error.code, 'OV_INVALID_ACTION')
      }
    })
  })

  describe('select', () => {
    let m
    before(async () => {
      m = await newMatch({
        game_n: 41,
        game_pin: '123456',
        connection_pins: { referee: '111111' },
        scheduled_at: '2026-10-05T10:00:00Z',
        match_info: { competition_name: 'NLA Men' },
        home_team: { name: 'Home' }
      })
    })

    it('select * leaves secret columns out and serialises like PostgREST', async () => {
      const r = await q('matches', 'select', { columns: '*', filters: [eq('id', m.id)] })
      assert.equal(r.status, 200)
      assert.equal(r.body.error, null)
      const row = r.body.data[0]
      assert.ok(!('game_pin' in row))
      assert.ok(!('connection_pins' in row))
      assert.equal(row.external_id, m.external_id)
      assert.equal(row.scheduled_at, '2026-10-05T10:00:00+00:00')
      assert.deepEqual(row.match_info, { competition_name: 'NLA Men' })
      assert.equal(row.sport_type, 'indoor')
      assert.equal(row.test, false)
      assert.equal(r.body.count, undefined)
    })

    it('naming a secret column omits it (MatchSetup still gets a row)', async () => {
      const r = await q('matches', 'select', { columns: 'connection_pins', filters: [eq('external_id', m.external_id)], maybeSingle: true })
      assert.equal(r.status, 200)
      assert.deepEqual(r.body.data, {})
      const r2 = await q('matches', 'select', { columns: 'id, game_pin, status', filters: [eq('id', m.id)] })
      assert.deepEqual(Object.keys(r2.body.data[0]), ['id', 'status'])
    })

    it('internal mode returns the secret columns', async () => {
      const r = await q('matches', 'select', { columns: 'id, game_pin, connection_pins', filters: [eq('id', m.id)], single: true }, { internal: true })
      assert.equal(r.body.data.game_pin, '123456')
      assert.deepEqual(r.body.data.connection_pins, { referee: '111111' })
    })

    it('unknown select column is an error', async () => {
      const r = await q('matches', 'select', { columns: 'id, team_a' })
      assert.equal(r.status, 400)
      assert.equal(r.body.error.code, 'PGRST204')
      assert.ok(logger.lines.some(l => l.includes('team_a')))
    })

    it('filters: eq neq gt gte lt lte', async () => {
      const ext = uniq('F')
      for (const n of [1, 2, 3]) await newMatch({ external_id: `${ext}-${n}`, game_n: 900 + n, status: n === 2 ? 'setup' : 'live' })
      const ids = async (...filters) => {
        const r = await q('matches', 'select', { columns: 'game_n', filters: [{ type: 'like', column: 'external_id', value: `${ext}-*` }, ...filters], order: [{ column: 'game_n' }] })
        assert.equal(r.status, 200, JSON.stringify(r.body))
        return r.body.data.map(x => x.game_n)
      }
      assert.deepEqual(await ids(eq('game_n', 902)), [902])
      assert.deepEqual(await ids({ type: 'neq', column: 'status', value: 'setup' }), [901, 903])
      assert.deepEqual(await ids({ type: 'gt', column: 'game_n', value: 901 }), [902, 903])
      assert.deepEqual(await ids({ type: 'gte', column: 'game_n', value: 902 }), [902, 903])
      assert.deepEqual(await ids({ type: 'lt', column: 'game_n', value: 902 }), [901])
      assert.deepEqual(await ids({ type: 'lte', column: 'game_n', value: '902' }), [901, 902])
    })

    it('filters: like/ilike map * to %, in, is', async () => {
      const ext = uniq('L')
      await newMatch({ external_id: `${ext}-a`, winner: 'Home', final_score: null })
      await newMatch({ external_id: `${ext}-b`, winner: 'away', final_score: '3:1', test: true })
      const names = async (...filters) => {
        const r = await q('matches', 'select', { columns: 'external_id', filters, order: [{ column: 'external_id' }] })
        assert.equal(r.status, 200, JSON.stringify(r.body))
        return r.body.data.map(x => x.external_id)
      }
      assert.deepEqual(await names({ type: 'like', column: 'external_id', value: `${ext}*` }), [`${ext}-a`, `${ext}-b`])
      assert.deepEqual(await names({ type: 'like', column: 'external_id', value: `${ext}*` }, { type: 'like', column: 'winner', value: 'h*' }), [])
      assert.deepEqual(await names({ type: 'like', column: 'external_id', value: `${ext}*` }, { type: 'ilike', column: 'winner', value: 'h*' }), [`${ext}-a`])
      assert.deepEqual(await names({ type: 'in', column: 'external_id', value: [`${ext}-b`, 'nope'] }), [`${ext}-b`])
      assert.deepEqual(await names({ type: 'in', column: 'external_id', value: [] }), [])
      assert.deepEqual(await names({ type: 'like', column: 'external_id', value: `${ext}*` }, { type: 'is', column: 'final_score', value: null }), [`${ext}-a`])
      assert.deepEqual(await names({ type: 'like', column: 'external_id', value: `${ext}*` }, { type: 'is', column: 'test', value: true }), [`${ext}-b`])
      assert.deepEqual(await names({ type: 'like', column: 'external_id', value: `${ext}*` }, { type: 'is', column: 'test', value: 'false' }), [`${ext}-a`])
    })

    it('filters: contains on a JSON array (string value, as useOfficialHistory sends) and on text[]', async () => {
      const last = uniq('Ref')
      await q('referee_database', 'insert', { data: [
        { first_name: 'A', last_name: last, sport_type: ['indoor'] },
        { first_name: 'B', last_name: last, sport_type: ['beach', 'indoor'] },
        { first_name: 'C', last_name: last, sport_type: ['beach'] }
      ] }, W)
      const r = await q('referee_database', 'select', {
        columns: 'first_name, sport_type',
        filters: [eq('last_name', last), { type: 'contains', column: 'sport_type', value: JSON.stringify(['indoor']) }],
        order: [{ column: 'first_name', ascending: true }]
      })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.deepEqual(r.body.data, [{ first_name: 'A', sport_type: ['indoor'] }, { first_name: 'B', sport_type: ['beach', 'indoor'] }])
      const r2 = await q('referee_database', 'select', { columns: 'first_name', filters: [eq('last_name', last), { type: 'contains', column: 'sport_type', value: ['beach'] }] })
      assert.equal(r2.body.data.length, 2)
      const bad = await q('referee_database', 'select', { filters: [{ type: 'contains', column: 'sport_type', value: '[not json' }] })
      assert.equal(bad.body.error.code, 'OV_INVALID_FILTER')

      const uid = (await raw.query("INSERT INTO auth.users (email) VALUES ($1) RETURNING id", [`${uniq('u')}@x.invalid`])).rows[0].id
      const ins = await q('profiles', 'insert', { data: { user_id: uid, roles: ['scorer', 'referee'], dob: '1990-02-03' }, returning: 'roles, dob', single: true }, W)
      assert.deepEqual(ins.body.data, { roles: ['scorer', 'referee'], dob: '1990-02-03' })
      const r3 = await q('profiles', 'select', { columns: 'user_id', filters: [{ type: 'contains', column: 'roles', value: ['referee'] }, eq('user_id', uid)] })
      assert.equal(r3.body.data.length, 1)
    })

    it('match_info->>competition_name works in filters and order', async () => {
      const r = await q('matches', 'select', {
        columns: 'id',
        filters: [{ type: 'eq', column: 'match_info->>competition_name', value: 'NLA Men' }, eq('id', m.id)],
        order: [{ column: 'match_info->>competition_name', ascending: false }]
      })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.deepEqual(r.body.data, [{ id: m.id }])
      const notJson = await q('matches', 'select', { filters: [{ type: 'eq', column: 'status->>x', value: 'a' }] })
      assert.equal(notJson.body.error.code, 'OV_INVALID_FILTER')
    })

    it('single and maybeSingle with 0, 1 and 2 rows', async () => {
      const ext = uniq('S')
      await newMatch({ external_id: `${ext}-1`, game_n: 5 })
      await newMatch({ external_id: `${ext}-2`, game_n: 5 })
      const like = { type: 'like', column: 'external_id', value: `${ext}-*` }
      const one = [like, eq('external_id', `${ext}-1`)]
      const none = [like, eq('external_id', 'none')]

      let r = await q('matches', 'select', { columns: 'external_id', filters: one, single: true })
      assert.deepEqual(r.body.data, { external_id: `${ext}-1` })
      r = await q('matches', 'select', { filters: none, single: true })
      assert.equal(r.status, 406); assert.equal(r.body.error.code, 'PGRST116'); assert.equal(r.body.data, null)
      r = await q('matches', 'select', { filters: [like], single: true })
      assert.equal(r.body.error.code, 'PGRST116')

      r = await q('matches', 'select', { columns: 'external_id', filters: one, maybeSingle: true })
      assert.deepEqual(r.body.data, { external_id: `${ext}-1` })
      r = await q('matches', 'select', { filters: none, maybeSingle: true })
      assert.equal(r.status, 200); assert.equal(r.body.data, null); assert.equal(r.body.error, null)
      r = await q('matches', 'select', { filters: [like], maybeSingle: true })
      assert.equal(r.body.error.code, 'PGRST116')
    })

    it('count exact, with and without head; count ignores limit', async () => {
      const ext = uniq('C')
      for (let i = 0; i < 3; i++) await newMatch({ external_id: `${ext}-${i}` })
      const filters = [{ type: 'like', column: 'external_id', value: `${ext}-*` }]
      let r = await q('matches', 'select', { columns: '*', count: 'exact', head: true, filters })
      assert.equal(r.body.data, null); assert.equal(r.body.count, 3)
      r = await q('matches', 'select', { columns: 'id', count: 'exact', filters, limit: 2 })
      assert.equal(r.body.data.length, 2); assert.equal(r.body.count, 3)
    })

    it('order and limit, with a row cap', async () => {
      const ext = uniq('O')
      for (const n of [3, 1, 2]) await newMatch({ external_id: `${ext}-${n}`, game_n: n })
      const filters = [{ type: 'like', column: 'external_id', value: `${ext}-*` }]
      let r = await q('matches', 'select', { columns: 'game_n', filters, order: [{ column: 'game_n', ascending: false }], limit: 2 })
      assert.deepEqual(r.body.data, [{ game_n: 3 }, { game_n: 2 }])
      r = await q('matches', 'select', { columns: 'game_n', filters, order: { column: 'game_n' } })
      assert.deepEqual(r.body.data.map(x => x.game_n), [1, 2, 3])
      const capped = createPgQuery({ pool: db.pool, logger, maxRows: 2 })
      r = await capped.runQuery({ table: 'matches', action: 'select', params: { filters, limit: 50 } })
      assert.equal(r.body.data.length, 2)
      for (const limit of [-1, 1.5, 'x', '1;drop']) {
        r = await q('matches', 'select', { limit })
        assert.equal(r.body.error.code, 'OV_INVALID_LIMIT', String(limit))
      }
    })

    it('livescore embed runs as a LEFT JOIN and keeps the PostgREST shape', async () => {
      const lm = await newMatch({ set_results: [{ set: 1, home: 25, away: 20 }] })
      const ins = await q('match_live_state', 'upsert', { data: { match_id: lm.id, points_a: 3, sport_type: 'indoor' }, onConflict: 'match_id' }, W)
      assert.equal(ins.status, 200, JSON.stringify(ins.body))
      await raw.query("INSERT INTO match_live_state (match_id, points_a, sport_type) VALUES (NULL, 9, 'indoor')")
      const r = await q('match_live_state', 'select', {
        columns: '*, matches!match_live_state_match_id_fkey_cascade(set_results)',
        filters: [eq('sport_type', 'indoor')],
        order: [{ column: 'updated_at', ascending: false }]
      })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      const mine = r.body.data.find(x => x.match_id === lm.id)
      assert.deepEqual(mine.matches, { set_results: [{ set: 1, home: 25, away: 20 }] })
      assert.equal(mine.points_a, 3)
      const orphan = r.body.data.find(x => x.match_id === null)
      assert.equal(orphan.matches, null)
      // Whitespace variations of the same string are fine; anything else is not.
      const r2 = await q('match_live_state', 'select', { columns: '*,matches!match_live_state_match_id_fkey_cascade( set_results )', filters: [eq('match_id', lm.id)] })
      assert.equal(r2.status, 200)
      for (const columns of ['*, matches(*)', '*, matches!match_live_state_match_id_fkey_cascade(game_pin)', '*, matches!match_live_state_match_id_fkey_cascade(*)', 'id, users!inner(email)']) {
        const bad = await q('match_live_state', 'select', { columns })
        assert.equal(bad.status, 400, columns)
        assert.equal(bad.body.error.code, 'OV_INVALID_SELECT', columns)
      }
      const other = await q('matches', 'select', { columns: '*, matches!match_live_state_match_id_fkey_cascade(set_results)' })
      assert.equal(other.body.error.code, 'OV_INVALID_SELECT')
    })

    it('Postgres errors come back as SQLSTATE with a generic message', async () => {
      const r = await q('matches', 'select', { filters: [eq('id', 'not-a-uuid')] })
      assert.equal(r.status, 400)
      assert.deepEqual(r.body.error, { message: 'Database operation failed', code: '22P02' })
    })
  })

  describe('secret columns', () => {
    it('cannot be filtered or ordered on, in any spelling', async () => {
      const filterCols = ['game_pin', 'GAME_PIN', 'Game_Pin', '"game_pin"', 'game_pin::text', 'x:game_pin', 'connection_pins',
        'connection_pins->>referee', 'connection_pins->referee', 'connection_pins->>bench_home', ' game_pin ']
      for (const column of filterCols) {
        for (const type of ['eq', 'like', 'ilike', 'in', 'is', 'gt', 'contains']) {
          const value = type === 'in' ? ['1'] : type === 'is' ? null : '1*'
          const r = await q('matches', 'select', { filters: [{ type, column, value }] })
          assert.equal(r.status, 400, `${type} ${column}`)
          assert.equal(r.body.error.code, 'OV_SECRET_FILTER', `${type} ${column}`)
        }
        const o = await q('matches', 'select', { order: [{ column }] })
        assert.equal(o.body.error.code, 'OV_SECRET_FILTER', `order ${column}`)
      }
      // Same rule on update/delete filters, and as an upsert target.
      let r = await q('matches', 'update', { data: { status: 'x' }, filters: [{ type: 'like', column: 'game_pin', value: '1*' }] }, W)
      assert.equal(r.body.error.code, 'OV_SECRET_FILTER')
      r = await q('matches', 'delete', { filters: [eq('game_pin', '123456')] }, W)
      assert.equal(r.body.error.code, 'OV_SECRET_FILTER')
      r = await q('matches', 'upsert', { data: { game_pin: '1', external_id: uniq() }, onConflict: 'game_pin' }, W)
      assert.equal(r.body.error.code, 'OV_SECRET_FILTER')
    })

    it('are never returned by writes, but can be written', async () => {
      const ext = uniq('W')
      const r = await q('matches', 'insert', { data: { external_id: ext, game_pin: '654321', connection_pins: { referee: '1' } }, returning: '*', single: true }, W)
      assert.equal(r.status, 200)
      assert.ok(!('game_pin' in r.body.data))
      assert.ok(!('connection_pins' in r.body.data))
      assert.ok(r.changes.every(c => !('game_pin' in c.row) && !('connection_pins' in c.row)))
      const stored = (await raw.query('SELECT game_pin FROM matches WHERE external_id = $1', [ext])).rows[0]
      assert.equal(stored.game_pin, '654321')
      const ri = await q('matches', 'update', { data: { status: 'live' }, filters: [eq('external_id', ext)], returning: 'game_pin' }, { internal: true })
      assert.deepEqual(ri.body.data, [{ game_pin: '654321' }])
      assert.ok(ri.changes.every(c => !('game_pin' in c.row)), 'broadcast rows are always redacted')
    })

    it('internal mode may filter on a secret column (PIN validation)', async () => {
      const ext = uniq('P')
      await newMatch({ external_id: ext, game_pin: '777777' })
      const r = await q('matches', 'select', { columns: 'external_id', filters: [eq('game_pin', '777777'), eq('external_id', ext)] }, { internal: true })
      assert.deepEqual(r.body.data, [{ external_id: ext }])
    })
  })

  describe('writes', () => {
    it('need X-OV-Proto >= 2 (426 otherwise); reads and internal calls do not', async () => {
      for (const proto of [undefined, null, '', '1', 1, 'abc', '1.9']) {
        for (const action of ['insert', 'update', 'upsert', 'delete']) {
          const r = await q('matches', action, { data: { external_id: uniq() }, filters: [eq('external_id', 'x')] }, { proto })
          assert.equal(r.status, 426, `${action} proto=${proto}`)
          assert.equal(r.body.error.code, 'OV_CLIENT_TOO_OLD')
        }
      }
      assert.equal((await q('matches', 'select', { limit: 1 })).status, 200)
      assert.equal((await q('matches', 'insert', { data: { external_id: uniq() } }, { proto: '2' })).status, 200)
      assert.equal((await q('matches', 'insert', { data: { external_id: uniq() } }, { proto: '3' })).status, 200)
      assert.equal((await q('matches', 'insert', { data: { external_id: uniq() } }, { internal: true })).status, 200)
    })

    it('return rows only when asked (returning), with count on request', async () => {
      const ext = uniq('R')
      let r = await q('matches', 'insert', { data: { external_id: ext } }, W)
      assert.deepEqual(r.body, { data: null, error: null, count: undefined })
      r = await q('matches', 'update', { data: { status: 'final' }, filters: [eq('external_id', ext)], returning: 'external_id, status' }, W)
      assert.deepEqual(r.body.data, [{ external_id: ext, status: 'final' }])
      r = await q('matches', 'update', { data: { status: 'x' }, filters: [eq('external_id', 'nope')], returning: '*', count: 'exact' }, W)
      assert.deepEqual(r.body.data, []); assert.equal(r.body.count, 0)
      r = await q('matches', 'delete', { filters: [eq('external_id', ext)], returning: '*', count: 'exact', head: true }, W)
      assert.equal(r.body.data, null); assert.equal(r.body.count, 1)
      r = await q('matches', 'insert', { data: { external_id: uniq() }, returning: 'nope' }, W)
      assert.equal(r.body.error.code, 'PGRST204')
    })

    it('single on a write rolls the write back when it does not hit exactly one row', async () => {
      const ext = uniq('SW')
      await newMatch({ external_id: `${ext}-1`, status: 'a' })
      await newMatch({ external_id: `${ext}-2`, status: 'a' })
      const r = await q('matches', 'update', { data: { status: 'b' }, filters: [{ type: 'like', column: 'external_id', value: `${ext}-*` }], returning: 'id', single: true }, W)
      assert.equal(r.body.error.code, 'PGRST116')
      const rows = (await raw.query('SELECT status FROM matches WHERE external_id LIKE $1', [`${ext}-%`])).rows
      assert.deepEqual(rows.map(x => x.status), ['a', 'a'])
    })

    it('multi-row insert uses the union of keys; missing keys are NULL, absent columns keep defaults', async () => {
      const ext = uniq('U')
      const r = await q('matches', 'insert', { data: [{ external_id: `${ext}-1`, winner: 'home' }, { external_id: `${ext}-2`, final_score: '3:0' }], returning: 'external_id, winner, final_score, test, sport_type' }, W)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.deepEqual(r.body.data, [
        { external_id: `${ext}-1`, winner: 'home', final_score: null, test: false, sport_type: 'indoor' },
        { external_id: `${ext}-2`, winner: null, final_score: '3:0', test: false, sport_type: 'indoor' }
      ])
      assert.deepEqual(r.changes.map(c => c.eventType), ['INSERT', 'INSERT'])
    })

    it('unknown write columns are an error (PGRST204) and nothing is written', async () => {
      const ext = uniq('X')
      const r = await q('matches', 'insert', { data: [{ external_id: ext }, { external_id: `${ext}b`, team_a: {} }] }, W)
      assert.equal(r.body.error.code, 'PGRST204')
      const n = (await raw.query('SELECT count(*)::int AS n FROM matches WHERE external_id LIKE $1', [`${ext}%`])).rows[0].n
      assert.equal(n, 0)
    })

    it('bad data shapes are refused', async () => {
      for (const data of [[], null, 'x', [1], [[]], [null]]) {
        const r = await q('matches', 'insert', { data }, W)
        assert.equal(r.body.error.code, 'OV_INVALID_DATA', JSON.stringify(data))
      }
      const r = await q('matches', 'update', { data: [{ status: 'x' }], filters: [eq('id', '00000000-0000-0000-0000-000000000000')] }, W)
      assert.equal(r.body.error.code, 'OV_INVALID_DATA')
    })

    it('unfiltered update and delete are refused', async () => {
      let r = await q('matches', 'update', { data: { status: 'x' } }, W)
      assert.equal(r.body.error.code, 'OV_UNFILTERED_WRITE')
      r = await q('matches', 'delete', { filters: [] }, W)
      assert.equal(r.body.error.code, 'OV_UNFILTERED_WRITE')
      r = await q('referee_database', 'delete', {}, { internal: true })
      assert.equal(r.body.error.code, 'OV_UNFILTERED_WRITE')
    })

    it('upsert: external_id on matches (insert then update, no __inserted leak)', async () => {
      const ext = uniq('UP')
      let r = await q('matches', 'upsert', { data: { external_id: ext, status: 'setup' }, onConflict: 'external_id', returning: 'id', single: true }, W)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      const id = r.body.data.id
      assert.deepEqual(Object.keys(r.body.data), ['id'])
      assert.equal(r.changes[0].eventType, 'INSERT')
      assert.ok(!('__inserted' in r.changes[0].row))
      r = await q('matches', 'upsert', { data: { external_id: ext, status: 'live' }, onConflict: 'external_id', returning: '*', single: true }, W)
      assert.equal(r.body.data.id, id)
      assert.equal(r.body.data.status, 'live')
      assert.ok(!('__inserted' in r.body.data))
      assert.equal(r.changes[0].eventType, 'UPDATE')
    })

    it('upsert: external_id on sets and events, match_id on match_live_state', async () => {
      const m = await newMatch()
      const setExt = `${m.external_id}:s:1`
      let r = await q('sets', 'upsert', { data: { external_id: setExt, match_id: m.id, index: 1, home_points: 5 }, onConflict: 'external_id' }, W)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      r = await q('sets', 'upsert', { data: { external_id: setExt, match_id: m.id, index: 1, home_points: 6 }, onConflict: 'external_id', returning: 'home_points' }, W)
      assert.deepEqual(r.body.data, [{ home_points: 6 }])

      const events = [1, 2, 3].map(n => ({ external_id: `${m.external_id}:e:${n}`, match_id: m.id, seq: n + 0.5, type: 'point', payload: { team: 'home' }, ts: '2026-10-05T12:00:0' + n + 'Z' }))
      r = await q('events', 'upsert', { data: events, onConflict: 'external_id', returning: 'id, seq, ts, payload' }, W)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.equal(typeof r.body.data[0].id, 'number')
      assert.equal(r.body.data[0].seq, 1.5)
      assert.equal(r.body.data[0].ts, '2026-10-05T12:00:01+00:00')
      events[0].type = 'timeout'
      r = await q('events', 'upsert', { data: events, onConflict: 'external_id', count: 'exact' }, W)
      assert.equal(r.body.count, 3)
      assert.equal((await raw.query('SELECT count(*)::int n FROM events WHERE match_id = $1', [m.id])).rows[0].n, 3)

      r = await q('match_live_state', 'upsert', { data: { match_id: m.id, points_a: 1, lineup_a: { I: 7 } }, onConflict: 'match_id' }, W)
      assert.equal(r.status, 200)
      r = await q('match_live_state', 'upsert', { data: { match_id: m.id, points_a: 2 }, onConflict: 'match_id', returning: 'points_a, lineup_a' }, W)
      assert.deepEqual(r.body.data, [{ points_a: 2, lineup_a: { I: 7 } }])
    })

    it('upsert: composite onConflict on user_matches; default target is the primary key', async () => {
      const uid = (await raw.query('INSERT INTO auth.users (email) VALUES ($1) RETURNING id', [`${uniq('u')}@x.invalid`])).rows[0].id
      const row = { user_id: uid, match_external_id: uniq('E'), role: 'scorer' }
      let r = await q('user_matches', 'upsert', { data: row, onConflict: 'user_id,match_external_id,role', returning: 'id' }, W)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      const id = r.body.data[0].id
      r = await q('user_matches', 'upsert', { data: { ...row, sport_type: 'indoor' }, onConflict: 'user_id, match_external_id, role', returning: 'id, sport_type' }, W)
      assert.deepEqual(r.body.data, [{ id, sport_type: 'indoor' }])
      r = await q('user_matches', 'upsert', { data: { id, ...row, role: 'scorer' } }, W)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      r = await q('user_matches', 'upsert', { data: row, onConflict: 'role' }, W)
      assert.equal(r.body.error.code, '42P10') // no unique constraint on that column
    })

    it('update merges JSON objects on matches atomically and keeps other PIN entries', async () => {
      const m = await newMatch({
        connection_pins: { referee: '111111', bench_home: '222222' },
        connections: { referee_enabled: true, home_bench_enabled: true },
        match_info: { a: 1, b: 2 }
      })
      // The client cannot read connection_pins, so it sends only the entry it changes.
      let r = await q('matches', 'update', { data: { connection_pins: { referee: '333333' }, connections: { referee_enabled: false } }, filters: [eq('external_id', m.external_id)] }, W)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      let row = (await q('matches', 'select', { columns: 'connection_pins, connections, match_info', filters: [eq('id', m.id)], single: true }, { internal: true })).body.data
      assert.deepEqual(row.connection_pins, { referee: '333333', bench_home: '222222' })
      assert.deepEqual(row.connections, { referee_enabled: false, home_bench_enabled: true })
      // A non-merge JSON column is replaced.
      await q('matches', 'update', { data: { match_info: { c: 3 } }, filters: [eq('id', m.id)] }, W)
      // Arrays replace, null clears.
      await q('matches', 'update', { data: { set_results: [1, 2] }, filters: [eq('id', m.id)] }, W)
      await q('matches', 'update', { data: { set_results: { x: 1 } }, filters: [eq('id', m.id)] }, W) // object onto array: replace
      await q('matches', 'update', { data: { sanctions: null }, filters: [eq('id', m.id)] }, W)
      row = (await q('matches', 'select', { columns: 'match_info, set_results, sanctions', filters: [eq('id', m.id)], single: true })).body.data
      assert.deepEqual(row, { match_info: { c: 3 }, set_results: { x: 1 }, sanctions: null })

      // The bench PIN still validates the way server.js validate-connection-pin reads it.
      const pins = await q('matches', 'select', { columns: 'id, external_id, connections, connection_pins', filters: [{ type: 'in', column: 'status', value: ['setup', 'live'] }, eq('sport_type', 'indoor')] }, { internal: true })
      const hit = pins.body.data.find(x => x.connection_pins?.bench_home === '222222' && x.connections?.home_bench_enabled)
      assert.equal(hit?.external_id, m.external_id)

      // Concurrent partial updates of different keys both survive.
      await Promise.all([
        q('matches', 'update', { data: { connection_pins: { upload_home: '444444' } }, filters: [eq('id', m.id)] }, W),
        q('matches', 'update', { data: { connection_pins: { upload_away: '555555' } }, filters: [eq('id', m.id)] }, W),
        q('matches', 'update', { data: { connection_pins: { bench_away: '666666' } }, filters: [eq('id', m.id)] }, W)
      ])
      row = (await raw.query('SELECT connection_pins FROM matches WHERE id = $1', [m.id])).rows[0]
      assert.deepEqual(row.connection_pins, { referee: '333333', bench_home: '222222', upload_home: '444444', upload_away: '555555', bench_away: '666666' })
    })

    it('delete of a match cascades to sets, events and live state', async () => {
      const m = await newMatch()
      await q('sets', 'insert', { data: { external_id: `${m.external_id}:s:1`, match_id: m.id } }, W)
      await q('events', 'insert', { data: { external_id: `${m.external_id}:e:1`, match_id: m.id } }, W)
      await q('match_live_state', 'insert', { data: { match_id: m.id } }, W)
      const r = await q('matches', 'delete', { filters: [eq('id', m.id)] }, W)
      assert.equal(r.status, 200)
      assert.equal(r.changes[0].eventType, 'DELETE')
      assert.equal(r.changes[0].row.id, m.id)
      for (const t of ['sets', 'events', 'match_live_state']) {
        assert.equal((await raw.query(`SELECT count(*)::int n FROM ${t} WHERE match_id = $1`, [m.id])).rows[0].n, 0, t)
      }
    })

    it('collectChanges can be switched off and is off for tables outside changeTables', async () => {
      let r = await q('matches', 'insert', { data: { external_id: uniq() } }, { ...W, collectChanges: false })
      assert.equal(r.changes, undefined)
      r = await q('referee_database', 'insert', { data: { last_name: 'x' } }, W)
      assert.equal(r.changes, undefined)
    })
  })

  describe('set and event id scope guard', () => {
    it('two matches whose sets carry the same Dexie id both survive', async () => {
      const a = await newMatch(); const b = await newMatch()
      let r = await q('sets', 'upsert', { data: { external_id: `${a.external_id}:s:1`, match_id: a.id, home_points: 1 }, onConflict: 'external_id' }, W)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      r = await q('sets', 'upsert', { data: { external_id: `${b.external_id}:s:1`, match_id: b.id, home_points: 2 }, onConflict: 'external_id' }, W)
      assert.equal(r.status, 200)
      const rows = (await raw.query('SELECT match_id, home_points FROM sets WHERE match_id = ANY($1) ORDER BY home_points', [[a.id, b.id]])).rows
      assert.deepEqual(rows, [{ match_id: a.id, home_points: 1 }, { match_id: b.id, home_points: 2 }])
      // Legacy backupManager fallback ids (`${externalId}_set_${n}`) are accepted too.
      r = await q('sets', 'insert', { data: { external_id: `${a.external_id}_set_2`, match_id: a.id } }, W)
      assert.equal(r.status, 200)
    })

    it('rejects unscoped ids on insert and upsert, and writes nothing from a mixed batch', async () => {
      const a = await newMatch(); const b = await newMatch()
      const bad = [
        { external_id: '1', match_id: a.id },
        { external_id: 1, match_id: a.id },
        { external_id: `${b.external_id}:s:9`, match_id: a.id },
        { external_id: `${a.external_id}x:s:1`, match_id: a.id },
        { external_id: a.external_id, match_id: a.id },
        { external_id: `${a.external_id}:s:1` },
        { external_id: `${a.external_id}:s:1`, match_id: null },
        { external_id: `${a.external_id}:s:1`, match_id: '00000000-0000-0000-0000-000000000000' },
        { match_id: a.id }
      ]
      for (const row of bad) {
        for (const action of ['insert', 'upsert']) {
          const r = await q('sets', action, { data: row, onConflict: action === 'upsert' ? 'external_id' : undefined }, W)
          assert.equal(r.status, 400, `${action} ${JSON.stringify(row)}`)
          assert.equal(r.body.error.code, 'OV_UNSCOPED_EXTERNAL_ID', `${action} ${JSON.stringify(row)}`)
        }
      }
      const r = await q('events', 'insert', { data: [{ external_id: `${a.external_id}:e:1`, match_id: a.id }, { external_id: '2', match_id: a.id }] }, W)
      assert.equal(r.body.error.code, 'OV_UNSCOPED_EXTERNAL_ID')
      assert.equal((await raw.query('SELECT count(*)::int n FROM events WHERE match_id = $1', [a.id])).rows[0].n, 0)
      const inv = await q('sets', 'insert', { data: { external_id: `${a.external_id}:s:1`, match_id: 'not-a-uuid' } }, W)
      assert.equal(inv.status, 400)
    })

    it('update and delete on sets/events must be scoped to one match', async () => {
      const m = await newMatch()
      const ext = `${m.external_id}:s:1`
      await q('sets', 'insert', { data: { external_id: ext, match_id: m.id, index: 1 } }, W)
      const unscoped = (indexCol) => [[eq(indexCol, 1)], [eq('external_id', '1')], [{ type: 'like', column: 'external_id', value: `${m.external_id}*` }],
        [{ type: 'in', column: 'match_id', value: [m.id] }], [eq('external_id', '')], [{ type: 'neq', column: 'match_id', value: m.id }]]
      for (const filters of unscoped('index')) {
        const u = await q('sets', 'update', { data: { home_points: 9 }, filters }, W)
        assert.equal(u.body.error.code, 'OV_UNSCOPED_WRITE', JSON.stringify(filters))
        const d = await q('sets', 'delete', { filters }, W)
        assert.equal(d.body.error.code, 'OV_UNSCOPED_WRITE', JSON.stringify(filters))
      }
      for (const filters of unscoped('set_index')) {
        const u = await q('events', 'update', { data: { type: 'x' }, filters }, W)
        assert.equal(u.body.error.code, 'OV_UNSCOPED_WRITE', JSON.stringify(filters))
        const d = await q('events', 'delete', { filters }, W)
        assert.equal(d.body.error.code, 'OV_UNSCOPED_WRITE', JSON.stringify(filters))
      }
      assert.equal((await raw.query('SELECT home_points FROM sets WHERE external_id = $1', [ext])).rows[0].home_points, 0)
      let r = await q('sets', 'update', { data: { home_points: 9 }, filters: [eq('external_id', ext)], returning: 'home_points' }, W)
      assert.deepEqual(r.body.data, [{ home_points: 9 }])
      r = await q('sets', 'update', { data: { finished: true }, filters: [eq('match_id', m.id), eq('index', 1)], count: 'exact' }, W)
      assert.equal(r.body.count, 1)
      r = await q('events', 'delete', { filters: [eq('match_id', m.id)] }, W)
      assert.equal(r.status, 200)
    })

    it('an update cannot move a set to another match or rename it out of scope', async () => {
      const a = await newMatch(); const b = await newMatch()
      const ext = `${a.external_id}:s:1`
      await q('sets', 'insert', { data: { external_id: ext, match_id: a.id } }, W)
      let r = await q('sets', 'update', { data: { match_id: b.id }, filters: [eq('external_id', ext)] }, W)
      assert.equal(r.body.error.code, 'OV_UNSCOPED_EXTERNAL_ID')
      r = await q('sets', 'update', { data: { external_id: '77' }, filters: [eq('match_id', a.id)] }, W)
      assert.equal(r.body.error.code, 'OV_UNSCOPED_EXTERNAL_ID')
      const row = (await raw.query('SELECT external_id, match_id FROM sets WHERE external_id = $1', [ext])).rows[0]
      assert.deepEqual(row, { external_id: ext, match_id: a.id })
    })

    it('an upsert cannot overwrite or move a set/event of another match (by id, default key or collided external_id)', async () => {
      const a = await newMatch(); const b = await newMatch()
      const aSetExt = `${a.external_id}:s:1`
      const aSet = (await q('sets', 'insert', { data: { external_id: aSetExt, match_id: a.id, home_points: 5 }, returning: 'id', single: true }, W)).body.data.id
      for (const onConflict of ['id', undefined]) {
        const r = await q('sets', 'upsert', { data: { id: aSet, external_id: `${b.external_id}:s:9`, match_id: b.id, home_points: 99 }, onConflict, returning: '*' }, W)
        assert.equal(r.status, 400, `onConflict ${onConflict}: ${JSON.stringify(r.body)}`)
        assert.equal(r.body.error.code, 'OV_UNSCOPED_WRITE')
      }
      assert.deepEqual((await raw.query('SELECT external_id, match_id, home_points FROM sets WHERE id = $1', [aSet])).rows[0],
        { external_id: aSetExt, match_id: a.id, home_points: 5 })

      const aEv = (await q('events', 'insert', { data: { external_id: `${a.external_id}:e:1`, match_id: a.id, type: 'point' }, returning: 'id', single: true }, W)).body.data.id
      let r = await q('events', 'upsert', { data: { id: aEv, external_id: `${b.external_id}:e:1`, match_id: b.id, type: 'hijack' } }, W)
      assert.equal(r.body.error.code, 'OV_UNSCOPED_WRITE')
      assert.equal((await raw.query('SELECT match_id FROM events WHERE id = $1', [aEv])).rows[0].match_id, a.id)

      // A row damaged by the historical collisions: it lives in match a but its
      // external_id is in b's namespace. b's scorer upserting that id must not move it.
      const collided = `${b.external_id}:e:7`
      await raw.query("INSERT INTO events (external_id, match_id, type) VALUES ($1, $2, 'old')", [collided, a.id])
      r = await q('events', 'upsert', { data: { external_id: collided, match_id: b.id, type: 'new' }, onConflict: 'external_id' }, W)
      assert.equal(r.body.error.code, 'OV_UNSCOPED_WRITE')
      // ... and a batch containing it writes nothing at all.
      r = await q('events', 'upsert', { data: [{ external_id: `${b.external_id}:e:8`, match_id: b.id }, { external_id: collided, match_id: b.id }], onConflict: 'external_id' }, W)
      assert.equal(r.body.error.code, 'OV_UNSCOPED_WRITE')
      assert.deepEqual((await raw.query('SELECT external_id, match_id, type FROM events WHERE external_id = ANY($1) ORDER BY external_id', [[collided, `${b.external_id}:e:8`]])).rows,
        [{ external_id: collided, match_id: a.id, type: 'old' }])

      // Upserts within the same match keep working, by id and by external_id.
      r = await q('sets', 'upsert', { data: { id: aSet, external_id: aSetExt, match_id: a.id, home_points: 6 }, onConflict: 'id', returning: 'home_points', single: true }, W)
      assert.deepEqual(r.body.data, { home_points: 6 })
      r = await q('sets', 'upsert', { data: { external_id: aSetExt, match_id: a.id, home_points: 7 }, onConflict: 'external_id', count: 'exact' }, W)
      assert.equal(r.body.count, 1)
    })
  })

  describe('error mapping', () => {
    it('transient SQLSTATEs are 503 and retryable, timeouts 504, others 400', () => {
      const mk = (code) => Object.assign(new pg.DatabaseError('boom', 0, 'error'), { code })
      for (const code of ['40001', '40P01', '55P03', '57P01', '53300', '08006']) {
        const r = db.toErrorResult(mk(code), { action: 'upsert', table: 'events' })
        assert.equal(r.status, 503, code)
        assert.deepEqual(r.body.error, { message: 'Database operation failed', code, retryable: true })
      }
      assert.equal(db.toErrorResult(mk('57014'), {}).status, 504)
      for (const code of ['23505', '22P02', '23503', '42703']) {
        const r = db.toErrorResult(mk(code), {})
        assert.equal(r.status, 400, code)
        assert.equal(r.body.error.retryable, undefined, code)
      }
      assert.equal(sqlstateStatus('40P01'), 503)
    })
  })

  describe('owner scoping (opts.scope)', () => {
    let alice, bob
    before(async () => {
      alice = (await raw.query("INSERT INTO auth.users (email) VALUES ($1) RETURNING id", [`${uniq('a')}@x.invalid`])).rows[0].id
      bob = (await raw.query("INSERT INTO auth.users (email) VALUES ($1) RETURNING id", [`${uniq('b')}@x.invalid`])).rows[0].id
      await raw.query("INSERT INTO user_matches (user_id, match_external_id, role) VALUES ($1, 'A1', 'scorer'), ($2, 'B1', 'scorer')", [alice, bob])
      await raw.query("INSERT INTO profiles (user_id, first_name) VALUES ($1, 'Alice'), ($2, 'Bob')", [alice, bob])
    })

    it('forces the owner filter and ignores a client user_id filter', async () => {
      const r = await q('user_matches', 'select', { columns: 'match_external_id', filters: [eq('user_id', bob)] }, { scope: { column: 'user_id', value: alice } })
      assert.deepEqual(r.body.data, [{ match_external_id: 'A1' }])
    })

    it('forces user_id on writes; a conflicting row of another user is untouched', async () => {
      let r = await q('user_matches', 'insert', { data: { user_id: bob, match_external_id: 'A2', role: 'scorer' }, returning: 'user_id' }, { ...W, scope: { column: 'user_id', value: alice } })
      assert.deepEqual(r.body.data, [{ user_id: alice }])
      const bobProfile = (await raw.query('SELECT id FROM profiles WHERE user_id = $1', [bob])).rows[0].id
      r = await q('profiles', 'upsert', { data: { id: bobProfile, first_name: 'Hacked' }, onConflict: 'id', returning: '*' }, { ...W, scope: { column: 'user_id', value: alice } })
      assert.equal(r.status, 200)
      assert.deepEqual(r.body.data, [])
      assert.equal((await raw.query('SELECT first_name, user_id FROM profiles WHERE id = $1', [bobProfile])).rows[0].first_name, 'Bob')
      r = await q('profiles', 'update', { data: { first_name: 'X' }, filters: [eq('id', bobProfile)], count: 'exact' }, { ...W, scope: { column: 'user_id', value: alice } })
      assert.equal(r.body.count, 0)
      r = await q('user_matches', 'delete', { filters: [] }, { ...W, scope: { column: 'user_id', value: alice } })
      assert.equal(r.status, 200) // the forced owner filter counts as a filter
      assert.equal((await raw.query('SELECT count(*)::int n FROM user_matches WHERE user_id = $1', [bob])).rows[0].n, 1)
    })
  })

  describe('SQL injection attempts', () => {
    let before0
    const tableCounts = async () => (await raw.query(`SELECT (SELECT count(*) FROM matches)::int m, (SELECT count(*) FROM internal_notes)::int n,
      (SELECT count(*) FROM auth.users)::int u, (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public')::int t`)).rows[0]
    before(async () => { before0 = await tableCounts() })

    const PAYLOADS = [
      'id; DROP TABLE internal_notes; --',
      'id"; DROP TABLE internal_notes; --',
      '"id" = "id" OR 1=1 --',
      'id) OR (1=1',
      'id, (SELECT note FROM internal_notes)',
      '(SELECT note FROM internal_notes)',
      'id::text',
      'pg_sleep(5)',
      'external_id->>x\' OR 1=1 --',
      'match_info->>competition_name\'; DROP TABLE matches; --',
      'match_info->>(select 1)',
      'match_info->>"x"',
      '*/ id /*',
      'id\u0000',
      'extérnal_id',
      'a'.repeat(300)
    ]

    it('identifiers in select, filters, order, onConflict, returning and data keys are refused', async () => {
      for (const p of PAYLOADS) {
        const sel = await q('matches', 'select', { columns: p })
        assert.equal(sel.status, 400, `select ${p}`)
        const fil = await q('matches', 'select', { filters: [{ type: 'eq', column: p, value: 'x' }] })
        assert.equal(fil.status, 400, `filter ${p}`)
        const ord = await q('matches', 'select', { order: [{ column: p }] })
        assert.equal(ord.status, 400, `order ${p}`)
        const conf = await q('matches', 'upsert', { data: { external_id: uniq() }, onConflict: p }, W)
        assert.equal(conf.status, 400, `onConflict ${p}`)
        const ret = await q('matches', 'insert', { data: { external_id: uniq() }, returning: p }, W)
        assert.equal(ret.status, 400, `returning ${p}`)
        const key = await q('matches', 'insert', { data: { [p]: 'x' } }, W)
        assert.equal(key.status, 400, `data key ${p}`)
        const upd = await q('matches', 'update', { data: { [p]: 'x' }, filters: [eq('external_id', 'x')] }, W)
        assert.equal(upd.status, 400, `update key ${p}`)
      }
      for (const onConflict of ['external_id) DO NOTHING; --', 'external_id) DO UPDATE SET game_pin = \'0\' --', 'external_id,(select 1)', '(external_id)', 'external_id WHERE true']) {
        const r = await q('matches', 'upsert', { data: { external_id: uniq() }, onConflict }, W)
        assert.equal(r.status, 400, onConflict)
        assert.ok(['OV_INVALID_CONFLICT', 'OV_SECRET_FILTER'].includes(r.body.error.code), onConflict)
      }
    })

    it('filter types, order objects and filter lists outside the contract are refused', async () => {
      for (const f of [{ type: 'or', column: 'id', value: 'x' }, { type: 'eq;', column: 'id', value: 'x' }, { type: 'raw', column: 'id', value: '1=1' },
        { type: 'match', column: 'id', value: {} }, { type: 'eq', column: 'status', value: { a: 1 } }, { type: 'eq', column: 'status', value: ['a'] },
        { type: 'eq', column: 'status', value: null }, { type: 'in', column: 'status', value: 'a,b' }, { type: 'in', column: 'status', value: [{ a: 1 }] },
        { type: 'like', column: 'status', value: 5 }, { type: 'is', column: 'status', value: 'not null' }, 'eq.id', null]) {
        const r = await q('matches', 'select', { filters: [f] })
        assert.equal(r.body.error.code, 'OV_INVALID_FILTER', JSON.stringify(f))
      }
      let r = await q('matches', 'select', { filters: 'id=eq.1' })
      assert.equal(r.body.error.code, 'OV_INVALID_FILTER')
      r = await q('matches', 'select', { order: ['id desc'] })
      assert.equal(r.body.error.code, 'OV_INVALID_ORDER')
      r = await q('matches', 'select', { order: [{ column: 'id', ascending: 'desc; drop table matches' }] })
      assert.equal(r.status, 200) // ascending is only ever compared with false
    })

    it('values are always data: hostile strings are stored and matched literally', async () => {
      const evil = ["'; DROP TABLE internal_notes; --", '\' OR \'1\'=\'1', '$1', '%', '\\', '"', '*', 'a\u0000b'.replace('\u0000', '')]
      for (const v of evil) {
        const ext = uniq('INJ') + v
        let r = await q('matches', 'insert', { data: { external_id: ext, winner: v, match_info: { v } } }, W)
        assert.equal(r.status, 200, `${v}: ${JSON.stringify(r.body)}`)
        r = await q('matches', 'select', { columns: 'winner, match_info', filters: [eq('external_id', ext)], single: true })
        assert.deepEqual(r.body.data, { winner: v, match_info: { v } })
        r = await q('matches', 'select', { columns: 'external_id', filters: [{ type: 'eq', column: 'winner', value: v }, eq('external_id', ext)] })
        assert.equal(r.body.data.length, 1, v)
        r = await q('matches', 'select', { columns: 'external_id', filters: [{ type: 'eq', column: 'match_info->>v', value: v }, eq('external_id', ext)] })
        assert.equal(r.body.data.length, 1, `json path ${v}`)
        r = await q('matches', 'select', { filters: [{ type: 'in', column: 'external_id', value: [ext, "x') OR ('1'='1"] }], count: 'exact', head: true })
        assert.equal(r.body.count, 1)
      }
      const r = await q('matches', 'select', { filters: [{ type: 'eq', column: 'match_info->>v', value: "' OR 1=1 --" }], count: 'exact', head: true })
      assert.equal(r.body.count, 0)
    })

    it('filter values that name a secret column are matched literally, never against the column', async () => {
      const ext = uniq('SEC')
      await q('matches', 'insert', { data: { external_id: ext, game_pin: '424242', winner: 'home', match_info: { hall: 'A' } } }, W)
      const one = (probe) => q('matches', 'select', { columns: 'external_id', filters: [probe, eq('external_id', ext)] })
      // Control: the same filter shapes do find the row with honest values.
      for (const probe of [{ type: 'like', column: 'winner', value: 'ho*' }, { type: 'contains', column: 'match_info', value: { hall: 'A' } },
        { type: 'eq', column: 'match_info->>hall', value: 'A' }]) {
        assert.equal((await one(probe)).body.data.length, 1, JSON.stringify(probe))
      }
      const probes = [
        { type: 'like', column: 'winner', value: "%' OR game_pin LIKE '4%" },
        { type: 'ilike', column: 'winner', value: '%) OR (game_pin ILIKE 4*' },
        { type: 'like', column: 'match_info->>hall', value: "A' OR game_pin LIKE '4%' --" },
        { type: 'eq', column: 'match_info->>hall', value: "A' OR game_pin = '424242" },
        { type: 'in', column: 'winner', value: ["x') OR game_pin LIKE ('4%"] },
        { type: 'contains', column: 'match_info', value: { game_pin: '424242' } },
        { type: 'contains', column: 'match_info', value: '{"hall":"A","game_pin":"424242"}' }
      ]
      for (const probe of probes) {
        const r = await one(probe)
        assert.equal(r.status, 200, JSON.stringify(probe))
        assert.deepEqual(r.body.data, [], JSON.stringify(probe))
      }
      // A JSON path or contains value that names the secret column, and invalid JSON, are refused outright.
      let r = await one({ type: 'eq', column: 'match_info->>game_pin', value: '424242' })
      assert.equal(r.body.error.code, 'OV_SECRET_FILTER')
      r = await one({ type: 'contains', column: 'match_info', value: '{"x":1}) OR (game_pin LIKE \'1%\'' })
      assert.equal(r.body.error.code, 'OV_INVALID_FILTER')
    })

    it('nothing was dropped or leaked', async () => {
      const now = await tableCounts()
      assert.equal(now.n, before0.n)
      assert.equal(now.u, before0.u)
      assert.equal(now.t, before0.t)
      assert.ok(now.m >= before0.m)
      assert.equal((await raw.query('SELECT note FROM internal_notes')).rows[0].note, 'do not leak')
    })
  })

  describe('limits', () => {
    it('statement timeout cancels long statements', async () => {
      const slow = createPgQuery({ connectionString: tdb.url, logger, statementTimeoutMs: 100 })
      try {
        await assert.rejects(slow.pool.query('SELECT pg_sleep(1)'), (e) => e.code === '57014')
        const st = await slow.pool.query('SHOW TimeZone')
        assert.equal(st.rows[0].TimeZone, 'UTC')
      } finally {
        await slow.close()
      }
    })

    it('withTransaction can raise the timeout for one transaction', async () => {
      const slow = createPgQuery({ connectionString: tdb.url, logger, statementTimeoutMs: 100 })
      try {
        await slow.withTransaction(c => c.query('SELECT pg_sleep(0.3)'), { statementTimeoutMs: 2000 })
      } finally {
        await slow.close()
      }
    })
  })
})
