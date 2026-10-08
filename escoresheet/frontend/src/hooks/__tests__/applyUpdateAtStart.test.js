import { describe, it, expect, vi } from 'vitest'
import { applyUpdateAtStart } from '../useServiceWorker'

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
})
