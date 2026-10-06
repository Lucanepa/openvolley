import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const calls = []
const so = {
  orientation: vi.fn(async () => ({ type: 'portrait-primary' })),
  lock: vi.fn(async ({ orientation }) => {
    await new Promise((r) => setTimeout(r, 5))
    calls.push(`lock:${orientation}`)
  }),
  unlock: vi.fn(async () => { calls.push('unlock') }),
}
// Like a real Capacitor plugin: a Proxy that answers every property with a
// native call, `then` included (one that never settles here).
const pluginProxy = new Proxy(so, {
  get: (target, prop) => (prop in target ? target[prop] : () => new Promise(() => {}))
})
vi.mock('@capacitor/screen-orientation', () => ({ ScreenOrientation: pluginProxy }))

const { lockLandscape, unlockOrientation } = await import('../nativeOrientation')

describe('nativeOrientation', () => {
  beforeEach(() => {
    calls.length = 0
    vi.clearAllMocks()
  })
  afterEach(() => {
    delete window.Capacitor
  })

  it('does nothing in a browser', async () => {
    await lockLandscape()
    await unlockOrientation()
    expect(so.lock).not.toHaveBeenCalled()
    expect(so.unlock).not.toHaveBeenCalled()
  })

  describe('in the native app', () => {
    beforeEach(() => {
      window.Capacitor = { isNativePlatform: () => true }
    })

    it('locks landscape on the side the tablet is on, then unlocks', async () => {
      const orientation = { type: 'portrait-primary' }
      Object.defineProperty(window.screen, 'orientation', { value: orientation, configurable: true })
      await lockLandscape()
      expect(so.lock).toHaveBeenCalledWith({ orientation: 'landscape' })
      orientation.type = 'landscape-secondary'
      await lockLandscape()
      expect(so.lock).toHaveBeenLastCalledWith({ orientation: 'landscape-secondary' })
      delete window.screen.orientation
      await unlockOrientation()
      expect(so.unlock).toHaveBeenCalledTimes(1)
      // The plugin's own orientation() is wrong on landscape-natural tablets
      expect(so.orientation).not.toHaveBeenCalled()
    })

    it('an unlock sent while the lock is in flight runs after it', async () => {
      lockLandscape()
      await unlockOrientation()
      expect(calls).toEqual(['lock:landscape', 'unlock'])
    })

    it('a failed lock does not block the unlock', async () => {
      so.lock.mockRejectedValueOnce(new Error('not supported'))
      await lockLandscape()
      await unlockOrientation()
      expect(so.unlock).toHaveBeenCalledTimes(1)
    })
  })
})
