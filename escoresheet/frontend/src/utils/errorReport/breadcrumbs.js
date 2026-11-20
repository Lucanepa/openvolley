/**
 * The steps before an error (an error report's breadcrumbs): the last 20 of
 * screens opened, buttons tapped, requests made, connection changes. A button
 * is named by its test id, id or role, **never by its text** (it can be a
 * player's name); a request by its method, path (ids masked, no query, no
 * host for the app's own backend), status, time and request id. Nothing typed.
 */
export const MAX_CRUMBS = 20

let ring = []
let installed = false

const now = () => new Date().toISOString()

/** Adds one step: c = nav | click | fetch | sync | net | app | error, m = the line, d = small data. */
export function recordCrumb(c, m, d) {
  if (!m) return
  ring.push({ t: now(), c, m: String(m).slice(0, 160), ...(d ? { d } : {}) })
  if (ring.length > MAX_CRUMBS) ring = ring.slice(-MAX_CRUMBS)
}

/** A copy of the steps, oldest first. */
export const getCrumbs = () => ring.slice()

/** Tests only. */
export function resetCrumbs() {
  ring = []
}

/** A path with what changes masked: digits or long segments become :id, no query or hash. */
export function maskPath(path) {
  const p = String(path || '').split(/[?#]/)[0].slice(0, 200)
  return p.split('/').map((seg) => (/\d/.test(seg) || seg.length > 24 ? ':id' : seg)).join('/') || '/'
}

const CLICKABLE = 'button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="switch"], [role="option"], [role="checkbox"], input[type="checkbox"], input[type="radio"], select, [data-testid]'

/** What a tapped element is, without its text: "button[header-connect-tablets]", "tab#settings", "a". */
export function describeTarget(el) {
  const t = el?.closest?.(CLICKABLE)
  if (!t) return null
  const testId = t.getAttribute?.('data-testid')
  const role = t.getAttribute?.('role') || String(t.tagName || '').toLowerCase()
  const id = t.id && !/\d{3,}/.test(t.id) ? t.id : ''
  return `${role}${testId ? `[${String(testId).slice(0, 60)}]` : id ? `#${id.slice(0, 40)}` : ''}`
}

/**
 * Listens for taps, navigation, connection changes and requests (a wrapped
 * fetch that only observes: same arguments, same answer, same errors).
 * `ownOrigins`: the backend origins whose host is left out of the line.
 */
export function installBreadcrumbs({ win = typeof window !== 'undefined' ? window : undefined, ownOrigins = [], skipPaths = ['/api/errors'] } = {}) {
  if (!win || installed) return
  installed = true
  try {
    win.addEventListener('click', (e) => {
      const what = describeTarget(e.target)
      if (what) recordCrumb('click', what)
    }, { capture: true, passive: true })
    const nav = () => recordCrumb('nav', `${maskPath(win.location?.pathname)}${win.location?.hash ? maskPath(win.location.hash) : ''}`)
    win.addEventListener('hashchange', nav)
    win.addEventListener('popstate', nav)
    win.addEventListener('online', () => recordCrumb('net', 'online'))
    win.addEventListener('offline', () => recordCrumb('net', 'offline'))
  } catch { /* no window events */ }

  const orig = win.fetch
  if (typeof orig !== 'function' || orig.__ovCrumbs) return
  const own = new Set(ownOrigins.filter(Boolean))
  const wrapped = function (input, init) {
    let method = 'GET'
    let url = ''
    try {
      method = String(init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase()
      url = typeof input === 'string' ? input : input?.url || String(input)
    } catch { /* odd input */ }
    let line = null
    try {
      const u = new URL(url, win.location?.href)
      if (!skipPaths.includes(u.pathname)) {
        const host = own.has(u.origin) || u.origin === win.location?.origin ? '' : u.host
        line = `${method} ${host}${maskPath(u.pathname)}`
      }
    } catch { /* not a URL */ }
    const started = Date.now()
    const p = orig.apply(this, arguments)
    if (!line) return p
    return p.then((res) => {
      try {
        const rid = res.headers?.get?.('x-request-id')
        recordCrumb('fetch', `${line} ${res.status} ${Date.now() - started} ms`, rid ? { requestId: String(rid).slice(0, 32) } : undefined)
      } catch { /* headers unreadable */ }
      return res
    }, (err) => {
      recordCrumb('fetch', `${line} failed after ${Date.now() - started} ms`)
      throw err
    })
  }
  wrapped.__ovCrumbs = true
  try { win.fetch = wrapped } catch { /* read-only fetch */ }
}

/** Tests only. */
export function resetBreadcrumbsInstall() {
  installed = false
}
