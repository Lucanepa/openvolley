import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { startSentRosterWatch, SENT_ROSTER_POLL_MS, SENT_ROSTER_MIN_GAP_MS, REMOTE_PANEL_CHECK_MS } from '../useSentRosterRefresh'

// A roster sent while Match Setup is open (17.11.2026): asked again on a
// timer and when the screen comes back, never offline, hidden or twice at once
function setup ({ online = true, hidden = false, refresh } = {}) {
  const win = new EventTarget()
  const doc = new EventTarget()
  doc.visibilityState = hidden ? 'hidden' : 'visible'
  const state = { online }
  const calls = []
  const stop = startSentRosterWatch({
    refresh: refresh || (async () => { calls.push(Date.now()) }),
    win,
    doc,
    isOnline: () => state.online
  })
  return { win, doc, state, calls, stop }
}
const flush = () => vi.advanceTimersByTimeAsync(0)

describe('startSentRosterWatch', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('asks at once, then every SENT_ROSTER_POLL_MS', async () => {
    const { calls, stop } = setup()
    await flush()
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(SENT_ROSTER_POLL_MS)
    expect(calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(SENT_ROSTER_POLL_MS * 3)
    expect(calls).toHaveLength(5)
    stop()
    await vi.advanceTimersByTimeAsync(SENT_ROSTER_POLL_MS * 3)
    expect(calls).toHaveLength(5)
  })

  it('asks when the screen comes back, the window gets focus, the app resumes or the connection returns, not within the gap', async () => {
    const { win, doc, calls, stop } = setup()
    await flush()
    win.dispatchEvent(new Event('focus'))
    await flush()
    expect(calls).toHaveLength(1)
    for (const [target, type] of [[doc, 'visibilitychange'], [win, 'focus'], [doc, 'resume'], [win, 'online']]) {
      await vi.advanceTimersByTimeAsync(SENT_ROSTER_MIN_GAP_MS)
      target.dispatchEvent(new Event(type))
      await flush()
    }
    expect(calls).toHaveLength(5)
    stop()
    await vi.advanceTimersByTimeAsync(SENT_ROSTER_MIN_GAP_MS)
    win.dispatchEvent(new Event('focus'))
    doc.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(calls).toHaveLength(5)
  })

  it('never offline or while hidden; once online again, at once', async () => {
    const { win, doc, state, calls, stop } = setup({ online: false, hidden: true })
    await vi.advanceTimersByTimeAsync(SENT_ROSTER_POLL_MS * 2)
    expect(calls).toHaveLength(0)
    state.online = true
    await vi.advanceTimersByTimeAsync(SENT_ROSTER_POLL_MS)
    expect(calls).toHaveLength(0) // still hidden
    doc.visibilityState = 'visible'
    doc.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(calls).toHaveLength(1)
    state.online = false
    await vi.advanceTimersByTimeAsync(SENT_ROSTER_POLL_MS)
    expect(calls).toHaveLength(1)
    state.online = true
    win.dispatchEvent(new Event('online'))
    await flush()
    expect(calls).toHaveLength(2)
    stop()
  })

  it('one request at a time, and a failed one does not stop the next', async () => {
    let release
    let n = 0
    const refresh = vi.fn(() => {
      n++
      if (n === 1) return new Promise((resolve) => { release = resolve })
      if (n === 2) return Promise.reject(new Error('offline'))
      return Promise.resolve()
    })
    const { stop } = setup({ refresh })
    await flush()
    await vi.advanceTimersByTimeAsync(SENT_ROSTER_POLL_MS * 2)
    expect(refresh).toHaveBeenCalledTimes(1) // the first still runs
    release()
    await flush()
    await vi.advanceTimersByTimeAsync(SENT_ROSTER_POLL_MS)
    expect(refresh).toHaveBeenCalledTimes(2) // fails
    await vi.advanceTimersByTimeAsync(SENT_ROSTER_POLL_MS)
    expect(refresh).toHaveBeenCalledTimes(3)
    stop()
  })
})

// Match Setup's Remote panel (21.11.2026): the same watch, every 30 s
describe('the Remote panel\'s own check', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('asks every REMOTE_PANEL_CHECK_MS (30 s), never offline', async () => {
    expect(REMOTE_PANEL_CHECK_MS).toBe(30 * 1000)
    const win = new EventTarget()
    const doc = new EventTarget()
    doc.visibilityState = 'visible'
    const state = { online: true }
    const calls = []
    const stop = startSentRosterWatch({ refresh: async () => { calls.push(Date.now()) }, intervalMs: REMOTE_PANEL_CHECK_MS, win, doc, isOnline: () => state.online })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(REMOTE_PANEL_CHECK_MS)
    expect(calls).toHaveLength(2)
    state.online = false
    await vi.advanceTimersByTimeAsync(REMOTE_PANEL_CHECK_MS * 2)
    expect(calls).toHaveLength(2)
    state.online = true
    win.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(3)
    stop()
    await vi.advanceTimersByTimeAsync(REMOTE_PANEL_CHECK_MS * 2)
    expect(calls).toHaveLength(3)
  })
})
