/**
 * Match ownership guard of lib/pgQuery.js (opts.matchOwner) on a real
 * Postgres: matches.created_by is set by the server, writes to a match (and
 * its sets, events and live state) need its creator or an editor
 * (match_editors), legacy rows without an owner are read-only.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { createPgQuery } from '../lib/pgQuery.js'
import { SKIP_PG, createTestDatabase, quietLogger } from './helpers/pgTestDb.js'

describe('pgQuery match ownership', { skip: SKIP_PG }, () => {
  let tdb, db, raw
  let alice, bob, carol
  let seq = 0
  const uniq = (p = 'own') => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`
  const eq = (column, value) => ({ type: 'eq', column, value })
  const as = (userId) => ({ proto: 2, matchOwner: { userId } })
  const q = (table, action, params, opts) => db.runQuery({ table, action, params }, opts)
  const assertNotOwner = (r) => {
    assert.equal(r.status, 403, JSON.stringify(r.body))
    assert.equal(r.body.error.code, 'OV_NOT_MATCH_OWNER')
  }

  async function user () {
    const id = randomUUID()
    await raw.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `${id}@example.ch`])
    return id
  }

  async function matchOf (owner, extra = {}) {
    const external_id = uniq('M')
    const r = await q('matches', 'upsert', { data: { external_id, status: 'live', ...extra }, onConflict: 'external_id', returning: 'id, created_by', single: true }, as(owner))
    assert.equal(r.status, 200, JSON.stringify(r.body))
    return { id: r.body.data.id, external_id, createdBy: r.body.data.created_by }
  }

  before(async () => {
    tdb = await createTestDatabase('ownership')
    db = createPgQuery({ connectionString: tdb.url, logger: quietLogger() })
    raw = new pg.Client({ connectionString: tdb.url })
    await raw.connect()
    alice = await user()
    bob = await user()
    carol = await user()
  })

  after(async () => {
    await raw?.end()
    await db?.close()
    await tdb?.drop()
  })

  it('records the caller as creator on insert, whatever created_by the client sent', async () => {
    const m = await matchOf(alice, { created_by: bob })
    assert.equal(m.createdBy, alice)
    const r = await q('matches', 'insert', { data: { external_id: uniq('I'), created_by: carol }, returning: 'created_by', single: true }, as(bob))
    assert.equal(r.status, 200)
    assert.equal(r.body.data.created_by, bob)
  })

  it('the creator may update, upsert and delete; created_by never changes', async () => {
    const m = await matchOf(alice)
    let r = await q('matches', 'update', { data: { status: 'final' }, filters: [eq('external_id', m.external_id)] }, as(alice))
    assert.equal(r.status, 200, JSON.stringify(r.body))
    r = await q('matches', 'upsert', { data: { external_id: m.external_id, status: 'live' }, onConflict: 'external_id' }, as(alice))
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const row = (await raw.query('SELECT status, created_by FROM matches WHERE id = $1', [m.id])).rows[0]
    assert.deepEqual(row, { status: 'live', created_by: alice })
    r = await q('matches', 'update', { data: { created_by: bob }, filters: [eq('id', m.id)] }, as(alice))
    assert.equal(r.status, 400)
    r = await q('matches', 'delete', { filters: [eq('id', m.id)] }, as(alice))
    assert.equal(r.status, 200)
    assert.equal((await raw.query('SELECT 1 FROM matches WHERE id = $1', [m.id])).rowCount, 0)
  })

  it('a stranger gets 403 for update, upsert and delete, and nothing changes', async () => {
    const m = await matchOf(alice, { status: 'setup' })
    assertNotOwner(await q('matches', 'update', { data: { status: 'final' }, filters: [eq('external_id', m.external_id)] }, as(bob)))
    assertNotOwner(await q('matches', 'upsert', { data: { external_id: m.external_id, status: 'final' }, onConflict: 'external_id' }, as(bob)))
    assertNotOwner(await q('matches', 'upsert', { data: [{ external_id: uniq('new'), status: 'x' }, { external_id: m.external_id, status: 'final' }], onConflict: 'external_id' }, as(bob)))
    assertNotOwner(await q('matches', 'delete', { filters: [eq('id', m.id)] }, as(bob)))
    // A filter that matches the stranger's own row AND someone else's: all refused
    const own = await matchOf(bob)
    assertNotOwner(await q('matches', 'update', { data: { status: 'final' }, filters: [{ type: 'in', column: 'id', value: [own.id, m.id] }] }, as(bob)))
    const rows = (await raw.query('SELECT id, status, created_by FROM matches WHERE id = ANY($1)', [[m.id, own.id]])).rows
    assert.equal(rows.find(r => r.id === m.id).status, 'setup')
    assert.equal(rows.find(r => r.id === own.id).status, 'live')
    // the refused batch upsert inserted nothing either
    assert.equal(rows.length, 2)
  })

  it('a stranger cannot write sets, events or the live state of the match', async () => {
    const m = await matchOf(alice)
    const set = { external_id: `${m.external_id}:s:1`, match_id: m.id, index: 1, home_points: 1 }
    assertNotOwner(await q('sets', 'insert', { data: set }, as(bob)))
    assertNotOwner(await q('events', 'upsert', { data: { external_id: `${m.external_id}:e:1`, match_id: m.id, type: 'point' }, onConflict: 'external_id' }, as(bob)))
    assertNotOwner(await q('match_live_state', 'upsert', { data: { match_id: m.id, points_a: 25 }, onConflict: 'match_id' }, as(bob)))
    // the owner's rows, then the stranger's update/delete of them
    assert.equal((await q('sets', 'insert', { data: set }, as(alice))).status, 200)
    assert.equal((await q('match_live_state', 'upsert', { data: { match_id: m.id, points_a: 3 }, onConflict: 'match_id' }, as(alice))).status, 200)
    assertNotOwner(await q('sets', 'update', { data: { home_points: 99 }, filters: [eq('match_id', m.id)] }, as(bob)))
    assertNotOwner(await q('sets', 'delete', { filters: [eq('external_id', set.external_id)] }, as(bob)))
    assertNotOwner(await q('match_live_state', 'update', { data: { points_a: 99 }, filters: [eq('match_id', m.id)] }, as(bob)))
    assertNotOwner(await q('match_live_state', 'delete', { filters: [eq('match_id', m.id)] }, as(bob)))
    const s = (await raw.query('SELECT home_points FROM sets WHERE match_id = $1', [m.id])).rows
    assert.deepEqual(s, [{ home_points: 1 }])
    const l = (await raw.query('SELECT points_a FROM match_live_state WHERE match_id = $1', [m.id])).rows
    assert.deepEqual(l, [{ points_a: 3 }])
  })

  it('a child row cannot be moved to, or created for, a match the caller does not own', async () => {
    const mine = await matchOf(bob)
    const theirs = await matchOf(alice)
    assert.equal((await q('match_live_state', 'insert', { data: { match_id: mine.id } }, as(bob))).status, 200)
    assertNotOwner(await q('match_live_state', 'update', { data: { match_id: theirs.id }, filters: [eq('match_id', mine.id)] }, as(bob)))
    assertNotOwner(await q('match_live_state', 'insert', { data: { match_id: null } }, as(bob)))
    assertNotOwner(await q('match_live_state', 'insert', { data: { match_id: randomUUID() } }, as(bob)))
  })

  it('an editor (match_editors) may write; the creator stays the creator', async () => {
    const m = await matchOf(alice)
    assertNotOwner(await q('matches', 'update', { data: { status: 'final' }, filters: [eq('id', m.id)] }, as(carol)))
    await raw.query('INSERT INTO match_editors (match_id, user_id) VALUES ($1, $2)', [m.id, carol])
    let r = await q('matches', 'upsert', { data: { external_id: m.external_id, status: 'final' }, onConflict: 'external_id', returning: 'created_by', single: true }, as(carol))
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.data.created_by, alice)
    r = await q('sets', 'insert', { data: { external_id: `${m.external_id}:s:1`, match_id: m.id, index: 1 } }, as(carol))
    assert.equal(r.status, 200, JSON.stringify(r.body))
  })

  it('a legacy row without an owner is read-only for everyone (admins skip the guard)', async () => {
    const ext = uniq('L')
    const { rows: [{ id }] } = await raw.query("INSERT INTO matches (external_id, status) VALUES ($1, 'live') RETURNING id", [ext])
    for (const u of [alice, bob]) {
      assertNotOwner(await q('matches', 'update', { data: { status: 'final' }, filters: [eq('id', id)] }, as(u)))
      assertNotOwner(await q('matches', 'upsert', { data: { external_id: ext, status: 'final' }, onConflict: 'external_id' }, as(u)))
      assertNotOwner(await q('sets', 'insert', { data: { external_id: `${ext}:s:1`, match_id: id, index: 1 } }, as(u)))
    }
    const read = await q('matches', 'select', { columns: 'id,status', filters: [eq('id', id)] }, {})
    assert.deepEqual(read.body.data, [{ id, status: 'live' }])
    // no matchOwner (an admin, or trusted server code): unguarded
    const admin = await q('matches', 'update', { data: { status: 'final' }, filters: [eq('id', id)] }, { proto: 2 })
    assert.equal(admin.status, 200)
  })

  it('an admin writes any match unchecked, and a match it creates records it as creator', async () => {
    const admin = { proto: 2, matchOwner: { userId: carol, admin: true } }
    const theirs = await matchOf(alice)
    assert.equal((await q('matches', 'update', { data: { status: 'final' }, filters: [eq('id', theirs.id)] }, admin)).status, 200)
    assert.equal((await q('sets', 'insert', { data: { external_id: `${theirs.external_id}:s:1`, match_id: theirs.id, index: 1 } }, admin)).status, 200)
    const r = await q('matches', 'upsert', { data: { external_id: theirs.external_id, status: 'live' }, onConflict: 'external_id', returning: 'created_by', single: true }, admin)
    assert.equal(r.body.data.created_by, alice, 'the creator stays')
    const created = await q('matches', 'insert', { data: { external_id: uniq('A') }, returning: 'created_by', single: true }, admin)
    assert.equal(created.body.data.created_by, carol)
    assert.equal((await q('matches', 'update', { data: { created_by: bob }, filters: [eq('id', theirs.id)] }, admin)).status, 400)
  })

  it('readOwner marks every selected row with __owned; restrict matches owned rows only', async () => {
    const mine = await matchOf(alice, { status: 'setup' })
    const theirs = await matchOf(bob, { status: 'setup' })
    await raw.query('INSERT INTO match_editors (match_id, user_id) VALUES ($1, $2)', [theirs.id, carol])
    const ids = [mine.id, theirs.id]
    const sel = (userId, params = {}, restrict = false) => q('matches', 'select', { columns: 'external_id', filters: [{ type: 'in', column: 'id', value: ids }], order: [{ column: 'external_id' }], ...params }, { readOwner: { userId, restrict } })
    const owned = (r) => Object.fromEntries(r.body.data.map((x) => [x.external_id, x.__owned]))
    assert.deepEqual(owned(await sel(alice)), { [mine.external_id]: true, [theirs.external_id]: false })
    assert.deepEqual(owned(await sel(carol)), { [mine.external_id]: false, [theirs.external_id]: true }, 'an editor owns')
    const restricted = await sel(alice, { count: true }, true)
    assert.deepEqual(restricted.body.data.map((x) => x.external_id), [mine.external_id])
    assert.equal(restricted.body.count, 1)
    // children: by their match
    await raw.query("INSERT INTO events (external_id, match_id, type) VALUES ($1, $2, 'point'), ($3, $4, 'point')", [`${mine.external_id}:e:1`, mine.id, `${theirs.external_id}:e:1`, theirs.id])
    const ev = await q('events', 'select', { columns: 'external_id', filters: [{ type: 'in', column: 'match_id', value: ids }], order: [{ column: 'external_id' }] }, { readOwner: { userId: alice } })
    assert.deepEqual(Object.fromEntries(ev.body.data.map((x) => [x.external_id, x.__owned])), { [`${mine.external_id}:e:1`]: true, [`${theirs.external_id}:e:1`]: false })
    // a bad user id owns nothing; other tables are not marked
    assert.deepEqual(Object.values(owned(await sel('nope'))), [false, false])
    const prof = await q('profiles', 'select', { columns: '*', limit: 1 }, { readOwner: { userId: alice } })
    assert.equal(prof.status, 200)
    assert.equal(prof.body.data.some((x) => '__owned' in x), false)
  })

  it('a bad user id never writes unguarded', async () => {
    assertNotOwner(await q('matches', 'insert', { data: { external_id: uniq('B') } }, { proto: 2, matchOwner: { userId: 'not-a-uuid' } }))
  })

  it('refuses (503, retryable) instead of writing unguarded when db/005 has not run', async () => {
    const t2 = await createTestDatabase('ownership_nomig', { schemaSql: '' })
    const c = new pg.Client({ connectionString: t2.url })
    await c.connect()
    const db2 = createPgQuery({ connectionString: t2.url, logger: quietLogger() })
    try {
      await c.query('CREATE TABLE public.matches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), external_id text UNIQUE, status text)')
      const r = await db2.runQuery({ table: 'matches', action: 'insert', params: { data: { external_id: 'x' } } }, as(alice))
      assert.equal(r.status, 503)
      assert.equal(r.body.error.code, 'OV_OWNERSHIP_UNAVAILABLE')
      assert.equal(r.body.error.retryable, true)
      assert.equal((await c.query('SELECT count(*)::int AS n FROM matches')).rows[0].n, 0)
    } finally {
      await c.end()
      await db2.close()
      await t2.drop()
    }
  })

  it('tables other than matches and its children are not affected', async () => {
    const r = await q('referee_database', 'insert', { data: { first_name: 'A' } }, as(bob))
    assert.equal(r.status, 200, JSON.stringify(r.body))
  })
})
