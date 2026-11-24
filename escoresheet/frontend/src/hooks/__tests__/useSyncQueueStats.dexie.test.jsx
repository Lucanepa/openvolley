// useSyncQueueStats on the app's database (Dexie 4 on fake-indexeddb): the
// header's sync indicator re-renders when a count changes, not at each write
// of the queue (a point writes it several times: add, coalesce, sent).
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { db } from '../../db/db'
import { useSyncQueueStats } from '../useSyncQueue'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

beforeEach(async () => {
  await db.open()
  await db.sync_queue.clear()
})

describe('useSyncQueueStats', () => {
  it('zeros first, then the counts; a write that changes no count renders nothing', async () => {
    const results = []
    const { result, unmount } = renderHook(() => {
      const stats = useSyncQueueStats()
      results.push(stats)
      return stats
    })
    expect(result.current).toEqual({ pending: 0, error: 0, failed: 0 })
    await waitFor(() => expect(result.current).toEqual({ pending: 0, error: 0, failed: 0, serverBehind: 0 }))

    let id
    await act(async () => { id = await db.sync_queue.add({ resource: 'event', action: 'insert', status: 'queued', payload: { n: 1 }, ts: 't' }) })
    await waitFor(() => expect(result.current).toMatchObject({ pending: 1, error: 0, failed: 0 }))
    const shown = result.current
    const renders = results.length

    // the job coalesced (its payload rewritten), then taken for sending: still pending
    await act(async () => {
      await db.sync_queue.update(id, { payload: { n: 2 } })
      await db.sync_queue.update(id, { status: 'sending' })
      await sleep(100)
    })
    expect(results.length).toBe(renders)
    expect(result.current).toBe(shown)

    // refused for a column the server does not have yet: failed, serverBehind
    await act(async () => { await db.sync_queue.update(id, { status: 'failed', last_error: { code: '42703', message: 'column "x" does not exist' } }) })
    await waitFor(() => expect(result.current).toMatchObject({ pending: 0, failed: 1 }))
    expect(result.current.serverBehind).toBe(1)
    unmount()
  })
})
