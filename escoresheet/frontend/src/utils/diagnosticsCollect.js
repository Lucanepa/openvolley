/**
 * Reads what the support diagnostics report (utils/diagnosticsReport.js)
 * holds from this device, when the user ticks "Include diagnostics" in
 * Support & feedback: the app's state, the open match from the database, the
 * activity log and the interaction log of the last 2 hours (at least this
 * page load), the logger's errors and warnings, and the secrets to scrub
 * (PINs and tokens stored on the device). Read only: nothing is written,
 * nothing is sent from here. Every part is read on its own and a failing
 * part leaves only a note, so a report is always made.
 *
 * The scorer app has all of it. The referee, bench and livescore apps keep
 * no activity or interaction log and no match in the database: their report
 * holds the summary, their connection (utils/diagnosticsInfo) and their
 * error trail.
 *
 * The SupportFeedbackModal loads this module when it needs a report (a
 * separate chunk: the tablet apps do not carry it otherwise).
 */
import { db as appDb } from '../db/db'
import { appVersion, platformName, deviceId, currentAccountId } from './identity'
import { getAppEntry } from './appEntry'
import { getActiveMatch, gameNumberOf } from './activity/activeMatch'
import { flushActivityNow } from './activity/bus'
import { getLogs } from './logger'
import { getRecentLogs, getSessionStart } from './comprehensiveLogger'
import { getDiagnosticsInfo, getErrorTrail } from './diagnosticsInfo'
import { pickCurrentMatch } from './currentMatch'
import { jobMatchKey } from './syncIds'
import { detectOs } from './deviceKind'
import { diagnosticsState } from '../diagnostics'
import { buildDiagnosticsReport, formatSize, makeClock, TIMELINE_WINDOW_MS } from './diagnosticsReport'

const APP_NAMES = { scorer: 'scorer app', referee: 'referee app', bench: 'bench app', livescore: 'livescore', scoresheet: 'scoresheet' }
// A key naming a secret, as a word of it (refereePin, game_pin, api_auth_token,
// scorerClaim; not "typing", "mapping" or "pinned")
const SECRET_WORD = /(^|_)(pins?|tokens?|secrets?|passwords?|passwd|pwd|claims?|credentials?|apikey|cookies?)(_|$)/
export const isSecretKey = (key) => SECRET_WORD.test(String(key ?? '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').toLowerCase())
// What a secret's value looks like: a PIN, or a string a word or a setting is not
const secretShaped = (s) => PIN_SHAPED.test(s) || (s.length >= 8 && /\d/.test(s) && /[A-Za-z]/.test(s)) || (s.length >= 16 && !/\s/.test(s))
const UNSENT = ['queued', 'sending', 'error', 'failed']
// The interaction log rows read at most (the timeline keeps 5000 lines)
const MAX_INTERACTION_ROWS = 60000
// A page load open longer than this: the timeline starts this long ago
const SESSION_MAX_MS = 12 * 60 * 60 * 1000

async function attempt(notes, what, fn, fallback = null) {
  try {
    return await fn()
  } catch (err) {
    notes.push(`${what} could not be read (${String(err?.message || err).slice(0, 120)}).`)
    return fallback
  }
}

const PIN_SHAPED = /^\d{4,8}$/
const UUID_SHAPED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The secrets in a value: strings under a secret-looking key (pin, token,
 * password, claim ...) at any depth, and, inside an object stored under such
 * a key (the session, a PIN list), the values shaped like a PIN or a token
 * whatever their own key (not the account's UUID, not an email address).
 */
export function secretValuesOf(value, { key = '', inSecret = false, depth = 0, out = [] } = {}) {
  if (value == null || depth > 6) return out
  if (typeof value === 'string' || typeof value === 'number') {
    const s = String(value).trim()
    if (s.length < 4 || s.length > 4096) return out
    if (isSecretKey(key) ? secretShaped(s) : inSecret && (PIN_SHAPED.test(s) || (s.length >= 16 && !UUID_SHAPED.test(s) && !s.includes('@') && !/\s/.test(s)))) out.push(s)
    return out
  }
  if (Array.isArray(value)) {
    for (const v of value.slice(0, 50)) secretValuesOf(v, { key, inSecret, depth: depth + 1, out })
    return out
  }
  if (typeof value === 'object') {
    const secretHere = inSecret || isSecretKey(key)
    for (const [k, v] of Object.entries(value)) {
      // signatures and pictures: data URLs, never secrets to search for
      if (/signature|image|photo|logo/i.test(k)) continue
      secretValuesOf(v, { key: k, inSecret: secretHere, depth: depth + 1, out })
    }
  }
  return out
}

/** The secrets of a web storage (localStorage, sessionStorage): by key name, also inside JSON values. */
export function storageSecrets(storage) {
  const out = []
  if (!storage) return out
  let n = 0
  try { n = storage.length } catch { return out }
  for (let i = 0; i < n; i++) {
    let key
    let raw
    try {
      key = storage.key(i)
      raw = key == null ? null : storage.getItem(key)
    } catch {
      continue
    }
    if (raw == null || raw.length > 256 * 1024) continue
    let parsed
    try { parsed = JSON.parse(raw) } catch { parsed = undefined }
    if (parsed !== undefined && parsed !== null && typeof parsed === 'object') secretValuesOf(parsed, { key, out })
    else if (isSecretKey(key)) secretValuesOf(raw, { key, out })
  }
  return out
}

function urlSecrets(win) {
  const out = []
  try {
    for (const [k, v] of new URLSearchParams(win?.location?.search || '')) {
      if (isSecretKey(k) && v && v.length >= 4) out.push(v)
    }
  } catch { /* no location */ }
  return out
}

function runsAs(platform, win) {
  if (platform.startsWith('tauri')) return 'desktop app (Tauri)'
  if (platform === 'electron') return 'desktop app (Electron)'
  if (platform === 'android' || platform === 'ios') return `${platform === 'ios' ? 'iOS' : 'Android'} app`
  try {
    if (win?.matchMedia?.('(display-mode: standalone)')?.matches || win?.matchMedia?.('(display-mode: fullscreen)')?.matches || win?.navigator?.standalone === true) {
      return 'installed web app (PWA)'
    }
  } catch { /* no matchMedia */ }
  return 'browser'
}

function displayMode(win, storage) {
  let mode = 'auto'
  try { mode = storage?.getItem('displayMode') || 'auto' } catch { /* blocked */ }
  let fullscreen = false
  try { fullscreen = !!win?.document?.fullscreenElement } catch { /* none */ }
  return `${mode}${fullscreen ? ', fullscreen' : ''}`
}

function pageOf(win) {
  try {
    const l = win.location
    return `${l.protocol}//${l.host}${l.pathname}`
  } catch {
    return null
  }
}

async function storageEstimate(nav) {
  if (!nav?.storage?.estimate) return 'unknown'
  const [est, persisted] = await Promise.all([
    nav.storage.estimate().catch(() => null),
    nav.storage.persisted ? nav.storage.persisted().catch(() => null) : null
  ])
  const used = est?.usage != null ? formatSize(est.usage) : '?'
  const quota = est?.quota != null ? formatSize(est.quota) : '?'
  return `${used} used of ${quota}${persisted === true ? ', persistent' : persisted === false ? ', not persistent (the browser may clear it)' : ''}`
}

function jobErrorText(job, clockText) {
  const e = job.last_error || {}
  const what = [e.status, e.code, e.message ? String(e.message).slice(0, 160) : null].filter(Boolean).join(' ')
  const when = Number.isFinite(job.failed_at) ? clockText(job.failed_at) : Number.isFinite(job.next_attempt_at) ? `retry ${clockText(job.next_attempt_at)}` : ''
  return `${job.status} ${job.resource} ${job.action}${job.attempts ? ` (attempt ${job.attempts})` : ''}${what ? `: ${what}` : ''}${when ? `, ${when}` : ''}`
}

async function readQueue(db, clockText) {
  const rows = await db.sync_queue.where('status').anyOf(UNSENT).toArray()
  const by = {}
  for (const r of rows) by[r.status] = (by[r.status] || 0) + 1
  const oldest = rows.reduce((min, r) => {
    const t = Date.parse(r.ts) || (Number.isFinite(r.ts) ? r.ts : null)
    return t != null && (min == null || t < min) ? t : min
  }, null)
  const summary = rows.length
    ? `${rows.length} unsent (${UNSENT.filter(s => by[s]).map(s => `${by[s]} ${s === 'failed' ? 'refused' : s}`).join(', ')})${oldest != null ? `, the oldest queued ${clockText(oldest)}` : ''}`
    : 'nothing unsent'
  const errors = rows
    .filter(r => r.status === 'error' || r.status === 'failed')
    .sort((a, b) => (b.failed_at || b.next_attempt_at || 0) - (a.failed_at || a.next_attempt_at || 0))
    .slice(0, 3)
    .map(r => jobErrorText(r, clockText))
  return { rows, summary, errors }
}

/** The match the report describes: the one open now, else the current one, else the newest. */
async function pickMatch(db, gameNumber) {
  const active = getActiveMatch()
  if (active?.id != null) {
    const row = await db.matches.get(active.id)
    if (row) return { row, why: 'the match open on this device' }
  }
  const all = await db.matches.toArray()
  if (!all.length) return null
  if (gameNumber != null && gameNumber !== '') {
    const byGame = all.filter(m => String(gameNumberOf(m)) === String(gameNumber)).sort((a, b) => (b.id || 0) - (a.id || 0))[0]
    if (byGame) return { row: byGame, why: 'the match of the screen the dialog was opened from' }
  }
  const current = pickCurrentMatch(all)
  if (current) return { row: current, why: 'not open right now: the current match of the home screen' }
  const newest = [...all].sort((a, b) => (b.id || 0) - (a.id || 0))[0]
  return { row: newest, why: 'not open right now: the newest match on this device' }
}

async function readMatch(db, picked, queueRows) {
  const { row } = picked
  const [sets, events, homeTeam, awayTeam] = await Promise.all([
    db.sets.where('matchId').equals(row.id).toArray(),
    db.events.where('matchId').equals(row.id).toArray(),
    row.homeTeamId != null ? db.teams.get(row.homeTeamId) : null,
    row.awayTeamId != null ? db.teams.get(row.awayTeamId) : null
  ])
  let unsent = null
  if (row.seed_key && queueRows) {
    const mine = queueRows.filter(j => jobMatchKey(j) === row.seed_key)
    const byResource = {}
    for (const j of mine) byResource[j.resource] = (byResource[j.resource] || 0) + 1
    unsent = mine.length ? `${mine.length} (${Object.entries(byResource).map(([k, v]) => `${v} ${k}`).join(', ')})` : 'none'
  } else if (row.test === true) {
    unsent = 'none (a test match is never sent)'
  }
  return { row, sets, events, homeTeam: homeTeam || null, awayTeam: awayTeam || null, why: picked.why, unsent }
}

function appLogOf(logs, interaction, activity, trail) {
  const out = []
  for (const e of logs || []) {
    if (e?.level !== 'error' && e?.level !== 'warn') continue
    out.push({ ts: Date.parse(e.timestamp), level: e.level, source: 'console', message: e.message, stack: e.stack || null })
  }
  for (const r of activity || []) {
    if (r.kind !== 'app.error' && r.kind !== 'backup.error') continue
    out.push({ ts: Date.parse(r.ts), level: 'error', source: r.kind === 'backup.error' ? 'backup' : (r.data?.source || 'app.error'), message: r.data?.message || 'Error', frames: r.data?.frames || [] })
  }
  for (const e of interaction || []) {
    const p = e.payload || {}
    if (e.category === 'error') {
      out.push({ ts: e.ts, level: 'error', source: `${e.component}.${e.action}`, message: p.error?.message || 'Error', stack: p.error?.stack || null })
    } else if (e.category === 'ui' && e.type === 'error') {
      out.push({ ts: e.ts, level: 'error', source: e.action === 'unhandledrejection' ? 'unhandledrejection' : 'window.error', message: p.message || p.reason || 'Error', stack: typeof p.error === 'string' ? p.error : (p.stack || null) })
    }
  }
  for (const e of trail || []) out.push(e)
  return out
}

/**
 * Everything the report holds, read from this device.
 * @param {{ db?: object, win?: Window, now?: number, gameNumber?: string|number|null, language?: string,
 *   appEntry?: string|null, windowMs?: number }} [opts]
 */
export async function collectDiagnosticsInput({
  db = appDb,
  win = typeof window !== 'undefined' ? window : undefined,
  now = Date.now(),
  gameNumber = null,
  language = '',
  appEntry = getAppEntry(),
  windowMs = TIMELINE_WINDOW_MS,
  timeZone: zone = null
} = {}) {
  const notes = []
  const nav = win?.navigator
  const local = (() => { try { return win?.localStorage ?? globalThis.localStorage } catch { return null } })()
  const session = (() => { try { return win?.sessionStorage ?? globalThis.sessionStorage } catch { return null } })()
  const platform = platformName(win)
  const scorer = appEntry === 'scorer'
  let timeZone = zone
  if (!timeZone) {
    try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || null } catch { /* old engine */ }
  }
  const clock = makeClock(timeZone || undefined)
  const clockText = (ms) => clock.time(ms).slice(0, 8)

  const info = getDiagnosticsInfo()
  const queue = scorer && db?.sync_queue ? await attempt(notes, 'The sync queue', () => readQueue(db, clockText)) : null

  let match = null
  if (scorer && db?.matches) {
    match = await attempt(notes, 'The match', async () => {
      const picked = await pickMatch(db, gameNumber)
      return picked ? readMatch(db, picked, queue?.rows) : null
    })
  } else {
    const realtime = info.realtime || info.bench
    match = { note: `The ${APP_NAMES[appEntry] || 'app'} keeps no match on this device${realtime?.matchId ? `: it follows match ${realtime.matchId} (see the summary)` : ''}.` }
  }

  // Timeline (scorer only): the last 2 hours, at least this page load
  let timeline = null
  let interaction = []
  let activity = []
  if (scorer) {
    await attempt(notes, 'The activity log buffer', () => flushActivityNow(800))
    // the last 2 hours, or this page load when it started earlier (at most SESSION_MAX_MS back)
    let from = now - windowMs
    const sessionStart = await attempt(notes, 'The start of this page load', () => getSessionStart(), null)
    const lastStart = db?.activity_log ? await attempt(notes, 'The app start', () => db.activity_log.where('kind').equals('app.start').last(), null) : null
    for (const t of [sessionStart, lastStart ? Date.parse(lastStart.ts) : NaN]) {
      if (Number.isFinite(t) && t < from && now - t <= SESSION_MAX_MS) from = t
    }
    if (db?.activity_log) {
      activity = await attempt(notes, 'The activity log', () => db.activity_log.where('ts').aboveOrEqual(new Date(from).toISOString()).toArray(), [])
    }
    interaction = (await attempt(notes, 'The interaction log', () => getRecentLogs({ from, to: now }), [])).slice(-MAX_INTERACTION_ROWS)
    timeline = {
      activity,
      interaction,
      from,
      sessionStart,
      matches: match?.row ? new Map([[match.row.id, match.row]]) : new Map(),
      notes: interaction.length === 0 ? ['The interaction log has no entries for this time.'] : []
    }
  }

  // Errors and warnings
  const appLog = appLogOf(getLogs(), interaction, activity, getErrorTrail())

  // The desktop app's own files (desktop.log, activity-*.jsonl)
  let desktop = null
  if (platform.startsWith('tauri')) {
    desktop = {
      notes: [
        'The desktop app writes desktop.log and activity-YYYY-MM-DD.jsonl into its log folder',
        '(Linux ~/.local/share/OpenVolley/logs, Windows %APPDATA%\\OpenVolley\\logs, macOS ~/Library/Logs/OpenVolley).',
        'The app cannot read them back: the activity file holds the same entries as the timeline above;',
        'desktop.log (start, updates, windows, tablets) can be sent by hand: Options > Open log folder.'
      ]
    }
  }

  // Secrets to scrub wherever they appear
  const secrets = [...storageSecrets(local), ...storageSecrets(session), ...urlSecrets(win)]
  if (scorer && db?.matches) {
    await attempt(notes, 'The PINs to leave out', async () => {
      for (const m of await db.matches.toArray()) secretValuesOf(m, { out: secrets })
    })
  }

  let diagMode = null
  try {
    const d = diagnosticsState()
    diagMode = d.on ? `on (${d.source || 'options'}, ${d.sink || 'no sink'})` : 'off'
  } catch { /* not installed in this app */ }

  const screen = win?.screen
  const summary = {
    appName: 'OpenVolley',
    app: APP_NAMES[appEntry] || appEntry || 'unknown page',
    version: appVersion(),
    platform,
    runsAs: runsAs(platform, win),
    os: [detectOs(win), nav?.userAgentData?.platform ? `(${nav.userAgentData.platform}${nav.userAgentData.mobile ? ', mobile' : ''})` : null].filter(Boolean).join(' ') || 'unknown',
    userAgent: nav?.userAgent || null,
    screen: screen ? `${screen.width}×${screen.height}, ${win.devicePixelRatio || 1}× pixels${screen.orientation?.type ? `, ${screen.orientation.type}` : ''}${Number(nav?.maxTouchPoints) > 0 ? ', touch' : ''}` : null,
    window: win ? `${win.innerWidth}×${win.innerHeight}` : null,
    displayMode: displayMode(win, local),
    language: [language ? `${language} (app)` : null, nav?.languages?.length ? `${[...nav.languages].slice(0, 4).join(', ')} (browser)` : nav?.language || null].filter(Boolean).join(', '),
    timeZone,
    clock: info.relay?.clock || null,
    online: nav ? nav.onLine !== false : null,
    page: pageOf(win),
    info,
    queue: queue?.summary ?? (scorer ? null : undefined),
    queueErrors: queue?.errors || [],
    storage: await attempt(notes, 'The storage estimate', () => storageEstimate(nav), 'unknown'),
    diagnosticsMode: diagMode,
    deviceId: (() => { try { return deviceId(local) } catch { return null } })(),
    accountId: currentAccountId(local)
  }
  if (timeline && notes.length) timeline.notes.push(...notes.map(n => `Note: ${n}`))

  return {
    now,
    timeZone,
    app: appEntry,
    gameNumber: gameNumber ?? (match?.row ? gameNumberOf(match.row) : null),
    summary,
    match,
    timeline,
    timelineNote: scorer ? null : `No timeline: the ${APP_NAMES[appEntry] || 'app'} keeps no activity or interaction log (only the scorer app does). Its errors and warnings are in section 4.`,
    appLog,
    desktop,
    secrets,
    notes
  }
}

/**
 * The report of this device now: { text, bytes, lines, fileName, ... }
 * (utils/diagnosticsReport buildDiagnosticsReport). Never throws.
 */
export async function createDiagnosticsReport(opts = {}) {
  const input = await collectDiagnosticsInput(opts)
  return buildDiagnosticsReport(input)
}
