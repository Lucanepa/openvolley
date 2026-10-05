import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildReloadUrl, stripCacheBustParam, applyServiceWorkerUpdate } from '../useServiceWorker'

describe('buildReloadUrl', () => {
  it('keeps match/team/server params and the hash, adds cache_bust', () => {
    const url = new URL(buildReloadUrl('https://host/referee/?match=42&team=home&server=10.0.0.2#x', 123))
    expect(url.pathname).toBe('/referee/')
    expect(url.searchParams.get('match')).toBe('42')
    expect(url.searchParams.get('team')).toBe('home')
    expect(url.searchParams.get('server')).toBe('10.0.0.2')
    expect(url.searchParams.get('cache_bust')).toBe('123')
    expect(url.hash).toBe('#x')
  })

  it('replaces an existing cache_bust instead of piling them up', () => {
    const url = new URL(buildReloadUrl('https://host/?cache_bust=1&match=7', 2))
    expect(url.searchParams.getAll('cache_bust')).toEqual(['2'])
    expect(url.searchParams.get('match')).toBe('7')
  })
})

describe('stripCacheBustParam', () => {
  afterEach(() => window.history.replaceState(null, '', '/'))

  it('removes only cache_bust and keeps the rest of the query', () => {
    window.history.replaceState(null, '', '/bench/?match=9&cache_bust=55&team=away')
    stripCacheBustParam()
    expect(window.location.pathname).toBe('/bench/')
    const params = new URLSearchParams(window.location.search)
    expect(params.has('cache_bust')).toBe(false)
    expect(params.get('match')).toBe('9')
    expect(params.get('team')).toBe('away')
  })

  it('leaves the URL alone when there is no cache_bust', () => {
    window.history.replaceState(null, '', '/referee?match=1')
    stripCacheBustParam()
    expect(window.location.pathname + window.location.search).toBe('/referee?match=1')
  })
})

describe('applyServiceWorkerUpdate', () => {
  const originalLocation = window.location
  const originalSW = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker')

  afterEach(() => {
    Object.defineProperty(window, 'location', { value: originalLocation, configurable: true, writable: true })
    if (originalSW) Object.defineProperty(navigator, 'serviceWorker', originalSW)
    else delete navigator.serviceWorker
    vi.restoreAllMocks()
  })

  function mockLocation(href) {
    const replace = vi.fn()
    Object.defineProperty(window, 'location', { value: { href, replace }, configurable: true, writable: true })
    return replace
  }

  it('posts SKIP_WAITING, never wipes caches or unregisters, and reloads with the query kept', async () => {
    const replace = mockLocation('https://host/referee/?match=42&team=home')
    let onControllerChange
    const waiting = { postMessage: vi.fn(() => onControllerChange()) }
    const unregister = vi.fn()
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        getRegistration: vi.fn().mockResolvedValue({ waiting, unregister }),
        getRegistrations: vi.fn(),
        addEventListener: vi.fn((type, cb) => { if (type === 'controllerchange') onControllerChange = cb })
      }
    })
    const cachesDelete = vi.fn()
    globalThis.caches = { keys: vi.fn().mockResolvedValue(['workbox-precache']), delete: cachesDelete }

    await applyServiceWorkerUpdate()

    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    expect(unregister).not.toHaveBeenCalled()
    expect(navigator.serviceWorker.getRegistrations).not.toHaveBeenCalled()
    expect(cachesDelete).not.toHaveBeenCalled()
    expect(replace).toHaveBeenCalledTimes(1)
    const url = new URL(replace.mock.calls[0][0])
    expect(url.searchParams.get('match')).toBe('42')
    expect(url.searchParams.get('team')).toBe('home')
    expect(url.searchParams.has('cache_bust')).toBe(true)
    delete globalThis.caches
  })

  it('still reloads (query kept) when no worker is waiting', async () => {
    const replace = mockLocation('https://host/bench/?match=3')
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: vi.fn().mockResolvedValue(undefined), addEventListener: vi.fn() }
    })
    await applyServiceWorkerUpdate()
    expect(new URL(replace.mock.calls[0][0]).searchParams.get('match')).toBe('3')
  })
})
