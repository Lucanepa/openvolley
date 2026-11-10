import { describe, it, expect, afterEach, vi } from 'vitest'
import { canOfferDashboards, scorerDashboardUrl, openScorerDashboard } from '../scorerDashboards'
import { captureScorerReturn, scorerReturnUrl, returnToScorer, scorerHomeFor, withFromScorer } from '../scorerReturn'
import { setAppEntry } from '../appEntry'

// The scorer's Home menu opens the referee or bench dashboard on a phone or
// tablet (owner 2026-11-10), and the dashboard opened that way goes back

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
const LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

function fakeWin({ coarse = false, screen = { width: 1920, height: 1080 }, location = { hostname: 'localhost', search: '' }, extra = {} } = {}) {
  return {
    matchMedia: (q) => ({ matches: q === '(pointer: coarse)' ? coarse : false }),
    screen,
    innerWidth: screen.width,
    innerHeight: screen.height,
    location: { assign: vi.fn(), ...location },
    ...extra
  }
}

function memoryStorage() {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k)
  }
}

afterEach(() => {
  delete window.Capacitor
  setAppEntry(null)
})

describe('canOfferDashboards', () => {
  it('the Android/iOS app always', () => {
    window.Capacitor = { isNativePlatform: () => true }
    expect(canOfferDashboards({ win: fakeWin(), nav: { userAgent: LINUX } })).toBe(true)
  })

  it('a phone or tablet browser, an iPad reading as a Mac, a small touch screen', () => {
    expect(canOfferDashboards({ win: fakeWin(), nav: { userAgent: ANDROID } })).toBe(true)
    expect(canOfferDashboards({ win: fakeWin(), nav: { userAgent: IPAD, maxTouchPoints: 5 } })).toBe(true)
    expect(canOfferDashboards({ win: fakeWin({ coarse: true, screen: { width: 800, height: 1280 } }), nav: { userAgent: LINUX } })).toBe(true)
  })

  it('not a computer, not the desktop app', () => {
    expect(canOfferDashboards({ win: fakeWin(), nav: { userAgent: LINUX } })).toBe(false)
    expect(canOfferDashboards({ win: fakeWin(), nav: { userAgent: IPAD, maxTouchPoints: 0 } })).toBe(false)
    // a touch laptop with a big screen
    expect(canOfferDashboards({ win: fakeWin({ coarse: true }), nav: { userAgent: LINUX } })).toBe(false)
    expect(canOfferDashboards({ win: fakeWin({ extra: { __TAURI_INTERNALS__: {} } }), nav: { userAgent: ANDROID } })).toBe(false)
  })
})

describe('scorerDashboardUrl', () => {
  it('the app: the bundled page itself (offline), with the way back', () => {
    window.Capacitor = { isNativePlatform: () => true }
    const win = fakeWin({ location: { hostname: 'localhost', search: '' } })
    expect(scorerDashboardUrl('referee', { win })).toBe('/referee/index.html?from=scorer')
    expect(scorerDashboardUrl('bench', { win })).toBe('/bench/index.html?from=scorer')
  })

  it('a relay or the dev server: its own pages', () => {
    const win = fakeWin({ location: { hostname: '192.168.1.20', search: '' } })
    expect(scorerDashboardUrl('referee', { win })).toBe('/referee/index.html?from=scorer')
    expect(scorerDashboardUrl('bench', { win })).toBe('/bench/index.html?from=scorer')
    expect(scorerDashboardUrl('nope', { win })).toBeNull()
  })

  it('app.openvolley.app: the role sites, no team preselected', () => {
    const win = fakeWin({ location: { hostname: 'app.openvolley.app', search: '' } })
    const ref = new URL(scorerDashboardUrl('referee', { win }))
    expect(ref.origin).toBe('https://referee.openvolley.app')
    expect(ref.searchParams.get('from')).toBe('scorer')
    const bench = new URL(scorerDashboardUrl('bench', { win }))
    expect(bench.origin).toBe('https://bench.openvolley.app')
    expect(bench.searchParams.get('team')).toBeNull()
    // dev stays on dev
    const dev = new URL(scorerDashboardUrl('bench', { win: fakeWin({ location: { hostname: 'dev-app.openvolley.app', search: '' } }) }))
    expect(dev.origin).toBe('https://dev-bench.openvolley.app')
  })

  it('opens it with the location (one assign)', () => {
    const win = fakeWin({ location: { hostname: '192.168.1.20', search: '' } })
    expect(openScorerDashboard('bench', { win })).toBe(true)
    expect(win.location.assign).toHaveBeenCalledWith('/bench/index.html?from=scorer')
  })
})

describe('the way back', () => {
  it('scorerHomeFor: the scorer site for a role site, else the same server', () => {
    expect(scorerHomeFor('referee.openvolley.app')).toBe('https://app.openvolley.app/')
    expect(scorerHomeFor('dev-bench.openvolley.app')).toBe('https://dev-app.openvolley.app/')
    expect(scorerHomeFor('dev.openvolley-referee.pages.dev')).toBe('https://dev.openvolley-app.pages.dev/')
    expect(scorerHomeFor('localhost')).toBe('/')
    expect(scorerHomeFor('192.168.1.20')).toBe('/')
  })

  it('withFromScorer keeps the query and the hash', () => {
    expect(withFromScorer('/a?x=1#h')).toBe('/a?x=1&from=scorer#h')
  })

  it('kept for the tab when the link says from=scorer, and leaves to the scorer once', () => {
    setAppEntry('referee')
    const storage = memoryStorage()
    captureScorerReturn({ win: fakeWin({ location: { hostname: 'referee.openvolley.app', search: '?server=x' } }), storage })
    expect(scorerReturnUrl({ storage })).toBeNull()
    captureScorerReturn({ win: fakeWin({ location: { hostname: 'referee.openvolley.app', search: '?from=scorer' } }), storage })
    expect(scorerReturnUrl({ storage })).toBe('https://app.openvolley.app/')
    const win = fakeWin()
    expect(returnToScorer({ win, storage })).toBe(true)
    expect(win.location.assign).toHaveBeenCalledWith('https://app.openvolley.app/')
    expect(scorerReturnUrl({ storage })).toBeNull()
    expect(returnToScorer({ win, storage })).toBe(false)
  })

  it('never on the scorer page, never to a foreign address', () => {
    const storage = memoryStorage()
    storage.setItem('ov.scorerReturn', '/')
    setAppEntry('scorer')
    expect(scorerReturnUrl({ storage })).toBeNull()
    setAppEntry('bench')
    expect(scorerReturnUrl({ storage })).toBe('/')
    storage.setItem('ov.scorerReturn', 'https://evil.example/')
    expect(scorerReturnUrl({ storage })).toBeNull()
    storage.setItem('ov.scorerReturn', 'javascript:alert(1)')
    expect(scorerReturnUrl({ storage })).toBeNull()
  })
})
