/**
 * db/039 (record integrity): the closed guard waits for a close in flight;
 * a match that was closed stays an official record after an admin reopen
 * (no delete, no test flag, no game move but by an admin) and the reopen
 * keeps the closed record (match_closures); an event and a revision of its
 * match see each other; one set row per set number; the void stamps of a
 * restore; rev_uid of another match. Run twice: idempotent.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { SKIP_PG, createTestDatabase, quietLogger } from './helpers/pgTestDb.js'
import { createPgQuery } from '../lib/pgQuery.js'
import { createEventRevisions, deleteRevUid } from '../lib/eventRevisions.js'
import { createMatchRestore } from '../lib/matchRestore.js'

const here = dirname(fileURLToPath(import.meta.url))
const M039 = readFileSync(join(here, '..', 'db', '039_record_integrity.sql'), 'utf8')
const isClosedError = (e) => e.code === 'OVC01'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

describe('db/039 (record integrity)', { skip: SKIP_PG }, () => {
  let tdb, raw, other, db
  const users = {}
  let n = 0

  before(async () => {
    tdb = await createTestDatabase('m039')
    raw = new pg.Client({ connectionString: tdb.url })
    await raw.connect()
    other = new pg.Client({ connectionString: tdb.url })
    await other.connect()
    for (const name of ['scorer', 'stranger', 'admin']) {
      const { rows: [u] } = await raw.query('INSERT INTO auth.users (email) VALUES ($1) RETURNING id', [`${name}@example.test`])
      users[name] = u.id
    }
    db = createPgQuery({ connectionString: tdb.url, logger: quietLogger })
  })
  after(async () => {
    await db?.close()
    await other?.end().catch(() => {})
    await raw?.end().catch(() => {})
    await tdb?.drop()
  })

  async function newMatch ({ status = 'live', test = false, owner = users.scorer } = {}) {
    n++
    const ext = `m039_${n}`
    const { rows: [m] } = await raw.query(
      'INSERT INTO public.matches (external_id, status, game_n, test, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [ext, status, 939000 + n, test, owner])
    await raw.query('INSERT INTO public.sets (external_id, match_id, index, home_points, away_points) VALUES ($1, $2, 1, 25, 20)', [`${ext}:s:1`, m.id])
    return { id: m.id, ext }
  }
  const close = (id) => raw.query("UPDATE public.matches SET status = 'approved', final_score = '1:0', approval = '{\"approvedAt\":\"2026-11-14T10:00:00Z\"}' WHERE id = $1", [id])
  async function reopen (id, reason = 'sanction fixed') {
    await raw.query('BEGIN')
    await raw.query("SELECT set_config('ov.allow_closed', 'on', true), set_config('ov.user_id', $1, true), set_config('ov.reopen_reason', $2, true)", [users.admin, reason])
    await raw.query("UPDATE public.matches SET status = 'ended', approval = NULL, closed_at = NULL, closed_by = NULL WHERE id = $1", [id])
    await raw.query('COMMIT')
  }

  it('runs twice on the migrated schema and has its indexes', async () => {
    await raw.query(M039)
    await raw.query(M039)
    const { rows } = await raw.query("SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1)",
      [['sets_match_index_uidx', 'events_match_idx', 'events_voided_by_idx', 'event_revisions_actor_idx', 'audit_log_actor_idx',
        'audit_log_target_user_idx', 'match_approvals_requested_by_idx', 'match_approvals_revoked_by_idx', 'activity_log_uploader_idx']])
    assert.equal(rows.length, 9)
  })

  it('stops on two set rows with one number, names them, and applies nothing', async () => {
    const m = await newMatch()
    await raw.query('DROP INDEX public.sets_match_index_uidx')
    await raw.query('ALTER TABLE public.sets ALTER COLUMN match_id DROP NOT NULL')
    await raw.query('INSERT INTO public.sets (external_id, match_id, index) VALUES ($1, $2, 1)', [`${m.ext}:s:99`, m.id])
    await raw.query('INSERT INTO public.sets (external_id, index) VALUES ($1, 1)', ['orphan:s:1'])
    await assert.rejects(() => raw.query(M039), (e) => /db\/039: 1 set number/.test(e.message) && /1 set\(s\)/.test(e.message) && e.detail.includes(m.ext))
    await raw.query('ROLLBACK')
    const { rows: [i] } = await raw.query("SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'sets_match_index_uidx'")
    assert.equal(i.n, 0)
    await raw.query("DELETE FROM public.sets WHERE external_id IN ($1, 'orphan:s:1')", [`${m.ext}:s:99`])
    await raw.query(M039)
    await assert.rejects(() => raw.query('INSERT INTO public.sets (external_id, match_id, index) VALUES ($1, $2, 1)', [`${m.ext}:s:2`, m.id]), (e) => e.code === '23505')
    await assert.rejects(() => raw.query("INSERT INTO public.events (external_id, type) VALUES ('orphan:e:1', 'point')"), (e) => e.code === '23502')
  })

  it('a child write after a close in flight waits for it and is refused (var-check-then-act-1)', async () => {
    const m = await newMatch()
    await raw.query('BEGIN')
    await close(m.id)
    const write = other.query('UPDATE public.sets SET home_points = 19 WHERE match_id = $1', [m.id])
      .then(() => 'stored', (e) => (isClosedError(e) ? 'refused' : e.message))
    await sleep(200)
    await raw.query('COMMIT')
    assert.equal(await write, 'refused')
    const { rows: [s] } = await raw.query('SELECT home_points FROM public.sets WHERE match_id = $1', [m.id])
    assert.equal(s.home_points, 25)
  })

  it('a close waits for a child write in flight', async () => {
    const m = await newMatch()
    await other.query('BEGIN')
    await other.query('UPDATE public.sets SET home_points = 24 WHERE match_id = $1', [m.id])
    await raw.query("SET lock_timeout = '300ms'")
    try {
      await assert.rejects(() => close(m.id), (e) => e.code === '55P03')
    } finally {
      await raw.query('RESET lock_timeout')
      await other.query('COMMIT')
    }
    await close(m.id)
    const { rows: [r] } = await raw.query('SELECT closed_at FROM public.matches WHERE id = $1', [m.id])
    assert.ok(r.closed_at)
  })

  it('after a reopen only an admin deletes the match, makes it a test match or moves its game (gap-closed-record-changes-3)', async () => {
    const m = await newMatch()
    await close(m.id)
    const { rows: [c] } = await raw.query('SELECT closed_at, first_closed_at FROM public.matches WHERE id = $1', [m.id])
    assert.ok(c.first_closed_at)
    assert.equal(c.first_closed_at.getTime(), c.closed_at.getTime())
    await reopen(m.id)
    const { rows: [o] } = await raw.query('SELECT closed_at, first_closed_at FROM public.matches WHERE id = $1', [m.id])
    assert.equal(o.closed_at, null)
    assert.equal(o.first_closed_at.getTime(), c.first_closed_at.getTime())
    // the scorer's writes (no admin setting)
    await assert.rejects(() => raw.query('DELETE FROM public.matches WHERE id = $1', [m.id]), isClosedError)
    await assert.rejects(() => raw.query('UPDATE public.matches SET test = true WHERE id = $1', [m.id]), isClosedError)
    await assert.rejects(() => raw.query('UPDATE public.matches SET game_n = game_n + 1 WHERE id = $1', [m.id]), isClosedError)
    // the stamp is the server's
    await raw.query('UPDATE public.matches SET first_closed_at = NULL WHERE id = $1', [m.id])
    const { rows: [k] } = await raw.query('SELECT first_closed_at FROM public.matches WHERE id = $1', [m.id])
    assert.equal(k.first_closed_at.getTime(), c.first_closed_at.getTime())
    // what the correction is for still goes
    await raw.query("UPDATE public.matches SET sanctions = '[]' WHERE id = $1", [m.id])
    // an admin
    await raw.query('BEGIN')
    await raw.query("SELECT set_config('ov.admin', 'on', true)")
    await raw.query('DELETE FROM public.matches WHERE id = $1', [m.id])
    await raw.query('COMMIT')
    const { rows: [gone] } = await raw.query('SELECT count(*)::int AS n FROM public.matches WHERE id = $1', [m.id])
    assert.equal(gone.n, 0)
  })

  it('a new match never brings its own first_closed_at; a never-closed one is deleted as before', async () => {
    const { rows: [m] } = await raw.query("INSERT INTO public.matches (external_id, status, first_closed_at) VALUES ('m039_fresh', 'live', now()) RETURNING id, first_closed_at")
    assert.equal(m.first_closed_at, null)
    await raw.query('DELETE FROM public.matches WHERE id = $1', [m.id])
  })

  it('the reopen keeps the closed record, the next close adds the new one (gap-closed-record-changes-4)', async () => {
    const m = await newMatch()
    await raw.query("UPDATE public.matches SET remarks = 'Protest of the home team' WHERE id = $1", [m.id])
    await close(m.id)
    await reopen(m.id, 'protest withdrawn')
    await raw.query("UPDATE public.matches SET remarks = NULL WHERE id = $1", [m.id])
    await raw.query('UPDATE public.sets SET home_points = 26, away_points = 24 WHERE match_id = $1', [m.id])
    const { rows: [mid] } = await raw.query('SELECT reclosed_at FROM public.match_closures WHERE match_id = $1', [m.id])
    assert.equal(mid.reclosed_at, null)
    await close(m.id)
    const { rows } = await raw.query('SELECT * FROM public.match_closures WHERE match_id = $1', [m.id])
    assert.equal(rows.length, 1)
    const c = rows[0]
    assert.equal(c.reason, 'protest withdrawn')
    assert.equal(c.reopened_by, users.admin)
    assert.ok(c.closed_at && c.reclosed_at)
    assert.equal(c.closed_record.status, 'approved')
    assert.equal(c.closed_record.remarks, 'Protest of the home team')
    assert.deepEqual(c.closed_record.approval, { approvedAt: '2026-11-14T10:00:00Z' })
    assert.equal(c.closed_record.final_score, '1:0')
    assert.equal(c.closed_record.sets[0].home_points, 25)
    assert.equal(c.reclosed_record.remarks, null)
    assert.equal(c.reclosed_record.sets[0].home_points, 26)
    assert.ok(!('game_pin' in c.closed_record))
  })

  it('an event inserted while its undo is stored is born voided (be-races-3)', async () => {
    const m = await newMatch()
    const ev = `${m.ext}:e:1`
    await other.query('BEGIN')
    await other.query('SELECT pg_advisory_xact_lock(15015, hashtext($1::text))', [m.id])
    await other.query(`INSERT INTO public.event_revisions (rev_uid, match_id, event_external_id, op, reason, applied, client_ts)
      VALUES (gen_random_uuid(), $1, $2, 'void', 'undo', false, now())`, [m.id, ev])
    const insert = raw.query("INSERT INTO public.events (external_id, match_id, type, seq) VALUES ($1, $2, 'point', 1)", [ev, m.id])
    await sleep(200)
    await other.query('COMMIT')
    await insert
    const { rows: [e] } = await raw.query('SELECT voided_at FROM public.events WHERE external_id = $1', [ev])
    assert.ok(e.voided_at, 'born voided')
  })

  describe('lib/eventRevisions.js', () => {
    let revisions
    before(() => { revisions = createEventRevisions(db, { log: quietLogger }) })
    const rev = (over = {}) => ({ rev_uid: '0b9c3f9e-1c0e-4c8e-9a51-6f2d9e0a1b2c', op: 'void', reason: 'undo', client_ts: '2026-11-14T10:00:00Z', ...over })

    it('a revision id another match used is a conflict, not a retry (be-match-data-7)', async () => {
      const mine = await newMatch({ owner: users.stranger })
      const victim = await newMatch()
      const victimEv = `${victim.ext}:e:4`
      await raw.query("INSERT INTO public.events (external_id, match_id, type, seq) VALUES ($1, $2, 'point', 4)", [victimEv, victim.id])
      // the stranger files a revision of its own match under the rev_uid the
      // victim's delete used before db/039 (all it can compute: not the match's id)
      const taken = deleteRevUid(victimEv)
      assert.notEqual(deleteRevUid(victimEv, victim.id), taken)
      const r1 = await revisions.apply({
        body: { match_external_id: mine.ext, revisions: [rev({ rev_uid: taken, event_external_id: `${mine.ext}:e:1` })] },
        user: { id: users.stranger },
        matchOwner: { userId: users.stranger }
      })
      assert.equal(r1.status, 200, JSON.stringify(r1.body))
      // a plain rev_uid of another match answers 409 too
      const r2 = await revisions.apply({
        body: { match_external_id: victim.ext, revisions: [rev({ rev_uid: taken, event_external_id: victimEv })] },
        user: { id: users.scorer },
        matchOwner: { userId: users.scorer }
      })
      assert.equal(r2.status, 409)
      assert.equal(r2.body.error.code, 'OV_REVISION_CONFLICT')
      // the delete of the victim's event voids it: its rev_uid is the victim match's own
      const r3 = await revisions.voidByExternalId({ eventExt: victimEv, user: { id: users.scorer }, matchOwner: { userId: users.scorer } })
      assert.equal(r3.status, 200, JSON.stringify(r3.body))
      const { rows: [e] } = await raw.query('SELECT voided_at FROM public.events WHERE external_id = $1', [victimEv])
      assert.ok(e.voided_at)
    })

    it('the resend of a revision stored before its event applies it (be-races-3)', async () => {
      const m = await newMatch()
      const ev = `${m.ext}:e:7`
      const body = { match_external_id: m.ext, revisions: [rev({ rev_uid: 'a1d6c2b0-7c55-4b7e-8f0e-3d1c2b4a5e6f', event_external_id: ev })] }
      const args = { body, user: { id: users.scorer }, matchOwner: { userId: users.scorer } }
      const first = await revisions.apply(args)
      assert.deepEqual(first.body.data, { applied: 0, pending: 1 })
      // the event arrives the way the race left it: live (the trigger did not see the revision)
      await raw.query('BEGIN')
      await raw.query('ALTER TABLE public.events DISABLE TRIGGER events_apply_void')
      await raw.query("INSERT INTO public.events (external_id, match_id, type, seq) VALUES ($1, $2, 'point', 7)", [ev, m.id])
      await raw.query('ALTER TABLE public.events ENABLE TRIGGER events_apply_void')
      await raw.query('COMMIT')
      const again = await revisions.apply(args)
      assert.deepEqual(again.body.data, { applied: 1, pending: 0 })
      const { rows: [e] } = await raw.query('SELECT voided_at, void_reason FROM public.events WHERE external_id = $1', [ev])
      assert.ok(e.voided_at)
      assert.equal(e.void_reason, 'undo')
      // and once more: nothing left to do
      assert.deepEqual((await revisions.apply(args)).body.data, { applied: 0, pending: 0 })
    })
  })

  describe('lib/matchRestore.js restoreMatch (be-match-data-6)', () => {
    it('takes no void stamps from the payload, keeps the recorded voids, and audits the counts', async () => {
      const restore = createMatchRestore(db, { logger: quietLogger })
      const m = await newMatch()
      for (const i of [1, 2, 3]) {
        await raw.query("INSERT INTO public.events (external_id, match_id, type, seq, payload) VALUES ($1, $2, 'point', $3, '{\"team\":\"home\"}')", [`${m.ext}:e:${i}`, m.id, i])
      }
      // event 2 was undone (a revision of this match)
      const undo = await createEventRevisions(db, { log: quietLogger }).apply({
        body: { match_external_id: m.ext, revisions: [{ rev_uid: 'c3e1f2a4-5b6c-4d7e-8f90-a1b2c3d4e5f6', op: 'void', reason: 'undo', event_external_id: `${m.ext}:e:2`, client_ts: '2026-11-14T10:00:00Z' }] },
        user: { id: users.scorer },
        matchOwner: { userId: users.scorer }
      })
      assert.equal(undo.body.data.applied, 1)
      const r = await restore.restoreMatch({
        match: { external_id: m.ext, status: 'live' },
        sets: [{ external_id: `${m.ext}:s:1`, index: 1, home_points: 25, away_points: 20 }],
        events: [
          { external_id: `${m.ext}:e:1`, type: 'point', seq: 1, payload: { team: 'away' }, voided_at: '2026-11-14T09:00:00Z', voided_by: users.stranger, void_reason: 'other', rev: 41 },
          { external_id: `${m.ext}:e:2`, type: 'point', seq: 2 }
        ]
      }, { proto: 2, matchOwner: { userId: users.scorer }, actorId: users.scorer })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      const { rows } = await raw.query('SELECT external_id, voided_at, voided_by, rev FROM public.events WHERE match_id = $1 ORDER BY seq', [m.id])
      assert.equal(rows.length, 2)
      assert.equal(rows[0].voided_at, null)
      assert.equal(rows[0].voided_by, null)
      assert.equal(rows[0].rev, 0)
      assert.ok(rows[1].voided_at, 'the recorded undo is applied again')
      const { rows: [a] } = await raw.query("SELECT actor_id, details FROM public.audit_log WHERE action = 'match.restore' AND match_id = $1", [m.id])
      assert.equal(a.actor_id, users.scorer)
      assert.deepEqual(a.details.before, { sets: 1, events: 3, voided_events: 1, live_state: 0 })
      assert.deepEqual(a.details.after, { sets: 1, events: 2, voided_events: 1, live_state: 0 })
      assert.equal(a.details.external_id, m.ext)
    })
  })
})
