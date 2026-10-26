import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// ---------------------------------------------------------------------------
// In-memory stand-ins for the Dexie tables and the /api/db client
// ---------------------------------------------------------------------------

function fakeTable(rows = []) {
  const map = new Map(rows.map(r => [r.id, { ...r }]))
  const collection = (pred) => ({
    toArray: async () => [...map.values()].filter(pred).sort((a, b) => a.id - b.id),
    first: async () => [...map.values()].filter(pred)[0],
    count: async () => [...map.values()].filter(pred).length,
    and: (fn) => collection(r => pred(r) && fn(r))
  })
  return {
    map,
    reset(newRows) {
      map.clear()
      for (const r of newRows) map.set(r.id, { ...r })
    },
    get: async (id) => map.get(id),
    toArray: async () => [...map.values()].sort((a, b) => a.id - b.id),
    add: async (row) => {
      const id = Math.max(0, ...map.keys()) + 1
      map.set(id, { ...row, id })
      return id
    },
    update: async (id, changes) => {
      const row = map.get(id)
      if (!row) return 0
      map.set(id, { ...row, ...changes })
      return 1
    },
    where: (field) => ({
      equals: (value) => collection(r => r[field] === value),
      anyOf: (...values) => collection(r => values.flat().includes(r[field]))
    }),
    filter: (fn) => collection(fn),
    bulkGet: async (ids) => ids.map(id => map.get(id)),
    bulkDelete: async (ids) => { for (const id of ids) map.delete(id) },
    hook: () => {}
  }
}

// Module load installs a Dexie 'creating' hook on sync_queue
const fakeDb = vi.hoisted(() => ({ sync_queue: { hook: () => {} } }))
vi.mock('../../db/db', () => ({ db: fakeDb }))

// Dexie's live queries only observe real Dexie tables: run the query once per
// dependency change against the fakes instead
vi.mock('dexie-react-hooks', async () => {
  const { useState, useEffect } = await import('react')
  return {
    useLiveQuery: (query, deps = [], initial) => {
      const [value, setValue] = useState(initial)
      useEffect(() => {
        let alive = true
        Promise.resolve(query()).then(v => { if (alive) setValue(v) })
        return () => { alive = false }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, deps)
      return value
    }
  }
})

// Every apiFrom call is recorded; `respond` decides the result.
// apiMatchRestore (POST /api/match/restore) is recorded as a call on table '__restore'.
const api = vi.hoisted(() => ({ calls: [], respond: null }))
vi.mock('../../lib/apiClient', () => {
  function builder(table) {
    const call = { table, action: null, data: null, filters: [], returning: null }
    const b = {
      select(cols) {
        if (call.action) call.returning = cols || '*'
        else { call.action = 'select'; call.columns = cols }
        return b
      },
      insert(d) { call.action = 'insert'; call.data = d; return b },
      upsert(d, o) { call.action = 'upsert'; call.data = d; call.onConflict = o?.onConflict; return b },
      update(d) { call.action = 'update'; call.data = d; return b },
      delete() { call.action = 'delete'; return b },
      eq(c, v) { call.filters.push(['eq', c, v]); return b },
      in(c, v) { call.filters.push(['in', c, v]); return b },
      limit() { return b },
      single() { return b },
      maybeSingle() { call.maybeSingle = true; return b },
      then(resolve, reject) {
        api.calls.push(call)
        return Promise.resolve()
          .then(() => api.respond(call))
          .then(resolve, reject)
      }
    }
    return b
  }
  return {
    AUTH_TOKEN_CHANGE_EVENT: 'api-auth-token-change',
    AUTH_TOKEN_STORAGE_KEY: 'api_auth_token',
    apiFrom: (table) => builder(table),
    apiMatchRestore: async (payload) => {
      const call = { table: '__restore', action: 'restore', data: payload, filters: [] }
      api.calls.push(call)
      return api.respond(call)
    },
    apiMatchClaim: async (externalId, pin) => {
      const call = { table: '__claim', action: 'claim', data: { externalId, pin }, filters: [] }
      api.calls.push(call)
      return api.respond(call)
    },
    apiPostActivity: async (entries) => {
      const call = { table: '__activity', action: 'post', data: entries, filters: [] }
      api.calls.push(call)
      return api.respond(call)
    },
    apiMatchScorer: async (externalId, opts) => {
      const call = { table: '__scorer', action: opts?.claim === false ? 'status' : 'claim', data: { externalId }, filters: [] }
      api.calls.push(call)
      return api.respond(call)
    },
    apiPostEventRevisions: async (matchExternalId, revisions) => {
      const call = { table: '__revisions', action: 'post', data: { matchExternalId, revisions }, filters: [] }
      api.calls.push(call)
      return api.respond(call)
    }
  }
})

vi.mock('../../utils/backendConfig', () => ({ getApiUrl: (p) => `http://backend.test${p}`, getCloudApiUrl: (p) => `http://backend.test${p}` }))

import {
  runQueuePass,
  retryErrorsInternal,
  payloadCovers,
  errorBackoffMs,
  isAuthError,
  isPermanentError,
  redactForLog,
  getSyncQueueStats,
  clearAuthBlock,
  resetQueueHousekeeping,
  pruneSyncQueue,
  hasApplicationErrorCode,
  useSyncQueue,
  queueUserMatchLinks,
  storedSessionUserId,
  useUserMatchLink,
  processJob,
  takeJobError,
  probeErrorStatus,
  STOP_PASS,
  resetCloudBlockCache,
  isClosingJob,
  CLOUD_BLOCK_EVENT,
  matchEndUpdateNeeded,
  checkScorerMoved
} from '../useSyncQueue'
import { queueAndWait, useSequentialSync } from '../useSequentialSync'

const MATCH_UUID = '11111111-2222-4333-8444-555555555555'
const ok = (data = null) => ({ data, error: null })

// Default backend: the match exists, every write succeeds
function defaultRespond(call) {
  if (call.table === 'matches' && call.action === 'select') return ok({ id: MATCH_UUID })
  return ok()
}

beforeEach(() => {
  fakeDb.transaction = async (...args) => args[args.length - 1]()
  fakeDb.sync_queue = fakeTable()
  fakeDb.matches = fakeTable([{ id: 1, seed_key: 'match_100_aaa', refereePin: '111111', homeTeamPin: '222222', awayTeamPin: '333333', homeTeamUploadPin: '444444' }])
  fakeDb.sets = fakeTable([{ id: 5, matchId: 1, index: 1 }])
  fakeDb.events = fakeTable([{ id: 9, matchId: 1, type: 'coin_toss' }])
  api.calls = []
  api.respond = defaultRespond
  clearAuthBlock()
  resetQueueHousekeeping()
})

describe('runQueuePass', () => {
  it('sends an event delete (a correction removed the event) by its namespaced external_id', async () => {
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'event', action: 'insert', status: 'queued', retry_count: 0, payload: { external_id: 'match_100_aaa:e:7', match_id: 'match_100_aaa', seq: 8 } },
      { id: 2, resource: 'event', action: 'delete', status: 'queued', retry_count: 0, payload: { external_id: 'match_100_aaa:e:4', match_id: 'match_100_aaa' } }
    ])
    await runQueuePass()
    const del = api.calls.find(c => c.table === 'events' && c.action === 'delete')
    expect(del.filters).toEqual([['eq', 'external_id', 'match_100_aaa:e:4']])
    expect(fakeDb.sync_queue.map.get(1).status).toBe('sent')
    expect(fakeDb.sync_queue.map.get(2).status).toBe('sent')
  })

  it('deleting a match that is closed on the server is done: the server keeps it, the job is not refused', async () => {
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'match', action: 'delete', status: 'queued', retry_count: 0, payload: { id: 'match_100_aaa' } }
    ])
    const closed = { data: null, error: { message: 'Match is closed', code: 'OV_MATCH_CLOSED', status: 409 } }
    api.respond = (call) => (call.action === 'delete' ? closed : defaultRespond(call))
    const outcome = await runQueuePass()
    expect(api.calls.some(c => c.table === 'matches' && c.action === 'delete')).toBe(true)
    expect(fakeDb.sync_queue.map.get(1).status).toBe('sent')
    expect(outcome.hasFailed).toBeFalsy()
    expect(fakeDb.matches.map.get(1).cloudBlock).toBeFalsy()
  })

  it('a write refused as OV_NOT_MATCH_OWNER takes the match over with the local game PIN, then is sent', async () => {
    fakeDb.matches.reset([{ id: 1, seed_key: 'match_100_aaa', gamePin: '864201' }])
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'event', action: 'insert', status: 'queued', retry_count: 0, payload: { external_id: 'match_100_aaa:e:1', match_id: 'match_100_aaa' } },
      { id: 2, resource: 'event', action: 'insert', status: 'queued', retry_count: 0, payload: { external_id: 'match_100_aaa:e:2', match_id: 'match_100_aaa' } }
    ])
    let claimed = false
    api.respond = (call) => {
      if (call.table === '__claim') {
        claimed = true
        return { data: { role: 'editor' }, error: null, status: 200 }
      }
      if (call.action === 'upsert' && !claimed) return { data: null, error: { message: 'Database operation failed', code: 'OV_NOT_MATCH_OWNER', status: 403 } }
      return defaultRespond(call)
    }
    const outcome = await runQueuePass()
    const claims = api.calls.filter(c => c.table === '__claim')
    expect(claims).toEqual([{ table: '__claim', action: 'claim', data: { externalId: 'match_100_aaa', pin: '864201' }, filters: [] }])
    expect(fakeDb.sync_queue.map.get(1).status).toBe('sent')
    expect(fakeDb.sync_queue.map.get(2).status).toBe('sent')
    expect(outcome.hasFailed).toBe(false)
  })

  it('without the game PIN, or when the take-over is refused, the job is parked as failed (one claim per pass)', async () => {
    fakeDb.matches.reset([{ id: 1, seed_key: 'match_100_aaa', gamePin: '864201' }])
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'event', action: 'insert', status: 'queued', payload: { external_id: 'match_100_aaa:e:1', match_id: 'match_100_aaa' } },
      { id: 2, resource: 'event', action: 'insert', status: 'queued', payload: { external_id: 'match_100_aaa:e:2', match_id: 'match_100_aaa' } }
    ])
    api.respond = (call) => {
      if (call.table === '__claim') return { data: null, error: { code: 'OV_NOT_FOUND', status: 404 }, status: 404 }
      if (call.action === 'upsert') return { data: null, error: { message: 'Database operation failed', code: 'OV_NOT_MATCH_OWNER', status: 403 } }
      return defaultRespond(call)
    }
    await runQueuePass()
    expect(api.calls.filter(c => c.table === '__claim')).toHaveLength(1)
    expect(fakeDb.sync_queue.map.get(1).status).toBe('failed')

    // No local game PIN: no claim at all
    fakeDb.matches.reset([{ id: 1, seed_key: 'match_100_aaa' }])
    fakeDb.sync_queue.reset([
      { id: 3, resource: 'event', action: 'insert', status: 'queued', payload: { external_id: 'match_100_aaa:e:3', match_id: 'match_100_aaa' } }
    ])
    api.calls = []
    await runQueuePass()
    expect(api.calls.filter(c => c.table === '__claim')).toHaveLength(0)
    expect(fakeDb.sync_queue.map.get(3).status).toBe('failed')
  })

  it('processJob itself takes over (the direct set-end / match-end sync too) and requeues the match\'s parked jobs', async () => {
    fakeDb.matches.reset([{ id: 1, seed_key: 'match_100_aaa', gamePin: '864201' }])
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'event', action: 'insert', status: 'failed', payload: { external_id: 'match_100_aaa:e:1', match_id: 'match_100_aaa' } },
      { id: 2, resource: 'event', action: 'insert', status: 'failed', payload: { external_id: 'match_other:e:1', match_id: 'match_other' } },
      { id: 3, resource: 'set', action: 'insert', status: 'sending', payload: { external_id: 'match_100_aaa:s:2', match_id: 'match_100_aaa', index: 2 } }
    ])
    let claimed = false
    api.respond = (call) => {
      if (call.table === '__claim') {
        claimed = true
        return { data: { role: 'editor' }, error: null, status: 200 }
      }
      if (call.action === 'upsert' && !claimed) return { data: null, error: { message: 'Database operation failed', code: 'OV_NOT_MATCH_OWNER', status: 403 } }
      return defaultRespond(call)
    }
    const job = fakeDb.sync_queue.map.get(3)
    expect(await processJob(job)).toBe(true)
    expect(takeJobError(3)).toBeNull()
    expect(api.calls.filter(c => c.table === '__claim')).toHaveLength(1)
    expect(fakeDb.sync_queue.map.get(1).status).toBe('queued')
    expect(fakeDb.sync_queue.map.get(2).status).toBe('failed', 'another match stays parked')

    // A refused take-over is not repeated by every job within the minute
    claimed = false
    api.calls = []
    api.respond = (call) => {
      if (call.table === '__claim') return { data: null, error: { code: 'OV_NOT_FOUND', status: 404 }, status: 404 }
      if (call.action === 'upsert') return { data: null, error: { message: 'Database operation failed', code: 'OV_NOT_MATCH_OWNER', status: 403 } }
      return defaultRespond(call)
    }
    resetQueueHousekeeping()
    const other = { id: 9, resource: 'event', action: 'insert', status: 'sending', payload: { external_id: 'match_100_aaa:e:9', match_id: 'match_100_aaa' } }
    await processJob(other)
    await processJob({ ...other, id: 10 })
    expect(api.calls.filter(c => c.table === '__claim')).toHaveLength(1)
  })

  it('a 429 leaves the job queued untouched and stops the pass', async () => {
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'event', action: 'insert', status: 'queued', retry_count: 0, payload: { external_id: 'match_100_aaa:e:1', match_id: 'match_100_aaa' } },
      { id: 2, resource: 'event', action: 'insert', status: 'queued', retry_count: 0, payload: { external_id: 'match_100_aaa:e:2', match_id: 'match_100_aaa' } }
    ])
    api.respond = (call) => {
      if (call.action === 'upsert') return { data: null, error: { message: 'Too many requests', status: 429 } }
      return defaultRespond(call)
    }

    const outcome = await runQueuePass()

    expect(outcome.stopped).toBe(true)
    expect(fakeDb.sync_queue.map.get(1)).toMatchObject({ status: 'queued', retry_count: 0 })
    expect(fakeDb.sync_queue.map.get(2)).toMatchObject({ status: 'queued', retry_count: 0 })
    // the second event was never sent
    expect(api.calls.filter(c => c.action === 'upsert')).toHaveLength(1)
  })

  it('a network failure leaves the job queued and stops the pass', async () => {
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'event', action: 'insert', status: 'queued', payload: { external_id: 'match_100_aaa:e:1', match_id: 'match_100_aaa' } }
    ])
    api.respond = () => { throw new TypeError('Failed to fetch') }

    const outcome = await runQueuePass()
    expect(outcome.stopped).toBe(true)
    expect(fakeDb.sync_queue.map.get(1).status).toBe('queued')
  })

  it('a 5xx is retried later, not marked as an error', async () => {
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'event', action: 'insert', status: 'queued', retry_count: 0, payload: { external_id: 'match_100_aaa:e:1', match_id: 'match_100_aaa' } }
    ])
    api.respond = (call) => (call.action === 'upsert' ? { data: null, error: { message: 'Database operation failed', status: 503 } } : defaultRespond(call))

    const outcome = await runQueuePass()
    expect(outcome.hasError).toBe(false)
    expect(fakeDb.sync_queue.map.get(1)).toMatchObject({ status: 'queued', retry_count: 1 })
  })

  it('a refused set insert holds back the later update of the same set (per-entity FIFO)', async () => {
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'set', action: 'insert', status: 'queued', payload: { external_id: 'match_100_aaa:s:5', match_id: 'match_100_aaa', index: 1 } },
      { id: 2, resource: 'set', action: 'update', status: 'queued', payload: { external_id: 'match_100_aaa:s:5', finished: true } }
    ])
    api.respond = (call) => (call.table === 'sets' && call.action === 'upsert'
      ? { data: null, error: { message: 'Database operation failed', code: 'OV_INVALID_DATA', status: 400 } }
      : defaultRespond(call))

    const outcome = await runQueuePass()
    expect(outcome.hasError).toBe(true)
    expect(outcome.hasFailed).toBe(true)
    expect(fakeDb.sync_queue.map.get(1).status).toBe('failed')
    expect(fakeDb.sync_queue.map.get(1).attempts).toBe(1)
    expect(fakeDb.sync_queue.map.get(2).status).toBe('queued')
    expect(api.calls.some(c => c.table === 'sets' && c.action === 'update')).toBe(false)
  })

  it('an errored set insert holds back newer jobs of that set in later passes (#58)', async () => {
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'set', action: 'insert', status: 'error', attempts: 1, next_attempt_at: Date.now() + 30000, payload: { external_id: 'match_100_aaa:s:5', match_id: 'match_100_aaa', index: 1 } },
      { id: 2, resource: 'set', action: 'update', status: 'queued', payload: { external_id: 'match_100_aaa:s:5', home_points: 25, finished: true } },
      // another set of the same match is not held back
      { id: 3, resource: 'set', action: 'update', status: 'queued', payload: { external_id: 'match_100_aaa:s:6', home_points: 3 } }
    ])

    const outcome = await runQueuePass()
    expect(outcome.hasRetry).toBe(true)
    expect(fakeDb.sync_queue.map.get(2).status).toBe('queued')
    expect(fakeDb.sync_queue.map.get(3).status).toBe('sent')
    const updates = api.calls.filter(c => c.table === 'sets' && c.action === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].data).toEqual({ home_points: 3, sport_type: 'indoor' })
  })

  it('an errored match insert holds back every newer job of that match', async () => {
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'match', action: 'insert', status: 'error', payload: { external_id: 'match_100_aaa' } },
      { id: 2, resource: 'event', action: 'insert', status: 'queued', payload: { external_id: 'match_100_aaa:e:1', match_id: 'match_100_aaa' } },
      { id: 3, resource: 'event', action: 'insert', status: 'queued', payload: { external_id: 'match_200_bbb:e:1', match_id: 'match_200_bbb' } }
    ])
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(2).status).toBe('queued')
    expect(fakeDb.sync_queue.map.get(3).status).toBe('sent')
  })

  it('a job claimed as "sending" holds back newer jobs of the same set', async () => {
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'set', action: 'update', status: 'sending', sending_since: Date.now(), payload: { external_id: 'match_100_aaa:s:5', finished: true } },
      { id: 2, resource: 'set', action: 'update', status: 'queued', payload: { external_id: 'match_100_aaa:s:5', home_points: 1 } }
    ])
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(2).status).toBe('queued')
    expect(api.calls.some(c => c.table === 'sets' && c.action === 'update')).toBe(false)
  })

  it('an errored update does not stall newer updates of the same row', async () => {
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'set', action: 'update', status: 'error', payload: { external_id: 'match_100_aaa:s:5', home_points: 10 } },
      { id: 2, resource: 'set', action: 'update', status: 'queued', payload: { external_id: 'match_100_aaa:s:5', home_points: 11 } }
    ])
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(2).status).toBe('sent')
  })

  it('a queued job older than the errored one is not held back', async () => {
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'set', action: 'update', status: 'queued', payload: { external_id: 'match_100_aaa:s:5', home_points: 1 } },
      { id: 2, resource: 'set', action: 'insert', status: 'error', payload: { external_id: 'match_100_aaa:s:5', match_id: 'match_100_aaa', index: 1 } }
    ])
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(1).status).toBe('sent')
  })

  it('namespaces a bare set id and scopes the set update to its match', async () => {
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'set', action: 'update', status: 'queued', payload: { external_id: '5', finished: true } }
    ])

    await runQueuePass()

    expect(fakeDb.sync_queue.map.get(1).status).toBe('sent')
    expect(fakeDb.sync_queue.map.get(1).payload.external_id).toBe('match_100_aaa:s:5')
    const update = api.calls.find(c => c.table === 'sets' && c.action === 'update')
    expect(update.data).toEqual({ finished: true, sport_type: 'indoor' })
    expect(update.filters).toEqual([
      ['eq', 'match_id', MATCH_UUID],
      ['in', 'external_id', ['match_100_aaa:s:5', '5']]
    ])
  })

  it('drops a set/event job that cannot be attributed to a match', async () => {
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'event', action: 'insert', status: 'queued', payload: { external_id: '41' } }
    ])
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(1).status).toBe('dropped')
    expect(api.calls.some(c => c.table === 'events')).toBe(false)
  })

  it('sends connection_pins whole from the local match, never a read-merge', async () => {
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'match', action: 'update', status: 'queued', payload: { id: 'match_100_aaa', connection_pins: { referee: '111111' } } }
    ])

    await runQueuePass()

    expect(api.calls.some(c => c.table === 'matches' && c.action === 'select')).toBe(false)
    const update = api.calls.find(c => c.table === 'matches' && c.action === 'update')
    expect(update.data.connection_pins).toEqual({
      referee: '111111',
      bench_home: '222222',
      bench_away: '333333',
      upload_home: '444444'
    })
    expect(fakeDb.sync_queue.map.get(1).status).toBe('sent')
  })

  const restoreJob = () => ({
    id: 1,
    resource: 'match',
    action: 'restore',
    status: 'queued',
    payload: {
      match: { external_id: 'match_100_aaa', status: 'live', not_a_column: 1 },
      sets: [{ external_id: 'match_100_aaa:s:1', index: 1 }],
      events: [{ external_id: 'match_100_aaa:e:1', seq: 1 }],
      liveState: { match_status: 'live' }
    }
  })

  it('restore is ONE /api/match/restore call (no client-side delete/upsert steps)', async () => {
    fakeDb.sync_queue.reset([restoreJob()])
    api.respond = (call) => (call.table === '__restore'
      ? ok({ id: MATCH_UUID, counts: { sets: 1, events: 1, liveState: 1 } })
      : defaultRespond(call))

    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(1).status).toBe('sent')
    expect(api.calls.map(c => c.table)).toEqual(['__restore'])
    const sent = api.calls[0].data
    expect(sent.match.external_id).toBe('match_100_aaa')
    expect(sent.match.not_a_column).toBeUndefined()
    expect(sent.sets).toHaveLength(1)
    expect(sent.events).toHaveLength(1)
    expect(sent.liveState).toEqual({ match_status: 'live' })
  })

  it('restore refused by the server (400, rolled back) is parked as failed', async () => {
    fakeDb.sync_queue.reset([restoreJob()])
    api.respond = (call) => (call.table === '__restore'
      ? { data: null, error: { message: 'Database operation failed', code: 'OV_UNSCOPED_EXTERNAL_ID', status: 400 } }
      : defaultRespond(call))

    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(1)).toMatchObject({ status: 'failed', last_error: { status: 400, code: 'OV_UNSCOPED_EXTERNAL_ID' } })
  })

  it('restore that throws (no HTTP answer) is retried with backoff', async () => {
    fakeDb.sync_queue.reset([restoreJob()])
    api.respond = (call) => {
      if (call.table === '__restore') throw new Error('boom')
      return defaultRespond(call)
    }
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(1).status).toBe('error')
    expect(fakeDb.sync_queue.map.get(1).next_attempt_at).toBeGreaterThan(Date.now())
  })

  it('restore stays queued on 426 (old bundle) and 5xx', async () => {
    for (const status of [426, 503]) {
      fakeDb.sync_queue.reset([restoreJob()])
      api.respond = (call) => (call.table === '__restore'
        ? { data: null, error: { message: 'x', status } }
        : defaultRespond(call))
      await runQueuePass()
      const job = fakeDb.sync_queue.map.get(1)
      expect(job.status, String(status)).toBe('queued')
      expect(job.retry_count, String(status)).toBe(1)
    }
  })
})

describe('event history jobs (void / edit / restore)', () => {
  const voidJob = (id, extra = {}) => ({
    id, resource: 'event', action: 'void', status: 'queued',
    payload: { external_id: 'match_100_aaa:e:1', match_id: 'match_100_aaa', rev_uid: `rev-${id}`, op: 'void', reason: 'undo', seq: 3, set_index: 1, type: 'point', client_ts: '2026-10-07T10:00:00.000Z', ...extra }
  })

  it('posts the revision to /api/match/event-revisions, after the event insert of the same event', async () => {
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'event', action: 'insert', status: 'queued', payload: { external_id: 'match_100_aaa:e:1', match_id: 'match_100_aaa' } },
      voidJob(2)
    ])
    const outcome = await runQueuePass()
    expect(outcome.sent).toBe(2)
    expect(api.calls.map(c => c.table)).toEqual(['matches', 'events', '__revisions'])
    const rev = api.calls[2].data
    expect(rev.matchExternalId).toBe('match_100_aaa')
    expect(rev.revisions).toEqual([expect.objectContaining({ rev_uid: 'rev-2', op: 'void', event_external_id: 'match_100_aaa:e:1', reason: 'undo' })])
  })

  it('waits behind its errored insert (per-entity order)', async () => {
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'event', action: 'insert', status: 'error', next_attempt_at: Date.now() + 60000, payload: { external_id: 'match_100_aaa:e:1', match_id: 'match_100_aaa' } },
      voidJob(2)
    ])
    await runQueuePass()
    expect(api.calls.filter(c => c.table === '__revisions')).toHaveLength(0)
    expect(fakeDb.sync_queue.map.get(2).status).toBe('queued')
  })

  it('a server without the route (404) parks the job as failed; a match not on the server yet is retried', async () => {
    fakeDb.sync_queue.reset([voidJob(1)])
    api.respond = (call) => (call.table === '__revisions' ? { data: null, error: { message: 'Not found', status: 404 }, status: 404 } : defaultRespond(call))
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(1)).toMatchObject({ status: 'failed', last_error: expect.objectContaining({ code: 'OV_ROUTE_MISSING' }) })

    fakeDb.sync_queue.reset([voidJob(1)])
    api.respond = (call) => (call.table === '__revisions' ? { data: null, error: { message: 'No match', status: 404, code: 'OV_MATCH_NOT_FOUND' }, status: 404 } : defaultRespond(call))
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(1)).toMatchObject({ status: 'queued', retry_count: 1 })
  })

  it('a closed match (409) sets the revision aside like any event write, no lasting refusal', async () => {
    resetCloudBlockCache()
    fakeDb.sync_queue.reset([voidJob(1)])
    api.respond = (call) => (call.table === '__revisions' ? { data: null, error: { message: 'closed', status: 409, code: 'OV_MATCH_CLOSED' }, status: 409 } : defaultRespond(call))
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(1)).toMatchObject({ status: 'dropped', superseded_by: 'server-closed' })
    expect(await getSyncQueueStats()).toEqual({ pending: 0, error: 0, failed: 0 })
  })

  it('a closing update waits for a pending void of its match', async () => {
    fakeDb.sync_queue.reset([
      voidJob(1, {}),
      { id: 2, resource: 'match', action: 'update', status: 'queued', payload: { id: 'match_100_aaa', status: 'final' } }
    ])
    fakeDb.sync_queue.map.get(1).status = 'error'
    fakeDb.sync_queue.map.get(1).next_attempt_at = Date.now() + 60000
    await runQueuePass()
    expect(api.calls.filter(c => c.table === 'matches' && c.action === 'update')).toHaveLength(0)
  })
})

describe('activity log upload job', () => {
  it('runs after the match jobs; a server without the route parks it as failed', async () => {
    fakeDb.activity_log = undefined
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'activity', action: 'flush', status: 'queued', payload: {} },
      { id: 2, resource: 'match', action: 'update', status: 'queued', payload: { id: 'match_100_aaa', status: 'live' } }
    ])
    const outcome = await runQueuePass()
    expect(outcome.sent).toBe(2)
    expect(api.calls.map(c => c.table)).toEqual(['matches']) // no rows: no upload request
  })
})

describe('retryErrorsInternal', () => {
  it('marks a stale errored match update as superseded by a newer sent one', async () => {
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'match', action: 'update', status: 'error', payload: { id: 'match_100_aaa', status: 'live', match_info: { hall: 'A' } } },
      { id: 2, resource: 'match', action: 'update', status: 'sent', payload: { id: 'match_100_aaa', status: 'ended', match_info: { hall: 'B', city: 'Z' } } }
    ])

    await retryErrorsInternal({ force: true })
    expect(fakeDb.sync_queue.map.get(1).status).toBe('superseded')
  })

  it('keeps only the fields no newer sent update wrote', async () => {
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'match', action: 'update', status: 'error', payload: { id: 'match_100_aaa', status: 'live', winner: 'home', match_info: { hall: 'A', city: 'Y' } } },
      { id: 2, resource: 'match', action: 'update', status: 'sent', payload: { id: 'match_100_aaa', status: 'ended', match_info: { hall: 'B' } } }
    ])

    await retryErrorsInternal({ force: true })
    const job = fakeDb.sync_queue.map.get(1)
    expect(job.status).toBe('queued')
    // the stale 'live' must not be replayed over 'ended'
    expect(job.payload).toEqual({ id: 'match_100_aaa', winner: 'home', match_info: { city: 'Y' } })
  })

  it('ignores sent updates of other matches and older ones', async () => {
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'match', action: 'update', status: 'sent', payload: { id: 'match_100_aaa', status: 'setup' } },
      { id: 2, resource: 'match', action: 'update', status: 'error', payload: { id: 'match_100_aaa', status: 'live' } },
      { id: 3, resource: 'match', action: 'update', status: 'sent', payload: { id: 'match_200_bbb', status: 'ended' } }
    ])

    await retryErrorsInternal({ force: true })
    expect(fakeDb.sync_queue.map.get(2)).toMatchObject({ status: 'queued', payload: { id: 'match_100_aaa', status: 'live' } })
  })

  it('trims a stale errored set update against a newer sent one', async () => {
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'set', action: 'update', status: 'error', payload: { external_id: 'match_100_aaa:s:5', home_points: 10, sport_type: 'indoor' } },
      { id: 2, resource: 'set', action: 'update', status: 'sent', payload: { external_id: 'match_100_aaa:s:5', home_points: 12, sport_type: 'indoor' } },
      { id: 3, resource: 'set', action: 'update', status: 'error', payload: { external_id: 'match_100_aaa:s:5', away_points: 4 } },
      { id: 4, resource: 'set', action: 'update', status: 'sent', payload: { external_id: 'match_100_aaa:s:5', home_points: 13, finished: true } },
      { id: 5, resource: 'set', action: 'update', status: 'error', payload: { external_id: 'match_100_aaa:s:6', home_points: 2, finished: false } },
      { id: 6, resource: 'set', action: 'update', status: 'sent', payload: { external_id: 'match_100_aaa:s:6', home_points: 3 } }
    ])

    await retryErrorsInternal({ force: true })
    expect(fakeDb.sync_queue.map.get(1).status).toBe('superseded')
    expect(fakeDb.sync_queue.map.get(3)).toMatchObject({ status: 'queued', payload: { external_id: 'match_100_aaa:s:5', away_points: 4 } })
    expect(fakeDb.sync_queue.map.get(5)).toMatchObject({ status: 'queued', payload: { external_id: 'match_100_aaa:s:6', finished: false } })
    expect(fakeDb.sync_queue.map.get(5).payload.home_points).toBeUndefined()
  })

  it('respects each job\'s backoff unless forced', async () => {
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'event', action: 'insert', status: 'error', next_attempt_at: Date.now() + 60000, payload: {} },
      { id: 2, resource: 'event', action: 'insert', status: 'error', next_attempt_at: Date.now() - 1, payload: {} }
    ])

    await retryErrorsInternal()
    expect(fakeDb.sync_queue.map.get(1).status).toBe('error')
    expect(fakeDb.sync_queue.map.get(2).status).toBe('queued')

    await retryErrorsInternal({ force: true })
    expect(fakeDb.sync_queue.map.get(1).status).toBe('queued')
  })

  it('hands back abandoned "sending" jobs', async () => {
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'set', action: 'update', status: 'sending', sending_since: Date.now() - 10 * 60 * 1000, payload: {} },
      { id: 2, resource: 'set', action: 'update', status: 'sending', sending_since: Date.now(), payload: {} }
    ])
    await retryErrorsInternal()
    expect(fakeDb.sync_queue.map.get(1).status).toBe('queued')
    expect(fakeDb.sync_queue.map.get(2).status).toBe('sending')
  })
})

describe('helpers', () => {
  it('payloadCovers compares fields and JSON sub-keys', () => {
    expect(payloadCovers({ id: 'x', a: 1, j: { p: 1, q: 2 } }, { id: 'x', a: 0, j: { p: 0 } })).toBe(true)
    expect(payloadCovers({ id: 'x', a: 1 }, { id: 'x', a: 0, b: 1 })).toBe(false)
    expect(payloadCovers({ id: 'x', j: { p: 1 } }, { id: 'x', j: { q: 1 } })).toBe(false)
  })

  it('error backoff grows and is capped', () => {
    expect(errorBackoffMs(1)).toBe(30000)
    expect(errorBackoffMs(2)).toBe(60000)
    expect(errorBackoffMs(50)).toBe(10 * 60 * 1000)
  })

  it('exports the stop marker', () => {
    expect(STOP_PASS).toBe('stop')
  })

  it('a probe 404 (LAN relay without /api/db) is "no cloud backend", not an error', () => {
    expect(probeErrorStatus({ status: 404, message: 'Not found' })).toBe('online_no_supabase')
    expect(probeErrorStatus({ network: true, status: 0 })).toBe('offline')
    expect(probeErrorStatus({ code: '42P01', status: 400 })).toBe('online_no_supabase')
    expect(probeErrorStatus({ status: 500, message: 'boom' })).toBe('error')
    expect(probeErrorStatus({ status: 401, message: 'unauthorized' })).toBe('error')
  })
})

// ---------------------------------------------------------------------------
// E2E findings: coin toss id, permanent 4xx, sign-in required, auto-retry
// ---------------------------------------------------------------------------

describe('legacy coin toss jobs', () => {
  it('a queued coin_toss_<seed> job is sent as <seed>:e:<local coin toss event id>', async () => {
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'event', action: 'insert', status: 'queued', payload: { external_id: 'coin_toss_match_100_aaa', match_id: 'match_100_aaa', type: 'coin_toss', set_index: 1 } }
    ])
    await runQueuePass()
    const upsert = api.calls.find(c => c.table === 'events' && c.action === 'upsert')
    expect(upsert.data.external_id).toBe('match_100_aaa:e:9')
    expect(fakeDb.sync_queue.map.get(1)).toMatchObject({ status: 'sent', payload: { external_id: 'match_100_aaa:e:9' } })
  })
})

describe('failure classes', () => {
  it('classifies 401 as sign-in required and 4xx with a backend error code as permanent', () => {
    expect(isAuthError({ status: 401, code: 'missing_token' })).toBe(true)
    expect(isAuthError({ status: 0, network: true })).toBe(false)
    expect(isPermanentError({ status: 400, code: 'OV_UNSCOPED_EXTERNAL_ID' })).toBe(true)
    expect(isPermanentError({ status: 406, code: 'PGRST116' })).toBe(true)
    expect(isPermanentError({ status: 400, code: '23505' })).toBe(true)
    // a proxy/WAF page or misrouted URL: no application code (non-JSON body)
    expect(isPermanentError({ status: 403 })).toBe(false)
    expect(isPermanentError({ status: 404, message: 'Request failed (404)' })).toBe(false)
    expect(isPermanentError({ status: 400, code: 'bad_request' })).toBe(false)
    for (const status of [401, 408, 426, 429, 500, 503, 0]) expect(isPermanentError({ status, code: 'OV_X' }), String(status)).toBe(false)
    expect(hasApplicationErrorCode({ code: 'OV_BODY_TOO_LARGE' })).toBe(true)
    expect(hasApplicationErrorCode({ code: 'Forbidden' })).toBe(false)
  })

  it('a 403 page without a backend error code backs off the job and stops the pass', async () => {
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'event', action: 'insert', status: 'queued', payload: { external_id: 'match_100_aaa:e:1', match_id: 'match_100_aaa' } },
      { id: 2, resource: 'event', action: 'insert', status: 'queued', payload: { external_id: 'match_100_aaa:e:2', match_id: 'match_100_aaa' } },
      { id: 3, resource: 'event', action: 'insert', status: 'queued', payload: { external_id: 'match_200_bbb:e:3', match_id: 'match_200_bbb' } }
    ])
    // apiClient's result for a non-JSON (HTML) 403 body
    api.respond = (call) => (call.action === 'upsert'
      ? { data: null, error: { message: 'Database operation failed (403)', status: 403 } }
      : defaultRespond(call))

    const outcome = await runQueuePass()
    expect(outcome).toMatchObject({ stopped: true, hasError: true, hasFailed: false })
    const job = fakeDb.sync_queue.map.get(1)
    expect(job).toMatchObject({ status: 'error', attempts: 1, last_error: { status: 403, code: null } })
    expect(job.next_attempt_at).toBeGreaterThan(Date.now())
    // the rest of the queue was not burnt on the same page
    expect(fakeDb.sync_queue.map.get(2).status).toBe('queued')
    expect(fakeDb.sync_queue.map.get(3).status).toBe('queued')
    expect(api.calls.filter(c => c.action === 'upsert')).toHaveLength(1)
  })

  it('a refused job comes back once an hour on its own, at most 24 times', async () => {
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'event', action: 'insert', status: 'failed', failed_at: Date.now() - 10 * 60 * 1000, payload: { external_id: 'match_100_aaa:e:1' } },
      { id: 2, resource: 'event', action: 'insert', status: 'failed', failed_at: Date.now() - 61 * 60 * 1000, payload: { external_id: 'match_100_aaa:e:2' } },
      { id: 3, resource: 'event', action: 'insert', status: 'failed', failed_at: Date.now() - 61 * 60 * 1000, failed_auto_retries: 24, payload: { external_id: 'match_100_aaa:e:3' } }
    ])
    expect(await retryErrorsInternal()).toBe(true)
    expect(fakeDb.sync_queue.map.get(1).status).toBe('failed') // refused 10 min ago
    expect(fakeDb.sync_queue.map.get(2)).toMatchObject({ status: 'queued', failed_auto_retries: 1 })
    expect(fakeDb.sync_queue.map.get(3).status).toBe('failed') // cap reached: manual retry only

    // a manual retry (or a sign-in, or the app start) takes them all and resets the cap
    await retryErrorsInternal({ force: true, includeFailed: true })
    expect(fakeDb.sync_queue.map.get(3)).toMatchObject({ status: 'queued', failed_auto_retries: 0 })
  })

  it('a 400 (OV_UNSCOPED_EXTERNAL_ID) is marked failed with its reason and not retried with the error backoff', async () => {
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'event', action: 'insert', status: 'queued', payload: { external_id: 'match_100_aaa:e:1', match_id: 'match_100_aaa' } }
    ])
    api.respond = (call) => (call.action === 'upsert'
      ? { data: null, error: { message: 'Database operation failed', code: 'OV_UNSCOPED_EXTERNAL_ID', status: 400 } }
      : defaultRespond(call))

    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(1)).toMatchObject({ status: 'failed', attempts: 1, last_error: { status: 400, code: 'OV_UNSCOPED_EXTERNAL_ID' } })

    // the error backoff (30 s ...) and the back-online retry leave it alone
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 5 * 60 * 1000)
    try {
      expect(await retryErrorsInternal()).toBe(false)
      expect(await retryErrorsInternal({ force: true })).toBe(false)
    } finally {
      vi.useRealTimers()
    }
    expect(fakeDb.sync_queue.map.get(1).status).toBe('failed')

    // a manual "Retry All" (or a sign-in) gives it another try
    expect(await retryErrorsInternal({ force: true, includeFailed: true })).toBe(true)
    expect(fakeDb.sync_queue.map.get(1).status).toBe('queued')
  })

  it('a 401 leaves every job queued without counting an attempt and stops the pass', async () => {
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'match', action: 'insert', status: 'queued', payload: { external_id: 'match_100_aaa' } },
      { id: 2, resource: 'event', action: 'insert', status: 'queued', payload: { external_id: 'match_200_bbb:e:1', match_id: 'match_200_bbb' } }
    ])
    api.respond = (call) => (call.action === 'upsert'
      ? { data: null, error: { message: 'Authentication required', code: 'missing_token', status: 401 } }
      : defaultRespond(call))

    const outcome = await runQueuePass()
    expect(outcome).toMatchObject({ authRequired: true, stopped: true, hasError: false })
    expect(fakeDb.sync_queue.map.get(1)).toMatchObject({ status: 'queued' })
    expect(fakeDb.sync_queue.map.get(1).attempts).toBeUndefined()
    expect(fakeDb.sync_queue.map.get(2).status).toBe('queued')
    expect(api.calls.filter(c => c.action === 'upsert')).toHaveLength(1)
  })

  it('logs a 401 as a warning, other refusals as errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      fakeDb.sync_queue.reset([
        { id: 1, resource: 'match', action: 'insert', status: 'queued', payload: { external_id: 'match_100_aaa' } }
      ])
      api.respond = (call) => (call.action === 'upsert'
        ? { data: null, error: { message: 'Authentication required', code: 'missing_token', status: 401 } }
        : defaultRespond(call))
      await runQueuePass()
      expect(warn.mock.calls.some(c => String(c[0]).includes('Match insert error'))).toBe(true)
      expect(error.mock.calls.some(c => String(c[0]).includes('Match insert error'))).toBe(false)

      api.respond = (call) => (call.action === 'upsert'
        ? { data: null, error: { message: 'bad', code: 'OV_INVALID_DATA', status: 400 } }
        : defaultRespond(call))
      await runQueuePass()
      expect(error.mock.calls.some(c => String(c[0]).includes('Match insert error'))).toBe(true)
    } finally {
      warn.mockRestore()
      error.mockRestore()
    }
  })

  it('logs match payloads without PINs', () => {
    expect(redactForLog({ external_id: 'm', game_pin: '123456', connection_pins: { referee: '1' }, home_team: { name: 'A' } }))
      .toEqual({ external_id: 'm', home_team: { name: 'A' } })
  })

  it('redactForLog drops PIN fields at any depth and in any spelling, keeps the rest', () => {
    const out = redactForLog({
      id: 'm',
      gamePin: '1',
      PIN: '2',
      homeTeamUploadPin: '3',
      connectionPins: { referee: '4' },
      match: { refereePin: '5', status: 'live', teams: [{ name: 'A', bench_home_pin: '6' }] },
      mapping: 'kept',
      pinned: true,
      when: 123456
    })
    expect(out).toEqual({ id: 'm', match: { status: 'live', teams: [{ name: 'A' }] }, mapping: 'kept', pinned: true, when: 123456 })
  })

  it('redactForLog prints the remarks as a length, never their text (db/017)', () => {
    expect(redactForLog({ id: 'm', remarks: 'Player 4 Muster injured' })).toEqual({ id: 'm', remarks: '[23 characters]' })
    expect(redactForLog({ match: { remarks: '' } })).toEqual({ match: { remarks: '[0 characters]' } })
    expect(redactForLog({ remarks: null })).toEqual({ remarks: null })
  })

  it('redactForLog masks PIN values inside texts and error messages', () => {
    expect(redactForLog('Key (game_pin)=(123456) already exists.')).toBe('Key (game_pin)=([redacted]) already exists.')
    expect(redactForLog('{"refereePin":"654321","n":42}')).toBe('{"refereePin":"[redacted]","n":42}')
    expect(redactForLog('Processing 12345 queued items')).toBe('Processing 12345 queued items')
    const err = redactForLog(new Error('duplicate game_pin 123456'))
    expect(err.message).toBe('duplicate game_pin [redacted]')
    const plain = new Error('boom')
    expect(redactForLog(plain)).toBe(plain)
    expect(redactForLog({ code: 'X', details: 'Key (game_pin)=(123456)' })).toEqual({ code: 'X', details: 'Key (game_pin)=([redacted])' })
  })

  it('no console line of a queue pass carries a PIN (payloads, nested PINs, backend errors)', async () => {
    const lines = []
    const capture = (...args) => { lines.push(JSON.stringify(args.map(a => (a instanceof Error ? { message: a.message } : a)))) }
    const spies = ['log', 'warn', 'error'].map(m => vi.spyOn(console, m).mockImplementation(capture))
    try {
      fakeDb.sync_queue.reset([
        { id: 1, resource: 'match', action: 'insert', status: 'queued', payload: { external_id: 'match_100_aaa', game_pin: '999999', connection_pins: { referee: '111111' } } },
        { id: 2, resource: 'match', action: 'update', status: 'queued', payload: { id: 'match_100_aaa', game_pin: '999999', connection_pins: { referee: '111111' } } },
        { id: 3, resource: 'set', action: 'insert', status: 'queued', payload: { external_id: 'match_100_aaa:s:5', match_id: 'match_100_aaa', debug: { gamePin: '999999' } } },
        { id: 4, resource: 'event', action: 'insert', status: 'queued', payload: { external_id: 'match_100_aaa:e:9', match_id: 'match_100_aaa', refereePin: '111111' } }
      ])
      api.respond = (call) => {
        if (call.table === 'matches' && call.action === 'select') return ok({ id: MATCH_UUID })
        if (call.action === 'upsert' && call.table === 'matches') return ok()
        return { data: null, error: { status: 400, message: 'Key (game_pin)=(999999) bad', details: { home_team_pin: '222222' } } }
      }
      await runQueuePass()
    } finally {
      spies.forEach(s => s.mockRestore())
    }
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.some(l => l.includes('Match insert payload'))).toBe(true)
    for (const pin of ['999999', '111111', '222222', '333333', '444444']) {
      expect(lines.filter(l => l.includes(pin))).toEqual([])
    }
  })
})

describe('pruneSyncQueue', () => {
  it('removes old sent/superseded/dropped rows, but none newer than a pending job', async () => {
    const now = Date.now()
    const old = now - 8 * 24 * 3600 * 1000
    fakeDb.sync_queue.reset([
      { id: 1, status: 'sent', ts: old },
      { id: 2, status: 'superseded', ts: new Date(old).toISOString() },
      { id: 3, status: 'dropped', ts: old },
      { id: 4, status: 'sent', ts: now - 3600 * 1000 }, // recent
      { id: 5, status: 'error', ts: old }, // still pending: kept, and so is what follows
      { id: 6, status: 'sent', ts: old },
      { id: 7, status: 'failed', ts: old }
    ])
    expect(await pruneSyncQueue({ now })).toBe(3)
    expect([...fakeDb.sync_queue.map.keys()]).toEqual([4, 5, 6, 7])
  })
})

describe('getSyncQueueStats', () => {
  it('counts pending, errored and failed jobs', async () => {
    fakeDb.sync_queue.reset([
      { id: 1, status: 'queued' }, { id: 2, status: 'sending' }, { id: 3, status: 'error' },
      { id: 4, status: 'failed' }, { id: 5, status: 'sent' }, { id: 6, status: 'dropped' }
    ])
    expect(await getSyncQueueStats()).toEqual({ pending: 2, error: 1, failed: 1 })
  })
})

describe('My Matches links (user_matches)', () => {
  const ALICE = 'aaaaaaaa-0000-4000-8000-000000000001'
  const BOB = 'bbbbbbbb-0000-4000-8000-000000000002'
  const signIn = (id) => localStorage.setItem('api_auth_token', JSON.stringify({ access_token: 't', expires_at: Date.now() / 1000 + 3600, user: { id } }))
  afterEach(() => {
    localStorage.removeItem('api_auth_token')
    localStorage.removeItem('cachedProfile')
  })

  it('reads the signed-in account from the stored session, ignoring an expired one', () => {
    expect(storedSessionUserId()).toBe(null)
    signIn(ALICE)
    expect(storedSessionUserId()).toBe(ALICE)
    localStorage.setItem('api_auth_token', JSON.stringify({ access_token: 't', expires_at: 1, user: { id: ALICE } }))
    expect(storedSessionUserId()).toBe(null)
  })

  it('queues a scorer link keyed by the seed key, once, only when signed in and never for test matches', async () => {
    expect(await queueUserMatchLinks({ seed_key: 'match_100_aaa' })).toBe(0) // nobody signed in
    signIn(ALICE)
    expect(await queueUserMatchLinks({ seed_key: null })).toBe(0) // no seed key yet: no Dexie-id link
    expect(await queueUserMatchLinks({ seed_key: 'match_100_aaa', test: true })).toBe(0)
    expect(await queueUserMatchLinks({ seed_key: 'match_100_aaa' })).toBe(1)
    expect(await queueUserMatchLinks({ seed_key: 'match_100_aaa' })).toBe(0) // already queued
    const jobs = [...fakeDb.sync_queue.map.values()]
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      resource: 'user_match',
      action: 'upsert',
      status: 'queued',
      payload: { user_id: ALICE, match_external_id: 'match_100_aaa', role: 'scorer', sport_type: 'indoor' }
    })
  })

  it('adds the officials role carrying the account name', async () => {
    signIn(ALICE)
    localStorage.setItem('cachedProfile', JSON.stringify({ user_id: ALICE, first_name: 'Anna', last_name: 'Müller' }))
    await queueUserMatchLinks({
      seed_key: 'match_100_aaa',
      officials: [
        { role: '1st referee', firstName: 'anna', lastName: 'MULLER' },
        { role: 'scorer', firstName: 'Other', lastName: 'Person' }
      ]
    })
    expect([...fakeDb.sync_queue.map.values()].map(j => j.payload.role)).toEqual(['scorer', '1st referee'])
  })

  it('sends the link after the match, as an owner-scoped upsert without user_id', async () => {
    signIn(ALICE)
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'user_match', action: 'upsert', status: 'queued', payload: { user_id: ALICE, match_external_id: 'match_100_aaa', role: 'scorer', sport_type: 'indoor' } },
      { id: 2, resource: 'match', action: 'insert', status: 'queued', payload: { external_id: 'match_100_aaa' } }
    ])
    await runQueuePass()
    expect(api.calls.map(c => c.table)).toEqual(['matches', 'user_matches'])
    const link = api.calls[1]
    expect(link).toMatchObject({ action: 'upsert', onConflict: 'user_id,match_external_id,role', data: { match_external_id: 'match_100_aaa', role: 'scorer', sport_type: 'indoor' } })
    expect(link.data).not.toHaveProperty('user_id')
    expect(fakeDb.sync_queue.map.get(1).status).toBe('sent')
  })

  it('waits behind a failed match insert of the same match', async () => {
    signIn(ALICE)
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'match', action: 'insert', status: 'error', attempts: 1, next_attempt_at: Date.now() + 60000, payload: { external_id: 'match_100_aaa' } },
      { id: 2, resource: 'user_match', action: 'upsert', status: 'queued', payload: { user_id: ALICE, match_external_id: 'match_100_aaa', role: 'scorer' } }
    ])
    await runQueuePass()
    expect(api.calls).toHaveLength(0)
    expect(fakeDb.sync_queue.map.get(2).status).toBe('queued')
  })

  it('useUserMatchLink links the open match once it has a seed key, and re-checks when the profile arrives', async () => {
    signIn(ALICE)
    fakeDb.matches.reset([{ id: 1, seed_key: 'match_100_aaa', officials: [{ role: '2nd referee', firstName: 'Anna', lastName: 'Muster' }] }])
    const { unmount } = renderHook(() => useUserMatchLink(1))
    await vi.waitFor(() => expect(fakeDb.sync_queue.map.size).toBe(1))
    expect([...fakeDb.sync_queue.map.values()][0].payload).toMatchObject({ match_external_id: 'match_100_aaa', role: 'scorer' })

    localStorage.setItem('cachedProfile', JSON.stringify({ user_id: ALICE, first_name: 'Anna', last_name: 'Muster' }))
    await act(async () => { window.dispatchEvent(new Event('ov-profile-cached')) })
    await vi.waitFor(() => expect(fakeDb.sync_queue.map.size).toBe(2))
    expect([...fakeDb.sync_queue.map.values()].map(j => j.payload.role)).toEqual(['scorer', '2nd referee'])
    unmount()
  })

  it('useUserMatchLink queues nothing for a match without a seed key or a test match', async () => {
    signIn(ALICE)
    fakeDb.matches.reset([{ id: 1, seed_key: null }, { id: 2, seed_key: 'match_200_bbb', test: true }])
    const a = renderHook(() => useUserMatchLink(1))
    const b = renderHook(() => useUserMatchLink(2))
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
    expect(fakeDb.sync_queue.map.size).toBe(0)
    a.unmount()
    b.unmount()
  })

  it('never links the match to another account signed in meanwhile', async () => {
    signIn(BOB)
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'user_match', action: 'upsert', status: 'queued', payload: { user_id: ALICE, match_external_id: 'match_100_aaa', role: 'scorer' } }
    ])
    await runQueuePass()
    expect(api.calls).toHaveLength(0)
    expect(fakeDb.sync_queue.map.get(1).status).toBe('dropped')
  })
})

describe('useSyncQueue flush loop', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    // A stored session: without one the queue sends nothing (see below)
    localStorage.setItem('api_auth_token', JSON.stringify({ access_token: 't' }))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    localStorage.removeItem('api_auth_token')
  })

  it('sends nothing without a stored session, then resumes on sign-in', async () => {
    localStorage.removeItem('api_auth_token')
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'match', action: 'insert', status: 'queued', payload: { external_id: 'match_100_aaa' } }
    ])
    const { result, unmount } = renderHook(() => useSyncQueue())
    await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
    expect(result.current.syncStatus).toBe('auth_required')
    // No write was even tried: no 401 in the console or the backend log
    expect(api.calls.filter(c => c.action !== 'select')).toHaveLength(0)
    expect(fakeDb.sync_queue.map.get(1)).toMatchObject({ status: 'queued' })

    await act(async () => {
      localStorage.setItem('api_auth_token', JSON.stringify({ access_token: 't' }))
      window.dispatchEvent(new CustomEvent('api-auth-token-change', { detail: { access_token: 't' } }))
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(fakeDb.sync_queue.map.get(1).status).toBe('sent')
    expect(result.current.syncStatus).toBe('synced')
    unmount()
  })

  it('reports synced while signed out with nothing waiting', async () => {
    localStorage.removeItem('api_auth_token')
    fakeDb.sync_queue.reset([])
    const { result, unmount } = renderHook(() => useSyncQueue())
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(result.current.syncStatus).toBe('synced')
    unmount()
  })

  it('requeues an errored job once its backoff has passed, while the 5 s poll runs', async () => {
    const { unmount } = renderHook(() => useSyncQueue())
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })

    // Parked after the mount-time forced retry already ran (as in the e2e run)
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'event', action: 'insert', status: 'error', attempts: 1, next_attempt_at: Date.now() + 10000, payload: { external_id: 'match_100_aaa:e:1', match_id: 'match_100_aaa' } }
    ])
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(fakeDb.sync_queue.map.get(1).status).toBe('error') // backoff not over yet

    await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
    expect(fakeDb.sync_queue.map.get(1).status).toBe('sent')
    unmount()
  })

  it('waits for a sign-in after a 401 of a stored session (no request churn), then resumes at once', async () => {
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'match', action: 'insert', status: 'queued', payload: { external_id: 'match_100_aaa' } }
    ])
    let signedIn = false
    api.respond = (call) => (call.action === 'upsert' && !signedIn
      ? { data: null, error: { message: 'Authentication required', code: 'missing_token', status: 401 } }
      : defaultRespond(call))

    const { result, unmount } = renderHook(() => useSyncQueue())
    await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
    expect(result.current.syncStatus).toBe('auth_required')
    expect(api.calls.filter(c => c.action === 'upsert')).toHaveLength(1)
    expect(fakeDb.sync_queue.map.get(1).status).toBe('queued')

    signedIn = true
    await act(async () => {
      window.dispatchEvent(new CustomEvent('api-auth-token-change', { detail: { access_token: 't' } }))
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(fakeDb.sync_queue.map.get(1).status).toBe('sent')
    expect(result.current.syncStatus).toBe('synced')
    unmount()
  })

  // 2026-10-13 (OpenBeach): signed in, the banner still said "Session
  // expired" for the whole first pass: the status changed only at its end
  it('after the sign-in the status leaves auth_required as the pass starts, not when it ends', async () => {
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'match', action: 'insert', status: 'queued', payload: { external_id: 'match_100_aaa' } }
    ])
    let signedIn = false
    api.respond = (call) => {
      if (call.action !== 'upsert') return defaultRespond(call)
      if (!signedIn) return { data: null, error: { message: 'Authentication required', code: 'missing_token', status: 401 } }
      return new Promise(resolve => setTimeout(() => resolve(defaultRespond(call)), 5000)) // a slow write
    }
    const { result, unmount } = renderHook(() => useSyncQueue())
    await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
    expect(result.current.syncStatus).toBe('auth_required')

    signedIn = true
    await act(async () => {
      window.dispatchEvent(new CustomEvent('api-auth-token-change', { detail: { access_token: 't' } }))
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(fakeDb.sync_queue.map.get(1).status).toBe('queued') // still on its way
    expect(result.current.syncStatus).toBe('syncing')
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(result.current.syncStatus).toBe('synced')
    unmount()
  })

  // Laptop run of 2026-10-08 (OB-3): the scoreboard mounts its own queue,
  // whose first probe published 'connecting' over the app's 'synced': the
  // header's cloud chip changed for one frame ('Venue mode', then 'Ready')
  it('a second instance never shows "connecting" over a cloud already known to work', async () => {
    fakeDb.sync_queue.reset([])
    const seen = []
    const app = renderHook(() => { const q = useSyncQueue(); seen.push(q.syncStatus); return q })
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(app.result.current.syncStatus).toBe('synced')

    seen.length = 0
    const scoreboard = renderHook(() => useSyncQueue())
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(seen).not.toContain('connecting')
    expect(app.result.current.syncStatus).toBe('synced')
    scoreboard.unmount()
    app.unmount()
  })
})

// Stress test 2026-10-25 (network chaos): the cloud was down from before
// set 2 started and back shortly before its set point, the hall Wi-Fi up all
// the time. The set end was sent directly, past the queue, which was still
// waiting out its probe backoff: the set update matched no row (the set's
// insert was still queued), the insert then wrote set 2 as 0:0 unfinished for
// good, and the previous set end's queued match update rolled current_set and
// set_results back.
describe('set end after a cloud outage', () => {
  const SEED = 'match_100_aaa'
  const S1 = { set: 1, home: 25, away: 3 }
  const outageQueue = () => [
    { id: 1, resource: 'set', action: 'update', status: 'queued', retry_count: 0, payload: { external_id: `${SEED}:s:5`, home_points: 25, away_points: 3, finished: true, end_time: '2026-10-25T12:20:00Z' } },
    { id: 2, resource: 'match', action: 'update', status: 'queued', retry_count: 0, payload: { id: SEED, current_set: 2, set_results: [S1] } },
    { id: 3, resource: 'set', action: 'insert', status: 'queued', retry_count: 0, payload: { external_id: `${SEED}:s:6`, match_id: SEED, index: 2, home_points: 0, away_points: 0, finished: false } },
    { id: 4, resource: 'set', action: 'update', status: 'queued', retry_count: 0, payload: { external_id: `${SEED}:s:6`, home_points: 24, away_points: 3 } }
  ]

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    localStorage.setItem('api_auth_token', JSON.stringify({ access_token: 't' }))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    localStorage.removeItem('api_auth_token')
  })

  it('the set end goes out after the older writes of its set and match, right after the cloud is back', async () => {
    fakeDb.sync_queue.reset(outageQueue())
    let cloudUp = false
    api.respond = (call) => (cloudUp ? defaultRespond(call) : { data: null, error: { message: 'Failed to fetch', status: 0, network: true } })

    const { result, unmount } = renderHook(() => ({ queue: useSyncQueue(), setEnd: useSequentialSync() }))
    // the outage: the probe fails and backs off (5, 10, 20, 40 s ...)
    await act(async () => { await vi.advanceTimersByTimeAsync(80000) })
    expect(fakeDb.sync_queue.map.get(3).status).toBe('queued')

    // back, without an 'online' event (the Wi-Fi never dropped); the set point
    cloudUp = true
    api.calls = []
    let outcome
    await act(async () => {
      const pending = result.current.setEnd.syncSetEnd({
        lastPointPayload: null,
        setPayload: { external_id: `${SEED}:s:6`, home_points: 25, away_points: 3, finished: true, end_time: '2026-10-25T12:45:00Z' },
        matchPayload: { id: SEED, current_set: 3, set_results: [S1, { set: 2, home: 25, away: 3 }] }
      })
      await vi.advanceTimersByTimeAsync(3000)
      outcome = await pending
    })
    expect(outcome).toEqual({ success: true, hasWarning: false })

    const writes = api.calls.filter(c => c.action !== 'select')
    const set2 = writes.filter(c => c.table === 'sets' && JSON.stringify(c).includes(`${SEED}:s:6`))
    // the insert first, the set end last: set 2 ends finished in the cloud
    expect(set2.map(c => c.action)).toEqual(['upsert', 'update', 'update'])
    expect(set2[2].data).toMatchObject({ finished: true, home_points: 25 })
    // the match row ends at set 3 with both sets
    const matchUpdates = writes.filter(c => c.table === 'matches')
    expect(matchUpdates.map(c => c.data.current_set)).toEqual([2, 3])
    expect([...fakeDb.sync_queue.map.values()].every(j => j.status === 'sent')).toBe(true)
    unmount()
  })

  it('both set-end writes are in the queue together before anything is sent', async () => {
    fakeDb.sync_queue.reset([])
    api.respond = () => new Promise(() => {}) // the backend hangs
    const { result, unmount } = renderHook(() => useSequentialSync())
    await act(async () => {
      result.current.syncSetEnd({
        lastPointPayload: null,
        setPayload: { external_id: `${SEED}:s:5`, finished: true },
        matchPayload: { id: SEED, current_set: 2, set_results: [S1] }
      })
      await vi.advanceTimersByTimeAsync(10)
    })
    // a page that dies now still has the match update to send at the next start
    expect([...fakeDb.sync_queue.map.values()].map(j => [j.resource, j.action, j.status])).toEqual([
      ['set', 'update', 'queued'],
      ['match', 'update', 'queued']
    ])
    unmount()
  })
})

describe('closing order (approval waits for the match\'s older sets and events)', () => {
  const close = (id, status = 'approved') => ({ id, resource: 'match', action: 'update', status: 'queued', retry_count: 0, payload: { id: 'match_100_aaa', status } })
  const setJob = (id, status = 'queued') => ({ id, resource: 'set', action: 'update', status, retry_count: 0, payload: { external_id: 'match_100_aaa:s:5', match_id: 'match_100_aaa', home_points: 25 } })

  it('recognises closing updates only', () => {
    expect(isClosingJob(close(1))).toBe(true)
    expect(isClosingJob(close(1, 'final'))).toBe(true)
    expect(isClosingJob(close(1, 'ended'))).toBe(false)
    expect(isClosingJob({ resource: 'match', action: 'insert', payload: { status: 'approved' } })).toBe(false)
  })

  it('holds the approval while an older set job is queued, and sends it after', async () => {
    fakeDb.sync_queue.reset([setJob(1), close(2)])
    // The set job errors in the first pass (5xx), so it is still pending
    let setCalls = 0
    api.respond = (call) => {
      if (call.table === 'sets' && call.action !== 'select') {
        setCalls++
        if (setCalls === 1) return { data: null, error: { message: 'Service unavailable', status: 503 } }
      }
      return defaultRespond(call)
    }
    await runQueuePass()
    const matchUpdates = () => api.calls.filter(c => c.table === 'matches' && c.action === 'update')
    expect(matchUpdates()).toHaveLength(0)
    expect(fakeDb.sync_queue.map.get(2).status).toBe('queued')

    // The set goes through: the approval follows in the next pass
    fakeDb.sync_queue.update(1, { status: 'queued', next_attempt_at: 0 })
    await runQueuePass()
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(1).status).toBe('sent')
    expect(fakeDb.sync_queue.map.get(2).status).toBe('sent')
    expect(matchUpdates()).toHaveLength(1)
  })

  it('an old failed set job does not hold the approval', async () => {
    fakeDb.sync_queue.reset([setJob(1, 'failed'), close(2)])
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(2).status).toBe('sent')
  })

  it('a newer set job does not hold it either', async () => {
    fakeDb.sync_queue.reset([close(1), setJob(2)])
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(1).status).toBe('sent')
  })

  // db/017: the remarks as approved go just before the approval. Once the
  // approval has closed the match, the server refuses them (OV_MATCH_CLOSED).
  const remarksJob = (id, status = 'queued') => ({ id, resource: 'match', action: 'update', status, retry_count: 0, payload: { id: 'match_100_aaa', remarks: 'Actual start time: 20:05' } })

  it('holds the approval while an older remarks job is waiting out a backoff', async () => {
    fakeDb.sync_queue.reset([remarksJob(1), close(2)])
    let remarksCalls = 0
    api.respond = (call) => {
      if (call.table === 'matches' && call.action === 'update' && 'remarks' in (call.data || {})) {
        remarksCalls++
        // a proxy page (4xx without a backend code): the job backs off as 'error'
        if (remarksCalls === 1) return { data: null, error: { message: 'Bad gateway page', status: 403 } }
      }
      return defaultRespond(call)
    }
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(1).status).toBe('error')
    // A later pass while the remarks job still waits: the approval must not overtake it
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(2).status).toBe('queued')

    fakeDb.sync_queue.update(1, { status: 'queued', next_attempt_at: 0 })
    await runQueuePass()
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(1).status).toBe('sent')
    expect(fakeDb.sync_queue.map.get(2).status).toBe('sent')
    const updates = api.calls.filter(c => c.table === 'matches' && c.action === 'update')
    expect(updates.at(-1).data.status).toBe('approved')
  })

  it('a refused (failed) remarks job, e.g. a server without db/017, does not hold the approval', async () => {
    fakeDb.sync_queue.reset([remarksJob(1, 'failed'), close(2)])
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(2).status).toBe('sent')
  })
})

describe('cloud blocks (OV_SCORER_REQUIRED, OV_GAME_TAKEN, OV_MATCH_CLOSED)', () => {
  beforeEach(() => {
    resetCloudBlockCache()
  })

  const insertJob = (id) => ({ id, resource: 'match', action: 'insert', status: 'queued', payload: { external_id: 'match_100_aaa' } })
  const eventJob = (id) => ({ id, resource: 'event', action: 'insert', status: 'queued', payload: { external_id: `match_100_aaa:e:${id}`, match_id: 'match_100_aaa' } })

  it('OV_GAME_TAKEN parks the job and records who scores the game, without anything but the claim fields', async () => {
    const seen = []
    const onBlock = (e) => seen.push(e.detail)
    window.addEventListener(CLOUD_BLOCK_EVENT, onBlock)
    fakeDb.sync_queue.reset([insertJob(1)])
    const claim = { game_n: 4711, season: 2026, sport: 'indoor', status: 'live', scorer_name: 'Anna Muster', mine: false, scheduled_at: '2026-10-10T16:00:00Z', game_pin: '123456' }
    api.respond = (call) => {
      if (call.table === 'matches' && call.action !== 'select') return { data: null, error: { message: 'taken', code: 'OV_GAME_TAKEN', status: 409, claim } }
      return defaultRespond(call)
    }
    await runQueuePass()
    window.removeEventListener(CLOUD_BLOCK_EVENT, onBlock)
    expect(fakeDb.sync_queue.map.get(1).status).toBe('failed')
    const block = fakeDb.matches.map.get(1).cloudBlock
    expect(block.code).toBe('OV_GAME_TAKEN')
    expect(block.claim).toEqual({ game_n: 4711, season: 2026, sport: 'indoor', status: 'live', scorer_name: 'Anna Muster', mine: false, scheduled_at: '2026-10-10T16:00:00Z' })
    expect(fakeDb.sync_queue.map.get(1).last_error.claim.scorer_name).toBe('Anna Muster')
    expect(seen).toEqual([{ seedKey: 'match_100_aaa', code: 'OV_GAME_TAKEN' }])
  })

  it('OV_SCORER_REQUIRED sets the block with no claim, the job stays refused', async () => {
    fakeDb.sync_queue.reset([eventJob(1)])
    api.respond = (call) => (call.table === 'events' ? { data: null, error: { message: 'no', code: 'OV_SCORER_REQUIRED', status: 403 } } : defaultRespond(call))
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(1).status).toBe('failed')
    expect(fakeDb.matches.map.get(1).cloudBlock).toMatchObject({ code: 'OV_SCORER_REQUIRED', claim: null })
  })

  it('OV_MATCH_CLOSED sets the block with no claim, the job is set aside (not refused)', async () => {
    fakeDb.sync_queue.reset([eventJob(1)])
    api.respond = (call) => (call.table === 'events' ? { data: null, error: { message: 'no', code: 'OV_MATCH_CLOSED', status: 409 } } : defaultRespond(call))
    const outcome = await runQueuePass()
    expect(fakeDb.sync_queue.map.get(1).status).toBe('dropped')
    expect(outcome.hasFailed).toBeFalsy()
    expect(fakeDb.matches.map.get(1).cloudBlock).toMatchObject({ code: 'OV_MATCH_CLOSED', claim: null })
  })

  // 2026-10-19: a backup of a match the server had closed was restored next to
  // a new match of the same game; it stayed open on the home screen
  const restoreJob = (id) => ({ id, resource: 'match', action: 'restore', status: 'queued', payload: { match: { external_id: 'match_100_aaa' }, sets: [], events: [] } })
  const closedRestore = (call) => (call.table === '__restore'
    ? { data: null, error: { message: 'closed', code: 'OV_MATCH_CLOSED', status: 409 } }
    : defaultRespond(call))

  it.each(['ended', 'approved'])('OV_MATCH_CLOSED marks a match that ended here (%s) final', async (status) => {
    fakeDb.matches.reset([{ id: 1, seed_key: 'match_100_aaa', status }])
    fakeDb.sync_queue.reset([restoreJob(1)])
    api.respond = closedRestore
    await runQueuePass()
    expect(fakeDb.matches.map.get(1)).toMatchObject({ status: 'final', cloudBlock: { code: 'OV_MATCH_CLOSED' } })
  })

  it.each(['scheduled', 'live'])('OV_MATCH_CLOSED leaves a match still scored here (%s) open, its restore set aside', async (status) => {
    fakeDb.matches.reset([{ id: 1, seed_key: 'match_100_aaa', status }])
    fakeDb.sync_queue.reset([restoreJob(1)])
    api.respond = closedRestore
    await runQueuePass()
    expect(fakeDb.matches.map.get(1)).toMatchObject({ status, cloudBlock: { code: 'OV_MATCH_CLOSED' } })
    expect(fakeDb.sync_queue.map.get(1).status).toBe('dropped')
  })

  it('other blocks leave an ended match open', async () => {
    fakeDb.matches.reset([{ id: 1, seed_key: 'match_100_aaa', status: 'ended' }])
    fakeDb.sync_queue.reset([eventJob(1)])
    api.respond = (call) => (call.table === 'events' ? { data: null, error: { message: 'no', code: 'OV_SCORER_REQUIRED', status: 403 } } : defaultRespond(call))
    await runQueuePass()
    expect(fakeDb.matches.map.get(1).status).toBe('ended')
  })

  it('a later successful job of the match clears the block', async () => {
    fakeDb.matches.reset([{ id: 1, seed_key: 'match_100_aaa', cloudBlock: { code: 'OV_SCORER_REQUIRED', claim: null, at: 1 } }])
    fakeDb.sync_queue.reset([eventJob(1)])
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(1).status).toBe('sent')
    expect(fakeDb.matches.map.get(1).cloudBlock).toBeNull()
  })

  it('other refusals set no block', async () => {
    fakeDb.sync_queue.reset([eventJob(1)])
    api.respond = (call) => {
      if (call.table === 'events') return { data: null, error: { message: 'bad', code: 'OV_INVALID_REQUEST', status: 400 } }
      return defaultRespond(call)
    }
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(1).status).toBe('failed')
    expect(fakeDb.matches.map.get(1).cloudBlock).toBeUndefined()
  })
})

describe('access changes', () => {
  it('ov-access-changed with canScore requeues the refused jobs', async () => {
    fakeDb.sync_queue.reset([{ id: 1, resource: 'match', action: 'insert', status: 'failed', failed_at: Date.now(), payload: { external_id: 'match_100_aaa' } }])
    window.dispatchEvent(new CustomEvent('ov-access-changed', { detail: { canScore: false } }))
    await new Promise(r => setTimeout(r, 10))
    expect(fakeDb.sync_queue.map.get(1).status).toBe('failed')
    window.dispatchEvent(new CustomEvent('ov-access-changed', { detail: { canScore: true } }))
    await new Promise(r => setTimeout(r, 10))
    expect(fakeDb.sync_queue.map.get(1).status).toBe('queued')
  })
})

// ---------------------------------------------------------------------------
// 2026-10-20, game 406970: started on the PC, continued on a phone
// ---------------------------------------------------------------------------
describe('a match continued on another device', () => {
  beforeEach(() => {
    resetCloudBlockCache()
  })

  const update = (id, payload, status = 'queued') => ({ id, resource: 'match', action: 'update', status, retry_count: 0, payload: { id: 'match_100_aaa', ...payload } })
  const eventJob = (id, seed = 'match_100_aaa') => ({ id, resource: 'event', action: 'insert', status: 'queued', retry_count: 0, payload: { external_id: `${seed}:e:${id}`, match_id: seed } })
  const refuse = (code, extra = {}) => ({ data: null, error: { message: 'no', code, status: 409, ...extra } })

  it('a match update refused as closed for a match approved here is dropped, not a lasting error', async () => {
    fakeDb.matches.reset([{ id: 1, seed_key: 'match_100_aaa', status: 'ended', approved: true }])
    fakeDb.sync_queue.reset([update(1, { status: 'ended', set_results: [], final_score: '3-0' })])
    api.respond = (call) => (call.table === 'matches' && call.action === 'update' ? refuse('OV_MATCH_CLOSED') : defaultRespond(call))
    const outcome = await runQueuePass()
    expect(fakeDb.sync_queue.map.get(1).status).toBe('dropped')
    expect(outcome.hasFailed).toBeFalsy()
    expect(await getSyncQueueStats()).toEqual({ pending: 0, error: 0, failed: 0 })
    // the local copy follows the server: closed
    expect(fakeDb.matches.map.get(1)).toMatchObject({ status: 'final', cloudBlock: { code: 'OV_MATCH_CLOSED' } })
  })

  // 2026-10-23: refused sets and events stayed 'failed' ("they carry the
  // score"); the local rows keep it, the server's closed copy is the record
  it('a set, event or update refused as closed is set aside, whatever the local status', async () => {
    fakeDb.matches.reset([{ id: 1, seed_key: 'match_100_aaa', status: 'final', approved: true }])
    fakeDb.sync_queue.reset([eventJob(1)])
    api.respond = (call) => (call.table === 'events' ? refuse('OV_MATCH_CLOSED') : defaultRespond(call))
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(1)).toMatchObject({ status: 'dropped', superseded_by: 'server-closed' })

    resetCloudBlockCache()
    fakeDb.matches.reset([{ id: 1, seed_key: 'match_100_aaa', status: 'live' }])
    fakeDb.sync_queue.reset([update(1, { status: 'live' })])
    api.respond = (call) => (call.table === 'matches' && call.action === 'update' ? refuse('OV_MATCH_CLOSED') : defaultRespond(call))
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(1).status).toBe('dropped')
    // the copy still scored here keeps its status, with the block
    expect(fakeDb.matches.map.get(1)).toMatchObject({ status: 'live', cloudBlock: { code: 'OV_MATCH_CLOSED' } })
    expect(await getSyncQueueStats()).toEqual({ pending: 0, error: 0, failed: 0 })
  })

  it('the match-end update is not queued for a match closed here, nor twice for the same result', () => {
    const payload = { id: 'match_100_aaa', status: 'ended', set_results: [{ set: 1, home: 25, away: 10 }], final_score: '3-0' }
    const open = { seed_key: 'match_100_aaa', status: 'ended' }
    expect(matchEndUpdateNeeded(open, [], payload)).toBe(true)
    expect(matchEndUpdateNeeded({ ...open, approved: true }, [], payload)).toBe(false)
    expect(matchEndUpdateNeeded({ ...open, status: 'final' }, [], payload)).toBe(false)
    expect(matchEndUpdateNeeded({ ...open, cloudBlock: { code: 'OV_MATCH_CLOSED' } }, [], payload)).toBe(false)
    expect(matchEndUpdateNeeded({ ...open, test: true }, [], payload)).toBe(false)
    const pending = [{ id: 1, status: 'queued', resource: 'match', action: 'update', payload }]
    expect(matchEndUpdateNeeded(open, pending, payload)).toBe(false)
    expect(matchEndUpdateNeeded(open, [{ ...pending[0], status: 'sent' }], payload)).toBe(true)
    expect(matchEndUpdateNeeded(open, pending, { ...payload, final_score: '3-1' })).toBe(true)
  })

  // The phone's own copy (cs4qcg) of the game the PC claimed (u2sbmb)
  const own = { id: 2, seed_key: 'match_200_own', gameN: 406970, status: 'scheduled', matchInfoConfirmedAt: 'x' }
  const ownInsert = { id: 1, resource: 'match', action: 'insert', status: 'queued', retry_count: 0, payload: { external_id: 'match_200_own', game_n: 406970 } }
  const takenBy = (claim) => (call) => (call.table === 'matches' && call.action !== 'select' ? refuse('OV_GAME_TAKEN', { claim }) : defaultRespond(call))

  it('OV_GAME_TAKEN for a game whose cloud match this device joined retires the refused copy', async () => {
    fakeDb.matches.reset([{ id: 1, seed_key: 'match_100_aaa', gameN: 406970, status: 'live', importedFrom: 'supabase' }, own])
    fakeDb.sync_queue.reset([ownInsert, eventJob(3, 'match_200_own')])
    api.respond = takenBy({ game_n: 406970, season: 2026, status: 'live', mine: true, external_id: 'match_100_aaa' })
    await runQueuePass()
    expect(fakeDb.matches.map.get(2)).toMatchObject({ status: 'final', supersededBy: 'match_100_aaa' })
    // the refused job itself is dropped, its other jobs superseded: none counts as an error
    expect(fakeDb.sync_queue.map.get(1).status).toBe('dropped')
    expect(fakeDb.sync_queue.map.get(3).status).toBe('superseded')
    expect(await getSyncQueueStats()).toEqual({ pending: 0, error: 0, failed: 0 })
    expect(fakeDb.matches.map.get(1).status).toBe('live')
  })

  it('... also when that match was scored and closed here already (or its copy is gone)', async () => {
    fakeDb.matches.reset([own])
    fakeDb.sync_queue.reset([ownInsert])
    api.respond = takenBy({ game_n: 406970, season: 2026, status: 'approved', mine: true })
    await runQueuePass()
    expect(fakeDb.matches.map.get(2).status).toBe('final')
    expect(fakeDb.sync_queue.map.get(1).status).toBe('dropped')
  })

  it('another account scoring the game, or the own match still open elsewhere: the notice stays', async () => {
    for (const claim of [{ game_n: 406970, status: 'approved', mine: false }, { game_n: 406970, status: 'live', mine: true }]) {
      resetCloudBlockCache()
      fakeDb.matches.reset([own])
      fakeDb.sync_queue.reset([ownInsert])
      api.respond = takenBy(claim)
      await runQueuePass()
      expect(fakeDb.matches.map.get(2)).toMatchObject({ status: 'scheduled', cloudBlock: { code: 'OV_GAME_TAKEN' } })
      expect(fakeDb.sync_queue.map.get(1).status).toBe('failed')
    }
  })

  it('OV_SCORER_MOVED marks the match with the new scorer (platform and time only) and sets its unsent writes aside', async () => {
    const seen = []
    const onBlock = (e) => seen.push(e.detail)
    window.addEventListener(CLOUD_BLOCK_EVENT, onBlock)
    fakeDb.matches.reset([{ id: 1, seed_key: 'match_100_aaa', status: 'live' }])
    fakeDb.sync_queue.reset([
      eventJob(1),
      { id: 2, resource: 'set', action: 'update', status: 'error', retry_count: 0, payload: { external_id: 'match_100_aaa:s:5', home_points: 11, away_points: 8 } },
      eventJob(3, 'match_200_other')
    ])
    api.respond = (call) => (call.table === 'events' && call.data?.external_id?.startsWith('match_100_aaa')
      ? refuse('OV_SCORER_MOVED', { scorer: { platform: 'android', at: '2026-10-20T17:54:25Z', device_id: 'x' } })
      : defaultRespond(call))
    await runQueuePass()
    window.removeEventListener(CLOUD_BLOCK_EVENT, onBlock)
    // not a lasting "refused by the server": set aside, the other match goes on
    expect(fakeDb.sync_queue.map.get(1).status).toBe('dropped')
    expect(fakeDb.sync_queue.map.get(2)).toMatchObject({ status: 'superseded', superseded_by: 'scorer-moved' })
    expect(fakeDb.sync_queue.map.get(3).status).toBe('sent')
    expect(await getSyncQueueStats()).toEqual({ pending: 0, error: 0, failed: 0 })
    expect(fakeDb.matches.map.get(1).cloudBlock).toMatchObject({ code: 'OV_SCORER_MOVED', scorer: { platform: 'android', at: '2026-10-20T17:54:25Z' } })
    expect(fakeDb.matches.map.get(1).cloudBlock.scorer).toEqual({ platform: 'android', at: '2026-10-20T17:54:25Z' })
    expect(seen).toEqual([{ seedKey: 'match_100_aaa', code: 'OV_SCORER_MOVED' }])
  })

  // review 2026-10-21 (reproduced): a 'failed' set update of the device that
  // lost the match went out over the other device's score after a take-back
  it('a take-back claim never sends this device\'s writes from before it (they were set aside)', async () => {
    fakeDb.matches.reset([{ id: 1, seed_key: 'match_100_aaa', status: 'live', cloudBlock: { code: 'OV_SCORER_MOVED' } }])
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'set', action: 'update', status: 'superseded', superseded_by: 'scorer-moved', payload: { external_id: 'match_100_aaa:s:5', home_points: 11, away_points: 8, finished: false } },
      { id: 2, resource: 'match', action: 'scorer', status: 'queued', payload: { id: 'match_100_aaa' } }
    ])
    await runQueuePass()
    await retryErrorsInternal({ force: true, includeFailed: true })
    await runQueuePass()
    expect(api.calls.some(c => c.table === 'sets')).toBe(false)
    expect(fakeDb.sync_queue.map.get(1).status).toBe('superseded')
    expect(fakeDb.sync_queue.map.get(2).status).toBe('sent')
  })

  // review 2026-10-21 (reproduced): after the other device closed the match,
  // the old device's retry got OV_MATCH_CLOSED, which replaced the notice and
  // left a live match with a 'failed' job
  it('a moved match refused as closed later: final here, the notice stays, nothing left failed', async () => {
    fakeDb.matches.reset([{ id: 1, seed_key: 'match_100_aaa', status: 'live', cloudBlock: { code: 'OV_SCORER_MOVED', scorer: { platform: 'android', at: 'T' }, at: 3 } }])
    fakeDb.sync_queue.reset([eventJob(1), eventJob(2)])
    api.respond = (call) => (call.table === 'events' ? refuse('OV_MATCH_CLOSED') : defaultRespond(call))
    await runQueuePass()
    expect(fakeDb.matches.map.get(1)).toMatchObject({ status: 'final', cloudBlock: { code: 'OV_SCORER_MOVED', scorer: { platform: 'android', at: 'T' }, closed: true } })
    expect(fakeDb.sync_queue.map.get(1).status).toBe('dropped')
    expect(fakeDb.sync_queue.map.get(2).status).toBe('superseded')
    expect(await getSyncQueueStats()).toEqual({ pending: 0, error: 0, failed: 0 })
  })

  it('a claim goes first among the match jobs', async () => {
    fakeDb.sync_queue.reset([
      update(1, { status: 'live' }),
      { id: 3, resource: 'match', action: 'scorer', status: 'queued', payload: { id: 'match_100_aaa' } }
    ])
    await runQueuePass()
    const order = api.calls.filter(c => c.table === '__scorer' || (c.table === 'matches' && c.action === 'update')).map(c => c.table)
    expect(order[0]).toBe('__scorer')
    expect(fakeDb.sync_queue.map.get(3).status).toBe('sent')
    expect(fakeDb.sync_queue.map.get(1).status).toBe('sent')
  })

  // review 2026-10-21 (reproduced): a parked claim let the joined device's
  // events go first; refused as moved, they put ScorerMovedModal on the
  // device the scorer was using
  it('a claim not answered yet holds the match back across passes; its refusals as moved are retried, no notice', async () => {
    fakeDb.matches.reset([{ id: 1, seed_key: 'match_100_aaa', status: 'live' }])
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'match', action: 'scorer', status: 'error', attempts: 1, next_attempt_at: Date.now() + 60_000, payload: { id: 'match_100_aaa' } },
      eventJob(2)
    ])
    api.respond = (call) => (call.table === 'events' ? refuse('OV_SCORER_MOVED', { scorer: { platform: 'tauri-windows' } }) : defaultRespond(call))
    await runQueuePass()
    expect(api.calls.some(c => c.table === 'events')).toBe(false)
    expect(fakeDb.sync_queue.map.get(2).status).toBe('queued')

    // The same write tried again while the claim waits: retry later
    fakeDb.sync_queue.map.get(1).status = 'queued'
    api.respond = (call) => {
      if (call.table === '__scorer') return { data: null, error: { message: 'busy', code: 'OV_DB_UNAVAILABLE', status: 503 }, status: 503 }
      return call.table === 'events' ? refuse('OV_SCORER_MOVED', { scorer: { platform: 'tauri-windows' } }) : defaultRespond(call)
    }
    expect(await processJob({ ...eventJob(2) })).toBeNull()
    expect(fakeDb.matches.map.get(1).cloudBlock).toBeUndefined()

    // A claim that keeps failing (503) for many passes: the events still wait
    for (let i = 0; i < 12; i++) {
      await runQueuePass()
      const claim = fakeDb.sync_queue.map.get(1)
      if (claim.status === 'error') fakeDb.sync_queue.map.set(1, { ...claim, status: 'queued' })
    }
    expect(api.calls.filter(c => c.table === 'events').length).toBe(1)
    expect(fakeDb.matches.map.get(1).cloudBlock).toBeUndefined()

    // The claim goes through: the events follow
    api.respond = defaultRespond
    await runQueuePass()
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(1).status).toBe('sent')
    expect(fakeDb.sync_queue.map.get(2).status).toBe('sent')
  })

  it('a refused claim holds nothing back: then the refusal as moved is the notice', async () => {
    fakeDb.matches.reset([{ id: 1, seed_key: 'match_100_aaa', status: 'live' }])
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'match', action: 'scorer', status: 'failed', payload: { id: 'match_100_aaa' } },
      eventJob(2)
    ])
    api.respond = (call) => (call.table === 'events' ? refuse('OV_SCORER_MOVED') : defaultRespond(call))
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(2).status).toBe('dropped')
    expect(fakeDb.matches.map.get(1).cloudBlock).toMatchObject({ code: 'OV_SCORER_MOVED' })
  })

  it('a restore names when it was made (db/019: a later take-over elsewhere keeps the match)', async () => {
    const ts = new Date(Date.now() - 90_000).toISOString()
    fakeDb.sync_queue.reset([{ id: 1, resource: 'match', action: 'restore', status: 'queued', ts, payload: { match: { external_id: 'match_100_aaa' }, sets: [], events: [] } }])
    api.respond = (call) => (call.table === '__restore' ? ok({ id: MATCH_UUID, counts: {} }) : defaultRespond(call))
    await runQueuePass()
    const call = api.calls.find(c => c.table === '__restore')
    expect(call.data.queuedAt).toBe(ts)
  })

  it.each([
    ['not in the cloud yet', { data: null, error: { message: 'no', code: 'OV_MATCH_NOT_FOUND', status: 404 }, status: 404 }],
    ['an older backend without the route', { data: null, error: { message: 'Not found', status: 404 }, status: 404 }],
    ['closed', { data: null, error: { message: 'closed', code: 'OV_MATCH_CLOSED', status: 409 }, status: 409 }],
    ['no db/019', { data: null, error: { message: 'n/a', code: 'OV_SCORER_UNAVAILABLE', status: 503 }, status: 503 }],
    ['a server without a database', { data: null, error: { message: 'n/a', code: 'OV_DB_NOT_CONFIGURED', status: 503 }, status: 503 }]
  ])('a claim the server cannot record (%s) holds nothing back', async (_what, answer) => {
    fakeDb.sync_queue.reset([{ id: 1, resource: 'match', action: 'scorer', status: 'queued', payload: { id: 'match_100_aaa' } }, eventJob(2)])
    api.respond = (call) => (call.table === '__scorer' ? answer : defaultRespond(call))
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(1).status).toBe('sent')
    expect(fakeDb.sync_queue.map.get(2).status).toBe('sent')
  })

  it('the relay nudge marks the match only when the server says this device no longer scores it', async () => {
    fakeDb.matches.reset([{ id: 1, seed_key: 'match_100_aaa', status: 'live' }])
    api.respond = (call) => (call.table === '__scorer' ? ok({ mine: true, scorer: { platform: 'tauri-linux' } }) : defaultRespond(call))
    expect(await checkScorerMoved('match_100_aaa')).toBe(false)
    expect(fakeDb.matches.map.get(1).cloudBlock).toBeUndefined()
    api.respond = (call) => (call.table === '__scorer' ? ok({ mine: false, scorer: { platform: 'android', at: 'T' } }) : defaultRespond(call))
    expect(await checkScorerMoved('match_100_aaa')).toBe(true)
    expect(fakeDb.matches.map.get(1).cloudBlock).toMatchObject({ code: 'OV_SCORER_MOVED', scorer: { platform: 'android', at: 'T' } })
    expect(api.calls.filter(c => c.table === '__scorer').every(c => c.action === 'status')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2026-10-23, match 406970: the owner's phone kept a live copy of a match the
// server had approved and closed. Its restore, refused as closed, stayed
// 'failed' ("Refused by the server: 1", Retry all did nothing) and held back
// every newer write of the match (pending 4 -> 9).
// ---------------------------------------------------------------------------
describe('a match closed on the server', () => {
  const SEED = 'match_1792518507614_u2sbmb'
  const closed = { data: null, error: { message: 'Match is closed', code: 'OV_MATCH_CLOSED', status: 409 }, status: 409 }
  const restore = (id, extra = {}) => ({ id, resource: 'match', action: 'restore', status: 'queued', retry_count: 0, ts: '2026-10-20T21:30:00.000Z', payload: { match: { external_id: SEED, status: 'live' }, sets: [], events: [] }, ...extra })
  const setUpdate = (id) => ({ id, resource: 'set', action: 'update', status: 'queued', retry_count: 0, payload: { external_id: `${SEED}:s:3`, match_id: SEED, finished: false, end_time: null } })
  const eventInsert = (id) => ({ id, resource: 'event', action: 'insert', status: 'queued', retry_count: 0, payload: { external_id: `${SEED}:e:${id}`, match_id: SEED, type: 'point' } })
  const matchUpdate = (id) => ({ id, resource: 'match', action: 'update', status: 'queued', retry_count: 0, payload: { id: SEED, status: 'live' } })
  const link = (id) => ({ id, resource: 'user_match', action: 'upsert', status: 'queued', retry_count: 0, payload: { match_external_id: SEED, role: 'scorer' } })
  const block = { code: 'OV_MATCH_CLOSED', claim: null, at: 1 }

  beforeEach(() => {
    resetCloudBlockCache()
    fakeDb.matches.reset([{ id: 1, seed_key: SEED, gameN: 406970, status: 'live', gamePin: '583920' }])
  })

  it('the incident: the refused restore sets aside every unsent write of the match; no error, the link still goes, Retry all has nothing to send', async () => {
    fakeDb.sync_queue.reset([restore(1), setUpdate(2), eventInsert(3), matchUpdate(4), link(5)])
    api.respond = (call) => (call.table === '__restore' ? closed : defaultRespond(call))

    const outcome = await runQueuePass()
    expect(outcome.hasFailed).toBeFalsy()
    expect(fakeDb.sync_queue.map.get(1)).toMatchObject({ status: 'dropped', superseded_by: 'server-closed' })
    for (const id of [2, 3, 4]) expect(fakeDb.sync_queue.map.get(id)).toMatchObject({ status: 'superseded', superseded_by: 'server-closed' })
    // nothing else of the match went out in that pass
    expect(api.calls.map(c => c.table)).toEqual(['__restore'])
    expect(await getSyncQueueStats()).toEqual({ pending: 1, error: 0, failed: 0 })
    // the copy keeps its status and gets the block (the closed-copy notice)
    expect(fakeDb.matches.map.get(1)).toMatchObject({ status: 'live', cloudBlock: { code: 'OV_MATCH_CLOSED' } })

    // the next pass sends the "My Matches" link
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(5).status).toBe('sent')
    expect(await getSyncQueueStats()).toEqual({ pending: 0, error: 0, failed: 0 })

    // Retry all (and the startup / hourly retry) has nothing to send
    expect(await retryErrorsInternal({ force: true, includeFailed: true })).toBe(false)
    expect([...fakeDb.sync_queue.map.values()].filter(j => j.status === 'queued')).toEqual([])
    await runQueuePass()
    expect(api.calls.filter(c => c.table === '__restore')).toHaveLength(1)
  })

  it('a set end refused as closed is kept, not "Sync failed"; the match\'s queued writes are set aside', async () => {
    fakeDb.sync_queue.reset([eventInsert(1)])
    api.respond = (call) => (call.table === 'sets' ? closed : defaultRespond(call))
    // (the mounted queue's flush)
    const pass = () => { runQueuePass() }
    window.addEventListener('sync-queue-flush-now', pass)
    const [result] = await queueAndWait([{ resource: 'set', action: 'update', payload: { external_id: `${SEED}:s:3`, match_id: SEED, finished: true } }])
    window.removeEventListener('sync-queue-flush-now', pass)
    expect(result).toMatchObject({ success: false, offline: true, setAside: true })
    expect(fakeDb.sync_queue.map.get(result.jobId)).toMatchObject({ status: 'dropped', superseded_by: 'server-closed' })
    expect(fakeDb.sync_queue.map.get(1)).toMatchObject({ status: 'superseded', superseded_by: 'server-closed' })
    expect(fakeDb.matches.map.get(1).cloudBlock).toMatchObject({ code: 'OV_MATCH_CLOSED' })
    expect(await getSyncQueueStats()).toEqual({ pending: 0, error: 0, failed: 0 })
  })

  it('a refused write whose local copy is gone (Close match removed it) is set aside with the match\'s others', async () => {
    fakeDb.matches.reset([])
    fakeDb.sync_queue.reset([eventInsert(1), eventInsert(2), { id: 3, resource: 'match', action: 'delete', status: 'queued', payload: { id: SEED } }])
    api.respond = (call) => (call.table === 'events' ? closed : defaultRespond(call))
    const outcome = await runQueuePass()
    expect(outcome.hasFailed).toBeFalsy()
    expect(fakeDb.sync_queue.map.get(1)).toMatchObject({ status: 'dropped', superseded_by: 'server-closed' })
    expect(fakeDb.sync_queue.map.get(2)).toMatchObject({ status: 'superseded', superseded_by: 'server-closed' })
    // a delete is never set aside: answered "closed", it is done
    expect(fakeDb.sync_queue.map.get(3).status).toBe('sent')
  })

  it('Close match\'s queued \'final\' still goes after an older write of the match is refused as closed', async () => {
    // The approval went out (the server is 'approved'), an older event waited
    // as 'failed', and Close match queued 'final' and removed the local copy
    fakeDb.matches.reset([])
    fakeDb.sync_queue.reset([
      { ...eventInsert(1), status: 'failed', last_error: { status: 422, code: 'OV_INVALID_REQUEST' } },
      { id: 2, resource: 'match', action: 'update', status: 'sent', payload: { id: SEED, status: 'approved' } },
      { id: 3, resource: 'match', action: 'update', status: 'queued', retry_count: 0, payload: { id: SEED, status: 'final' } }
    ])
    // db/007: a closed match still takes approved -> final, no other write
    api.respond = (call) => (call.table === 'events' || (call.table === 'matches' && call.action === 'update' && call.data?.status !== 'final')
      ? closed : defaultRespond(call))
    // the startup retry requeues the old write; 'final' waits for it (closingMustWait)
    await retryErrorsInternal({ force: true, includeFailed: true })
    const outcome = await runQueuePass()
    expect(outcome.hasFailed).toBeFalsy()
    expect(fakeDb.sync_queue.map.get(1)).toMatchObject({ status: 'dropped', superseded_by: 'server-closed' })
    expect(fakeDb.sync_queue.map.get(3).status).toBe('queued')
    await runQueuePass()
    expect(api.calls.some(c => c.table === 'matches' && c.action === 'update' && c.data?.status === 'final')).toBe(true)
    expect(fakeDb.sync_queue.map.get(3).status).toBe('sent')
    expect(await getSyncQueueStats()).toEqual({ pending: 0, error: 0, failed: 0 })
  })

  it('the block stays through a claim, a delete or an update the server accepts; an accepted event clears it', async () => {
    fakeDb.matches.reset([{ id: 1, seed_key: SEED, status: 'live', cloudBlock: block }])
    // a claim answered "closed" counts as sent (nothing to take over)
    fakeDb.sync_queue.reset([{ id: 1, resource: 'match', action: 'scorer', status: 'queued', payload: { id: SEED } }])
    api.respond = (call) => (call.table === '__scorer' ? closed : defaultRespond(call))
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(1).status).toBe('sent')
    expect(fakeDb.matches.map.get(1).cloudBlock).toEqual(block)

    // a match delete answered "closed" is done as well
    fakeDb.sync_queue.reset([{ id: 2, resource: 'match', action: 'delete', status: 'queued', payload: { id: SEED } }])
    api.respond = (call) => (call.table === 'matches' && call.action === 'delete' ? closed : defaultRespond(call))
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(2).status).toBe('sent')
    expect(fakeDb.matches.map.get(1).cloudBlock).toEqual(block)

    // a match update passes on a closed match when it changes nothing, a set
    // update when the server has no such row: neither proves it open
    fakeDb.sync_queue.reset([matchUpdate(3), setUpdate(4)])
    api.respond = defaultRespond
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(3).status).toBe('sent')
    expect(fakeDb.sync_queue.map.get(4).status).toBe('sent')
    expect(fakeDb.matches.map.get(1).cloudBlock).toEqual(block)

    // an accepted event insert does: an admin reopened the match
    fakeDb.sync_queue.reset([eventInsert(5)])
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(5).status).toBe('sent')
    expect(fakeDb.matches.map.get(1).cloudBlock).toBeNull()
  })

  it('an accepted restore clears the block too', async () => {
    fakeDb.matches.reset([{ id: 1, seed_key: SEED, status: 'live', cloudBlock: block }])
    fakeDb.sync_queue.reset([restore(1)])
    api.respond = (call) => (call.table === '__restore' ? ok({ id: MATCH_UUID, counts: {} }) : defaultRespond(call))
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(1).status).toBe('sent')
    expect(fakeDb.matches.map.get(1).cloudBlock).toBeNull()
  })

  describe('at app start (devices stuck before this version)', () => {
    // The phone as it was: the restore parked as 'failed', four writes held behind it
    const stuck = () => [
      restore(1, { status: 'failed', attempts: 9, last_error: { status: 409, code: 'OV_MATCH_CLOSED', message: 'Match is closed' } }),
      { ...eventInsert(2), resource: 'set', action: 'insert', payload: { external_id: `${SEED}:s:3`, match_id: SEED, index: 3 } },
      setUpdate(3), eventInsert(4), matchUpdate(5)
    ]

    beforeEach(() => {
      vi.useFakeTimers()
      localStorage.setItem('api_auth_token', JSON.stringify({ access_token: 't' }))
      fakeDb.matches.reset([{ id: 1, seed_key: SEED, gameN: 406970, status: 'live', cloudBlock: block }])
      fakeDb.sync_queue.reset(stuck())
    })
    afterEach(() => {
      vi.useRealTimers()
      vi.restoreAllMocks()
      localStorage.removeItem('api_auth_token')
    })

    it('offline: the writes are set aside before anything is sent; the copy is unchanged', async () => {
      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
      const before = { ...fakeDb.matches.map.get(1) }
      const { unmount } = renderHook(() => useSyncQueue())
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(await getSyncQueueStats()).toEqual({ pending: 0, error: 0, failed: 0 })
      for (const id of [1, 2, 3, 4, 5]) expect(fakeDb.sync_queue.map.get(id)).toMatchObject({ status: 'superseded', superseded_by: 'server-closed' })
      expect(fakeDb.matches.map.get(1)).toEqual(before)
      expect(api.calls).toEqual([])
      unmount()
    })

    it('online: the startup retry sends no restore (the refused one is set aside first)', async () => {
      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
      const { unmount } = renderHook(() => useSyncQueue())
      await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
      expect(api.calls.filter(c => c.table === '__restore')).toEqual([])
      expect(api.calls.filter(c => c.action !== 'select')).toEqual([])
      expect(await getSyncQueueStats()).toEqual({ pending: 0, error: 0, failed: 0 })
      unmount()
    })

    it('a match without the block: only a write parked as refused-as-closed is set aside, its queued writes still go', async () => {
      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
      fakeDb.matches.reset([{ id: 1, seed_key: SEED, gameN: 406970, status: 'live' }])
      const { unmount } = renderHook(() => useSyncQueue())
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(fakeDb.sync_queue.map.get(1)).toMatchObject({ status: 'superseded', superseded_by: 'server-closed' })
      for (const id of [2, 3, 4, 5]) expect(fakeDb.sync_queue.map.get(id).status).toBe('queued')
      unmount()
    })
  })
})
