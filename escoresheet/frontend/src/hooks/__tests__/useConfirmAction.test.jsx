// The confirmation-dialog pattern used by every scorer dialog (Scoreboard):
// snapshot when the dialog opens, close before the first await, and refuse a
// second run while one is in flight. Scoreboard is too large to render here,
// so a small harness reproduces the time-out request dialog against a store
// that behaves like Dexie's live query: the screen re-renders the moment the
// write commits, while the confirm handler is still awaiting the rest of its
// work (snapshot capture, sync queue).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { render, screen, fireEvent, act, renderHook } from '@testing-library/react'
import { useConfirmAction, GHOST_CLICK_MS, resetGhostClickGuard } from '../useConfirmAction'
import { classifyTimeoutRequest } from '../../domain/timeouts'

const sleep = ms => new Promise(r => setTimeout(r, ms))

// each test starts without the previous test's ghost-click guard
afterEach(() => resetGhostClickGuard())

function liveStore(initial = []) {
  let events = initial
  const listeners = new Set()
  return {
    subscribe: l => { listeners.add(l); return () => listeners.delete(l) },
    get: () => events,
    writes: 0,
    // like logEvent: the event commits (live query fires), then more awaits
    async write(e) {
      this.writes++
      await sleep(1)
      events = [...events, { ...e, setIndex: 1, seq: events.length + 1 }]
      listeners.forEach(l => l())
      await sleep(20)
    }
  }
}

// pattern 'fixed': snapshot + close first + guard (what Scoreboard does now)
// pattern 'before': live label + write then close, no guard (what it did)
function TimeoutDialog({ store, pattern, log }) {
  const events = useSyncExternalStore(store.subscribe, store.get)
  const liveUsed = events.filter(e => e.type === 'timeout').length
  const [modal, setModal] = useState(null)
  const run = useConfirmAction()

  const open = () => {
    const r = classifyTimeoutRequest(events, 1, 'home')
    setModal({ started: false, ordinal: r.ordinal, consecutive: r.consecutive })
  }
  const confirmFixed = () => run(async () => {
    const req = modal
    if (!req || req.started) return
    setModal({ ...req, started: true })
    await store.write({ type: 'timeout', payload: { team: 'home' } })
  })
  const confirmBefore = async () => {
    if (!modal || modal.started) return
    await store.write({ type: 'timeout', payload: { team: 'home' } })
    setModal({ ...modal, started: true })
  }

  const text = !modal || modal.started
    ? null
    : pattern === 'before'
      ? (liveUsed === 1 ? 'Confirm 2nd time-out request?' : 'Confirm time-out request?')
      : (modal.consecutive ? 'already took a time-out in this interruption' : modal.ordinal === 2 ? 'Second time-out of this set' : 'Time-out 1 of 2')

  // every committed frame's dialog text
  useLayoutEffect(() => { log.push(text) })

  return (
    <div>
      <button onClick={open}>TO</button>
      {text && (
        <div role="dialog">
          <p>{text}</p>
          <button onClick={pattern === 'before' ? confirmBefore : confirmFixed}>Confirm</button>
        </div>
      )}
    </div>
  )
}

async function confirmOnce(store, pattern) {
  const log = []
  render(<TimeoutDialog store={store} pattern={pattern} log={log} />)
  fireEvent.click(screen.getByText('TO'))
  log.length = 0
  await act(async () => {
    fireEvent.click(screen.getByText('Confirm'))
    await sleep(60)
  })
  return log
}

describe('useConfirmAction', () => {
  it('runs the action once while a run is in flight', async () => {
    const { result } = renderHook(() => useConfirmAction())
    const action = vi.fn(() => sleep(10))
    let first, second
    await act(async () => {
      first = result.current(action)
      second = result.current(action)
      await Promise.all([first, second])
    })
    expect(action).toHaveBeenCalledTimes(1)
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(false)
  })

  it('is free again after the action finishes or throws', async () => {
    const { result } = renderHook(() => useConfirmAction())
    await act(async () => {
      await expect(result.current(() => Promise.reject(new Error('db')))).rejects.toThrow('db')
    })
    const action = vi.fn()
    await act(async () => { await result.current(action) })
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('swallows the second tap of a double tap, which would land under the closed dialog', async () => {
    const under = vi.fn()
    function Screen() {
      const run = useConfirmAction()
      const [open, setOpen] = useState(true)
      return (
        <div>
          <button onClick={under}>court player</button>
          {open && <button onClick={() => run(async () => { setOpen(false); await sleep(5) })}>Yes</button>}
        </div>
      )
    }
    render(<Screen />)
    await act(async () => {
      fireEvent.click(screen.getByText('Yes'))
      // the dialog is gone; the trailing tap hits what was under it
      fireEvent.click(screen.getByText('court player'))
      await sleep(20)
    })
    expect(screen.queryByText('Yes')).toBeNull()
    expect(under).not.toHaveBeenCalled()
    await act(async () => { await sleep(GHOST_CLICK_MS + 50) })
    fireEvent.click(screen.getByText('court player'))
    expect(under).toHaveBeenCalledTimes(1)
  })

  it('reports a failed write through onError (the dialog is already closed)', async () => {
    const onError = vi.fn()
    const { result } = renderHook(() => useConfirmAction(onError))
    let ran
    await act(async () => { ran = await result.current(() => Promise.reject(new Error('db'))) })
    expect(ran).toBe(false)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0].message).toBe('db')
    const action = vi.fn()
    await act(async () => { await result.current(action) })
    expect(action).toHaveBeenCalledTimes(1)
  })
})

describe('time-out request dialog against a live store', () => {
  it('the harness reproduces the flash with the old pattern (control)', async () => {
    const log = await confirmOnce(liveStore(), 'before')
    expect(log).toContain('Confirm 2nd time-out request?')
  })

  it('confirming the 1st time-out never renders the 2nd-time-out text', async () => {
    const store = liveStore()
    const log = await confirmOnce(store, 'fixed')
    expect(log.filter(Boolean)).toEqual([])
    expect(log.some(t => t && /second|2nd/i.test(t))).toBe(false)
    expect(store.writes).toBe(1)
  })

  it('confirming a real 2nd time-out keeps its wording until it closes', async () => {
    const store = liveStore([{ type: 'timeout', payload: { team: 'home' }, setIndex: 1, seq: 1 }, { type: 'rally_start', setIndex: 1, seq: 2 }])
    const log = []
    render(<TimeoutDialog store={store} pattern="fixed" log={log} />)
    fireEvent.click(screen.getByText('TO'))
    expect(screen.getByRole('dialog').textContent).toContain('Second time-out of this set')
    log.length = 0
    await act(async () => {
      fireEvent.click(screen.getByText('Confirm'))
      await sleep(60)
    })
    expect(log.filter(Boolean)).toEqual([])
  })

  it('a double tap on confirm writes one time-out', async () => {
    const store = liveStore()
    render(<TimeoutDialog store={store} pattern="fixed" log={[]} />)
    fireEvent.click(screen.getByText('TO'))
    const confirm = screen.getByText('Confirm')
    await act(async () => {
      // both taps land before React re-renders (same closure, same snapshot)
      fireEvent.click(confirm)
      fireEvent.click(confirm)
      await sleep(60)
    })
    expect(store.writes).toBe(1)
    expect(store.get().filter(e => e.type === 'timeout')).toHaveLength(1)
  })

  it('without the guard the same double tap writes twice (control)', async () => {
    const store = liveStore()
    render(<TimeoutDialog store={store} pattern="before" log={[]} />)
    fireEvent.click(screen.getByText('TO'))
    const confirm = screen.getByText('Confirm')
    await act(async () => {
      fireEvent.click(confirm)
      fireEvent.click(confirm)
      await sleep(60)
    })
    expect(store.writes).toBe(2)
  })
})
