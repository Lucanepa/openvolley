/**
 * The error reporter: every page and app reports its errors to the backend's
 * error tracker (POST /api/errors, lib/errorTracker.js, db/050), signed in or
 * not (privacy policy 1.22, section 5). The owner gets a digest by mail, push
 * and the manager's bell, and triages them in the manager's Errors tab.
 *
 *   import './utils/errorReport/boot'         first import of every entry (installs it)
 *   setErrorTool(tool, product)               the entry names its tool exactly
 *   installErrorReporter({ tool, product })   (boot.js calls it)
 *   reportError(err, { kind, level, view, data, source, componentStack })
 *   setErrorView(view)                        the screen / page now open
 *   setErrorMatch(externalId)                 the match now open (or null)
 *   errorReportsEnabled() / setErrorReportsEnabled(on)   the switch in Support and feedback
 *
 * Caught: window errors (and scripts / images that fail to load, as
 * warnings), unhandled promise rejections, render crashes (ErrorBoundary),
 * and from the activity bus a failed backup (error) and a dropped upload
 * (warning). Noise is dropped or demoted (classify.js). The same message at
 * most 5 times in 10 minutes. Never throws, never blocks.
 */
import { staticContext, liveContext } from './context'
import { classifyError, isAutomatedVisit } from './classify'
import { installBreadcrumbs, recordCrumb, getCrumbs, maskPath } from './breadcrumbs'
import { createTransport, errorReportsEnabled, setErrorReportsEnabled } from './transport'
import { getCloudApiUrl, getCloudApiBaseUrl } from '../backendConfig'
import { setErrorTap } from '../activity/bus'
import { randomUuid } from '../deviceId'

export { errorReportsEnabled, setErrorReportsEnabled, recordCrumb }

const REPEAT_MAX = 5
const REPEAT_WINDOW_MS = 10 * 60 * 1000
const SESSION_KEY = 'api_auth_token' // lib/apiClient AUTH_TOKEN_STORAGE_KEY

let ctx = null
let transport = null
let view = null
let matchExt = null
let unloading = false
// the window's listeners are added once (they report through whatever ctx is current)
const listening = new WeakSet()
const seen = new Map() // message -> { at, count }

/** The Bearer header of the stored session, if any (lib/apiClient's, read without importing it). */
function authHeader() {
  try {
    const s = JSON.parse(globalThis.localStorage?.getItem(SESSION_KEY) || 'null')
    if (!s?.access_token) return {}
    if (s.expires_at && Date.now() / 1000 > s.expires_at) return {}
    return { Authorization: `Bearer ${s.access_token}` }
  } catch {
    return {}
  }
}

function allowed(message) {
  const key = String(message || '').slice(0, 120)
  const t = Date.now()
  const s = seen.get(key)
  if (!s || t - s.at > REPEAT_WINDOW_MS) {
    seen.set(key, { at: t, count: 1 })
    if (seen.size > 100) seen.delete(seen.keys().next().value)
    return true
  }
  s.count++
  return s.count <= REPEAT_MAX
}

/** Stack lines without the page's origin or a query; the first ("TypeError: …") left out. */
export function framesOf(stack) {
  if (typeof stack !== 'string') return []
  return stack.split('\n')
    .map((l) => l.trim().replace(/^at\s+/, '').replace(/(https?|capacitor|tauri|file):\/\/[^/\s)]*/g, '').replace(/\?[^\s:)]*/g, ''))
    .filter((l) => l && !/^\w*Error\b/.test(l) && !/^(Uncaught|Error:)/.test(l))
    .slice(0, 20)
    .map((l) => l.slice(0, 200))
}

function lastRequestId() {
  const crumbs = getCrumbs()
  for (let i = crumbs.length - 1; i >= 0; i--) {
    const c = crumbs[i]
    if (c.d?.requestId && Date.now() - Date.parse(c.t) < 10000) return c.d.requestId
  }
  return null
}

/**
 * Reports one error (also what a page catches itself and wants to know about).
 * @param {unknown} err an Error, or a message
 * @param {{ kind?: string, level?: 'warn'|'error', view?: string, data?: object, source?: string, componentStack?: string, requestId?: string }} [opts]
 */
export function reportError(err, opts = {}) {
  try {
    if (!ctx || !transport || !errorReportsEnabled()) return null
    const e = err instanceof Error ? err : null
    const message = String(e ? e.message : (typeof err === 'string' ? err : err?.message ?? err ?? '')) || '(no message)'
    const name = e?.name && e.name !== 'Error' ? e.name : (e ? 'Error' : null)
    const live = liveContext()
    const verdict = classifyError({ message, name: e?.name, source: opts.source, stack: typeof e?.stack === 'string' ? e.stack : '', kind: opts.kind || 'app.error', online: live.online, unloading, automated: isAutomatedVisit() })
    if (verdict.action === 'drop') return null
    if (!allowed(message)) return null
    const level = opts.level === 'warn' || verdict.level === 'warn' ? 'warn' : 'error'
    const data = { ...(opts.data || {}) }
    if (opts.componentStack) data.componentStack = String(opts.componentStack).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 8).join(' < ').slice(0, 400)
    if (opts.source) data.source = String(opts.source).slice(0, 120)
    const event = {
      uid: randomUuid(),
      client_ts: new Date().toISOString(),
      kind: verdict.kind,
      level,
      ...ctx,
      ...live,
      view: opts.view || view || maskPath(globalThis.location?.pathname),
      match_external_id: matchExt,
      request_id: [opts.requestId, lastRequestId()].find((r) => typeof r === 'string' && /^[0-9a-f]{6,32}$/i.test(r)) || null,
      error_name: name && /^[A-Za-z_$][\w$.]{0,79}$/.test(name) ? name : null,
      message: message.slice(0, 2000),
      frames: framesOf(e?.stack),
      breadcrumbs: getCrumbs(),
      data
    }
    transport.enqueue(event)
    recordCrumb('error', `${name ? name + ': ' : ''}${message}`.slice(0, 160))
    return event
  } catch {
    return null
  }
}

/** The entry names its tool (and product) exactly; boot.js only guessed it from the address. */
export function setErrorTool(tool, product) {
  if (!ctx) return
  if (typeof tool === 'string' && tool) ctx = { ...ctx, tool }
  if (product === 'openvolley' || product === 'openbeach') ctx = { ...ctx, product }
}

/** The screen or page now open (the scorer has no router: App.jsx calls this). */
export function setErrorView(next) {
  const v = next ? String(next).slice(0, 120) : null
  if (v && v !== view) recordCrumb('nav', v)
  view = v
}

/** The match now open on this device (its external id), or null. */
export function setErrorMatch(externalId) {
  matchExt = typeof externalId === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(externalId) ? externalId : null
}

/**
 * First thing in every entry (before React renders).
 * @param {{ tool: string, product?: 'openvolley'|'openbeach', win?: Window }} o
 */
export function installErrorReporter({ tool, product = 'openvolley', win = typeof window !== 'undefined' ? window : undefined } = {}) {
  if (ctx || !win) return
  try {
    ctx = staticContext({ tool, product, win })
    transport = createTransport({ url: () => getCloudApiUrl('/api/errors'), authHeader })
    installBreadcrumbs({ win, ownOrigins: [safe(() => new URL(getCloudApiBaseUrl()).origin)] })

    if (listening.has(win)) { setTimeout(() => { void transport.flush() }, 3000); return }
    listening.add(win)
    win.addEventListener('error', (ev) => {
      const t = ev?.target
      // a script, stylesheet or image that failed to load (capture phase only)
      if (t && t !== win && (t.src || t.href) && !ev.error) {
        const tag = String(t.tagName || 'resource').toLowerCase()
        // a help video or a sound that does not load is no bug of the app
        if (/^(video|audio|source|track)$/.test(tag)) return
        reportError(`failed to load ${tag} ${maskPath(safe(() => new URL(t.src || t.href).pathname))}`, { kind: 'resource.error', level: 'warn' })
        return
      }
      reportError(ev?.error || ev?.message || 'error', { kind: 'js.error', source: ev?.filename })
    }, true)
    win.addEventListener('unhandledrejection', (ev) => {
      const r = ev?.reason
      reportError(r instanceof Error ? r : String(r?.message || r || 'unhandled rejection'), { kind: 'js.unhandledrejection' })
    })
    const leave = () => { transport.flushOnExit() }
    win.addEventListener('pagehide', () => { unloading = true; leave() })
    win.addEventListener('pageshow', () => { unloading = false })
    win.document?.addEventListener?.('visibilitychange', () => { if (win.document.visibilityState === 'hidden') leave() })

    // From the activity bus: a failed backup (error), an upload given up (warning)
    setErrorTap((kind, data = {}, opts = {}) => {
      if (kind === 'backup.error') reportError(String(data?.message || 'backup failed'), { kind: 'backup.error' })
      else if (kind === 'sync.dropped') {
        reportError(`sync dropped: ${[data?.resource, data?.action, data?.status, data?.code].filter((x) => x != null && x !== '').join(' ')}`, {
          // a refused approval PDF is an error (useSyncQueue isRefusedApprovalPdf, LOG-10), any other drop a warning
          kind: 'sync.dropped', level: opts?.level === 'error' ? 'error' : 'warn', requestId: typeof data?.requestId === 'string' ? data.requestId : undefined,
          data: { resource: data?.resource ?? null, action: data?.action ?? null, status: data?.status ?? null, code: data?.code ?? null, attempt: data?.attempt ?? null }
        })
      }
      if (opts?.matchExt) setErrorMatch(opts.matchExt)
    })

    // what an earlier visit could not send
    setTimeout(() => { void transport.flush() }, 3000)
  } catch { /* the reporter never stops a page */ }
}

function safe(fn) {
  try { return fn() } catch { return null }
}

/** Tests only. */
export function resetErrorReporter() {
  ctx = null
  transport = null
  view = null
  matchExt = null
  unloading = false
  seen.clear()
}
