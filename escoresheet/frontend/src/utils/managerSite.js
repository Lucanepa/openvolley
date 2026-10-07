/**
 * manager.openvolley.app: the admin console and the competition manager as a
 * site of their own. The main app links to it from its manage console (web
 * only), and the manager links back to the scorer app.
 *
 * Both follow the deployment the page runs on, as cloudTabletBase does for
 * the tablets: a Cloudflare Pages preview (dev.openvolley-app.pages.dev)
 * links the preview of the other project, everything on *.openvolley.app the
 * production sites.
 */
import { detectAppPlatform } from './openAppWindow'

export const MANAGER_SITE_URL = 'https://manager.openvolley.app'
export const MAIN_APP_URL = 'https://app.openvolley.app'

const hostOf = (hostname) => String(hostname || '').toLowerCase()
const currentHost = () => (typeof window !== 'undefined' ? window.location.hostname : '')

/**
 * The same Pages label in another project: <label>.openvolley-<from>.pages.dev
 * -> https://<label>.openvolley-<to>.pages.dev. A per-deployment hash (8 hex)
 * exists only in its own project, so it maps to the production build.
 * @returns {string|null} null when the host is not a preview of `from`
 */
function pagesPeer(host, from, to) {
  const m = host.match(new RegExp(`^(?:([a-z0-9-]+)\\.)?openvolley-${from}\\.pages\\.dev$`))
  if (!m) return null
  const label = m[1] && !/^[0-9a-f]{8}$/.test(m[1]) ? `${m[1]}.` : ''
  return `https://${label}openvolley-${to}.pages.dev`
}

/**
 * Where the main app's console links to the manager site, or null when it
 * should not: in the desktop and Android apps (the console stays in-app
 * there), on the venue LAN server and in local development.
 * @param {string} [hostname]
 * @param {Window} [win]
 */
export function managerSiteUrl(hostname = currentHost(), win = typeof window !== 'undefined' ? window : undefined) {
  if (detectAppPlatform(win) !== 'web') return null
  if (win?.electronAPI) return null
  const host = hostOf(hostname)
  const preview = pagesPeer(host, 'app', 'manager')
  if (preview) return preview
  if (host === 'openvolley.app' || host.endsWith('.openvolley.app')) return MANAGER_SITE_URL
  return null
}

// The manager's page that creates an account (ManagerApp, hash route).
export const SIGN_UP_HASH = 'signup'

/**
 * Where the scorer apps send "Don't have an account?": accounts are made on
 * manager.openvolley.app only. Unlike managerSiteUrl this is never null: the
 * desktop and Android apps, the venue LAN server and local development link
 * the public site too (it needs internet, see signUpNeedsInternetNote). Only a
 * Cloudflare Pages preview of the app links the matching manager preview.
 * @param {string} [hostname]
 * @param {Window} [win]
 */
export function managerSignUpUrl(hostname = currentHost(), win = typeof window !== 'undefined' ? window : undefined) {
  const preview = detectAppPlatform(win) === 'web' ? pagesPeer(hostOf(hostname), 'app', 'manager') : null
  return `${preview || MANAGER_SITE_URL}/#${SIGN_UP_HASH}`
}

/**
 * Should the "create an account" link say it needs internet? Wherever the app
 * is not the public website (the desktop and Android apps, the venue LAN
 * server, local development) and on a device that is offline right now.
 * @param {string} [hostname]
 * @param {Window} [win]
 */
export function signUpNeedsInternetNote(hostname = currentHost(), win = typeof window !== 'undefined' ? window : undefined) {
  if (win?.navigator?.onLine === false) return true
  return managerSiteUrl(hostname, win) === null
}

/**
 * Where the manager links back to the scorer app: the production app, the
 * matching Pages preview, or this origin in local development (vite serves
 * both pages there).
 * @param {string} [hostname]
 * @param {string} [origin]
 */
export function mainAppUrl(hostname = currentHost(), origin = typeof window !== 'undefined' ? window.location.origin : '') {
  const host = hostOf(hostname)
  const preview = pagesPeer(host, 'manager', 'app')
  if (preview) return `${preview}/`
  if (host === 'localhost' || host === '127.0.0.1') return `${origin}/`
  return `${MAIN_APP_URL}/`
}
