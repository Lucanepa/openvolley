/**
 * What an error report says about where it happened (backend
 * lib/errorTracker.js, db/050): the product, tool and version, the platform,
 * the operating system and browser with their versions, how the app runs, the
 * device model when the system names it, screen and window, language, time
 * zone, the random device id (the activity log's) and a random visit id.
 * Never a name, an address or anything typed. Synchronous and never throwing.
 */
import { appVersion, platformName, deviceId } from '../identity'

const VISIT_KEY = 'ov.errorReports.visit'

const cut = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null)
const pick = (s, re) => (s.match(re) || [])[1] || null

/** A random id for this visit (one tab, kept over reloads). */
export function visitId(storage = typeof sessionStorage !== 'undefined' ? sessionStorage : null) {
  try {
    let v = storage?.getItem(VISIT_KEY)
    if (!v) {
      v = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
      storage?.setItem(VISIT_KEY, v)
    }
    return v
  } catch {
    return null
  }
}

/**
 * OS, browser and device model from the user agent (and userAgentData where
 * the browser has it): { os_name, os_version, browser, browser_version, device_model }.
 */
export function parseUserAgent(ua = '', uaData = null, maxTouchPoints = 0) {
  const s = String(ua || '')
  let osName = null
  let osVersion = null
  let model = null
  const android = pick(s, /Android ([\d.]+)/)
  if (android || /Android/.test(s)) {
    osName = 'Android'
    osVersion = android
    // "Android 15; SM-X910 Build/..." or "Android 14; Pixel 8)": the model after the version
    const m = s.match(/Android [\d.]+;\s*([^;)]+?)(?:\s+Build\/[^;)]*)?[;)]/)
    if (m && !/^(K|wv|Linux|U)$/.test(m[1].trim())) model = m[1].trim()
  } else if (/iPhone|iPad|iPod/.test(s) || (/Macintosh/.test(s) && Number(maxTouchPoints) > 1)) {
    osName = /iPad/.test(s) || /Macintosh/.test(s) ? 'iPadOS' : 'iOS'
    const v = pick(s, /OS (\d+[_\d]*) like Mac OS X/) || pick(s, /Version\/([\d.]+)/)
    osVersion = v ? v.replace(/_/g, '.') : null
    model = /iPad/.test(s) || /Macintosh/.test(s) ? 'iPad' : /iPhone/.test(s) ? 'iPhone' : null
  } else if (/\bCrOS\b/.test(s)) {
    osName = 'ChromeOS'
  } else if (/Windows/.test(s)) {
    osName = 'Windows'
    const nt = pick(s, /Windows NT ([\d.]+)/)
    osVersion = nt === '10.0' ? '10/11' : nt
  } else if (/Macintosh|Mac OS X/.test(s)) {
    osName = 'macOS'
    const v = pick(s, /Mac OS X ([\d_.]+)/)
    osVersion = v ? v.replace(/_/g, '.') : null
  } else if (/Linux|X11/.test(s)) {
    osName = 'Linux'
  }
  // userAgentData knows the platform even when the UA string is frozen
  const hint = uaData && typeof uaData.platform === 'string' ? uaData.platform : ''
  if (!osName && hint) osName = hint

  let browser = null
  let browserVersion = null
  const wv = /\bwv\b/.test(s) || (/Android/.test(s) && /Version\/[\d.]+ Chrome/.test(s))
  if (/Edg\//.test(s)) { browser = /WebView2|Tauri/.test(s) ? 'Edge WebView2' : 'Edge'; browserVersion = pick(s, /Edg\/([\d.]+)/) }
  else if (/Firefox\//.test(s)) { browser = 'Firefox'; browserVersion = pick(s, /Firefox\/([\d.]+)/) }
  else if (/OPR\//.test(s)) { browser = 'Opera'; browserVersion = pick(s, /OPR\/([\d.]+)/) }
  else if (/SamsungBrowser\//.test(s)) { browser = 'Samsung Internet'; browserVersion = pick(s, /SamsungBrowser\/([\d.]+)/) }
  else if (/Chrom(e|ium)\//.test(s)) { browser = wv ? 'Chrome WebView' : 'Chrome'; browserVersion = pick(s, /Chrom(?:e|ium)\/([\d.]+)/) }
  else if (/AppleWebKit/.test(s) && /Version\/[\d.]+.*Safari/.test(s)) { browser = 'Safari'; browserVersion = pick(s, /Version\/([\d.]+)/) }
  else if (/AppleWebKit/.test(s)) { browser = osName === 'Linux' ? 'WebKitGTK' : 'WebKit'; browserVersion = pick(s, /AppleWebKit\/([\d.]+)/) }
  return {
    os_name: cut(osName, 24),
    os_version: cut(osVersion, 24),
    browser: cut(browser, 32),
    browser_version: cut(browserVersion, 24),
    device_model: cut(model, 48)
  }
}

/** 'tab' | 'pwa' | 'desktop' | 'android_app' | 'ios_app' */
export function runsAs(platform, win) {
  if (String(platform).startsWith('tauri') || platform === 'electron') return 'desktop'
  if (platform === 'android') return 'android_app'
  if (platform === 'ios') return 'ios_app'
  try {
    if (win?.matchMedia?.('(display-mode: standalone)')?.matches || win?.matchMedia?.('(display-mode: fullscreen)')?.matches || win?.navigator?.standalone === true) return 'pwa'
  } catch { /* no matchMedia */ }
  return 'tab'
}

const size = (w, h) => (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? `${Math.round(w)}x${Math.round(h)}` : null)

/** The part that does not change during a visit. */
export function staticContext({ tool, product = 'openvolley', win = typeof window !== 'undefined' ? window : undefined } = {}) {
  const nav = win?.navigator || {}
  const platform = platformName(win)
  let lang = null
  let tz = null
  try { lang = cut(nav.language, 16) } catch { /* none */ }
  try { tz = cut(Intl.DateTimeFormat().resolvedOptions().timeZone, 48) } catch { /* none */ }
  let build = null
  try {
    // eslint-disable-next-line no-undef
    build = typeof __BUILD_SHA__ !== 'undefined' ? cut(String(__BUILD_SHA__), 40) : null
  } catch { /* not defined */ }
  return {
    product,
    tool,
    app_version: appVersion(),
    build,
    platform,
    ...parseUserAgent(nav.userAgent, nav.userAgentData, nav.maxTouchPoints),
    runs_as: runsAs(platform, win),
    point_hub: win?.__OV_POINTHUB_BOARD__ === true,
    screen: size(win?.screen?.width, win?.screen?.height),
    dpr: Number.isFinite(win?.devicePixelRatio) ? Math.round(win.devicePixelRatio * 100) / 100 : null,
    lang,
    tz,
    device_id: cut(safe(() => deviceId()), 64),
    session_id: visitId()
  }
}

/** The part read at the moment of the error. */
export function liveContext(win = typeof window !== 'undefined' ? window : undefined) {
  return {
    viewport: size(win?.innerWidth, win?.innerHeight),
    online: typeof win?.navigator?.onLine === 'boolean' ? win.navigator.onLine : null
  }
}

function safe(fn) {
  try { return fn() } catch { return null }
}
