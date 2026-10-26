/**
 * matchRestore — the two match endpoints that replace multi-step client flows.
 *
 *   POST /api/match/restore        { match, sets, events, liveState }   (needs a session)
 *     One transaction: upsert the match by external_id, delete its events,
 *     sets and live state, insert the sets and events (the pgQuery id scope
 *     guard applies) and the live state. Any failure rolls everything back.
 *     Keys that are not columns are dropped (and reported), not fatal: old
 *     backups and bundles send extra keys (backupManager's live state `status`
 *     is renamed to `match_status`). Sets/events without sport_type get the
 *     match's, else 'indoor'. Null/empty game_pin or connection_pins keep the
 *     stored value; connection_pins is merged into the stored object. PINs are
 *     stored in hashed form when a PIN secret is configured (lib/pinHash.js).
 *     With `matchOwner` (every non-admin session) the match must be new or
 *     owned by the caller (creator or editor), else 403 OV_NOT_MATCH_OWNER and
 *     nothing is written; with `matchOwner.testOnly` (not an approved scorer)
 *     only a test match, else 403 OV_SCORER_REQUIRED.
 *     db/007: a closed match (approved/final reached the server) cannot be
 *     restored over (409 OV_MATCH_CLOSED, nothing changes). A backup that is
 *     itself approved/final is written as 'ended' first and gets its closing
 *     status as the last step of the transaction, after its sets and events
 *     (closing first would lock the match before its children are in).
 *     `actorId` is the ov.user_id of the transaction (closed_by).
 *     -> 200 { data: { id, counts: { sets, events, liveState }, dropped: { match?, sets?, events?, liveState? } }, error: null }
 *
 *   POST /api/match/restore-by-pin { gameN, pin }                        (anonymous, attempt-limited)
 *     Exact match on game number AND game PIN. Returns the match with its
 *     secret columns stripped, plus its sets, events and live state. With
 *     `editorUserId` (the caller is signed in) that account becomes an editor
 *     of the match (match_editors): proving the game PIN is the take-over.
 *     `takeOver(match)` (server.js, a device that continues the match: the
 *     scoring device, db/019) runs once the PIN is proved and BEFORE the
 *     sets, events and live state are read; what it returns is the answer's
 *     `scorer` (nothing when it returns null or fails).
 *     `idFloor` { set, event }: the highest local id the match's set / event
 *     external_ids carry (`<match>:s:<n>`, `<match>:e:<n>`), voided events and
 *     the revisions of events never uploaded included. The device continuing
 *     the match gives out ids above it: a new event under the id of a voided
 *     one would be born voided (db/015).
 *
 *   POST /api/match/claim { externalId, pin }                           (session, attempt-limited)
 *     The take-over alone: game PIN of that match -> the caller becomes an
 *     editor. Same attempt limits as restore-by-pin.
 *     Limits: 20 attempts per caller in 10 min across all game numbers and 5
 *     per caller and game number; a successful lookup does not count.
 *     The server MUST pass the client IP as `limitKey` (default: one shared bucket).
 *     -> 200 { data: { match, sets, events, liveState }, error: null }
 *     -> 404 { data: null, error: { code: 'OV_NOT_FOUND' } }  (wrong PIN or game number)
 *     -> 429 { data: null, error: { code: 'OV_TOO_MANY_ATTEMPTS' } }
 *
 * Both functions return { status, body } (and `changes` for the realtime
 * write-through) and never throw, like pgQuery.runQuery().
 *
 * Usage:
 *   const { createMatchRestore } = await import('./lib/matchRestore.js')
 *   const restore = createMatchRestore(db)            // db = createPgQuery(...)
 *   const r = await restore.restoreMatch(body, { proto: req.headers['x-ov-proto'] })
 *   const p = await restore.restoreByPin(body, { limitKey: clientIp })
 */
import { createHash } from 'node:crypto'

export const RESTORE_DEFAULTS = Object.freeze({
  matchTable: 'matches',
  matchKey: 'external_id',
  matchId: 'id',
  childFk: 'match_id',
  setsTable: 'sets',
  eventsTable: 'events',
  liveStateTable: 'match_live_state',
  gameNColumn: 'game_n',
  pinColumn: 'game_pin',
  statementTimeoutMs: 60000,
  maxSets: 20,
  maxEvents: 20000,
  childRowCap: 100000,
  // Restored sets/events without sport_type get the match's, else this (the old client flow stamped 'indoor').
  defaultSportType: 'indoor',
  // Keys older clients still send, renamed when the table has the new column but not the old one.
  // backupManager.js builds the restore-in-place live state with `status`.
  legacyAliases: { match_live_state: { status: 'match_status' } },
  // Columns only the server writes (db/005, db/007): dropped from a backup's match row.
  serverOnlyColumns: ['created_by', 'closed_at', 'closed_by', 'official_game_exempt', 'tournament_match_id'],
  // Statuses that close a non-test match (db/007's trigger); a restore sets them last.
  closingStatuses: ['approved', 'final'],
  closingPlaceholderStatus: 'ended',
  // Never in the match that restore-by-pin returns (closed_at stays).
  restoreByPinHidden: ['created_by', 'closed_by', 'official_game_exempt'],
  // Only the key columns travel in the DELETE changes of a restore.
  deleteChangeColumns: ['id', 'external_id', 'match_id'],
  // restore-by-pin: per caller and game number, and per caller across all game numbers.
  pinAttempts: { max: 5, windowMs: 10 * 60 * 1000, maxKeys: 50000 },
  callerAttempts: { max: 20, windowMs: 10 * 60 * 1000, maxKeys: 50000 }
})

const PIN_RE = /^[A-Za-z0-9]{1,32}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const quote = (name) => '"' + String(name).replace(/"/g, '""') + '"'

/**
 * Fixed-window attempt limiter with a bounded key map.
 * - `isLimited(key)` counts one attempt and says whether the key is over the limit.
 * - `refund(key)` takes one attempt back (a successful lookup), `reset(key)` forgets the key.
 * Expired windows are pruned at most once a minute (or once per window, if shorter).
 * When the map is full the oldest windows are evicted first (Map insertion order),
 * so memory stays bounded and a request never walks the whole map.
 */
export function createAttemptLimiter ({ max = 5, windowMs = 600000, maxKeys = 50000 } = {}) {
  const hits = new Map()
  const pruneEveryMs = Math.min(windowMs, 60000)
  let lastPrune = Date.now()
  function prune (now) {
    lastPrune = now
    for (const [k, e] of hits) {
      if (now - e.start <= windowMs) break // insertion order = window start order
      hits.delete(k)
    }
  }
  return {
    isLimited (key) {
      const now = Date.now()
      if (now - lastPrune >= pruneEveryMs) prune(now)
      let e = hits.get(key)
      if (e && now - e.start > windowMs) { hits.delete(key); e = undefined }
      if (!e) {
        while (hits.size >= maxKeys) hits.delete(hits.keys().next().value)
        e = { count: 0, start: now }
        hits.set(key, e)
      }
      e.count++
      return e.count > max
    },
    refund (key) {
      const e = hits.get(key)
      if (e && e.count > 0) e.count--
    },
    reset (key) { hits.delete(key) },
    get size () { return hits.size }
  }
}

/**
 * The brute-force budget of the server's PIN checks: wrong PINs per address
 * bucket (`ipKey`, IPv6 by /64) AND scope, where the scope names what a check
 * compares against (one match's PINs, or one PIN type of every live match),
 * with a larger ceiling per address across all scopes. Same shape as
 * restore-by-pin's limits (per caller and game number, per caller).
 *
 * One limit per address alone locked a whole hall (every tablet behind one
 * venue NAT) out of every PIN check, right PINs included, after about ten
 * typos on one tablet: the bench and a reloading referee of another court, the
 * scoreboard re-proving its own match, a roster upload's wrong PINs the
 * referee connect. Per scope, a run of wrong PINs locks only what was being
 * guessed, and still for the right PIN too (no guessing oracle); the ceiling
 * keeps a sprayer from adding up fresh scopes.
 *
 * - `isLimited(ipKey, scope)` counts one attempt up front (parallel guesses
 *   cannot all slip through) and says whether nothing may be compared. A
 *   refused attempt does not count toward the ceiling (nothing was compared).
 * - `refund(ipKey, scope)` takes the attempt back (a right PIN, or no PIN
 *   compared).
 * - `repeated(ipKey, scope, pin)` after a WRONG PIN: true, and the attempt is
 *   refunded, when the same PIN already failed in this scope within the
 *   window; else it is remembered (as a hash). The same wrong PIN tried again
 *   is no new guess: the apps check a typed PIN twice (the backend, then the
 *   relay), and one typo used to cost two.
 */
export function createPinFailureBudget ({ max = 20, ipMax = 60, windowMs = 600000, maxKeys = 50000 } = {}) {
  const scoped = createAttemptLimiter({ max, windowMs, maxKeys })
  const total = createAttemptLimiter({ max: ipMax, windowMs, maxKeys })
  const wrong = new Map() // hash of ipKey|scope|pin -> time it failed (insertion order = time order)
  const scopeKey = (ipKey, scope) => `${ipKey}|${scope}`
  const budget = {
    isLimited (ipKey, scope) {
      if (total.isLimited(ipKey)) {
        total.refund(ipKey)
        return true
      }
      if (scoped.isLimited(scopeKey(ipKey, scope))) {
        total.refund(ipKey)
        return true
      }
      return false
    },
    refund (ipKey, scope) {
      scoped.refund(scopeKey(ipKey, scope))
      total.refund(ipKey)
    },
    repeated (ipKey, scope, pin) {
      const now = Date.now()
      for (const [k, at] of wrong) {
        if (now - at <= windowMs) break
        wrong.delete(k)
      }
      const k = createHash('sha256').update(`${scopeKey(ipKey, scope)}|${String(pin)}`).digest('base64url')
      const at = wrong.get(k)
      if (at !== undefined && now - at <= windowMs) {
        budget.refund(ipKey, scope)
        return true
      }
      while (wrong.size >= maxKeys) wrong.delete(wrong.keys().next().value)
      wrong.set(k, now)
      return false
    }
  }
  return budget
}

class RestoreAbort extends Error {
  constructor (step, result) {
    super(`restore failed at ${step}`)
    this.step = step
    this.result = result
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function errorBody (status, code, message, details) {
  const error = { message, code }
  if (details) error.details = details
  return { status, body: { data: null, error } }
}

/**
 * @param {ReturnType<import('./pgQuery.js').createPgQuery>} db
 * @param {object} [options]  overrides of RESTORE_DEFAULTS, plus `logger`
 */
export function createMatchRestore (db, options = {}) {
  const cfg = { ...RESTORE_DEFAULTS, ...options }
  const log = options.logger || console
  // lib/pinHash.js hasher; without one PINs are stored and compared as they are.
  const pins = options.pinHasher || {
    enabled: false,
    candidates: (kind, pin) => [String(pin)],
    hashMatchRow: (row) => row
  }
  const pinLimiter = createAttemptLimiter(cfg.pinAttempts)
  const callerLimiter = createAttemptLimiter(cfg.callerAttempts)

  /**
   * Keep only the keys that are columns of `table` (renaming legacy keys first)
   * and record the dropped ones. Old backups and old bundles send extra keys;
   * one of them must not roll back the whole restore.
   */
  function cleanRow (cat, table, row, dropped, label) {
    const t = cat.tables.get(table)
    const aliases = cfg.legacyAliases?.[table] || {}
    const out = {}
    for (const [key, value] of Object.entries(row)) {
      let k = key
      if (!t.columns.has(k) && aliases[k] && t.columns.has(aliases[k]) && !(aliases[k] in row)) k = aliases[k]
      if (t.columns.has(k)) out[k] = value
      else (dropped[label] ||= new Set()).add(key)
    }
    return out
  }

  function duplicateExternalId (rows, ext) {
    const seen = new Set()
    for (const r of rows) {
      const v = r[ext]
      if (v == null) continue
      if (seen.has(v)) return String(v).slice(0, 120)
      seen.add(v)
    }
    return null
  }

  async function restoreMatch (payload, { proto, matchOwner, actorId } = {}) {
    if (!isPlainObject(payload)) return errorBody(400, 'OV_INVALID_REQUEST', 'Invalid request')
    const { match, sets = [], events = [], liveState = null } = payload
    const minProto = db.config.minWriteProto
    if (minProto != null && !(Number(proto) >= minProto)) {
      return errorBody(426, 'OV_CLIENT_TOO_OLD', 'This app version is too old to write. Please reload the app.')
    }
    if (!isPlainObject(match) || typeof match[cfg.matchKey] !== 'string' || !match[cfg.matchKey] || match[cfg.matchKey].length > 200) {
      return errorBody(400, 'OV_INVALID_REQUEST', 'Invalid request', `match.${cfg.matchKey} is required`)
    }
    if (!Array.isArray(sets) || !sets.every(isPlainObject) || sets.length > cfg.maxSets) {
      return errorBody(400, 'OV_INVALID_REQUEST', 'Invalid request', 'sets must be an array of objects')
    }
    if (!Array.isArray(events) || !events.every(isPlainObject) || events.length > cfg.maxEvents) {
      return errorBody(400, 'OV_INVALID_REQUEST', 'Invalid request', 'events must be an array of objects')
    }
    if (liveState != null && !isPlainObject(liveState)) {
      return errorBody(400, 'OV_INVALID_REQUEST', 'Invalid request', 'liveState must be an object')
    }

    try {
      const cat = await db.ensureCatalog()
      const has = (t) => cat.tables.has(t) && db.config.allowedTables.includes(t)
      for (const t of [cfg.matchTable, ...(sets.length ? [cfg.setsTable] : []), ...(events.length ? [cfg.eventsTable] : []), ...(liveState ? [cfg.liveStateTable] : [])]) {
        if (!has(t)) return errorBody(400, '42P01', 'Database operation failed', `${t} is not available`)
      }

      // Rows as they will be written: unknown keys dropped, server keys replaced.
      const dropped = {}
      const { id: _ignored, ...matchIn } = match
      const matchRow = cleanRow(cat, cfg.matchTable, matchIn, dropped, 'match')
      // A backup without the PINs (or with them nulled) keeps the stored ones;
      // JSON secrets (connection_pins) are merged into the stored object below.
      const matchSecrets = db.secretColumnsOf(cfg.matchTable)
      for (const k of matchSecrets) {
        if (k in matchRow && (matchRow[k] == null || matchRow[k] === '')) delete matchRow[k]
      }
      // The creator, the closing stamp and the exemption are the server's to set
      // (pgQuery's ownership guard, db/007's triggers, the admin), never a backup's.
      for (const k of cfg.serverOnlyColumns) delete matchRow[k]
      if (db.config.ownership?.ownerColumn) delete matchRow[db.config.ownership.ownerColumn]
      const storedMatchRow = pins.hashMatchRow(matchRow)
      // A closing status goes in last (after the children), see the header.
      const closingStatus = matchRow.test !== true && cfg.closingStatuses.includes(matchRow.status) ? matchRow.status : null
      const upsertMatchRow = closingStatus ? { ...storedMatchRow, status: cfg.closingPlaceholderStatus } : storedMatchRow
      const sportType = typeof matchRow.sport_type === 'string' && matchRow.sport_type ? matchRow.sport_type : cfg.defaultSportType
      const childRows = (table, rows, label) => {
        const hasSport = cat.tables.get(table).columns.has('sport_type')
        return rows.map(r => {
          const { id: _id, ...rest } = r
          const row = cleanRow(cat, table, rest, dropped, label)
          if (hasSport && row.sport_type == null && sportType) row.sport_type = sportType
          return row
        })
      }
      const setRows = sets.length ? childRows(cfg.setsTable, sets, 'sets') : []
      const eventRows = events.length ? childRows(cfg.eventsTable, events, 'events') : []
      const liveRow = liveState ? childRows(cfg.liveStateTable, [liveState], 'liveState')[0] : null
      for (const [label, rows] of [['sets', setRows], ['events', eventRows]]) {
        const dup = duplicateExternalId(rows, 'external_id')
        if (dup) return errorBody(400, 'OV_INVALID_REQUEST', 'Invalid request', `${label}: duplicate external_id "${dup}"`)
      }
      const droppedOut = Object.fromEntries(Object.entries(dropped).map(([k, v]) => [k, [...v].sort()]))
      if (Object.keys(droppedOut).length) {
        log.warn?.(`[matchRestore] ${match[cfg.matchKey].slice(0, 80)}: dropped unknown keys ${JSON.stringify(droppedOut).slice(0, 300)}`)
      }

      const changes = []
      const out = await db.withTransaction(async (client) => {
        if (typeof actorId === 'string' && UUID_RE.test(actorId)) {
          await client.query("SELECT set_config('ov.user_id', $1, true)", [actorId])
        }
        const run = async (step, request, extra = {}) => {
          const r = await db.runQuery(request, { client, proto, collectChanges: true, ...(matchOwner ? { matchOwner } : {}), ...extra })
          if (r.body.error) throw new RestoreAbort(step, r)
          if (r.changes) changes.push(...r.changes)
          return r
        }
        const up = await run('match', {
          table: cfg.matchTable,
          action: 'upsert',
          params: { data: upsertMatchRow, onConflict: cfg.matchKey, returning: cfg.matchId, single: true }
        }, { mergeOnUpsert: matchSecrets })
        const matchUuid = up.body.data[cfg.matchId]
        const withFk = (row) => ({ ...row, [cfg.childFk]: matchUuid })
        // DELETE changes carry only the keys, so subscribers drop the old rows.
        const del = (table) => run(`delete ${table}`, {
          table, action: 'delete', params: { filters: [{ type: 'eq', column: cfg.childFk, value: matchUuid }] }
        }, { changeColumns: cfg.deleteChangeColumns })
        if (has(cfg.eventsTable)) await del(cfg.eventsTable)
        if (has(cfg.setsTable)) await del(cfg.setsTable)
        if (has(cfg.liveStateTable)) await del(cfg.liveStateTable)

        const counts = { sets: 0, events: 0, liveState: 0 }
        if (setRows.length) {
          const r = await run('sets', { table: cfg.setsTable, action: 'insert', params: { data: setRows.map(withFk), count: 'exact' } })
          counts.sets = r.body.count
        }
        if (eventRows.length) {
          const r = await run('events', { table: cfg.eventsTable, action: 'insert', params: { data: eventRows.map(withFk), count: 'exact' } })
          counts.events = r.body.count
        }
        if (liveRow) {
          const r = await run('liveState', { table: cfg.liveStateTable, action: 'insert', params: { data: withFk(liveRow), count: 'exact' } })
          counts.liveState = r.body.count
        }
        if (closingStatus) {
          await run('close', {
            table: cfg.matchTable,
            action: 'update',
            params: { data: { status: closingStatus }, filters: [{ type: 'eq', column: cfg.matchId, value: matchUuid }] }
          })
        }
        return { id: matchUuid, counts, dropped: droppedOut }
      }, { statementTimeoutMs: cfg.statementTimeoutMs })
      return { status: 200, body: { data: out, error: null }, changes }
    } catch (err) {
      if (err instanceof RestoreAbort) {
        const { status, body } = err.result
        const error = { ...body.error, details: `${err.step}: ${body.error.details || body.error.code}` }
        log.warn?.(`[matchRestore] rolled back at ${err.step}: ${body.error.code}`)
        return { status, body: { data: null, error } }
      }
      // Catalog not loaded, BEGIN/COMMIT failing (serialization, connection) ...
      const r = db.toErrorResult(err, { action: 'restore', table: cfg.matchTable })
      return { status: r.status, body: r.body }
    }
  }

  /**
   * Make `userId` an editor of the match (unless it created it). Never throws;
   * returns 'creator' | 'editor' | null (failed, logged).
   */
  async function addEditor (matchUuid, userId, via) {
    const own = db.config.ownership
    if (!own || typeof userId !== 'string' || !userId) return null
    const table = (name) => `${quote(db.config.schema || 'public')}.${quote(name)}`
    try {
      const r = await db.pool.query(
        `WITH m AS (SELECT ${quote(own.ownerColumn)} AS owner FROM ${table(own.parent)} WHERE ${quote(own.key)} = $1),
              ins AS (INSERT INTO ${table(own.editors.table)} (${quote(own.editors.matchColumn)}, ${quote(own.editors.userColumn)}, granted_via)
                      SELECT $1, $2::uuid, $3 WHERE NOT EXISTS (SELECT 1 FROM m WHERE owner = $2::uuid)
                      ON CONFLICT DO NOTHING RETURNING 1)
         SELECT EXISTS (SELECT 1 FROM m WHERE owner = $2::uuid) AS creator`,
        [matchUuid, userId, via])
      return r.rows[0]?.creator ? 'creator' : 'editor'
    } catch (err) {
      log.warn?.(`[matchRestore] could not add an editor: ${err.code || err.message}`)
      return null
    }
  }

  /**
   * Highest `<n>` of the match's `<ext>:s:<n>` set and `<ext>:e:<n>` event ids
   * (voided events and event_revisions too): { set, event }, null when none.
   * Never throws: without it the device keeps the ids it imported (null).
   */
  async function idFloor (cat, matchUuid, ext) {
    const table = (name) => `${quote(db.config.schema || 'public')}.${quote(name)}`
    const n = (col) => `substr(${col}, length($2::text) + 4)`
    const own = (col, kind) => `left(${col}, length($2::text) + 3) = $2::text || '${kind}' AND ${n(col)} ~ '^[0-9]{1,15}$'`
    const maxOf = (tbl, col, kind) => `SELECT ${n(col)}::bigint AS n FROM ${table(tbl)} WHERE ${quote(cfg.childFk)} = $1 AND ${own(col, kind)}`
    const eventSources = [maxOf(cfg.eventsTable, 'external_id', ':e:')]
    if (cat.tables.has('event_revisions')) eventSources.push(maxOf('event_revisions', 'event_external_id', ':e:'))
    try {
      const r = await db.pool.query(
        `SELECT (SELECT max(n) FROM (${maxOf(cfg.setsTable, 'external_id', ':s:')}) s) AS "set",
                (SELECT max(n) FROM (${eventSources.join(' UNION ALL ')}) e) AS "event"`,
        [matchUuid, ext])
      const toNum = (v) => (v == null ? null : Number(v))
      return { set: toNum(r.rows[0]?.set), event: toNum(r.rows[0]?.event) }
    } catch (err) {
      log.warn?.(`[matchRestore] could not read the id floor: ${err.code || err.message}`)
      return null
    }
  }

  /** Attempt limits shared by restore-by-pin and claim. Returns a 429 result or null. */
  function overLimit (callerKey, gameKey) {
    if (callerLimiter.isLimited(callerKey) || pinLimiter.isLimited(gameKey)) {
      return errorBody(429, 'OV_TOO_MANY_ATTEMPTS', 'Too many attempts. Please wait a few minutes before trying again.')
    }
    return null
  }

  /**
   * POST /api/match/claim { externalId, pin }: the caller (signed in) proves
   * the match's game PIN and becomes an editor of it.
   */
  async function claimMatch (input, { userId, limitKey = 'anon' } = {}) {
    if (!isPlainObject(input)) return errorBody(400, 'OV_INVALID_REQUEST', 'Invalid request')
    const ext = typeof input.externalId === 'string' ? input.externalId.trim() : ''
    const pin = typeof input.pin === 'number' ? String(input.pin) : (typeof input.pin === 'string' ? input.pin.trim() : '')
    if (!ext || ext.length > 200 || !PIN_RE.test(pin)) {
      return errorBody(400, 'OV_INVALID_REQUEST', 'Invalid request', 'externalId and pin are required')
    }
    const callerKey = String(limitKey)
    const gameKey = `${callerKey}|ext:${ext}`
    const limited = overLimit(callerKey, gameKey)
    if (limited) return limited
    try {
      const found = await db.runQuery({
        table: cfg.matchTable,
        action: 'select',
        params: {
          columns: cfg.matchId,
          filters: [
            { type: 'eq', column: cfg.matchKey, value: ext },
            { type: 'in', column: cfg.pinColumn, value: pins.candidates('game', pin) }
          ],
          limit: 1
        }
      }, { internal: true })
      if (found.body.error) return { status: found.status, body: found.body }
      const row = found.body.data[0]
      if (!row) return errorBody(404, 'OV_NOT_FOUND', 'No match with this id and game PIN')
      pinLimiter.reset(gameKey)
      callerLimiter.refund(callerKey)
      const role = await addEditor(row[cfg.matchId], userId, 'claim')
      if (!role) return errorBody(503, 'OV_DB_UNAVAILABLE', 'Service unavailable')
      return { status: 200, body: { data: { id: row[cfg.matchId], external_id: ext, role }, error: null } }
    } catch (err) {
      const r = db.toErrorResult(err, { action: 'claim', table: cfg.matchTable })
      return { status: r.status, body: r.body }
    }
  }

  async function restoreByPin (input, { limitKey = 'anon', editorUserId = null, takeOver = null } = {}) {
    if (!isPlainObject(input)) return errorBody(400, 'OV_INVALID_REQUEST', 'Invalid request')
    const gameN = typeof input.gameN === 'string' && /^\d+$/.test(input.gameN.trim()) ? Number(input.gameN.trim()) : input.gameN
    const pin = typeof input.pin === 'number' ? String(input.pin) : (typeof input.pin === 'string' ? input.pin.trim() : '')
    if (!Number.isInteger(gameN) || gameN < 0 || gameN > 2147483647 || !PIN_RE.test(pin)) {
      return errorBody(400, 'OV_INVALID_REQUEST', 'Invalid request', 'gameN (integer) and pin are required')
    }
    // Per caller across all game numbers first (one guessed PIN cannot be tried
    // against every match), then per caller and game number.
    const callerKey = String(limitKey)
    const gameKey = `${callerKey}|${gameN}`
    const limited = overLimit(callerKey, gameKey)
    if (limited) return limited
    try {
      const cat = await db.ensureCatalog()
      const mt = cat.tables.get(cfg.matchTable)
      if (!mt) return errorBody(400, '42P01', 'Database operation failed')
      const order = mt.columns.has('updated_at') ? [{ column: 'updated_at', ascending: false, nullsFirst: false }]
        : mt.columns.has('created_at') ? [{ column: 'created_at', ascending: false, nullsFirst: false }] : undefined
      // internal: the only place a secret column is filtered on, and only with exact equality.
      const found = await db.runQuery({
        table: cfg.matchTable,
        action: 'select',
        params: {
          columns: '*',
          filters: [
            { type: 'eq', column: cfg.gameNColumn, value: gameN },
            { type: 'in', column: cfg.pinColumn, value: pins.candidates('game', pin) }
          ],
          order,
          limit: 1
        }
      }, { internal: true })
      if (found.body.error) return { status: found.status, body: found.body }
      const row = found.body.data[0]
      if (!row) return errorBody(404, 'OV_NOT_FOUND', 'Match not found with this ID and PIN')
      // Only failed guesses count against the caller.
      pinLimiter.reset(gameKey)
      callerLimiter.refund(callerKey)
      const match = { ...row }
      for (const k of db.secretColumnsOf(cfg.matchTable)) {
        for (const key of Object.keys(match)) if (key.toLowerCase() === k) delete match[key]
      }
      const matchUuid = row[cfg.matchId]
      // A signed-in caller who proved the game PIN may now write the match.
      const editor = editorUserId ? await addEditor(matchUuid, editorUserId, 'restore-by-pin') : null
      for (const k of cfg.restoreByPinHidden) delete match[k]
      // The caller scores the match from here on (before the read: a write
      // of the device it leaves is in what is read, or refused after it)
      let scorer = null
      if (typeof takeOver === 'function') {
        try {
          scorer = await takeOver({ id: matchUuid, external_id: row[cfg.matchKey] })
        } catch (err) {
          log.warn?.(`[matchRestore] scoring-device take-over failed: ${err?.code || err?.message}`)
        }
      }
      const byMatch = [{ type: 'eq', column: cfg.childFk, value: matchUuid }]
      const childOrder = (table, cols) => {
        const t = cat.tables.get(table)
        const col = t && cols.find(c => t.columns.has(c))
        return col ? [{ column: col, ascending: true }] : undefined
      }
      const read = async (table, params) => {
        if (!cat.tables.has(table) || !db.config.allowedTables.includes(table)) return { body: { data: params.maybeSingle ? null : [] } }
        const r = await db.runQuery({ table, action: 'select', params: { columns: '*', filters: byMatch, ...params } }, { maxRows: cfg.childRowCap })
        if (r.body.error) throw Object.assign(new Error('child read failed'), { result: r })
        return r
      }
      const [s, e, l, floor] = await Promise.all([
        read(cfg.setsTable, { order: childOrder(cfg.setsTable, ['index']) }),
        read(cfg.eventsTable, { order: childOrder(cfg.eventsTable, ['seq', 'ts', 'id']) }),
        read(cfg.liveStateTable, { maybeSingle: true }),
        idFloor(cat, matchUuid, row[cfg.matchKey])
      ])
      return { status: 200, body: { data: { match, sets: s.body.data, events: e.body.data, liveState: l.body.data, ...(floor ? { idFloor: floor } : {}), ...(editor ? { access: editor } : {}), ...(scorer ? { scorer } : {}) }, error: null } }
    } catch (err) {
      if (err?.result) return { status: err.result.status, body: err.result.body }
      const r = db.toErrorResult(err, { action: 'restore-by-pin', table: cfg.matchTable })
      return { status: r.status, body: r.body }
    }
  }

  return { restoreMatch, restoreByPin, claimMatch, addEditor, pinLimiter, callerLimiter }
}
