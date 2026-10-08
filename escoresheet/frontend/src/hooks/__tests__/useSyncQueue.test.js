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
  CLOUD_BLOCK_EVENT
} from '../useSyncQueue'

const MATCH_UUID = '11111111-2222-4333-8444-555555555555'
const ok = (data = null) => ({ data, error: null })

// Default backend: the match exists, every write succeeds
function defaultRespond(call) {
  if (call.table === 'matches' && call.action === 'select') return ok({ id: MATCH_UUID })
  return ok()
}

beforeEach(() => {
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

  it('a closed match (409) is a refusal like any event write', async () => {
    fakeDb.sync_queue.reset([voidJob(1)])
    api.respond = (call) => (call.table === '__revisions' ? { data: null, error: { message: 'closed', status: 409, code: 'OV_MATCH_CLOSED' }, status: 409 } : defaultRespond(call))
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(1).status).toBe('failed')
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

  it.each(['OV_SCORER_REQUIRED', 'OV_MATCH_CLOSED'])('%s sets the block with no claim', async (code) => {
    fakeDb.sync_queue.reset([eventJob(1)])
    api.respond = (call) => {
      if (call.table === 'events') return { data: null, error: { message: 'no', code, status: code === 'OV_SCORER_REQUIRED' ? 403 : 409 } }
      return defaultRespond(call)
    }
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(1).status).toBe('failed')
    expect(fakeDb.matches.map.get(1).cloudBlock).toMatchObject({ code, claim: null })
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
