import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildReloadUrl, stripCacheBustParam, applyServiceWorkerUpdate, clearCachesAndReload, resetServiceWorkerUpdateForTests } from '../useServiceWorker'

// Shared stubs for the browser APIs the update / clear-cache paths touch
const originalLocation = window.location
const originalSW = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker')
function restoreBrowserStubs() {
  Object.defineProperty(window, 'location', { value: originalLocation, configurable: true, writable: true })
  if (originalSW) Object.defineProperty(navigator, 'serviceWorker', originalSW)
  else delete navigator.serviceWorker
  delete globalThis.caches
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
}
function stubLocation(href) {
  const replace = vi.fn()
  Object.defineProperty(window, 'location', { value: { href, replace }, configurable: true, writable: true })
  return replace
}
function stubServiceWorker(value) {
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value })
}

// every test is a fresh page (applyServiceWorkerUpdate remembers its reload)
afterEach(() => resetServiceWorkerUpdateForTests())

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

  // The desktop app at start: the home screen's banner and applyUpdateAtStart
  // both applied the same waiting build 2 ms apart (two page.reload_request
  // lines, two SKIP_WAITING). A second call joins the one under way, and one
  // just after the reload was asked for does nothing.
  it('a second call while one is under way joins it: one SKIP_WAITING, one reload', async () => {
    const replace = mockLocation('https://host/')
    let onControllerChange = null
    const waiting = { postMessage: vi.fn(() => setTimeout(() => onControllerChange?.(), 5)) }
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        getRegistration: vi.fn().mockResolvedValue({ waiting }),
        addEventListener: vi.fn((type, cb) => { if (type === 'controllerchange') onControllerChange = cb })
      }
    })
    const first = applyServiceWorkerUpdate()
    const second = applyServiceWorkerUpdate()
    await Promise.all([first, second])
    expect(waiting.postMessage).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledTimes(1)
    // just after: the page is reloading, nothing more to do
    await applyServiceWorkerUpdate()
    expect(replace).toHaveBeenCalledTimes(1)
    // a reload that never came: after a while an update applies again
    const later = Date.now() + 11000
    vi.spyOn(Date, 'now').mockReturnValue(later)
    await applyServiceWorkerUpdate()
    expect(replace).toHaveBeenCalledTimes(2)
  })

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

describe('applyServiceWorkerUpdate({ checkForUpdate }) - Options > Update', () => {
  afterEach(restoreBrowserStubs)

  it('fetches the new worker, waits for it to install, then activates it (a plain reload would keep the old one)', async () => {
    const replace = stubLocation('https://host/?x=1')
    let onControllerChange
    const listeners = {}
    const installing = {
      state: 'installing',
      addEventListener: vi.fn((type, cb) => { listeners[type] = cb }),
      removeEventListener: vi.fn(),
      postMessage: vi.fn(() => onControllerChange())
    }
    const reg = { waiting: null, installing: null }
    reg.update = vi.fn(async () => {
      reg.installing = installing
      // finishes installing a moment later
      setTimeout(() => { installing.state = 'installed'; listeners.statechange() }, 10)
    })
    stubServiceWorker({
      getRegistration: vi.fn().mockResolvedValue(reg),
      addEventListener: vi.fn((type, cb) => { if (type === 'controllerchange') onControllerChange = cb })
    })

    await applyServiceWorkerUpdate({ checkForUpdate: true })

    expect(reg.update).toHaveBeenCalledTimes(1)
    expect(installing.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    expect(replace).toHaveBeenCalledTimes(1)
    expect(new URL(replace.mock.calls[0][0]).searchParams.get('x')).toBe('1')
  })

  it('does not post SKIP_WAITING to a worker that never finishes installing', async () => {
    const replace = stubLocation('https://host/')
    const installing = { state: 'installing', addEventListener: vi.fn(), removeEventListener: vi.fn(), postMessage: vi.fn() }
    stubServiceWorker({
      getRegistration: vi.fn().mockResolvedValue({ waiting: null, installing, update: vi.fn() }),
      addEventListener: vi.fn()
    })
    await applyServiceWorkerUpdate({ checkForUpdate: true, timeoutMs: 20 })
    expect(installing.postMessage).not.toHaveBeenCalled()
    expect(replace).toHaveBeenCalledTimes(1)
  })
})

describe('clearCachesAndReload', () => {
  afterEach(restoreBrowserStubs)

  function stubCachesAndSW() {
    const cachesDelete = vi.fn().mockResolvedValue(true)
    globalThis.caches = { keys: vi.fn().mockResolvedValue(['workbox-precache-v2-x', 'api-cache']), delete: cachesDelete }
    const unregister = vi.fn().mockResolvedValue(true)
    stubServiceWorker({ getRegistrations: vi.fn().mockResolvedValue([{ unregister }]) })
    return { cachesDelete, unregister }
  }

  it('wipes caches, unregisters and reloads with ?match=&team= kept when the server answers', async () => {
    const replace = stubLocation('https://host/referee/?match=42&team=home')
    const { cachesDelete, unregister } = stubCachesAndSW()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    expect(await clearCachesAndReload()).toBe(true)

    expect(cachesDelete).toHaveBeenCalledTimes(2)
    expect(unregister).toHaveBeenCalledTimes(1)
    const url = new URL(replace.mock.calls[0][0])
    expect(url.pathname).toBe('/referee/')
    expect(url.searchParams.get('match')).toBe('42')
    expect(url.searchParams.get('team')).toBe('home')
    expect(url.searchParams.has('cache_bust')).toBe(true)
  })

  it('touches nothing when the server is unreachable (the reload could not load the app offline)', async () => {
    const replace = stubLocation('https://host/referee/?match=42')
    const { cachesDelete, unregister } = stubCachesAndSW()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    localStorage.setItem('keep', '1')

    expect(await clearCachesAndReload({ includeLocalStorage: true })).toBe(false)

    expect(cachesDelete).not.toHaveBeenCalled()
    expect(unregister).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
    expect(localStorage.getItem('keep')).toBe('1')
    localStorage.removeItem('keep')
  })

  // Every clear-cache / update entry point must go through the shared helpers;
  // the old `pathname + '?cache_bust='` reload dropped ?match=&team= and
  // detached referee/bench tablets from the live match.
  it.each([
    'components/DashboardHeader.jsx',
    'components/SimpleHeader.jsx',
    'components/options/HomeOptionsModal.jsx',
    'components/options/ScoreboardOptionsModal.jsx'
  ])('%s keeps the query on reload', (file) => {
    const src = readFileSync(resolve(__dirname, '../..', file), 'utf8')
    expect(src).not.toMatch(/location\.pathname \+ '\?cache_bust='/)
    expect(src).toMatch(/clearCachesAndReload\(/)
  })
})
