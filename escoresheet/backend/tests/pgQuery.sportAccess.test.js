/**
 * Roles per sport at the pgQuery / matchRestore level (db/012,
 * ~/ov-ops/openbeach-separation-tournaments-PLAN.md 1.3):
 * - opts.matchOwner.testOnlySports: an account writes non-test matches only
 *   in the sports it can score in; the sport is the ROW's (the payload of an
 *   insert, the stored match of an update, the parent match of sets, events
 *   and live state), never the calling app's;
 * - db/012's trigger keeps a match's sport fixed (409 OV_SPORT_LOCKED), so a
 *   match cannot be created in one sport and flipped to the other.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { createPgQuery } from '../lib/pgQuery.js'
import { createMatchRestore } from '../lib/matchRestore.js'
import { SKIP_PG, createTestDatabase, quietLogger } from './helpers/pgTestDb.js'

describe('pgQuery and matchRestore: scoring rights per sport', { skip: SKIP_PG }, () => {
  let tdb, db, raw, restore
  let indoor, beach, both, admin
  let seq = 0
  let gameSeq = 70000
  const uniq = (p = 'sp') => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`
  const eq = (column, value) => ({ type: 'eq', column, value })
  // what server.js matchOwnerFor() passes for each kind of account
  const asIndoor = (userId) => ({ proto: 2, matchOwner: { userId, testOnly: false, testOnlySports: ['beach'] }, actorId: userId })
  const asBeach = (userId) => ({ proto: 2, matchOwner: { userId, testOnly: false, testOnlySports: ['indoor'] }, actorId: userId })
  const asBoth = (userId) => ({ proto: 2, matchOwner: { userId, testOnly: false, testOnlySports: [] }, actorId: userId })
  const asAdmin = (userId) => ({ proto: 2, matchOwner: { userId, admin: true }, actorId: userId })
  const q = (table, action, params, opts) => db.runQuery({ table, action, params }, opts)
  const expectCode = (r, status, code) => {
    assert.equal(r.status, status, JSON.stringify(r.body))
    assert.equal(r.body.error.code, code)
  }
  const scorerRequired = (r) => expectCode(r, 403, 'OV_SCORER_REQUIRED')
  const sportLocked = (r) => expectCode(r, 409, 'OV_SPORT_LOCKED')
  const okay = (r) => assert.equal(r.status, 200, JSON.stringify(r.body))

  async function user () {
    const id = randomUUID()
    await raw.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `${id}@example.ch`])
    return id
  }
  async function matchOf (opts, extra = {}) {
    const external_id = uniq('M')
    const r = await q('matches', 'insert', { data: { external_id, status: 'live', game_n: gameSeq++, ...extra }, returning: 'id', single: true }, opts)
    okay(r)
    return { id: r.body.data.id, external_id }
  }
  const editor = (m, userId) => raw.query("INSERT INTO match_editors (match_id, user_id, granted_via) VALUES ($1, $2, 'claim')", [m.id, userId])
  const setOf = (m, n = 1) => ({ external_id: `${m.external_id}:s:${n}`, match_id: m.id, index: n })
  const eventOf = (m, n = 1) => ({ external_id: `${m.external_id}:e:${n}`, match_id: m.id, set_index: 1, type: 'point', seq: n })
  const sportOfRow = async (id) => (await raw.query('SELECT sport_type::text AS s FROM matches WHERE id = $1', [id])).rows[0].s

  before(async () => {
    tdb = await createTestDatabase('sportaccess')
    const logger = quietLogger()
    db = createPgQuery({ connectionString: tdb.url, logger })
    restore = createMatchRestore(db, { logger })
    raw = new pg.Client({ connectionString: tdb.url })
    await raw.connect()
    indoor = await user()
    beach = await user()
    both = await user()
    admin = await user()
  })

  after(async () => {
    await raw?.end()
    await db?.close()
    await tdb?.drop()
  })

  describe('inserts: the sport of the payload', () => {
    it('an indoor scorer writes indoor matches; beach only as a test match', async () => {
      await matchOf(asIndoor(indoor), { sport_type: 'indoor' })
      await matchOf(asIndoor(indoor)) // no sport_type: the column default (indoor)
      scorerRequired(await q('matches', 'insert', { data: { external_id: uniq(), game_n: gameSeq++, sport_type: 'beach' } }, asIndoor(indoor)))
      scorerRequired(await q('matches', 'insert', { data: [{ external_id: uniq(), sport_type: 'indoor' }, { external_id: uniq(), sport_type: 'beach' }] }, asIndoor(indoor)))
      const t = await matchOf(asIndoor(indoor), { sport_type: 'beach', test: true })
      assert.equal(await sportOfRow(t.id), 'beach')
    })

    it('a beach-only scorer writes beach matches; indoor only as a test match', async () => {
      const m = await matchOf(asBeach(beach), { sport_type: 'beach' })
      assert.equal(await sportOfRow(m.id), 'beach')
      scorerRequired(await q('matches', 'insert', { data: { external_id: uniq(), game_n: gameSeq++, sport_type: 'indoor' } }, asBeach(beach)))
      scorerRequired(await q('matches', 'insert', { data: { external_id: uniq(), game_n: gameSeq++ } }, asBeach(beach)), 'no sport_type is indoor')
      scorerRequired(await q('matches', 'upsert', { data: { external_id: uniq(), sport_type: 'indoor' }, onConflict: 'external_id' }, asBeach(beach)))
      await matchOf(asBeach(beach), { sport_type: 'indoor', test: true })
      assert.equal((await raw.query("SELECT count(*)::int n FROM matches WHERE created_by = $1 AND sport_type = 'indoor' AND test IS NOT TRUE", [beach])).rows[0].n, 0)
    })

    it('both roles, and the admin, write either sport', async () => {
      await matchOf(asBoth(both), { sport_type: 'beach' })
      await matchOf(asBoth(both), { sport_type: 'indoor' })
      await matchOf(asAdmin(admin), { sport_type: 'beach' })
      await matchOf(asAdmin(admin), { sport_type: 'indoor' })
    })
  })

  describe('updates and children: the sport of the stored match', () => {
    it('a beach-only editor of an indoor match cannot change it or its children', async () => {
      const m = await matchOf(asIndoor(indoor), { sport_type: 'indoor' })
      await editor(m, beach)
      okay(await q('sets', 'insert', { data: setOf(m, 1) }, asIndoor(indoor)))
      okay(await q('events', 'insert', { data: eventOf(m, 1) }, asIndoor(indoor)))
      scorerRequired(await q('matches', 'update', { data: { status: 'ended' }, filters: [eq('id', m.id)] }, asBeach(beach)))
      scorerRequired(await q('matches', 'upsert', { data: { external_id: m.external_id, status: 'ended' }, onConflict: 'external_id' }, asBeach(beach)))
      scorerRequired(await q('matches', 'delete', { filters: [eq('id', m.id)] }, asBeach(beach)))
      scorerRequired(await q('sets', 'insert', { data: setOf(m, 2) }, asBeach(beach)))
      scorerRequired(await q('events', 'upsert', { data: eventOf(m, 2), onConflict: 'external_id' }, asBeach(beach)))
      scorerRequired(await q('match_live_state', 'upsert', { data: { match_id: m.id, points_a: 1 }, onConflict: 'match_id' }, asBeach(beach)))
      scorerRequired(await q('sets', 'update', { data: { home_points: 9 }, filters: [eq('match_id', m.id)] }, asBeach(beach)))
      scorerRequired(await q('events', 'delete', { filters: [eq('match_id', m.id)] }, asBeach(beach)))
      assert.equal((await raw.query('SELECT status FROM matches WHERE id = $1', [m.id])).rows[0].status, 'live')
      // the indoor scorer, its creator, still can
      okay(await q('sets', 'update', { data: { home_points: 9 }, filters: [eq('match_id', m.id)] }, asIndoor(indoor)))
      okay(await q('matches', 'update', { data: { status: 'ended' }, filters: [eq('id', m.id)] }, asIndoor(indoor)))
    })

    it('and the reverse: an indoor-only editor of a beach match', async () => {
      const m = await matchOf(asBeach(beach), { sport_type: 'beach' })
      await editor(m, indoor)
      scorerRequired(await q('matches', 'update', { data: { status: 'ended' }, filters: [eq('id', m.id)] }, asIndoor(indoor)))
      scorerRequired(await q('sets', 'insert', { data: setOf(m, 1) }, asIndoor(indoor)))
      scorerRequired(await q('match_live_state', 'upsert', { data: { match_id: m.id, points_a: 1 }, onConflict: 'match_id' }, asIndoor(indoor)))
      okay(await q('sets', 'insert', { data: setOf(m, 1) }, asBeach(beach)))
      okay(await q('events', 'insert', { data: eventOf(m, 1) }, asBeach(beach)))
      okay(await q('match_live_state', 'upsert', { data: { match_id: m.id, points_a: 1 }, onConflict: 'match_id' }, asBeach(beach)))
    })

    it('an indoor scorer can update its own indoor rows and children (unchanged)', async () => {
      const m = await matchOf(asIndoor(indoor))
      okay(await q('sets', 'upsert', { data: setOf(m, 1), onConflict: 'external_id' }, asIndoor(indoor)))
      okay(await q('match_live_state', 'upsert', { data: { match_id: m.id, points_a: 3 }, onConflict: 'match_id' }, asIndoor(indoor)))
      okay(await q('matches', 'upsert', { data: { external_id: m.external_id, status: 'ended', sport_type: 'indoor' }, onConflict: 'external_id' }, asIndoor(indoor)))
      okay(await q('events', 'delete', { filters: [eq('match_id', m.id)] }, asIndoor(indoor)))
    })

    it('test:false is refused only in a sport the account cannot score in', async () => {
      const tb = await matchOf(asBeach(beach), { sport_type: 'beach', test: true })
      okay(await q('matches', 'update', { data: { test: false }, filters: [eq('id', tb.id)] }, asBeach(beach)))
      const ti = await matchOf(asBeach(beach), { sport_type: 'indoor', test: true })
      scorerRequired(await q('matches', 'update', { data: { test: false }, filters: [eq('id', ti.id)] }, asBeach(beach)))
      scorerRequired(await q('matches', 'update', { data: { test: null }, filters: [{ type: 'in', column: 'id', value: [tb.id, ti.id] }] }, asBeach(beach)))
      assert.equal((await raw.query('SELECT test FROM matches WHERE id = $1', [ti.id])).rows[0].test, true)
      // its own indoor test match stays writable as a test match
      okay(await q('matches', 'update', { data: { status: 'ended', test: true }, filters: [eq('id', ti.id)] }, asBeach(beach)))
      okay(await q('sets', 'insert', { data: setOf(ti, 1) }, asBeach(beach)))
    })
  })

  describe('the sport of a match is fixed (db/012)', () => {
    it('an indoor match cannot become beach, by update or upsert, for anyone', async () => {
      const m = await matchOf(asIndoor(indoor), { sport_type: 'indoor' })
      sportLocked(await q('matches', 'update', { data: { sport_type: 'beach' }, filters: [eq('id', m.id)] }, asIndoor(indoor)))
      // the payload row is a non-test beach match: refused before the lock is reached
      scorerRequired(await q('matches', 'upsert', { data: { external_id: m.external_id, sport_type: 'beach' }, onConflict: 'external_id' }, asIndoor(indoor)))
      sportLocked(await q('matches', 'upsert', { data: { external_id: m.external_id, sport_type: 'beach' }, onConflict: 'external_id' }, asAdmin(admin)))
      sportLocked(await q('matches', 'update', { data: { sport_type: 'beach' }, filters: [eq('id', m.id)] }, asAdmin(admin)))
      sportLocked(await q('matches', 'update', { data: { sport_type: 'beach' }, filters: [eq('id', m.id)] }, { internal: true }))
      assert.equal(await sportOfRow(m.id), 'indoor')
    })

    it('a beach test match of an indoor scorer cannot be flipped to indoor to escape the test flag', async () => {
      const t = await matchOf(asIndoor(indoor), { sport_type: 'beach', test: true })
      sportLocked(await q('matches', 'update', { data: { sport_type: 'indoor' }, filters: [eq('id', t.id)] }, asIndoor(indoor)))
      sportLocked(await q('matches', 'upsert', { data: { external_id: t.external_id, sport_type: 'indoor', test: false }, onConflict: 'external_id' }, asIndoor(indoor)))
      assert.deepEqual((await raw.query('SELECT sport_type::text AS s, test FROM matches WHERE id = $1', [t.id])).rows[0], { s: 'beach', test: true })
    })

    it('an upsert that leaves out sport_type is judged by the STORED sport (S1 review)', async () => {
      const row = async (id) => (await raw.query('SELECT sport_type::text AS s, test, closed_at FROM matches WHERE id = $1', [id])).rows[0]
      // an indoor-only scorer's beach test match: the payload looks indoor, the row is beach
      const t = await matchOf(asIndoor(indoor), { sport_type: 'beach', test: true })
      scorerRequired(await q('matches', 'upsert', { data: { external_id: t.external_id, test: false, status: 'final' }, onConflict: 'external_id' }, asIndoor(indoor)))
      scorerRequired(await q('matches', 'upsert', { data: { external_id: t.external_id, test: null }, onConflict: 'external_id' }, asIndoor(indoor)))
      // another row names a sport: this one writes NULL (indoor) over beach, the lock refuses it
      sportLocked(await q('matches', 'upsert', { data: [{ external_id: uniq(), sport_type: 'indoor' }, { external_id: t.external_id, test: false }], onConflict: 'external_id' }, asIndoor(indoor)))
      const after = await row(t.id)
      assert.equal(after.s, 'beach')
      assert.equal(after.test, true)
      assert.equal(after.closed_at, null)
      // it stays writable as a test match (test kept, or set to true)
      okay(await q('matches', 'upsert', { data: { external_id: t.external_id, status: 'ended' }, onConflict: 'external_id' }, asIndoor(indoor)))
      okay(await q('matches', 'upsert', { data: { external_id: t.external_id, status: 'ended', test: true }, onConflict: 'external_id' }, asIndoor(indoor)))
      assert.equal((await row(t.id)).test, true)
      // the beach game number is still free for a beach scorer
      okay(await q('matches', 'insert', { data: { external_id: uniq(), sport_type: 'beach', game_n: (await raw.query('SELECT game_n FROM matches WHERE id = $1', [t.id])).rows[0].game_n } }, asBeach(beach)))

      // the reverse: a beach-only scorer's indoor test match (a payload sport of 'beach' hits the lock)
      const ti = await matchOf(asBeach(beach), { sport_type: 'indoor', test: true })
      sportLocked(await q('matches', 'upsert', { data: { external_id: ti.external_id, sport_type: 'beach', test: false }, onConflict: 'external_id' }, asBeach(beach)))
      scorerRequired(await q('matches', 'upsert', { data: { external_id: ti.external_id, test: false }, onConflict: 'external_id' }, asBeach(beach)))
      assert.deepEqual(await row(ti.id), { s: 'indoor', test: true, closed_at: null })
      okay(await q('matches', 'upsert', { data: { external_id: ti.external_id, status: 'ended' }, onConflict: 'external_id' }, asBeach(beach)))
      // and its own beach match needs no sport_type in an upsert (the stored sport counts)
      const bm = await matchOf(asBeach(beach), { sport_type: 'beach' })
      okay(await q('matches', 'upsert', { data: { external_id: bm.external_id, status: 'ended' }, onConflict: 'external_id' }, asBeach(beach)))
      // a NEW row without sport_type is still indoor
      scorerRequired(await q('matches', 'upsert', { data: { external_id: uniq(), game_n: gameSeq++, status: 'live' }, onConflict: 'external_id' }, asBeach(beach)))

      // an official match of the test-only sport is not taken over by test: true either
      const official = await matchOf(asBeach(beach), { sport_type: 'beach' })
      await editor(official, indoor)
      scorerRequired(await q('matches', 'upsert', { data: { external_id: official.external_id, test: true }, onConflict: 'external_id' }, asIndoor(indoor)))
      assert.equal((await row(official.id)).test, false)

      // unchanged: the sports the account scores in
      const own = await matchOf(asIndoor(indoor), { sport_type: 'indoor', test: true })
      okay(await q('matches', 'upsert', { data: { external_id: own.external_id, test: false }, onConflict: 'external_id' }, asIndoor(indoor)))
      const bt = await matchOf(asBeach(beach), { sport_type: 'beach', test: true })
      okay(await q('matches', 'upsert', { data: { external_id: bt.external_id, test: false }, onConflict: 'external_id' }, asBeach(beach)))
    })

    it('NULL and indoor are the same sport; rewriting the same sport is fine', async () => {
      const m = await matchOf(asIndoor(indoor))
      await raw.query('UPDATE matches SET sport_type = NULL WHERE id = $1', [m.id]) // a legacy row
      okay(await q('matches', 'update', { data: { sport_type: 'indoor' }, filters: [eq('id', m.id)] }, asIndoor(indoor)))
      okay(await q('matches', 'update', { data: { sport_type: 'indoor' }, filters: [eq('id', m.id)] }, asIndoor(indoor)))
      const b = await matchOf(asBeach(beach), { sport_type: 'beach' })
      okay(await q('matches', 'upsert', { data: { external_id: b.external_id, sport_type: 'beach', status: 'ended' }, onConflict: 'external_id' }, asBeach(beach)))
    })
  })

  describe('matchRestore', () => {
    const backup = (external_id, match = {}) => ({
      match: { external_id, status: 'ended', game_n: gameSeq++, ...match },
      sets: [{ external_id: `${external_id}:s:1`, index: 1, home_points: 25, away_points: 20, finished: true }],
      events: [{ external_id: `${external_id}:e:1`, set_index: 1, type: 'point', seq: 1 }]
    })

    it('restores only in the sports the account can score in (or as a test match)', async () => {
      scorerRequired(await restore.restoreMatch(backup(uniq('R'), { sport_type: 'indoor' }), asBeach(beach)))
      scorerRequired(await restore.restoreMatch(backup(uniq('R')), asBeach(beach)))
      okay(await restore.restoreMatch(backup(uniq('R'), { sport_type: 'beach' }), asBeach(beach)))
      okay(await restore.restoreMatch(backup(uniq('R'), { sport_type: 'indoor', test: true }), asBeach(beach)))
      scorerRequired(await restore.restoreMatch(backup(uniq('R'), { sport_type: 'beach' }), asIndoor(indoor)))
      okay(await restore.restoreMatch(backup(uniq('R'), { sport_type: 'indoor' }), asIndoor(indoor)))
    })

    it('a backup without sport_type is judged by the STORED sport (S1 review)', async () => {
      // an indoor-only scorer: its beach test match cannot become official
      const ext = uniq('R')
      okay(await restore.restoreMatch(backup(ext, { sport_type: 'beach', test: true }), asIndoor(indoor)))
      scorerRequired(await restore.restoreMatch(backup(ext, { test: false }), asIndoor(indoor)))
      scorerRequired(await restore.restoreMatch(backup(ext, { test: false, status: 'final' }), asIndoor(indoor)))
      const stored = (await raw.query('SELECT sport_type::text AS s, test, closed_at FROM matches WHERE external_id = $1', [ext])).rows[0]
      assert.deepEqual(stored, { s: 'beach', test: true, closed_at: null })
      okay(await restore.restoreMatch(backup(ext, { test: true }), asIndoor(indoor)))
      // the reverse: a beach-only scorer's indoor test match
      const exti = uniq('R')
      okay(await restore.restoreMatch(backup(exti, { sport_type: 'indoor', test: true }), asBeach(beach)))
      assert.equal((await restore.restoreMatch(backup(exti, { sport_type: 'beach', test: false }), asBeach(beach))).status, 409, 'the sport lock')
      scorerRequired(await restore.restoreMatch(backup(exti, { test: false }), asBeach(beach)))
      assert.equal((await raw.query('SELECT test FROM matches WHERE external_id = $1', [exti])).rows[0].test, true)
      // its own sport: unchanged
      const extb = uniq('R')
      okay(await restore.restoreMatch(backup(extb, { sport_type: 'beach', test: true }), asBeach(beach)))
      okay(await restore.restoreMatch(backup(extb, { test: false }), asBeach(beach)))
    })

    it('a backup cannot change the sport of a stored match', async () => {
      const ext = uniq('R')
      okay(await restore.restoreMatch(backup(ext, { sport_type: 'beach', test: true }), asIndoor(indoor)))
      const r = await restore.restoreMatch(backup(ext, { sport_type: 'indoor' }), asIndoor(indoor))
      assert.equal(r.status, 409, JSON.stringify(r.body))
      assert.equal((await raw.query('SELECT sport_type::text AS s FROM matches WHERE external_id = $1', [ext])).rows[0].s, 'beach')
    })
  })
})
