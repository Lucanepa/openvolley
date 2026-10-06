import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  APP_VIEW_ATTR,
  MSG_CLOSE,
  MSG_SAVE_PDF,
  currentInAppView,
  detectAppPlatform,
  openAppWindow,
  openFailedMessageKey,
  resolveAppUrl,
  writePdfNative,
} from '../openAppWindow'
import { closeAppWindow, getOpenerWindow, isInAppView, savePdfThroughApp } from '../appWindowGuest'

const ORIGIN = 'http://localhost:5173'

/** A window stub: location on ORIGIN, window.open returning `opened`. */
function fakeWin({ opened = {}, extra = {} } = {}) {
  return {
    location: { href: `${ORIGIN}/`, origin: ORIGIN, assign: vi.fn() },
    open: vi.fn(() => opened),
    ...extra,
  }
}

afterEach(() => {
  currentInAppView()?.close()
  document.body.innerHTML = ''
})

describe('detectAppPlatform', () => {
  it('tells the desktop app, the Android app and a browser apart', () => {
    expect(detectAppPlatform({ __TAURI_INTERNALS__: { invoke() {} } })).toBe('tauri')
    expect(detectAppPlatform({ __TAURI__: {} })).toBe('tauri')
    expect(detectAppPlatform({ Capacitor: { isNativePlatform: () => true } })).toBe('capacitor')
    // @capacitor/core in a browser: not native
    expect(detectAppPlatform({ Capacitor: { isNativePlatform: () => false } })).toBe('web')
    expect(detectAppPlatform({})).toBe('web')
    expect(detectAppPlatform(undefined)).toBe('web')
  })

  it('treats a throwing bridge as a browser', () => {
    expect(detectAppPlatform({ Capacitor: { isNativePlatform: () => { throw new Error('x') } } })).toBe('web')
  })
})

describe('resolveAppUrl', () => {
  it('resolves relative URLs and tells same-origin from external', () => {
    const win = fakeWin()
    expect(resolveAppUrl('/scoresheet/?matchId=7', win)).toEqual({ href: `${ORIGIN}/scoresheet/?matchId=7`, sameOrigin: true, scheme: 'http:' })
    expect(resolveAppUrl('https://openvolley.app/x', win).sameOrigin).toBe(false)
    expect(resolveAppUrl('http://localhost:8080/', win).sameOrigin).toBe(false)
    expect(resolveAppUrl('mailto:a@b.c', win).scheme).toBe('mailto:')
  })
})

describe('openAppWindow in a browser', () => {
  it('opens the scoresheet as a popup, as before', () => {
    const popup = {}
    const win = fakeWin({ opened: popup })
    const r = openAppWindow('/scoresheet/?matchId=7', { win, platform: 'web', features: 'width=1200,height=900' })
    expect(win.open).toHaveBeenCalledWith(`${ORIGIN}/scoresheet/?matchId=7`, '_blank', 'width=1200,height=900')
    expect(r).toMatchObject({ ok: true, mode: 'popup', platform: 'web', window: popup })
  })

  it('reports a blocked popup, and only then asks to allow popups', () => {
    const win = fakeWin({ opened: null })
    const r = openAppWindow('/scoresheet/?matchId=7', { win, platform: 'web' })
    expect(r).toMatchObject({ ok: false, mode: 'blocked' })
    expect(openFailedMessageKey(r, 'matchSetup.allowPopups')).toBe('matchSetup.allowPopups')
  })

  it('opens external links with noopener and never calls them blocked', () => {
    const win = fakeWin({ opened: null }) // noopener: window.open returns null
    const r = openAppWindow('https://openvolley.app/help', { win, platform: 'web' })
    expect(win.open).toHaveBeenCalledWith('https://openvolley.app/help', '_blank', 'noopener,noreferrer')
    expect(r).toMatchObject({ ok: true, mode: 'external' })
  })

  it('refuses other schemes', () => {
    const win = fakeWin()
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x']) {
      expect(openAppWindow(url, { win, platform: 'web' })).toMatchObject({ ok: false, mode: 'blocked' })
    }
    expect(win.open).not.toHaveBeenCalled()
  })
})

describe('openAppWindow in the desktop app (Tauri)', () => {
  it('opens app pages with window.open (the app turns it into an app window)', () => {
    const child = {}
    const win = fakeWin({ opened: child, extra: { __TAURI_INTERNALS__: {} } })
    const r = openAppWindow('/scoresheet/?matchId=7&action=print', { win })
    expect(win.open).toHaveBeenCalledWith(`${ORIGIN}/scoresheet/?matchId=7&action=print`, '_blank', 'width=1200,height=900')
    expect(r).toMatchObject({ ok: true, mode: 'window', platform: 'tauri', window: child })
  })

  it('external links: the app opens the system browser and refuses the window (null is fine)', () => {
    const win = fakeWin({ opened: null, extra: { __TAURI_INTERNALS__: {} } })
    expect(openAppWindow('mailto:volleyball@example.com?subject=x', { win })).toMatchObject({ ok: true, mode: 'external' })
    expect(openAppWindow('https://openvolley.app/', { win })).toMatchObject({ ok: true, mode: 'external' })
    expect(win.open).toHaveBeenCalledTimes(2)
  })

  it('a refused app window is not a popup blocker', () => {
    const win = fakeWin({ opened: null, extra: { __TAURI_INTERNALS__: {} } })
    const r = openAppWindow('/scoresheet/?matchId=7', { win })
    expect(r).toMatchObject({ ok: false, mode: 'blocked', platform: 'tauri' })
    expect(openFailedMessageKey(r, 'matchSetup.allowPopups')).toBe('appWindow.couldNotOpen')
  })
})

describe('openAppWindow in the Android app (Capacitor)', () => {
  const open = (url, opts = {}) => openAppWindow(url, { win: window, platform: 'capacitor', ...opts })

  it('shows app pages in a full-screen in-app view, without window.open or leaving the page', () => {
    const spy = vi.spyOn(window, 'open')
    const before = window.location.href
    const r = open('/scoresheet/?matchId=7', { title: 'Scoresheet' })
    expect(spy).not.toHaveBeenCalled()
    expect(window.location.href).toBe(before)
    expect(r).toMatchObject({ ok: true, mode: 'in-app', platform: 'capacitor' })
    const view = document.querySelector('[data-testid="app-window"]')
    expect(view).not.toBeNull()
    const frame = view.querySelector('iframe')
    expect(frame.hasAttribute(APP_VIEW_ATTR)).toBe(true)
    expect(frame.getAttribute('src')).toBe(`${window.location.origin}/scoresheet/?matchId=7`)
    expect(view.textContent).toContain('Scoresheet')
    expect(r.window).toBe(frame.contentWindow)
    spy.mockRestore()
  })

  it('keeps the screen underneath mounted and returns to it with Back', () => {
    const screen = document.createElement('div')
    screen.id = 'scoreboard'
    document.body.appendChild(screen)
    open('/scoresheet/?matchId=7')
    expect(document.getElementById('scoreboard')).toBe(screen)
    document.querySelector('[data-testid="app-window-back"]').click()
    expect(document.querySelector('[data-testid="app-window"]')).toBeNull()
    expect(document.getElementById('scoreboard')).toBe(screen)
    expect(currentInAppView()).toBeNull()
  })

  it('closes on the Android Back button (popstate) and on Escape', () => {
    open('/scoresheet/?matchId=7')
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }))
    expect(document.querySelector('[data-testid="app-window"]')).toBeNull()

    open('/scoresheet/?matchId=7')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(document.querySelector('[data-testid="app-window"]')).toBeNull()
  })

  it('closes when its page asks (window.close of the scoresheet), and only its page', () => {
    const r = open('/scoresheet/?matchId=7&action=getBlob')
    // another frame / origin: ignored
    window.dispatchEvent(new MessageEvent('message', { data: { type: MSG_CLOSE }, origin: window.location.origin, source: window }))
    window.dispatchEvent(new MessageEvent('message', { data: { type: MSG_CLOSE }, origin: 'https://evil.example', source: r.window }))
    expect(document.querySelector('[data-testid="app-window"]')).not.toBeNull()
    window.dispatchEvent(new MessageEvent('message', { data: { type: MSG_CLOSE }, origin: window.location.origin, source: r.window }))
    expect(document.querySelector('[data-testid="app-window"]')).toBeNull()
  })

  it('opening again reuses the view', () => {
    open('/scoresheet/?matchId=7')
    open('/scoresheet/?matchId=7&action=save')
    const views = document.querySelectorAll('[data-testid="app-window"]')
    expect(views).toHaveLength(1)
    expect(views[0].querySelector('iframe').getAttribute('src')).toContain('action=save')
  })

  it('sends external links to the system browser by navigation (Capacitor hands it to Android)', () => {
    const win = fakeWin({ extra: { Capacitor: { isNativePlatform: () => true } } })
    const r = openAppWindow('https://openvolley.app/help', { win })
    expect(win.location.assign).toHaveBeenCalledWith('https://openvolley.app/help')
    expect(win.open).not.toHaveBeenCalled()
    expect(r).toMatchObject({ ok: true, mode: 'external', platform: 'capacitor' })
  })
})

describe('writePdfNative (Save PDF in the Android app)', () => {
  const pdf = new TextEncoder().encode('%PDF-1.4 test').buffer
  const Directory = { Documents: 'DOCUMENTS', External: 'EXTERNAL' }

  it('writes the PDF as base64 to Documents/OpenVolley/scoresheets', async () => {
    const writeFile = vi.fn(async () => ({ uri: 'file:///storage/emulated/0/Documents/OpenVolley/scoresheets/x.pdf' }))
    const res = await writePdfNative({ Filesystem: { writeFile }, Directory }, pdf, '7_HOME_AWAY_20261006.pdf')
    expect(writeFile).toHaveBeenCalledWith({
      path: 'OpenVolley/scoresheets/7_HOME_AWAY_20261006.pdf',
      data: btoa('%PDF-1.4 test'),
      directory: 'DOCUMENTS',
      recursive: true,
    })
    expect(res.path).toBe('Documents/OpenVolley/scoresheets/7_HOME_AWAY_20261006.pdf')
  })

  it('falls back to the app folder, and keeps the file name safe', async () => {
    const writeFile = vi.fn()
      .mockRejectedValueOnce(new Error('denied'))
      .mockResolvedValueOnce({ uri: 'file:///x' })
    const res = await writePdfNative({ Filesystem: { writeFile }, Directory }, pdf, '../a/b:c.pdf')
    expect(writeFile).toHaveBeenLastCalledWith(expect.objectContaining({ directory: 'EXTERNAL', path: 'OpenVolley/scoresheets/.._a_b_c.pdf' }))
    expect(res.path).toContain('Android/data/')
  })

  it('throws when nothing is writable', async () => {
    const writeFile = vi.fn(async () => { throw new Error('nope') })
    await expect(writePdfNative({ Filesystem: { writeFile }, Directory }, pdf, 'x.pdf')).rejects.toThrow('nope')
  })
})

describe('every window.open of the app goes through openAppWindow', () => {
  it('has no other window.open call in src/ or scoresheet_pdf/', async () => {
    const { listSourceFiles, FRONTEND_DIR } = await import('../../../scripts/check-i18n-keys.js')
    const fs = await import('node:fs')
    const path = await import('node:path')
    const offenders = []
    for (const file of listSourceFiles()) {
      if (file.endsWith(path.join('utils', 'openAppWindow.js'))) continue
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (/\bwindow\.open\s*\(/.test(line) && !/^\s*(\/\/|\*)/.test(line)) offenders.push(`${path.relative(FRONTEND_DIR, file)}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })
})

describe('the page side (appWindowGuest)', () => {
  function frameWin({ inView = true, opener = null } = {}) {
    const parent = { postMessage: vi.fn() }
    const win = {
      opener,
      close: vi.fn(),
      location: { origin: ORIGIN },
      frameElement: inView ? { hasAttribute: (a) => a === APP_VIEW_ATTR } : null,
    }
    win.parent = inView ? parent : win
    return { win, parent }
  }

  it('knows when it runs in the in-app view', () => {
    expect(isInAppView(frameWin().win)).toBe(true)
    expect(isInAppView(frameWin({ inView: false }).win)).toBe(false)
    // a cross-origin parent throws on frameElement
    const w = { parent: {}, get frameElement() { throw new Error('SecurityError') } }
    expect(isInAppView(w)).toBe(false)
  })

  it('talks to the opener, or to the app under the in-app view', () => {
    const opener = { closed: false }
    expect(getOpenerWindow(frameWin({ inView: false, opener }).win)).toBe(opener)
    const { win, parent } = frameWin()
    expect(getOpenerWindow(win)).toBe(parent)
    expect(getOpenerWindow(frameWin({ inView: false }).win)).toBeNull()
    expect(getOpenerWindow(frameWin({ inView: false, opener: { closed: true } }).win)).toBeNull()
  })

  it('closes the popup, or asks the app to close the in-app view', () => {
    const popup = frameWin({ inView: false })
    closeAppWindow(popup.win)
    expect(popup.win.close).toHaveBeenCalled()

    const { win, parent } = frameWin()
    closeAppWindow(win)
    expect(win.close).not.toHaveBeenCalled()
    expect(parent.postMessage).toHaveBeenCalledWith({ type: MSG_CLOSE }, ORIGIN)
  })

  it('hands a PDF to the app only inside the in-app view', async () => {
    const blob = new Blob(['%PDF'], { type: 'application/pdf' })
    expect(await savePdfThroughApp(blob, 'x.pdf', frameWin({ inView: false }).win)).toBe(false)
    const { win, parent } = frameWin()
    expect(await savePdfThroughApp(blob, 'x.pdf', win)).toBe(true)
    const [msg, origin] = parent.postMessage.mock.calls[0]
    expect(origin).toBe(ORIGIN)
    expect(msg.type).toBe(MSG_SAVE_PDF)
    expect(msg.filename).toBe('x.pdf')
    expect(new TextDecoder().decode(msg.arrayBuffer)).toBe('%PDF')
  })
})
