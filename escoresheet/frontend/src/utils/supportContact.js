/**
 * The Support & feedback form's request: POST /api/contact on the cloud
 * backend (backend/lib/contact.js, the same contract as the
 * openvolley.app/support page), or a mailto to the support mailbox when
 * there is no backend or the request fails.
 *
 * - areas: the section ids of the help (helpSections.js: the "?" panel of
 *   each screen and openvolley.app/support), plus 'other'. The area names of
 *   older app versions and the help's screens map onto them (contactAreaOf),
 *   so a caller may pass either.
 * - attachments: checked here before the upload (count, 10 MB together, the
 *   kinds the backend takes); the backend checks again, by the bytes.
 * - diagnostics: only when the user ticks "Include diagnostics", and exactly
 *   what the dialog shows: app version, platform, display mode, screen size,
 *   online state, the open match's game number, and the last 20 console
 *   errors of the logger's buffer (utils/logger.js keeps them in the scorer
 *   app) with PIN-like numbers and URL queries removed.
 */
import { appVersion, platformName } from './identity'
import { getActiveMatch } from './activity/activeMatch'
import { getLogs } from './logger'
import { redactFreeText } from '../domain/activitySummary'
import { redactScreenText } from './screenText'
import { HELP_SCREENS, SECTION_IDS } from '../components/help/helpSections'

export const SUPPORT_EMAIL = 'support@openvolley.app'

export const SUPPORT_SECTIONS = Object.freeze([...SECTION_IDS])
export const CONTACT_AREAS = Object.freeze([...SUPPORT_SECTIONS, 'other'])

// Older area values (the form's own before the sections, and the pages of
// the contextual help before it had sections), as backend/lib/contact.js
// maps them
export const LEGACY_AREAS = Object.freeze({
  mainPage: 'home',
  header: 'home',
  options: 'home',
  matchSetup: 'setup',
  uploadRoster: 'setup',
  coinToss: 'coin-toss',
  scoreboard: 'scoring',
  approval: 'match-end',
  escoresheet: 'match-end',
  matchEnd: 'match-end',
  manualAdjustments: 'corrections',
  refereeDashboard: 'referee',
  benchDashboard: 'bench',
  livescore: 'livescore'
})

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)

/**
 * A section id (or 'other') for a section id, an older area / page name or a
 * help screen (its main section: liveCorrections -> corrections); '' for
 * anything else.
 */
export function contactAreaOf(raw) {
  if (typeof raw !== 'string' || !raw) return ''
  if (CONTACT_AREAS.includes(raw)) return raw
  if (own(LEGACY_AREAS, raw)) return LEGACY_AREAS[raw]
  return own(HELP_SCREENS, raw) ? HELP_SCREENS[raw].sections[0] : ''
}

export const MAX_FILES = 5
export const MAX_FILES_BYTES = 10 * 1024 * 1024
export const MAX_FILES_MB = MAX_FILES_BYTES / (1024 * 1024)
const FILE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'avif', 'pdf', 'txt', 'log', 'csv', 'json', 'ndjson'])
const FILE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic', 'image/heif', 'image/avif', 'application/pdf', 'text/plain', 'text/csv', 'application/json'])
/** For the file picker */
export const FILE_ACCEPT = 'image/*,.pdf,.txt,.log,.csv,.json,.ndjson'
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/

export const isContactEmail = (email) => typeof email === 'string' && email.length <= 254 && EMAIL.test(email.trim())

function extensionOf(name) {
  const s = String(name || '')
  const dot = s.lastIndexOf('.')
  return dot > 0 ? s.slice(dot + 1).toLowerCase() : ''
}

/** A kind of file the backend takes: by its extension, or its type when it has none. */
export function isAllowedFile(file) {
  const ext = extensionOf(file?.name)
  return ext ? FILE_EXTENSIONS.has(ext) : FILE_TYPES.has(String(file?.type || '').toLowerCase())
}

/**
 * Why these attachments cannot go, or null: { code: 'file_type', name } |
 * { code: 'too_many_files' } | { code: 'files_too_large' } (the backend's codes).
 */
export function checkFiles(files) {
  const list = Array.from(files || [])
  const bad = list.find((f) => !isAllowedFile(f))
  if (bad) return { code: 'file_type', name: bad.name }
  if (list.length > MAX_FILES) return { code: 'too_many_files' }
  if (list.reduce((n, f) => n + (f.size || 0), 0) > MAX_FILES_BYTES) return { code: 'files_too_large' }
  return null
}

/** The page the form is sent from, without query or fragment (tablet links carry ?pin=). */
export function pageUrl(win = typeof window !== 'undefined' ? window : undefined) {
  try {
    const l = win.location
    return `${l.protocol}//${l.host}${l.pathname}`
  } catch {
    return ''
  }
}

const URL_QUERY = /((?:https?|wss?):\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi
const MAX_ERRORS = 20
const MAX_ERROR_CHARS = 300

function readDisplayMode(storage) {
  try {
    return storage?.getItem('displayMode') || 'auto'
  } catch {
    return 'auto'
  }
}

/**
 * What "Include diagnostics" sends (and the dialog shows). gameNumber: the
 * caller's match, else the match open in the scorer app.
 */
export function collectDiagnostics({
  win = typeof window !== 'undefined' ? window : undefined,
  gameNumber,
  logs = getLogs(),
  storage = globalThis.localStorage
} = {}) {
  const active = getActiveMatch()
  const game = gameNumber ?? active?.gameN ?? null
  const errors = (Array.isArray(logs) ? logs : [])
    .filter((e) => e?.level === 'error')
    .slice(-MAX_ERRORS)
    .map((e) => {
      const text = redactScreenText(redactFreeText(String(e.message ?? ''))).replace(URL_QUERY, '$1')
      return `${e.timestamp || ''} ${text}`.trim().slice(0, MAX_ERROR_CHARS)
    })
  const out = {
    appVersion: appVersion(),
    platform: platformName(win),
    displayMode: readDisplayMode(storage),
    screen: win ? `${win.innerWidth}x${win.innerHeight}` : null,
    online: typeof navigator === 'undefined' || navigator.onLine !== false,
    gameNumber: game === '' ? null : game
  }
  if (errors.length) out.consoleErrors = errors
  return out
}

/**
 * The multipart body of POST /api/contact.
 * @param {{ contactType: string, area: string, supportType?: string, severity?: string|number,
 *   email: string, comments: string, files?: File[], diagnostics?: object|null, language?: string,
 *   win?: Window, now?: Date }} v
 */
export function buildContactForm(v) {
  const win = v.win ?? (typeof window !== 'undefined' ? window : undefined)
  const fd = new FormData()
  fd.append('contactType', v.contactType)
  fd.append('area', v.area)
  fd.append('supportType', v.supportType || '')
  fd.append('severity', v.severity ? String(v.severity) : '')
  fd.append('email', String(v.email || '').trim())
  fd.append('comments', v.comments)
  fd.append('source', 'app')
  fd.append('language', v.language || '')
  fd.append('appVersion', appVersion())
  fd.append('platform', platformName(win))
  fd.append('url', pageUrl(win))
  fd.append('userAgent', (typeof navigator !== 'undefined' && navigator.userAgent) || '')
  fd.append('timestamp', (v.now || new Date()).toISOString())
  if (v.diagnostics) fd.append('diagnostics', JSON.stringify(v.diagnostics))
  for (const file of v.files || []) fd.append('files', file, file.name)
  return fd
}

/**
 * mailto: to the support mailbox with the same fields (no attachments: a
 * mailto cannot carry them). labels: the translated values to show.
 */
export function contactMailto(v, labels = {}) {
  const subject = `[OpenVolley ${labels.type || v.contactType}] ${v.area}${labels.supportType ? ` - ${labels.supportType}` : ''}`
  const lines = [
    `Contact type: ${labels.type || v.contactType}`,
    `Area: ${labels.area || v.area} (${v.area})`,
    labels.supportType ? `Support type: ${labels.supportType}` : null,
    labels.severity ? `Severity: ${labels.severity}` : null,
    `From: ${String(v.email || '').trim()}`,
    `App version: ${appVersion()}`,
    `Page: ${pageUrl(v.win)}`,
    '',
    'Comments:',
    v.comments,
    v.diagnostics ? `\nDiagnostics: ${JSON.stringify(v.diagnostics)}` : null,
    v.files?.length ? `\n${v.files.length} file(s) to attach: ${v.files.map((f) => f.name).join(', ')}` : null
  ].filter((l) => l !== null)
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\n'))}`
}
