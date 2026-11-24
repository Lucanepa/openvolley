// Audit round 3, against the real app database (Dexie 4 on fake-indexeddb):
// the sync jobs a restore in place and a cloud import leave behind.
//  - LOG-08: restoreMatchInPlace (Take back scoring keeping this device's
//    score, a cloud backup restored during the match) re-adds the events
//    under new ids and sends them all in its restore job. It dropped the
//    match's 'queued' and 'error' set/event jobs but kept a 'failed' one
//    (parked for the hourly retry or Retry all) under the OLD id: once that
//    retry went through, the server stored the rally a second time.
//  - LOG-17: importMatchFromSupabase makes a local Set 1 for a cloud copy
//    with a coin toss or events and no set row, and queued no insert for it:
//    every score update of the set matched no row on the server.
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/apiClient', () => ({
  apiFrom: vi.fn(() => { throw new Error('no network in this test') }),
  apiStorage: { from: vi.fn() },
  apiMatchRestoreByPin: vi.fn(),
  apiMatchScorer: vi.fn(async () => ({ data: null, error: { status: 0, network: true } })),
  writingDevice: () => ({ id: '00000000-0000-4000-8000-000000000001', platform: 'web' }),
  OV_PROTO: '2'
}))

import { db } from '../../db/db'
import { importMatchFromSupabase, restoreMatchInPlace, restoreMatchFromJson, exportMatchData } from '../backupManager'
import { queueSetScoreSync, buildEventInsertJob } from '../eventSync'
import { eventHistorySettled } from '../../db/eventHistory'

const offline = { checkServer: async () => null, cloudLiveState: async () => null }
const settle = async () => {
  await new Promise(r => setTimeout(r, 30))
  await eventHistorySettled()
}

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map(t => t.clear()))
})

// An official match in set 1 whose rally insert was refused once (a server
// behind this build: PGRST204, parked as 'failed'), plus a set update
// waiting out a backoff and a queued rally of the same match
async function matchWithParkedJobs(seed) {
  const matchId = await db.matches.add({ seed_key: seed, status: 'live', gameN: 900102, gamePin: '123456', test: false })
  const setId = await db.sets.add({ matchId, index: 1, homePoints: 2, awayPoints: 0, finished: false })
  const ev1 = await db.events.add({ matchId, setIndex: 1, type: 'point', payload: { team: 'home' }, seq: 3, ts: '2026-11-23T10:01:00Z' })
  const ev2 = await db.events.add({ matchId, setIndex: 1, type: 'point', payload: { team: 'home' }, seq: 4, ts: '2026-11-23T10:02:00Z' })
  const match = await db.matches.get(matchId)
  const failed = await db.sync_queue.add({ ...buildEventInsertJob(await db.events.get(ev1), match), status: 'failed', failed_at: Date.now(), last_error: { code: 'PGRST204', status: 400 } })
  const queued = await db.sync_queue.add(buildEventInsertJob(await db.events.get(ev2), match))
  const error = await db.sync_queue.add({ resource: 'set', action: 'update', payload: { external_id: `${seed}:s:${setId}`, home_points: 2, away_points: 0 }, ts: Date.now(), status: 'error' })
  // an older restore of the match, refused and parked: it would replace the
  // server's events with the old ids again
  const oldRestore = await db.sync_queue.add({ resource: 'match', action: 'restore', payload: { match: { external_id: seed }, sets: [], events: [] }, ts: Date.now(), status: 'failed' })
  // jobs that stay: a match update not sent, a sent insert (history), another match's parked insert
  const matchUpdate = await db.sync_queue.add({ resource: 'match', action: 'update', payload: { id: seed, officials: [] }, ts: Date.now(), status: 'failed' })
  const sent = await db.sync_queue.add({ resource: 'event', action: 'insert', payload: { external_id: `${seed}:e:900`, match_id: seed }, ts: Date.now(), status: 'sent' })
  const other = await db.sync_queue.add({ resource: 'event', action: 'insert', payload: { external_id: 'match_other_x:e:4', match_id: 'match_other_x' }, ts: Date.now(), status: 'failed' })
  return { matchId, ids: { failed, queued, error, oldRestore, matchUpdate, sent, other }, oldEventExt: `${seed}:e:${ev1}` }
}

describe('LOG-08: a restore in place keeps no job of the rows it replaces', () => {
  it('restoreMatchInPlace: the parked insert under the old id goes with the queued and error ones; the restore job carries the rally once', async () => {
    const seed = 'match_1792931096817_auditrip'
    const { matchId, ids, oldEventExt } = await matchWithParkedJobs(seed)

    const data = await exportMatchData(matchId)
    await restoreMatchInPlace(matchId, data, { ...offline, replaceNewer: true })
    await settle()

    const jobs = await db.sync_queue.toArray()
    const left = new Set(jobs.map(j => j.id))
    expect(left.has(ids.failed)).toBe(false)
    expect(left.has(ids.queued)).toBe(false)
    expect(left.has(ids.error)).toBe(false)
    expect(left.has(ids.oldRestore)).toBe(false)
    // nothing of the match under its old ids is left to send
    expect(jobs.filter(j => j.payload?.external_id === oldEventExt)).toEqual([])
    // kept: the match update (columns the restore does not carry), the sent
    // history, another match's job
    expect(left.has(ids.matchUpdate)).toBe(true)
    expect(left.has(ids.sent)).toBe(true)
    expect(left.has(ids.other)).toBe(true)
    const restores = jobs.filter(j => j.resource === 'match' && j.action === 'restore')
    expect(restores).toHaveLength(1)
    expect(restores[0].payload.events.map(e => e.seq)).toEqual([3, 4])
    expect(restores[0].payload.events.map(e => e.external_id)).not.toContain(oldEventExt)
  })

  it('restoreMatchFromJson (a backup restored over this device\'s copy): no set or event job of the match survives either', async () => {
    const seed = 'match_1792931096817_auditrfj'
    const { matchId, ids, oldEventExt } = await matchWithParkedJobs(seed)

    const data = await exportMatchData(matchId)
    await restoreMatchFromJson(data, { ...offline, replaceNewer: true })
    await settle()

    const jobs = await db.sync_queue.toArray()
    const left = new Set(jobs.map(j => j.id))
    expect(left.has(ids.failed)).toBe(false)
    expect(left.has(ids.queued)).toBe(false)
    expect(left.has(ids.error)).toBe(false)
    expect(jobs.filter(j => j.payload?.external_id === oldEventExt)).toEqual([])
    expect(left.has(ids.other)).toBe(true)
  })
})

describe('LOG-17: continuing a match whose cloud copy has no set row', () => {
  it('the Set 1 the import makes is queued as an insert, and the later score updates follow it', async () => {
    const seed = 'match_1792931096817_auditnoset'
    const cloud = {
      match: {
        id: '11111111-1111-4111-8111-111111111111', external_id: seed, game_n: 900102, game_pin: '123456', status: 'live', test: false,
        sport_type: 'indoor', home_team: { name: 'Synthetic Home' }, away_team: { name: 'Synthetic Away' },
        coin_toss: { team_a: 'home', team_b: 'away', confirmed: true, first_serve: 'home' }, set_results: []
      },
      sets: [],
      events: [
        { id: 'c1', external_id: `${seed}:e:1`, set_index: 1, seq: 1, type: 'coin_toss', payload: {}, ts: '2026-11-23T10:00:00Z' },
        { id: 'c2', external_id: `${seed}:e:2`, set_index: 1, seq: 2, type: 'set_start', payload: {}, ts: '2026-11-23T10:00:00Z' },
        { id: 'c3', external_id: `${seed}:e:3`, set_index: 1, seq: 3, type: 'point', payload: { team: 'home' }, ts: '2026-11-23T10:01:00Z' }
      ],
      liveState: null,
      scorerClaimed: true
    }
    const localId = await importMatchFromSupabase(cloud, { replaceNewer: true })
    const sets = await db.sets.where('matchId').equals(localId).toArray()
    expect(sets).toHaveLength(1)
    const setExt = `${seed}:s:${sets[0].id}`

    // the scorer plays on: the running score of set 1 is queued
    await db.sets.update(sets[0].id, { homePoints: 2 })
    await queueSetScoreSync(db, { matchId: localId, setIndex: 1 })
    const setJobs = (await db.sync_queue.orderBy('id').toArray()).filter(j => j.resource === 'set')
    expect(setJobs.map(j => `${j.action} ${j.payload.external_id}`)).toEqual([`insert ${setExt}`, `update ${setExt}`])
    expect(setJobs[0]).toMatchObject({ status: 'queued', payload: { match_id: seed, index: 1, finished: false } })
  })

  it('a cloud copy with its sets gets no extra set insert', async () => {
    const seed = 'match_1792931096817_auditwithset'
    const cloud = {
      match: {
        id: '22222222-2222-4222-8222-222222222222', external_id: seed, game_n: 900103, game_pin: '123456', status: 'live', test: false,
        sport_type: 'indoor', home_team: { name: 'Synthetic Home' }, away_team: { name: 'Synthetic Away' },
        coin_toss: { team_a: 'home', team_b: 'away', confirmed: true, first_serve: 'home' }, set_results: []
      },
      sets: [{ id: 's1', external_id: `${seed}:s:5`, index: 1, home_points: 1, away_points: 0, finished: false }],
      events: [{ id: 'c3', external_id: `${seed}:e:3`, set_index: 1, seq: 3, type: 'point', payload: { team: 'home' }, ts: '2026-11-23T10:01:00Z' }],
      liveState: null,
      scorerClaimed: true
    }
    await importMatchFromSupabase(cloud, { replaceNewer: true })
    expect((await db.sync_queue.toArray()).filter(j => j.resource === 'set')).toEqual([])
  })
})
