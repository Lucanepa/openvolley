import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// In-memory stand-ins for the Dexie tables and the /api/db client
// ---------------------------------------------------------------------------

function fakeTable(rows = []) {
  const map = new Map(rows.map(r => [r.id, { ...r }]))
  const collection = (pred) => ({
    toArray: async () => [...map.values()].filter(pred).sort((a, b) => a.id - b.id),
    first: async () => [...map.values()].filter(pred)[0],
    and: (fn) => collection(r => pred(r) && fn(r))
  })
  return {
    map,
    reset(newRows) {
      map.clear()
      for (const r of newRows) map.set(r.id, { ...r })
    },
    get: async (id) => map.get(id),
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
    hook: () => {}
  }
}

// Module load installs a Dexie 'creating' hook on sync_queue
const fakeDb = vi.hoisted(() => ({ sync_queue: { hook: () => {} } }))
vi.mock('../../db/db', () => ({ db: fakeDb }))

// Every apiFrom call is recorded; `respond` decides the result
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
  return { apiFrom: (table) => builder(table) }
})

vi.mock('../../utils/backendConfig', () => ({ getApiUrl: (p) => `http://backend.test${p}` }))

import {
  runQueuePass,
  retryErrorsInternal,
  payloadCovers,
  errorBackoffMs,
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
  api.calls = []
  api.respond = defaultRespond
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

  it('a failed set insert holds back the later update of the same set (per-entity FIFO)', async () => {
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'set', action: 'insert', status: 'queued', payload: { external_id: 'match_100_aaa:s:5', match_id: 'match_100_aaa', index: 1 } },
      { id: 2, resource: 'set', action: 'update', status: 'queued', payload: { external_id: 'match_100_aaa:s:5', finished: true } }
    ])
    api.respond = (call) => (call.table === 'sets' && call.action === 'upsert'
      ? { data: null, error: { message: 'Database operation failed', status: 400 } }
      : defaultRespond(call))

    const outcome = await runQueuePass()
    expect(outcome.hasError).toBe(true)
    expect(fakeDb.sync_queue.map.get(1).status).toBe('error')
    expect(fakeDb.sync_queue.map.get(1).attempts).toBe(1)
    expect(fakeDb.sync_queue.map.get(1).next_attempt_at).toBeGreaterThan(Date.now())
    expect(fakeDb.sync_queue.map.get(2).status).toBe('queued')
    expect(api.calls.some(c => c.table === 'sets' && c.action === 'update')).toBe(false)
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

  it('restore fails (and is retried) when a set cannot be written', async () => {
    fakeDb.sync_queue.reset([
      {
        id: 1,
        resource: 'match',
        action: 'restore',
        status: 'queued',
        payload: {
          match: { external_id: 'match_100_aaa', status: 'live' },
          sets: [{ external_id: 'match_100_aaa:s:1', index: 1 }],
          events: [],
          liveState: null
        }
      }
    ])
    api.respond = (call) => (call.table === 'sets' && call.action === 'upsert'
      ? { data: null, error: { message: 'Database operation failed', status: 400 } }
      : defaultRespond(call))

    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(1).status).toBe('error')
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

  it('does not supersede when the newer update lacks a field', async () => {
    fakeDb.sync_queue.reset([
      { id: 1, resource: 'match', action: 'update', status: 'error', payload: { id: 'match_100_aaa', status: 'live', winner: 'home' } },
      { id: 2, resource: 'match', action: 'update', status: 'sent', payload: { id: 'match_100_aaa', status: 'ended' } }
    ])

    await retryErrorsInternal({ force: true })
    expect(fakeDb.sync_queue.map.get(1).status).toBe('queued')
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
