/**
 * Every reload or location change the app itself makes goes through here
 * with a reason, so the log tells an app reload (an update, Clear cache, a
 * restored backup, the error screen) from one nobody asked for (the service
 * worker, the webview, the OS):
 *
 *   reloadWithReason('sw-update', { how: 'replace', url: buildReloadUrl() })
 *
 * With diagnostics on, a `page.reload_request` line is written and the reason
 * is kept in sessionStorage for the next load's `page.load` line (`prev`).
 * With it off this is just the location call.
 */
import { diag, diagActive, stashAndFlush } from './recorder'

export const RELOAD_REASON_KEY = 'ov.diagnostics.reloadReason'

const bare = (url) => (typeof url === 'string' ? url.split(/[?#]/)[0] : null)

/**
 * @param {string} reason a short fixed name ('sw-update', 'clear-cache', 'error-screen', ...)
 * @param {{ how?: 'reload'|'replace'|'assign'|'href', url?: string, win?: Window, storage?: Storage }} [opts]
 */
export function reloadWithReason(reason, { how = 'reload', url, win = typeof window !== 'undefined' ? window : undefined, storage = globalThis.sessionStorage } = {}) {
  if (diagActive()) {
    const at = Date.now()
    diag('page.reload_request', { reason, how, url: bare(url) })
    try { storage?.setItem(RELOAD_REASON_KEY, JSON.stringify({ reason, how, at })) } catch { /* storage blocked */ }
    stashAndFlush()
  }
  const loc = win?.location
  if (!loc) return
  if (how === 'replace') loc.replace(url)
  else if (how === 'assign') loc.assign(url)
  else if (how === 'href') loc.href = url
  else loc.reload()
}

/** The reason the previous load of this tab gave for reloading (once), or null. */
export function takeReloadReason(storage = globalThis.sessionStorage, now = Date.now()) {
  try {
    const raw = storage?.getItem(RELOAD_REASON_KEY)
    if (!raw) return null
    storage.removeItem(RELOAD_REASON_KEY)
    const r = JSON.parse(raw)
    return { reason: String(r.reason || ''), how: r.how || null, agoMs: Number.isFinite(r.at) ? now - r.at : null }
  } catch {
    return null
  }
}
