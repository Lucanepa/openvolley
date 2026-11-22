// The four look switches of a device (utils/lookSettings, owner 22.11.2026):
// today's look by default on every platform, kept in localStorage, applied to
// <html> at once, and a blocked storage never breaks them.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  LOOK_KEYS, LOOK_SWITCHES, NO_MOTION_ATTR, applyLook, getLook, initLook, lookDefaults, pdfSharpFor, readLook,
  readStoredSwitch, resetLookForTests, setLook, useLook
} from '../lookSettings'
import { LITE_GRAPHICS_CLASS, liteGraphicsOn, privacyCoverFill } from '../liteGraphics'
import { APP_VIEW_ATTR, currentInAppView, openAppWindow } from '../openAppWindow'
import LineupSetOverlay from '../../components/scoreboard/LineupSetOverlay'

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 13; SM-T220 Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Safari/537.36'
const IOS_UA = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
const DESKTOP_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const root = () => document.documentElement
const setUserAgent = (ua, win = window) => Object.defineProperty(win.navigator, 'userAgent', { configurable: true, get: () => ua })
/** Where the page runs: the Android app, the iOS app, the desktop app (Tauri) or a browser. */
function runOn(where) {
  delete window.Capacitor
  delete window.__TAURI__
  if (where === 'android') { window.Capacitor = { isNativePlatform: () => true }; setUserAgent(ANDROID_UA) }
  if (where === 'ios') { window.Capacitor = { isNativePlatform: () => true }; setUserAgent(IOS_UA) }
  if (where === 'desktop') { window.__TAURI__ = {}; setUserAgent(DESKTOP_UA) }
  if (where === 'web') setUserAgent(DESKTOP_UA)
  if (where === 'android-web') setUserAgent(ANDROID_UA)
}
const TODAY = {
  // the hall tablet's look since the perf pass: no blur, the PDF at 1.5
  android: { blur: false, motion: true, clockSeconds: true, pdfSharp: false },
  ios: { blur: true, motion: true, clockSeconds: true, pdfSharp: true },
  desktop: { blur: true, motion: true, clockSeconds: true, pdfSharp: true },
  web: { blur: true, motion: true, clockSeconds: true, pdfSharp: true },
  'android-web': { blur: true, motion: true, clockSeconds: true, pdfSharp: true }
}

beforeEach(() => {
  localStorage.clear()
  resetLookForTests()
})

afterEach(() => {
  delete window.Capacitor
  delete window.__TAURI__
  delete window.navigator.userAgent
  root().classList.remove(LITE_GRAPHICS_CLASS)
  root().removeAttribute(NO_MOTION_ATTR)
  localStorage.clear()
  resetLookForTests()
  vi.restoreAllMocks()
})

describe('the defaults are today\'s look', () => {
  for (const where of Object.keys(TODAY)) {
    it(`${where}: ${JSON.stringify(TODAY[where])}`, () => {
      runOn(where)
      expect(lookDefaults()).toEqual(TODAY[where])
      expect(readLook()).toEqual(TODAY[where])
      initLook()
      // the Android app keeps ov-lite (no blur) as since the perf pass; the
      // others no class; nobody loses the animations
      expect(liteGraphicsOn()).toBe(where === 'android')
      expect(root().hasAttribute(NO_MOTION_ATTR)).toBe(false)
    })
  }

  it('four switches, one key each', () => {
    expect(LOOK_SWITCHES).toEqual(['blur', 'motion', 'clockSeconds', 'pdfSharp'])
    expect(new Set(Object.values(LOOK_KEYS)).size).toBe(4)
  })
})

describe('stored switches', () => {
  it('a stored value wins over the default, anything else is the default', () => {
    runOn('android')
    localStorage.setItem(LOOK_KEYS.blur, 'true')
    localStorage.setItem(LOOK_KEYS.motion, 'false')
    localStorage.setItem(LOOK_KEYS.clockSeconds, 'yes')
    expect(readLook()).toEqual({ blur: true, motion: false, clockSeconds: true, pdfSharp: false })
    expect(readStoredSwitch('clockSeconds')).toBe(null)
  })

  it('setLook keeps the switch, applies it to <html> at once and leaves the others', () => {
    runOn('web')
    setLook({ blur: false })
    expect(localStorage.getItem(LOOK_KEYS.blur)).toBe('false')
    expect(liteGraphicsOn()).toBe(true)
    expect(root().hasAttribute(NO_MOTION_ATTR)).toBe(false)
    setLook({ motion: false, clockSeconds: false })
    expect(root().hasAttribute(NO_MOTION_ATTR)).toBe(true)
    expect(getLook()).toEqual({ blur: false, motion: false, clockSeconds: false, pdfSharp: true })
    setLook({ blur: true, motion: true })
    expect(liteGraphicsOn()).toBe(false)
    expect(root().hasAttribute(NO_MOTION_ATTR)).toBe(false)
    expect(localStorage.getItem(LOOK_KEYS.pdfSharp)).toBe(null)
  })

  it('only booleans of the four switches are kept', () => {
    setLook({ blur: 'no', other: false, motion: false })
    expect(localStorage.getItem(LOOK_KEYS.blur)).toBe(null)
    expect(localStorage.getItem('other')).toBe(null)
    expect(localStorage.getItem(LOOK_KEYS.motion)).toBe('false')
  })

  it('applyLook without a document does nothing', () => {
    expect(() => applyLook({ blur: false, motion: false }, null)).not.toThrow()
  })
})

describe('storage blocked or broken', () => {
  it('reading throws: today\'s look', () => {
    runOn('android')
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('SecurityError') })
    expect(readLook()).toEqual(TODAY.android)
    expect(() => initLook()).not.toThrow()
    expect(liteGraphicsOn()).toBe(true)
  })

  it('writing throws: the switch still applies to this page and holds there', () => {
    runOn('web')
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError') })
    expect(setLook({ blur: false, clockSeconds: false }).blur).toBe(false)
    expect(liteGraphicsOn()).toBe(true)
    expect(getLook()).toMatchObject({ blur: false, clockSeconds: false })
  })

  it('no storage at all', () => {
    expect(readLook({ storage: null, androidApp: false })).toEqual(TODAY.web)
    expect(readStoredSwitch('blur', undefined)).toBe(null)
  })
})

describe('useLook', () => {
  function Shown() {
    const look = useLook()
    return <span data-testid="look">{JSON.stringify(look)}</span>
  }

  it('renders again when a switch changes, with the same object in between', () => {
    runOn('web')
    let renders = 0
    function Counting() {
      renders++
      return <Shown />
    }
    render(<Counting />)
    expect(JSON.parse(screen.getByTestId('look').textContent)).toEqual(TODAY.web)
    expect(getLook()).toBe(getLook())
    act(() => { setLook({ clockSeconds: false }) })
    expect(JSON.parse(screen.getByTestId('look').textContent).clockSeconds).toBe(false)
    expect(renders).toBe(1)
  })

  it('a change made in another tab of the app applies here too', () => {
    runOn('web')
    initLook()
    render(<Shown />)
    localStorage.setItem(LOOK_KEYS.motion, 'false')
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: LOOK_KEYS.motion, newValue: 'false' })) })
    expect(root().hasAttribute(NO_MOTION_ATTR)).toBe(true)
    expect(JSON.parse(screen.getByTestId('look').textContent).motion).toBe(false)
    // another key: nothing
    localStorage.setItem(LOOK_KEYS.motion, 'true')
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'theme', newValue: 'dark' })) })
    expect(root().hasAttribute(NO_MOTION_ATTR)).toBe(true)
  })
})

describe('the line-up cover follows the blur switch', () => {
  it('blur on: frosted; off: the near-opaque panel', () => {
    runOn('web')
    setLook({ blur: true })
    expect(privacyCoverFill()).toEqual({ background: 'rgba(15, 23, 42, 0.5)', backdropFilter: 'blur(8px)' })
    setLook({ blur: false })
    expect(privacyCoverFill()).toEqual({ background: 'rgb(15, 23, 42)' })
  })

  it('the phone court\'s cover too: frosted 8 px, or the near-opaque panel', () => {
    runOn('web')
    setLook({ blur: true })
    const { unmount } = render(<LineupSetOverlay side="left" onPeek={() => {}} />)
    let cover = screen.getByTestId('phone-lineup-hidden-left')
    expect(cover.style.backdropFilter).toBe('blur(8px)')
    expect(cover.style.background).toMatch(/rgba\(15, 23, 42, 0\.55\)/)
    unmount()
    setLook({ blur: false })
    render(<LineupSetOverlay side="left" onPeek={() => {}} />)
    cover = screen.getByTestId('phone-lineup-hidden-left')
    expect(cover.style.backdropFilter || '').toBe('')
    expect(cover.style.background).toMatch(/rgba\(15, 23, 42, 0\.92\)/)
  })

  it('the scoring screen\'s full-screen notices (turn the tablet, turn the phone back) only dim with the blur off', () => {
    const scoreboard = readFileSync(resolve(__dirname, '../../components/Scoreboard.jsx'), 'utf8')
    expect(scoreboard.match(/\.\.\.\(liteGraphicsOn\(\) \? null : \{ backdropFilter: 'blur\(4px\)' \}\),/g)).toHaveLength(2)
    expect(scoreboard).not.toMatch(/^\s*backdropFilter: 'blur\(\d+px\)',$/m)
  })

  it('the scoring screen renders again on a change (useLook)', () => {
    const scoreboard = readFileSync(resolve(__dirname, '../../components/Scoreboard.jsx'), 'utf8')
    expect(scoreboard).toMatch(/^import \{ useLook \} from '\.\.\/utils\/lookSettings'$/m)
    expect(scoreboard).toMatch(/^ {2}useLook\(\)$/m)
  })
})

describe('main.jsx', () => {
  it('applies the stored look at start, before the first render', () => {
    const main = readFileSync(resolve(__dirname, '../../main.jsx'), 'utf8')
    expect(main).toMatch(/^import \{ initLook \} from '\.\/utils\/lookSettings'$/m)
    expect(main).toMatch(/^initLook\(\)$/m)
    expect(main.indexOf('\ninitLook()')).toBeLessThan(main.indexOf('createRoot('))
    expect(main).not.toMatch(/applyLiteGraphics/)
  })
})

describe('the referee, bench and livescore pages: only the switches the scorer set', () => {
  for (const entry of ['referee-main.jsx', 'bench-main.jsx', 'livescore-main.jsx']) {
    it(`${entry} applies them at start, before the first render`, () => {
      const main = readFileSync(resolve(__dirname, '../..', entry), 'utf8')
      expect(main).toMatch(/^import \{ initLook \} from '\.\/utils\/lookSettings'$/m)
      expect(main).toMatch(/^initLook\(\{ storedOnly: true \}\)$/m)
      expect(main.indexOf('\ninitLook({ storedOnly: true })')).toBeLessThan(main.indexOf('createRoot('))
    })
  }

  it('never set: the look those pages always had, blur and animations on, also in the Android app', () => {
    runOn('android')
    initLook({ storedOnly: true })
    expect(getLook()).toMatchObject({ blur: true, motion: true })
    expect(liteGraphicsOn()).toBe(false)
    expect(root().hasAttribute(NO_MOTION_ATTR)).toBe(false)
  })

  it('set by the scorer (Apply, or a switch in Options): blur and animations off here too', () => {
    runOn('android')
    localStorage.setItem(LOOK_KEYS.blur, 'false')
    localStorage.setItem(LOOK_KEYS.motion, 'false')
    initLook({ storedOnly: true })
    expect(getLook()).toMatchObject({ blur: false, motion: false })
    expect(liteGraphicsOn()).toBe(true)
    expect(root().hasAttribute(NO_MOTION_ATTR)).toBe(true)
  })

  it('the scorer\'s page keeps its own defaults (the Android app: no blur)', () => {
    runOn('android')
    initLook()
    expect(getLook().blur).toBe(false)
    expect(liteGraphicsOn()).toBe(true)
  })

  it('the referee view\'s line-up covers follow the blur switch: frosted 16 px, or the near-opaque panel', () => {
    const referee = readFileSync(resolve(__dirname, '../../components/Referee.jsx'), 'utf8')
    expect(referee).toMatch(/^ {2}useLook\(\)$/m)
    expect(referee.match(/\.\.\.privacyCoverFill\(undefined, REFEREE_COVER_FROSTED\)/g)).toHaveLength(2)
    expect(referee).not.toMatch(/backdropFilter: 'blur\(16px\)',\n/)
    const frosted = { background: 'rgba(15, 23, 42, 0.6)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)' }
    runOn('web')
    setLook({ blur: true })
    expect(privacyCoverFill(undefined, frosted)).toEqual(frosted)
    setLook({ blur: false })
    expect(privacyCoverFill(undefined, frosted)).toEqual({ background: 'rgb(15, 23, 42)' })
  })
})

// The PDF made on the device (scoresheet_pdf/utils/pdfCapture): the sheet runs
// in a popup / app window or the Android app's in-app view, same origin
describe('pdfSharpFor: the setting, read by the page that makes the PDF', () => {
  afterEach(() => { currentInAppView()?.close() })

  it('never set: 1.5 only in the Android app and its in-app view (today\'s default)', () => {
    runOn('android')
    expect(pdfSharpFor(window)).toBe(false)
    openAppWindow('/scoresheet/?matchId=7', { win: window, platform: 'capacitor' })
    const view = document.querySelector(`iframe[${APP_VIEW_ATTR}]`).contentWindow
    // the app under the view (jsdom's window object, as the frame sees it)
    const app = view.parent
    app.Capacitor = { isNativePlatform: () => true }
    setUserAgent(ANDROID_UA, app)
    try {
      expect(view.Capacitor).toBeUndefined()
      expect(pdfSharpFor(view)).toBe(false)
    } finally {
      delete app.Capacitor
      delete app.navigator.userAgent
    }
    for (const where of ['ios', 'desktop', 'web', 'android-web']) {
      runOn(where)
      expect(pdfSharpFor(window), where).toBe(true)
    }
  })

  it('the stored switch wins, either way', () => {
    runOn('android')
    localStorage.setItem(LOOK_KEYS.pdfSharp, 'true')
    expect(pdfSharpFor(window)).toBe(true)
    runOn('web')
    localStorage.setItem(LOOK_KEYS.pdfSharp, 'false')
    expect(pdfSharpFor(window)).toBe(false)
  })

  it('a window whose storage cannot be read takes the default', () => {
    const locked = { navigator: { userAgent: DESKTOP_UA }, get localStorage() { throw new Error('SecurityError') } }
    locked.parent = locked
    expect(pdfSharpFor(locked)).toBe(true)
    expect(pdfSharpFor(undefined)).toBe(true)
  })
})
