// The undo of an account approval goes through the sync queue (audit
// fe-home-options-1): a change of the sheet after the approval, made offline,
// left the server's row active; it came back with the next refresh and
// completed its slot again. The job is retried like every write, and the
// approval of the match waits for it.
import { describe, it, expect, vi, beforeEach } from 'vitest'

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

const fakeDb = vi.hoisted(() => ({ sync_queue: { hook: () => {} } }))
vi.mock('../../db/db', () => ({ db: fakeDb }))

// /api/db (apiFrom) and the account endpoints (apiRequest) are recorded
const api = vi.hoisted(() => ({ calls: [], respond: null }))
vi.mock('../../lib/apiClient', () => {
  function builder(table) {
    const call = { table, action: null, data: null, filters: [] }
    const b = {
      select(cols) { if (!call.action) { call.action = 'select'; call.columns = cols } return b },
      insert(d) { call.action = 'insert'; call.data = d; return b },
      upsert(d) { call.action = 'upsert'; call.data = d; return b },
      update(d) { call.action = 'update'; call.data = d; return b },
      delete() { call.action = 'delete'; return b },
      eq(c, v) { call.filters.push(['eq', c, v]); return b },
      in(c, v) { call.filters.push(['in', c, v]); return b },
      limit() { return b },
      single() { return b },
      maybeSingle() { return b },
      then(resolve, reject) {
        api.calls.push(call)
        return Promise.resolve().then(() => api.respond(call)).then(resolve, reject)
      }
    }
    return b
  }
  return {
    AUTH_TOKEN_CHANGE_EVENT: 'api-auth-token-change',
    AUTH_TOKEN_STORAGE_KEY: 'api_auth_token',
    BACKEND_REACHED_EVENT: 'ov-backend-reached',
    apiFrom: (table) => builder(table),
    apiRequest: async (method, path) => {
      const call = { table: '__request', action: method, data: { path }, filters: [] }
      api.calls.push(call)
      return api.respond(call)
    },
    apiDownload: async () => ({ error: { status: 0, network: true } }),
    apiMatchRestore: async () => ({ data: null, error: null }),
    apiMatchClaim: async () => ({ data: null, error: null }),
    apiMatchScorer: async () => ({ data: null, error: null }),
    apiPostEventRevisions: async () => ({ data: null, error: null }),
    apiStorage: { from: () => ({ upload: async () => ({ data: null, error: null }) }) }
  }
})
vi.mock('../../utils/backendConfig', () => ({ getApiUrl: (p) => `http://backend.test${p}`, getCloudApiUrl: (p) => `http://backend.test${p}` }))

import { runQueuePass, clearAuthBlock, resetQueueHousekeeping } from '../useSyncQueue'
import { approvalUndoJobs } from '../../domain/accountApproval'

const SEED = 'match_100_aaa'
const MATCH_UUID = '11111111-2222-4333-8444-555555555555'
const APPROVAL_ID = '33333333-3333-4333-8333-333333333333'
const ok = (data = null) => ({ data, error: null, status: 200 })
const defaultRespond = (call) => (call.table === 'matches' && call.action === 'select' ? ok({ id: MATCH_UUID }) : ok({ approval: { id: APPROVAL_ID }, already: false }))
const undoJob = (id, status = 'queued') => ({ id, ...approvalUndoJobs({ seed_key: SEED, accountApprovals: { scorer: { id: APPROVAL_ID } } })[0], status, retry_count: 0 })
const close = (id) => ({ id, resource: 'match', action: 'update', status: 'queued', retry_count: 0, payload: { id: SEED, status: 'approved' } })
const undoCalls = () => api.calls.filter(c => c.table === '__request' && c.action === 'DELETE')

beforeEach(() => {
  fakeDb.transaction = async (...args) => args[args.length - 1]()
  fakeDb.sync_queue = fakeTable()
  fakeDb.matches = fakeTable([{ id: 1, seed_key: SEED }])
  fakeDb.sets = fakeTable()
  fakeDb.events = fakeTable()
  api.calls = []
  api.respond = defaultRespond
  clearAuthBlock()
  resetQueueHousekeeping()
})

describe('approval undo jobs', () => {
  it('approvalUndoJobs: one per approval of an official match, none for a test, local or closed one', () => {
    const approvals = { referee1: { id: 'a1' }, scorer: { id: 'a2' }, referee2: null }
    expect(approvalUndoJobs({ seed_key: SEED, accountApprovals: approvals }).map(j => [j.resource, j.action, j.payload])).toEqual([
      ['approval', 'undo', { id: 'a1', match_external_id: SEED }],
      ['approval', 'undo', { id: 'a2', match_external_id: SEED }]
    ])
    expect(approvalUndoJobs({ seed_key: SEED, test: true, accountApprovals: approvals })).toEqual([])
    expect(approvalUndoJobs({ accountApprovals: approvals })).toEqual([])
    expect(approvalUndoJobs({ seed_key: SEED, closed_at: '2026-11-09T21:00:00Z', accountApprovals: approvals })).toEqual([])
  })

  it('undoes the approval on the server', async () => {
    fakeDb.sync_queue.reset([undoJob(1)])
    await runQueuePass()
    expect(undoCalls().map(c => c.data.path)).toEqual([`/api/approvals/${APPROVAL_ID}`])
    expect(fakeDb.sync_queue.map.get(1).status).toBe('sent')
  })

  it('offline it stays queued and goes with a later pass', async () => {
    fakeDb.sync_queue.reset([undoJob(1)])
    api.respond = (call) => (call.table === '__request' ? { data: null, error: { message: 'Failed to fetch', status: 0, network: true }, status: 0 } : defaultRespond(call))
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(1).status).toBe('queued')
    api.respond = defaultRespond
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(1).status).toBe('sent')
  })

  it('an approval the server no longer has (replaced, undone elsewhere) counts as done', async () => {
    fakeDb.sync_queue.reset([undoJob(1)])
    api.respond = (call) => (call.table === '__request' ? { data: null, error: { message: 'Not found', code: 'OV_NOT_FOUND', status: 404 }, status: 404 } : defaultRespond(call))
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(1).status).toBe('sent')
  })

  it('a closed match keeps its approvals: dropped, not retried', async () => {
    fakeDb.sync_queue.reset([undoJob(1)])
    api.respond = (call) => (call.table === '__request' ? { data: null, error: { message: 'closed', code: 'OV_MATCH_CLOSED', status: 409 }, status: 409 } : defaultRespond(call))
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(1).status).toBe('dropped')
  })

  it('the approval of the match waits for an older undo still on its way', async () => {
    fakeDb.sync_queue.reset([undoJob(1, 'error'), close(2)])
    await runQueuePass()
    const closes = () => api.calls.filter(c => c.table === 'matches' && c.action === 'update')
    expect(closes()).toHaveLength(0)
    expect(fakeDb.sync_queue.map.get(2).status).toBe('queued')
    // the undo goes through: the approval follows
    fakeDb.sync_queue.update(1, { status: 'queued', next_attempt_at: 0 })
    await runQueuePass()
    await runQueuePass()
    expect(fakeDb.sync_queue.map.get(1).status).toBe('sent')
    expect(fakeDb.sync_queue.map.get(2).status).toBe('sent')
    expect(closes()).toHaveLength(1)
  })
})
