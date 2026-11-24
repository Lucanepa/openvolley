/**
 * The scorer's Home menu opens this device as the referee or a bench
 * dashboard (owner 2026-11-10: "for any tablet/phone app and/or browser if on
 * a phone, also give in the menu the option to use it as either referee or
 * bench dashboard"), and the dashboard opened that way offers a way back.
 *
 * Where the dashboard is:
 * - the Android/iOS app (Capacitor): bundled in the same app (the app build
 *   is the full `vite build`, every entry included), so it opens offline.
 *   The file itself (/referee/index.html): the app's local server answers a
 *   path without a dot in its last segment with the scorer's index.html.
 * - a static deployment (app.openvolley.app, its Pages previews): the role's
 *   own site (referee.openvolley.app, bench.openvolley.app; QRCodeModal's
 *   cloudTabletBase), with the backend the scorer uses (`server=`);
 * - any other server (the desktop app's relay on the hall network, a venue
 *   box, the dev server): its own /referee/ and /bench/ pages.
 *
 * The way back: the link carries `from=scorer` (utils/scorerReturn.js).
 */
import { isNativeApp, isStaticHost, getCloudApiBaseUrl } from './backendConfig'
import { cloudTabletBase } from '../components/QRCodeModal'
import { withFromScorer } from './scorerReturn'
import { reloadWithReason } from '../diagnostics/reload'

export const SCORER_DASHBOARD_ROLES = ['referee', 'bench']

const ROLE_PATHS = { referee: '/referee/index.html', bench: '/bench/index.html', livescore: '/livescore/index.html' }
const ROLE_LINK_ROLES = { referee: 'referee', bench: 'bench_home', livescore: 'livescore' }

function safeWindow() {
  return typeof window !== 'undefined' ? window : null
}

function inDesktopApp(win) {
  return !!(win && (win.electronAPI || win.__TAURI__ || win.__TAURI_INTERNALS__))
}

/**
 * Whether Home offers the referee and bench dashboards: the Android/iOS app,
 * and a browser on a phone or tablet (by its user agent; an iPad's Safari
 * reads as a Mac, its touch points tell it apart; else a touch-first screen
 * no bigger than a tablet). Not the desktop app, not a computer's browser.
 */
export function canOfferDashboards({ win = safeWindow(), nav = typeof navigator !== 'undefined' ? navigator : null } = {}) {
  if (!win) return false
  if (isNativeApp()) return true
  if (inDesktopApp(win)) return false
  const ua = String(nav?.userAgent || '')
  if (/android|iphone|ipad|ipod|mobile|tablet/i.test(ua)) return true
  if (/macintosh/i.test(ua) && (nav?.maxTouchPoints || 0) > 1) return true
  let coarse = false
  try {
    coarse = !!win.matchMedia?.('(pointer: coarse)')?.matches
  } catch {
    coarse = false
  }
  const w = win.screen?.width || win.innerWidth || 0
  const h = win.screen?.height || win.innerHeight || 0
  return coarse && w > 0 && h > 0 && Math.min(w, h) <= 1024
}

/**
 * The link Home opens for a role ('referee' | 'bench'), `from=scorer` on it.
 * Null for an unknown role.
 */
export function scorerDashboardUrl(role, { win = safeWindow() } = {}) {
  const path = ROLE_PATHS[role]
  if (!path) return null
  if (isNativeApp()) return withFromScorer(path)
  const hostname = win?.location?.hostname || ''
  if (isStaticHost(hostname)) {
    // The role's site, on the backend the scorer uses (as cloudRoleUrl in
    // utils/tabletLinks, but no team: the bench picks its own)
    const base = cloudTabletBase(ROLE_LINK_ROLES[role], hostname)
    if (!base) return null
    const api = getCloudApiBaseUrl()
    return withFromScorer(`${base}/${api ? `?server=${encodeURIComponent(api)}` : ''}`)
  }
  return withFromScorer(path)
}

/** Open this device as the role's dashboard (Home menu, Options in the app). */
export function openScorerDashboard(role, { win = safeWindow() } = {}) {
  const url = scorerDashboardUrl(role, { win })
  if (!url) return false
  reloadWithReason('open-dashboard', { how: 'assign', url, win })
  return true
}
