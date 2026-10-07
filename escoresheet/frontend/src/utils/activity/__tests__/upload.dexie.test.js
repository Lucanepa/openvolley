// The activity upload on the real app database (Dexie 4 on fake-indexeddb).
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { db } from '../../../db/db'
import { SYNC } from '../writer'
import { uploadActivityBatch, ensureActivityFlushJob, uploadEntry } from '../upload'

const ME = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const row = (uid, extra = {}) => ({ uid, ts: '2026-10-07T10:00:00.000Z', kind: 'event.add', level: 'info', app: 'indoor', matchId: null, matchExt: null, data: { type: 'point' }, deviceId: 'd', appVersion: '2.4.0', platform: 'web', accountId: null, synced: SYNC.PENDING, ...extra })

describe('activity upload', () => {
  beforeEach(async () => {
    await db.open()
    await Promise.all(db.tables.map(t => t.clear()))
  })

  it('sends the waiting rows of no account or this account, marks accepted 1 and refused 2', async () => {
    const matchId = await db.matches.add({ status: 'live', seed_key: 'match_1_a' })
    const testId = await db.matches.add({ status: 'live', seed_key: 'match_2_t', test: true })
    await db.activity_log.bulkAdd([
      row('a', { accountId: ME, matchId }),
      row('b'),
      row('c', { accountId: OTHER }),
      row('d', { synced: SYNC.UPLOADED }),
      row('e', { matchId: testId }),
      row('f', { accountId: ME })
    ])
    const post = vi.fn(async (entries) => ({ data: { accepted: ['a', 'b'], rejected: [{ uid: 'f', code: 'OV_ACTIVITY_INVALID' }] }, error: null, status: 200 }))
    const r = await uploadActivityBatch(db, { post, accountId: ME })
    expect(post).toHaveBeenCalledTimes(1)
    const sent = post.mock.calls[0][0]
    expect(sent.map(e => e.uid).sort()).toEqual(['a', 'b', 'f'])
    expect(sent.find(e => e.uid === 'a')).toMatchObject({ match_external_id: 'match_1_a', account_id: ME, client_ts: '2026-10-07T10:00:00.000Z', kind: 'event.add' })
    expect(r).toMatchObject({ sent: 3, accepted: 2, rejected: 1, more: false })
    const by = Object.fromEntries((await db.activity_log.toArray()).map(x => [x.uid, x.synced]))
    expect(by).toEqual({ a: 1, b: 1, c: 0, d: 1, e: 2, f: 2 })
  })

  it('an error leaves the rows waiting; more than a batch asks for another flush', async () => {
    await db.activity_log.bulkAdd([row('a'), row('b'), row('c')])
    const fail = vi.fn(async () => ({ data: null, error: { status: 503, message: 'busy' }, status: 503 }))
    const r = await uploadActivityBatch(db, { post: fail, accountId: ME })
    expect(r.error.status).toBe(503)
    expect(await db.activity_log.where('synced').equals(SYNC.PENDING).count()).toBe(3)
    const ok = vi.fn(async (entries) => ({ data: { accepted: entries.map(e => e.uid), rejected: [] }, error: null, status: 200 }))
    const r2 = await uploadActivityBatch(db, { post: ok, accountId: ME, batch: 2 })
    expect(r2).toMatchObject({ sent: 2, more: true })
  })

  it('queues one coalesced flush job, only with a session', async () => {
    expect(await ensureActivityFlushJob(db, { accountId: null })).toBe(false)
    expect(await ensureActivityFlushJob(db, { accountId: ME })).toBe(true)
    expect(await ensureActivityFlushJob(db, { accountId: ME })).toBe(false)
    expect(await db.sync_queue.toArray()).toEqual([expect.objectContaining({ resource: 'activity', action: 'flush', status: 'queued' })])
  })

  it('the upload sanitizes again: a row stored before the redaction leaves without its PIN (leftover d)', () => {
    const old = { ...row('x', { kind: 'app.error' }), kind: 'app.error', data: { message: 'pin 123456 failed', frames: ['a.js:1:2'] } }
    expect(uploadEntry(old).data).toEqual({ message: 'pin [redacted] failed', frames: ['a.js:1:2'] })
  })

  it('the upload body never carries the local ids', () => {
    expect(Object.keys(uploadEntry(row('x', { lid: 5, matchId: 3 }))).sort()).toEqual([
      'account_id', 'app', 'app_version', 'client_ts', 'data', 'device_id', 'event_external_id', 'event_seq',
      'kind', 'level', 'match_external_id', 'platform', 'set_index', 'uid'
    ])
  })
})
