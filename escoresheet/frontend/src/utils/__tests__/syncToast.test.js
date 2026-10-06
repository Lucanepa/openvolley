import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../db/db', () => ({ db: { sync_queue: { get: vi.fn() } } }))
vi.mock('../../hooks/useSyncQueue', () => ({ hasStoredSessionToken: () => true }))

import { syncJobsOutcome, toastSyncOutcome } from '../syncToast'

const MESSAGES = { synced: 'Match synced', failed: 'Sync failed', pending: 'Match saved locally (sync pending)' }

function setup({ jobs = {}, canSync = () => true } = {}) {
  const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn() }
  const store = { ...jobs }
  const getJob = vi.fn(async (id) => store[id])
  return { notify, store, getJob, canSync }
}

const shown = (notify) => [
  ...notify.success.mock.calls.map(c => ['success', c[0]]),
  ...notify.error.mock.calls.map(c => ['error', c[0]]),
  ...notify.info.mock.calls.map(c => ['info', c[0]])
]

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('syncJobsOutcome', () => {
  it('reads sent, superseded, dropped and pruned rows as synced', () => {
    expect(syncJobsOutcome([{ status: 'sent' }, { status: 'superseded' }, undefined, { status: 'dropped' }])).toBe('synced')
  })
  it('an errored or refused row wins', () => {
    expect(syncJobsOutcome([{ status: 'sent' }, { status: 'failed' }])).toBe('failed')
    expect(syncJobsOutcome([{ status: 'queued' }, { status: 'error' }])).toBe('failed')
  })
  it('anything still queued or sending is pending', () => {
    expect(syncJobsOutcome([{ status: 'sent' }, { status: 'sending' }])).toBe('pending')
  })
})

describe('toastSyncOutcome', () => {
  it('shows one success toast once the job is sent', async () => {
    const s = setup({ jobs: { 7: { status: 'queued' } } })
    toastSyncOutcome([7], { messages: MESSAGES, getJob: s.getJob, canSync: s.canSync, notify: s.notify, lang: 'de-CH' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(shown(s.notify)).toEqual([])
    s.store[7] = { status: 'sent' }
    await vi.advanceTimersByTimeAsync(10000)
    expect(shown(s.notify)).toEqual([['success', 'Match synced']])
    expect(s.notify.success.mock.calls[0][1]).toEqual({ lang: 'DE' })
  })

  it('signed out or offline: the pending notice at once, and never a later one', async () => {
    const s = setup({ jobs: { 7: { status: 'queued' } }, canSync: () => false })
    toastSyncOutcome([7], { messages: MESSAGES, getJob: s.getJob, canSync: s.canSync, notify: s.notify })
    expect(shown(s.notify)).toEqual([['info', 'Match saved locally (sync pending)']])
    s.store[7] = { status: 'sent' }
    await vi.advanceTimersByTimeAsync(60000)
    expect(shown(s.notify)).toHaveLength(1)
    expect(s.getJob).not.toHaveBeenCalled()
  })

  it('still queued after the timeout: one info toast (not a success), then stops', async () => {
    const s = setup({ jobs: { 7: { status: 'queued' } } })
    toastSyncOutcome([7], { messages: MESSAGES, getJob: s.getJob, canSync: s.canSync, notify: s.notify, timeoutMs: 10000 })
    await vi.advanceTimersByTimeAsync(12000)
    expect(shown(s.notify)).toEqual([['info', 'Match saved locally (sync pending)']])
    const calls = s.getJob.mock.calls.length
    await vi.advanceTimersByTimeAsync(10000)
    expect(s.getJob.mock.calls.length).toBe(calls)
  })

  it('an error shows the error toast', async () => {
    const s = setup({ jobs: { 7: { status: 'error' } } })
    toastSyncOutcome([7], { messages: MESSAGES, getJob: s.getJob, canSync: s.canSync, notify: s.notify })
    await vi.advanceTimersByTimeAsync(600)
    expect(shown(s.notify)).toEqual([['error', 'Sync failed']])
  })

  it('watches only its own job, not other queued work', async () => {
    const s = setup({ jobs: { 7: { status: 'sent' }, 8: { status: 'queued' } } })
    toastSyncOutcome([7], { messages: MESSAGES, getJob: s.getJob, canSync: s.canSync, notify: s.notify })
    await vi.advanceTimersByTimeAsync(600)
    expect(shown(s.notify)).toEqual([['success', 'Match synced']])
  })

  it('a save that queued nothing (test match) shows nothing', async () => {
    const s = setup()
    toastSyncOutcome([null], { messages: MESSAGES, getJob: s.getJob, canSync: s.canSync, notify: s.notify })
    await vi.advanceTimersByTimeAsync(20000)
    expect(shown(s.notify)).toEqual([])
  })

  it('stop() cancels the watch', async () => {
    const s = setup({ jobs: { 7: { status: 'queued' } } })
    const stop = toastSyncOutcome([7], { messages: MESSAGES, getJob: s.getJob, canSync: s.canSync, notify: s.notify })
    stop()
    s.store[7] = { status: 'sent' }
    await vi.advanceTimersByTimeAsync(20000)
    expect(shown(s.notify)).toEqual([])
  })
})
