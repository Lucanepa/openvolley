/**
 * VolleyManager -> public.svrz_games sync (self-hosted port of the Supabase
 * Edge Function kept in legacy/supabase-functions/vm-sync/index.ts).
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
 *  - date/time are formatted in Europe/Zurich, not UTC (kick-offs were 1-2 h early)
 *  - "today" is the Europe/Zurich calendar day, not the UTC one
 *  - the window is configurable; default Zurich today -1 .. today +14 days
 *  - created / updated / unchanged are counted (xmax + a pre-image CTE)
 *  - a Postgres advisory lock keeps two runs (any process) from overlapping
 *  - every VolleyManager request has a timeout and limited retries with backoff
 *  - the password, cookies and CSRF token are never logged (and are scrubbed
 *    from every log line and error message)
 *
 * Nothing here imports `pg`: runVmSync takes a pg Pool (or anything with
 * connect() -> client { query, release }), so it can share the backend's pool.
 */

export const VM_BASE = 'https://volleymanager.volleyball.ch'
export const ZURICH_TZ = 'Europe/Zurich'
export const BATCH_SIZE = 200
export const DEFAULT_WINDOW = Object.freeze({ daysBack: 1, daysAhead: 14 })
/** Upper bound on a sync window, so a typo cannot ask VM for decades of games. */
export const MAX_WINDOW_DAYS = 400
/** A 'running' log row older than this belongs to a dead run. */
export const STALE_RUNNING_MS = 60 * 60 * 1000
/**
 * pg_try_advisory_lock key (bigint): ASCII "ovvmsync". Shared by every process
 * that runs the sync against the same database.
 */
export const ADVISORY_LOCK_KEY = '8031737197922709091'

// Leagues to EXCLUDE (above 1L). Substring match on the league text, exactly as
// the Edge Function did.
export const EXCLUDED_LEAGUES = ['nl', 'nationalliga', 'nla', 'nlb']

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
const USERNAME_FIELD = '__authentication[Neos][Flow][Security][Authentication][Token][UsernamePassword][username]'
const PASSWORD_FIELD = '__authentication[Neos][Flow][Security][Authentication][Token][UsernamePassword][password]'

export const RENDER_PROPERTIES = [
  'game.startingDateTime', 'gameDayOfWeek', 'game.number',
  'game.group.phase.league.leagueCategory.name',
  'game.group.phase.league.leagueCategory.displayNameWithManagingAssociationShortName',
  'game.group.phase.league.gender',
  'game.group.name', 'game.group.displayName',
  'game.group.phase.name', 'game.group.phase.displayName',
  'game.encounter.teamHome.identifier', 'game.encounter.teamHome.name',
  'game.encounter.teamHome.displayName', 'game.encounter.teamHome.leagueCategory.name',
  'game.encounter.teamAway.identifier', 'game.encounter.teamAway.name',
  'game.encounter.teamAway.displayName', 'game.encounter.teamAway.leagueCategory.name',
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
 * Parses VM's startingDateTime. A string without a zone designator is read as
 * UTC: that is how the Edge Function (Deno on UTC hosts) read it, independent
 * of this server's TZ.
 */
export function parseVmDateTime(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null
  let s = raw.trim()
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s += 'Z'
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

/** dd/mm/yyyy and HH:MM of an instant, in Europe/Zurich (the app's formats). */
export function formatZurichDateTime(date, tz = ZURICH_TZ) {
  const p = zonedParts(date, tz)
  return {
    date: `${pad2(p.day)}/${pad2(p.month)}/${p.year}`,
    time: `${pad2(p.hour)}:${pad2(p.minute)}`
  }
}

/** Birthday -> 'YYYY-MM-DD' (for the date column) or null. Accepts ISO or dd.mm.yyyy. */
export function normalizeDob(raw) {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  let ymd = null
  let m
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/))) ymd = `${m[1]}-${m[2]}-${m[3]}`
  else if ((m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/))) ymd = `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`
  return ymd && isYmd(ymd) ? ymd : null
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

export function buildLoginBody(fields, username, password) {
  return new URLSearchParams({ ...fields, [USERNAME_FIELD]: username, [PASSWORD_FIELD]: password }).toString()
}

/**
 * Logs in and returns { jar, csrfToken }. Never logs the password, cookie
 * values or the CSRF token.
 */
export async function vmLogin({ username, password }, { fetch: fetchImpl, baseUrl = VM_BASE, http = {}, logger = null } = {}) {
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

  logger?.log?.('VM: getting referee page for the CSRF token')
  const { body: refHtml } = await followRedirects(`${baseUrl}/indoorvolleyball.refadmin/refereegame/index`, jar, {}, { ...opts, label: 'referee page' })
  const csrfToken = extractCsrfToken(refHtml)
  if (!csrfToken) {
    const looksLikeLogin = /\/login\b|UsernamePassword/.test(refHtml)
    throw new Error(looksLikeLogin
      ? 'VolleyManager login failed (still on the login page; check VM_USERNAME / VM_PASSWORD)'
      : 'VolleyManager login failed (no CSRF token on the referee page)')
  }
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
  const resp = await fetchWithRetry(fetchImpl, `${baseUrl}${SEARCH_PATH}`, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Cookie: jar.header()
    },
    body: buildSearchBody(csrfToken, offset, batchSize, dateFrom, dateTo),
    redirect: 'manual'
  }, { ...http, label })
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
 * Pages through the search API. A page that still fails after its retries
 * stops the paging: the games fetched so far are returned with
 * `incomplete: true` (upserting them is harmless; the run is marked 'partial').
 * A failing first page throws.
 */
export async function fetchAllGames(jar, csrfToken, dateFrom, dateTo, {
  fetch: fetchImpl, baseUrl = VM_BASE, http = {}, logger = null, batchSize = BATCH_SIZE, pageDelayMs = 100, sleep = defaultSleep
} = {}) {
  const opts = { fetch: fetchImpl, baseUrl, http: { ...http, logger, sleep: http.sleep ?? sleep }, batchSize }
  const first = await searchPage(jar, csrfToken, 0, dateFrom, dateTo, opts)
  const total = Number(first?.totalItemsCount) || 0
  const items = Array.isArray(first?.items) ? [...first.items] : []
  logger?.log?.(`VM: ${total} game(s) in window, ${items.length} in the first page`)
  let incomplete = false
  let pageError = null
  const maxPages = Math.ceil(total / Math.max(1, batchSize)) + 2
  for (let page = 1; items.length < total && page < maxPages; page++) {
    if (pageDelayMs > 0) await sleep(pageDelayMs)
    let batch
    try {
      batch = await searchPage(jar, csrfToken, items.length, dateFrom, dateTo, opts)
    } catch (err) {
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

function extractRefereeInfo(item, convocationKey) {
  const empty = { name: null, firstName: null, lastName: null, dob: null }
  const conv = item[convocationKey]
  if (!conv || typeof conv !== 'object') return empty
  const person = deepGet(conv, 'indoorAssociationReferee', 'indoorReferee', 'person')
  if (!person) return empty
  return {
    name: person.displayName ?? null,
    firstName: person.firstName ?? null,
    lastName: person.lastName ?? null,
    dob: person.formattedAndTimezoneIndependentBirthday ?? null
  }
}

const JUNIOR_KEYWORDS = ['u14', 'u15', 'u16', 'u17', 'u18', 'u19', 'u20', 'u23', 'junior', 'jugend', 'nachwuchs']

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

  const leagueName = String(leagueCat.name ?? '')
  const nameLower = leagueName.toLowerCase()
  const genderCode = league.gender ?? ''
  const isJunior = !!leagueCat.isJuniorLeagueCategory

  const isCup = nameLower.includes('cup') || nameLower.includes('pokal')
  const matchGender = genderCode === 'm' ? 'men' : genderCode === 'f' ? 'women' : ''
  const matchLevel = (isJunior || JUNIOR_KEYWORDS.some((kw) => nameLower.includes(kw))) ? 'junior' : 'senior'

  // League text (e.g. "3L B", "1L D"); group display "Gruppe B" or "#27051 | D"
  const leagueShort = leagueCat.shortName ?? leagueName
  const groupDisplay = grp.displayName ?? ''
  const gruppeMatch = String(groupDisplay).match(/Gruppe\s+([A-Z0-9]+)/) || String(groupDisplay).match(/\|\s*([A-Z0-9]+)\s*$/)
  const leagueText = gruppeMatch ? `${leagueShort} ${gruppeMatch[1]}` : leagueShort

  const matchFormat = league.numberOfWinSets === 'two_win_sets' ? 3 : 5

  const rawDt = typeof g.startingDateTime === 'string' ? g.startingDateTime : ''
  const kickoff = parseVmDateTime(rawDt)
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
    hall: str(hall.name),
    match_type: isCup ? 'cup' : 'championship',
    championship_type: ((nameLower.includes('1l') || nameLower.includes('1. liga')) && matchLevel === 'senior') ? 'national' : 'regional',
    gender: matchGender,
    match_level: matchLevel,
    league: str(leagueText),
    match_format: matchFormat,
    team_home: str(home.name),
    team_away: str(away.name),
    referee_1: str(ref1.name ?? item.activeFirstHeadRefereeName),
    referee_1_first_name: str(ref1.firstName),
    referee_1_last_name: str(ref1.lastName),
    referee_1_dob: normalizeDob(ref1.dob),
    referee_2: str(ref2.name ?? item.activeSecondHeadRefereeName),
    referee_2_first_name: str(ref2.firstName),
    referee_2_last_name: str(ref2.lastName),
    referee_2_dob: normalizeDob(ref2.dob),
    hall_address: str(addr.combinedAddress),
    hall_postal_code: str(addr.postalCode),
    group_display: str(groupDisplay),
    phase_name: str(phase.name),
    linesman_1: str(item.activeFirstLinesmanRefereeName),
    linesman_2: str(item.activeSecondLinesmanRefereeName),
    is_supervised: !!item.isSupervised,
    has_supervised_referee: !!item.hasAtLeastOneRefereeIntendedToBeSupervised,
    convocations,
    synced_at: (syncedAt instanceof Date ? syncedAt : new Date(syncedAt)).toISOString()
  }
}

export function isExcludedLeague(league) {
  const l = String(league ?? '').toLowerCase()
  return EXCLUDED_LEAGUES.some((ex) => l.includes(ex))
}

/**
 * Transforms, drops rows without a game number and NL leagues, and de-duplicates
 * by game_number (last one wins: one INSERT .. ON CONFLICT cannot touch the same
 * row twice).
 */
export function prepareRows(items, opts = {}) {
  const all = (items || []).map((it) => transformGame(it, opts)).filter((r) => r.game_number)
  const kept = all.filter((r) => !isExcludedLeague(r.league))
  const byNumber = new Map()
  for (const r of kept) byNumber.set(r.game_number, r)
  return { rows: [...byNumber.values()], transformed: all.length, excluded: all.length - kept.length, duplicates: kept.length - byNumber.size }
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/** svrz_games columns written by the sync, with their Postgres types. */
export const GAME_COLUMNS = [
  ['game_number', 'text'], ['date', 'text'], ['time', 'text'], ['datetime', 'text'],
  ['city', 'text'], ['hall', 'text'], ['match_type', 'text'], ['championship_type', 'text'],
  ['gender', 'text'], ['match_level', 'text'], ['league', 'text'], ['match_format', 'integer'],
  ['team_home', 'text'], ['team_away', 'text'],
  ['referee_1', 'text'], ['referee_1_first_name', 'text'], ['referee_1_last_name', 'text'], ['referee_1_dob', 'date'],
  ['referee_2', 'text'], ['referee_2_first_name', 'text'], ['referee_2_last_name', 'text'], ['referee_2_dob', 'date'],
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
 * @param {object} o
 * @param {{connect: Function}} [o.pool]   pg Pool (or compatible). Not needed with dryRun.
 * @param {Function} [o.fetch]             fetch implementation (default globalThis.fetch)
 * @param {Date|Function} [o.now]          clock (Date or () => Date)
 * @param {object} [o.window]              see resolveWindow (default Zurich today -1 .. +14)
 * @param {object} [o.logger]              console-like; every line is scrubbed of secrets
 * @param {{username: string, password: string}} o.credentials
 * @param {string} [o.baseUrl]             VolleyManager origin (tests)
 * @param {object} [o.http]                { timeoutMs, retries, backoffMs, sleep }
 * @param {boolean} [o.dryRun]             fetch + transform only, no database
 */
export async function runVmSync({
  pool,
  fetch: fetchImpl = globalThis.fetch,
  now = () => new Date(),
  window,
  logger,
  credentials = {},
  baseUrl = VM_BASE,
  http = {},
  batchSize = BATCH_SIZE,
  pageDelayMs = 100,
  dryRun = false,
  staleRunningMs = STALE_RUNNING_MS
} = {}) {
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
    created: 0, updated: 0, unchanged: 0, errors: 0, elapsedMs: 0, message: '', dryRun
  }
  const elapsed = () => ((clock().getTime() - startedAt.getTime()) / 1000).toFixed(1)

  let client = null
  let locked = false
  try {
    if (!dryRun) {
      client = await pool.connect()
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
    ;({ jar, csrfToken } = await vmLogin(credentials, { fetch: fetchImpl, baseUrl, http, logger: log }))

    const fetched = await fetchAllGames(jar, csrfToken, win.dateFrom, win.dateTo, {
      fetch: fetchImpl, baseUrl, http, logger: log, batchSize, pageDelayMs, sleep: http.sleep
    })
    result.fetched = fetched.items.length
    result.total = fetched.total

    const prepared = prepareRows(fetched.items, { syncedAt: clock() })
    result.kept = prepared.rows.length
    result.excluded = prepared.excluded
    log.log(`vm-sync: ${prepared.transformed} game(s) transformed, ${prepared.excluded} NL excluded, ${prepared.rows.length} to write` +
      (prepared.duplicates ? ` (${prepared.duplicates} duplicate game number(s) merged)` : ''))

    const batchErrors = []
    if (!dryRun) {
      const syncedAt = clock()
      for (let i = 0; i < prepared.rows.length; i += batchSize) {
        const batch = prepared.rows.slice(i, i + batchSize)
        try {
          const c = await upsertBatch(client, batch, syncedAt)
          result.created += c.created
          result.updated += c.updated
          result.unchanged += c.unchanged
        } catch (err) {
          result.errors += batch.length
          const msg = redact(err)
          batchErrors.push(msg)
          log.error(`vm-sync: batch at offset ${i} failed: ${msg}`)
        }
      }
    }

    const parts = [`[${dateLabel}] ${dryRun ? 'Dry run: fetched' : 'Synced'} ${prepared.rows.length} games in ${elapsed()}s`]
    if (!dryRun) parts.push(`(${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged, ${result.errors} errors)`)
    if (prepared.excluded) parts.push(`${prepared.excluded} NL excluded`)
    if (fetched.incomplete) parts.push(`INCOMPLETE: ${fetched.items.length}/${fetched.total} fetched (${redact(fetched.pageError)})`)
    if (batchErrors.length) parts.push(`first error: ${batchErrors[0]}`)
    result.message = redact(parts.join(' '))
    if (result.errors > 0 && result.errors >= prepared.rows.length) result.status = 'failed'
    else if (result.errors > 0 || fetched.incomplete) result.status = 'partial'
    else result.status = 'success'
  } catch (err) {
    result.status = 'failed'
    result.error = redact(err)
    result.message = redact(`[${dateLabel}] Failed after ${elapsed()}s: ${result.error}`)
  } finally {
    result.elapsedMs = clock().getTime() - startedAt.getTime()
    if (client) {
      try {
        if (result.logId != null) {
          await client.query(
            `UPDATE public.svrz_sync_log
                SET finished_at = now(), games_fetched = $2, games_created = $3, games_updated = $4,
                    games_unchanged = $5, errors = $6, status = $7, message = $8
              WHERE id = $1`,
            [result.logId, result.fetched, result.created, result.updated, result.unchanged,
              result.errors, result.status, result.message]
          )
        }
      } catch (err) {
        // The next run (or db/003) closes the row once it is older than an hour
        log.error(`vm-sync: could not close log row ${result.logId}: ${redact(err)}`)
      }
      let releaseErr
      try {
        if (locked) await client.query('SELECT pg_advisory_unlock($1::bigint)', [ADVISORY_LOCK_KEY])
      } catch (err) {
        // Destroy the connection so the session (and its lock) cannot leak into the pool
        releaseErr = err
      }
      try { client.release(releaseErr) } catch { /* ignore */ }
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

/**
 * Runs `run()` every day at hourLocal:minuteLocal in `tz` (default 06:00
 * Europe/Zurich, the Edge Function's cron hour, now in local time). Timers are
 * unref'd. Overlap inside this process is skipped here; across processes the
 * advisory lock in runVmSync does it. Errors from run() are logged, never thrown.
 *
 * @returns {{ stop(): void, nextRunAt(): Date|null, runNow(): Promise<any> }}
 */
export function scheduleVmSync({
  hourLocal = 6,
  minuteLocal = 0,
  tz = ZURICH_TZ,
  run,
  logger = console,
  now = () => new Date(),
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  if (typeof run !== 'function') throw new TypeError('scheduleVmSync: run() required')
  if (!Number.isInteger(hourLocal) || hourLocal < 0 || hourLocal > 23) throw new RangeError('hourLocal must be 0-23')
  if (!Number.isInteger(minuteLocal) || minuteLocal < 0 || minuteLocal > 59) throw new RangeError('minuteLocal must be 0-59')
  new Intl.DateTimeFormat('en', { timeZone: tz }) // throws RangeError on an unknown zone

  let timer = null
  let next = null
  let stopped = false
  let running = null

  const runOnce = () => {
    if (running) {
      logger?.warn?.('[vm-sync] previous run still in progress, skipping')
      return running
    }
    running = Promise.resolve()
      .then(() => run())
      .catch((err) => { logger?.error?.('[vm-sync] run failed:', err?.message || err) })
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
        runOnce()
        arm(slot)
      } else {
        arm()
      }
    }, Math.max(0, delay))
    timer?.unref?.()
  }

  arm()
  logger?.log?.(`[vm-sync] scheduled daily at ${pad2(hourLocal)}:${pad2(minuteLocal)} ${tz}; next run ${next.toISOString()}`)

  return {
    stop() {
      stopped = true
      if (timer) clearTimer(timer)
      timer = null
      next = null
    },
    nextRunAt: () => next,
    runNow: () => runOnce()
  }
}

/** Reads the sync window from env (VM_SYNC_DAYS_BACK / VM_SYNC_DAYS_AHEAD). */
export function windowFromEnv(env = process.env) {
  const w = {}
  for (const [key, prop] of [['VM_SYNC_DAYS_BACK', 'daysBack'], ['VM_SYNC_DAYS_AHEAD', 'daysAhead']]) {
    const raw = env[key]
    if (raw == null || raw === '') continue
    if (!/^\d+$/.test(String(raw).trim())) throw new RangeError(`${key} must be a non-negative integer`)
    w[prop] = Number(raw)
  }
  return w
}
