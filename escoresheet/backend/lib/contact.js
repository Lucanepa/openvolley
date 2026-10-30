/**
 * lib/contact.js — the support form, POST /api/contact: the app's Support &
 * feedback dialog and the openvolley.app/support page send it. Its body, its
 * checks, and the ONE mail it sends: to the support mailbox (CONTACT_EMAIL),
 * which FreeScout (support.openvolley.app) reads.
 *
 * Body: multipart/form-data (JSON without files is still read):
 *   contactType  support | feedback | request                     required
 *   email        the user's address: the mail's Reply-To          required
 *   comments     the message                                      required
 *   area         a section id of the help (SECTION_IDS) or 'other';
 *                the app's older area names are mapped (LEGACY_AREAS)
 *   supportType  bug | help        severity  1-4 (support only)
 *   matchRunning "1": a match is being scored right now (the app ticks it
 *                when this device scores one); anything else: not
 *   source       app | website     language, appVersion, platform, url,
 *                userAgent, timestamp: context, each checked against a
 *                pattern (url loses its query and fragment: ?pin=)
 *   diagnostics  JSON text, at most 32 KB: the short diagnostics of the app
 *                versions before the report (still read); sent only with the
 *                user's consent
 *   diagnosticsFile  the app's diagnostics report (utils/diagnosticsReport.js),
 *                sent only when the user leaves "Include diagnostics" ticked:
 *                one UTF-8 text part without NUL, at most 3 MB, named
 *                openvolley-diagnostics-<date>[-g<game>].txt. Not one of the
 *                5 files and not part of their 10 MB; attached to the mail as
 *                .txt, with a "Diagnostics: attached (N lines, X KB)" row
 *   website      a honeypot: filled in (a bot), the answer is the same 200
 *                and nothing is sent
 *   files        0-5 attachments, 10 MB together: images (PNG, JPEG, GIF,
 *                WebP, HEIC/HEIF, AVIF), PDF, text (txt, log, csv) and JSON,
 *                told apart by their first bytes (sniffFile), never by the
 *                name or the client's Content-Type alone
 *
 * The mail: From MAIL_FROM (the account mailbox of lib/mailer.js), To
 * CONTACT_EMAIL, Reply-To the user, the attachments, the priority
 * (priorityOf: P1-P4) in the subject, in the X-OpenVolley-Priority header
 * and as the body's first line. The subject holds no text the user typed,
 * only the priority, the area and the type ("[P2] [scoring] Support – Bug
 * report"): FreeScout's auto reply can quote the subject to the Reply-To
 * address, which nobody has verified. FreeScout takes the
 * customer of an incoming mail from Reply-To when it has one, else From
 * (app/Console/Commands/FetchEmails.php, processMessage), so the user becomes
 * the ticket's customer and the agents' replies go to them. The mail carries
 * no Auto-Submitted or Precedence header: FreeScout reads either as an
 * auto-responder (MailHelper::isAutoResponder) and would then skip the
 * mailbox's auto reply, which is the user's acknowledgement now (the backend
 * no longer mails the user). The recipient is fixed, so the route relays to
 * nobody and needs no SMTP_LEGACY_ROUTES.
 *
 * Volume: the route's per-IP limit (server.js) and CONTACT_MAILS_PER_HOUR
 * for all senders together, so the form cannot use up the mailbox's sending
 * quota that the account mails need. Memory: at most MAX_CONTACT_IN_FLIGHT
 * requests at once (createContactSlots), each with up to 14 MB of body; the
 * next one gets the same 503 busy as a used-up budget.
 *
 * Public API:
 *   handleContact({ body, contentType, mailer, logger, now }) -> Promise<{ status, body }>  never throws
 *   parseContactBody(buffer, contentType) -> { fields, files, diagnosticsFile? }   (throws ContactError)
 *   parseMultipart(buffer, contentType, limits) -> { fields, files, diagnosticsFile? }
 *   checkDiagnosticsFile(part) -> { filename, mime, data, lines } | null  (throws ContactError)
 *   normalizeContact(fields) -> the checked values      (throws ContactError)
 *   checkAttachments(files) -> [{ filename, mime, data }] (throws ContactError)
 *   sniffFile(data, filename) -> { mime, ext } | null
 *   priorityOf(value) -> { level: 'P1'|'P2'|'P3'|'P4', reason }
 *   supportSubject(value) -> "[P1 – match running] [scoring] Support – Bug report"
 *   buildSupportMail(value, attachments, { receivedAt, diagnosticsFile }) -> nodemailer message (no from / to)
 *   createContactMailer({ transport, from, to, maxPerHour }) / contactMailerFromEnv(env) / disabledContactMailer(reason)
 *   createContactSlots(max) -> { run(work) -> Promise | null, inFlight, max }: MAX_CONTACT_IN_FLIGHT at once
 */

import nodemailer from 'nodemailer'
import { transportOptions, maskEmail, describeMailError, DEFAULT_FROM_NAME } from './mailer.js'

export const DEFAULT_CONTACT_EMAIL = 'support@openvolley.app'
export const CONTACT_TYPES = Object.freeze(['support', 'feedback', 'request'])
export const SUPPORT_TYPES = Object.freeze(['bug', 'help'])
export const SOURCES = Object.freeze(['app', 'website'])

// The sections of the help (the "?" panel of each screen, openvolley.app/support).
export const SECTION_IDS = Object.freeze([
  'home', 'setup', 'coin-toss', 'scoring', 'subs-timeouts', 'sanctions', 'set-end', 'match-end',
  'corrections', 'connections', 'referee', 'bench', 'livescore', 'handover', 'sync-offline', 'install-updates'
])
export const CONTACT_AREAS = Object.freeze([...SECTION_IDS, 'other'])
// The names in the mail body (the subject keeps the id)
export const SECTION_NAMES = Object.freeze({
  home: 'Home',
  setup: 'Match setup',
  'coin-toss': 'Coin toss',
  scoring: 'Scoring',
  'subs-timeouts': 'Substitutions, time-outs, libero',
  sanctions: 'Sanctions',
  'set-end': 'Set end, interval, set 5',
  'match-end': 'Match end',
  corrections: 'Manual adjustments, corrections',
  connections: 'Connecting tablets',
  referee: 'Referee tablet',
  bench: 'Bench tablet',
  livescore: 'Livescore, remote scoreboard',
  handover: 'Continuing on another device',
  'sync-offline': 'Online, offline, sync',
  'install-updates': 'Installing, updates',
  other: 'Other'
})
// Area names of app versions before the sections, and the pages of the
// contextual help before it had sections (helpContent.js)
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

const TYPE_LABELS = Object.freeze({ support: 'Support', feedback: 'Feedback', request: 'Request' })
const SUPPORT_TYPE_LABELS = Object.freeze({ bug: 'Bug report', help: 'Help / question' })
const SEVERITY_LABELS = Object.freeze({
  1: '1 - Tool breaks completely',
  2: '2 - Very limited functionality',
  3: '3 - Inconvenience',
  4: '4 - Nice-to-have'
})

// Limits. The body may be the files, the diagnostics report and 1 MB of
// fields and multipart framing.
export const MAX_FILES = 5
export const MAX_FILES_BYTES = 10 * 1024 * 1024
// The app's report is at most 2 MB (utils/diagnosticsReport REPORT_MAX_BYTES)
export const MAX_DIAGNOSTICS_FILE_BYTES = 3 * 1024 * 1024
export const DIAGNOSTICS_FILE_FIELD = 'diagnosticsFile'
export const MAX_CONTACT_BODY_BYTES = MAX_FILES_BYTES + MAX_DIAGNOSTICS_FILE_BYTES + 1024 * 1024
export const MAX_PARTS = 30
export const MAX_FIELD_BYTES = 64 * 1024
const MAX_PART_HEADER_BYTES = 2048
export const MAX_COMMENTS = 5000
export const MAX_DIAGNOSTICS_BYTES = 32 * 1024
export const CONTACT_MAILS_PER_HOUR = 30
const HOUR_MS = 60 * 60 * 1000
// Requests in flight at once (createContactSlots): each holds its body, up to
// MAX_CONTACT_BODY_BYTES, in memory for up to 2 minutes, so 10 hold 140 MB
export const MAX_CONTACT_IN_FLIGHT = 10

/** A rejected request: status and code for the answer, message for people. */
export class ContactError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

/** The boundary of a multipart/form-data Content-Type, or null. */
export function boundaryOf(contentType) {
  const ct = String(contentType || '')
  if (!/^\s*multipart\/form-data\s*(;|$)/i.test(ct)) return null
  const m = /;\s*boundary\s*=\s*(?:"([^"]{1,70})"|([^\s;"]{1,70}))/i.exec(ct)
  return m ? (m[1] ?? m[2]) : null
}

/** The parameters of a Content-Disposition value (lower-case names, quotes undone). */
function dispositionParams(value) {
  const out = {}
  const re = /;\s*([A-Za-z0-9!#$%&'*+.^_`|~-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]*))/g
  let m
  while ((m = re.exec(value))) {
    const key = m[1].toLowerCase()
    if (!(key in out)) out[key] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3]
  }
  return out
}

function partHeaders(text) {
  const headers = {}
  for (const line of text.split('\r\n')) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const name = line.slice(0, colon).trim().toLowerCase()
    if (!(name in headers)) headers[name] = line.slice(colon + 1).trim()
  }
  return headers
}

const malformed = () => new ContactError(400, 'invalid_body', 'Malformed form data')

/**
 * A multipart/form-data body (RFC 7578) held in memory: parts with a filename
 * are files ({ field, filename, contentType, data }; empty ones are left
 * out), the others fields (UTF-8, the first of a repeated name wins). The
 * part named DIAGNOSTICS_FILE_FIELD (with a filename or without) is the
 * diagnostics report, returned as diagnosticsFile (the first one; not a file
 * and not counted with them, at most maxDiagnosticsBytes: 413
 * diagnostics_too_large). Stops at the limits instead of reading on:
 * MAX_PARTS parts, MAX_FIELD_BYTES per field, maxFiles files (400) and
 * maxFilesBytes together (413).
 */
export function parseMultipart(buffer, contentType, {
  maxParts = MAX_PARTS, maxFieldBytes = MAX_FIELD_BYTES, maxFiles = MAX_FILES, maxFilesBytes = MAX_FILES_BYTES,
  maxDiagnosticsBytes = MAX_DIAGNOSTICS_FILE_BYTES
} = {}) {
  const boundary = boundaryOf(contentType)
  if (!boundary) throw new ContactError(400, 'invalid_body', 'Expected multipart/form-data')
  const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '')
  const open = Buffer.from(`--${boundary}`)
  const delimiter = Buffer.from(`\r\n--${boundary}`)
  let pos
  if (body.subarray(0, open.length).equals(open)) {
    pos = open.length
  } else {
    // a preamble before the first boundary
    const first = body.indexOf(delimiter)
    if (first < 0) throw malformed()
    pos = first + delimiter.length
  }
  const fields = {}
  const files = []
  let diagnosticsFile = null
  let parts = 0
  let filesBytes = 0
  for (;;) {
    // "--" closes the body; else transport padding and CRLF, then a part
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break
    while (body[pos] === 0x20 || body[pos] === 0x09) pos++
    if (body[pos] !== 0x0d || body[pos + 1] !== 0x0a) throw malformed()
    pos += 2
    const headEnd = body.indexOf('\r\n\r\n', pos)
    if (headEnd < 0 || headEnd - pos > MAX_PART_HEADER_BYTES) throw malformed()
    const end = body.indexOf(delimiter, headEnd + 4)
    if (end < 0) throw malformed()
    if (++parts > maxParts) throw new ContactError(400, 'too_many_parts', 'Too many form fields')
    const headers = partHeaders(body.toString('utf8', pos, headEnd))
    const disposition = headers['content-disposition'] || ''
    if (!/^form-data\s*(;|$)/i.test(disposition)) throw malformed()
    const params = dispositionParams(disposition)
    const name = params.name
    if (typeof name !== 'string' || name === '') throw malformed()
    const data = body.subarray(headEnd + 4, end)
    let filename = params.filename
    const extended = /^utf-8''(.+)$/i.exec(params['filename*'] || '')
    if (extended) {
      try { filename = decodeURIComponent(extended[1]) } catch { /* keep the plain one */ }
    }
    if (name === DIAGNOSTICS_FILE_FIELD) {
      if (data.length > maxDiagnosticsBytes) throw new ContactError(413, 'diagnostics_too_large', 'The diagnostics are too large', { maxBytes: maxDiagnosticsBytes })
      if (!diagnosticsFile && data.length > 0) diagnosticsFile = { filename: String(filename ?? ''), contentType: headers['content-type'] || '', data }
    } else if (filename !== undefined) {
      if (data.length > 0) {
        if (files.length >= maxFiles) throw new ContactError(400, 'too_many_files', `At most ${maxFiles} attachments`, { maxFiles })
        filesBytes += data.length
        if (filesBytes > maxFilesBytes) throw new ContactError(413, 'files_too_large', 'Attachments too large', { maxBytes: maxFilesBytes })
        files.push({ field: name, filename: String(filename), contentType: headers['content-type'] || '', data })
      }
    } else {
      if (data.length > maxFieldBytes) throw new ContactError(400, 'field_too_large', `Field ${name.slice(0, 40)} is too long`)
      if (!(name in fields)) fields[name] = data.toString('utf8')
    }
    pos = end + delimiter.length
  }
  return diagnosticsFile ? { fields, files, diagnosticsFile } : { fields, files }
}

/** The fields and files of a request body: multipart, or a JSON object (no files). */
export function parseContactBody(buffer, contentType) {
  if (boundaryOf(contentType)) return parseMultipart(buffer, contentType)
  if (/^\s*application\/json\s*(;|$)/i.test(String(contentType || ''))) {
    let parsed
    try { parsed = JSON.parse(Buffer.from(buffer || '').toString('utf8') || '{}') } catch { throw new ContactError(400, 'invalid_body', 'Invalid JSON') }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ContactError(400, 'invalid_body', 'Invalid JSON')
    const fields = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') fields[k] = String(v)
      else if (k === 'diagnostics' && v && typeof v === 'object') fields[k] = JSON.stringify(v)
    }
    return { fields, files: [] }
  }
  throw new ContactError(400, 'invalid_body', 'Expected multipart/form-data')
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

// Address: one @, a dot in the domain, nothing an address list or a display
// name could be read from (no comma, semicolon, brackets, quotes, spaces).
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/
// Control characters, bidi overrides and zero-width characters
const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g
const CONTROL_EXCEPT_NEWLINE_TAB = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g

export function isContactEmail(email) {
  return typeof email === 'string' && email.length <= 254 && EMAIL.test(email)
}

/** One header-safe line: no CR, LF or other control character, at most max characters. */
export function oneLine(value, max = 200) {
  if (value === undefined || value === null) return ''
  return String(value).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

/** Free text (the message): LF newlines, tabs kept, other control characters gone. */
function freeText(value, max) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(CONTROL_EXCEPT_NEWLINE_TAB, '').trim().slice(0, max)
}

/** A section id; the older names mapped; anything else 'other'. */
export function areaOf(raw) {
  const s = oneLine(raw, 40)
  if (CONTACT_AREAS.includes(s)) return s
  if (Object.prototype.hasOwnProperty.call(LEGACY_AREAS, s)) return LEGACY_AREAS[s]
  return 'other'
}

/** The page the form was sent from, without query or fragment (tablet links carry ?pin=). */
export function pageUrlOf(raw) {
  const s = oneLine(raw, 2000)
  if (!s) return ''
  try {
    const u = new URL(s)
    if (!['http:', 'https:', 'capacitor:', 'tauri:'].includes(u.protocol)) return ''
    return `${u.protocol}//${u.host}${u.pathname}`.slice(0, 300)
  } catch {
    return ''
  }
}

const pick = (value, re, max) => {
  const s = oneLine(value, max)
  return re.test(s) ? s : ''
}

/** Diagnostics as the body shows them: indented JSON, or the text cut short when it is not JSON. */
function diagnosticsOf(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return null
  if (Buffer.byteLength(s, 'utf8') > MAX_DIAGNOSTICS_BYTES) throw new ContactError(400, 'field_too_large', 'Diagnostics are too long')
  try {
    return JSON.stringify(JSON.parse(s), null, 2).replace(CONTROL_EXCEPT_NEWLINE_TAB, '')
  } catch {
    return `(not JSON) ${freeText(s, 4000)}`
  }
}

/** The honeypot field: a person never sees or fills it. */
export function isHoneypotHit(fields) {
  return oneLine(fields?.website, 200) !== ''
}

/**
 * The checked values of a submission. Required (else 400): contactType,
 * a valid email, comments. The rest is optional; a value that does not fit
 * its pattern is left out rather than refused.
 */
export function normalizeContact(fields = {}) {
  const contactType = oneLine(fields.contactType, 20).toLowerCase()
  if (!CONTACT_TYPES.includes(contactType)) throw new ContactError(400, 'invalid_type', 'Unknown contact type')
  // not cut to 254 first: that could turn a too long address into another one
  const email = oneLine(fields.email, 1000)
  if (!isContactEmail(email)) throw new ContactError(400, 'invalid_email', 'Invalid email address')
  const comments = freeText(fields.comments, MAX_COMMENTS)
  if (!comments) throw new ContactError(400, 'missing_comments', 'The message is empty')
  const supportType = oneLine(fields.supportType, 10).toLowerCase()
  const severity = oneLine(fields.severity, 2)
  const source = oneLine(fields.source, 20).toLowerCase()
  return {
    contactType,
    email,
    comments,
    area: areaOf(fields.area),
    supportType: contactType === 'support' && SUPPORT_TYPES.includes(supportType) ? supportType : '',
    // only a support message has a severity: one left in a form switched to
    // feedback would set the priority (priorityOf)
    severity: contactType === 'support' && /^[1-4]$/.test(severity) ? severity : '',
    matchRunning: oneLine(fields.matchRunning, 10) === '1',
    source: SOURCES.includes(source) ? source : 'app',
    language: pick(fields.language, /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/, 16),
    appVersion: pick(fields.appVersion, /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/, 32),
    platform: pick(fields.platform, /^[a-z0-9][a-z0-9_-]{0,31}$/i, 32),
    url: pageUrlOf(fields.url),
    userAgent: oneLine(fields.userAgent, 300),
    timestamp: pick(fields.timestamp, /^[0-9][0-9T:.+\-Z ]{0,39}$/, 40),
    diagnostics: diagnosticsOf(fields.diagnostics)
  }
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'])
const AVIF_BRANDS = new Set(['avif', 'avis'])
const ascii = (b, at, text) => b.length >= at + text.length && b.toString('latin1', at, at + text.length) === text
const ftypBrand = (b) => (ascii(b, 4, 'ftyp') && b.length >= 12 ? b.toString('latin1', 8, 12) : '')

// Binary types: recognised by their signature, whatever the name says
const BINARY_TYPES = [
  { mime: 'image/png', exts: ['png'], match: (b) => b.length >= 8 && b.subarray(0, 8).equals(PNG) },
  { mime: 'image/jpeg', exts: ['jpg', 'jpeg'], match: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', exts: ['gif'], match: (b) => ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a') },
  { mime: 'image/webp', exts: ['webp'], match: (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP') },
  { mime: 'image/heic', exts: ['heic', 'heif'], match: (b) => HEIF_BRANDS.has(ftypBrand(b)) },
  { mime: 'image/avif', exts: ['avif'], match: (b) => AVIF_BRANDS.has(ftypBrand(b)) },
  { mime: 'application/pdf', exts: ['pdf'], match: (b) => ascii(b, 0, '%PDF-') }
]
// Text types: no signature, so the name decides among these, and the bytes
// must be UTF-8 text without NUL (JSON: starting with { or [)
const TEXT_TYPES = Object.freeze({
  txt: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  ndjson: 'application/x-ndjson'
})

function extOf(name) {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

function isUtf8Text(b) {
  if (b.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b)
    return true
  } catch {
    return false
  }
}

/**
 * The type of an attachment by its bytes: { mime, ext } for an allowed one
 * (ext: the file's own extension when it fits, else the type's), else null.
 */
export function sniffFile(data, filename = '') {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data || '')
  if (b.length === 0) return null
  const ext = extOf(String(filename))
  const binary = BINARY_TYPES.find((t) => t.match(b))
  if (binary) return { mime: binary.mime, ext: binary.exts.includes(ext) ? ext : binary.exts[0] }
  const textExt = ext || 'txt'
  if (!Object.prototype.hasOwnProperty.call(TEXT_TYPES, textExt) || !isUtf8Text(b)) return null
  if (textExt === 'json' || textExt === 'ndjson') {
    const first = b.toString('utf8', 0, Math.min(b.length, 1024)).replace(/^﻿/, '').trimStart()[0]
    if (first !== '{' && first !== '[') return null
  }
  return { mime: TEXT_TYPES[textExt], ext: textExt }
}

/** A file name for the mail: no path, no control or reserved characters, at most 100 characters, ending in `ext`. */
export function safeFilename(raw, ext) {
  let name = String(raw || '').normalize('NFC').split(/[\\/]/).pop()
  name = name.replace(CONTROL, '').replace(/[<>:"|?*]/g, '').replace(/\s+/g, ' ').trim().replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')
  if (!name) name = 'attachment'
  if (extOf(name) !== ext) name = `${name}.${ext}`
  if (name.length > 100) name = `${name.slice(0, 100 - ext.length - 1).trimEnd()}.${ext}`
  return name
}

/**
 * The diagnostics report as the mail's attachment: { filename (always .txt),
 * mime, data, lines }, null without one. UTF-8 text without NUL, else 415
 * diagnostics_type; at most MAX_DIAGNOSTICS_FILE_BYTES (413, also checked
 * while parsing).
 */
export function checkDiagnosticsFile(part) {
  if (!part?.data?.length) return null
  const data = Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data)
  if (data.length > MAX_DIAGNOSTICS_FILE_BYTES) throw new ContactError(413, 'diagnostics_too_large', 'The diagnostics are too large', { maxBytes: MAX_DIAGNOSTICS_FILE_BYTES })
  if (!isUtf8Text(data)) throw new ContactError(415, 'diagnostics_type', 'The diagnostics must be UTF-8 text')
  const text = data.toString('utf8')
  const lines = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
  return { filename: safeFilename(part.filename || 'openvolley-diagnostics.txt', 'txt'), mime: 'text/plain; charset=utf-8', data, lines }
}

/** The attachments of the mail ({ filename, mime, data }), or a ContactError naming the refused file. */
export function checkAttachments(files = []) {
  if (files.length > MAX_FILES) throw new ContactError(400, 'too_many_files', `At most ${MAX_FILES} attachments`, { maxFiles: MAX_FILES })
  const total = files.reduce((n, f) => n + f.data.length, 0)
  if (total > MAX_FILES_BYTES) throw new ContactError(413, 'files_too_large', 'Attachments too large', { maxBytes: MAX_FILES_BYTES })
  return files.map((f) => {
    const type = sniffFile(f.data, f.filename)
    const shown = oneLine(f.filename, 100) || 'attachment'
    if (!type) throw new ContactError(415, 'file_type', `${shown}: this type of file cannot be attached`, { file: shown })
    return { filename: safeFilename(f.filename, type.ext), mime: type.mime, data: f.data }
  })
}

// ---------------------------------------------------------------------------
// The mail
// ---------------------------------------------------------------------------

function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * The ticket's priority (the owner's scheme, 2026-10-29) and the reason the
 * body names:
 *   P1  a match is being scored right now (matchRunning), or severity 1
 *   P2  severity 2
 *   P3  severity 3, a help question, or support without a severity
 *   P4  the rest: severity 4, feedback, a feature request
 * @param {{ contactType: string, supportType?: string, severity?: string, matchRunning?: boolean }} value normalizeContact's
 * @returns {{ level: 'P1'|'P2'|'P3'|'P4', reason: string }}
 */
export function priorityOf(value) {
  const { contactType, supportType, severity, matchRunning } = value
  if (matchRunning || severity === '1') {
    return { level: 'P1', reason: [matchRunning && 'match running', severity === '1' && 'severity 1'].filter(Boolean).join(', ') }
  }
  if (severity === '2') return { level: 'P2', reason: 'severity 2' }
  if (severity === '3') return { level: 'P3', reason: 'severity 3' }
  if (supportType === 'help') return { level: 'P3', reason: 'help question' }
  if (contactType === 'support' && !severity) return { level: 'P3', reason: 'support without severity' }
  if (severity === '4') return { level: 'P4', reason: 'severity 4' }
  return { level: 'P4', reason: contactType === 'request' ? 'feature request' : 'feedback' }
}

/**
 * "[P1 – match running] [scoring] Support – Bug report", "[P4] [home] Feedback":
 * the priority, the area id and the type, never a word the user typed.
 * FreeScout's auto reply can quote the subject to the Reply-To address,
 * which nobody has verified; the message stays in the body.
 */
export function supportSubject(value, priority = priorityOf(value)) {
  const level = value.matchRunning ? `${priority.level} – match running` : priority.level
  const supportType = value.contactType === 'support' ? SUPPORT_TYPE_LABELS[value.supportType] : ''
  return `[${level}] [${value.area}] ${TYPE_LABELS[value.contactType]}${supportType ? ` – ${supportType}` : ''}`
}

/**
 * The mail to the support mailbox, without from / to (the mailer sets them):
 * Reply-To the user, the priority in the subject and in X-OpenVolley-Priority,
 * the attachments with their checked types (the diagnostics report last), a
 * plain-text body with the priority first, then every field and the
 * diagnostics.
 */
export function buildSupportMail(value, attachments = [], { receivedAt = new Date(), diagnosticsFile = null } = {}) {
  const priority = priorityOf(value)
  const rows = [
    ['Priority', `${priority.level} – ${priority.reason}`],
    ['Type', TYPE_LABELS[value.contactType]],
    ['Support type', SUPPORT_TYPE_LABELS[value.supportType] || ''],
    ['Severity', SEVERITY_LABELS[value.severity] || ''],
    ['Area', `${SECTION_NAMES[value.area]} (${value.area})`],
    ['Email', value.email],
    ['Source', value.source],
    ['Language', value.language],
    ['App version', value.appVersion],
    ['Platform', value.platform],
    ['Page', value.url],
    ['User agent', value.userAgent],
    ['Sent at', value.timestamp],
    ['Received at', receivedAt.toISOString()],
    ['Attachments', attachments.length ? attachments.map((a) => `${a.filename} (${formatBytes(a.data.length)})`).join(', ') : 'none'],
    ['Diagnostics', diagnosticsFile ? `attached (${diagnosticsFile.lines} lines, ${Math.max(1, Math.round(diagnosticsFile.data.length / 1024))} KB): ${diagnosticsFile.filename}` : '']
  ].filter(([, v]) => v)
  const width = Math.max(...rows.map(([k]) => k.length)) + 1
  const lines = [
    // "Priority: P1 – match running" first: the line FreeScout's list previews
    ...rows.map(([k, v]) => `${`${k}:`.padEnd(width + 1)}${v}`),
    '',
    'Message:',
    value.comments,
    ''
  ]
  if (value.diagnostics) lines.push('Diagnostics (sent with the user\'s consent):', value.diagnostics, '')
  return {
    replyTo: { name: '', address: value.email },
    subject: supportSubject(value, priority),
    // a custom header only, nothing FreeScout reads as an auto-responder.
    // nodemailer writes the name as X-Openvolley-Priority (header names are
    // case-insensitive)
    headers: { 'X-OpenVolley-Priority': priority.level },
    text: lines.join('\n'),
    attachments: [...attachments, ...(diagnosticsFile ? [diagnosticsFile] : [])].map((a) => ({ filename: a.filename, content: a.data, contentType: a.mime }))
  }
}

// ---------------------------------------------------------------------------
// Mailer
// ---------------------------------------------------------------------------

export function disabledContactMailer(reason = 'not configured') {
  return {
    enabled: false,
    reason,
    async send() { return { sent: false, skipped: 'disabled' } },
    close() {}
  }
}

/**
 * Sends the support mails: from and to are fixed here, never taken from a
 * request. At most maxPerHour mails per fixed hour window (all senders).
 * @param {{ transport: { sendMail: Function, close?: Function }, from: string, to: string, maxPerHour?: number, now?: () => number }} o
 */
export function createContactMailer({ transport, from, to, maxPerHour = CONTACT_MAILS_PER_HOUR, now = Date.now } = {}) {
  if (!transport || typeof transport.sendMail !== 'function') throw new Error('createContactMailer: transport is required')
  if (!from) throw new Error('createContactMailer: from is required')
  if (!isContactEmail(to)) throw new Error('createContactMailer: to must be one address')
  let windowStart = now()
  let used = 0
  return {
    enabled: true,
    reason: null,
    from,
    to,
    async send(mail) {
      const t = now()
      if (t - windowStart >= HOUR_MS) { windowStart = t; used = 0 }
      if (used >= maxPerHour) return { sent: false, skipped: 'budget' }
      used++
      await transport.sendMail({ ...mail, from, to, disableFileAccess: true, disableUrlAccess: true })
      return { sent: true }
    },
    close() { try { transport.close?.() } catch { /* already closed */ } }
  }
}

/**
 * The support mailer of the environment: the SMTP account of the account
 * mails (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS; From MAIL_FROM, with
 * the same default as lib/mailer.js), To CONTACT_EMAIL. A disabled one, with
 * the reason, when that is not configured. Never throws, never logs the
 * password. One connection per mail (no pool): the form sends rarely.
 */
export function contactMailerFromEnv(env = process.env, { tls, maxPerHour } = {}) {
  const host = (env.SMTP_HOST || '').trim()
  const pass = env.SMTP_PASS || ''
  if (!host || !pass) return disabledContactMailer(!host ? 'SMTP_HOST not set' : 'SMTP_PASS not set')
  const user = (env.SMTP_USER || '').trim()
  if (!user) return disabledContactMailer('SMTP_USER not set')
  const portText = (env.SMTP_PORT || '').trim() || '465'
  const port = Number(portText)
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) return disabledContactMailer('SMTP_PORT is not a port number')
  const from = (env.MAIL_FROM || '').trim() || (user.includes('@') ? `${DEFAULT_FROM_NAME} <${user}>` : '')
  if (!from) return disabledContactMailer('MAIL_FROM not set (and SMTP_USER is not an address)')
  const to = (env.CONTACT_EMAIL || '').trim() || DEFAULT_CONTACT_EMAIL
  if (!isContactEmail(to)) return disabledContactMailer('CONTACT_EMAIL is not one address')
  try {
    const transport = nodemailer.createTransport({ ...transportOptions({ host, port, user, pass, tls }), pool: false })
    return createContactMailer({ transport, from, to, maxPerHour })
  } catch (err) {
    return disabledContactMailer(err.message)
  }
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

const answer = (status, body) => ({ status, body })

/**
 * The 503 of a form that cannot take more now: the hourly budget is used up
 * (handleContact), or MAX_CONTACT_IN_FLIGHT bodies are being received
 * (server.js). The app then offers to send the message by email (mailto).
 */
export const BUSY_BODY = Object.freeze({ success: false, code: 'busy', error: 'Too many messages right now. Please try again later' })

/**
 * At most `max` contact requests at once (server.js): each holds its body,
 * up to MAX_CONTACT_BODY_BYTES, in memory while it arrives (up to 2 minutes)
 * and while it is mailed. run(work) starts work in a free slot and frees the
 * slot once work settles, whichever way it ends (answered, refused, the body
 * timed out or the client gone, work throwing), and returns work's promise;
 * with every slot taken it starts nothing and returns null.
 */
export function createContactSlots(max = MAX_CONTACT_IN_FLIGHT) {
  let inFlight = 0
  return {
    max,
    get inFlight() { return inFlight },
    run(work) {
      if (inFlight >= max) return null
      inFlight++
      let released = false
      const release = () => {
        if (released) return
        released = true
        inFlight--
      }
      try {
        return Promise.resolve(work()).finally(release)
      } catch (err) {
        release()
        return Promise.reject(err)
      }
    }
  }
}

/**
 * One POST /api/contact after the rate limit and the body read. Never throws.
 *   200 { success: true }                         mailed (or the honeypot was filled)
 *   400 / 413 / 415 { success: false, code, error } the body, a field or a file is refused
 *   503 { success: false, code: 'unavailable' | 'busy' }  no mail configured / hourly budget used up
 *   502 { success: false, code: 'send_failed' }   the SMTP server did not take it
 * The app offers to send the message by email (mailto) after a 5xx.
 */
export async function handleContact({ body, contentType, mailer, logger = console, now = () => new Date() } = {}) {
  let value
  let attachments
  let diagnosticsFile
  try {
    const { fields, files, diagnosticsFile: report } = parseContactBody(body, contentType)
    if (isHoneypotHit(fields)) {
      logger.warn('[Contact] honeypot field filled in: dropped')
      return answer(200, { success: true })
    }
    value = normalizeContact(fields)
    attachments = checkAttachments(files)
    diagnosticsFile = checkDiagnosticsFile(report)
  } catch (err) {
    if (err instanceof ContactError) return answer(err.status, { success: false, code: err.code, error: err.message, ...err.extra })
    logger.error('[Contact] could not read the request:', err?.message)
    return answer(400, { success: false, code: 'invalid_body', error: 'Invalid request' })
  }
  const what = `${value.contactType}/${value.area} ${priorityOf(value).level} from ${maskEmail(value.email)} (${value.source}, ${attachments.length} attachment(s)${diagnosticsFile ? ', diagnostics' : ''})`
  if (!mailer?.enabled) {
    logger.warn(`[Contact] ${what} not mailed: support mail is off (${mailer?.reason || 'no mailer'})`)
    return answer(503, { success: false, code: 'unavailable', error: 'The support form is not available right now' })
  }
  try {
    const r = await mailer.send(buildSupportMail(value, attachments, { receivedAt: now(), diagnosticsFile }))
    if (!r.sent) {
      logger.warn(`[Contact] ${what} not mailed: ${r.skipped === 'budget' ? 'hourly budget used up' : r.skipped}`)
      return answer(503, BUSY_BODY)
    }
  } catch (err) {
    logger.error(`[Contact] ${what} not mailed: ${describeMailError(err)}`)
    return answer(502, { success: false, code: 'send_failed', error: 'Could not send the message' })
  }
  logger.log(`[Contact] ${what} mailed to the support mailbox`)
  return answer(200, { success: true })
}
