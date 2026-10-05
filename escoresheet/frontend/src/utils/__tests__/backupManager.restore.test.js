import { describe, it, expect, vi, beforeEach } from 'vitest'

// In-memory stand-in for the Dexie tables the restore paths touch
function fakeTable(rows = []) {
  const map = new Map(rows.map(r => [r.id, { ...r }]))
  let nextId = Math.max(0, ...rows.map(r => r.id)) + 1
  const collection = (pred) => ({
    toArray: async () => [...map.values()].filter(pred).sort((a, b) => a.id - b.id),
    first: async () => [...map.values()].filter(pred)[0],
    delete: async () => {
      const ids = [...map.values()].filter(pred).map(r => r.id)
      ids.forEach(id => map.delete(id))
      return ids.length
    }
  })
  return {
    map,
    get: async (id) => map.get(id),
    add: async (row) => {
      const id = row.id ?? nextId++
      if (map.has(id)) throw new Error(`ConstraintError: key ${id} exists`)
      nextId = Math.max(nextId, id + 1)
      map.set(id, { ...row, id })
      return id
    },
    update: async (id, changes) => {
      const row = map.get(id)
      if (!row) return 0
      map.set(id, { ...row, ...changes })
      return 1
    },
    delete: async (id) => { map.delete(id) },
    bulkDelete: async (ids) => { ids.forEach(id => map.delete(id)) },
    clear: async () => { map.clear() },
    toArray: async () => [...map.values()],
    filter: (fn) => collection(fn),
    where: (field) => ({ equals: (value) => collection(r => r[field] === value) })
  }
}

const fakeDb = vi.hoisted(() => ({}))
vi.mock('../../db/db', () => ({ db: fakeDb }))
vi.mock('../backendConfig', () => ({ getApiUrl: (p) => `http://backend.test${p}` }))
vi.mock('../../lib/apiClient', () => ({ apiFrom: vi.fn(), apiStorage: { from: vi.fn() } }))

import { restoreMatchFromJson, restoreMatchInPlace } from '../backupManager'

const SEED = 'match_100_aaa'
const OTHER = 'match_200_bbb'

function backup(overrides = {}) {
  return {
    version: 1,
    match: { seed_key: SEED, status: 'live', gameN: 7, refereePin: '111111', homeTeamPin: '222222', ...overrides },
    homeTeam: { name: 'Home' },
    awayTeam: { name: 'Away' },
    homePlayers: [],
    awayPlayers: [],
    sets: [{ index: 1, homePoints: 25, awayPoints: 20, finished: true }, { index: 2, homePoints: 3, awayPoints: 1 }],
    events: [{ setIndex: 1, type: 'point', seq: 1 }]
  }
}

beforeEach(() => {
  fakeDb.matches = fakeTable([
    { id: 1, seed_key: OTHER, status: 'final' },
    { id: 2, seed_key: SEED, status: 'live' }
  ])
  fakeDb.sets = fakeTable([
    { id: 1, matchId: 1, index: 1 },
    { id: 2, matchId: 2, index: 1 }
  ])
  fakeDb.events = fakeTable([
    { id: 1, matchId: 1, type: 'point' },
    { id: 2, matchId: 2, type: 'point' }
  ])
  fakeDb.teams = fakeTable()
  fakeDb.players = fakeTable()
  fakeDb.sync_queue = fakeTable([
    { id: 1, resource: 'match', action: 'insert', status: 'queued', payload: { external_id: SEED } },
    { id: 2, resource: 'match', action: 'update', status: 'error', payload: { id: SEED, officials: [{ role: 'r1' }] } },
    { id: 3, resource: 'set', action: 'update', status: 'queued', payload: { external_id: `${SEED}:s:2`, home_points: 4 } },
    { id: 4, resource: 'event', action: 'insert', status: 'queued', payload: { external_id: `${SEED}:e:2`, match_id: SEED } },
    { id: 5, resource: 'event', action: 'insert', status: 'queued', payload: { external_id: `${OTHER}:e:1`, match_id: OTHER } },
    { id: 6, resource: 'match', action: 'update', status: 'sent', payload: { id: OTHER, status: 'final' } }
  ])
  fakeDb.transaction = async (...args) => args[args.length - 1]()
})

describe('restoreMatchFromJson', () => {
  it('replaces only this match: other local matches, their rows and jobs stay', async () => {
    const newId = await restoreMatchFromJson(backup())

    // the other match is untouched
    expect(fakeDb.matches.map.get(1)).toMatchObject({ seed_key: OTHER })
    expect(fakeDb.sets.map.get(1)).toMatchObject({ matchId: 1 })
    expect(fakeDb.events.map.get(1)).toMatchObject({ matchId: 1 })
    expect(fakeDb.sync_queue.map.get(5)).toBeDefined()
    expect(fakeDb.sync_queue.map.get(6)).toBeDefined()

    // the old copy of this match is gone, the restored one has a new id
    expect(fakeDb.matches.map.get(2)).toBeUndefined()
    expect(newId).not.toBe(1)
    expect(fakeDb.matches.map.get(newId)).toMatchObject({ seed_key: SEED })
    const restoredSets = [...fakeDb.sets.map.values()].filter(s => s.matchId === newId)
    expect(restoredSets).toHaveLength(2)
    expect([...fakeDb.sets.map.values()].some(s => s.matchId === 2)).toBe(false)

    // this match's old jobs are replaced by one restore job
    for (const id of [1, 2, 3, 4]) expect(fakeDb.sync_queue.map.get(id)).toBeUndefined()
    const restore = [...fakeDb.sync_queue.map.values()].find(j => j.action === 'restore')
    expect(restore.payload.match.external_id).toBe(SEED)
    expect(restore.payload.match.connection_pins).toEqual({ referee: '111111', bench_home: '222222' })
    // cloud set ids follow the new local ids
    expect(restore.payload.sets.map(s => s.external_id)).toEqual(restoredSets.map(s => `${SEED}:s:${s.id}`))
  })

  it('never queues a restore for a test match', async () => {
    await restoreMatchFromJson(backup({ test: true }))
    expect([...fakeDb.sync_queue.map.values()].some(j => j.action === 'restore')).toBe(false)
  })
})

describe('restoreMatchInPlace', () => {
  it('keeps pending match insert/update jobs; drops only this match\'s set/event jobs', async () => {
    await restoreMatchInPlace(2, backup())

    expect(fakeDb.sync_queue.map.get(1)).toMatchObject({ action: 'insert', status: 'queued' })
    expect(fakeDb.sync_queue.map.get(2)).toMatchObject({ action: 'update', status: 'error' })
    expect(fakeDb.sync_queue.map.get(3)).toBeUndefined()
    expect(fakeDb.sync_queue.map.get(4)).toBeUndefined()
    expect(fakeDb.sync_queue.map.get(5)).toBeDefined()

    const restore = [...fakeDb.sync_queue.map.values()].find(j => j.action === 'restore')
    // queued after the kept match jobs, so it runs after them
    expect(restore.id).toBeGreaterThan(2)
    expect(restore.payload.match.connection_pins).toEqual({ referee: '111111', bench_home: '222222' })
  })

  it('refuses a backup of another match', async () => {
    await expect(restoreMatchInPlace(2, backup({ seed_key: OTHER }))).rejects.toThrow(/different match/)
  })

  it('omits connection_pins when there are none, instead of sending {}', async () => {
    fakeDb.matches.map.set(2, { id: 2, seed_key: SEED })
    await restoreMatchInPlace(2, backup({ refereePin: undefined, homeTeamPin: undefined }))
    const restore = [...fakeDb.sync_queue.map.values()].find(j => j.action === 'restore')
    expect('connection_pins' in restore.payload.match).toBe(false)
  })
})
