// Restore and take-over never replace newer or unsent local data without
// asking (audit 2026-11: fe-backup-3/4/5/6/8, var-local-delete-1,
// fe-connect-devices-3), against the app's Dexie database on fake-indexeddb.
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
import {
  restoreMatchFromJson, restoreMatchInPlace, importMatchFromSupabase, readBackupFile,
  localLossOnReplace, continueWithLocalCopy, RESTORE_LOSES_LOCAL, BACKUP_FORMAT_ERROR, MAX_BACKUP_FILE_BYTES
} from '../backupManager'
import { takeBackScoring, markScorerMoved } from '../matchHandover'
import { unsentOfMatch } from '../deviceSelfCheck'

const seed = 'match_1792931096817_restoresafe'
const offline = { checkServer: async () => null, cloudLiveState: async () => null }
const ev = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, setIndex: 1, seq: i + 1, type: 'point', ts: '2026-11-01T10:00:00.000Z', payload: { team: 'home' } }))

function file({ events = 3, match = {}, ...rest } = {}) {
  return {
    version: 1,
    lastUpdated: '2026-11-01T10:00:00.000Z',
    match: { id: 3, seed_key: seed, status: 'live', gameN: 111111, ...match },
    homeTeam: { id: 1, name: 'Synthetic Home' },
    awayTeam: { id: 2, name: 'Synthetic Away' },
    homePlayers: [],
    awayPlayers: [],
    sets: [{ id: 1, index: 1, homePoints: events, awayPoints: 0, finished: false }],
    events: ev(events),
    ...rest
  }
}

async function localMatch({ events = 10, ...fields } = {}) {
  const id = await db.matches.add({ seed_key: seed, status: 'live', gameN: 111111, gamePin: '111111', refereePin: '222222', test: false, ...fields })
  for (const e of ev(events)) await db.events.add({ ...e, id: undefined, matchId: id })
  return id
}

beforeEach(async () => {
  await Promise.all(db.tables.map(t => t.clear()))
})

describe('Home restore over a newer local copy (fe-backup-4)', () => {
  it('is refused, nothing changed, naming the loss; done on the second confirmation', async () => {
    const id = await localMatch({ events: 10 })
    const err = await restoreMatchFromJson(file({ events: 3 }), offline).catch(e => e)
    expect(err?.code).toBe(RESTORE_LOSES_LOCAL)
    expect(err.loss).toMatchObject({ localEvents: 10, incomingEvents: 3, missingEvents: 7 })
    expect(await db.matches.get(id)).toBeTruthy()
    expect(await db.events.count()).toBe(10)

    const newId = await restoreMatchFromJson(file({ events: 3 }), { ...offline, replaceNewer: true })
    expect(await db.events.where('matchId').equals(newId).count()).toBe(3)
  })

  it('a file with every event of the local copy restores without asking', async () => {
    await localMatch({ events: 3 })
    expect(await restoreMatchFromJson(file({ events: 5 }), offline)).toBeGreaterThan(0)
  })

  it('unsent writes of the match count as a loss', async () => {
    await localMatch({ events: 3 })
    await db.sync_queue.add({ resource: 'event', action: 'insert', status: 'queued', payload: { match_id: seed, external_id: `${seed}_e_9` } })
    expect(await localLossOnReplace(seed, ev(5))).toMatchObject({ unsentChanges: 1 })
  })
})

describe('Home restore keeps the match insert and update jobs (fe-backup-3)', () => {
  it('its unsent update job stays, ahead of the restore job; set and event jobs go', async () => {
    await localMatch({ events: 0 })
    await db.sync_queue.add({ resource: 'match', action: 'update', status: 'queued', payload: { external_id: seed, officials: [{ role: 'scorer', lastName: 'Beispiel' }] } })
    await db.sync_queue.add({ resource: 'set', action: 'update', status: 'queued', payload: { match_id: seed, external_id: `${seed}_s_1` } })
    await restoreMatchFromJson(file({ events: 3 }), { ...offline, replaceNewer: true })
    const jobs = (await db.sync_queue.toArray()).sort((a, b) => a.id - b.id)
    expect(jobs.map(j => `${j.resource}:${j.action}`)).toEqual(['match:update', 'match:restore'])
  })
})

describe('a plain file over a local copy of the same match (fe-backup-6)', () => {
  it('test, PINs and session come from the local copy, and the closed check runs', async () => {
    await localMatch({ events: 0, sessionId: 'local-session' })
    const asked = []
    const id = await restoreMatchFromJson(file({ events: 3, match: { test: true, gamePin: '999999', refereePin: '888888', sessionId: 'file-session' } }), {
      checkServer: async (k) => { asked.push(k); return null }, cloudLiveState: async () => null
    })
    const m = await db.matches.get(id)
    expect([m.test, m.gamePin, m.refereePin, m.sessionId]).toEqual([false, '111111', '222222', 'local-session'])
    expect(asked).toEqual([seed])
    const restore = (await db.sync_queue.toArray()).find(j => j.action === 'restore')
    expect(restore.payload.match.game_pin).toBe('111111')
  })
})

describe('in-place restore of a file without a key (fe-backup-5)', () => {
  it('is refused over a keyed match, which keeps its key and events', async () => {
    const id = await localMatch({ events: 2 })
    const keyless = file({ events: 5, match: { seed_key: undefined, gameN: 222222 } })
    await expect(restoreMatchInPlace(id, keyless, { ...offline, replaceNewer: true })).rejects.toThrow(/different match/)
    expect((await db.matches.get(id)).seed_key).toBe(seed)
    expect(await db.events.where('matchId').equals(id).count()).toBe(2)
  })
})

describe('the shape and size of a backup file (fe-backup-8)', () => {
  it.each([
    ['a string as the match', { version: 1, match: 'hello', sets: [], events: [] }],
    ['events not a list', { ...file(), events: { a: 1 } }],
    ['events not objects', { ...file(), events: [null, 'x', 7] }]
  ])('%s: refused before any write', async (_, data) => {
    const id = await localMatch({ events: 2 })
    const err = await restoreMatchFromJson(data, offline).catch(e => e)
    expect(err?.code).toBe(BACKUP_FORMAT_ERROR)
    expect(await db.matches.get(id)).toBeTruthy()
    expect(await db.matches.count()).toBe(1)
  })

  it('a file over the limit is not read', async () => {
    const text = vi.fn(async () => '{}')
    await expect(readBackupFile({ size: MAX_BACKUP_FILE_BYTES + 1, text })).rejects.toMatchObject({ code: BACKUP_FORMAT_ERROR })
    expect(text).not.toHaveBeenCalled()
  })
})

describe('restore by game PIN over this device\'s own copy (var-local-delete-1)', () => {
  it('with unsent rallies here: refused, nothing set aside; replaced on the second confirmation', async () => {
    const id = await localMatch({ events: 38 })
    await db.sync_queue.add({ resource: 'event', action: 'insert', status: 'queued', payload: { match_id: seed, external_id: `${seed}_e_38` } })
    const cloud = { match: { external_id: seed, status: 'live', game_n: 111111 }, sets: [], events: ev(26).map(e => ({ ...e, set_index: 1 })) }
    const err = await importMatchFromSupabase(cloud).catch(e => e)
    expect(err?.code).toBe(RESTORE_LOSES_LOCAL)
    expect(await db.matches.get(id)).toBeTruthy()
    expect((await db.sync_queue.toArray()).map(j => j.status)).toEqual(['queued'])
  })
})

describe('"Take back scoring here" keeping this device\'s score (fe-connect-devices-3)', () => {
  it('the local copy stays, the block is lifted, and a restore of it is queued after the claim', async () => {
    const id = await localMatch({ events: 15 })
    await db.sync_queue.add({ resource: 'event', action: 'insert', status: 'queued', payload: { match_id: seed, external_id: `${seed}_e_15` } })
    await markScorerMoved(db, await db.matches.get(id), { scorer: { platform: 'web' } })
    const fetchCloud = vi.fn(async () => ({ match: { external_id: seed, status: 'live' }, sets: [], events: ev(12) }))
    const importCloud = vi.fn()
    const r = await takeBackScoring(db, id, {
      fetchCloud, importCloud, online: true,
      keepLocal: (mid) => continueWithLocalCopy(mid)
    })
    expect(r.ok).toBe(true)
    expect(importCloud).not.toHaveBeenCalled()
    expect(fetchCloud.mock.calls[0][2]).toMatchObject({ claim: true })
    const m = await db.matches.get(id)
    expect(m.cloudBlock).toBeNull()
    expect(await db.events.where('matchId').equals(id).count()).toBe(15)
    const restore = (await db.sync_queue.toArray()).find(j => j.action === 'restore' && j.status === 'queued')
    expect(restore.payload.events).toHaveLength(15)
  })
  it('the set-aside points go in the restore and are no longer counted as unsent', async () => {
    const id = await localMatch({ events: 15 })
    await db.sync_queue.add({ resource: 'event', action: 'insert', status: 'queued', payload: { match_id: seed, external_id: `${seed}_e_15` } })
    await markScorerMoved(db, await db.matches.get(id), { scorer: { platform: 'web' } })
    await continueWithLocalCopy(id, { checkServer: async () => null })
    const jobs = await db.sync_queue.toArray()
    expect(jobs.filter(j => j.resource === 'event')).toHaveLength(0)
    expect(unsentOfMatch(jobs, seed).events).toBe(0)
    expect(jobs.some(j => j.superseded_by)).toBe(false)
  })

  it('a match closed on the server meanwhile: the block stays and nothing set aside goes again', async () => {
    const id = await localMatch({ events: 15 })
    await db.sync_queue.add({ resource: 'match', action: 'update', status: 'queued', payload: { id: seed, external_id: seed } })
    await markScorerMoved(db, await db.matches.get(id), { scorer: { platform: 'web' } })
    const before = await db.sync_queue.toArray()
    const err = await continueWithLocalCopy(id, { checkServer: async () => true }).catch(e => e)
    expect(err?.code).toBe('OV_MATCH_CLOSED')
    expect((await db.matches.get(id)).cloudBlock).toBeTruthy()
    expect(await db.sync_queue.toArray()).toEqual(before)
  })

  it('a closed server copy loads as closed instead of keeping this device\'s score', async () => {
    const id = await localMatch({ events: 15 })
    await markScorerMoved(db, await db.matches.get(id), { scorer: { platform: 'web' } })
    const cloud = { match: { external_id: seed, status: 'final' }, sets: [], events: ev(12) }
    const keepLocal = vi.fn()
    const importCloud = vi.fn(async () => 99)
    const r = await takeBackScoring(db, id, { fetchCloud: async () => cloud, importCloud, keepLocal, online: true })
    expect(keepLocal).not.toHaveBeenCalled()
    expect(importCloud).toHaveBeenCalledWith(cloud)
    expect(r).toMatchObject({ ok: true, matchId: 99 })
  })
})
