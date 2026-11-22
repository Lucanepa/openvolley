// Lite graphics (utils/liteGraphics): ov-lite on <html> only in the Android
// app, while LITE_GRAPHICS_ON_ANDROID is on (on since the owner said yes,
// 22.11.2026). Then dialog scrims lose their backdrop blur (tailwind.css) and
// the line-up privacy cover is a near-opaque panel (Scoreboard.jsx). The
// switch is injected here, so both of its values are covered.
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  LITE_GRAPHICS_CLASS, LITE_GRAPHICS_ON_ANDROID, applyLiteGraphics, inAndroidApp, isAndroidApp, liteGraphicsOn, privacyCoverFill
} from '../utils/liteGraphics'
import { APP_VIEW_ATTR, currentInAppView, openAppWindow } from '../utils/openAppWindow'

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 13; SM-T220 Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Safari/537.36'
const IOS_UA = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
const DESKTOP_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const nativeApp = (native) => {
  window.Capacitor = native ? { isNativePlatform: () => true } : undefined
}

afterEach(() => {
  delete window.Capacitor
  document.documentElement.classList.remove(LITE_GRAPHICS_CLASS)
})

describe('ov-lite: only the Android app, only when switched on', () => {
  it('is on (owner, 22.11.2026): the Android app gets the class by default', () => {
    expect(LITE_GRAPHICS_ON_ANDROID).toBe(true)
    nativeApp(true)
    expect(applyLiteGraphics({ android: isAndroidApp({ userAgent: ANDROID_UA }) })).toBe(true)
    expect(liteGraphicsOn()).toBe(true)
    expect(privacyCoverFill()).toEqual({ background: 'rgba(15, 23, 42, 0.92)' })
  })

  it('switched off: not even the Android app', () => {
    nativeApp(true)
    expect(applyLiteGraphics({ enabled: false, android: isAndroidApp({ userAgent: ANDROID_UA }) })).toBe(false)
    expect(liteGraphicsOn()).toBe(false)
  })

  for (const [where, native, userAgent] of [
    ['the web on an Android tablet', false, ANDROID_UA],
    ['the iOS app', true, IOS_UA],
    ['the desktop apps and the web', false, DESKTOP_UA]
  ]) {
    it(`by default: never ${where}`, () => {
      nativeApp(native)
      expect(applyLiteGraphics({ android: isAndroidApp({ userAgent }) })).toBe(false)
      expect(liteGraphicsOn()).toBe(false)
      expect(privacyCoverFill()).toEqual({ background: 'rgba(15, 23, 42, 0.5)', backdropFilter: 'blur(8px)' })
    })
  }

  it('switched on: the Android app gets the class', () => {
    nativeApp(true)
    const android = isAndroidApp({ userAgent: ANDROID_UA })
    expect(android).toBe(true)
    expect(applyLiteGraphics({ enabled: true, android })).toBe(true)
    expect(document.documentElement.classList.contains(LITE_GRAPHICS_CLASS)).toBe(true)
    expect(liteGraphicsOn()).toBe(true)
  })

  for (const [where, native, userAgent] of [
    ['the web on an Android tablet', false, ANDROID_UA],
    ['the iOS app', true, IOS_UA],
    ['the desktop apps and the web', false, DESKTOP_UA]
  ]) {
    it(`switched on: never ${where}`, () => {
      nativeApp(native)
      const android = isAndroidApp({ userAgent })
      expect(android).toBe(false)
      expect(applyLiteGraphics({ enabled: true, android })).toBe(false)
      expect(liteGraphicsOn()).toBe(false)
    })
  }

  it('main.jsx applies it at start with the switch as it is', () => {
    const main = readFileSync(resolve(__dirname, '../main.jsx'), 'utf8')
    expect(main).toMatch(/^import \{ applyLiteGraphics \} from '\.\/utils\/liteGraphics'$/m)
    expect(main).toMatch(/^applyLiteGraphics\(\)$/m)
  })
})

describe('the line-up privacy cover', () => {
  it('off: frosted as before', () => {
    expect(privacyCoverFill()).toEqual({ background: 'rgba(15, 23, 42, 0.5)', backdropFilter: 'blur(8px)' })
  })

  it('ov-lite: no blur, and at least 90 % opaque so the other team cannot read the line-up', () => {
    document.documentElement.classList.add(LITE_GRAPHICS_CLASS)
    const fill = privacyCoverFill()
    expect(fill.backdropFilter).toBeUndefined()
    const alpha = Number(fill.background.match(/rgba\([^)]*,\s*([\d.]+)\)/)[1])
    expect(alpha).toBeGreaterThanOrEqual(0.9)
  })

  it('both tablet covers on the scoring screen take it', () => {
    const scoreboard = readFileSync(resolve(__dirname, '../components/Scoreboard.jsx'), 'utf8')
    expect(scoreboard.match(/\.\.\.privacyCoverFill\(\),/g)).toHaveLength(2)
    expect(scoreboard).not.toMatch(/backdropFilter: 'blur\(8px\)'/)
  })
})

describe('tailwind.css: the scrims without blur under ov-lite', () => {
  const css = readFileSync(resolve(__dirname, '../tailwind.css'), 'utf8')
  const rule = /html\.ov-lite :is\(\.backdrop-blur-sm, \.backdrop-blur\) \{\s*-webkit-backdrop-filter: none;\s*backdrop-filter: none;\s*\}/

  it('turns both blur classes off', () => {
    expect(css).toMatch(rule)
  })

  it('sits outside any @layer (and any other block), so it beats the utilities layer', () => {
    const at = css.search(rule)
    let depth = 0
    for (const ch of css.slice(0, at).replace(/\/\*[\s\S]*?\*\//g, '')) {
      if (ch === '{') depth++
      else if (ch === '}') depth--
    }
    expect(depth).toBe(0)
    expect(at).toBeGreaterThan(css.indexOf('@layer theme, base, legacy, components, utilities;'))
  })
})

// The scoresheet's capture in the Android app (pdfCapture capturePixelRatio):
// the page runs in the app's in-app view, a same-origin iframe of the app,
// so the check is made on the app's window
describe('inAndroidApp: the Android app\'s page, or a page in its in-app view', () => {
  const setUserAgent = (ua, win = window) => Object.defineProperty(win.navigator, 'userAgent', { configurable: true, get: () => ua })
  // the in-app view's window, its app (its parent, as the frame sees it)
  // native or not, with `userAgent`
  let app = null
  const inAppViewWindow = (native, userAgent) => {
    openAppWindow('/scoresheet/?matchId=7', { win: window, platform: 'capacitor' })
    const frame = document.querySelector(`iframe[${APP_VIEW_ATTR}]`)
    expect(frame).toBeTruthy()
    const view = frame.contentWindow
    app = view.parent
    app.Capacitor = native ? { isNativePlatform: () => true } : undefined
    setUserAgent(userAgent, app)
    return view
  }
  afterEach(() => {
    currentInAppView()?.close()
    delete window.navigator.userAgent
    if (app) {
      delete app.Capacitor
      delete app.navigator.userAgent
      app = null
    }
  })

  it('the Android app itself', () => {
    nativeApp(true)
    setUserAgent(ANDROID_UA)
    expect(inAndroidApp(window)).toBe(true)
  })

  it('a page in the Android app\'s in-app view: the app\'s window decides', () => {
    const view = inAppViewWindow(true, ANDROID_UA)
    expect(view.Capacitor).toBeUndefined()
    expect(inAndroidApp(view)).toBe(true)
  })

  for (const [where, native, userAgent] of [
    ['the web on an Android tablet', false, ANDROID_UA],
    ['the iOS app', true, IOS_UA],
    ['the desktop and the web', false, DESKTOP_UA]
  ]) {
    it(`never ${where}, nor a page in its view`, () => {
      nativeApp(native)
      setUserAgent(userAgent)
      expect(inAndroidApp(window)).toBe(false)
      if (native) expect(inAndroidApp(inAppViewWindow(native, userAgent))).toBe(false)
    })
  }

  it('never the desktop app (Tauri), nor without a window', () => {
    setUserAgent(ANDROID_UA)
    expect(inAndroidApp({ __TAURI__: {}, navigator: { userAgent: DESKTOP_UA } })).toBe(false)
    expect(inAndroidApp(undefined)).toBe(false)
  })
})
