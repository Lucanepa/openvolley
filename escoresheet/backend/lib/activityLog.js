/**
 * activityLog — the match activity log on the server (db/016_activity_log.sql,
 * docs/activity-log-spec.md).
 *
 *   POST   /api/activity {entries:[<=500]}           signed in, address confirmed (server.js, 30/min per user)
 *   GET    /api/activity?match=&before=&limit<=500   owner / editor of the match (admin: any, audited)
 *   (lists newest first by client_ts, then id; `next` is the cursor for `before`)
 *   GET    /api/admin/activity?match=&account=&kind=&level=&from=&to=&app=&before=&limit<=500
 *          (audited when it names a match or an account)
 *   GET    /api/admin/activity/export?...&format=csv|ndjson[&emails=1]   (streamed by server.js,
 *          <= 50,000 rows, audited; the account's email address only with emails=1)
 *   DELETE /api/admin/activity?match=|account=[&kind=...]&confirm=yes   delete on request (audited):
 *          exactly the rows the list shows for the same filters
 *
 * Every uploaded entry runs through the same sanitizer as on the device
 * (lib/activitySanitize.js). An entry may name an account only when it is
 * the caller's. It is tied to a match only when the match is on the server
 * and the caller owns or edits it; one naming a match the server does not
 * have is kept without the match (the device keeps the link), one naming
 * another account's match is refused. client_ts is at most a day ahead of
 * the server; retention counts from `at` (received). An account that has not
 * confirmed its address stores nothing, and each account at most
 * DAILY_ROW_CAP rows a day. Idempotent by uid.
 * Handlers answer { status, body } and never throw.
 */
import { sanitizeActivityData, isKnownKind, ACTIVITY_KIND_RE, ACTIVITY_LEVELS } from './activitySanitize.js'
import { EMAIL_CONFIRMATION_MARK } from './auth.js'

export const MAX_ENTRIES = 500
export const MAX_BODY_BYTES = 512 * 1024
export const LIST_MAX = 500
export const EXPORT_MAX = 50000
export const UNLINKED_RETENTION_DAYS = 90
export const MATCH_RETENTION_MONTHS = 24
// A device clock ahead of the server's by more than this is cut back to it
export const CLIENT_TS_MAX_AHEAD_MS = 24 * 60 * 60 * 1000
// Rows one account may store in a day: a whole match is up to about 1,000,
// a long tournament day of one scorer a few thousand
export const DAILY_ROW_CAP = 20000
const DAY_MS = 24 * 60 * 60 * 1000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const APPS = ['indoor', 'beach']

const answer = (status, data) => ({ status, body: { data, error: null } })
const fail = (status, code, message, details) => ({ status, body: { data: null, error: { message, code, ...(details ? { details } : {}) } } })
const invalid = (details) => fail(400, 'OV_INVALID_REQUEST', 'Invalid request', details)
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const optText = (v, max) => (v == null || v === '' ? null : typeof v === 'string' && v.length <= max ? v : undefined)
const optNum = (v) => (v == null ? null : Number.isFinite(Number(v)) && Math.abs(Number(v)) < 1e9 ? Number(v) : undefined)

/**
 * A link account that has not confirmed its address yet (lib/auth.js: it may
 * sign in, but gets no role until then).
 * @param {{ email_confirmed_at?: string|null, app_metadata?: object }} user as requireUser returns it
 */
export function isUnconfirmedUser(user) {
  if (!user || user.email_confirmed_at != null) return false
  const meta = user.app_metadata
  return isPlainObject(meta) && meta[EMAIL_CONFIRMATION_MARK.key] === EMAIL_CONFIRMATION_MARK.value
}

/**
 * Check one uploaded entry. Returns { row } or { code } (the refusal).
 * @param {object} e entry as sent by the app (utils/activity/upload uploadEntry)
 * @param {string} callerId
 * @param {{ now?: number }} [opts] the server's time (ms): client_ts is at most a day ahead of it
 */
export function checkEntry(e, callerId, { now = Date.now() } = {}) {
  if (!isPlainObject(e)) return { code: 'OV_ACTIVITY_INVALID' }
  if (typeof e.uid !== 'string' || !UUID_RE.test(e.uid)) return { code: 'OV_ACTIVITY_INVALID' }
  if (typeof e.kind !== 'string' || e.kind.length > 64 || !ACTIVITY_KIND_RE.test(e.kind) || !isKnownKind(e.kind)) return { code: 'OV_ACTIVITY_INVALID' }
  const sent = typeof e.client_ts === 'string' && e.client_ts.length <= 40 ? Date.parse(e.client_ts) : NaN
  if (!Number.isFinite(sent)) return { code: 'OV_ACTIVITY_INVALID' }
  const ts = Math.min(sent, now + CLIENT_TS_MAX_AHEAD_MS)
  const level = e.level == null ? 'info' : e.level
  if (!ACTIVITY_LEVELS.includes(level)) return { code: 'OV_ACTIVITY_INVALID' }
  const app = e.app == null ? 'indoor' : e.app
  if (!APPS.includes(app)) return { code: 'OV_ACTIVITY_INVALID' }
  if (e.account_id != null && e.account_id !== callerId) return { code: 'OV_ACTIVITY_ACCOUNT' }
  const matchExt = optText(e.match_external_id, 200)
  const deviceId = optText(e.device_id, 64)
  const appVersion = optText(e.app_version, 32)
  const platform = optText(e.platform, 24)
  const eventExt = optText(e.event_external_id, 200)
  const setIndex = e.set_index == null ? null : Number.isInteger(Number(e.set_index)) && Math.abs(Number(e.set_index)) < 1000 ? Number(e.set_index) : undefined
  const eventSeq = optNum(e.event_seq)
  if ([matchExt, deviceId, appVersion, platform, eventExt, setIndex, eventSeq].includes(undefined)) return { code: 'OV_ACTIVITY_INVALID' }
  if (e.data != null && !isPlainObject(e.data)) return { code: 'OV_ACTIVITY_INVALID' }
  return {
    row: {
      uid: e.uid.toLowerCase(),
      client_ts: new Date(ts).toISOString(),
      app,
      match_external_id: matchExt,
      account_id: e.account_id == null ? null : callerId,
      device_id: deviceId,
      app_version: appVersion,
      platform,
      kind: e.kind,
      level,
      set_index: setIndex,
      event_seq: eventSeq,
      event_external_id: eventExt,
      data: sanitizeActivityData(e.kind, e.data || {})
    }
  }
}

/** SQL: the match row `m` is owned (created or edited) by the user $n. */
const ownedBy = (alias, param) =>
  `(${alias}.created_by = ${param}::uuid OR EXISTS (SELECT 1 FROM public.match_editors oe WHERE oe.match_id = ${alias}.id AND oe.user_id = ${param}::uuid))`

const queryValue = (query, k) => {
  const v = typeof query?.get === 'function' ? query.get(k) : query?.[k]
  return v == null || v === '' ? null : String(v)
}

/**
 * Admin filters -> { where, values } (activity_log a): the list, the export
 * and the delete use this one, so a delete removes what the list showed.
 * A game number finds the matches with that number (an entry naming the
 * bare number is no match's); anything else is a match's external id.
 * `cursor: false` (the delete) ignores `before`.
 */
export function adminFilters(query, { values = [], cursor = true } = {}) {
  const get = (k) => queryValue(query, k)
  const p = (v) => { values.push(v); return `$${values.length}` }
  const where = []
  const match = get('match')
  if (match) {
    if (match.length > 200) return { error: invalid('match') }
    if (/^\d{1,9}$/.test(match)) {
      where.push(`a.match_external_id IN (SELECT external_id FROM public.matches WHERE game_n = ${p(Number(match))} OR external_id = ${p(match)})`)
    } else {
      where.push(`a.match_external_id = ${p(match)}`)
    }
  }
  const account = get('account')
  if (account) {
    if (!UUID_RE.test(account)) return { error: invalid('account') }
    where.push(`(a.account_id = ${p(account)}::uuid OR a.uploader_id = ${p(account)}::uuid)`)
  }
  const kind = get('kind')
  if (kind) {
    if (!/^[a-z_.]{1,64}$/.test(kind)) return { error: invalid('kind') }
    where.push(`a.kind LIKE ${p(kind.replace(/[_%]/g, (c) => `\\${c}`) + '%')}`)
  }
  const level = get('level')
  if (level) {
    if (!ACTIVITY_LEVELS.includes(level)) return { error: invalid('level') }
    where.push(`a.level = ${p(level)}`)
  }
  for (const [k, op] of [['from', '>='], ['to', '<=']]) {
    const v = get(k)
    if (!v) continue
    const ms = Date.parse(v)
    if (!Number.isFinite(ms)) return { error: invalid(k) }
    where.push(`a.client_ts ${op} ${p(new Date(ms).toISOString())}`)
  }
  const app = get('app')
  if (app) {
    if (!APPS.includes(app)) return { error: invalid('app') }
    where.push(`a.app = ${p(app)}`)
  }
  const before = cursor ? get('before') : null
  if (before) {
    const c = parseCursor(before)
    if (!c) return { error: invalid('before') }
    where.push(cursorSql(c, p))
  }
  return { where, values }
}

const FILTER_KEYS = ['match', 'account', 'kind', 'level', 'from', 'to', 'app']

/** The filters of a query as they go into an audit entry (only those given). */
function filterDetails(query) {
  const out = {}
  for (const k of FILTER_KEYS) {
    const v = queryValue(query, k)
    if (v != null) out[k] = v.slice(0, 200)
  }
  return out
}

/**
 * Lists are in the order things happened on the devices: client_ts, then id
 * (upload order) for entries of the same moment; newest first. The page
 * cursor (`next`, sent back as `before`) is "<client_ts in µs>_<id>"; a bare
 * id (older consoles) still pages by upload order.
 */
export const ACTIVITY_ORDER = 'a.client_ts DESC, a.id DESC'
const CURSOR_SELECT = '(extract(epoch FROM a.client_ts) * 1000000)::bigint AS cursor_us'

export function parseCursor(v) {
  const s = String(v ?? '')
  let m = /^(-?\d{1,17})_(\d{1,18})$/.exec(s)
  if (m) return { us: m[1], id: m[2] }
  m = /^(\d{1,18})$/.exec(s)
  return m ? { id: m[1] } : null
}

function cursorSql(c, p) {
  if (c.us == null) return `a.id < ${p(c.id)}::bigint`
  return `(a.client_ts, a.id) < (timestamptz 'epoch' + ${p(c.us)}::bigint * interval '1 microsecond', ${p(c.id)}::bigint)`
}

/** The rows without the cursor column, and the cursor of the last one. */
export function pageOf(rows, limit) {
  const last = rows[rows.length - 1]
  const next = rows.length === limit && last ? `${last.cursor_us}_${last.id}` : null
  return { entries: rows.map(({ cursor_us: _c, ...r }) => r), next }
}

const clampLimit = (v, max) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : max
}

const LIST_COLUMNS = `a.id, a.uid, a.at, a.client_ts, a.app, a.match_external_id, m.game_n, a.account_id,
  u.email AS account_email, a.uploader_id, a.device_id, a.app_version, a.platform, a.kind, a.level,
  a.set_index, a.event_seq, a.event_external_id, a.data`
const LIST_FROM = `public.activity_log a
  LEFT JOIN public.matches m ON m.external_id = a.match_external_id
  LEFT JOIN auth.users u ON u.id = a.account_id`

/**
 * @param {{ pool: import('pg').Pool, accounts?: { audit: Function }, log?: Console, dailyRowCap?: number, now?: () => number }} deps
 */
export function createActivityLog({ pool, accounts = null, log = console, dailyRowCap = DAILY_ROW_CAP, now = Date.now }) {
  const dbError = (where, err) => {
    log.warn?.(`[activity] ${where} failed:`, err?.message)
    return fail(503, 'OV_DB_UNAVAILABLE', 'Service unavailable')
  }

  // Rows each account stored in the last day: counted from the table once
  // per account and day (so also after a restart), then kept here
  const stored = new Map() // uploader id -> { start, rows }
  async function storedToday(userId, t) {
    const cur = stored.get(userId)
    if (cur && t - cur.start < DAY_MS) return cur
    if (stored.size > 10000) for (const [k, v] of stored) if (t - v.start >= DAY_MS) stored.delete(k)
    const { rows: [c] } = await pool.query(
      `SELECT count(*)::int AS n FROM public.activity_log
        WHERE uploader_id = $1::uuid AND at > $2::timestamptz - interval '1 day'`,
      [userId, new Date(t).toISOString()])
    // a request of the same account counted meanwhile: its record stays
    const again = stored.get(userId)
    if (again && t - again.start < DAY_MS) return again
    const fresh = { start: t, rows: Number(c?.n) || 0 }
    stored.set(userId, fresh)
    return fresh
  }

  /** An admin's read of someone's activity, on record before the rows leave (throws on a database error). */
  async function auditRead(actorId, details, targetUserId = null) {
    if (!accounts?.audit) return
    await accounts.audit(null, { actorId, action: 'activity.read', targetUserId, details })
  }

  /** POST /api/activity */
  async function ingest({ user, body, isAdmin = false }) {
    if (!isPlainObject(body) || !Array.isArray(body.entries)) return invalid('entries must be an array')
    if (body.entries.length === 0) return answer(200, { accepted: [], rejected: [] })
    if (body.entries.length > MAX_ENTRIES) return invalid(`at most ${MAX_ENTRIES} entries`)
    const accepted = []
    const rejected = []
    const rows = []
    const seen = new Set()
    const t = now()
    // Refused one by one, not as a request: the app keeps these rows on the
    // device (synced 2) and its sync queue goes on as before
    const unconfirmed = isUnconfirmedUser(user)
    for (const e of body.entries) {
      const r = checkEntry(e, user.id, { now: t })
      if (r.code || unconfirmed) {
        if (typeof e?.uid === 'string' && e.uid.length <= 64) rejected.push({ uid: e.uid, code: r.code || 'OV_EMAIL_UNCONFIRMED' })
        continue
      }
      if (seen.has(r.row.uid)) continue
      seen.add(r.row.uid)
      rows.push(r.row)
    }
    if (!rows.length) return answer(200, { accepted, rejected })
    let quota = null
    let reserved = 0
    try {
      // Matches named by the entries: tied to one only when it is on the
      // server and the caller owns or edits it (an admin: any on the server)
      const exts = [...new Set(rows.map(r => r.match_external_id).filter(Boolean))]
      const held = new Set()
      const notMine = new Set()
      if (exts.length) {
        const { rows: found } = await pool.query(
          `SELECT m.external_id, ${ownedBy('m', '$2')} AS owned FROM public.matches m WHERE m.external_id = ANY($1::text[])`,
          [exts, user.id])
        for (const f of found) (f.owned || isAdmin ? held : notMine).add(f.external_id)
      }
      const linked = []
      for (const r of rows) {
        if (!r.match_external_id || held.has(r.match_external_id)) linked.push(r)
        else if (notMine.has(r.match_external_id)) rejected.push({ uid: r.uid, code: 'OV_NOT_MATCH_OWNER' })
        // no such match on the server (yet): kept, without it
        else linked.push({ ...r, match_external_id: null })
      }
      quota = await storedToday(user.id, t)
      let room = Math.max(0, dailyRowCap - quota.rows)
      let keep = linked
      if (linked.length > room) {
        // over the cap: rows already stored (sent again) are still accepted
        const { rows: have } = await pool.query('SELECT uid FROM public.activity_log WHERE uid = ANY($1::uuid[])', [linked.map(r => r.uid)])
        const already = new Set(have.map(h => String(h.uid)))
        keep = []
        for (const r of linked) {
          if (already.has(r.uid)) accepted.push(r.uid)
          else if (room > 0) { keep.push(r); room-- }
          else rejected.push({ uid: r.uid, code: 'OV_ACTIVITY_QUOTA' })
        }
        log.warn?.(`[activity] an account reached the daily cap of ${dailyRowCap} rows`)
      }
      if (keep.length) {
        reserved = keep.length
        quota.rows += reserved
        const ins = await pool.query(
          `INSERT INTO public.activity_log
             (uid, client_ts, app, match_external_id, account_id, uploader_id, device_id, app_version, platform,
              kind, level, set_index, event_seq, event_external_id, data)
           SELECT r.uid, r.client_ts, r.app, r.match_external_id, r.account_id, $2::uuid, r.device_id, r.app_version,
                  r.platform, r.kind, r.level, r.set_index, r.event_seq, r.event_external_id, coalesce(r.data, '{}'::jsonb)
             FROM jsonb_to_recordset($1::jsonb) AS r(uid uuid, client_ts timestamptz, app text, match_external_id text,
                  account_id uuid, device_id text, app_version text, platform text, kind text, level text,
                  set_index int, event_seq numeric, event_external_id text, data jsonb)
           ON CONFLICT (uid) DO NOTHING`,
          [JSON.stringify(keep), user.id])
        // rows sent again (idempotent) are no new rows
        quota.rows -= reserved - (Number(ins?.rowCount) || 0)
        reserved = 0
        for (const r of keep) accepted.push(r.uid)
      }
      return answer(200, { accepted, rejected })
    } catch (err) {
      if (quota) quota.rows -= reserved
      return dbError('ingest', err)
    }
  }

  /** GET /api/activity?match= (owner / editor: entries uploaded by an owner or editor; admin: all) */
  async function listForMatch({ user, isAdmin = false, query }) {
    const get = (k) => (typeof query?.get === 'function' ? query.get(k) : query?.[k]) ?? null
    const matchExt = get('match')
    if (typeof matchExt !== 'string' || !matchExt || matchExt.length > 200) return invalid('match')
    const before = get('before')
    const cursor = before != null ? parseCursor(before) : null
    if (before != null && !cursor) return invalid('before')
    const limit = clampLimit(get('limit'), LIST_MAX)
    try {
      const { rows: [m] } = await pool.query(
        `SELECT m.id, ${ownedBy('m', '$2')} AS owned FROM public.matches m WHERE m.external_id = $1`,
        [matchExt, user.id])
      if (!m) return fail(404, 'OV_MATCH_NOT_FOUND', 'Match not found')
      if (!m.owned && !isAdmin) return fail(403, 'OV_NOT_MATCH_OWNER', 'You do not own this match')
      const values = [matchExt, limit]
      let extra = ''
      if (!isAdmin) {
        // Only what the match's own scorers uploaded (an entry can name a match before it exists)
        extra += ` AND (a.uploader_id IS NULL OR EXISTS (SELECT 1 FROM public.matches om WHERE om.external_id = a.match_external_id AND ${ownedBy('om', 'a.uploader_id')}))`
      }
      if (cursor) extra += ` AND ${cursorSql(cursor, (v) => { values.push(v); return `$${values.length}` })}`
      const { rows } = await pool.query(
        `SELECT a.id, a.uid, a.at, a.client_ts, a.app, a.match_external_id, a.account_id, a.device_id, a.app_version,
                a.platform, a.kind, a.level, a.set_index, a.event_seq, a.event_external_id, a.data, ${CURSOR_SELECT}
           FROM public.activity_log a
          WHERE a.match_external_id = $1${extra}
          ORDER BY ${ACTIVITY_ORDER}
          LIMIT $2`, values)
      // an admin reading a match that is not theirs
      if (!m.owned) await auditRead(user.id, { match: matchExt.slice(0, 200), rows: rows.length })
      return answer(200, pageOf(rows, limit))
    } catch (err) {
      return dbError('list', err)
    }
  }

  /** GET /api/admin/activity (a read of a match or an account is audited) */
  async function adminList({ actorId = null, query }) {
    const f = adminFilters(query)
    if (f.error) return f.error
    const limit = clampLimit(queryValue(query, 'limit'), LIST_MAX)
    f.values.push(limit)
    try {
      const { rows } = await pool.query(
        `SELECT ${LIST_COLUMNS}, ${CURSOR_SELECT} FROM ${LIST_FROM}
          ${f.where.length ? `WHERE ${f.where.join(' AND ')}` : ''}
          ORDER BY ${ACTIVITY_ORDER} LIMIT $${f.values.length}`, f.values)
      const details = filterDetails(query)
      if (details.match || details.account) await auditRead(actorId, { ...details, rows: rows.length }, details.account || null)
      return answer(200, pageOf(rows, limit))
    } catch (err) {
      return dbError('admin list', err)
    }
  }

  /**
   * GET /api/admin/activity/export, before the first row is sent: the
   * filters checked, the rows counted (at most EXPORT_MAX) and the export on
   * record (actor, filters, format, with or without email addresses, rows).
   * Returns null, or the answer that refuses it (bad filter, database down).
   */
  async function auditExport({ actorId = null, query, format, emails = false }) {
    const f = adminFilters(query, { cursor: false })
    if (f.error) return f.error
    try {
      f.values.push(EXPORT_MAX)
      const { rows: [c] } = await pool.query(
        `SELECT count(*)::int AS n FROM (SELECT 1 FROM public.activity_log a
          ${f.where.length ? `WHERE ${f.where.join(' AND ')}` : ''} LIMIT $${f.values.length}) x`, f.values)
      if (accounts?.audit) {
        const details = filterDetails(query)
        await accounts.audit(null, {
          actorId,
          action: 'activity.export',
          targetUserId: details.account || null,
          details: { ...details, format, emails: !!emails, rows: Number(c?.n) || 0 }
        })
      }
      return null
    } catch (err) {
      return dbError('export', err)
    }
  }

  /**
   * GET /api/admin/activity/export: async iterator of row pages (newest first),
   * at most EXPORT_MAX rows, without the account's email address unless
   * `emails`. Throws on a bad query (err.result is the answer).
   */
  async function * exportPages(query, { pageSize = 1000, emails = false } = {}) {
    let before = null
    let total = 0
    for (;;) {
      const q = new URLSearchParams(typeof query?.toString === 'function' ? query.toString() : '')
      if (before != null) q.set('before', String(before))
      const f = adminFilters(q)
      if (f.error) throw Object.assign(new Error('bad query'), { result: f.error })
      const size = Math.min(pageSize, EXPORT_MAX - total)
      if (size <= 0) return
      f.values.push(size)
      const { rows } = await pool.query(
        `SELECT ${LIST_COLUMNS}, ${CURSOR_SELECT} FROM ${LIST_FROM}
          ${f.where.length ? `WHERE ${f.where.join(' AND ')}` : ''}
          ORDER BY ${ACTIVITY_ORDER} LIMIT $${f.values.length}`, f.values)
      if (!rows.length) return
      total += rows.length
      const page = pageOf(rows, size)
      yield emails ? page.entries : page.entries.map(({ account_email: _e, ...r }) => r)
      if (rows.length < size) return
      before = page.next
    }
  }

  /**
   * DELETE /api/admin/activity?match=|account=[&kind=&level=&from=&to=&app=]&confirm=yes
   * (delete on request): the rows the list shows for the same filters. A
   * match or an account is required: never everything of a kind or a day.
   */
  async function adminDelete({ actorId, query }) {
    const get = (k) => queryValue(query, k)
    if (get('confirm') !== 'yes') return invalid('confirm=yes is required')
    const match = get('match')
    const account = get('account')
    if (!match && !account) return invalid('match or account')
    const f = adminFilters(query, { cursor: false })
    if (f.error) return f.error
    const { match: _m, account: _a, ...narrowedBy } = filterDetails(query)
    try {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const r = await client.query(`DELETE FROM public.activity_log a WHERE ${f.where.join(' AND ')}`, f.values)
        if (accounts?.audit) {
          await accounts.audit(client, {
            actorId,
            action: 'activity.delete',
            targetUserId: account || null,
            details: { match: match || null, account: account || null, ...narrowedBy, rows: r.rowCount }
          })
        }
        await client.query('COMMIT')
        return answer(200, { deleted: r.rowCount })
      } catch (err) {
        try { await client.query('ROLLBACK') } catch { /* broken connection */ }
        throw err
      } finally {
        client.release()
      }
    } catch (err) {
      return dbError('delete', err)
    }
  }

  /**
   * Retention (daily): rows without a match after 90 days, match rows 24
   * months after they were received (`at`: the server's clock, not the
   * device's). Returns the counts.
   */
  async function purge({ now = new Date() } = {}) {
    const unlinked = await pool.query(
      `DELETE FROM public.activity_log WHERE match_external_id IS NULL AND at < $1::timestamptz - make_interval(days => $2)`,
      [now.toISOString(), UNLINKED_RETENTION_DAYS])
    const linked = await pool.query(
      `DELETE FROM public.activity_log WHERE match_external_id IS NOT NULL AND at < $1::timestamptz - make_interval(months => $2)`,
      [now.toISOString(), MATCH_RETENTION_MONTHS])
    return { unlinked: unlinked.rowCount, linked: linked.rowCount }
  }

  return { ingest, listForMatch, adminList, auditExport, exportPages, exportColumns, adminDelete, purge }
}

/** CSV of export rows (RFC 4180, data as JSON). */
export const CSV_COLUMNS = ['id', 'client_ts', 'at', 'app', 'match_external_id', 'game_n', 'account_email', 'account_id', 'uploader_id', 'device_id', 'app_version', 'platform', 'kind', 'level', 'set_index', 'event_seq', 'event_external_id', 'data']
/** The export's columns: the account's email address only when asked for. */
export function exportColumns({ emails = false } = {}) {
  return emails ? CSV_COLUMNS : CSV_COLUMNS.filter((c) => c !== 'account_email')
}
export function csvLine(row, columns = CSV_COLUMNS) {
  return columns.map((c) => {
    let v = row[c]
    if (v == null) return ''
    if (v instanceof Date) v = v.toISOString()
    else if (typeof v === 'object') v = JSON.stringify(v)
    else v = String(v)
    // a cell starting with = + - @ is text in a spreadsheet, never a formula
    if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`
    return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
  }).join(',')
}
