import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'

const calls = []
const bars = {
  hide: vi.fn(async () => {
    await new Promise((r) => setTimeout(r, 5))
    calls.push('hide')
  }),
  show: vi.fn(async () => { calls.push('show') }),
}
// Like a real Capacitor plugin: a Proxy that answers every property with a
// native call, `then` included (one that never settles here).
const pluginProxy = new Proxy(bars, {
  get: (target, prop) => (prop in target ? target[prop] : () => new Promise(() => {}))
})
const registerPlugin = vi.fn(() => pluginProxy)

const { hideSystemBars, showSystemBars, useSystemBarsHidden } = await import('../nativeSystemBars')

describe('nativeSystemBars', () => {
  beforeEach(() => {
    calls.length = 0
    vi.clearAllMocks()
  })
  afterEach(() => {
    delete window.Capacitor
  })

  it('does nothing in a browser', async () => {
    await hideSystemBars()
    await showSystemBars()
    expect(bars.hide).not.toHaveBeenCalled()
    expect(bars.show).not.toHaveBeenCalled()
  })

  describe('in the native app', () => {
    beforeEach(() => {
      window.Capacitor = { isNativePlatform: () => true, registerPlugin }
    })

    it('hides and shows the bars through the app plugin', async () => {
      await hideSystemBars()
      await showSystemBars()
      expect(calls).toEqual(['hide', 'show'])
      // registered once, by its native name
      await hideSystemBars()
      expect(registerPlugin.mock.calls.flat()).toEqual(['OpenVolleyBars'])
    })

    it('a show sent while the hide is in flight runs after it', async () => {
      hideSystemBars()
      await showSystemBars()
      expect(calls).toEqual(['hide', 'show'])
    })

    it('the hook hides the bars while active and says when they are gone', async () => {
      vi.useFakeTimers()
      try {
        const { result, rerender } = renderHook(({ on }) => useSystemBarsHidden(on), { initialProps: { on: false } })
        expect(result.current).toBe(false)
        rerender({ on: true })
        // the size gate waits from the first paint on
        expect(result.current).toBe(true)
        await act(async () => { await vi.advanceTimersByTimeAsync(10) })
        expect(calls).toEqual(['hide'])
        expect(result.current).toBe(true)
        await act(async () => { await vi.advanceTimersByTimeAsync(300) })
        expect(result.current).toBe(false)
        rerender({ on: false })
        await act(async () => { await vi.advanceTimersByTimeAsync(10) })
        expect(calls).toEqual(['hide', 'show'])
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('the hook never holds the gate in a browser', () => {
    const { result } = renderHook(() => useSystemBarsHidden(true))
    expect(result.current).toBe(false)
    expect(bars.hide).not.toHaveBeenCalled()
  })
})
