import { describe, it, expect, vi, beforeEach } from 'vitest'
import { applyUpdateAtStart, autoApplyAllowed, noteAutoApply, AUTO_UPDATE_KEY, AUTO_UPDATE_WINDOW_MS } from '../useServiceWorker'

// The desktop app at start: the page that just loaded is the previous build
// (served by the service worker) and the new one installs next to it. The app
// had opened straight into a restored match, where no update banner is shown,
// so the new build stayed waiting for the whole match.

function fakeWindow() {
  const listeners = {}
  return {
    listeners,
    addEventListener: vi.fn((t, fn) => { listeners[t] = fn }),
    removeEventListener: vi.fn((t) => { delete listeners[t] })
  }
}

function fakeServiceWorker({ waiting = null } = {}) {
  const installing = { state: 'installing', handlers: [], addEventListener(t, fn) { this.handlers.push(fn) } }
  const reg = { waiting, installing: null, handlers: [], addEventListener(t, fn) { this.handlers.push(fn) } }
  const sw = { controller: {}, getRegistration: vi.fn(async () => reg) }
  const install = async () => {
    reg.installing = installing
    reg.handlers.forEach((fn) => fn())
    installing.state = 'installed'
    installing.handlers.forEach((fn) => fn())
    await Promise.resolve()
  }
  return { sw, install }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => sessionStorage.clear())

describe('applyUpdateAtStart', () => {
  it('applies the new build once it has installed, on whatever screen opened', async () => {
    const win = fakeWindow()
    const { sw, install } = fakeServiceWorker()
    const apply = vi.fn()
    applyUpdateAtStart({ win, sw, apply })
    await flush()
    await install()
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('a build already waiting is applied at once', async () => {
    const apply = vi.fn()
    applyUpdateAtStart({ win: fakeWindow(), sw: fakeServiceWorker({ waiting: {} }).sw, apply })
    await flush()
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('never after the scorer has touched the app (the home screen applies it then)', async () => {
    const win = fakeWindow()
    const { sw, install } = fakeServiceWorker()
    const apply = vi.fn()
    applyUpdateAtStart({ win, sw, apply })
    await flush()
    win.listeners.pointerdown()
    await install()
    expect(apply).not.toHaveBeenCalled()
  })

  it('never after the grace time', async () => {
    vi.useFakeTimers()
    try {
      const win = fakeWindow()
      const { sw, install } = fakeServiceWorker()
      const apply = vi.fn()
      applyUpdateAtStart({ win, sw, apply, graceMs: 1000 })
      await vi.advanceTimersByTimeAsync(1500)
      await install()
      expect(apply).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a first install (no controller) is no update', async () => {
    const { sw, install } = fakeServiceWorker()
    sw.controller = null
    const apply = vi.fn()
    applyUpdateAtStart({ win: fakeWindow(), sw, apply })
    await flush()
    await install()
    expect(apply).not.toHaveBeenCalled()
  })

  it('not again right after its own try: the reloaded page leaves it to the banner (no reload loop)', async () => {
    const first = vi.fn()
    applyUpdateAtStart({ win: fakeWindow(), sw: fakeServiceWorker({ waiting: {} }).sw, apply: first })
    await flush()
    expect(first).toHaveBeenCalledTimes(1)
    expect(Number(sessionStorage.getItem(AUTO_UPDATE_KEY))).toBeGreaterThan(0)

    // applyServiceWorkerUpdate reloaded after its timeout, the new worker
    // still waiting: the page starts again
    const again = vi.fn()
    applyUpdateAtStart({ win: fakeWindow(), sw: fakeServiceWorker({ waiting: {} }).sw, apply: again })
    await flush()
    expect(again).not.toHaveBeenCalled()
  })

  it('no tap reaches the page between the apply and its reload', async () => {
    const win = { ...fakeWindow(), document: { body: { inert: false } } }
    let inertAtApply = null
    const apply = vi.fn(() => { inertAtApply = win.document.body.inert })
    applyUpdateAtStart({ win, sw: fakeServiceWorker({ waiting: {} }).sw, apply })
    await flush()
    expect(apply).toHaveBeenCalledTimes(1)
    expect(inertAtApply).toBe(true)
  })

  it('a page that does not apply leaves the page usable', async () => {
    const win = { ...fakeWindow(), document: { body: { inert: false } } }
    const { sw, install } = fakeServiceWorker()
    applyUpdateAtStart({ win, sw, apply: vi.fn() })
    await flush()
    win.listeners.pointerdown()
    await install()
    expect(win.document.body.inert).toBe(false)
  })
})

describe('autoApplyAllowed', () => {
  const store = (value) => {
    const data = new Map(value == null ? [] : [[AUTO_UPDATE_KEY, String(value)]])
    return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) }
  }

  it('allowed with no earlier try, not within the window, allowed again after it', () => {
    const now = 1_000_000_000
    expect(autoApplyAllowed({ storage: store(null), now })).toBe(true)
    expect(autoApplyAllowed({ storage: store(now - 1000), now })).toBe(false)
    expect(autoApplyAllowed({ storage: store(now - AUTO_UPDATE_WINDOW_MS + 1), now })).toBe(false)
    expect(autoApplyAllowed({ storage: store(now - AUTO_UPDATE_WINDOW_MS), now })).toBe(true)
  })

  it('noteAutoApply records the try', () => {
    const storage = store(null)
    noteAutoApply({ storage, now: 42 })
    expect(storage.getItem(AUTO_UPDATE_KEY)).toBe('42')
    expect(autoApplyAllowed({ storage, now: 43 })).toBe(false)
  })

  it('without sessionStorage: never on its own', () => {
    expect(autoApplyAllowed({ storage: null })).toBe(false)
    const throwing = { getItem: () => { throw new Error('denied') } }
    expect(autoApplyAllowed({ storage: throwing })).toBe(false)
  })
})
