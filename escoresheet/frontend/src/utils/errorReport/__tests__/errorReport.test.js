/**
 * The error reporter (utils/errorReport): context, noise rules, steps before an
 * error without any text, the send queue and its switch, and the contract with
 * the backend: what the app builds passes lib/errorTracker.js checkClientEvent.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { parseUserAgent, runsAs, staticContext } from '../context'
import { classifyError } from '../classify'
import { describeTarget, maskPath, installBreadcrumbs, recordCrumb, getCrumbs, resetCrumbs, resetBreadcrumbsInstall } from '../breadcrumbs'
import { createTransport, errorReportsEnabled, setErrorReportsEnabled, QUEUE_KEY, OFF_KEY } from '../transport'
import { installErrorReporter, reportError, setErrorView, setErrorTool, resetErrorReporter, framesOf } from '../index'
import { guessTool } from '../boot'
import { emitActivity } from '../../activity/bus'
import { checkClientEvent } from '../../../../../backend/lib/errorTracker.js'

const UA = {
  androidTablet: 'Mozilla/5.0 (Linux; Android 15; SM-X910 Build/AP3A.240905.015; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.39 Safari/537.36',
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  tauriWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0',
  webkitgtk: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)',
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
}

describe('context', () => {
  it('reads OS, browser and model from the user agent', () => {
    expect(parseUserAgent(UA.androidTablet)).toEqual({ os_name: 'Android', os_version: '15', browser: 'Chrome WebView', browser_version: '131.0.6778.39', device_model: 'SM-X910' })
    expect(parseUserAgent(UA.ipad, null, 5)).toMatchObject({ os_name: 'iPadOS', os_version: '18.6', browser: 'Safari', device_model: 'iPad' })
    expect(parseUserAgent(UA.iphone)).toMatchObject({ os_name: 'iOS', os_version: '18.6', device_model: 'iPhone' })
    expect(parseUserAgent(UA.tauriWindows)).toMatchObject({ os_name: 'Windows', os_version: '10/11', browser: 'Edge', browser_version: '142.0.0.0' })
    expect(parseUserAgent(UA.webkitgtk)).toMatchObject({ os_name: 'Linux', browser: 'WebKitGTK' })
    expect(parseUserAgent(UA.chromeMac, null, 0)).toMatchObject({ os_name: 'macOS', browser: 'Chrome' })
  })

  it('says how the app runs', () => {
    expect(runsAs('tauri-linux')).toBe('desktop')
    expect(runsAs('android')).toBe('android_app')
    expect(runsAs('web', { matchMedia: () => ({ matches: true }) })).toBe('pwa')
    expect(runsAs('web', { matchMedia: () => ({ matches: false }) })).toBe('tab')
  })

  it('guesses the tool from the address', () => {
    expect(guessTool({ hostname: 'referee.openvolley.app', pathname: '/' })).toBe('referee')
    expect(guessTool({ hostname: 'manager-beach.openvolley.app', pathname: '/' })).toBe('manager')
    expect(guessTool({ hostname: 'localhost', pathname: '/livescore/' })).toBe('livescore')
    expect(guessTool({ hostname: 'app.openvolley.app', pathname: '/' })).toBe('scorer')
  })
})

describe('noise rules', () => {
  it('drops the browser\'s noise and injected scripts, demotes the network and stale bundles', () => {
    expect(classifyError({ message: 'ResizeObserver loop completed with undelivered notifications.', kind: 'js.error' }).action).toBe('drop')
    expect(classifyError({ message: 'x is undefined', source: 'chrome-extension://abc/inject.js', kind: 'js.error' }).action).toBe('drop')
    expect(classifyError({ message: 'Script error.', kind: 'js.error' })).toMatchObject({ action: 'report', level: 'warn' })
    expect(classifyError({ message: 'Failed to fetch', kind: 'js.unhandledrejection' })).toEqual({ action: 'report', level: 'warn', kind: 'net.fail' })
    // Google's page renderer (its crawler) rejects serviceWorker.register: no person sees it (21.11.2026)
    expect(classifyError({ message: 'Rejected', stack: 'Error: Rejected\n    at wrsParams.serviceWorkers.navigator.serviceWorker.register (<anonymous>:13:648)\n    at /registerSW.js:1:98', kind: 'js.unhandledrejection' }).action).toBe('drop')
    expect(classifyError({ message: 'Rejected', stack: 'Error: Rejected\n    at /registerSW.js:1:98', kind: 'js.unhandledrejection' })).toMatchObject({ action: 'report', level: 'error' })
    expect(classifyError({ message: 'Failed to fetch dynamically imported module: /assets/x.js', kind: 'js.unhandledrejection' })).toEqual({ action: 'report', level: 'warn', kind: 'chunk.stale' })
    expect(classifyError({ message: 'The user aborted a request.', kind: 'js.unhandledrejection' }).action).toBe('drop')
    expect(classifyError({ message: 'boom', kind: 'js.error', unloading: true }).action).toBe('drop')
    expect(classifyError({ message: 'boom', kind: 'js.error', automated: true }).level).toBe('warn')
    expect(classifyError({ message: "Cannot read properties of undefined (reading 'team1')", kind: 'js.error' })).toEqual({ action: 'report', level: 'error', kind: 'js.error' })
  })
})

describe('steps before an error', () => {
  beforeEach(() => resetCrumbs())

  it('names a button by its test id or role, never by its text', () => {
    document.body.innerHTML = '<button data-testid="header-connect-tablets"><span>Anna Muster</span></button><div role="tab" id="settings">Settings</div><a href="/x">Leo Beispiel</a>'
    expect(describeTarget(document.querySelector('span'))).toBe('button[header-connect-tablets]')
    expect(describeTarget(document.querySelector('[role=tab]'))).toBe('tab#settings')
    expect(describeTarget(document.querySelector('a'))).toBe('a')
    expect(maskPath('/api/match/9f8e7d6c-1234-4abc-8def-0123456789ab/events?pin=1234')).toBe('/api/match/:id/events')
  })

  it('observes requests without changing them, and keeps the request id', async () => {
    resetBreadcrumbsInstall()
    const res = { status: 500, headers: { get: (k) => (k === 'x-request-id' ? 'abcdef123456' : null) } }
    const win = { location: { href: 'https://app.openvolley.app/', origin: 'https://app.openvolley.app', pathname: '/' }, addEventListener() {}, fetch: vi.fn(async () => res) }
    installBreadcrumbs({ win, ownOrigins: ['https://backend.openvolley.app'] })
    expect(await win.fetch('https://backend.openvolley.app/api/db?x=1', { method: 'post' })).toBe(res)
    await win.fetch('https://backend.openvolley.app/api/errors', { method: 'POST' })
    const crumbs = getCrumbs()
    expect(crumbs).toHaveLength(1)
    expect(crumbs[0]).toMatchObject({ c: 'fetch', d: { requestId: 'abcdef123456' } })
    expect(crumbs[0].m).toMatch(/^POST \/api\/db 500 \d+ ms$/)
  })

  it('keeps the last 20', () => {
    for (let i = 0; i < 30; i++) recordCrumb('nav', `screen ${i}`)
    expect(getCrumbs()).toHaveLength(20)
    expect(getCrumbs()[19].m).toBe('screen 29')
  })
})

/** A localStorage double. */
function memoryStore() {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}

describe('the send queue', () => {
  it('sends a batch with the session token, and forgets what the server took or refused', async () => {
    const store = memoryStore()
    const calls = []
    const t = createTransport({ store, url: () => 'https://backend.example/api/errors', authHeader: () => ({ Authorization: 'Bearer tok' }), setTimer: () => 0, fetchImpl: async (u, init) => { calls.push({ u, init }); return { ok: true, status: 200 } } })
    t.enqueue({ uid: 'a', level: 'error' })
    t.enqueue({ uid: 'a', level: 'error' })
    t.enqueue({ uid: 'b', level: 'warn' })
    expect(t.queue()).toHaveLength(2)
    expect(await t.flush()).toEqual({ sent: 2 })
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok')
    expect(JSON.parse(calls[0].init.body).events.map((e) => e.uid)).toEqual(['a', 'b'])
    expect(t.queue()).toHaveLength(0)
  })

  it('keeps reports for later when the server is down, and sends the rest by beacon on exit', async () => {
    const store = memoryStore()
    const beacons = []
    const t = createTransport({ store, url: () => 'https://backend.example/api/errors', setTimer: () => 0, fetchImpl: async () => ({ ok: false, status: 503 }), beacon: (u, b) => { beacons.push({ u, b }); return true } })
    t.enqueue({ uid: 'a', level: 'error' })
    await t.flush()
    expect(t.queue()).toHaveLength(1)
    t.flushOnExit()
    expect(beacons[0].b.type).toMatch(/^text\/plain;charset=utf-8$/i)
    // kept until a fetch confirms it: a beacon's answer is never read (audit SEC-19 review ET-5)
    expect(t.queue()).toHaveLength(1)
  })

  it('switched off: nothing is queued, and what was queued goes', () => {
    const store = memoryStore()
    const t = createTransport({ store, url: () => 'x', setTimer: () => 0, fetchImpl: async () => ({ ok: true, status: 200 }) })
    t.enqueue({ uid: 'a', level: 'warn' })
    setErrorReportsEnabled(false, store)
    expect(store.getItem(OFF_KEY)).toBe('1')
    expect(store.getItem(QUEUE_KEY)).toBe(null)
    expect(errorReportsEnabled(store)).toBe(false)
    expect(t.enqueue({ uid: 'b', level: 'error' })).toBe(false)
    setErrorReportsEnabled(true, store)
    expect(errorReportsEnabled(store)).toBe(true)
  })
})

describe('the reporter', () => {
  beforeEach(() => {
    resetErrorReporter()
    resetCrumbs()
    localStorage.clear()
  })

  it('builds a report the backend accepts, without the account in the body', () => {
    installErrorReporter({ tool: 'referee', win: window })
    setErrorTool('referee', 'openvolley')
    setErrorView('/referee')
    const err = new TypeError("Cannot read properties of undefined (reading 'team1')")
    err.stack = "TypeError: Cannot read properties of undefined (reading 'team1')\n    at onPoint (https://referee.openvolley.app/assets/referee-Zz11Yy22.js?v=3:4:512)\n    at dispatch (https://referee.openvolley.app/assets/vendor-Qq9w8e7r.js:2:100)"
    const ev = reportError(err)
    expect(ev).toBeTruthy()
    expect(ev).toMatchObject({ kind: 'app.error', level: 'error', tool: 'referee', product: 'openvolley', view: '/referee', error_name: 'TypeError' })
    expect(ev.frames).toEqual(['onPoint (/assets/referee-Zz11Yy22.js:4:512)', 'dispatch (/assets/vendor-Qq9w8e7r.js:2:100)'])
    expect('account_id' in ev).toBe(false)
    const checked = checkClientEvent(ev, { accountId: null })
    expect(checked.code).toBeUndefined()
    expect(checked.row.tool).toBe('referee')
    expect(JSON.parse(localStorage.getItem(QUEUE_KEY))).toHaveLength(1)
  })

  it('the same message at most 5 times; nothing when switched off', () => {
    installErrorReporter({ tool: 'scorer', win: window })
    for (let i = 0; i < 8; i++) reportError(new Error('same boom'))
    expect(JSON.parse(localStorage.getItem(QUEUE_KEY))).toHaveLength(5)
    setErrorReportsEnabled(false)
    expect(reportError(new Error('other boom'))).toBe(null)
  })

  it('a window error and an unhandled rejection become reports', () => {
    installErrorReporter({ tool: 'bench', win: window })
    window.dispatchEvent(new ErrorEvent('error', { error: new RangeError('window boom'), message: 'window boom' }))
    const ev = new Event('unhandledrejection')
    ev.reason = new Error('promise boom')
    window.dispatchEvent(ev)
    const q = JSON.parse(localStorage.getItem(QUEUE_KEY))
    expect(q.map((e) => [e.kind, e.error_name, e.message])).toEqual([['js.error', 'RangeError', 'window boom'], ['js.unhandledrejection', 'Error', 'promise boom']])
  })

  it('a dropped upload from the activity bus is a warning; a refused approval PDF (LOG-10) an error', () => {
    installErrorReporter({ tool: 'scorer', win: window })
    const dropped = { resource: 'scoresheet', action: 'upload', status: 409, code: 'OV_MATCH_CLOSED', attempt: 1 }
    emitActivity('sync.dropped', dropped, { level: 'warn' })
    emitActivity('sync.dropped', { ...dropped, attempt: 2 }, { level: 'error' })
    const q = JSON.parse(localStorage.getItem(QUEUE_KEY))
    expect(q.map((e) => [e.kind, e.level])).toEqual([['sync.dropped', 'warn'], ['sync.dropped', 'error']])
    for (const ev of q) expect(checkClientEvent(ev, { accountId: null }).code).toBeUndefined()
  })

  it('stack lines lose their origin and query', () => {
    expect(framesOf('Error: x\n    at a (https://app.openvolley.app/assets/index-AbC.js?x=1:1:2)\nb@capacitor://localhost/assets/b.js:3:4')).toEqual(['a (/assets/index-AbC.js:1:2)', 'b@/assets/b.js:3:4'])
  })

  it('the context of a real page passes the server\'s checks', () => {
    const ctx = staticContext({ tool: 'scorer', win: window })
    const r = checkClientEvent({ uid: '9f8e7d6c-1234-4abc-8def-0123456789ab', client_ts: new Date().toISOString(), kind: 'js.error', level: 'error', message: 'x', ...ctx })
    expect(r.code).toBeUndefined()
  })
})
