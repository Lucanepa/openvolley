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
    }
  }
})

vi.mock('../../utils/backendConfig', () => ({ getApiUrl: (p) => `http://backend.test${p}` }))

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
  STOP_PASS
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

  it('logs match payloads without PINs', () => {
    expect(redactForLog({ external_id: 'm', game_pin: '123456', connection_pins: { referee: '1' }, home_team: { name: 'A' } }))
      .toEqual({ external_id: 'm', home_team: { name: 'A' } })
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
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
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

  it('waits for a sign-in after a 401 (no request churn), then resumes at once', async () => {
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
