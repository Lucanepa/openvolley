/**
 * matchRestore — the two match endpoints that replace multi-step client flows.
 *
 *   POST /api/match/restore        { match, sets, events, liveState }   (needs a session)
 *     One transaction: upsert the match by external_id, delete its events,
 *     sets and live state, insert the sets and events (the pgQuery id scope
 *     guard applies) and the live state. Any failure rolls everything back.
 *     -> 200 { data: { id, counts: { sets, events, liveState } }, error: null }
 *
 *   POST /api/match/restore-by-pin { gameN, pin }                        (anonymous, attempt-limited)
 *     Exact match on game number AND game PIN. Returns the match with its
 *     secret columns stripped, plus its sets, events and live state.
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
  pinAttempts: { max: 5, windowMs: 10 * 60 * 1000 }
})

const PIN_RE = /^[A-Za-z0-9]{1,32}$/

/**
 * Fixed-window attempt limiter. `isLimited(key)` counts one attempt and says
 * whether the caller is over the limit.
 */
export function createAttemptLimiter ({ max = 5, windowMs = 600000, maxKeys = 50000 } = {}) {
  const hits = new Map()
  function prune (now) {
    for (const [k, e] of hits) if (now - e.start > windowMs) hits.delete(k)
  }
  return {
    isLimited (key) {
      const now = Date.now()
      let e = hits.get(key)
      if (!e || now - e.start > windowMs) {
        e = { count: 0, start: now }
        hits.set(key, e)
      }
      e.count++
      if (hits.size > maxKeys) prune(now)
      return e.count > max
    },
    reset (key) { hits.delete(key) },
    get size () { return hits.size }
  }
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
  const pinLimiter = createAttemptLimiter(cfg.pinAttempts)

  // Server-generated keys are dropped from restored rows; children get the new match id.
  function childRow (row, matchUuid) {
    const { id, ...rest } = row
    return { ...rest, [cfg.childFk]: matchUuid }
  }

  async function restoreMatch (payload, { proto } = {}) {
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
      const changes = []
      const out = await db.withTransaction(async (client) => {
        const run = async (step, request, collectChanges = true) => {
          const r = await db.runQuery(request, { client, proto, collectChanges })
          if (r.body.error) throw new RestoreAbort(step, r)
          if (r.changes) changes.push(...r.changes)
          return r
        }
        const { id: _ignored, ...matchRow } = match
        const up = await run('match', {
          table: cfg.matchTable,
          action: 'upsert',
          params: { data: matchRow, onConflict: cfg.matchKey, returning: cfg.matchId, single: true }
        })
        const matchUuid = up.body.data[cfg.matchId]
        const del = (table) => run(`delete ${table}`, {
          table, action: 'delete', params: { filters: [{ type: 'eq', column: cfg.childFk, value: matchUuid }] }
        }, false)
        if (has(cfg.eventsTable)) await del(cfg.eventsTable)
        if (has(cfg.setsTable)) await del(cfg.setsTable)
        if (has(cfg.liveStateTable)) await del(cfg.liveStateTable)

        const counts = { sets: 0, events: 0, liveState: 0 }
        if (sets.length) {
          const r = await run('sets', { table: cfg.setsTable, action: 'insert', params: { data: sets.map(s => childRow(s, matchUuid)), count: 'exact' } })
          counts.sets = r.body.count
        }
        if (events.length) {
          const r = await run('events', { table: cfg.eventsTable, action: 'insert', params: { data: events.map(e => childRow(e, matchUuid)), count: 'exact' } })
          counts.events = r.body.count
        }
        if (liveState) {
          const r = await run('liveState', { table: cfg.liveStateTable, action: 'insert', params: { data: childRow(liveState, matchUuid), count: 'exact' } })
          counts.liveState = r.body.count
        }
        return { id: matchUuid, counts }
      }, { statementTimeoutMs: cfg.statementTimeoutMs })
      return { status: 200, body: { data: out, error: null }, changes }
    } catch (err) {
      if (err instanceof RestoreAbort) {
        const { status, body } = err.result
        const error = { ...body.error, details: `${err.step}: ${body.error.details || body.error.code}` }
        log.warn?.(`[matchRestore] rolled back at ${err.step}: ${body.error.code}`)
        return { status, body: { data: null, error } }
      }
      if (err?.status && err?.code) return errorBody(err.status, err.code, err.message)
      log.error?.('[matchRestore] restore failed:', err?.message)
      return errorBody(500, 'OV_INTERNAL', 'Database operation failed')
    }
  }

  async function restoreByPin (input, { limitKey = 'anon' } = {}) {
    if (!isPlainObject(input)) return errorBody(400, 'OV_INVALID_REQUEST', 'Invalid request')
    const gameN = typeof input.gameN === 'string' && /^\d+$/.test(input.gameN.trim()) ? Number(input.gameN.trim()) : input.gameN
    const pin = typeof input.pin === 'number' ? String(input.pin) : (typeof input.pin === 'string' ? input.pin.trim() : '')
    if (!Number.isInteger(gameN) || gameN < 0 || gameN > 2147483647 || !PIN_RE.test(pin)) {
      return errorBody(400, 'OV_INVALID_REQUEST', 'Invalid request', 'gameN (integer) and pin are required')
    }
    if (pinLimiter.isLimited(`${limitKey}|${gameN}`)) {
      return errorBody(429, 'OV_TOO_MANY_ATTEMPTS', 'Too many attempts. Please wait a few minutes before trying again.')
    }
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
            { type: 'eq', column: cfg.pinColumn, value: pin }
          ],
          order,
          limit: 1
        }
      }, { internal: true })
      if (found.body.error) return { status: found.status, body: found.body }
      const row = found.body.data[0]
      if (!row) return errorBody(404, 'OV_NOT_FOUND', 'Match not found with this ID and PIN')
      const match = { ...row }
      for (const k of db.secretColumnsOf(cfg.matchTable)) {
        for (const key of Object.keys(match)) if (key.toLowerCase() === k) delete match[key]
      }
      const matchUuid = row[cfg.matchId]
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
      const [s, e, l] = await Promise.all([
        read(cfg.setsTable, { order: childOrder(cfg.setsTable, ['index']) }),
        read(cfg.eventsTable, { order: childOrder(cfg.eventsTable, ['seq', 'ts', 'id']) }),
        read(cfg.liveStateTable, { maybeSingle: true })
      ])
      return { status: 200, body: { data: { match, sets: s.body.data, events: e.body.data, liveState: l.body.data }, error: null } }
    } catch (err) {
      if (err?.result) return { status: err.result.status, body: err.result.body }
      log.error?.('[matchRestore] restore-by-pin failed:', err?.message)
      return errorBody(500, 'OV_INTERNAL', 'Database operation failed')
    }
  }

  return { restoreMatch, restoreByPin, pinLimiter }
}
