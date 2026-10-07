/**
 * The one-time links of the account emails (backend lib/mailer.js):
 *
 *   https://manager.openvolley.app/#reset?token=<43 chars>&lang=de
 *   https://manager.openvolley.app/#confirm?token=<43 chars>
 *
 * The token sits in the URL fragment, so it never reaches a server log. It is
 * read once, before React renders (manager-main.jsx), and removed from the
 * address bar and the history entry at once (history.replaceState), so it is
 * not left in the history, a bookmark, a screenshot of the address bar or a
 * crash report. It is never logged and never sent anywhere but to
 * /api/auth/reset-password/confirm or /api/auth/confirm-email.
 */

export const AUTH_LINK_PAGES = Object.freeze(['reset', 'confirm'])
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const LANGS = ['en', 'de', 'fr', 'it']

/**
 * Parses an auth link out of a location hash. Pure.
 * -> { page: 'reset' | 'confirm', token: string | null, lang: string | null } or null
 * (token null: the link was cut or garbled, the page shows "invalid link").
 */
export function parseAuthLinkHash(hash) {
  const m = /^#?(reset|confirm)(?:\?(.*))?$/.exec(String(hash || ''))
  if (!m) return null
  let params
  try { params = new URLSearchParams(m[2] || '') } catch { params = new URLSearchParams() }
  const token = params.get('token')
  const lang = (params.get('lang') || '').toLowerCase()
  return {
    page: m[1],
    token: token && TOKEN_RE.test(token) ? token : null,
    lang: LANGS.includes(lang) ? lang : null
  }
}

/**
 * Reads the auth link from window.location and strips the fragment (keeps
 * path and query). Returns the parsed link or null. Call once, at start-up.
 */
export function takeAuthLinkFromLocation(win = typeof window !== 'undefined' ? window : null) {
  if (!win?.location) return null
  const link = parseAuthLinkHash(win.location.hash)
  if (!link) return null
  try {
    const { pathname, search } = win.location
    win.history.replaceState(null, '', `${pathname}${search}`)
  } catch {
    // No history API: at least drop the fragment (this adds no entry).
    try { win.location.hash = '' } catch { /* nothing else to do */ }
  }
  return link
}
