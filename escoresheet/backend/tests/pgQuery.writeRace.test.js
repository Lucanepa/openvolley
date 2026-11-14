/**
 * Update / delete (and upsert of matches, child writes of a test-only
 * account) under the match guards of lib/pgQuery.js (opts.matchOwner) on a
 * real Postgres, with a row that another device commits (or deletes)
 * between the write's checks and its statement.
 * Postgres runs READ COMMITTED: each statement sees what was committed when
 * it started (and an upsert's ON CONFLICT also a row committed later), so
 * the checks before the statement cannot see that row. The guards are part
 * of the statement as well: such a row is written only when the caller may
 * write it, and a write that meets one it may not is refused as a whole,
 * with the code the checks give.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { createPgQuery } from '../lib/pgQuery.js'
import { SKIP_PG, createTestDatabase, quietLogger } from './helpers/pgTestDb.js'

describe('pgQuery update/delete/upsert: a row committed after the checks', { skip: SKIP_PG }, () => {
  let tdb, db, raw
  let alice, bob, pending, indoor, beach
  let seq = 0
  const uniq = (p = 'wr') => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`
  const eq = (column, value) => ({ type: 'eq', column, value })
  const as = (userId) => ({ proto: 2, matchOwner: { userId }, actorId: userId })
  const asPending = (userId) => ({ proto: 2, matchOwner: { userId, testOnly: true }, actorId: userId })
  const asIndoor = (userId) => ({ proto: 2, matchOwner: { userId, testOnly: false, testOnlySports: ['beach'] }, actorId: userId })
  const asBeach = (userId) => ({ proto: 2, matchOwner: { userId, testOnly: false, testOnlySports: ['indoor'] }, actorId: userId })
  const q = (table, action, params, opts) => db.runQuery({ table, action, params }, opts)
  const okay = (r) => assert.equal(r.status, 200, JSON.stringify(r.body))
  const expectCode = (r, status, code) => {
    assert.equal(r.status, status, JSON.stringify(r.body))
    assert.equal(r.body.error.code, code)
  }
  const eventOf = (m, n) => ({ external_id: `${m.external_id}:e:${n}`, match_id: m.id, set_index: 1, type: 'point', seq: n })
  const eventsOf = async (m) => (await raw.query('SELECT external_id, type, score_a FROM events WHERE match_id = $1 ORDER BY seq', [m.id])).rows

  async function user () {
    const id = randomUUID()
    await raw.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `${id}@example.ch`])
    return id
  }

  async function matchOf (opts, extra = {}) {
    const external_id = uniq('M')
    const r = await q('matches', 'insert', { data: { external_id, status: 'live', ...extra }, returning: 'id', single: true }, opts)
    okay(r)
    return { id: r.body.data.id, external_id }
  }

  /**
   * The write on a connection of its own, in its own transaction; `between`
   * runs (and commits, through the pool) right before the write's UPDATE /
   * DELETE / INSERT (upsert) statement, after every check of it.
   */
  async function writeWithCommitBetween (table, action, params, opts, between) {
    const conn = new pg.Client({ connectionString: tdb.url })
    await conn.connect()
    let ran = false
    const client = {
      query: async (sql, values) => {
        if (!ran && /^WITH w AS \((UPDATE|DELETE|INSERT) /.test(sql)) {
          ran = true
          await between()
        }
        return conn.query(sql, values)
      }
    }
    try {
      await conn.query('BEGIN')
      const r = await q(table, action, params, { ...opts, client })
      await conn.query(r.status === 200 ? 'COMMIT' : 'ROLLBACK')
      assert.equal(ran, true, 'the write reached its statement')
      return r
    } finally {
      await conn.end()
    }
  }

  before(async () => {
    tdb = await createTestDatabase('writerace')
    db = createPgQuery({ connectionString: tdb.url, logger: quietLogger() })
    raw = new pg.Client({ connectionString: tdb.url })
    await raw.connect()
    alice = await user()
    bob = await user()
    pending = await user()
    indoor = await user()
    beach = await user()
  })

  after(async () => {
    await raw?.end()
    await db?.close()
    await tdb?.drop()
  })

  it('a stranger\'s delete / update of the next event: the event the owner syncs in between stays as it is', async () => {
    const m = await matchOf(as(alice))
    okay(await q('events', 'insert', { data: eventOf(m, 1) }, as(alice)))
    // once the row is there, the stranger is refused by the check
    expectCode(await q('events', 'delete', { filters: [eq('external_id', `${m.external_id}:e:1`)] }, as(bob)), 403, 'OV_NOT_MATCH_OWNER')

    const del = await writeWithCommitBetween('events', 'delete', { filters: [eq('external_id', `${m.external_id}:e:2`)] }, as(bob),
      async () => okay(await q('events', 'insert', { data: eventOf(m, 2) }, as(alice))))
    expectCode(del, 403, 'OV_NOT_MATCH_OWNER')
    const upd = await writeWithCommitBetween('events', 'update', { data: { type: 'timeout', score_a: 99 }, filters: [eq('external_id', `${m.external_id}:e:3`)] }, as(bob),
      async () => okay(await q('events', 'insert', { data: eventOf(m, 3) }, as(alice))))
    expectCode(upd, 403, 'OV_NOT_MATCH_OWNER')
    // the match and a range: no id to guess
    const range = await writeWithCommitBetween('events', 'delete', { filters: [eq('match_id', m.id), { type: 'gt', column: 'seq', value: 3 }] }, as(bob),
      async () => okay(await q('events', 'insert', { data: eventOf(m, 4) }, as(alice))))
    expectCode(range, 403, 'OV_NOT_MATCH_OWNER')

    assert.deepEqual(await eventsOf(m), [1, 2, 3, 4].map((n) => ({ external_id: `${m.external_id}:e:${n}`, type: 'point', score_a: null })))
  })

  it('a stranger\'s update / delete of a match created in between does not reach it', async () => {
    const ext = uniq('M')
    const upd = await writeWithCommitBetween('matches', 'update', { data: { status: 'ended' }, filters: [eq('external_id', ext)] }, as(bob),
      async () => okay(await q('matches', 'insert', { data: { external_id: ext, status: 'live' } }, as(alice))))
    expectCode(upd, 403, 'OV_NOT_MATCH_OWNER')
    const ext2 = uniq('M')
    const del = await writeWithCommitBetween('matches', 'delete', { filters: [eq('external_id', ext2)] }, as(bob),
      async () => okay(await q('matches', 'insert', { data: { external_id: ext2, status: 'live' } }, as(alice))))
    expectCode(del, 403, 'OV_NOT_MATCH_OWNER')
    const rows = (await raw.query('SELECT external_id, status, created_by FROM matches WHERE external_id = ANY($1) ORDER BY external_id', [[ext, ext2]])).rows
    assert.deepEqual(rows, [{ external_id: ext, status: 'live', created_by: alice }, { external_id: ext2, status: 'live', created_by: alice }])
  })

  it('a write that meets its own row and a foreign one created in between writes neither', async () => {
    const mine = await matchOf(as(bob), { status: 'setup' })
    const ext = uniq('M')
    const r = await writeWithCommitBetween('matches', 'update', { data: { status: 'ended' }, filters: [{ type: 'in', column: 'external_id', value: [mine.external_id, ext] }] }, as(bob),
      async () => okay(await q('matches', 'insert', { data: { external_id: ext, status: 'setup' } }, as(alice))))
    expectCode(r, 403, 'OV_NOT_MATCH_OWNER')
    const rows = (await raw.query('SELECT external_id, status FROM matches WHERE external_id = ANY($1) ORDER BY external_id', [[mine.external_id, ext]])).rows
    assert.deepEqual(rows.map((x) => x.status), ['setup', 'setup'])
  })

  it('the owner\'s own delete still covers an event its other device syncs in between', async () => {
    const m = await matchOf(as(alice))
    okay(await q('events', 'insert', { data: eventOf(m, 1) }, as(alice)))
    const r = await writeWithCommitBetween('events', 'delete', { filters: [eq('match_id', m.id)], count: 'exact' }, as(alice),
      async () => okay(await q('events', 'insert', { data: eventOf(m, 2) }, as(alice))))
    okay(r)
    assert.equal(r.body.count, 2)
    assert.deepEqual(await eventsOf(m), [])
    // an editor the same
    await raw.query('INSERT INTO match_editors (match_id, user_id) VALUES ($1, $2)', [m.id, bob])
    const upd = await writeWithCommitBetween('events', 'update', { data: { score_a: 5 }, filters: [eq('match_id', m.id)], count: 'exact' }, as(bob),
      async () => okay(await q('events', 'insert', { data: eventOf(m, 3) }, as(alice))))
    okay(upd)
    assert.equal(upd.body.count, 1)
    assert.deepEqual(await eventsOf(m), [{ external_id: `${m.external_id}:e:3`, type: 'point', score_a: 5 }])
  })

  it('an account that is not an approved scorer, editor of a non-test match: the event synced in between is not deleted', async () => {
    const m = await matchOf(as(alice))
    await raw.query("INSERT INTO match_editors (match_id, user_id, granted_via) VALUES ($1, $2, 'claim')", [m.id, pending])
    const del = await writeWithCommitBetween('events', 'delete', { filters: [eq('external_id', `${m.external_id}:e:1`)] }, asPending(pending),
      async () => okay(await q('events', 'insert', { data: eventOf(m, 1) }, as(alice))))
    expectCode(del, 403, 'OV_SCORER_REQUIRED')
    const upd = await writeWithCommitBetween('events', 'update', { data: { score_a: 9 }, filters: [eq('external_id', `${m.external_id}:e:2`)] }, asPending(pending),
      async () => okay(await q('events', 'insert', { data: eventOf(m, 2) }, as(alice))))
    expectCode(upd, 403, 'OV_SCORER_REQUIRED')
    assert.deepEqual((await eventsOf(m)).map((e) => e.score_a), [null, null])
  })

  it('a child insert, upsert or move by an account that is not an approved scorer: a match that stops being a test match in between is not written', async () => {
    const untest = (m) => async () => okay(await q('matches', 'update', { data: { test: false }, filters: [eq('id', m.id)] }, as(alice)))
    const editorOf = (m, userId) => raw.query("INSERT INTO match_editors (match_id, user_id, granted_via) VALUES ($1, $2, 'claim')", [m.id, userId])
    const testOf = async (m) => (await raw.query('SELECT test FROM matches WHERE id = $1', [m.id])).rows[0].test
    const count = async (table, m) => (await raw.query(`SELECT count(*)::int n FROM ${table} WHERE match_id = $1`, [m.id])).rows[0].n

    const m1 = await matchOf(as(alice), { test: true })
    await editorOf(m1, pending)
    expectCode(await writeWithCommitBetween('events', 'insert', { data: eventOf(m1, 1) }, asPending(pending), untest(m1)), 403, 'OV_SCORER_REQUIRED')
    assert.equal(await testOf(m1), false)
    assert.equal(await count('events', m1), 0)

    const m2 = await matchOf(as(alice), { test: true })
    await editorOf(m2, pending)
    okay(await q('events', 'insert', { data: eventOf(m2, 1) }, as(alice)))
    expectCode(await writeWithCommitBetween('events', 'upsert', { data: { ...eventOf(m2, 1), type: 'timeout' }, onConflict: 'external_id' }, asPending(pending), untest(m2)), 403, 'OV_SCORER_REQUIRED')
    assert.deepEqual((await eventsOf(m2)).map((e) => e.type), ['point'])

    const m3 = await matchOf(as(alice), { test: true })
    await editorOf(m3, pending)
    expectCode(await writeWithCommitBetween('match_live_state', 'upsert', { data: { match_id: m3.id, points_a: 24 }, onConflict: 'match_id' }, asPending(pending), untest(m3)), 403, 'OV_SCORER_REQUIRED')
    assert.equal(await count('match_live_state', m3), 0)

    // moving an event of its own test match into a match that stops being one
    const own = await matchOf(asPending(pending), { test: true })
    okay(await q('events', 'insert', { data: eventOf(own, 1) }, asPending(pending)))
    const m4 = await matchOf(as(alice), { test: true })
    await editorOf(m4, pending)
    expectCode(await writeWithCommitBetween('events', 'update', { data: { match_id: m4.id, external_id: `${m4.external_id}:e:1` }, filters: [eq('external_id', `${own.external_id}:e:1`)] }, asPending(pending), untest(m4)), 403, 'OV_SCORER_REQUIRED')
    assert.equal(await count('events', own), 1)
    assert.equal(await count('events', m4), 0)

    // one sport only: an indoor-only editor of a beach test match
    const m5 = await matchOf(as(alice), { test: true, sport_type: 'beach' })
    await editorOf(m5, indoor)
    expectCode(await writeWithCommitBetween('events', 'insert', { data: eventOf(m5, 1) }, asIndoor(indoor), untest(m5)), 403, 'OV_SCORER_REQUIRED')
    assert.equal(await count('events', m5), 0)

    // controls: another change in between, and an indoor match that stops
    // being a test match for the indoor scorer; both written, with no
    // internal flag in the change record
    const m6 = await matchOf(as(alice), { test: true })
    await editorOf(m6, pending)
    const r6 = await writeWithCommitBetween('events', 'insert', { data: eventOf(m6, 1) }, asPending(pending),
      async () => okay(await q('matches', 'update', { data: { status: 'ended' }, filters: [eq('id', m6.id)] }, as(alice))))
    okay(r6)
    assert.deepEqual(Object.keys(r6.changes[0].row).filter((k) => k.startsWith('__')), [])
    const m7 = await matchOf(as(alice), { test: true, sport_type: 'indoor' })
    await editorOf(m7, indoor)
    okay(await writeWithCommitBetween('events', 'insert', { data: eventOf(m7, 1) }, asIndoor(indoor), untest(m7)))
    assert.equal(await count('events', m7), 1)
  })

  it('an update with test:false in a sport the account cannot score in: a match of that sport created in between stays a test match', async () => {
    const ext = uniq('M')
    const r = await writeWithCommitBetween('matches', 'update', { data: { test: false }, filters: [eq('external_id', ext)] }, asIndoor(indoor),
      async () => okay(await q('matches', 'insert', { data: { external_id: ext, status: 'live', sport_type: 'beach', test: true } }, asIndoor(indoor))))
    expectCode(r, 403, 'OV_SCORER_REQUIRED')
    assert.deepEqual((await raw.query('SELECT sport_type::text AS s, test FROM matches WHERE external_id = $1', [ext])).rows, [{ s: 'beach', test: true }])
  })

  it('an update that breaks both rules on a match created in between: OV_SCORER_REQUIRED, as the checks answer', async () => {
    const ext = uniq('M')
    const r = await writeWithCommitBetween('matches', 'update', { data: { status: 'ended' }, filters: [eq('external_id', ext)] }, asPending(bob),
      async () => okay(await q('matches', 'insert', { data: { external_id: ext, status: 'live' } }, as(alice))))
    expectCode(r, 403, 'OV_SCORER_REQUIRED')
    assert.deepEqual((await raw.query('SELECT status, test FROM matches WHERE external_id = $1', [ext])).rows, [{ status: 'live', test: false }])
  })

  it('an upsert with test:false in a sport the account cannot score in: its own match of that sport created in between stays a test match', async () => {
    const ext = uniq('M')
    const r = await writeWithCommitBetween('matches', 'upsert', { data: { external_id: ext, status: 'live', test: false }, onConflict: 'external_id' }, asIndoor(indoor),
      async () => okay(await q('matches', 'insert', { data: { external_id: ext, status: 'live', sport_type: 'beach', test: true } }, asIndoor(indoor))))
    expectCode(r, 403, 'OV_SCORER_REQUIRED')
    const rowOf = async (x) => (await raw.query('SELECT sport_type::text AS s, test, status FROM matches WHERE external_id = $1', [x])).rows
    assert.deepEqual(await rowOf(ext), [{ s: 'beach', test: true, status: 'live' }])

    // controls: the same upsert without test onto its beach test match, and
    // test:false onto its indoor test match, both created in between
    const ext2 = uniq('M')
    okay(await writeWithCommitBetween('matches', 'upsert', { data: { external_id: ext2, status: 'ended' }, onConflict: 'external_id' }, asIndoor(indoor),
      async () => okay(await q('matches', 'insert', { data: { external_id: ext2, status: 'live', sport_type: 'beach', test: true } }, asIndoor(indoor)))))
    assert.deepEqual(await rowOf(ext2), [{ s: 'beach', test: true, status: 'ended' }])
    const ext3 = uniq('M')
    okay(await writeWithCommitBetween('matches', 'upsert', { data: { external_id: ext3, status: 'live', test: false }, onConflict: 'external_id' }, asIndoor(indoor),
      async () => okay(await q('matches', 'insert', { data: { external_id: ext3, status: 'live', sport_type: 'indoor', test: true } }, asIndoor(indoor)))))
    assert.deepEqual(await rowOf(ext3), [{ s: 'indoor', test: false, status: 'live' }])
  })

  it('an upsert by an account that is not an approved scorer: a non-test match created in between stays as it is', async () => {
    const rowOf = async (x) => (await raw.query('SELECT status, test, created_by FROM matches WHERE external_id = $1', [x])).rows
    // a match it edits
    const ext = uniq('M')
    const r = await writeWithCommitBetween('matches', 'upsert', { data: { external_id: ext, status: 'ended', test: true }, onConflict: 'external_id' }, asPending(pending),
      async () => {
        const m = await q('matches', 'insert', { data: { external_id: ext, status: 'live' }, returning: 'id', single: true }, as(alice))
        okay(m)
        await raw.query("INSERT INTO match_editors (match_id, user_id, granted_via) VALUES ($1, $2, 'claim')", [m.body.data.id, pending])
      })
    expectCode(r, 403, 'OV_SCORER_REQUIRED')
    assert.deepEqual(await rowOf(ext), [{ status: 'live', test: false, created_by: alice }])
    // a stranger's match: both rules, the test-only one answers first (as the checks)
    const ext2 = uniq('M')
    const r2 = await writeWithCommitBetween('matches', 'upsert', { data: { external_id: ext2, status: 'ended', test: true }, onConflict: 'external_id' }, asPending(bob),
      async () => okay(await q('matches', 'insert', { data: { external_id: ext2, status: 'live' } }, as(alice))))
    expectCode(r2, 403, 'OV_SCORER_REQUIRED')
    assert.deepEqual(await rowOf(ext2), [{ status: 'live', test: false, created_by: alice }])
  })

  it('an upsert in one sport over its own test match deleted in between: the row it would insert instead is judged too', async () => {
    const rowOf = async (x) => (await raw.query('SELECT sport_type::text AS s, test, status FROM matches WHERE external_id = $1', [x])).rows
    const deleteOwn = (x, opts) => async () => okay(await q('matches', 'delete', { filters: [eq('external_id', x)] }, opts))
    // indoor-only: its beach test match, the payload says beach but not test,
    // so the insert would be a non-test beach match (test defaults to false)
    const ext = uniq('M')
    okay(await q('matches', 'insert', { data: { external_id: ext, status: 'live', sport_type: 'beach', test: true } }, asIndoor(indoor)))
    const r = await writeWithCommitBetween('matches', 'upsert', { data: { external_id: ext, status: 'ended', sport_type: 'beach' }, onConflict: 'external_id' }, asIndoor(indoor),
      deleteOwn(ext, asIndoor(indoor)))
    expectCode(r, 403, 'OV_SCORER_REQUIRED')
    assert.deepEqual(await rowOf(ext), [])
    // beach-only: its indoor test match, the payload sets neither sport nor
    // test, so the insert would be a non-test indoor match (the defaults)
    const ext2 = uniq('M')
    okay(await q('matches', 'insert', { data: { external_id: ext2, status: 'live', sport_type: 'indoor', test: true } }, asBeach(beach)))
    const r2 = await writeWithCommitBetween('matches', 'upsert', { data: { external_id: ext2, status: 'ended' }, onConflict: 'external_id' }, asBeach(beach),
      deleteOwn(ext2, asBeach(beach)))
    expectCode(r2, 403, 'OV_SCORER_REQUIRED')
    assert.deepEqual(await rowOf(ext2), [])
    // the same without a change record (no rows returned)
    const ext3 = uniq('M')
    okay(await q('matches', 'insert', { data: { external_id: ext3, status: 'live', sport_type: 'indoor', test: true } }, asBeach(beach)))
    const r3 = await writeWithCommitBetween('matches', 'upsert', { data: { external_id: ext3, status: 'ended' }, onConflict: 'external_id' }, { ...asBeach(beach), collectChanges: false },
      deleteOwn(ext3, asBeach(beach)))
    expectCode(r3, 403, 'OV_SCORER_REQUIRED')
    assert.deepEqual(await rowOf(ext3), [])

    // controls, deleted in between as well: a test row, and a row in the
    // sport the account may score in, are inserted; the change record is
    // the stored row
    const ext4 = uniq('M')
    okay(await q('matches', 'insert', { data: { external_id: ext4, status: 'live', sport_type: 'beach', test: true } }, asIndoor(indoor)))
    const r4 = await writeWithCommitBetween('matches', 'upsert', { data: { external_id: ext4, status: 'ended', sport_type: 'beach', test: true }, onConflict: 'external_id' }, asIndoor(indoor),
      deleteOwn(ext4, asIndoor(indoor)))
    okay(r4)
    assert.deepEqual(await rowOf(ext4), [{ s: 'beach', test: true, status: 'ended' }])
    assert.equal(r4.changes.length, 1)
    assert.equal(r4.changes[0].eventType, 'INSERT')
    assert.deepEqual(Object.keys(r4.changes[0].row).filter((k) => k.startsWith('__')), [])
    const ext5 = uniq('M')
    okay(await q('matches', 'insert', { data: { external_id: ext5, status: 'live', sport_type: 'indoor', test: true } }, asIndoor(indoor)))
    okay(await writeWithCommitBetween('matches', 'upsert', { data: { external_id: ext5, status: 'ended' }, onConflict: 'external_id' }, asIndoor(indoor),
      deleteOwn(ext5, asIndoor(indoor))))
    assert.deepEqual(await rowOf(ext5), [{ s: 'indoor', test: false, status: 'ended' }])
  })
})
