/**
 * The way back from a dashboard opened from the scorer's Home menu
 * (utils/scorerDashboards.js): the link carries `from=scorer`, the dashboard
 * page keeps that for the tab (sessionStorage: the page rewrites its own
 * URL), and its menus show "Back to scorer". Never on the scorer page itself.
 * Kept apart from scorerDashboards.js so the referee, bench and livescore
 * pages do not load the scorer's link helpers.
 */
import { isScorerEntry } from './appEntry'
import { reloadWithReason } from '../diagnostics/reload'

const RETURN_KEY = 'ov.scorerReturn'
export const FROM_PARAM = 'from'
export const FROM_SCORER = 'scorer'

function safeWindow() {
  return typeof window !== 'undefined' ? window : null
}

/** The link with `from=scorer` added (before any #hash). */
export function withFromScorer(url) {
  const [path, hash = ''] = String(url).split('#')
  const sep = path.includes('?') ? '&' : '?'
  return `${path}${sep}${FROM_PARAM}=${FROM_SCORER}${hash ? `#${hash}` : ''}`
}

/**
 * Where "Back to scorer" goes from a dashboard on this host: the scorer's own
 * site for a role's site on *.openvolley.app or its Pages project
 * (<prefix>referee.openvolley.app -> <prefix>app.openvolley.app), else the
 * root of the same server (the app, a relay, the dev server).
 */
export function scorerHomeFor(hostname) {
  const host = String(hostname || '').toLowerCase()
  const sub = host.match(/^([a-z0-9-]*?)(referee|bench|livescore)\.openvolley\.app$/)
  if (sub) return `https://${sub[1]}app.openvolley.app/`
  const pages = host.match(/^(?:([a-z0-9-]+)\.)?openvolley-(referee|bench|livescore)\.pages\.dev$/)
  if (pages) return `https://${pages[1] ? `${pages[1]}.` : ''}openvolley-app.pages.dev/`
  return '/'
}

/**
 * On a dashboard page (referee, bench, livescore entries): note that it was
 * opened from the scorer (`from=scorer`), for the rest of the tab's life.
 */
export function captureScorerReturn({ win = safeWindow(), storage = globalThis.sessionStorage } = {}) {
  if (!win || isScorerEntry()) return
  try {
    const params = new URLSearchParams(win.location?.search || '')
    if (params.get(FROM_PARAM) !== FROM_SCORER) return
    storage?.setItem(RETURN_KEY, scorerHomeFor(win.location?.hostname))
  } catch {
    // storage blocked: no way back shown, the page still works
  }
}

/** Where "Back to scorer" goes, or null when this page was not opened from the scorer. */
export function scorerReturnUrl({ storage = globalThis.sessionStorage } = {}) {
  if (isScorerEntry()) return null
  try {
    const url = storage?.getItem(RETURN_KEY)
    // Only the two forms scorerHomeFor writes: the same server's root or an
    // OpenVolley site. Anything else in storage is ignored.
    if (url === '/' || /^https:\/\/[a-z0-9.-]+\.(openvolley\.app|pages\.dev)\/$/.test(url || '')) return url
  } catch {
    // storage blocked
  }
  return null
}

/** Leave the dashboard for the scorer's Home. */
export function returnToScorer({ win = safeWindow(), storage = globalThis.sessionStorage } = {}) {
  const url = scorerReturnUrl({ storage })
  if (!url) return false
  try { storage?.removeItem(RETURN_KEY) } catch { /* storage blocked */ }
  reloadWithReason('back-to-scorer', { how: 'assign', url, win })
  return true
}
