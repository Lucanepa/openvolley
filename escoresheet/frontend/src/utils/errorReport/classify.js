/**
 * Which errors are worth a report, and how loud (svrz_rc's lesson: most of the
 * work was demoting false alarms, so it is built in from the start).
 *
 *   drop   not reported at all (the browser's own noise, a script a browser
 *          extension injected, a page that is going away)
 *   warn   stored, never alerted: the network, a cancelled request, an old
 *          bundle after a deploy, an opaque cross-origin "Script error.", an
 *          automated visitor
 *   error  stored and alerted
 */

const NOISE = [
  /ResizeObserver loop (limit exceeded|completed with undelivered notifications)/i,
  /^Script error\.?$/i,
  // Safari / WebKit: a request cancelled because the page navigated
  /^cancelled$/i,
  /Non-Error promise rejection captured with value: (undefined|Object Not Found Matching Id)/i
]

const NETWORK = [
  /Failed to fetch/i,
  /NetworkError when attempting to fetch resource/i,
  /Load failed$/i,
  /The network connection was lost/i,
  /network error/i,
  /Network request failed/i,
  /ERR_(INTERNET_DISCONNECTED|NETWORK_CHANGED|CONNECTION_(RESET|REFUSED|CLOSED|TIMED_OUT)|NAME_NOT_RESOLVED)/,
  /timeout of \d+ms exceeded/i,
  /The operation timed out/i
]

const STALE_CHUNK = [
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /Importing a module script failed/i,
  /Unable to preload CSS/i,
  /'text\/html' is not a valid JavaScript MIME type/i
]

const ABORT = /AbortError|The (operation|user) (was|aborted)|aborted a request|signal is aborted/i

// A script the page did not ship: an extension, an injected helper
const FOREIGN_SOURCE = /^(chrome|moz|safari|safari-web)-extension:|^webkit-masked-url:|^(chrome|edge):\/\/|\/inject|userscript/i

// Google's page renderer for its crawler (the Web Rendering Service) stubs the
// browser's APIs: its navigator.serviceWorker.register rejects with "Rejected"
// (registerSW.js, 21.11.2026, reported as a guest on Android 10 / Chrome 138).
// No person ever sees it.
const GOOGLE_RENDERER = /\bwrsParams\b/

/** Is this visit a robot (a crawler, a test runner, a link preview)? */
export function isAutomatedVisit(win = typeof window !== 'undefined' ? window : undefined) {
  try {
    const nav = win?.navigator || {}
    if (nav.webdriver === true) return true
    return /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|whatsapp/i.test(String(nav.userAgent || ''))
  } catch {
    return false
  }
}

/**
 * @param {{ message?: string, name?: string, source?: string, stack?: string, kind: string, online?: boolean|null, unloading?: boolean, automated?: boolean }} e
 * @returns {{ action: 'drop'|'report', level: 'warn'|'error', kind: string }}
 */
export function classifyError({ message = '', name = '', source = '', stack = '', kind, online = null, unloading = false, automated = false }) {
  const msg = String(message || '')
  if (unloading) return { action: 'drop', level: 'warn', kind }
  if (GOOGLE_RENDERER.test(String(stack || ''))) return { action: 'drop', level: 'warn', kind }
  if (source && FOREIGN_SOURCE.test(String(source))) return { action: 'drop', level: 'warn', kind }
  if (NOISE.some((re) => re.test(msg))) {
    // an opaque "Script error." is kept as a warning (its count says something), the rest dropped
    return /^Script error/i.test(msg) ? { action: 'report', level: 'warn', kind } : { action: 'drop', level: 'warn', kind }
  }
  if (STALE_CHUNK.some((re) => re.test(msg))) return { action: 'report', level: 'warn', kind: 'chunk.stale' }
  if (ABORT.test(msg) || name === 'AbortError') return { action: 'drop', level: 'warn', kind }
  if (NETWORK.some((re) => re.test(msg)) || online === false) return { action: 'report', level: 'warn', kind: kind === 'js.unhandledrejection' ? 'net.fail' : kind }
  if (automated) return { action: 'report', level: 'warn', kind }
  return { action: 'report', level: 'error', kind }
}
