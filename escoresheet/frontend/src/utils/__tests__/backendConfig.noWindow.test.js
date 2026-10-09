// The backend checks run in no page at all: a live-state push that lands
// after a test's teardown (the jsdom window gone) called isBackendAvailable
// and threw "window is not defined" (a flaky unhandled error in the
// scoreboard suites under load). Without a window there is no backend.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { getBackendUrl, isBackendAvailable, getWebSocketUrl } from '../backendConfig'

afterEach(() => { vi.unstubAllGlobals() })

describe('backendConfig without a window', () => {
  it('no backend, no throw', () => {
    vi.stubGlobal('window', undefined)
    expect(typeof window).toBe('undefined')
    expect(() => isBackendAvailable()).not.toThrow()
    expect(isBackendAvailable()).toBe(false)
    expect(getBackendUrl()).toBeNull()
    expect(getWebSocketUrl()).toBeNull()
  })
})
