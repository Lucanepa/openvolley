/**
 * The pure half of lib/scorerDevice.js (db/019, the scoring-device handover):
 * which device a request names and which matches a /api/db write touches.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createScorerDevices, deviceOf, matchRefsOfWrite, writtenMatchIds, scorerMovedBody, publicScorer, SCORER_TABLES } from '../lib/scorerDevice.js'

const DEV = '0b7c1f3e-5a2d-4c8e-9f10-2a3b4c5d6e7f'
const UUID = '171f784a-f1b6-4091-ac4b-8842f823185e'
const SEED = 'match_1792518507614_u2sbmb'

describe('scorerDevice deviceOf', () => {
  it('takes a uuid, alone or with a platform, lower-cased', () => {
    assert.deepEqual(deviceOf(DEV), { id: DEV, platform: null })
    assert.deepEqual(deviceOf({ id: DEV.toUpperCase(), platform: 'Tauri-Linux' }), { id: DEV, platform: 'tauri-linux' })
  })
  it('names no device for a missing or malformed id (the write is not checked)', () => {
    for (const v of [undefined, null, '', 'abc', 42, { id: 'x' }, { platform: 'android' }, ['a']]) assert.equal(deviceOf(v), null, JSON.stringify(v))
  })
  it('drops a platform that is not a short plain token', () => {
    assert.equal(deviceOf({ id: DEV, platform: '<script>' }).platform, null)
    assert.equal(deviceOf({ id: DEV, platform: 'x'.repeat(25) }).platform, null)
  })
})

describe('scorerDevice matchRefsOfWrite', () => {
  it('matches rows and filters name the match by external_id or id', () => {
    assert.deepEqual(matchRefsOfWrite('matches', 'upsert', { data: { external_id: SEED, game_n: 1 } }), { externalIds: [SEED], ids: [] })
    assert.deepEqual(matchRefsOfWrite('matches', 'update', { data: { status: 'live' }, filters: [{ type: 'eq', column: 'external_id', value: SEED }] }), { externalIds: [SEED], ids: [] })
    assert.deepEqual(matchRefsOfWrite('matches', 'update', { data: {}, filters: [{ type: 'eq', column: 'id', value: UUID }] }), { externalIds: [], ids: [UUID] })
  })
  it('sets and events: the match uuid only, never a match parsed from the child id', () => {
    assert.deepEqual(matchRefsOfWrite('events', 'upsert', { data: [{ external_id: `${SEED}:e:12`, match_id: UUID }] }), { externalIds: [], ids: [UUID] })
    assert.deepEqual(matchRefsOfWrite('sets', 'update', { data: { home_points: 3 }, filters: [{ type: 'eq', column: 'match_id', value: UUID }, { type: 'in', column: 'external_id', value: [`${SEED}:s:4`, '4'] }] }),
      { externalIds: [], ids: [UUID] })
    // a child id that names another match names nothing (the rows written decide)
    assert.deepEqual(matchRefsOfWrite('events', 'insert', { data: { external_id: `${SEED}:e:99999` } }), { externalIds: [], ids: [] })
    assert.deepEqual(matchRefsOfWrite('events', 'delete', { filters: [{ type: 'eq', column: 'external_id', value: `${SEED}:e:3` }] }), { externalIds: [], ids: [] })
  })
  it('the matches a write wrote: matches.id, a child row\'s match_id', () => {
    assert.deepEqual(writtenMatchIds('matches', [{ table: 'matches', eventType: 'INSERT', row: { id: UUID.toUpperCase(), external_id: SEED } }]), [UUID])
    assert.deepEqual(writtenMatchIds('events', [{ row: { match_id: UUID } }, { row: { match_id: UUID } }, { row: { match_id: null } }]), [UUID])
    assert.deepEqual(writtenMatchIds('events', []), [])
    assert.deepEqual(writtenMatchIds('sets', undefined), [])
  })
  it('live state: its match_id', () => {
    assert.deepEqual(matchRefsOfWrite('match_live_state', 'upsert', { data: { match_id: UUID, points_a: 3 } }), { externalIds: [], ids: [UUID] })
  })
  it('ignores what is not a match reference', () => {
    assert.deepEqual(matchRefsOfWrite('matches', 'insert', { data: [null, 'x', { external_id: 5 }] }), { externalIds: [], ids: [] })
    assert.deepEqual(matchRefsOfWrite('events', 'upsert', { data: { match_id: 'not-a-uuid' } }), { externalIds: [], ids: [] })
    assert.deepEqual(SCORER_TABLES, ['matches', 'sets', 'events', 'match_live_state'])
  })
})

describe('scorerDevice answers', () => {
  it('409 OV_SCORER_MOVED names the platform and time, never the device id', () => {
    const at = new Date('2026-10-20T17:54:25Z')
    const body = scorerMovedBody({ external_id: SEED, device_id: DEV, platform: 'android', claimed_at: at })
    assert.equal(body.error.code, 'OV_SCORER_MOVED')
    assert.deepEqual(body.error.scorer, { platform: 'android', at: at.toISOString() })
    assert.equal(body.error.match_external_id, SEED)
    assert.equal(JSON.stringify(body).includes(DEV), false)
    assert.equal(publicScorer(null), null)
  })
})

describe('scorerDevice guardedWrite', () => {
  // A pgQuery stand-in: withTransaction hands `client` to the callback, a throw rolls back
  const fakeDb = (client) => ({
    withTransaction: async (fn) => fn(client),
    assertMatchWritable: async () => ({}),
    toErrorResult: (err) => ({ status: 503, body: { data: null, error: { message: 'Service unavailable', code: 'OV_DB_UNAVAILABLE', retryable: true } }, cause: err.message })
  })
  const refs = { externalIds: [SEED], ids: [] }

  it('fails closed: a check that cannot run fails the write, which never runs', async () => {
    const client = { query: async () => { throw new Error('Connection terminated unexpectedly') } }
    const sd = createScorerDevices({ pool: client, db: fakeDb(client) })
    let wrote = false
    const g = await sd.guardedWrite({ device: deviceOf(DEV), refs, table: 'events', action: 'upsert', write: async () => { wrote = true; return { status: 200, body: {}, changes: [] } } })
    assert.equal(wrote, false)
    assert.equal(g.moved, null)
    assert.equal(g.result.status, 503)
    assert.equal(g.result.body.error.retryable, true)
  })

  it('adopts only the matches whose rows the write wrote', async () => {
    const calls = []
    const client = { query: async (text, values) => { calls.push({ text, values }); return { rows: [] } } }
    const sd = createScorerDevices({ pool: client, db: fakeDb(client) })
    const none = await sd.guardedWrite({ device: deviceOf(DEV), refs, table: 'events', action: 'update', write: async () => ({ status: 200, body: {}, changes: [] }) })
    assert.equal(none.result.status, 200)
    assert.equal(calls.some((c) => /INSERT INTO public\.match_scorer_devices/.test(c.text)), false, 'no row written: nothing adopted')
    calls.length = 0
    await sd.guardedWrite({ device: deviceOf(DEV), refs, table: 'events', action: 'upsert', write: async () => ({ status: 200, body: {}, changes: [{ row: { match_id: UUID } }] }) })
    const ins = calls.find((c) => /INSERT INTO public\.match_scorer_devices/.test(c.text))
    assert.deepEqual(ins.values[0], [UUID])
  })
})
