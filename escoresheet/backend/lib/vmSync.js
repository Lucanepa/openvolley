/**
 * VolleyManager -> public.svrz_games sync (self-hosted port of the Supabase
 * Edge Function vm-sync; its source left the tree in 2026-11, see git history).
 *
 * Logs into VolleyManager (volleymanager.volleyball.ch, a Neos Flow app) with a
 * cookie jar, reads the CSRF token from the referee-game page, pages through the
 * referee-game search API, transforms every game and upserts it into
 * public.svrz_games (ON CONFLICT game_number). Each run is logged in
 * public.svrz_sync_log.
 *
 * Fixed against the Edge Function:
 *  - a failure after the 'running' log row is written closes the row as
 *    'failed' (with a redacted message); rows left 'running' by a killed process
 *    are closed by the next run (and once by db/003_svrz_games_local_time.sql)
 *  - date/time are formatted in Europe/Zurich, not UTC (kick-offs were 1-2 h early);
 *    a startingDateTime without Z/offset is a Zurich wall-clock time (as the
 *    frontend reads it); a non-ISO one gives '' instead of the host's reading
 *  - "today" is the Europe/Zurich calendar day, not the UTC one
 *  - the window is configurable; default Zurich today -1 .. today +14 days
 *  - created / updated / unchanged are counted (xmax + a pre-image CTE)
 *  - a Postgres advisory lock keeps two runs (any process) from overlapping
 *  - every VolleyManager request has a timeout and limited retries with backoff
 *  - the password, cookies and CSRF token are never logged (and are scrubbed
 *    from every log line and error message)
 *  - the account's active role is read back after the switch; a switch that
 *    is refused or does not take fails the run
 *  - match_format is 3 or 5 only when VolleyManager says so (NULL otherwise,
 *    counted in the log), the category and an age class in it are stored, and
 *    the NL filter takes whole words
 *  - a complete run moves the upcoming games VolleyManager no longer returns
 *    out of svrz_games (db/041); no games or most of them missing is 'partial'
 *  - scheduleVmSync retries a run that is no success and catches a missed one
 *    up; readSyncRecord / syncHealth are /health's view of it
 *  - a referee or line judge erased on request (scripts/redact-person.mjs,
 *    registered in public.redacted_people, db/052) is written as NULL, not
 *    as VolleyManager has them (lib/redactedPeople.js; data-map F27); a
 *    register with entries and no OV_PIN_SECRET to check them fails the run
 *
 * Nothing here imports `pg`: runVmSync takes a pg Pool (or anything with
 * connect() -> client { query, release, on/removeListener } and, optionally,
 * query() for a fresh connection), so it can share the backend's pool. The
 * checked-out client gets its own 'error' listener for the whole run, so a
 * dropped database connection cannot become an uncaught exception.
 */

import { createRedactedMatcher, loadRegister, redactedPeopleKey, withholdRedacted } from './redactedPeople.js'
import { parseLeagueCalendar } from './vmIcal.js'
import { fetchGames as fetchGameCenterGames } from './gameCenter.js'

export const VM_BASE = 'https://volleymanager.volleyball.ch'
export const ZURICH_TZ = 'Europe/Zurich'
export const BATCH_SIZE = 200
/**
 * The search pages. On 10.11.2026 the 180-day window (1045 games) stopped at
 * 200: VolleyManager took more than 20 s for the second page of 200, three
 * times. Pages of 100 with 45 s each; a page that still fails is asked again
 * at the same offset with half the size, down to SEARCH_MIN_PAGE_SIZE.
 */
export const SEARCH_PAGE_SIZE = 100
export const SEARCH_MIN_PAGE_SIZE = 25
export const SEARCH_TIMEOUT_MS = 45000
export const DEFAULT_WINDOW = Object.freeze({ daysBack: 1, daysAhead: 14 })
/** Upper bound on a sync window, so a typo cannot ask VM for decades of games. */
export const MAX_WINDOW_DAYS = 400
/** A 'running' log row older than this belongs to a dead run. */
export const STALE_RUNNING_MS = 60 * 60 * 1000
/**
 * A complete run moves the upcoming games VolleyManager no longer returns out
 * of svrz_games (db/041 svrz_games_removed), unless more than this many and
 * more than half of the window's upcoming games would go at once: that is
 * VolleyManager answering under another role or with a broken search, not a
 * wave of cancellations, and the run is 'partial' for a person to look at.
 */
export const REMOVAL_GUARD_MIN = 10
/** The schedule's retries after a run that was no success (each counted from the end of the last try). */
export const VM_SYNC_RETRY_DELAYS_MS = Object.freeze([15, 30, 60].map((m) => m * 60000))
/** /health: a last success older than this (a nightly sync missed, plus slack) is stale. */
export const SYNC_STALE_AFTER_MS = 26 * 3600000
/**
 * When retries and catch-up runs may start (UTC, VM_SYNC_WINDOW_UTC): the
 * shared account's referee-role hours (svrz_rc's 22:00-00:59 UTC games
 * window, which a club app's club-role jobs keep out of). 'any' once
 * OpenVolley has an account of its own.
 */
export const DEFAULT_RUN_WINDOW_UTC = '22:00-01:00'
/**
 * pg_try_advisory_lock key (bigint): ASCII "ovvmsync". Shared by every process
 * that runs the sync against the same database.
 */
export const ADVISORY_LOCK_KEY = '8031737197922709091'

/**
 * The VolleyManager role the referee-game search needs. The account is shared
 * (svrz_rc and a club app log into the same one), and VolleyManager keeps the
 * active role per ACCOUNT, not per session: whichever job or person last picked
 * a role decides what this login may read. Under a club role the referee page
 * answers 403 (which is how this sync failed most days from 2026-10-23: the club app's
 * 04:30 UTC job leaves the account in its club role). So the login switches into
 * this role itself, as svrz_rc's games sync does (svrz_rc server/index.ts,
 * "VolleyManager roles").
 *
 * An *attribute value* id, per account (the `persistenceObjectIdentifier` in
 * `party.groupedEligibleAttributeValues`, GET /api/sportmanager.security/api%5cparty
 * ?party[__identity]=<partyId>): VM_ROLE_ATTRIBUTE_GAMES overrides it when the
 * account changes. This one is Indoorvolleyball.RefAdmin:RefereeDelegate.
 */
export const VM_ROLE_FOR_GAMES = 'e693b8cf-3fda-4a8d-b091-b3c7dae850ec'

// Leagues to EXCLUDE (above 1L): a whole word of the league text ("NLA",
// "NL B", "Nationalliga A"). The Edge Function matched a substring, which also
// dropped every league whose text merely contains "nl" (Seniorenliga,
// Juniorenliga, Einladungsturnier).
export const EXCLUDED_LEAGUES = ['nl', 'nationalliga', 'nla', 'nlb']

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
const USERNAME_FIELD = '__authentication[Neos][Flow][Security][Authentication][Token][UsernamePassword][username]'
const PASSWORD_FIELD = '__authentication[Neos][Flow][Security][Authentication][Token][UsernamePassword][password]'

export const RENDER_PROPERTIES = [
  'game.startingDateTime', 'gameDayOfWeek', 'game.number',
  'game.group.phase.league.leagueCategory.name',
  'game.group.phase.league.leagueCategory.shortName',
  'game.group.phase.league.leagueCategory.isJuniorLeagueCategory',
  'game.group.phase.league.leagueCategory.displayNameWithManagingAssociationShortName',
  'game.group.phase.league.gender',
  'game.group.phase.league.numberOfWinSets',
  'game.group.name', 'game.group.displayName',
  'game.group.phase.name', 'game.group.phase.displayName',
  'game.encounter.teamHome.identifier', 'game.encounter.teamHome.name',
  'game.encounter.teamHome.displayName', 'game.encounter.teamHome.leagueCategory.name',
  'game.encounter.teamHome.club.identifier',
  'game.encounter.teamAway.identifier', 'game.encounter.teamAway.name',
  'game.encounter.teamAway.displayName', 'game.encounter.teamAway.leagueCategory.name',
  'game.encounter.teamAway.club.identifier',
  'game.hall.name', 'game.hall.displayName',
  'game.hall.primaryPostalAddress.additionToAddress',
  'game.hall.primaryPostalAddress.combinedAddress',
  'game.hall.primaryPostalAddress.country.countryCode',
  'game.hall.primaryPostalAddress.postalCode',
  'game.hall.primaryPostalAddress.city',
  'activeFirstHeadRefereeName', 'activeSecondHeadRefereeName',
  'activeFirstLinesmanRefereeName', 'activeSecondLinesmanRefereeName',
  'activeThirdLinesmanRefereeName', 'activeFourthLinesmanRefereeName',
  'activeStandbyHeadRefereeName', 'activeStandbyLinesmanName',
  'isSupervised', 'isHeadOneSupervised', 'isHeadTwoSupervised',
  'isLinesmanOneSupervised', 'isLinesmanTwoSupervised',
  'isLinesmanThreeSupervised', 'isLinesmanFourSupervised',
  'hasAtLeastOneRefereeIntendedToBeSupervised',
  'refereeConvocations.*.indoorAssociationReferee.indoorReferee.person.displayName'
]

// ---------------------------------------------------------------------------
// Time zone helpers (Intl only, no dependency)
// ---------------------------------------------------------------------------

const partsFormatters = new Map()
function partsFormatter(tz) {
  let f = partsFormatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23'
    })
    partsFormatters.set(tz, f)
  }
  return f
}

/** Wall-clock fields of an instant in `tz` (numbers). */
export function zonedParts(date, tz = ZURICH_TZ) {
  const out = {}
  for (const p of partsFormatter(tz).formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value)
  }
  if (out.hour === 24) out.hour = 0 // very old engines render midnight as 24
  return out
}

const pad2 = (n) => String(n).padStart(2, '0')

/** 'YYYY-MM-DD' of the calendar day of `date` in `tz`. */
export function zonedYmd(date, tz = ZURICH_TZ) {
  const p = zonedParts(date, tz)
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`
}

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Validates a 'YYYY-MM-DD' calendar date (rejects 2026-02-30). */
export function isYmd(s) {
  const m = typeof s === 'string' && s.match(YMD_RE)
  if (!m) return false
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]
}

/** Calendar arithmetic on 'YYYY-MM-DD' (no time zone involved). */
export function addDaysYmd(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`
}

/** Whole days from `a` to `b` ('YYYY-MM-DD'). */
export function diffDaysYmd(a, b) {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000)
}

/** Offset of `tz` from UTC at `instantMs`, in ms (Zurich: +1 h or +2 h). */
export function tzOffsetMs(instantMs, tz = ZURICH_TZ) {
  const t = Math.floor(instantMs / 1000) * 1000
  const p = zonedParts(new Date(t), tz)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t
}

/**
 * The UTC instant of wall-clock `ymd hour:minute` in `tz`. For a time skipped
 * by a DST jump it returns the instant one hour later; for a repeated time the
 * first occurrence. (Midnight and 06:00 in Zurich are never ambiguous.)
 */
export function zonedTimeToUtc(ymd, hour = 0, minute = 0, tz = ZURICH_TZ) {
  const [y, m, d] = ymd.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d, hour, minute)
  const off1 = tzOffsetMs(guess - 12 * 3600000, tz) // offset before any same-day jump
  let t = guess - off1
  const off2 = tzOffsetMs(t, tz)
  if (off2 !== off1) {
    const t2 = guess - off2
    // Only take the second offset if it really maps back to the wall time
    if (tzOffsetMs(t2, tz) === off2) t = t2
  }
  return new Date(t)
}

/**
 * Resolves the sync window to Zurich calendar days and the UTC instants VM is
 * asked for. `window` may be:
 *   { date: 'YYYY-MM-DD' }                    one Zurich day
 *   { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }  inclusive Zurich days
 *   { daysBack, daysAhead }                   relative to Zurich "today" (default -1 .. +14)
 */
export function resolveWindow(window = {}, { now = new Date(), tz = ZURICH_TZ } = {}) {
  const w = window || {}
  let fromDay
  let toDay
  if (w.from != null || w.to != null) {
    if (!isYmd(w.from) || !isYmd(w.to)) throw new RangeError('window.from and window.to must both be YYYY-MM-DD dates')
    fromDay = w.from
    toDay = w.to
  } else if (w.date != null) {
    if (!isYmd(w.date)) throw new RangeError('window.date must be a YYYY-MM-DD date')
    fromDay = toDay = w.date
  } else {
    const back = w.daysBack ?? DEFAULT_WINDOW.daysBack
    const ahead = w.daysAhead ?? DEFAULT_WINDOW.daysAhead
    for (const [k, v] of [['daysBack', back], ['daysAhead', ahead]]) {
      if (!Number.isInteger(v) || v < 0) throw new RangeError(`window.${k} must be a non-negative integer`)
    }
    const today = zonedYmd(now, tz)
    fromDay = addDaysYmd(today, -back)
    toDay = addDaysYmd(today, ahead)
  }
  const days = diffDaysYmd(fromDay, toDay) + 1
  if (days < 1) throw new RangeError(`window.from (${fromDay}) is after window.to (${toDay})`)
  if (days > MAX_WINDOW_DAYS) throw new RangeError(`window spans ${days} days (max ${MAX_WINDOW_DAYS})`)
  const startUtc = zonedTimeToUtc(fromDay, 0, 0, tz)
  const endUtc = new Date(zonedTimeToUtc(addDaysYmd(toDay, 1), 0, 0, tz).getTime() - 1000)
  return {
    fromDay,
    toDay,
    days,
    // Same shape the Edge Function sent ("…T00:00:00.000Z"), now Zurich-aligned
    dateFrom: startUtc.toISOString(),
    dateTo: endUtc.toISOString()
  }
}

/**
 * The ISO 8601 shapes VM's startingDateTime is accepted in, with field ranges
 * checked (db/003 uses the same pattern). Anything else is rejected rather than
 * handed to Date's legacy parser, which would read it in the host's time zone.
 */
export const VM_DATETIME_RE =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d+))?)?(Z|[+-](?:0\d|1[0-4])(?::?[0-5]\d)?)?$/

/** True when a VM datetime string carries no zone designator (Z / ±hh[:mm]). */
export function isOffsetlessVmDateTime(raw) {
  const m = typeof raw === 'string' && raw.trim().match(VM_DATETIME_RE)
  return !!m && !m[8]
}

/**
 * Parses VM's startingDateTime into an instant, or null.
 *
 *  - With Z or an offset: that instant.
 *  - Without a zone designator: a Europe/Zurich wall-clock time. That is how
 *    the only consumer (LoadOfficialMatchModal, `new Date(row.datetime)` in a
 *    Swiss browser) reads it, and the Edge Function's date/time for such a
 *    value were its literal digits, so this keeps them unchanged.
 *  - Anything else (space separator, other formats, 2026-02-30, 25:00): null.
 */
export function parseVmDateTime(raw, tz = ZURICH_TZ) {
  if (typeof raw !== 'string') return null
  const m = raw.trim().match(VM_DATETIME_RE)
  if (!m) return null
  const [, y, mo, d, h, mi, s = '0', frac = '', zone] = m
  const ymd = `${y}-${mo}-${d}`
  if (!isYmd(ymd)) return null
  const ms = Number((frac + '000').slice(0, 3))
  if (!zone) {
    const base = zonedTimeToUtc(ymd, Number(h), Number(mi), tz).getTime()
    return new Date(base + Number(s) * 1000 + ms)
  }
  let offsetMin = 0
  if (zone !== 'Z') {
    const digits = zone.slice(1).replace(':', '')
    offsetMin = (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || 0)) * (zone[0] === '-' ? -1 : 1)
  }
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, ms) - offsetMin * 60000)
}

/** dd/mm/yyyy and HH:MM of an instant, in Europe/Zurich (the app's formats). */
export function formatZurichDateTime(date, tz = ZURICH_TZ) {
  const p = zonedParts(date, tz)
  return {
    date: `${pad2(p.day)}/${pad2(p.month)}/${p.year}`,
    time: `${pad2(p.hour)}:${pad2(p.minute)}`
  }
}

// ---------------------------------------------------------------------------
// Secret scrubbing
// ---------------------------------------------------------------------------

/**
 * Returns a function that replaces every occurrence of the given secrets
 * (password, CSRF token, cookie values, ...) in a string. Secrets shorter than
 * 4 characters are ignored (they would mangle ordinary text).
 */
export function createRedactor(getSecrets) {
  return (value) => {
    let s = typeof value === 'string' ? value : value instanceof Error ? value.message : String(value)
    const secrets = [...new Set((getSecrets() || []).filter((x) => typeof x === 'string' && x.length >= 4))]
      .sort((a, b) => b.length - a.length)
    for (const secret of secrets) {
      s = s.split(secret).join('[redacted]')
      const enc = encodeURIComponent(secret)
      if (enc !== secret) s = s.split(enc).join('[redacted]')
    }
    return s.replace(/[\r\n\t]+/g, ' ').slice(0, 1000)
  }
}

// ---------------------------------------------------------------------------
// Cookie jar
// ---------------------------------------------------------------------------

export class CookieJar {
  constructor() {
    /** @type {Map<string, string>} */
    this.cookies = new Map()
  }

  /** Stores the cookies a response sets (handles deletions via Max-Age=0 / past Expires). */
  update(response, now = Date.now()) {
    const headers = response?.headers
    if (!headers) return
    let lines = []
    if (typeof headers.getSetCookie === 'function') {
      lines = headers.getSetCookie()
    } else {
      const joined = headers.get?.('set-cookie')
      // Split a folded header on commas that start a new "name=" (not the comma in Expires)
      if (joined) lines = joined.split(/,(?=\s*[^;,=\s]+=)/)
    }
    for (const line of lines) this.setFromHeader(line, now)
  }

  setFromHeader(line, now = Date.now()) {
    const [pair, ...attrs] = String(line).split(';')
    const eq = pair.indexOf('=')
    if (eq <= 0) return
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (!name) return
    let expired = false
    for (const a of attrs) {
      const [k, ...rest] = a.split('=')
      const key = k.trim().toLowerCase()
      const v = rest.join('=').trim()
      if (key === 'max-age' && /^-?\d+$/.test(v) && Number(v) <= 0) expired = true
      if (key === 'expires') {
        const t = Date.parse(v)
        if (!Number.isNaN(t) && t <= now) expired = true
      }
    }
    if (expired) this.cookies.delete(name)
    else this.cookies.set(name, value)
  }

  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  /** Cookie values (for scrubbing logs). */
  values() {
    return [...this.cookies.values()]
  }

  get size() {
    return this.cookies.size
  }
}

// ---------------------------------------------------------------------------
// HTTP: timeout, retries, redirects
// ---------------------------------------------------------------------------

export class VmHttpError extends Error {
  constructor(message, { status = null, retryable = false } = {}) {
    super(message)
    this.name = 'VmHttpError'
    this.status = status
    this.retryable = retryable
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * fetch with a per-attempt timeout (covering headers AND body) and limited
 * retries (exponential backoff with jitter) on network errors, timeouts, 429
 * and 5xx. Returns a buffered response { status, ok, headers, body } for any
 * other status. `label` is what error messages show instead of the URL (which
 * never carries secrets, but keeps messages short).
 */
export async function fetchWithRetry(fetchImpl, url, init, {
  label = 'request',
  timeoutMs = 20000,
  retries = 2,
  backoffMs = 1000,
  sleep = defaultSleep,
  logger = null
} = {}) {
  let lastErr = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const delay = Math.round(backoffMs * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5))
      logger?.warn?.(`VM: ${label} retry ${attempt}/${retries} in ${delay} ms (${lastErr.message})`)
      await sleep(delay)
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const resp = await fetchImpl(url, { ...init, signal: controller.signal })
      const body = await resp.text()
      if (resp.status === 429 || resp.status >= 500) {
        lastErr = new VmHttpError(`${label}: HTTP ${resp.status}`, { status: resp.status, retryable: true })
        continue
      }
      return { status: resp.status, ok: resp.status >= 200 && resp.status < 300, headers: resp.headers, body }
    } catch (err) {
      lastErr = controller.signal.aborted
        ? new VmHttpError(`${label}: timed out after ${timeoutMs} ms`, { retryable: true })
        : new VmHttpError(`${label}: network error (${err?.cause?.code || err?.message || err})`, { retryable: true })
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr
}

/**
 * Follows redirects by hand so every hop's Set-Cookie lands in the jar. Cookies
 * are only ever sent to `baseUrl`'s origin; a redirect elsewhere is an error.
 * A POST turns into a GET after the first redirect (like a browser after 302/303).
 */
export async function followRedirects(url, jar, init = {}, {
  fetch: fetchImpl,
  baseUrl = VM_BASE,
  maxRedirects = 10,
  http = {},
  label = 'request'
} = {}) {
  const origin = new URL(baseUrl).origin
  let currentUrl = new URL(url, baseUrl).toString()
  let currentInit = init
  for (let i = 0; i <= maxRedirects; i++) {
    if (new URL(currentUrl).origin !== origin) {
      throw new VmHttpError(`${label}: redirected off ${origin}`)
    }
    const resp = await fetchWithRetry(fetchImpl, currentUrl, {
      ...currentInit,
      headers: { 'User-Agent': USER_AGENT, ...(jar.size ? { Cookie: jar.header() } : {}), ...(currentInit.headers ?? {}) },
      redirect: 'manual'
    }, { ...http, label })
    jar.update(resp)
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location')
      if (!location) throw new VmHttpError(`${label}: HTTP ${resp.status} without Location`, { status: resp.status })
      currentUrl = new URL(location, currentUrl).toString()
      currentInit = {}
      continue
    }
    if (!resp.ok) throw new VmHttpError(`${label}: HTTP ${resp.status}`, { status: resp.status })
    return { response: resp, body: resp.body }
  }
  throw new VmHttpError(`${label}: too many redirects`)
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" }
export function decodeHtmlEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (all, e) => {
    const k = e.toLowerCase()
    if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16))
    if (k.startsWith('#') && k !== '#39') return String.fromCodePoint(parseInt(k.slice(1), 10))
    return ENTITIES[k] ?? all
  })
}

/**
 * Named <input> fields of the login form with their (entity-decoded) values,
 * attributes in any order — what a browser submits when the login button is
 * clicked: hidden/text fields and the submit button (as the Edge Function
 * sent them), unchecked checkboxes/radios left out.
 */
export function extractFormFields(html) {
  const fields = {}
  const tagRe = /<input\b[^>]*>/gi
  let m
  while ((m = tagRe.exec(String(html))) !== null) {
    const tag = m[0]
    const attr = (n) => {
      const r = tag.match(new RegExp(`\\s${n}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'))
      return r ? (r[1] ?? r[2]) : null
    }
    const name = attr('name')
    if (!name) continue
    const type = (attr('type') || 'text').toLowerCase()
    if (type === 'button' || type === 'image' || type === 'reset' || type === 'file') continue
    if ((type === 'checkbox' || type === 'radio') && !/\schecked(?=[\s=/>]|$)/i.test(tag)) continue
    fields[decodeHtmlEntities(name)] = decodeHtmlEntities(attr('value') ?? '')
  }
  return fields
}

export function extractCsrfToken(html) {
  const m = String(html).match(/data-csrf-token="([^"]+)"/)
  return m ? decodeHtmlEntities(m[1]) : null
}

/**
 * The account's active role attribute on the dashboard, or '' when the page
 * shows none: `:active-party="$convertFromBackendToFrontend({...})"`, whose
 * activeAttributeValue.persistenceObjectIdentifier it is. Parsed, not
 * pattern-matched: the association's id comes first, nested (svrz_rc reads it
 * the same way, server/boerse.ts readActiveRole).
 */
export function extractActiveRole(html) {
  const m = String(html).match(/:active-party="([^"]+)"/)
  if (!m) return ''
  const raw = decodeHtmlEntities(m[1])
  const open = raw.indexOf('(')
  const close = raw.lastIndexOf(')')
  if (open < 0 || close <= open) return ''
  try {
    const id = JSON.parse(raw.slice(open + 1, close))?.activeAttributeValue?.persistenceObjectIdentifier
    return typeof id === 'string' ? id : ''
  } catch {
    return ''
  }
}

export function buildLoginBody(fields, username, password) {
  return new URLSearchParams({ ...fields, [USERNAME_FIELD]: username, [PASSWORD_FIELD]: password }).toString()
}

/**
 * Points the logged-in account at a role (VM_ROLE_FOR_GAMES). True when
 * VolleyManager accepted the switch (vmLogin then reads the role back). Never
 * logs the token.
 */
export async function vmSwitchRole(jar, csrfToken, attributeValueId, { fetch: fetchImpl, baseUrl = VM_BASE, http = {} } = {}) {
  const logger = http.logger
  if (!attributeValueId || !csrfToken) {
    logger?.warn?.(`VM: no role switch (${attributeValueId ? 'no CSRF token on the dashboard' : 'no role attribute'})`)
    return false
  }
  const origin = new URL(baseUrl).origin
  try {
    const resp = await fetchWithRetry(fetchImpl, `${origin}/api/sportmanager.security/api%5cparty/switchRoleAndAttribute`, {
      method: 'PUT',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: '*/*',
        Origin: origin,
        Referer: `${origin}/`,
        Cookie: jar.header()
      },
      body: new URLSearchParams({ 'attributeValueAsArray[0]': attributeValueId, __csrfToken: csrfToken }).toString(),
      redirect: 'manual'
    }, { ...http, label: 'role switch', retries: 1 })
    jar.update(resp)
    if (!resp.ok) {
      logger?.warn?.(`VM: role switch answered HTTP ${resp.status}`)
      return false
    }
    logger?.log?.('VM: switched the account to the referee-delegate role')
    return true
  } catch (err) {
    logger?.warn?.(`VM: role switch failed (${err.message})`)
    return false
  }
}

/** Why a page after the login carries no CSRF token, in words that point at the cause. */
function loginFailure(html, page) {
  return /\/login\b|UsernamePassword/.test(html)
    ? 'VolleyManager login failed (still on the login page; check VM_USERNAME / VM_PASSWORD)'
    : `VolleyManager login failed (no CSRF token on the ${page})`
}

/**
 * Logs in and returns { jar, csrfToken }. Never logs the password, cookie
 * values or the CSRF token.
 *
 * The shared account's active role is read on the dashboard; when it is not
 * `roleAttribute`, the account is switched and the role read again. A refused
 * switch, or a role that did not change, fails the login (and so the run):
 * another role may read fewer games without an error (svrz_rc saw one answer
 * 200 with no rows), which a run must never take for the schedule.
 */
export async function vmLogin({ username, password }, { fetch: fetchImpl, baseUrl = VM_BASE, http = {}, logger = null, roleAttribute = VM_ROLE_FOR_GAMES } = {}) {
  if (!username || !password) throw new Error('VolleyManager credentials missing (VM_USERNAME / VM_PASSWORD)')
  const jar = new CookieJar()
  const opts = { fetch: fetchImpl, baseUrl, http: { ...http, logger } }

  logger?.log?.('VM: getting login page')
  const { body: loginHtml } = await followRedirects(`${baseUrl}/login`, jar, {}, { ...opts, label: 'login page' })
  const fields = extractFormFields(loginHtml)
  delete fields[USERNAME_FIELD]
  delete fields[PASSWORD_FIELD]
  logger?.log?.(`VM: login form has ${Object.keys(fields).length} extra fields, ${jar.size} cookie(s)`)

  logger?.log?.('VM: posting login')
  await followRedirects(`${baseUrl}/sportmanager.security/authentication/authenticate`, jar, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: buildLoginBody(fields, username, password)
  }, { ...opts, label: 'login' })

  // The dashboard opens under every role, shows the active one and carries a
  // CSRF token: with it, the session asks for the one role that may read the
  // referee games, and reads the role back.
  logger?.log?.('VM: getting the dashboard for the active role')
  const { body: dashboardHtml } = await followRedirects(`${baseUrl}/`, jar, {}, { ...opts, label: 'dashboard' })
  if (!extractCsrfToken(dashboardHtml)) throw new Error(loginFailure(dashboardHtml, 'dashboard'))
  const before = extractActiveRole(dashboardHtml)
  if (before !== roleAttribute) {
    logger?.log?.(`VM: the account is on ${before || 'no readable role'}; switching to the referee-delegate role`)
    if (!(await vmSwitchRole(jar, extractCsrfToken(dashboardHtml), roleAttribute, opts))) {
      throw new VmHttpError(`role switch to the referee-delegate role was refused (the account is on ${before || 'no readable role'}; check VM_ROLE_ATTRIBUTE_GAMES)`)
    }
    const { body: afterHtml } = await followRedirects(`${baseUrl}/`, jar, {}, { ...opts, label: 'dashboard' })
    const after = extractActiveRole(afterHtml)
    if (after !== roleAttribute) {
      throw new VmHttpError(`the account is still on ${after || 'no readable role'} after the role switch, not the referee-delegate role ${roleAttribute}`)
    }
  }

  logger?.log?.('VM: getting referee page for the CSRF token')
  let refHtml
  try {
    ;({ body: refHtml } = await followRedirects(`${baseUrl}/indoorvolleyball.refadmin/refereegame/index`, jar, {}, { ...opts, label: 'referee page' }))
  } catch (err) {
    if (err instanceof VmHttpError && err.status === 403) {
      throw new VmHttpError('referee page: HTTP 403 (the account is not in the referee-delegate role)', { status: 403 })
    }
    throw err
  }
  const csrfToken = extractCsrfToken(refHtml)
  if (!csrfToken) throw new Error(loginFailure(refHtml, 'referee page'))
  logger?.log?.(`VM: logged in (CSRF token ${csrfToken.length} chars, ${jar.size} cookie(s))`)
  return { jar, csrfToken }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export function buildSearchBody(csrfToken, offset, limit, dateFrom, dateTo) {
  const params = new URLSearchParams()
  params.set('searchConfiguration[propertyFilters][0][propertyName]', 'game.startingDateTime')
  params.set('searchConfiguration[propertyFilters][0][dateRange][from]', dateFrom)
  params.set('searchConfiguration[propertyFilters][0][dateRange][to]', dateTo)
  params.set('searchConfiguration[customFilters]', '')
  params.set('searchConfiguration[propertyOrderings][0][propertyName]', 'game.startingDateTime')
  params.set('searchConfiguration[propertyOrderings][0][descending]', 'false')
  params.set('searchConfiguration[propertyOrderings][0][isSetByUser]', 'true')
  params.set('searchConfiguration[offset]', String(offset))
  params.set('searchConfiguration[limit]', String(limit))
  params.set('searchConfiguration[textSearchOperator]', 'AND')
  RENDER_PROPERTIES.forEach((prop, i) => {
    params.set(`propertyRenderConfiguration[${i}]`, prop)
  })
  params.set('__csrfToken', csrfToken)
  return params.toString()
}

export const SEARCH_PATH = '/api/indoorvolleyball.refadmin/api%5celasticsearchrefereegame/searchForManagingAssociation'

async function searchPage(jar, csrfToken, offset, dateFrom, dateTo, { fetch: fetchImpl, baseUrl, http, batchSize }) {
  const label = `search offset ${offset}`
  // A search page is slow on VolleyManager's side: its own timeout (unless the
  // caller set one), one retry, then fetchAllGames halves the page
  const searchHttp = { ...http, timeoutMs: http.searchTimeoutMs ?? http.timeoutMs ?? SEARCH_TIMEOUT_MS, retries: http.searchRetries ?? Math.min(http.retries ?? 1, 1) }
  // Headers as the Edge Function sent them (no Accept). Unlike it, redirects
  // are not followed: a redirect here means the session is not authenticated.
  const resp = await fetchWithRetry(fetchImpl, `${baseUrl}${SEARCH_PATH}`, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: jar.header()
    },
    body: buildSearchBody(csrfToken, offset, batchSize, dateFrom, dateTo),
    redirect: 'manual'
  }, { ...searchHttp, label })
  jar.update(resp)
  if (resp.status >= 300 && resp.status < 400) {
    throw new VmHttpError(`${label}: redirected (session not authenticated?)`, { status: resp.status })
  }
  if (!resp.ok) {
    throw new VmHttpError(`${label}: HTTP ${resp.status}`, { status: resp.status })
  }
  try {
    return JSON.parse(resp.body)
  } catch {
    throw new VmHttpError(`${label}: response is not JSON (session not authenticated?)`, { status: resp.status })
  }
}

/**
 * Pages through the search API. A later page that fails after its retry
 * (a timeout, a network error, 429 or 5xx) is asked again at the same offset
 * with half the page size, down to `minBatchSize`; one that still fails stops
 * the paging: the games fetched so far are returned with `incomplete: true`
 * (upserting them is harmless; the run is marked 'partial'). A failing first
 * page throws.
 */
export async function fetchAllGames(jar, csrfToken, dateFrom, dateTo, {
  fetch: fetchImpl, baseUrl = VM_BASE, http = {}, logger = null, batchSize = SEARCH_PAGE_SIZE, minBatchSize = SEARCH_MIN_PAGE_SIZE, pageDelayMs = 100, sleep = defaultSleep
} = {}) {
  const opts = { fetch: fetchImpl, baseUrl, http: { ...http, logger, sleep: http.sleep ?? sleep }, batchSize }
  const first = await searchPage(jar, csrfToken, 0, dateFrom, dateTo, opts)
  const total = Number(first?.totalItemsCount) || 0
  const items = Array.isArray(first?.items) ? [...first.items] : []
  logger?.log?.(`VM: ${total} game(s) in window, ${items.length} in the first page`)
  let incomplete = false
  let pageError = null
  // The page size VM actually returned (it may cap `limit` below what we
  // asked for); an empty page also stops the loop, and so does the guard
  let size = Math.max(1, Math.min(items.length || batchSize, batchSize))
  const smallest = Math.max(1, Math.min(minBatchSize, size))
  const maxRequests = Math.ceil(total / smallest) + 8
  for (let n = 1; items.length < total && n < maxRequests; n++) {
    if (pageDelayMs > 0) await sleep(pageDelayMs)
    let batch
    try {
      batch = await searchPage(jar, csrfToken, items.length, dateFrom, dateTo, { ...opts, batchSize: size })
    } catch (err) {
      if (err?.retryable && size > smallest) {
        size = Math.max(smallest, Math.floor(size / 2))
        logger?.warn?.(`VM: ${err.message}; asking again in pages of ${size}`)
        continue
      }
      incomplete = true
      pageError = err.message
      logger?.warn?.(`VM: paging stopped at ${items.length}/${total}: ${err.message}`)
      break
    }
    const got = Array.isArray(batch?.items) ? batch.items : []
    if (got.length === 0) break
    items.push(...got)
  }
  if (items.length < total && !incomplete) {
    incomplete = true
    pageError = `VM returned ${items.length} of ${total} games`
  }
  return { items, total, incomplete, pageError }
}

// ---------------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------------

function deepGet(obj, ...keys) {
  for (const k of keys) {
    if (obj && typeof obj === 'object') obj = obj[k]
    else return null
  }
  return obj ?? null
}

/**
 * The text of a translatable VolleyManager field in one language. VM answers
 * `name` in the language of the account that logged in (a club may give its
 * team another name in French and Italian: "VBC Musterdorf HU23-1" can be
 * "VBC Musterdorf 1" in it/fr), and sends all three under `translations`, so
 * the sync never depends on how the shared account is set. An empty or
 * missing text falls back to German, then to the plain field.
 */
export function translatedText(entity, lang = 'de', key = 'name') {
  if (!entity || typeof entity !== 'object') return null
  for (const l of lang === 'de' ? ['de'] : [lang, 'de']) {
    const v = deepGet(entity, 'translations', l, key)
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return entity[key] ?? null
}

/** League category, phase and hall names: always German (the regional association's language). */
export function germanText(entity, key = 'name') {
  return translatedText(entity, 'de', key)
}

// A Swiss Volley club number starts with its regional association's code
// (VolleyManager's club.identifier, e.g. 912xxx = Zürich).
const ASSOCIATION_LANGUAGE = {
  901: 'fr', // Genève
  902: 'fr', // Vaud
  904: 'fr', // Neuchâtel
  907: 'de', // Bern
  909: 'de', // Nordwestschweiz
  910: 'de', // Aargau / Solothurn
  911: 'de', // Innerschweiz
  912: 'de', // Zürich
  913: 'de', // Ostschweiz
  914: 'de', // Südostschweiz
  915: 'it' // Ticino
}
// Bilingual associations (903 Valais, 905 Jura / Seeland, 906 Fribourg):
// French, but for the clubs of their German-speaking part, listed by number.
const BILINGUAL_ASSOCIATIONS = new Set(['903', '905', '906'])
const GERMAN_SPEAKING_CLUBS = new Set([
  '903025', '903059', '903095', '903100', '903155', '903190', '903192', '903300', // Oberwallis: Brig, Goms, Lalden, Raron, Visp
  '905090', '905270', '905998', // Biel/Bienne (bilingual, German majority), Nidau
  '906035', '906040', '906100', '906170', '906205', '906260', '906291', '906340', '906365', '906370' // Sense + See: Plaffeien, Bösingen, Düdingen, Gurmels, Kerzers, Murten, Rechthalten, Schmitten, Tafers, Ueberstorf
])

/**
 * The language a team's name is shown in: the one of the region its club is
 * in (Ticino Italian, Romandie French, German-speaking Switzerland German).
 * No club number, or one of no known association: German.
 */
export function teamLanguage(team) {
  const id = String(deepGet(team, 'club', 'identifier') ?? '').trim()
  if (!/^\d{6}$/.test(id)) return 'de'
  const assoc = id.slice(0, 3)
  if (BILINGUAL_ASSOCIATIONS.has(assoc)) return GERMAN_SPEAKING_CLUBS.has(id) ? 'de' : 'fr'
  return ASSOCIATION_LANGUAGE[assoc] ?? 'de'
}

/** A team's name in its own region's language (see teamLanguage). */
export function teamName(team) {
  return translatedText(team, teamLanguage(team))
}

/**
 * LOG-24 (audit 26.11): the teams whose name the sync now writes in their
 * region's language (teamName) but whose German name club_teams, saved teams
 * and older schedule rows may still hold (they were kept German before):
 * Map lower(German name) -> the region's name, from the fetched items. Left
 * out when it is not clear: a German name with two region names, a region
 * name two German names share, or a region name that is another team's
 * German name. Pure.
 */
export function teamNameRenames(items) {
  const byDe = new Map()
  const unclear = new Set()
  const germanNames = new Set()
  for (const it of Array.isArray(items) ? items : []) {
    const enc = it?.game?.encounter ?? {}
    for (const team of [enc.teamHome, enc.teamAway]) {
      if (!team || typeof team !== 'object') continue
      const de = String(translatedText(team, 'de') ?? '').replace(/\s+/g, ' ').trim()
      const shown = String(teamName(team) ?? '').replace(/\s+/g, ' ').trim()
      if (de) germanNames.add(de.toLowerCase())
      if (!de || !shown || de.toLowerCase() === shown.toLowerCase()) continue
      const k = de.toLowerCase()
      if (byDe.has(k) && byDe.get(k) !== shown) unclear.add(k)
      else byDe.set(k, shown)
    }
  }
  const shownOf = new Map()
  for (const [k, v] of byDe) {
    if (unclear.has(k)) continue
    const key = v.toLowerCase()
    shownOf.set(key, (shownOf.get(key) || 0) + 1)
  }
  const out = new Map()
  for (const [k, v] of byDe) {
    if (unclear.has(k) || shownOf.get(v.toLowerCase()) > 1 || germanNames.has(v.toLowerCase())) continue
    out.set(k, v)
  }
  return out
}

/**
 * LOG-24: the names the club rule (db/018 club_teams), the clubs' contacts
 * (lib/finalMail.js), the take-over of a held game (lib/accounts.js), the
 * saved teams (competition_teams.svrz_team_name) and every other match by
 * name read follow the schedule's: each German name of `renames`
 * (teamNameRenames) becomes the region's name in club_teams (unless that
 * name is there already), in the svrz names of the saved teams of indoor
 * competitions not archived (and as the svrz name of one without it whose
 * name is the German one), and in the schedule's older rows. Idempotent.
 * A table that does not exist is left out. { clubTeams, savedTeams, games }
 *
 * LOG-24 R1: a club team keeps the name it is renamed from in former_names
 * (db/059, oldest first, at most 10): the matches its scorers stored before
 * carry that name, and the club API and the public ?club= list pick a club's
 * matches by name (lib/publicApi.js clubTeamNames). Each renamed club team
 * is one audit row in the same statement (club.update, no actor account,
 * details { club_id, team_id, renamed: { from, to }, by: 'vm-sync' }). On a
 * database without db/059 nothing is renamed (as before this fix): a club
 * team is never renamed without keeping its former name.
 */
export async function followTeamRenames(client, renames) {
  const out = { clubTeams: 0, savedTeams: 0, games: 0 }
  if (!(renames instanceof Map) || !renames.size) return out
  const params = [[...renames.keys()], [...renames.values()]]
  const X = 'unnest($1::text[], $2::text[]) AS x(de, shown)'
  const run = async (key, sql) => {
    try {
      const { rowCount } = await client.query(sql, params)
      out[key] += rowCount ?? 0
    } catch (err) {
      if (!['42P01', '42703'].includes(err?.code)) throw err
    }
  }
  try {
    const { rows: [r] } = await client.query(`WITH old AS (
         SELECT ct.id, ct.team_name AS was, x.shown FROM public.club_teams ct JOIN ${X} ON lower(btrim(ct.team_name)) = x.de
          WHERE NOT EXISTS (SELECT 1 FROM public.club_teams o WHERE lower(btrim(o.team_name)) = lower(x.shown))),
       renamed AS (
         UPDATE public.club_teams ct
            SET team_name = old.shown,
                former_names = CASE WHEN old.was = ANY(ct.former_names) THEN ct.former_names
                                    ELSE (ct.former_names || old.was)[greatest(1, cardinality(ct.former_names) - 8):] END
           FROM old WHERE ct.id = old.id
         RETURNING ct.id, ct.club_id, old.was, ct.team_name),
       logged AS (
         INSERT INTO public.audit_log (actor_id, action, details)
         SELECT NULL, 'club.update', jsonb_build_object('club_id', club_id, 'team_id', id,
                  'renamed', jsonb_build_object('from', was, 'to', team_name), 'by', 'vm-sync')
           FROM renamed)
       SELECT count(*)::int AS n FROM renamed`, params)
    out.clubTeams += r?.n ?? 0
  } catch (err) {
    // no former_names (db/059 not run): rename nothing, the schedule's older rows included
    if (err?.code === '42703') return out
    if (err?.code !== '42P01') throw err
  }
  const indoorOpen = 't.competition_id IN (SELECT c.id FROM public.competitions c WHERE c.sport = \'indoor\' AND NOT c.archived)'
  await run('savedTeams', `UPDATE public.competition_teams t SET svrz_team_name = x.shown FROM ${X}
     WHERE lower(btrim(t.svrz_team_name)) = x.de AND ${indoorOpen}`)
  await run('savedTeams', `UPDATE public.competition_teams t SET svrz_team_name = x.shown FROM ${X}
     WHERE coalesce(btrim(t.svrz_team_name), '') = '' AND lower(btrim(t.name)) = x.de AND ${indoorOpen}`)
  await run('games', `UPDATE public.svrz_games g SET team_home = x.shown FROM ${X} WHERE lower(btrim(g.team_home)) = x.de`)
  await run('games', `UPDATE public.svrz_games g SET team_away = x.shown FROM ${X} WHERE lower(btrim(g.team_away)) = x.de`)
  return out
}

/**
 * A referee's licence number (db/051) of VolleyManager's person: its
 * `associationId`, the Swiss Volley number (SV-Nr.), else `externalId`, which
 * holds the same number (svrz_rc's games sync reads the same field of the same
 * search, checked against the SVRZ referee register); 4 to 7 digits, spaces
 * aside, else null.
 */
export function refereeLicenceOf(person) {
  if (!person || typeof person !== 'object') return null
  for (const v of [person.associationId, person.externalId]) {
    if (typeof v !== 'string' && typeof v !== 'number') continue
    const t = String(v).replace(/\s+/g, '')
    if (/^[0-9]{4,7}$/.test(t)) return t
  }
  return null
}

// The referee's names and licence number: VolleyManager's birthday of the
// person (formattedAndTimezoneIndependentBirthday) is never read (db/048,
// owner 2026-11-19: no dates of birth outside a match's own sheet)
function extractRefereeInfo(item, convocationKey) {
  const empty = { name: null, firstName: null, lastName: null, licence: null }
  const conv = item[convocationKey]
  if (!conv || typeof conv !== 'object') return empty
  const person = deepGet(conv, 'indoorAssociationReferee', 'indoorReferee', 'person')
  if (!person) return empty
  return {
    name: person.displayName ?? null,
    firstName: person.firstName ?? null,
    lastName: person.lastName ?? null,
    licence: refereeLicenceOf(person)
  }
}

// A youth league: an age class in its category (U13, "U 17", U21, U23) or one
// of these words. Recorded only (match_level, the sheet's category box): no
// rule limit reads it (owner decision 6).
const AGE_CLASS_RE = /\bu ?\d{2}\b/i
const JUNIOR_WORDS_RE = /junior|jugend|nachwuchs/i

/**
 * VolleyManager's league.numberOfWinSets -> best of 3 or 5, or null when it
 * says neither (missing, another value): the app then asks the scorer. The
 * Edge Function made everything but two_win_sets a best of 5.
 */
export function matchFormatOf(numberOfWinSets) {
  const v = typeof numberOfWinSets === 'string' ? numberOfWinSets.trim().toLowerCase() : ''
  return v === 'two_win_sets' ? 3 : v === 'three_win_sets' ? 5 : null
}

/**
 * One VM search item -> one svrz_games row (without id / created_at).
 * `date` is dd/mm/yyyy and `time` HH:MM, both in Europe/Zurich; `datetime`
 * keeps VM's raw ISO string (the frontend parses that one).
 */
export function transformGame(item, { syncedAt = new Date(), tz = ZURICH_TZ } = {}) {
  item = item && typeof item === 'object' ? item : {}
  const g = item.game ?? {}
  const enc = g.encounter ?? {}
  const home = enc.teamHome ?? {}
  const away = enc.teamAway ?? {}
  const hall = g.hall ?? {}
  const addr = hall.primaryPostalAddress ?? {}
  const grp = g.group ?? {}
  const phase = grp.phase ?? {}
  const league = phase.league ?? {}
  const leagueCat = league.leagueCategory ?? {}

  const ref1 = extractRefereeInfo(item, 'activeRefereeConvocationFirstHeadReferee')
  const ref2 = extractRefereeInfo(item, 'activeRefereeConvocationSecondHeadReferee')

  const leagueName = String(germanText(leagueCat) ?? '')
  const nameLower = leagueName.toLowerCase()
  const genderCode = league.gender ?? ''
  const juniorFlag = typeof leagueCat.isJuniorLeagueCategory === 'boolean' ? leagueCat.isJuniorLeagueCategory : null
  const shortText = String(germanText(leagueCat, 'shortName') ?? '')

  const isCup = nameLower.includes('cup') || nameLower.includes('pokal')
  const matchGender = genderCode === 'm' ? 'men' : genderCode === 'f' ? 'women' : ''
  const isJunior = juniorFlag === true || AGE_CLASS_RE.test(leagueName) || AGE_CLASS_RE.test(shortText) || JUNIOR_WORDS_RE.test(leagueName)
  const matchLevel = isJunior ? 'junior' : 'senior'

  // League text (e.g. "3L B", "1L D"); group display "Gruppe B" or "#27051 | D"
  const leagueShort = germanText(leagueCat, 'shortName') ?? leagueName
  const groupDisplay = grp.displayName ?? ''
  const gruppeMatch = String(groupDisplay).match(/Gruppe\s+([A-Z0-9]+)/) || String(groupDisplay).match(/\|\s*([A-Z0-9]+)\s*$/)
  const leagueText = gruppeMatch ? `${leagueShort} ${gruppeMatch[1]}` : leagueShort

  const matchFormat = matchFormatOf(league.numberOfWinSets)

  const rawDt = typeof g.startingDateTime === 'string' ? g.startingDateTime : ''
  const kickoff = parseVmDateTime(rawDt, tz)
  const { date: gameDate, time: gameTime } = kickoff ? formatZurichDateTime(kickoff, tz) : { date: '', time: '' }

  const convocations = []
  if (Array.isArray(item.refereeConvocations)) {
    for (const c of item.refereeConvocations) {
      const name = deepGet(c, 'indoorAssociationReferee', 'indoorReferee', 'person', 'displayName')
      if (name) convocations.push(String(name))
    }
  }

  const str = (v) => (v == null ? '' : String(v))
  return {
    game_number: str(g.number),
    date: gameDate,
    time: gameTime,
    datetime: rawDt,
    city: str(addr.city),
    hall: str(germanText(hall)),
    match_type: isCup ? 'cup' : 'championship',
    championship_type: ((nameLower.includes('1l') || nameLower.includes('1. liga')) && matchLevel === 'senior') ? 'national' : 'regional',
    gender: matchGender,
    match_level: matchLevel,
    league: str(leagueText),
    league_category: str(germanText(leagueCat)),
    junior_category: juniorFlag,
    match_format: matchFormat,
    team_home: str(teamName(home)),
    team_away: str(teamName(away)),
    referee_1: str(ref1.name ?? item.activeFirstHeadRefereeName),
    referee_1_first_name: str(ref1.firstName),
    referee_1_last_name: str(ref1.lastName),
    // db/051: null without a convocation (a name alone carries no number)
    referee_1_licence: ref1.licence,
    referee_2: str(ref2.name ?? item.activeSecondHeadRefereeName),
    referee_2_first_name: str(ref2.firstName),
    referee_2_last_name: str(ref2.lastName),
    referee_2_licence: ref2.licence,
    hall_address: str(addr.combinedAddress),
    hall_postal_code: str(addr.postalCode),
    group_display: str(groupDisplay),
    phase_name: str(germanText(phase)),
    linesman_1: str(item.activeFirstLinesmanRefereeName),
    linesman_2: str(item.activeSecondLinesmanRefereeName),
    is_supervised: !!item.isSupervised,
    has_supervised_referee: !!item.hasAtLeastOneRefereeIntendedToBeSupervised,
    convocations,
    synced_at: (syncedAt instanceof Date ? syncedAt : new Date(syncedAt)).toISOString()
  }
}

export function isExcludedLeague(league) {
  const words = String(league ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u)
  return words.some((w) => EXCLUDED_LEAGUES.includes(w))
}

/**
 * Transforms, drops rows without a game number and NL leagues, and de-duplicates
 * by game_number (last one wins: one INSERT .. ON CONFLICT cannot touch the same
 * row twice). `numbers`: every game number VolleyManager returned (the NL ones
 * too: a game it returns is not cancelled); `excludedLeagues`: the league texts
 * left out, for the run's log line.
 */
export function prepareRows(items, opts = {}) {
  const all = (items || []).map((it) => transformGame(it, opts)).filter((r) => r.game_number)
  const kept = all.filter((r) => !isExcludedLeague(r.league))
  const byNumber = new Map()
  for (const r of kept) byNumber.set(r.game_number, r)
  const excludedLeagues = [...new Set(all.filter((r) => isExcludedLeague(r.league)).map((r) => r.league))]
  return {
    rows: [...byNumber.values()],
    numbers: new Set(all.map((r) => r.game_number)),
    transformed: all.length,
    excluded: all.length - kept.length,
    excludedLeagues,
    duplicates: kept.length - byNumber.size
  }
}

// ---------------------------------------------------------------------------
// League calendars (no login): VM_ICAL_FEEDS
// ---------------------------------------------------------------------------

export const ICAL_SCHEDULE_PATH = '/iCal/schedule/'
const ROOKIE_FUTURE_RE = /\b(rookie|future)\b/i

/**
 * VM_ICAL_FEEDS -> the calendars' https links. Entries are separated by
 * spaces, commas or new lines; each is a 40-hex token or a webcal:// /
 * https:// link to VolleyManager. An empty or unset value -> [].
 */
export function icalFeedsFromEnv(env = process.env, { baseUrl = VM_BASE } = {}) {
  const raw = String(env.VM_ICAL_FEEDS ?? '').trim()
  if (!raw) return []
  return [...new Set(raw.split(/[\s,]+/).filter(Boolean).map((entry) => {
    if (/^[0-9a-f]{40}$/i.test(entry)) return `${baseUrl}${ICAL_SCHEDULE_PATH}${entry.toLowerCase()}`
    const url = entry.replace(/^webcal:\/\//i, 'https://')
    if (!url.startsWith(`${baseUrl}${ICAL_SCHEDULE_PATH}`)) throw new Error(`VM_ICAL_FEEDS: not a VolleyManager league calendar: ${entry.slice(0, 80)}`)
    return url
  }))]
}

/** VolleyManager's own datetime shape, so a calendar row compares equal to a login-sync row. */
function vmIsoDateTime(instant) {
  return `${instant.toISOString().slice(0, 19)}.000000+00:00`
}

/**
 * One calendar game -> a svrz_games row. The calendar has no referees, line
 * judges, licences, supervision marks, group or number of win sets: those are
 * null / '' here (mergeWithStored keeps what the schedule already knows).
 */
export function icalGameToRow(game, calendar, { syncedAt = new Date() } = {}) {
  const s = game.start
  const kickoff = s.tz === 'UTC'
    ? new Date(Date.UTC(+s.ymd.slice(0, 4), +s.ymd.slice(5, 7) - 1, +s.ymd.slice(8, 10), s.hour, s.minute))
    : zonedTimeToUtc(s.ymd, s.hour, s.minute, s.tz)
  const { date, time } = formatZurichDateTime(kickoff)
  const league = calendar.league
  const junior = AGE_CLASS_RE.test(league) || JUNIOR_WORDS_RE.test(league) || ROOKIE_FUTURE_RE.test(league)
  const senior1L = /^1l\b|1\. liga/i.test(league) && !junior
  return {
    game_number: game.game_number,
    date, time,
    datetime: vmIsoDateTime(kickoff),
    city: game.city,
    hall: game.hall,
    match_type: /cup|pokal/i.test(league) ? 'cup' : 'championship',
    championship_type: senior1L ? 'national' : 'regional',
    gender: calendar.gender,
    match_level: junior ? 'junior' : 'senior',
    league,
    league_category: league,
    junior_category: junior,
    match_format: null,
    team_home: game.team_home,
    team_away: game.team_away,
    referee_1: null, referee_1_first_name: null, referee_1_last_name: null, referee_1_licence: null,
    referee_2: null, referee_2_first_name: null, referee_2_last_name: null, referee_2_licence: null,
    hall_address: game.street,
    hall_postal_code: game.postalCode,
    group_display: '',
    phase_name: '',
    linesman_1: null, linesman_2: null,
    is_supervised: false, has_supervised_referee: false, convocations: [],
    synced_at: (syncedAt instanceof Date ? syncedAt : new Date(syncedAt)).toISOString()
  }
}

/** "3L B" belongs to the calendar league "3L"; "2L" to "2L". */
const sameLeague = (stored, league) => !!stored && (stored === league || stored.startsWith(`${league} `))

/**
 * Keeps what the schedule already knows and a calendar does not say:
 *  - the group letter ("3L B": the calendar says "3L"), for a game already
 *    stored or, for a new one, from either team's other games in that league
 *  - the street with its number (the calendar drops the number)
 *  - the number of win sets, else the league's usual one
 *  - group / phase texts and the VolleyManager category
 * Referees and line judges are NOT kept: the calendar cannot say whether a
 * crew changed, and a stale name would be pre-filled on an official sheet.
 *
 * `stored`: [{ game_number, league, gender, team_home, team_away, hall_address,
 * match_format, group_display, phase_name, league_category }].
 */
export function mergeWithStored(rows, stored) {
  const byNumber = new Map(stored.map((r) => [r.game_number, r]))
  const groupOfTeam = new Map() // "women|3L|team" -> "3L B"
  const formats = new Map() // "women|3L" -> { 5: n, 3: m }
  for (const r of stored) {
    if (!r.league) continue
    const base = r.league.replace(/\s+[A-Z]$/, '') // group letters: "3L B"; not "Rookie 2"
    if (base !== r.league) {
      for (const t of [r.team_home, r.team_away]) if (t) groupOfTeam.set(`${r.gender}|${base}|${t.trim()}`, r.league)
    }
    if (r.match_format != null) {
      const k = `${r.gender}|${base}`
      const counts = formats.get(k) ?? {}
      counts[r.match_format] = (counts[r.match_format] ?? 0) + 1
      formats.set(k, counts)
    }
  }
  const usualFormat = (gender, league) => {
    const counts = formats.get(`${gender}|${league}`)
    if (!counts) return null
    return Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0])
  }
  return rows.map((row) => {
    const old = byNumber.get(row.game_number)
    const out = { ...row }
    if (old && sameLeague(old.league, row.league)) out.league = old.league
    else {
      const group = groupOfTeam.get(`${row.gender}|${row.league}|${row.team_home}`) ?? groupOfTeam.get(`${row.gender}|${row.league}|${row.team_away}`)
      if (group) out.league = group
    }
    if (old?.hall_address && row.hall_address && old.hall_address.startsWith(row.hall_address)) out.hall_address = old.hall_address
    // without the group letter: a Game Center row already says "3L B", the usual formats are kept per "3L"
    out.match_format = row.match_format ?? old?.match_format ?? usualFormat(row.gender, row.league.replace(/\s+[A-Z]$/, ''))
    if (old?.group_display) out.group_display = old.group_display
    if (old?.phase_name) out.phase_name = old.phase_name
    if (old?.league_category) out.league_category = old.league_category
    return out
  })
}

/**
 * Fetches and parses every calendar. Never throws for one calendar: a failed
 * or empty one is listed in `failed`, and the run must then remove nothing.
 * -> { rows, covered: Map("gender|league" -> Set(team names)), failed: [{ url, error }], skipped }
 */
export async function fetchIcalFeeds(urls, { fetch: fetchImpl, http = {}, logger = null, syncedAt = new Date(), sleep = defaultSleep, delayMs = 500 } = {}) {
  const rows = []
  const covered = new Map()
  const failed = []
  let skipped = 0
  for (const [i, url] of urls.entries()) {
    if (i && delayMs) await sleep(delayMs) // a calendar client's pace, not a burst
    const label = `calendar ${url.slice(-8)}`
    try {
      const resp = await fetchWithRetry(fetchImpl, url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/calendar' } }, { label, logger, ...http })
      if (!resp.ok) throw new VmHttpError(`${label}: HTTP ${resp.status}`, { status: resp.status })
      const parsed = parseLeagueCalendar(resp.body)
      if (!parsed.calendar.league || !parsed.calendar.gender) throw new Error(`${label}: no league name / gender in the calendar`)
      if (!parsed.games.length) throw new Error(`${label}: no games (${parsed.calendar.league})`)
      skipped += parsed.skipped
      const key = `${parsed.calendar.gender}|${parsed.calendar.league}`
      const teams = covered.get(key) ?? new Set()
      covered.set(key, teams)
      for (const g of parsed.games) {
        rows.push(icalGameToRow(g, parsed.calendar, { syncedAt }))
        teams.add(g.team_home.trim())
        teams.add(g.team_away.trim())
      }
    } catch (err) {
      failed.push({ url, error: err?.message ?? String(err) })
      logger?.warn?.(`vm-sync: ${err?.message ?? err}`)
    }
  }
  return { rows, covered, failed, skipped }
}

// ---------------------------------------------------------------------------
// Swiss Volley Game Center (no login): VM_GAME_CENTER_REGIONS
// ---------------------------------------------------------------------------

/**
 * VM_GAME_CENTER_REGIONS -> region codes ("SVRZ", "SVRA", … "SV" = Swiss
 * Volley's national competitions), upper-cased, de-duplicated. Empty -> [].
 */
export function gameCenterRegionsFromEnv(env = process.env) {
  const raw = String(env.VM_GAME_CENTER_REGIONS ?? '').trim()
  if (!raw) return []
  return [...new Set(raw.split(/[\s,]+/).filter(Boolean).map((r) => {
    if (!/^[a-z]{2,8}$/i.test(r)) throw new Error(`VM_GAME_CENTER_REGIONS: not a region code: ${r.slice(0, 20)}`)
    return r.toUpperCase()
  }))]
}

/** A Game Center referee as the person refereeLicenceOf reads (its refereeId is the SV number). */
const gcReferee = (r) => {
  if (!r || typeof r !== 'object') return { name: '', firstName: '', lastName: '', licence: null }
  const firstName = String(r.firstName ?? '').trim()
  const lastName = String(r.lastName ?? '').trim()
  return { name: `${firstName} ${lastName}`.trim(), firstName, lastName, licence: refereeLicenceOf({ associationId: r.refereeId }) }
}

/**
 * One Game Center game (lib/gameCenter.js) -> a svrz_games row, the columns
 * transformGame writes from a login search: the referees with their SV numbers
 * (licence), the group letter, the street with its number and the best-of
 * format all come with it. Not published there: line judges (SVRZ has none)
 * and the supervision marks.
 */
export function gameCenterGameToRow(g, { syncedAt = new Date() } = {}) {
  const str = (v) => (v == null ? '' : String(v).trim())
  const league = g.league ?? {}
  const grp = g.group ?? {}
  const hall = g.hall ?? {}
  const caption = str(league.caption)
  const kickoff = g.playDateUtc ? new Date(g.playDateUtc) : null
  const valid = kickoff && !Number.isNaN(kickoff.getTime())
  const { date, time } = valid ? formatZurichDateTime(kickoff) : { date: '', time: '' }
  const junior = AGE_CLASS_RE.test(caption) || JUNIOR_WORDS_RE.test(caption) || ROOKIE_FUTURE_RE.test(caption)
  const groupDisplay = str(grp.caption)
  // "Männer 3. Liga Gruppe A" -> A; 1L names its groups with the bare letter ("D")
  const letter = groupDisplay.match(/Gruppe\s+([A-Z0-9]+)/) || groupDisplay.match(/\|\s*([A-Z0-9]+)\s*$/) || groupDisplay.match(/^([A-Z])$/)
  const r1 = gcReferee(g.referees?.['1'])
  const r2 = gcReferee(g.referees?.['2'])
  return {
    game_number: str(g.gameId),
    date, time,
    datetime: valid ? vmIsoDateTime(kickoff) : '',
    city: str(hall.city),
    hall: str(hall.caption),
    match_type: /cup|pokal/i.test(caption) ? 'cup' : 'championship',
    championship_type: /^1l\b|1\. liga/i.test(caption) && !junior ? 'national' : 'regional',
    gender: g.gender === 'm' ? 'men' : g.gender === 'f' ? 'women' : '',
    match_level: junior ? 'junior' : 'senior',
    league: letter ? `${caption} ${letter[1]}` : caption,
    league_category: caption,
    junior_category: junior,
    match_format: matchFormatOf(league.numberOfWinSets),
    team_home: str(g.teams?.home?.caption),
    team_away: str(g.teams?.away?.caption),
    referee_1: r1.name, referee_1_first_name: r1.firstName, referee_1_last_name: r1.lastName, referee_1_licence: r1.licence,
    referee_2: r2.name, referee_2_first_name: r2.firstName, referee_2_last_name: r2.lastName, referee_2_licence: r2.licence,
    hall_address: [str(hall.street), str(hall.number)].filter(Boolean).join(' '),
    hall_postal_code: str(hall.zip),
    group_display: groupDisplay,
    phase_name: str(g.phase?.caption),
    linesman_1: '', linesman_2: '',
    is_supervised: false, has_supervised_referee: false,
    convocations: [r1.name, r2.name].filter(Boolean),
    synced_at: (syncedAt instanceof Date ? syncedAt : new Date(syncedAt)).toISOString()
  }
}

/**
 * Game Center games -> rows, the way prepareRows treats a login search (NL
 * dropped, one row per game number), plus the leagues and teams the answer
 * covers: a stored game outside them (another region, 1L when only SVRZ is
 * read) is never taken for removed.
 */
export function prepareGameCenterRows(games, opts = {}) {
  const all = (games || []).map((g) => gameCenterGameToRow(g, opts)).filter((r) => r.game_number)
  const kept = all.filter((r) => !isExcludedLeague(r.league))
  const byNumber = new Map()
  const covered = new Map()
  for (const r of kept) {
    byNumber.set(r.game_number, r)
    const key = `${r.gender}|${r.league.replace(/\s+[A-Z]$/, '')}`
    const teams = covered.get(key) ?? new Set()
    covered.set(key, teams)
    // keyed without the group letter: coveredByCalendars tries "3L B", then "3L"
    for (const t of [r.team_home, r.team_away]) if (t) teams.add(t)
  }
  return {
    rows: [...byNumber.values()],
    numbers: new Set(all.map((r) => r.game_number)),
    transformed: all.length,
    excluded: all.length - kept.length,
    excludedLeagues: [...new Set(all.filter((r) => isExcludedLeague(r.league)).map((r) => r.league))],
    duplicates: kept.length - byNumber.size,
    covered
  }
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/**
 * svrz_games columns written by the sync, with their Postgres types
 * (referee_1_licence / referee_2_licence: db/051, so a backend with this list
 * needs that migration; deploy.sh runs it before the switch). No
 * referee_1_dob / referee_2_dob: NULL since db/048, never written again, and
 * db/049 drops them (the sync never names them, so it runs before and after
 * that migration alike).
 */
export const GAME_COLUMNS = [
  ['game_number', 'text'], ['date', 'text'], ['time', 'text'], ['datetime', 'text'],
  ['city', 'text'], ['hall', 'text'], ['match_type', 'text'], ['championship_type', 'text'],
  ['gender', 'text'], ['match_level', 'text'], ['league', 'text'], ['league_category', 'text'], ['junior_category', 'boolean'],
  ['match_format', 'integer'],
  ['team_home', 'text'], ['team_away', 'text'],
  ['referee_1', 'text'], ['referee_1_first_name', 'text'], ['referee_1_last_name', 'text'], ['referee_1_licence', 'text'],
  ['referee_2', 'text'], ['referee_2_first_name', 'text'], ['referee_2_last_name', 'text'], ['referee_2_licence', 'text'],
  ['hall_address', 'text'], ['hall_postal_code', 'text'], ['group_display', 'text'], ['phase_name', 'text'],
  ['linesman_1', 'text'], ['linesman_2', 'text'],
  ['is_supervised', 'boolean'], ['has_supervised_referee', 'boolean'], ['convocations', 'jsonb']
]

const q = (ident) => `"${ident}"`

/**
 * One statement per batch: $1 = jsonb array of rows, $2 = synced_at.
 * `prev` is read from the statement's snapshot (before the upsert), so it holds
 * the old values: rows whose data columns did not change count as unchanged
 * (they still get the new synced_at). xmax = 0 marks freshly inserted rows.
 */
export const UPSERT_SQL = (() => {
  const cols = GAME_COLUMNS.map(([c]) => q(c))
  const recordDef = GAME_COLUMNS.map(([c, t]) => `${q(c)} ${t}`).join(', ')
  const dataCols = GAME_COLUMNS.filter(([c]) => c !== 'game_number').map(([c]) => q(c))
  return `WITH input AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(${recordDef})
),
prev AS (
  SELECT g.game_number,
         (${dataCols.map((c) => `g.${c}`).join(', ')}) IS NOT DISTINCT FROM (${dataCols.map((c) => `i.${c}`).join(', ')}) AS same
    FROM public.svrz_games g
    JOIN input i ON i.game_number = g.game_number
),
up AS (
  INSERT INTO public.svrz_games (${cols.join(', ')}, synced_at)
  SELECT ${cols.join(', ')}, $2::timestamptz FROM input
  ON CONFLICT (game_number) DO UPDATE SET
    ${[...dataCols, '"synced_at"'].map((c) => `${c} = EXCLUDED.${c}`).join(',\n    ')}
  RETURNING game_number, (xmax = 0) AS inserted
)
SELECT count(*) FILTER (WHERE up.inserted)::int AS created,
       count(*) FILTER (WHERE NOT up.inserted AND NOT coalesce(prev.same, false))::int AS updated,
       count(*) FILTER (WHERE NOT up.inserted AND prev.same)::int AS unchanged
  FROM up LEFT JOIN prev ON prev.game_number = up.game_number`
})()

async function upsertBatch(client, rows, syncedAt) {
  const payload = rows.map((r) => {
    const o = {}
    for (const [c] of GAME_COLUMNS) o[c] = r[c] ?? null
    return o
  })
  const { rows: [res] } = await client.query(UPSERT_SQL, [JSON.stringify(payload), syncedAt.toISOString()])
  return { created: res?.created ?? 0, updated: res?.updated ?? 0, unchanged: res?.unchanged ?? 0 }
}

/** Closes 'running' rows older than `olderThanMs` as 'failed'. Returns how many. */
export async function closeStaleRunningRows(client, { olderThanMs = STALE_RUNNING_MS } = {}) {
  const { rowCount } = await client.query(
    `UPDATE public.svrz_sync_log
        SET status = 'failed',
            finished_at = now(),
            message = left(coalesce(nullif(message, '') || ' | ', '') || 'abandoned: still running after ' || $1::text || ' min (process died?)', 1000)
      WHERE status = 'running'
        AND started_at < now() - make_interval(secs => $2::double precision)`,
    [String(Math.round(olderThanMs / 60000)), olderThanMs / 1000]
  )
  return rowCount ?? 0
}

/**
 * The stored games of the window that kick off between `from` and the
 * window's end (instants, ms): [{ game_number, datetime }]. The text filter
 * is a day wider on each side (datetime is VolleyManager's raw ISO text, with
 * or without an offset); parseVmDateTime decides.
 */
async function storedUpcoming(client, win, from) {
  const { rows } = await client.query(
    'SELECT game_number, datetime, league, gender, team_home, team_away FROM public.svrz_games WHERE datetime >= $1 AND datetime < $2',
    [addDaysYmd(win.fromDay, -1), addDaysYmd(win.toDay, 2)])
  const to = Date.parse(win.dateTo)
  const start = Math.max(from, Date.parse(win.dateFrom))
  return rows.filter((r) => {
    const t = parseVmDateTime(r.datetime)?.getTime()
    return t != null && t >= start && t <= to
  })
}

/** The season's stored games, for mergeWithStored (group letters, streets, formats). */
async function storedForMerge(client, win) {
  const { rows } = await client.query(
    `SELECT game_number, league, gender, team_home, team_away, hall_address, match_format, group_display, phase_name, league_category
       FROM public.svrz_games WHERE datetime >= $1`, [addDaysYmd(win.fromDay, -365)])
  return rows
}

/**
 * A stored game the calendars answer for: its league ("3L B" -> "3L") has a
 * calendar AND one of its teams plays in that calendar. Several leagues share
 * a name (three "U23 ♀" in SVRZ): a league whose link is missing must not
 * lose its games because another one of the same name was read (27.11.2026:
 * 49 U23 games were removed that way, and came back with the third link).
 */
const coveredByCalendars = (row, covered) => {
  const teams = covered.get(`${row.gender}|${row.league}`) ?? covered.get(`${row.gender}|${String(row.league ?? '').replace(/\s+[A-Z]$/, '')}`)
  return !!teams && (teams.has(String(row.team_home ?? '').trim()) || teams.has(String(row.team_away ?? '').trim()))
}

/** Moves the games out of svrz_games into svrz_games_removed (db/041); returns their numbers. */
async function removeGames(client, numbers, logId) {
  const { rows } = await client.query(
    `WITH gone AS (
       DELETE FROM public.svrz_games g WHERE g.game_number = ANY($1::text[])
       RETURNING g.game_number, g.datetime, g.league, g.team_home, g.team_away, g.hall, g.synced_at
     )
     INSERT INTO public.svrz_games_removed (game_number, datetime, league, team_home, team_away, hall, last_synced_at, removed_at, sync_log_id)
     SELECT game_number, datetime, league, team_home, team_away, hall, synced_at, now(), $2 FROM gone
     ON CONFLICT (game_number) DO UPDATE SET
       datetime = EXCLUDED.datetime, league = EXCLUDED.league, team_home = EXCLUDED.team_home, team_away = EXCLUDED.team_away,
       hall = EXCLUDED.hall, last_synced_at = EXCLUDED.last_synced_at, removed_at = EXCLUDED.removed_at, sync_log_id = EXCLUDED.sync_log_id
     RETURNING game_number`, [numbers, logId])
  return rows.map((r) => r.game_number)
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function wrapLogger(logger, redact) {
  const base = logger || console
  const fn = (lvl) => (...args) => {
    const f = base[lvl] || base.info || base.log || (() => {})
    f.call(base, args.map((a) => redact(a)).join(' '))
  }
  return { log: fn('log'), info: fn('log'), warn: fn('warn'), error: fn('error') }
}

/**
 * Runs one sync. Never throws for a sync failure: the result says what happened
 * ({ status: 'success' | 'partial' | 'failed' | 'skipped', ... }). It throws
 * only for programming errors (no pool, bad window).
 *
 * A complete run (every page, every batch written) then moves the window's
 * games that kick off after its start and that VolleyManager no longer
 * returned out of svrz_games (removeGames; `removed`), so the club rule,
 * today's games and the loader stop offering a cancelled, renumbered or moved
 * game. No games at all while the schedule holds upcoming ones, or more than
 * REMOVAL_GUARD_MIN and half of them missing, is 'partial' and removes nothing.
 * So are pages that overlapped (fewer distinct game numbers than the total).
 * `withoutFormat`: rows written with match_format NULL (VolleyManager gave no
 * number of win sets the sync knows).
 *
 * @param {object} o
 * @param {{connect: Function}} [o.pool]   pg Pool (or compatible). Not needed with dryRun.
 * @param {Function} [o.fetch]             fetch implementation (default globalThis.fetch)
 * @param {Date|Function} [o.now]          clock (Date or () => Date)
 * @param {object} [o.window]              see resolveWindow (default Zurich today -1 .. +14)
 * @param {object} [o.logger]              console-like; every line is scrubbed of secrets
 * @param {{username: string, password: string}} o.credentials
 * @param {string} [o.baseUrl]             VolleyManager origin (tests)
 * @param {object} [o.http]                { timeoutMs, retries, backoffMs, sleep, searchTimeoutMs, searchRetries }
 * @param {number} [o.batchSize]           rows per database upsert
 * @param {number} [o.pageSize]            games per search page (SEARCH_PAGE_SIZE; halved on a failing page)
 * @param {boolean} [o.dryRun]             fetch + transform only, no database
 * @param {string} [o.roleAttribute]       the account's referee-delegate role (VM_ROLE_FOR_GAMES)
 * @param {string|null} [o.redactionSecret] OV_PIN_SECRET: the key of the register of people
 *                                         erased on request (db/052); needed once it has entries
 */
export async function runVmSync({
  pool,
  fetch: fetchImpl = globalThis.fetch,
  now = () => new Date(),
  window,
  logger,
  credentials = {},
  roleAttribute = VM_ROLE_FOR_GAMES,
  baseUrl = VM_BASE,
  http = {},
  batchSize = BATCH_SIZE,
  pageSize = SEARCH_PAGE_SIZE,
  pageDelayMs = 100,
  dryRun = false,
  staleRunningMs = STALE_RUNNING_MS,
  redactionSecret = null,
  feeds = [],
  calendarDelayMs = 500,
  gameCenterRegions = []
} = {}) {
  // The Swiss Volley Game Center (VM_GAME_CENTER_REGIONS): no login, referees
  // with their SV numbers; wins over the calendars, which name no referee
  const gcMode = Array.isArray(gameCenterRegions) && gameCenterRegions.length > 0
  // League calendars (VM_ICAL_FEEDS): no login, no role, no referees
  const icalMode = !gcMode && Array.isArray(feeds) && feeds.length > 0
  const clock = typeof now === 'function' ? now : () => new Date(now)
  const startedAt = clock()
  const win = resolveWindow(window, { now: startedAt })
  if (!dryRun && (!pool || typeof pool.connect !== 'function')) throw new TypeError('runVmSync: pool with connect() required')
  if (typeof fetchImpl !== 'function') throw new TypeError('runVmSync: fetch implementation required')

  let csrfToken = null
  let jar = null
  const redact = createRedactor(() => [credentials.password, credentials.username, csrfToken, ...(jar ? jar.values() : [])])
  const log = wrapLogger(logger, redact)
  const dateLabel = win.fromDay === win.toDay ? win.fromDay : `${win.fromDay} → ${win.toDay}`
  const result = {
    status: 'failed', logId: null, window: win, fetched: 0, total: 0, kept: 0, excluded: 0,
    created: 0, updated: 0, unchanged: 0, written: 0, withoutFormat: 0, removed: 0, withheld: 0, errors: 0, elapsedMs: 0, message: '', dryRun
  }
  const elapsed = () => ((clock().getTime() - startedAt.getTime()) / 1000).toFixed(1)

  let client = null
  let locked = false
  // The client stays checked out (holding the session lock) through about a
  // minute of VolleyManager I/O with no query running. pg-pool drops its own
  // 'error' listener while a client is checked out, so without this one a
  // dropped connection (Postgres restart, pg_terminate_backend, network) would
  // be an unhandled 'error' event and take the whole server down.
  let clientErr = null
  const onClientError = (err) => {
    if (!clientErr) log.error(`vm-sync: database connection lost: ${redact(err)}`)
    clientErr = clientErr || err || new Error('connection error')
  }
  try {
    if (!dryRun) {
      client = await pool.connect()
      client.on?.('error', onClientError)
      const { rows: [lk] } = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS ok', [ADVISORY_LOCK_KEY])
      locked = !!lk?.ok
      if (!locked) {
        result.status = 'skipped'
        result.message = 'another vm-sync run holds the lock'
        log.warn(`vm-sync: skipped, ${result.message}`)
        return result
      }
      const closed = await closeStaleRunningRows(client, { olderThanMs: staleRunningMs })
      if (closed) log.warn(`vm-sync: closed ${closed} abandoned 'running' log row(s)`)
      const { rows: [row] } = await client.query(
        `INSERT INTO public.svrz_sync_log (status, message) VALUES ('running', $1) RETURNING id`,
        [`[${dateLabel}] running`]
      )
      result.logId = row?.id ?? null
    }

    log.log(`vm-sync: window ${dateLabel} (Europe/Zurich) = ${win.dateFrom} → ${win.dateTo}`)
    let fetched
    let prepared
    let covered = null
    if (gcMode) {
      log.log(`vm-sync: reading the Swiss Volley Game Center for ${gameCenterRegions.join(', ')}, no login`)
      // fetchGames throws on any failed call: a partial read never gets here
      const games = await fetchGameCenterGames(gameCenterRegions.map((region) => ({ region })), win.fromDay, win.toDay, fetchImpl)
      const from = Date.parse(win.dateFrom)
      const to = Date.parse(win.dateTo)
      const gc = prepareGameCenterRows(games, { syncedAt: clock() })
      const inWindow = gc.rows.filter((r) => { const t = Date.parse(r.datetime); return t >= from && t <= to })
      // the list carries no number of win sets: the stored format, else the league's usual one
      const rows = dryRun ? inWindow : mergeWithStored(inWindow, await storedForMerge(client, win))
      covered = gc.covered
      prepared = { ...gc, rows }
      fetched = { items: games, total: games.length, incomplete: false, pageError: null }
    } else if (icalMode) {
      log.log(`vm-sync: reading ${feeds.length} league calendar(s), no login`)
      const cal = await fetchIcalFeeds(feeds, { fetch: fetchImpl, http, logger: log, syncedAt: clock(), sleep: http.sleep, delayMs: calendarDelayMs })
      const from = Date.parse(win.dateFrom)
      const to = Date.parse(win.dateTo)
      const inWindow = cal.rows.filter((r) => { const t = Date.parse(r.datetime); return t >= from && t <= to })
      const rows = dryRun ? inWindow : mergeWithStored(inWindow, await storedForMerge(client, win))
      const byNumber = new Map(rows.map((r) => [r.game_number, r]))
      covered = cal.covered
      prepared = { rows: [...byNumber.values()], numbers: new Set(byNumber.keys()), transformed: rows.length, excluded: 0, excludedLeagues: [], duplicates: rows.length - byNumber.size }
      fetched = {
        items: rows, total: rows.length, incomplete: cal.failed.length > 0,
        pageError: cal.failed.length ? `${cal.failed.length} of ${feeds.length} calendar(s) failed, first: ${cal.failed[0].error}` : null
      }
      if (cal.skipped) log.warn(`vm-sync: ${cal.skipped} calendar event(s) without a game number or start skipped`)
    } else {
      ;({ jar, csrfToken } = await vmLogin(credentials, { fetch: fetchImpl, baseUrl, http, logger: log, roleAttribute }))
      fetched = await fetchAllGames(jar, csrfToken, win.dateFrom, win.dateTo, {
        fetch: fetchImpl, baseUrl, http, logger: log, batchSize: pageSize, pageDelayMs, sleep: http.sleep
      })
    }
    result.fetched = fetched.items.length
    result.total = fetched.total

    // Raw startingDateTime shapes (no secrets in them), so a dry run shows
    // whether VM sends Z/offsets or Zurich wall-clock times.
    const rawTimes = icalMode || gcMode ? [] : fetched.items.map((it) => it?.game?.startingDateTime).filter((v) => typeof v === 'string' && v.trim())
    result.datetimeSamples = [...new Set(rawTimes)].slice(0, 5)
    result.offsetlessDatetimes = rawTimes.filter(isOffsetlessVmDateTime).length
    result.unparsedDatetimes = rawTimes.filter((v) => !parseVmDateTime(v)).length
    if (result.offsetlessDatetimes) {
      log.warn(`vm-sync: ${result.offsetlessDatetimes} startingDateTime value(s) without Z/offset, read as Europe/Zurich wall-clock time (e.g. ${rawTimes.find(isOffsetlessVmDateTime)})`)
    }
    if (result.unparsedDatetimes) {
      log.warn(`vm-sync: ${result.unparsedDatetimes} startingDateTime value(s) not ISO 8601, stored with empty date/time`)
    }

    if (!icalMode && !gcMode) prepared = prepareRows(fetched.items, { syncedAt: clock() })
    result.kept = prepared.rows.length
    result.excluded = prepared.excluded
    result.excludedLeagues = prepared.excludedLeagues
    result.withoutFormat = prepared.rows.filter((r) => r.match_format == null).length
    log.log(`vm-sync: ${prepared.transformed} game(s) transformed, ${prepared.excluded} NL excluded, ${prepared.rows.length} to write` +
      (prepared.duplicates ? ` (${prepared.duplicates} duplicate game number(s) merged)` : ''))

    const batchErrors = []
    // the upcoming games the schedule holds before this run (a moved game keeps its old time here)
    const upcoming = dryRun ? [] : await storedUpcoming(client, win, startedAt.getTime())
    if (!dryRun) {
      // People erased on request (db/052): their places stay empty. Read under
      // the run's lock, right before the writes; entries without the key to
      // check them would let the names back in, so the run writes nothing.
      // a calendar run writes no referee or line judge: nothing to withhold;
      // a Game Center run names the referees, so the register is read again
      const register = icalMode ? new Map() : await loadRegister(client)
      let rows = prepared.rows
      if (register.size) {
        let key
        try {
          key = redactedPeopleKey(redactionSecret)
        } catch {
          throw new Error(`the register of people erased on request (db/052) has ${register.size} entr${register.size === 1 ? 'y' : 'ies'} and OV_PIN_SECRET is not set to check them: nothing written`)
        }
        ;({ rows, withheld: result.withheld } = withholdRedacted(rows, createRedactedMatcher(register, key)))
        if (result.withheld) log.log(`vm-sync: ${result.withheld} referee / line judge place(s) left empty (erased on request)`)
      }
      const syncedAt = clock()
      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize)
        try {
          const c = await upsertBatch(client, batch, syncedAt)
          result.created += c.created
          result.updated += c.updated
          result.unchanged += c.unchanged
          // back in VolleyManager: no longer a removed game
          await client.query('DELETE FROM public.svrz_games_removed WHERE game_number = ANY($1::text[])', [batch.map((r) => r.game_number)])
        } catch (err) {
          result.errors += batch.length
          const msg = redact(err)
          batchErrors.push(msg)
          log.error(`vm-sync: batch at offset ${i} failed: ${msg}`)
        }
      }
    }
    result.written = result.created + result.updated + result.unchanged

    // LOG-24: club_teams, saved teams and older schedule rows follow the
    // region's names the run wrote; never fails the run
    // (login searches only: the renames come from VolleyManager's translation objects)
    if (!dryRun && !icalMode && !gcMode) {
      try {
        const renamed = await followTeamRenames(client, teamNameRenames(fetched.items))
        result.renamedTeams = renamed
        if (renamed.clubTeams || renamed.savedTeams || renamed.games) {
          log.log(`vm-sync: team names in their region's language: ${renamed.clubTeams} club team(s), ${renamed.savedTeams} saved team(s), ${renamed.games} older schedule row(s)`)
        }
      } catch (err) {
        log.warn(`vm-sync: the region's team names could not be applied to the clubs and saved teams: ${redact(err)}`)
      }
    }

    // Offset paging sorts on the kick-off alone: when VolleyManager breaks a tie
    // differently between two page requests, a page can repeat one game and
    // skip another while the count still adds up. Fewer distinct games than
    // the total means some were skipped: nothing is removed, the run is partial.
    const distinct = prepared.numbers.size + (fetched.items.length - prepared.transformed)
    const overlap = !icalMode && !gcMode && !fetched.incomplete && distinct < fetched.total
      ? `${distinct} distinct of ${fetched.total} games (pages overlapped), none removed`
      : null
    if (overlap) log.warn(`vm-sync: ${overlap}`)

    // the cancelled, renumbered or moved games: only after a complete run
    let suspicious = overlap
    if (!dryRun && !fetched.incomplete && !overlap && result.errors === 0) {
      // a calendar or Game Center run answers only for its leagues and teams: 1L or cup
      // games stored by the login sync (or another region's) stay
      const inScope = covered ? upcoming.filter((r) => coveredByCalendars(r, covered)) : upcoming
      const gone = inScope.filter((r) => !prepared.numbers.has(r.game_number)).map((r) => r.game_number)
      if (gone.length && !fetched.items.length) {
        suspicious = `VolleyManager returned no games; the schedule holds ${inScope.length} upcoming in this window, none removed`
      } else if (gone.length > Math.max(REMOVAL_GUARD_MIN, Math.floor(inScope.length / 2))) {
        suspicious = `${gone.length} of ${inScope.length} upcoming games not returned, none removed (${gcMode ? 'check the Game Center' : icalMode ? 'check the calendars' : "check the account's role"})`
      } else if (gone.length) {
        result.removedGames = await removeGames(client, gone, result.logId)
        result.removed = result.removedGames.length
      }
      if (suspicious) log.warn(`vm-sync: ${suspicious}`)
    }

    const parts = [`[${dateLabel}] ${dryRun ? 'Dry run: fetched' : 'Synced'} ${prepared.rows.length} games${gcMode ? ` from the Game Center (${gameCenterRegions.join(', ')})` : icalMode ? ` from ${feeds.length} league calendar(s)` : ''} in ${elapsed()}s`]
    if (!dryRun) parts.push(`(${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged, ${result.errors} errors)`)
    if (result.withoutFormat) parts.push(`${result.withoutFormat} without a format`)
    if (result.withheld) parts.push(`${result.withheld} referee / line judge place(s) left empty (erased on request)`)
    if (result.renamedTeams?.clubTeams || result.renamedTeams?.savedTeams) parts.push(`${result.renamedTeams.clubTeams} club and ${result.renamedTeams.savedTeams} saved team name(s) now in their region's language`)
    if (prepared.excluded) parts.push(`${prepared.excluded} NL excluded (${prepared.excludedLeagues.slice(0, 10).join(', ')})`)
    if (result.removed) parts.push(`${result.removed} no longer in VolleyManager (${result.removedGames.slice(0, 20).join(', ')})`)
    if (suspicious) parts.push(`SUSPICIOUS: ${suspicious}`)
    if (fetched.incomplete) parts.push(`INCOMPLETE: ${fetched.items.length}/${fetched.total} fetched (${redact(fetched.pageError)})`)
    if (batchErrors.length) parts.push(`first error: ${batchErrors[0]}`)
    result.message = redact(parts.join(' '))
    if (result.errors > 0 && result.errors >= prepared.rows.length) result.status = 'failed'
    else if (result.errors > 0 || fetched.incomplete || suspicious) result.status = 'partial'
    else result.status = 'success'
  } catch (err) {
    result.status = 'failed'
    result.error = redact(err)
    result.message = redact(`[${dateLabel}] Failed after ${elapsed()}s: ${result.error}`)
  } finally {
    result.elapsedMs = clock().getTime() - startedAt.getTime()
    if (client) {
      if (result.logId != null) {
        const closeSql = `UPDATE public.svrz_sync_log
                SET finished_at = now(), games_fetched = $2, games_created = $3, games_updated = $4,
                    games_unchanged = $5, errors = $6, status = $7, message = $8,
                    games_without_format = $9, games_removed = $10
              WHERE id = $1`
        const closeParams = [result.logId, result.fetched, result.created, result.updated, result.unchanged,
          result.errors, result.status, result.message, result.withoutFormat, result.removed]
        let closed = false
        if (!clientErr) {
          try {
            await client.query(closeSql, closeParams)
            closed = true
          } catch (err) {
            log.warn(`vm-sync: closing log row ${result.logId} on the run's connection failed: ${redact(err)}`)
          }
        }
        // The run's connection is dead: close the row on a fresh one (no lock needed)
        if (!closed && typeof pool.query === 'function') {
          try {
            await pool.query(closeSql, closeParams)
            closed = true
          } catch (err) {
            log.warn(`vm-sync: closing log row ${result.logId} on a fresh connection failed: ${redact(err)}`)
          }
        }
        // Otherwise the next run (or db/003) closes it once it is older than an hour
        if (!closed) log.error(`vm-sync: could not close log row ${result.logId}`)
      }
      let releaseErr = clientErr
      if (locked && !clientErr) {
        try {
          await client.query('SELECT pg_advisory_unlock($1::bigint)', [ADVISORY_LOCK_KEY])
        } catch (err) {
          // Destroy the connection so the session (and its lock) cannot leak into the pool
          releaseErr = err
        }
      }
      // A truthy argument makes pg-pool discard the connection instead of reusing it.
      // release() re-attaches the pool's idle listener synchronously, so ours can go after it.
      try { client.release(releaseErr || undefined) } catch { /* ignore */ }
      client.removeListener?.('error', onClientError)
    }
  }
  if (result.status !== 'skipped') {
    const line = `vm-sync: ${result.status}: ${result.message}`
    if (result.status === 'failed') log.error(line)
    else log.log(line)
  }
  return result
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/** Next instant (> `from`) when the wall clock in `tz` reads hourLocal:minuteLocal. */
export function nextRunAt(from, { hourLocal = 6, minuteLocal = 0, tz = ZURICH_TZ } = {}) {
  let day = zonedYmd(from, tz)
  for (let i = 0; i < 3; i++) {
    const t = zonedTimeToUtc(day, hourLocal, minuteLocal, tz)
    if (t.getTime() > from.getTime()) return t
    day = addDaysYmd(day, 1)
  }
  throw new Error('nextRunAt: no slot found') // unreachable for valid input
}

/** Minutes after midnight of `date` in `tz`. */
function minutesOfDay(date, tz) {
  const p = zonedParts(date, tz)
  return p.hour * 60 + p.minute
}

/** Whether minute-of-day `m` is inside { from, to } (minutes; `to` before `from` wraps past midnight). */
export function inRunWindow(m, w) {
  if (!w) return true
  return w.from <= w.to ? m >= w.from && m < w.to : m >= w.from || m < w.to
}

/** A run that needs no retry: a success that wrote games (zero written in season means VolleyManager answered nothing). */
export const isGoodSync = (r) => r?.status === 'success' && r.written > 0

/**
 * Runs `run()` every day at hourLocal:minuteLocal in `tz` (default 06:00
 * Europe/Zurich, the Edge Function's cron hour, now in local time). Timers are
 * unref'd. Overlap inside this process is skipped here; across processes the
 * advisory lock in runVmSync does it. Errors from run() are logged, never thrown.
 *
 * With `retryDelaysMs`, a run that is no success (`isSuccess(result)`) is
 * tried again after each delay in turn, the same day: never at or after the
 * next daily slot, and only inside `allowedWindow` ({ from, to } minutes of
 * the day in `tz`; null: any time). With `catchUp` (() => readSyncRecord()),
 * the schedule looks once `startDelayMs` after it starts: a last success older
 * than `staleAfterMs` (or none) is caught up at once, inside the window and
 * unless the daily slot or a try of the last 15 minutes makes it needless.
 *
 * @returns {{ stop(): void, nextRunAt(): Date|null, runNow(): Promise<any>, status(): object }}
 */
export function scheduleVmSync({
  hourLocal = 6,
  minuteLocal = 0,
  tz = ZURICH_TZ,
  run,
  logger = console,
  now = () => new Date(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  retryDelaysMs = [],
  isSuccess = isGoodSync,
  allowedWindow = null,
  catchUp = null,
  staleAfterMs = SYNC_STALE_AFTER_MS,
  startDelayMs = 2 * 60000
} = {}) {
  if (typeof run !== 'function') throw new TypeError('scheduleVmSync: run() required')
  if (!Number.isInteger(hourLocal) || hourLocal < 0 || hourLocal > 23) throw new RangeError('hourLocal must be 0-23')
  if (!Number.isInteger(minuteLocal) || minuteLocal < 0 || minuteLocal > 59) throw new RangeError('minuteLocal must be 0-59')
  new Intl.DateTimeFormat('en', { timeZone: tz }) // throws RangeError on an unknown zone

  let timer = null
  let next = null
  let stopped = false
  let running = null
  let retryTimer = null
  let retryAt = null
  let retries = 0 // tries since the last daily slot or success
  let last = null // { at, status, written }
  const inWindow = (d) => inRunWindow(minutesOfDay(d, tz), allowedWindow)

  const clearRetry = () => {
    if (retryTimer) clearTimer(retryTimer)
    retryTimer = null
    retryAt = null
  }
  const afterRun = (result) => {
    last = { at: now().toISOString(), status: result?.status ?? null, written: result?.written ?? null }
    if (stopped || isSuccess(result)) {
      retries = 0
      clearRetry()
      return
    }
    if (retries >= retryDelaysMs.length) {
      if (retryDelaysMs.length) logger?.error?.(`[vm-sync] still no success after ${retries} retries; the next try is the daily run ${next?.toISOString() ?? ''}`)
      retries = 0
      return
    }
    const at = new Date(now().getTime() + retryDelaysMs[retries++])
    if (!inWindow(at) || (next && at.getTime() >= next.getTime())) {
      logger?.warn?.(`[vm-sync] no retry at ${at.toISOString()} (outside the run window or past the daily run); the next try is ${next?.toISOString() ?? 'the daily run'}`)
      retries = 0
      return
    }
    logger?.warn?.(`[vm-sync] ${result?.status ?? 'no result'}: trying again at ${at.toISOString()} (retry ${retries}/${retryDelaysMs.length})`)
    clearRetry()
    retryAt = at
    retryTimer = setTimer(() => {
      retryTimer = null
      retryAt = null
      if (!stopped) runOnce()
    }, Math.max(0, at.getTime() - now().getTime()))
    retryTimer?.unref?.()
  }

  const runOnce = () => {
    if (running) {
      logger?.warn?.('[vm-sync] previous run still in progress, skipping')
      return running
    }
    running = Promise.resolve()
      .then(() => run())
      .catch((err) => {
        logger?.error?.('[vm-sync] run failed:', err?.message || err)
        return { status: 'failed' }
      })
      .then(afterRun)
      .finally(() => { running = null })
    return running
  }

  // `after`: the slot that just ran, so a timer firing a little early cannot
  // pick the same slot again.
  const arm = (after = null) => {
    if (stopped) return
    const n = now()
    const from = after && after.getTime() > n.getTime() ? after : n
    next = nextRunAt(from, { hourLocal, minuteLocal, tz })
    // Cap the delay so a suspended host / clock jump re-evaluates within 6 h
    const delay = Math.min(next.getTime() - n.getTime(), 6 * 3600000)
    timer = setTimer(() => {
      timer = null
      if (stopped) return
      const slot = next
      if (now().getTime() + 1000 >= slot.getTime()) {
        retries = 0
        clearRetry()
        arm(slot)
        runOnce()
      } else {
        arm()
      }
    }, Math.max(0, delay))
    timer?.unref?.()
  }

  arm()
  logger?.log?.(`[vm-sync] scheduled daily at ${pad2(hourLocal)}:${pad2(minuteLocal)} ${tz}; next run ${next.toISOString()}`)

  // A run missed while the process was down (a deploy over the slot): once,
  // a little after the start
  let startTimer = null
  if (typeof catchUp === 'function') {
    startTimer = setTimer(async () => {
      startTimer = null
      if (stopped || running) return
      let record = null
      try {
        record = await catchUp()
      } catch (err) {
        logger?.warn?.(`[vm-sync] could not read the last sync (${err?.message || err}); the next try is the daily run`)
        return
      }
      const t = now().getTime()
      const lastOk = Date.parse(record?.lastSuccess?.finishedAt ?? '')
      if (Number.isFinite(lastOk) && t - lastOk <= staleAfterMs) return
      const lastTry = Date.parse(record?.lastRun?.startedAt ?? '')
      if (Number.isFinite(lastTry) && t - lastTry < 15 * 60000) return
      if (next && next.getTime() - t < 30 * 60000) return
      const since = Number.isFinite(lastOk) ? `the last success was at ${new Date(lastOk).toISOString()}` : 'no success recorded'
      if (!inWindow(now())) {
        logger?.warn?.(`[vm-sync] ${since}; outside the run window, the next try is the daily run ${next?.toISOString() ?? ''}`)
        return
      }
      logger?.warn?.(`[vm-sync] ${since}: catching up now`)
      if (!stopped) runOnce()
    }, Math.max(0, startDelayMs))
    startTimer?.unref?.()
  }

  return {
    stop() {
      stopped = true
      if (timer) clearTimer(timer)
      if (startTimer) clearTimer(startTimer)
      clearRetry()
      timer = null
      startTimer = null
      next = null
    },
    nextRunAt: () => next,
    runNow: () => runOnce(),
    /** The schedule's own state, for /health (with readSyncRecord's record). */
    status: () => ({
      nextRunAt: next?.toISOString() ?? null,
      nextRetryAt: retryAt?.toISOString() ?? null,
      running: !!running,
      lastRun: last
    })
  }
}

/**
 * VM_SYNC_WINDOW_UTC ('HH:MM-HH:MM', default DEFAULT_RUN_WINDOW_UTC, 'any'):
 * when retries and catch-up runs may start, as { from, to } minutes of the
 * UTC day (null: any time). Throws on a bad value, when the schedule is wired up.
 */
export function runWindowFromEnv(env = process.env) {
  const raw = String(env.VM_SYNC_WINDOW_UTC ?? '').trim() || DEFAULT_RUN_WINDOW_UTC
  if (raw.toLowerCase() === 'any') return null
  const m = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-4]):([0-5]\d)$/.exec(raw)
  const from = m ? Number(m[1]) * 60 + Number(m[2]) : null
  const to = m ? (Number(m[3]) * 60 + Number(m[4])) % (24 * 60) : null
  if (from == null || to == null || from === to || (m[3] === '24' && m[4] !== '00')) {
    throw new RangeError(`VM_SYNC_WINDOW_UTC must be HH:MM-HH:MM (UTC) or 'any', not ${raw.slice(0, 40)}`)
  }
  return { from, to }
}

// ---------------------------------------------------------------------------
// The record (svrz_sync_log) and its health
// ---------------------------------------------------------------------------

const SYNC_LOG_COLUMNS = `status, started_at, finished_at, games_fetched,
  coalesce(games_created, 0) + coalesce(games_updated, 0) + coalesce(games_unchanged, 0) AS written,
  games_without_format, games_removed`
const recordOf = (r) => (r
  ? {
      status: r.status,
      startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
      finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
      fetched: r.games_fetched ?? null,
      written: Number(r.written ?? 0),
      withoutFormat: r.games_without_format ?? null,
      removed: r.games_removed ?? null
    }
  : null)

/**
 * The newest finished run and the newest success of svrz_sync_log, of any
 * process (the schedule, scripts/vm-sync.mjs): { lastRun, lastSuccess }, each
 * { status, startedAt, finishedAt, fetched, written, withoutFormat, removed } or null.
 */
export async function readSyncRecord(db) {
  const { rows: [lastRun] } = await db.query(
    `SELECT ${SYNC_LOG_COLUMNS} FROM public.svrz_sync_log WHERE status <> 'running' ORDER BY id DESC LIMIT 1`)
  const { rows: [lastSuccess] } = await db.query(
    `SELECT ${SYNC_LOG_COLUMNS} FROM public.svrz_sync_log WHERE status = 'success' ORDER BY id DESC LIMIT 1`)
  return { lastRun: recordOf(lastRun), lastSuccess: recordOf(lastSuccess) }
}

/**
 * The schedule sync as /health shows it: { state: 'ok' | 'degraded', reasons,
 * lastSuccessAt, lastSuccessGames, lastRunAt, lastRunStatus }. Degraded when
 * no success is recorded, the last one is older than `staleAfterMs`, it wrote
 * no game (VolleyManager answered nothing: also out of season), or the last
 * run was no success. No run message (it may name accounts and leagues).
 */
export function syncHealth({ lastRun, lastSuccess } = {}, { now = Date.now(), staleAfterMs = SYNC_STALE_AFTER_MS } = {}) {
  const reasons = []
  if (!lastSuccess) reasons.push('never_succeeded')
  else {
    const at = Date.parse(lastSuccess.finishedAt ?? '')
    if (!Number.isFinite(at) || now - at > staleAfterMs) reasons.push('stale')
    if (!(lastSuccess.written > 0)) reasons.push('no_games')
  }
  if (lastRun && lastRun.status !== 'success') reasons.push(`last_run_${lastRun.status}`)
  return {
    state: reasons.length ? 'degraded' : 'ok',
    reasons,
    lastSuccessAt: lastSuccess?.finishedAt ?? null,
    lastSuccessGames: lastSuccess?.written ?? null,
    lastSuccessWithoutFormat: lastSuccess?.withoutFormat ?? null,
    lastRunAt: lastRun?.finishedAt ?? null,
    lastRunStatus: lastRun?.status ?? null
  }
}

/**
 * Reads the sync window from env (VM_SYNC_DAYS_BACK / VM_SYNC_DAYS_AHEAD) and
 * validates it in full (including MAX_WINDOW_DAYS), so a bad value fails when
 * the schedule is wired up instead of making every scheduled run throw.
 */
export function windowFromEnv(env = process.env) {
  const w = {}
  for (const [key, prop] of [['VM_SYNC_DAYS_BACK', 'daysBack'], ['VM_SYNC_DAYS_AHEAD', 'daysAhead']]) {
    const raw = env[key]
    if (raw == null || raw === '') continue
    if (!/^\d+$/.test(String(raw).trim())) throw new RangeError(`${key} must be a non-negative integer`)
    w[prop] = Number(String(raw).trim())
  }
  try {
    resolveWindow(w)
  } catch (err) {
    throw new RangeError(`VM_SYNC_DAYS_BACK / VM_SYNC_DAYS_AHEAD: ${err.message}`)
  }
  return w
}
