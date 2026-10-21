/**
 * The pure half of lib/scorerDevice.js (db/019, the scoring-device handover):
 * which device a request names and which matches a /api/db write touches.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { deviceOf, matchRefsOfWrite, scorerMovedBody, publicScorer, SCORER_TABLES } from '../lib/scorerDevice.js'

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
  it('sets and events: the match uuid and the seed key of the namespaced id', () => {
    assert.deepEqual(matchRefsOfWrite('events', 'upsert', { data: [{ external_id: `${SEED}:e:12`, match_id: UUID }] }), { externalIds: [SEED], ids: [UUID] })
    assert.deepEqual(matchRefsOfWrite('sets', 'update', { data: { home_points: 3 }, filters: [{ type: 'eq', column: 'match_id', value: UUID }, { type: 'in', column: 'external_id', value: [`${SEED}:s:4`, '4'] }] }),
      { externalIds: [SEED], ids: [UUID] })
    // a bare (pre-namespace) id names nothing
    assert.deepEqual(matchRefsOfWrite('events', 'delete', { filters: [{ type: 'eq', column: 'external_id', value: '17' }] }), { externalIds: [], ids: [] })
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
