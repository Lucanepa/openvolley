/**
 * Approved scorers only, server-locked closing and one cloud match per
 * official game, at the pgQuery / matchRestore level (db/007,
 * docs/scorer-accounts-spec.md 4.2 and 4.3):
 * - opts.matchOwner.testOnly: an account that is not an approved scorer may
 *   write test matches and their children only (403 OV_SCORER_REQUIRED);
 * - opts.actorId reaches the closing trigger as closed_by;
 * - the closed lock (SQLSTATE OVC01) is 409 OV_MATCH_CLOSED, the official-game
 *   index 409 OV_GAME_TAKEN, both without details.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { createPgQuery } from '../lib/pgQuery.js'
import { createMatchRestore } from '../lib/matchRestore.js'
import { SKIP_PG, createTestDatabase, quietLogger } from './helpers/pgTestDb.js'

describe('pgQuery and matchRestore: scorer access, closing, official games', { skip: SKIP_PG }, () => {
  let tdb, db, raw, restore
  let pending, scorer, other, admin
  let seq = 0
  let gameSeq = 60000
  const uniq = (p = 'sa') => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`
  const eq = (column, value) => ({ type: 'eq', column, value })
  const asPending = (userId) => ({ proto: 2, matchOwner: { userId, testOnly: true }, actorId: userId })
  const asScorer = (userId) => ({ proto: 2, matchOwner: { userId, testOnly: false }, actorId: userId })
  const asAdmin = (userId) => ({ proto: 2, matchOwner: { userId, admin: true, testOnly: true }, actorId: userId })
  const q = (table, action, params, opts) => db.runQuery({ table, action, params }, opts)
  const expectCode = (r, status, code) => {
    assert.equal(r.status, status, JSON.stringify(r.body))
    assert.equal(r.body.error.code, code)
  }
  const scorerRequired = (r) => expectCode(r, 403, 'OV_SCORER_REQUIRED')

  async function user () {
    const id = randomUUID()
    await raw.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `${id}@example.ch`])
    return id
  }
  async function matchOf (opts, extra = {}) {
    const external_id = uniq('M')
    const r = await q('matches', 'insert', { data: { external_id, status: 'live', game_n: gameSeq++, ...extra }, returning: 'id', single: true }, opts)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    return { id: r.body.data.id, external_id }
  }
  const setOf = (m, n = 1) => ({ external_id: `${m.external_id}:s:${n}`, match_id: m.id, index: n })
  const eventOf = (m, n = 1) => ({ external_id: `${m.external_id}:e:${n}`, match_id: m.id, set_index: 1, type: 'point', seq: n })

  before(async () => {
    tdb = await createTestDatabase('scoreraccess')
    const logger = quietLogger()
    db = createPgQuery({ connectionString: tdb.url, logger })
    restore = createMatchRestore(db, { logger })
    raw = new pg.Client({ connectionString: tdb.url })
    await raw.connect()
    pending = await user()
    scorer = await user()
    other = await user()
    admin = await user()
  })

  after(async () => {
    await raw?.end()
    await db?.close()
    await tdb?.drop()
  })

  describe('testOnly (not an approved scorer)', () => {
    it('inserts only test matches; children of a test match are fine', async () => {
      scorerRequired(await q('matches', 'insert', { data: { external_id: uniq(), game_n: gameSeq++, test: false } }, asPending(pending)))
      scorerRequired(await q('matches', 'insert', { data: { external_id: uniq() } }, asPending(pending)), 'test missing')
      scorerRequired(await q('matches', 'insert', { data: [{ external_id: uniq(), test: true }, { external_id: uniq(), test: 'true' }] }, asPending(pending)))
      assert.equal((await raw.query('SELECT count(*)::int n FROM matches WHERE created_by = $1', [pending])).rows[0].n, 0)

      const m = await matchOf(asPending(pending), { test: true, status: 'setup' })
      assert.equal((await q('sets', 'insert', { data: setOf(m) }, asPending(pending))).status, 200)
      assert.equal((await q('events', 'upsert', { data: eventOf(m), onConflict: 'external_id' }, asPending(pending))).status, 200)
      assert.equal((await q('match_live_state', 'upsert', { data: { match_id: m.id, points_a: 1 }, onConflict: 'match_id' }, asPending(pending))).status, 200)
      assert.equal((await q('matches', 'update', { data: { status: 'final', test: true }, filters: [eq('id', m.id)] }, asPending(pending))).status, 200)
      assert.equal((await q('sets', 'update', { data: { home_points: 3 }, filters: [eq('match_id', m.id)] }, asPending(pending))).status, 200)
      assert.equal((await q('events', 'delete', { filters: [eq('match_id', m.id)] }, asPending(pending))).status, 200)
      assert.equal((await q('matches', 'delete', { filters: [eq('id', m.id)] }, asPending(pending))).status, 200)
    })

    it('an upsert cannot turn an existing non-test match into a test match', async () => {
      const m = await matchOf(asScorer(scorer))
      // the pending account is even made an editor: still refused, for the approval
      await raw.query("INSERT INTO match_editors (match_id, user_id, granted_via) VALUES ($1, $2, 'claim')", [m.id, pending])
      scorerRequired(await q('matches', 'upsert', { data: { external_id: m.external_id, test: true, status: 'setup' }, onConflict: 'external_id' }, asPending(pending)))
      assert.equal((await raw.query('SELECT test, status FROM matches WHERE id = $1', [m.id])).rows[0].status, 'live')
    })

    it('update and delete of a non-test match, and setting test:false, are refused', async () => {
      const t = await matchOf(asPending(pending), { test: true })
      scorerRequired(await q('matches', 'update', { data: { test: false }, filters: [eq('id', t.id)] }, asPending(pending)))
      scorerRequired(await q('matches', 'update', { data: { test: null }, filters: [eq('id', t.id)] }, asPending(pending)))
      const m = await matchOf(asScorer(scorer))
      await raw.query("INSERT INTO match_editors (match_id, user_id, granted_via) VALUES ($1, $2, 'claim')", [m.id, pending])
      scorerRequired(await q('matches', 'update', { data: { status: 'ended' }, filters: [eq('id', m.id)] }, asPending(pending)))
      scorerRequired(await q('matches', 'update', { data: { status: 'ended' }, filters: [{ type: 'in', column: 'id', value: [t.id, m.id] }] }, asPending(pending)))
      scorerRequired(await q('matches', 'delete', { filters: [eq('id', m.id)] }, asPending(pending)))
    })

    it('children of a non-test match: insert, upsert, update, delete and moving match_id are refused', async () => {
      const m = await matchOf(asScorer(scorer))
      await raw.query("INSERT INTO match_editors (match_id, user_id, granted_via) VALUES ($1, $2, 'claim')", [m.id, pending])
      assert.equal((await q('sets', 'insert', { data: setOf(m, 1) }, asScorer(scorer))).status, 200)
      assert.equal((await q('events', 'insert', { data: eventOf(m, 1) }, asScorer(scorer))).status, 200)
      scorerRequired(await q('sets', 'insert', { data: setOf(m, 2) }, asPending(pending)))
      scorerRequired(await q('events', 'upsert', { data: eventOf(m, 2), onConflict: 'external_id' }, asPending(pending)))
      scorerRequired(await q('match_live_state', 'upsert', { data: { match_id: m.id, points_a: 1 }, onConflict: 'match_id' }, asPending(pending)))
      scorerRequired(await q('sets', 'update', { data: { home_points: 9 }, filters: [eq('match_id', m.id)] }, asPending(pending)))
      scorerRequired(await q('events', 'delete', { filters: [eq('match_id', m.id)] }, asPending(pending)))
      // moving a set of a test match into the non-test match
      const t = await matchOf(asPending(pending), { test: true })
      assert.equal((await q('sets', 'insert', { data: setOf(t, 1) }, asPending(pending))).status, 200)
      scorerRequired(await q('sets', 'update', { data: { match_id: m.id }, filters: [eq('match_id', t.id)] }, asPending(pending)))
      assert.equal((await raw.query('SELECT count(*)::int n FROM sets WHERE match_id = $1', [m.id])).rows[0].n, 1)
    })

    it('a live-state upsert on its id cannot move another match\'s row into a test match', async () => {
      // review: a pending PIN holder (editor of N) upserted {id: L.id, match_id: T}
      const n = await matchOf(asScorer(scorer))
      const r0 = await q('match_live_state', 'upsert', { data: { match_id: n.id, points_a: 7 }, onConflict: 'match_id', returning: 'id', single: true }, asScorer(scorer))
      assert.equal(r0.status, 200, JSON.stringify(r0.body))
      const liveId = r0.body.data.id
      await raw.query("INSERT INTO match_editors (match_id, user_id, granted_via) VALUES ($1, $2, 'claim')", [n.id, pending])
      const t = await matchOf(asPending(pending), { test: true })
      const r = await q('match_live_state', 'upsert', { data: { id: liveId, match_id: t.id, points_a: 0, points_b: 25 } }, asPending(pending))
      assert.equal(r.status, 403, JSON.stringify(r.body))
      // an approved scorer owning both matches cannot move it either
      const s2 = await matchOf(asScorer(scorer))
      const r2 = await q('match_live_state', 'upsert', { data: { id: liveId, match_id: s2.id, points_a: 1 } }, asScorer(scorer))
      assert.equal(r2.status, 403, JSON.stringify(r2.body))
      const { rows: [row] } = await raw.query('SELECT match_id, points_a, points_b FROM match_live_state WHERE id = $1', [liveId])
      assert.deepEqual({ match_id: row.match_id, points_a: row.points_a }, { match_id: n.id, points_a: 7 })
      // the normal per-match upsert (on match_id) of a scorer still works
      assert.equal((await q('match_live_state', 'upsert', { data: { match_id: n.id, points_a: 8 }, onConflict: 'match_id' }, asScorer(scorer))).status, 200)
    })

    it('an approved scorer and an admin are not limited to test matches', async () => {
      await matchOf(asScorer(scorer))
      const a = await matchOf(asAdmin(admin))
      assert.equal((await raw.query('SELECT created_by FROM matches WHERE id = $1', [a.id])).rows[0].created_by, admin)
    })
  })

  describe('closing', () => {
    it('the closing write records closed_at and closed_by (actorId), and the audit entry', async () => {
      const m = await matchOf(asScorer(scorer))
      const r = await q('matches', 'update', { data: { status: 'approved', closed_at: '2001-01-01T00:00:00Z' }, filters: [eq('id', m.id)], returning: 'closed_at, closed_by', single: true }, asScorer(scorer))
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.equal(r.body.data.closed_by, scorer)
      assert.ok(Date.now() - new Date(r.body.data.closed_at).getTime() < 60000, 'the server stamps closed_at')
      const { rows } = await raw.query("SELECT actor_id, details FROM audit_log WHERE action = 'match.close' AND match_id = $1", [m.id])
      assert.equal(rows.length, 1)
      assert.equal(rows[0].actor_id, scorer)
    })

    it('a closed match, its sets and events refuse writes with 409 OV_MATCH_CLOSED; approved -> final passes', async () => {
      const m = await matchOf(asScorer(scorer))
      assert.equal((await q('sets', 'insert', { data: setOf(m, 1) }, asScorer(scorer))).status, 200)
      assert.equal((await q('match_live_state', 'upsert', { data: { match_id: m.id, points_a: 1 }, onConflict: 'match_id' }, asScorer(scorer))).status, 200)
      assert.equal((await q('matches', 'update', { data: { status: 'approved' }, filters: [eq('id', m.id)] }, asScorer(scorer))).status, 200)
      const closed = (r) => {
        expectCode(r, 409, 'OV_MATCH_CLOSED')
        assert.equal(r.body.error.details, undefined)
        assert.equal(r.body.error.retryable, undefined)
      }
      closed(await q('sets', 'insert', { data: setOf(m, 2) }, asScorer(scorer)))
      closed(await q('sets', 'update', { data: { home_points: 1 }, filters: [eq('match_id', m.id)] }, asScorer(scorer)))
      closed(await q('events', 'upsert', { data: eventOf(m, 1), onConflict: 'external_id' }, asScorer(scorer)))
      closed(await q('matches', 'update', { data: { status: 'ended' }, filters: [eq('id', m.id)] }, asScorer(scorer)))
      closed(await q('matches', 'update', { data: { home_team: { name: 'X' } }, filters: [eq('id', m.id)] }, asAdmin(admin)))
      closed(await q('matches', 'delete', { filters: [eq('id', m.id)] }, asAdmin(admin)))
      assert.equal((await q('matches', 'update', { data: { status: 'final' }, filters: [eq('id', m.id)] }, asScorer(scorer))).status, 200)
      // the resent closing job is a no-op rewrite
      assert.equal((await q('matches', 'update', { data: { status: 'final' }, filters: [eq('id', m.id)] }, asScorer(scorer))).status, 200)
      // the stored live score is locked as well
      closed(await q('match_live_state', 'upsert', { data: { match_id: m.id, points_a: 2 }, onConflict: 'match_id' }, asScorer(scorer)))
      closed(await q('match_live_state', 'delete', { filters: [eq('match_id', m.id)] }, asScorer(scorer)))
      assert.equal((await raw.query('SELECT points_a FROM match_live_state WHERE match_id = $1', [m.id])).rows[0].points_a, 1)
    })

    it('a test match never closes', async () => {
      const t = await matchOf(asPending(pending), { test: true })
      await q('matches', 'update', { data: { status: 'final' }, filters: [eq('id', t.id)] }, asPending(pending))
      assert.equal((await raw.query('SELECT closed_at FROM matches WHERE id = $1', [t.id])).rows[0].closed_at, null)
      assert.equal((await q('sets', 'insert', { data: setOf(t, 1) }, asPending(pending))).status, 200)
    })
  })

  describe('one cloud match per official game', () => {
    it('a second match for the same game and season is 409 OV_GAME_TAKEN without details; other 23505 unchanged', async () => {
      const n = gameSeq++
      await matchOf(asScorer(scorer), { game_n: n, scheduled_at: '2026-10-10T16:00:00Z' })
      const r = await q('matches', 'insert', { data: { external_id: uniq(), game_n: n, scheduled_at: '2026-11-01T16:00:00Z' } }, asScorer(other))
      expectCode(r, 409, 'OV_GAME_TAKEN')
      assert.equal(r.body.error.details, undefined)
      assert.equal(r.body.error.retryable, undefined)
      assert.equal(JSON.stringify(r.body).includes(String(n)), false, 'no key values')
      // next season, beach, a test match: all fine
      assert.equal((await q('matches', 'insert', { data: { external_id: uniq(), game_n: n, scheduled_at: '2027-10-10T16:00:00Z' } }, asScorer(other))).status, 200)
      assert.equal((await q('matches', 'insert', { data: { external_id: uniq(), game_n: n, sport_type: 'beach', scheduled_at: '2026-10-10T16:00:00Z' } }, asScorer(other))).status, 200)
      assert.equal((await q('matches', 'insert', { data: { external_id: uniq(), game_n: n, test: true, scheduled_at: '2026-10-10T16:00:00Z' } }, asScorer(other))).status, 200)
      // an update that moves a match onto a taken game
      const mine = await matchOf(asScorer(other), { scheduled_at: '2026-10-12T16:00:00Z' })
      expectCode(await q('matches', 'update', { data: { game_n: n }, filters: [eq('id', mine.id)] }, asScorer(other)), 409, 'OV_GAME_TAKEN')
      // any other unique violation keeps the plain SQLSTATE answer
      const dup = await q('matches', 'insert', { data: { external_id: mine.external_id, game_n: gameSeq++ } }, { proto: 2 })
      expectCode(dup, 400, '23505')
    })
  })

  describe('matchRestore', () => {
    function backup (ext, { status = 'live', test, gameN = gameSeq++ } = {}) {
      return {
        match: { external_id: ext, game_n: gameN, game_pin: '424242', status, ...(test != null ? { test } : {}), closed_at: null, closed_by: other, official_game_exempt: true, created_by: other },
        sets: [{ external_id: `${ext}:s:1`, index: 1, home_points: 25, away_points: 20 }],
        events: [{ external_id: `${ext}:e:1`, set_index: 1, type: 'point', seq: 1 }]
      }
    }

    it('drops the server-only columns, and a pending account restores test matches only', async () => {
      const ext = uniq('R')
      const r = await restore.restoreMatch(backup(ext), { proto: 2, matchOwner: { userId: scorer }, actorId: scorer })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      const { rows: [row] } = await raw.query('SELECT created_by, closed_by, official_game_exempt FROM matches WHERE external_id = $1', [ext])
      assert.deepEqual(row, { created_by: scorer, closed_by: null, official_game_exempt: false })
      scorerRequired(await restore.restoreMatch(backup(uniq('R')), { proto: 2, matchOwner: { userId: pending, testOnly: true } }))
      assert.equal((await restore.restoreMatch(backup(uniq('R'), { test: true }), { proto: 2, matchOwner: { userId: pending, testOnly: true } })).status, 200)
    })

    it('a final backup is restored with its children and closed last, by the actor', async () => {
      const ext = uniq('F')
      const r = await restore.restoreMatch(backup(ext, { status: 'final' }), { proto: 2, matchOwner: { userId: scorer }, actorId: scorer })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      const { rows: [m] } = await raw.query('SELECT id, status, closed_by, closed_at FROM matches WHERE external_id = $1', [ext])
      assert.equal(m.status, 'final')
      assert.equal(m.closed_by, scorer)
      assert.ok(m.closed_at)
      assert.equal((await raw.query('SELECT count(*)::int n FROM events WHERE match_id = $1', [m.id])).rows[0].n, 1)
      assert.equal(r.changes.at(-1).row.status, 'final')

      // restoring over the closed match: 409, nothing changes
      const again = await restore.restoreMatch({ ...backup(ext, { status: 'final' }), events: [] }, { proto: 2, matchOwner: { userId: scorer }, actorId: scorer })
      expectCode(again, 409, 'OV_MATCH_CLOSED')
      assert.equal((await raw.query('SELECT count(*)::int n FROM events WHERE match_id = $1', [m.id])).rows[0].n, 1)
    })

    it('restore-by-pin hides created_by, closed_by and official_game_exempt', async () => {
      const ext = uniq('P')
      const n = gameSeq++
      assert.equal((await restore.restoreMatch(backup(ext, { gameN: n, status: 'final' }), { proto: 2, matchOwner: { userId: scorer }, actorId: scorer })).status, 200)
      const r = await restore.restoreByPin({ gameN: n, pin: '424242' }, { limitKey: 'k-hide' })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      for (const k of ['created_by', 'closed_by', 'official_game_exempt', 'game_pin']) assert.equal(k in r.body.data.match, false, k)
      assert.ok(r.body.data.match.closed_at)
    })
  })
})
