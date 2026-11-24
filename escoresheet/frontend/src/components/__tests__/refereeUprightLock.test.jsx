import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'

// The referee view locks the screen upright while it is open (RefereeApp):
// natively in the Android app, with screen.orientation.lock in a browser,
// where it only works installed or in fullscreen and must otherwise fail
// quietly. Leaving the view rotates freely again.

const so = vi.hoisted(() => ({
  lock: vi.fn(async () => {}),
  unlock: vi.fn(async () => {})
}))
vi.mock('@capacitor/screen-orientation', () => ({ ScreenOrientation: so }))

const { useUprightLock } = await import('../referee/upright.js')

function LockedView() {
  useUprightLock()
  return null
}

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 20)) })

describe('referee view: portrait lock', () => {
  let orientation
  beforeEach(() => {
    vi.clearAllMocks()
    orientation = { type: 'landscape-primary', lock: vi.fn(() => Promise.resolve()), unlock: vi.fn() }
    Object.defineProperty(window.screen, 'orientation', { value: orientation, configurable: true })
  })
  afterEach(() => {
    delete window.screen.orientation
    delete window.Capacitor
  })

  it('a browser: asks for portrait on open and unlocks when the view is left', async () => {
    const view = render(<LockedView />)
    await flush()
    expect(orientation.lock).toHaveBeenCalledWith('portrait')
    view.unmount()
    expect(orientation.unlock).toHaveBeenCalledTimes(1)
    expect(so.lock).not.toHaveBeenCalled()
  })

  it('a refused lock (no fullscreen, not installed) is harmless', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      orientation.lock.mockImplementation(() => Promise.reject(new DOMException('not supported', 'NotSupportedError')))
      const view = render(<LockedView />)
      await flush()
      expect(orientation.lock).toHaveBeenCalledWith('portrait')
      view.unmount()
      await flush()
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('a browser without orientation lock (iOS) or one that throws is harmless', async () => {
    delete orientation.lock
    delete orientation.unlock
    const a = render(<LockedView />)
    await flush()
    a.unmount()
    orientation.lock = vi.fn(() => { throw new Error('boom') })
    orientation.unlock = vi.fn(() => { throw new Error('boom') })
    const b = render(<LockedView />)
    await flush()
    expect(() => b.unmount()).not.toThrow()
  })

  it('tries again when the page goes fullscreen (the lock is granted there)', async () => {
    const view = render(<LockedView />)
    await flush()
    expect(orientation.lock).toHaveBeenCalledTimes(1)
    Object.defineProperty(document, 'fullscreenElement', { value: document.documentElement, configurable: true })
    try {
      document.dispatchEvent(new Event('fullscreenchange'))
      expect(orientation.lock).toHaveBeenCalledTimes(2)
    } finally {
      delete document.fullscreenElement
    }
    view.unmount()
    // left: fullscreen no longer locks
    document.dispatchEvent(new Event('fullscreenchange'))
    expect(orientation.lock).toHaveBeenCalledTimes(2)
  })

  it('the Android app locks natively, upright on the side it is on, and unlocks when left', async () => {
    window.Capacitor = { isNativePlatform: () => true }
    const view = render(<LockedView />)
    await flush()
    expect(so.lock).toHaveBeenCalledWith({ orientation: 'portrait' })
    // the WebView ignores screen.orientation.lock: not asked
    expect(orientation.lock).not.toHaveBeenCalled()
    view.unmount()
    await flush()
    expect(so.unlock).toHaveBeenCalledTimes(1)
  })

  it('the Android app: a failed native lock is harmless and the unlock still runs', async () => {
    window.Capacitor = { isNativePlatform: () => true }
    so.lock.mockRejectedValueOnce(new Error('not supported'))
    const view = render(<LockedView />)
    await flush()
    view.unmount()
    await flush()
    expect(so.unlock).toHaveBeenCalledTimes(1)
  })
})
