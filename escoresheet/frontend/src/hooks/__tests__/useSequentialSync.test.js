import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

function fakeTable() {
  const map = new Map()
  let nextId = 1
  return {
    map,
    add: async (row) => { const id = nextId++; map.set(id, { ...row, id }); return id },
    update: async (id, changes) => { map.set(id, { ...map.get(id), ...changes }); return 1 },
    bulkGet: async (ids) => ids.map(id => map.get(id))
  }
}

const fakeDb = vi.hoisted(() => ({}))
vi.mock('../../db/db', () => ({ db: fakeDb }))

import { queueAndWait, useSequentialSync } from '../useSequentialSync'

const SET_END = { resource: 'set', action: 'update', payload: { external_id: 'match_1_a:s:1', finished: true } }
const MATCH_END = { resource: 'match', action: 'update', payload: { id: 'match_1_a', current_set: 2, set_results: [] } }

// The mounted sync queue (useSyncQueue) answers a flush request: `settle`
// gives each queued row the status the queue would have left it in
let flushes
function queueAnswers(settle) {
  const onFlush = () => {
    flushes++
    for (const row of fakeDb.sync_queue.map.values()) {
      const status = settle(row)
      if (status) fakeDb.sync_queue.map.set(row.id, { ...row, status })
    }
  }
  window.addEventListener('sync-queue-flush-now', onFlush)
  return () => window.removeEventListener('sync-queue-flush-now', onFlush)
}

let stop = () => {}
beforeEach(() => {
  fakeDb.sync_queue = fakeTable()
  fakeDb.transaction = async (...args) => args[args.length - 1]()
  flushes = 0
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
})
afterEach(() => {
  stop()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('queueAndWait', () => {
  it('queues the writes together, in order, and asks the queue to send them now', async () => {
    let atFlush
    stop = queueAnswers(() => { atFlush ??= [...fakeDb.sync_queue.map.values()].map(r => [r.resource, r.status]); return 'sent' })
    const results = await queueAndWait([SET_END, MATCH_END])
    expect(atFlush).toEqual([['set', 'queued'], ['match', 'queued']])
    expect(flushes).toBe(1)
    expect(results).toEqual([{ success: true, jobId: 1 }, { success: true, jobId: 2 }])
  })

  it('a write the queue left unsent at the deadline is reported as saved locally, and stays queued', async () => {
    vi.useFakeTimers()
    stop = queueAnswers(() => null) // waiting behind older writes, or the cloud is down
    const pending = queueAndWait([SET_END], 1000)
    await vi.advanceTimersByTimeAsync(1000)
    const [result] = await pending
    expect(result).toEqual({ success: false, offline: true, jobId: 1 })
    expect(fakeDb.sync_queue.map.get(1).status).toBe('queued')
  })

  it('reports a write sent by a later pass within the wait as sent', async () => {
    vi.useFakeTimers()
    stop = queueAnswers(() => null)
    const pending = queueAndWait([SET_END], 1000)
    await vi.advanceTimersByTimeAsync(400)
    fakeDb.sync_queue.map.set(1, { ...fakeDb.sync_queue.map.get(1), status: 'sent' })
    await vi.advanceTimersByTimeAsync(200)
    expect(await pending).toEqual([{ success: true, jobId: 1 }])
  })

  it('a write the backend refused (failed) or that failed (error) is an error', async () => {
    stop = queueAnswers((row) => (row.resource === 'set' ? 'failed' : 'error'))
    const [set, match] = await queueAndWait([SET_END, MATCH_END])
    expect(set).toMatchObject({ success: false, error: 'set update refused' })
    expect(set.offline).toBeUndefined()
    expect(match).toMatchObject({ success: false, error: 'match update failed' })
  })

  it('a write set aside for another scoring device is kept (a warning), not failed', async () => {
    stop = queueAnswers(() => 'dropped')
    const [result] = await queueAndWait([SET_END])
    expect(result).toMatchObject({ success: false, offline: true, setAside: true })
    expect(result.error).toBeUndefined()
  })

  it('offline: queued, nothing asked of the queue, reported as saved locally at once', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    stop = queueAnswers(() => 'sent')
    const results = await queueAndWait([SET_END, MATCH_END])
    expect(flushes).toBe(0)
    expect(results).toEqual([{ success: false, offline: true, jobId: 1 }, { success: false, offline: true, jobId: 2 }])
    expect([...fakeDb.sync_queue.map.values()].map(r => r.status)).toEqual(['queued', 'queued'])
  })
})

describe('useSequentialSync.syncSetEnd', () => {
  const run = async (params) => {
    const { result, unmount } = renderHook(() => useSequentialSync())
    let out
    await act(async () => { out = await result.current.syncSetEnd(params) })
    const state = result.current.syncState
    unmount()
    return { out, state }
  }

  it('sends the set and the match update, then reports the steps done', async () => {
    stop = queueAnswers(() => 'sent')
    const { out, state } = await run({ lastPointPayload: null, setPayload: SET_END.payload, matchPayload: MATCH_END.payload })
    expect(out).toEqual({ success: true, hasWarning: false })
    expect(state.steps.map(s => s.status)).toEqual(['done', 'done', 'done'])
    expect(state.isComplete).toBe(true)
    expect([...fakeDb.sync_queue.map.values()].map(r => r.resource)).toEqual(['set', 'match'])
  })

  // Stress test 2026-10-25: on a hung backend the whole scoreboard stayed
  // behind "Syncing to cloud..." for up to 22 s at every set end
  it('waits at most about 2 s in all for a cloud that does not answer', async () => {
    vi.useFakeTimers()
    stop = queueAnswers(() => null)
    const { result, unmount } = renderHook(() => useSequentialSync())
    let out = null
    await act(async () => {
      result.current.syncSetEnd({ lastPointPayload: null, setPayload: SET_END.payload, matchPayload: MATCH_END.payload }).then(r => { out = r })
      await vi.advanceTimersByTimeAsync(2500)
    })
    expect(out).toEqual({ success: true, hasWarning: true })
    // saved on the device, still queued for the background queue
    expect([...fakeDb.sync_queue.map.values()].map(r => r.status)).toEqual(['queued', 'queued'])
    unmount()
  })

  it('a match update still waiting is a warning, a refused set update an error', async () => {
    vi.useFakeTimers()
    stop = queueAnswers((row) => (row.resource === 'set' ? 'sent' : null))
    const { result, unmount } = renderHook(() => useSequentialSync())
    let out
    await act(async () => {
      const pending = result.current.syncSetEnd({ lastPointPayload: null, setPayload: SET_END.payload, matchPayload: MATCH_END.payload })
      await vi.advanceTimersByTimeAsync(15000)
      out = await pending
    })
    expect(out).toEqual({ success: true, hasWarning: true })
    unmount()

    stop()
    stop = queueAnswers(() => 'failed')
    vi.useRealTimers()
    const refused = await run({ lastPointPayload: null, setPayload: SET_END.payload, matchPayload: null })
    expect(refused.out).toEqual({ success: false, hasWarning: false })
    expect(refused.state.steps[1].status).toBe('error')
  })
})
