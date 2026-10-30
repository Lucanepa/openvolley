// A backup file restored on another device, against the real app database
// (Dexie 4 on fake-indexeddb). The restore gives the match's sets and events
// new local ids and sends them as the cloud ids (setExtId / eventExtId). A
// fresh device's counters are low: its new ids fell on ids the device that
// wrote the file had undone, the server keeps those voids (db/015's
// event_revisions, which a restore does not remove) and its insert trigger
// made the restored events born voided. The server's copy (restore by PIN,
// /api/db reads) lost those points while this device still showed them.
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
import { restoreMatchFromJson, restoreMatchInPlace, restoreIdFloor, RESTORE_ID_MARGIN } from '../backupManager'
import { eventHistorySettled } from '../../db/eventHistory'

const seed = 'match_1792931096817_33rkmmhm'
const N = 40
const offline = { checkServer: async () => null, cloudLiveState: async () => null }

// Device A's backup: its local ids (sets 1-2, events 1..N; it undid events
// 7 and 41-43, which the file does not carry)
function backupFile({ setIds = [1, 2], firstEvent = 1, idFloor } = {}) {
  return {
    version: 1,
    lastUpdated: '2026-10-30T10:00:00.000Z',
    match: { id: 3, seed_key: seed, status: 'live', gameN: 939715, test: false, homeTeamId: 1, awayTeamId: 2 },
    homeTeam: { id: 1, name: 'Synthetic Home' },
    awayTeam: { id: 2, name: 'Synthetic Away' },
    homePlayers: [],
    awayPlayers: [],
    sets: setIds.map((id, i) => ({ id, matchId: 3, index: i + 1, homePoints: i ? 4 : 25, awayPoints: i ? 2 : 21, finished: !i })),
    events: Array.from({ length: N }, (_, i) => ({
      id: firstEvent + i, matchId: 3, setIndex: i < 30 ? 1 : 2, seq: i + 1, type: 'point',
      payload: { team: i % 2 ? 'home' : 'away' }, ts: '2026-10-30T09:30:00.000Z'
    })),
    ...(idFloor ? { idFloor } : {})
  }
}

const restoreJob = async () => (await db.sync_queue.toArray()).find(j => j.resource === 'match' && j.action === 'restore')
const localRows = async (table, matchId) => (await db[table].where('matchId').equals(matchId).toArray()).sort((a, b) => a.id - b.id)

describe('a backup restored on another device gives out ids above the file\'s', () => {
  // A new database for every test: clear() keeps the key generators where
  // they are (why a restore on the device that wrote the file was safe)
  beforeEach(async () => {
    await db.delete()
    await db.open()
  })

  it('restoreMatchFromJson on an empty device: events and sets above the file\'s ids, the restore job carries exactly those', async () => {
    const localMatchId = await restoreMatchFromJson(backupFile(), offline)
    await eventHistorySettled()
    const events = await localRows('events', localMatchId)
    const sets = await localRows('sets', localMatchId)
    expect(events).toHaveLength(N)
    expect(sets).toHaveLength(2)
    expect(Math.min(...events.map(e => e.id))).toBe(N + RESTORE_ID_MARGIN + 1)
    expect(Math.min(...sets.map(s => s.id))).toBe(2 + RESTORE_ID_MARGIN + 1)

    const job = await restoreJob()
    expect(job.payload.events.map(e => e.external_id)).toEqual(events.map(e => `${seed}:e:${e.id}`))
    expect(job.payload.sets.map(s => s.external_id)).toEqual(sets.map(s => `${seed}:s:${s.id}`))
    // none of them is an id device A gave out (kept, or undone and voided on the server)
    const usedByA = new Set([...Array.from({ length: 43 }, (_, i) => `${seed}:e:${i + 1}`), `${seed}:s:1`, `${seed}:s:2`])
    expect([...job.payload.events, ...job.payload.sets].filter(r => usedByA.has(r.external_id))).toEqual([])
    // in the file's order, with its content
    expect(job.payload.events.map(e => e.seq)).toEqual(Array.from({ length: N }, (_, i) => i + 1))
    expect(job.payload.sets.map(s => s.index)).toEqual([1, 2])
  })

  it('the generators are moved without leaving a row, a history entry or a void behind', async () => {
    await restoreMatchFromJson(backupFile(), offline)
    await eventHistorySettled()
    expect(await db.events.get(N + RESTORE_ID_MARGIN)).toBeUndefined()
    expect(await db.sets.get(2 + RESTORE_ID_MARGIN)).toBeUndefined()
    expect(await db.event_history.count()).toBe(0)
    expect((await db.sync_queue.toArray()).filter(j => j.resource === 'event')).toEqual([])
  })

  it('an idFloor in the file is respected', async () => {
    const localMatchId = await restoreMatchFromJson(backupFile({ idFloor: { set: 9, event: 500 } }), offline)
    const events = await localRows('events', localMatchId)
    const sets = await localRows('sets', localMatchId)
    expect(events[0].id).toBe(500 + RESTORE_ID_MARGIN + 1)
    expect(sets[0].id).toBe(9 + RESTORE_ID_MARGIN + 1)
    const job = await restoreJob()
    expect(job.payload.events.map(e => e.external_id)).toEqual(events.map(e => `${seed}:e:${e.id}`))
    expect(job.payload.sets.map(s => s.external_id)).toEqual(sets.map(s => `${seed}:s:${s.id}`))
  })

  it('a device whose counters are higher already keeps going up from there', async () => {
    const other = await db.matches.add({ seed_key: 'match_1_other', status: 'live' })
    await db.events.add({ id: 30000, matchId: other, setIndex: 1, type: 'point', seq: 1, payload: { team: 'home' } })
    const localMatchId = await restoreMatchFromJson(backupFile(), offline)
    const events = await localRows('events', localMatchId)
    expect(events[0].id).toBe(30001)
    expect((await db.events.get(30000)).matchId).toBe(other)
  })

  it('restoreMatchInPlace: the open match\'s new rows are above the file\'s ids too', async () => {
    // this device's own copy of the game, with its own low ids
    const open = await db.matches.add({ seed_key: seed, status: 'live', homeTeamId: null, awayTeamId: null })
    await db.sets.add({ matchId: open, index: 1, homePoints: 1, awayPoints: 0, finished: false })
    for (let i = 0; i < 3; i++) await db.events.add({ matchId: open, setIndex: 1, type: 'point', seq: i + 1, payload: { team: 'home' } })

    // device A's cloud backup of the game (its ids 200..239, sets 6-7)
    await restoreMatchInPlace(open, backupFile({ setIds: [6, 7], firstEvent: 200 }), { checkServer: async () => null })
    await eventHistorySettled()
    const events = await localRows('events', open)
    const sets = await localRows('sets', open)
    expect(events).toHaveLength(N)
    expect(events[0].id).toBe(239 + RESTORE_ID_MARGIN + 1)
    expect(sets.map(s => s.id)).toEqual([7 + RESTORE_ID_MARGIN + 1, 7 + RESTORE_ID_MARGIN + 2])

    const job = await restoreJob()
    expect(job.payload.events.map(e => e.external_id)).toEqual(events.map(e => `${seed}:e:${e.id}`))
    expect(job.payload.sets.map(s => s.external_id)).toEqual(sets.map(s => `${seed}:s:${s.id}`))
    // replaced, not undone: nothing voided, no history
    expect(await db.event_history.count()).toBe(0)
    expect((await db.sync_queue.toArray()).filter(j => j.resource === 'event')).toEqual([])
  })
})

describe('restoreIdFloor', () => {
  it('the highest id of the file\'s sets / events or of its idFloor, plus the margin', () => {
    expect(restoreIdFloor(backupFile())).toEqual({ set: 2 + RESTORE_ID_MARGIN, event: N + RESTORE_ID_MARGIN })
    expect(restoreIdFloor(backupFile({ idFloor: { set: 1, event: 12 } }))).toEqual({ set: 2 + RESTORE_ID_MARGIN, event: N + RESTORE_ID_MARGIN })
    expect(restoreIdFloor(backupFile({ idFloor: { set: '9', event: 500 } }))).toEqual({ set: 9 + RESTORE_ID_MARGIN, event: 500 + RESTORE_ID_MARGIN })
    // rows without ids (an older or converted file): the margin alone
    expect(restoreIdFloor({ version: 1, match: {}, sets: [{ index: 1 }], events: [{ type: 'point' }] })).toEqual({ set: RESTORE_ID_MARGIN, event: RESTORE_ID_MARGIN })
    expect(restoreIdFloor({})).toEqual({ set: RESTORE_ID_MARGIN, event: RESTORE_ID_MARGIN })
  })

  it('ignores ids no device gives out (a damaged or crafted file), which would exhaust the key generator', () => {
    const file = backupFile({ idFloor: { set: -4, event: 2 ** 53 } })
    file.events.push({ id: 9007199254740000, matchId: 3, type: 'point' }, { id: 1e15, matchId: 3, type: 'point' }, { id: 12.5, matchId: 3, type: 'point' })
    expect(restoreIdFloor(file)).toEqual({ set: 2 + RESTORE_ID_MARGIN, event: N + RESTORE_ID_MARGIN })
  })
})
