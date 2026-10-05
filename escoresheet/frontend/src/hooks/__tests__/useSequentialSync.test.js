import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

function fakeTable() {
  const map = new Map()
  let nextId = 1
  return {
    map,
    add: async (row) => { const id = nextId++; map.set(id, { ...row, id }); return id },
    update: async (id, changes) => { map.set(id, { ...map.get(id), ...changes }); return 1 }
  }
}

const fakeDb = vi.hoisted(() => ({}))
vi.mock('../../db/db', () => ({ db: fakeDb }))

const sync = vi.hoisted(() => ({ processJob: null }))
vi.mock('../useSyncQueue', () => ({
  processJob: (job) => sync.processJob(job),
  errorBackoffMs: () => 30000,
  DROP_JOB: 'drop',
  AUTH_REQUIRED: 'auth_required',
  PERMANENT_FAILURE: 'permanent'
}))

import { sendJobNow } from '../useSequentialSync'

const JOB = { resource: 'set', action: 'update', payload: { external_id: 'match_1_a:s:1', finished: true } }

beforeEach(() => {
  fakeDb.sync_queue = fakeTable()
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('sendJobNow', () => {
  it('claims the job as "sending" while the call is in flight, then marks it sent', async () => {
    let statusDuringCall
    sync.processJob = async (job) => {
      statusDuringCall = fakeDb.sync_queue.map.get(job.id).status
      return true
    }
    const result = await sendJobNow(JOB)
    expect(statusDuringCall).toBe('sending')
    expect(result).toMatchObject({ success: true })
    expect(fakeDb.sync_queue.map.get(result.jobId).status).toBe('sent')
  })

  it('on timeout returns at once but keeps the row "sending" until the call settles', async () => {
    vi.useFakeTimers()
    let finish
    sync.processJob = () => new Promise(resolve => { finish = resolve })

    const pending = sendJobNow(JOB, 1000)
    await vi.advanceTimersByTimeAsync(1000)
    const result = await pending

    expect(result).toMatchObject({ success: false, offline: true })
    // not handed back to the background queue while the original call runs
    expect(fakeDb.sync_queue.map.get(result.jobId).status).toBe('sending')

    finish(true)
    await vi.runAllTimersAsync()
    expect(fakeDb.sync_queue.map.get(result.jobId).status).toBe('sent')
  })

  it('a late failure after the timeout still parks the job as an error', async () => {
    vi.useFakeTimers()
    let finish
    sync.processJob = () => new Promise(resolve => { finish = resolve })
    const pending = sendJobNow(JOB, 1000)
    await vi.advanceTimersByTimeAsync(1000)
    const { jobId } = await pending
    finish(false)
    await vi.runAllTimersAsync()
    expect(fakeDb.sync_queue.map.get(jobId)).toMatchObject({ status: 'error', attempts: 1 })
  })

  it('a deferred result (match not in the cloud yet) goes back to the queue', async () => {
    sync.processJob = async () => null
    const result = await sendJobNow(JOB)
    expect(result).toMatchObject({ success: false, offline: true })
    expect(fakeDb.sync_queue.map.get(result.jobId).status).toBe('queued')
  })

  it('a job the backend refuses (4xx) is parked as failed, not retried with backoff', async () => {
    sync.processJob = async () => 'permanent'
    const result = await sendJobNow(JOB)
    expect(result).toMatchObject({ success: false })
    expect(result.offline).toBeUndefined()
    expect(fakeDb.sync_queue.map.get(result.jobId)).toMatchObject({ status: 'failed', attempts: 1 })
  })

  it('a missing session leaves the job queued and reports it as deferred', async () => {
    sync.processJob = async () => 'auth_required'
    const result = await sendJobNow(JOB)
    expect(result).toMatchObject({ success: false, offline: true, authRequired: true })
    expect(fakeDb.sync_queue.map.get(result.jobId).status).toBe('queued')
  })

  it('an exception requeues the job and reports the error', async () => {
    sync.processJob = async () => { throw new Error('boom') }
    const result = await sendJobNow(JOB)
    expect(result).toMatchObject({ success: false, error: 'boom' })
    expect(fakeDb.sync_queue.map.get(result.jobId)).toMatchObject({ status: 'queued', error_message: 'boom' })
  })

  it('offline: queued without calling the backend', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    sync.processJob = vi.fn()
    const result = await sendJobNow(JOB)
    expect(sync.processJob).not.toHaveBeenCalled()
    expect(result).toMatchObject({ offline: true })
    expect(fakeDb.sync_queue.map.get(result.jobId).status).toBe('queued')
  })
})
