/**
 * Undone / deleted / edited events keep their history on the server
 * (db/015_event_revisions.sql, lib/eventRevisions.js,
 * POST /api/match/event-revisions), end to end through server.js.
 *
 * Needs PG_TEST_URL (a throwaway Postgres, see tests/helpers/pgTestDb.js) or
 * OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'
import { parseRevisionsBody, isScopedToMatch, deleteRevUid } from '../lib/eventRevisions.js'

const GAME_PIN = '774411'

describe('event revisions (unit)', () => {
  it('parses a body and refuses what does not fit', () => {
    const rev = { rev_uid: randomUUID(), op: 'void', event_external_id: 'match_1_a:e:3', reason: 'undo', seq: 3, set_index: 1, type: 'point', client_ts: '2026-10-07T10:00:00.000Z' }
    const ok = parseRevisionsBody({ match_external_id: 'match_1_a', revisions: [rev, rev] })
    assert.equal(ok.revisions.length, 1, 'a repeated rev_uid counts once')
    const bad = (patch) => parseRevisionsBody({ match_external_id: 'match_1_a', revisions: [{ ...rev, ...patch }] }).error?.body.error.code
    assert.equal(bad({ event_external_id: 'match_1_b:e:3' }), 'OV_INVALID_REQUEST', 'another match')
    assert.equal(bad({ event_external_id: 'match_1_ab:e:3' }), 'OV_INVALID_REQUEST', 'a prefix without separator')
    assert.equal(bad({ op: 'insert' }), 'OV_INVALID_REQUEST')
    assert.equal(bad({ reason: 'whatever' }), 'OV_INVALID_REQUEST')
    assert.equal(bad({ client_ts: 'yesterday' }), 'OV_INVALID_REQUEST')
    assert.equal(bad({ op: 'edit' }), 'OV_INVALID_REQUEST', 'an edit needs after')
    assert.equal(bad({ op: 'edit', after: { state_snapshot: {} } }), 'OV_INVALID_REQUEST', 'never the snapshot')
    assert.equal(parseRevisionsBody({ match_external_id: 'm', revisions: new Array(201).fill(rev) }).error.status, 400)
    assert.equal(isScopedToMatch('m_1:e:1', 'm_1'), true)
    assert.equal(isScopedToMatch('m_1', 'm_1'), false)
    // a correction (services/corrections) and its renumbered seq
    assert.equal(parseRevisionsBody({ match_external_id: 'match_1_a', revisions: [{ ...rev, reason: 'correction' }] }).revisions[0].reason, 'correction')
    const seqEdit = parseRevisionsBody({ match_external_id: 'match_1_a', revisions: [{ ...rev, op: 'edit', after: { seq: 7.5, payload: {} } }] })
    assert.deepEqual(seqEdit.revisions[0].after, { seq: 7.5, payload: {} })
    assert.equal(bad({ op: 'edit', after: { seq: 'x' } }), 'OV_INVALID_REQUEST')
    // the void of an /api/db event delete: one rev_uid per event, a valid uuid
    assert.equal(deleteRevUid('m_1:e:2'), deleteRevUid('m_1:e:2'))
    assert.notEqual(deleteRevUid('m_1:e:2'), deleteRevUid('m_1:e:3'))
    assert.equal(parseRevisionsBody({ match_external_id: 'match_1_a', revisions: [{ ...rev, rev_uid: deleteRevUid('x') }] }).error, undefined)
  })
})

describe('event revisions end to end', { skip: SKIP }, () => {
  let db, srv, sql, storageRoot, statusDir
  let ipSeq = 1
  const nextIp = () => `203.0.113.${ipSeq++}`
  const users = {}
  let gameSeq = 81100

  async function account (name, { roles = null } = {}) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const password = 'correct-horse-battery'
    const ip = nextIp()
    const up = await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password, metadata: { first_name: name, last_name: 'Test' } } })
    assert.equal(up.status, 200, up.text)
    let inn
    for (let attempt = 0; attempt < 10; attempt++) {
      inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password } })
      if (!(inn.status === 503 && inn.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    assert.equal(inn.status, 200, inn.text)
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, email, ip }
    if (roles) await grantRoles(sql, u.id, roles)
    users[name] = u
    return u
  }
  const dbCall = (user, table, action, params) =>
    api(srv.base, '/api/db', { token: user?.token, proto: action === 'select' ? null : '2', body: { table, action, params } })
  const revise = (user, matchExt, revisions) =>
    api(srv.base, '/api/match/event-revisions', { token: user?.token, proto: null, body: { match_external_id: matchExt, revisions } })
  const expectCode = (r, status, code) => {
    assert.equal(r.status, status, r.text)
    assert.equal(r.json?.error?.code, code, r.text)
  }
  const eq = (column, value) => ({ type: 'eq', column, value })
  const rev = (eventExt, patch = {}) => ({
    rev_uid: randomUUID(), op: 'void', event_external_id: eventExt, reason: 'undo', seq: 3, set_index: 1, type: 'point',
    client_ts: '2026-10-07T10:00:00.000Z', device_id: 'dev-1', app_version: '2.4.0', ...patch
  })

  async function newMatch (owner) {
    const ext = `match_${Date.now()}_${randomBytes(3).toString('hex')}`
    const n = gameSeq++
    const r = await dbCall(owner, 'matches', 'insert', { data: { external_id: ext, game_n: n, status: 'live', game_pin: GAME_PIN, scheduled_at: '2026-10-10T16:00:00Z' }, returning: 'id', single: true })
    assert.equal(r.status, 200, r.text)
    return { ext, n, id: r.json.data.id }
  }
  async function newEvent (owner, m, local, extra = {}) {
    const ext = `${m.ext}:e:${local}`
    const r = await dbCall(owner, 'events', 'upsert', { data: { external_id: ext, match_id: m.id, set_index: 1, type: 'point', seq: local, payload: { team: 'home' }, score_a: local, score_b: 0, ...extra }, onConflict: 'external_id' })
    assert.equal(r.status, 200, r.text)
    return ext
  }
  const eventRow = async (ext) => (await sql.query('SELECT voided_at, voided_by, void_reason, rev, type, payload, score_a FROM events WHERE external_id = $1', [ext])).rows[0]

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-rev-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-rev-status-'))
    writeFileSync(join(statusDir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
    srv = await bootServer({
      DATABASE_URL: db.url,
      STORAGE_ROOT: storageRoot,
      STATUS_DIR: statusDir,
      TRUST_PROXY: 'cloudflare',
      TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
      STORAGE_BACKUP_MIN_FREE_MB: '1',
      STORAGE_SCORESHEETS_MIN_FREE_MB: '1'
    })
    await account('admin', { roles: ['admin'] })
    await account('anna', { roles: ['scorer'] })
    await account('carl', { roles: ['scorer'] })
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
    if (statusDir) rmSync(statusDir, { recursive: true, force: true })
  })

  it('undo after sync: the event is voided, never deleted, and the revision keeps the row before', async () => {
    const m = await newMatch(users.anna)
    const e3 = await newEvent(users.anna, m, 3)
    const r1 = rev(e3)
    const r = await revise(users.anna, m.ext, [r1])
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.data, { applied: 1, pending: 0 })
    const row = await eventRow(e3)
    assert.ok(row.voided_at)
    assert.equal(row.voided_by, users.anna.id)
    assert.equal(row.void_reason, 'undo')
    assert.equal(row.rev, 1)
    const { rows: [h] } = await sql.query('SELECT * FROM event_revisions WHERE rev_uid = $1', [r1.rev_uid])
    assert.equal(h.applied, true)
    assert.equal(h.op, 'void')
    assert.equal(h.before.type, 'point')
    assert.equal(h.before.score_a, 3)
    assert.equal('state_snapshot' in h.before, false)
    assert.equal(h.actor_id, users.anna.id)
    assert.equal(h.device_id, 'dev-1')

    // the same revision again (a retry): nothing changes
    const again = await revise(users.anna, m.ext, [r1])
    assert.deepEqual(again.json.data, { applied: 0, pending: 0 })
    assert.equal((await eventRow(e3)).rev, 1)

    // /api/db reads leave it out; the owner may ask for it, anonymous may not
    const live = await dbCall(users.anna, 'events', 'select', { columns: 'external_id', filters: [eq('match_id', m.id)] })
    assert.deepEqual(live.json.data, [])
    const all = await dbCall(users.anna, 'events', 'select', { columns: 'external_id, voided_at', filters: [eq('match_id', m.id)], include_voided: true })
    assert.equal(all.json.data.length, 1)
    const other = await dbCall(users.carl, 'events', 'select', { columns: 'external_id', filters: [eq('match_id', m.id)], include_voided: true })
    assert.deepEqual(other.json.data, [])
    const anon = await dbCall(null, 'events', 'select', { columns: 'external_id', filters: [eq('match_id', m.id)], include_voided: true })
    assert.deepEqual(anon.json.data, [])
    const adm = await dbCall(users.admin, 'events', 'select', { columns: 'external_id', filters: [eq('match_id', m.id)], include_voided: true })
    assert.equal(adm.json.data.length, 1)

    // /api/db can never unvoid (the columns are denied)
    assert.equal((await dbCall(users.anna, 'events', 'update', { data: { voided_at: null, rev: 0 }, filters: [eq('external_id', e3), eq('match_id', m.id)] })).status, 200)
    assert.ok((await eventRow(e3)).voided_at)
    // and the upsert of the same event (a retried insert job) leaves it voided
    await newEvent(users.anna, m, 3)
    assert.ok((await eventRow(e3)).voided_at)
  })

  it('a void that arrives before its event: kept as pending, the event is born voided; a restore wins', async () => {
    const m = await newMatch(users.anna)
    const e5 = `${m.ext}:e:5`
    const r = await revise(users.anna, m.ext, [rev(e5, { reason: 'delete', seq: 5 })])
    assert.deepEqual(r.json.data, { applied: 0, pending: 1 })
    await newEvent(users.anna, m, 5)
    const row = await eventRow(e5)
    assert.ok(row.voided_at)
    assert.equal(row.void_reason, 'delete')

    const e6 = `${m.ext}:e:6`
    await revise(users.anna, m.ext, [rev(e6, { seq: 6 }), rev(e6, { op: 'restore', seq: 6, reason: 'undo' })])
    await newEvent(users.anna, m, 6)
    assert.equal((await eventRow(e6)).voided_at, null)

    // restore of a voided event that is on the server lifts the void
    await revise(users.anna, m.ext, [rev(e5, { op: 'restore', reason: 'decision_change', after: { type: 'point', payload: { team: 'away' } } })])
    const back = await eventRow(e5)
    assert.equal(back.voided_at, null)
    assert.deepEqual(back.payload, { team: 'away' })
  })

  it('an edit rewrites the server columns and counts the revision', async () => {
    const m = await newMatch(users.anna)
    const e2 = await newEvent(users.anna, m, 2)
    const r = await revise(users.anna, m.ext, [rev(e2, { op: 'edit', reason: 'manual_adjustment', after: { type: 'point', set_index: 1, payload: { team: 'away' }, score_a: 1, score_b: 2 } })])
    assert.deepEqual(r.json.data, { applied: 1, pending: 0 })
    const row = await eventRow(e2)
    assert.deepEqual(row.payload, { team: 'away' })
    assert.equal(row.score_a, 1)
    assert.equal(row.rev, 1)
    assert.equal(row.voided_at, null)
    const { rows: [h] } = await sql.query('SELECT before, after FROM event_revisions WHERE event_external_id = $1', [e2])
    assert.deepEqual(h.before.payload, { team: 'home' })
    assert.deepEqual(h.after.payload, { team: 'away' })
  })

  it('a correction voids with its reason and moves a renumbered event', async () => {
    const m = await newMatch(users.anna)
    const e4 = await newEvent(users.anna, m, 4)
    const e5 = await newEvent(users.anna, m, 5)
    const r = await revise(users.anna, m.ext, [
      rev(e4, { reason: 'correction', seq: 4 }),
      rev(e5, { op: 'edit', reason: 'correction', seq: 5, after: { type: 'point', set_index: 1, seq: 4, payload: { team: 'home' } } })
    ])
    assert.deepEqual(r.json.data, { applied: 2, pending: 0 })
    assert.equal((await eventRow(e4)).void_reason, 'correction')
    const { rows: [moved] } = await sql.query('SELECT seq FROM events WHERE external_id = $1', [e5])
    assert.equal(Number(moved.seq), 4)
  })

  it('an /api/db delete of one event (an older app\'s correction) voids it; a whole-match delete still deletes', async () => {
    const m = await newMatch(users.anna)
    const e1 = await newEvent(users.anna, m, 1)
    const e2 = await newEvent(users.anna, m, 2)
    // another account may not, as for any write of the match
    expectCode(await dbCall(users.carl, 'events', 'delete', { filters: [eq('external_id', e2)] }), 403, 'OV_NOT_MATCH_OWNER')
    assert.equal((await eventRow(e2)).voided_at, null)

    const del = await dbCall(users.anna, 'events', 'delete', { filters: [eq('external_id', e2)] })
    assert.equal(del.status, 200, del.text)
    const row = await eventRow(e2)
    assert.ok(row, 'the row is kept')
    assert.ok(row.voided_at)
    assert.equal(row.void_reason, 'correction')
    assert.equal(row.voided_by, users.anna.id)
    const { rows: hist } = await sql.query('SELECT op, reason, applied, actor_id FROM event_revisions WHERE event_external_id = $1', [e2])
    assert.deepEqual(hist, [{ op: 'void', reason: 'correction', applied: true, actor_id: users.anna.id }])
    // the views the server builds leave it out
    const live = await dbCall(users.anna, 'events', 'select', { columns: 'external_id', filters: [eq('match_id', m.id)] })
    assert.deepEqual(live.json.data.map(e => e.external_id), [e1])
    const pin = await api(srv.base, '/api/match/restore-by-pin', { proto: null, body: { gameN: m.n, pin: GAME_PIN } })
    assert.deepEqual(pin.json.data.events.map((e) => e.external_id), [e1])
    // the same delete again (a retried job): nothing more
    assert.equal((await dbCall(users.anna, 'events', 'delete', { filters: [eq('external_id', e2)] })).status, 200)
    assert.equal((await sql.query('SELECT count(*)::int n FROM event_revisions WHERE event_external_id = $1', [e2])).rows[0].n, 1)
    assert.equal((await eventRow(e2)).rev, 1)
    // an event the server never had: nothing to do
    assert.equal((await dbCall(users.anna, 'events', 'delete', { filters: [eq('external_id', `${m.ext}:e:99`)] })).status, 200)

    // a whole-match delete (filter on match_id) is unchanged
    assert.equal((await dbCall(users.anna, 'events', 'delete', { filters: [eq('match_id', m.id)] })).status, 200)
    assert.equal((await sql.query('SELECT count(*)::int n FROM events WHERE match_id = $1', [m.id])).rows[0].n, 0)
  })

  it('refuses another account (403), an unknown match (404) and ids of another match (400)', async () => {
    const m = await newMatch(users.anna)
    const e1 = await newEvent(users.anna, m, 1)
    expectCode(await revise(users.carl, m.ext, [rev(e1)]), 403, 'OV_NOT_MATCH_OWNER')
    assert.equal((await eventRow(e1)).voided_at, null)
    expectCode(await revise(users.anna, 'match_0_nope', [rev('match_0_nope:e:1')]), 404, 'OV_MATCH_NOT_FOUND')
    expectCode(await revise(users.anna, m.ext, [rev('match_0_other:e:1')]), 400, 'OV_INVALID_REQUEST')
    assert.equal((await revise(null, m.ext, [rev(e1)])).status, 401)
    // an admin may
    assert.equal((await revise(users.admin, m.ext, [rev(e1)])).status, 200)
  })

  it('a closed match is frozen (409); restore-by-pin leaves voided events out; account deletion keeps the history', async () => {
    const m = await newMatch(users.anna)
    const e1 = await newEvent(users.anna, m, 1)
    const e2 = await newEvent(users.anna, m, 2)
    assert.equal((await revise(users.anna, m.ext, [rev(e2, { seq: 2 })])).status, 200)

    const pin = await api(srv.base, '/api/match/restore-by-pin', { proto: null, body: { gameN: m.n, pin: GAME_PIN } })
    assert.equal(pin.status, 200, pin.text)
    assert.deepEqual(pin.json.data.events.map((e) => e.external_id), [e1])

    assert.equal((await dbCall(users.anna, 'matches', 'update', { data: { status: 'approved' }, filters: [eq('id', m.id)] })).status, 200)
    expectCode(await revise(users.anna, m.ext, [rev(e1, { seq: 1 })]), 409, 'OV_MATCH_CLOSED')
    assert.equal((await eventRow(e1)).voided_at, null)
    assert.equal((await sql.query('SELECT count(*)::int n FROM event_revisions WHERE match_id = $1', [m.id])).rows[0].n, 1)

    // the scorer deletes the account: the voids and revisions of the closed match stay, without it
    const del = await api(srv.base, '/api/auth/delete-account', { proto: null, body: { access_token: users.anna.token } })
    assert.equal(del.status, 200, del.text)
    const row = await eventRow(e2)
    assert.ok(row.voided_at)
    assert.equal(row.voided_by, null)
    const { rows: [h] } = await sql.query('SELECT actor_id FROM event_revisions WHERE event_external_id = $1', [e2])
    assert.equal(h.actor_id, null)
  })

  it('the admin console lists the revisions of a match', async () => {
    const m = await newMatch(users.carl)
    const e1 = await newEvent(users.carl, m, 1)
    await revise(users.carl, m.ext, [rev(e1, { seq: 1, reason: 'decision_change' })])
    const r = await api(srv.base, `/api/admin/matches/${m.id}/revisions`, { method: 'GET', token: users.admin.token, proto: null })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.data.length, 1)
    assert.equal(r.json.data[0].reason, 'decision_change')
    assert.equal(r.json.data[0].actor_email, users.carl.email)
    expectCode(await api(srv.base, `/api/admin/matches/${m.id}/revisions`, { method: 'GET', token: users.carl.token, proto: null }), 403, 'OV_FORBIDDEN')
  })
})
