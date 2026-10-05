/**
 * realtimeHub — the server half of the Supabase Realtime replacement.
 *
 * Browsers open a WebSocket to the relay with `?purpose=live` and subscribe to
 * row changes of a few tables. server.js publishes a change after every
 * successful /api/db (or /api/match/restore) write, and for every accepted
 * relay `live-state-update` message (see createLiveStateRelay below). The
 * frontend counterpart is escoresheet/frontend/src/lib/relayRealtime.js, which
 * exposes the supabase-js `channel().on('postgres_changes').subscribe()` API.
 *
 * The hub never touches the database and knows no column names except the
 * ones it is configured with (tables and filter columns are options).
 *
 * ── Wire protocol (version 1, JSON text frames) ─────────────────────────────
 *
 * Server -> client, right after the upgrade:
 *   { type: 'connected', mode: 'live', protocol: 1, timestamp }
 *
 * Client -> server (anything else closes the socket with 1008):
 *   { type: 'subscribe-db', id, subs: [{ table, event, column?, value? }] }
 *       id     channel id chosen by the client (string, 1-128 chars, unique per
 *              socket). Re-sending the same id replaces that channel.
 *       table  one of the configured tables (default matches, sets, events,
 *              match_live_state); `schema` may be sent and must be 'public'.
 *       event  '*' | 'INSERT' | 'UPDATE' | 'DELETE'
 *       column/value  optional equality filter (`<column>=eq.<value>` in
 *              supabase-js syntax). column must be an allowed filter column
 *              (default match_id, external_id, sport_type). value is compared
 *              as a string. Unfiltered subs are refused unless
 *              `allowUnfiltered` is set.
 *     -> { type: 'subscribe-db-ack', id }
 *     -> { type: 'subscribe-db-error', id, code, message }   (socket stays open)
 *   { type: 'unsubscribe-db', id }   -> { type: 'unsubscribe-db-ack', id }
 *   { type: 'ping' }                 -> { type: 'pong', timestamp }
 *
 * Server -> client, for every published row that matches a channel:
 *   { type: 'db-change', id, schema: 'public', table, eventType, new, old,
 *     commit_timestamp, coalesced? }
 *       eventType  'INSERT' | 'UPDATE' | 'DELETE'
 *       new        the row for INSERT/UPDATE, {} for DELETE
 *       old        the row for DELETE (filters are applied to it), otherwise
 *                  the previous row when the publisher supplied one, else {}
 *       coalesced  present when one publish matched more than
 *                  `maxRowsPerPublish` rows for this channel: only the last
 *                  row is sent and `coalesced` holds the number of rows.
 *   A channel gets one message per matching row, not one per matching sub;
 *   the client re-checks its own bindings.
 *
 * Liveness: the hub pings every live socket every `pingIntervalMs` (30 s;
 * Cloudflare closes idle WebSockets after 100 s) and terminates sockets that
 * did not answer the previous ping. Role sockets can share the same heartbeat
 * via `hub.heartbeat.track(ws)`.
 *
 * Secrets: every row is deep-cloned and passed through `redact(table, row)`
 * once per publish, before filters are evaluated, so a filter on a redacted
 * column can never match (no PIN oracle) and redacted columns never leave
 * the process.
 */

const DEFAULT_TABLES = ['matches', 'sets', 'events', 'match_live_state']
const DEFAULT_FILTER_COLUMNS = ['match_id', 'external_id', 'sport_type']
const EVENTS = new Set(['*', 'INSERT', 'UPDATE', 'DELETE'])

export const LIVE_PROTOCOL_VERSION = 1

/**
 * True when an upgrade request asks for a live (realtime) socket.
 * @param {import('node:http').IncomingMessage} req
 */
export function isLiveRequest(req) {
  try {
    const url = new URL(req?.url || '/', 'http://relay.invalid')
    return url.searchParams.get('purpose') === 'live'
  } catch {
    return false
  }
}

/**
 * Map a /api/db action to the eventType argument of broadcastDbChange.
 * @param {'insert'|'update'|'upsert'|'delete'|string} action
 * @returns {'INSERT'|'UPDATE'|'UPSERT'|'DELETE'|null}
 */
export function eventTypeForAction(action) {
  switch (action) {
    case 'insert': return 'INSERT'
    case 'update': return 'UPDATE'
    case 'upsert': return 'UPSERT'
    case 'delete': return 'DELETE'
    default: return null
  }
}

/**
 * Ping/pong heartbeat for any set of ws sockets.
 * @param {{ intervalMs?: number, onTerminate?: (ws) => void }} [opts]
 */
export function createHeartbeat({ intervalMs = 30000, onTerminate } = {}) {
  const alive = new Map() // ws -> boolean (pong seen since last ping)
  let timer = null

  function tick() {
    for (const [ws, seen] of alive) {
      if (ws.readyState !== 1) { // not OPEN
        if (ws.readyState === 3) alive.delete(ws)
        continue
      }
      if (!seen) {
        alive.delete(ws)
        try { onTerminate?.(ws) } catch { /* ignore */ }
        ws.terminate()
        continue
      }
      alive.set(ws, false)
      try { ws.ping() } catch { /* socket went away between checks */ }
    }
  }

  function ensureTimer() {
    if (timer || intervalMs <= 0) return
    timer = setInterval(tick, intervalMs)
    timer.unref?.()
  }

  return {
    /** Start watching a socket. Removed automatically on close. */
    track(ws) {
      alive.set(ws, true)
      ws.on('pong', () => { if (alive.has(ws)) alive.set(ws, true) })
      ws.on('close', () => { alive.delete(ws) })
      ensureTimer()
    },
    untrack(ws) { alive.delete(ws) },
    get size() { return alive.size },
    /** Run one heartbeat round now (tests). */
    tick,
    stop() {
      if (timer) clearInterval(timer)
      timer = null
      alive.clear()
    }
  }
}

function cloneRow(row) {
  if (row == null || typeof row !== 'object') return null
  try { return structuredClone(row) } catch { return JSON.parse(JSON.stringify(row)) }
}

function stripInternal(row) {
  for (const k of Object.keys(row)) {
    if (k.startsWith('__')) delete row[k]
  }
  return row
}

/**
 * @typedef {Object} HubOptions
 * @property {(table: string, row: object) => object} redact  REQUIRED. Strips secret
 *           columns; may mutate and must return the row (server.js redactSecrets fits).
 * @property {string[]} [tables]            Subscribable tables.
 * @property {string[] | ((table: string, column: string) => boolean)} [filterColumns]
 *           Allowed filter columns, or a predicate (e.g. backed by the pgQuery catalog
 *           minus secret columns).
 * @property {boolean} [allowUnfiltered=false]  Allow subs without a filter.
 * @property {number} [maxPerIp=500]       Live sockets per client IP.
 * @property {number} [maxTotal=3000]      Live sockets in total.
 * @property {number} [maxChannelsPerSocket=10]
 * @property {number} [maxSubsPerChannel=10]
 * @property {number} [maxRowsPerPublish=5] Per channel and publish; above this only
 *           the last row is sent with `coalesced`.
 * @property {number} [maxMessageBytes=16384]  Inbound frame limit (close 1009).
 * @property {number} [rateLimitCount=60]  Inbound messages allowed per window...
 * @property {number} [rateLimitWindowMs=10000]  ...per socket (close 1008).
 * @property {number} [maxBufferedBytes=4194304] Slow consumers above this are terminated.
 * @property {number} [pingIntervalMs=30000]
 * @property {(req) => string} [getClientIp]  Used when handleConnection gets no ip.
 * @property {{log:Function, warn:Function}} [logger]
 */

/**
 * @param {HubOptions} options
 */
export function createRealtimeHub(options = {}) {
  const {
    redact,
    tables = DEFAULT_TABLES,
    filterColumns = DEFAULT_FILTER_COLUMNS,
    allowUnfiltered = false,
    maxPerIp = 500,
    maxTotal = 3000,
    maxChannelsPerSocket = 10,
    maxSubsPerChannel = 10,
    maxRowsPerPublish = 5,
    maxMessageBytes = 16 * 1024,
    rateLimitCount = 60,
    rateLimitWindowMs = 10000,
    maxBufferedBytes = 4 * 1024 * 1024,
    pingIntervalMs = 30000,
    getClientIp = (req) => (req?.socket?.remoteAddress || 'unknown').replace('::ffff:', ''),
    logger = console
  } = options

  if (typeof redact !== 'function') {
    throw new TypeError('createRealtimeHub: options.redact(table, row) is required')
  }

  const tableSet = new Set(tables)
  const isFilterColumn = typeof filterColumns === 'function'
    ? filterColumns
    : ((cols) => (_table, column) => cols.has(column))(new Set(filterColumns))

  /** @type {Map<import('ws').WebSocket, {ip:string, channels:Map<string,object>, window:number, count:number}>} */
  const sockets = new Map()
  const ipCounts = new Map()
  /** @type {Map<string, Set<object>>} table -> channels with at least one sub on it */
  const byTable = new Map()
  const counters = { published: 0, delivered: 0, rejected: 0, terminatedSlow: 0 }

  const heartbeat = createHeartbeat({ intervalMs: pingIntervalMs })

  function send(ws, obj) {
    if (ws.readyState !== 1) return false
    ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj))
    return true
  }

  function indexChannel(channel) {
    for (const t of channel.tables) {
      let set = byTable.get(t)
      if (!set) byTable.set(t, (set = new Set()))
      set.add(channel)
    }
  }

  function unindexChannel(channel) {
    for (const t of channel.tables) {
      const set = byTable.get(t)
      if (!set) continue
      set.delete(channel)
      if (set.size === 0) byTable.delete(t)
    }
  }

  function dropSocket(ws) {
    const state = sockets.get(ws)
    if (!state) return
    for (const ch of state.channels.values()) unindexChannel(ch)
    state.channels.clear()
    sockets.delete(ws)
    const n = (ipCounts.get(state.ip) || 1) - 1
    if (n <= 0) ipCounts.delete(state.ip)
    else ipCounts.set(state.ip, n)
  }

  /** Validate one sub; returns a normalised sub or an error string. */
  function parseSub(raw) {
    if (!raw || typeof raw !== 'object') return 'sub must be an object'
    const { table, schema } = raw
    const event = raw.event ?? '*'
    if (schema != null && schema !== 'public') return `unsupported schema: ${String(schema).slice(0, 40)}`
    if (typeof table !== 'string' || !tableSet.has(table)) return `table not subscribable: ${String(table).slice(0, 40)}`
    if (!EVENTS.has(event)) return `unsupported event: ${String(event).slice(0, 20)}`
    const hasColumn = raw.column != null && raw.column !== ''
    if (!hasColumn) {
      if (!allowUnfiltered) return 'a filter is required'
      return { table, event, column: null, value: null }
    }
    const { column } = raw
    if (typeof column !== 'string' || !isFilterColumn(table, column)) {
      return `filter column not allowed: ${String(column).slice(0, 40)}`
    }
    if (raw.op != null && raw.op !== 'eq') return `unsupported filter operator: ${String(raw.op).slice(0, 10)}`
    const value = raw.value
    if (value == null || (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')) {
      return 'filter value must be a string, number or boolean'
    }
    const str = String(value)
    if (str.length === 0 || str.length > 200) return 'filter value length must be 1-200'
    return { table, event, column, value: str }
  }

  function handleSubscribe(ws, state, msg) {
    const id = msg.id
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
      counters.rejected++
      return send(ws, { type: 'subscribe-db-error', id: typeof id === 'string' ? id.slice(0, 128) : null, code: 'invalid_id', message: 'id must be a string of 1-128 chars' })
    }
    const fail = (code, message) => {
      counters.rejected++
      send(ws, { type: 'subscribe-db-error', id, code, message })
    }
    if (!Array.isArray(msg.subs) || msg.subs.length === 0) return fail('invalid_subs', 'subs must be a non-empty array')
    if (msg.subs.length > maxSubsPerChannel) return fail('too_many_subs', `at most ${maxSubsPerChannel} subs per channel`)
    if (!state.channels.has(id) && state.channels.size >= maxChannelsPerSocket) {
      return fail('too_many_channels', `at most ${maxChannelsPerSocket} channels per socket`)
    }
    const subs = []
    for (const raw of msg.subs) {
      const sub = parseSub(raw)
      if (typeof sub === 'string') return fail('invalid_sub', sub)
      subs.push(sub)
    }
    const previous = state.channels.get(id)
    if (previous) unindexChannel(previous)
    const channel = { id, ws, subs, tables: new Set(subs.map(s => s.table)) }
    state.channels.set(id, channel)
    indexChannel(channel)
    send(ws, { type: 'subscribe-db-ack', id })
  }

  function handleUnsubscribe(ws, state, msg) {
    const id = typeof msg.id === 'string' ? msg.id : null
    const channel = id != null ? state.channels.get(id) : null
    if (channel) {
      unindexChannel(channel)
      state.channels.delete(id)
    }
    send(ws, { type: 'unsubscribe-db-ack', id })
  }

  function rateLimited(state) {
    const now = Date.now()
    if (now - state.window >= rateLimitWindowMs) {
      state.window = now
      state.count = 0
    }
    state.count++
    return state.count > rateLimitCount
  }

  /**
   * Take over a `?purpose=live` socket. Call it from wss.on('connection')
   * before any role-socket bookkeeping, then return.
   * @param {import('ws').WebSocket} ws
   * @param {import('node:http').IncomingMessage} req
   * @param {{ ip?: string }} [info]
   * @returns {boolean} false when the socket was refused (already closed)
   */
  function handleConnection(ws, req, info = {}) {
    const ip = info.ip || getClientIp(req)
    if (sockets.size >= maxTotal) {
      ws.close(1013, 'Live connection limit reached')
      return false
    }
    if ((ipCounts.get(ip) || 0) >= maxPerIp) {
      ws.close(1008, 'Too many live connections from this IP')
      return false
    }

    const state = { ip, channels: new Map(), window: Date.now(), count: 0 }
    sockets.set(ws, state)
    ipCounts.set(ip, (ipCounts.get(ip) || 0) + 1)
    heartbeat.track(ws)

    ws.on('message', (data, isBinary) => {
      if (!sockets.has(ws)) return
      if (isBinary) return ws.close(1003, 'Text frames only')
      const size = data?.length ?? 0
      if (size > maxMessageBytes) return ws.close(1009, 'Message too large')
      if (rateLimited(state)) return ws.close(1008, 'Rate limit exceeded')
      let msg
      try { msg = JSON.parse(data.toString()) } catch { return ws.close(1008, 'Invalid JSON') }
      if (!msg || typeof msg !== 'object') return ws.close(1008, 'Invalid message')
      switch (msg.type) {
        case 'subscribe-db': return handleSubscribe(ws, state, msg)
        case 'unsubscribe-db': return handleUnsubscribe(ws, state, msg)
        case 'ping': return send(ws, { type: 'pong', timestamp: Date.now() })
        default: return ws.close(1008, 'Message type not allowed on live sockets')
      }
    })
    ws.on('close', () => dropSocket(ws))
    ws.on('error', (err) => {
      logger?.warn?.('[realtimeHub] socket error:', err?.message || err)
    })

    send(ws, { type: 'connected', mode: 'live', protocol: LIVE_PROTOCOL_VERSION, timestamp: new Date().toISOString() })
    return true
  }

  function rowMatches(sub, eventType, row) {
    if (sub.event !== '*' && sub.event !== eventType) return false
    if (sub.column == null) return true
    if (!row) return false
    const v = row[sub.column]
    return v != null && String(v) === sub.value
  }

  /**
   * Publish changed rows to matching subscribers.
   *
   * @param {string} table
   * @param {'INSERT'|'UPDATE'|'UPSERT'|'DELETE'} eventType  UPSERT resolves each row
   *        to INSERT/UPDATE through its `__inserted` flag (missing -> UPDATE).
   * @param {object|object[]} rows  RETURNING * rows. For DELETE these are the old rows.
   * @param {{ oldRows?: object[], commitTimestamp?: string }} [opts]
   *        oldRows: previous versions for UPDATE, index-aligned with rows (optional).
   * @returns {number} messages sent
   */
  function broadcastDbChange(table, eventType, rows, opts = {}) {
    const channels = byTable.get(table)
    if (!channels || channels.size === 0) return 0
    const list = Array.isArray(rows) ? rows : (rows ? [rows] : [])
    if (list.length === 0) return 0
    const commitTimestamp = opts.commitTimestamp || new Date().toISOString()
    const oldRows = Array.isArray(opts.oldRows) ? opts.oldRows : null
    counters.published++

    // Prepare each row once: clone, resolve upsert, strip internals, redact.
    const prepared = []
    for (let i = 0; i < list.length; i++) {
      const raw = list[i]
      if (!raw || typeof raw !== 'object') continue
      let type = eventType
      if (type === 'UPSERT') type = raw.__inserted === true ? 'INSERT' : 'UPDATE'
      if (type !== 'INSERT' && type !== 'UPDATE' && type !== 'DELETE') continue
      let row = cloneRow(raw)
      if (!row) continue
      row = redact(table, stripInternal(row)) || row
      let previous = null
      if (type === 'UPDATE' && oldRows && oldRows[i]) {
        previous = cloneRow(oldRows[i])
        if (previous) previous = redact(table, stripInternal(previous)) || previous
      }
      const payload = type === 'DELETE'
        ? { schema: 'public', table, commit_timestamp: commitTimestamp, eventType: type, new: {}, old: row }
        : { schema: 'public', table, commit_timestamp: commitTimestamp, eventType: type, new: row, old: previous || {} }
      prepared.push({ type, row, payload, json: null })
    }
    if (prepared.length === 0) return 0

    let sent = 0
    for (const channel of channels) {
      const matched = []
      for (const p of prepared) {
        if (channel.subs.some(sub => sub.table === table && rowMatches(sub, p.type, p.row))) matched.push(p)
      }
      if (matched.length === 0) continue
      const ws = channel.ws
      if (ws.readyState !== 1) continue
      if (ws.bufferedAmount > maxBufferedBytes) {
        counters.terminatedSlow++
        logger?.warn?.('[realtimeHub] terminating slow live socket', sockets.get(ws)?.ip)
        ws.terminate()
        continue
      }
      const toSend = matched.length > maxRowsPerPublish ? [matched[matched.length - 1]] : matched
      const coalesced = matched.length > maxRowsPerPublish ? matched.length : 0
      for (const p of toSend) {
        if (p.json == null) p.json = JSON.stringify(p.payload)
        // Splice the channel id in front of the shared body: no per-channel stringify.
        const head = `{"type":"db-change","id":${JSON.stringify(channel.id)}${coalesced ? `,"coalesced":${coalesced}` : ''},`
        ws.send(head + p.json.slice(1))
        sent++
      }
    }
    counters.delivered += sent
    return sent
  }

  /** Numbers for /health and logs. */
  function stats() {
    let channels = 0
    for (const s of sockets.values()) channels += s.channels.size
    return {
      sockets: sockets.size,
      ips: ipCounts.size,
      channels,
      tables: Object.fromEntries([...byTable].map(([t, set]) => [t, set.size])),
      ...counters
    }
  }

  /** Close every live socket and stop the heartbeat (shutdown, tests). */
  function close(code = 1001, reason = 'Server shutting down') {
    heartbeat.stop()
    for (const ws of [...sockets.keys()]) {
      try { ws.close(code, reason) } catch { /* ignore */ }
      dropSocket(ws)
    }
  }

  return {
    isLiveRequest,
    handleConnection,
    broadcastDbChange,
    publish: broadcastDbChange,
    heartbeat,
    stats,
    close
  }
}

/**
 * Turns relay `live-state-update` messages from the scoreboard into
 * `match_live_state` UPDATE db-change events, so livescore and the referee
 * alarm keep moving when the scorer's HTTP sync is down.
 *
 * @param {Object} opts
 * @param {ReturnType<typeof createRealtimeHub>} opts.hub
 * @param {(externalId: string) => Promise<object|null>} opts.lookupMatch
 *        Resolves the relay match id (seed key / matches.external_id) to the
 *        match row, at least `{ id, sport_type }`. Wire to pgQuery, e.g.
 *        runQuery({table:'matches', action:'select', columns:'id,sport_type',
 *        filters:[{type:'eq',column:'external_id',value}], maybeSingle:true}, {internal:true}).
 * @param {string} [opts.table='match_live_state']
 * @param {string} [opts.fkColumn='match_id']  set to the resolved `id`
 * @param {string[]} [opts.carryColumns=['sport_type']]  copied from the lookup result
 * @param {(table: string, column: string) => boolean} [opts.allowColumn]
 *        Optional catalog check; keys it rejects are dropped from the row.
 * @param {(client: object, message: object) => boolean} [opts.isAuthorized]
 *        Default: client.role === 'scoreboard' and client.matchId === message.matchId.
 * @param {number} [opts.cacheTtlMs=600000]
 * @param {number} [opts.negativeCacheTtlMs=30000]
 * @param {number} [opts.maxCacheEntries=2000]
 * @param {number} [opts.maxPayloadBytes=262144]
 */
export function createLiveStateRelay({
  hub,
  lookupMatch,
  table = 'match_live_state',
  fkColumn = 'match_id',
  carryColumns = ['sport_type'],
  allowColumn,
  isAuthorized = (client, message) =>
    client?.role === 'scoreboard' && client?.matchId != null && String(client.matchId) === String(message?.matchId),
  cacheTtlMs = 10 * 60 * 1000,
  negativeCacheTtlMs = 30 * 1000,
  maxCacheEntries = 2000,
  maxPayloadBytes = 256 * 1024
} = {}) {
  if (!hub || typeof hub.broadcastDbChange !== 'function') throw new TypeError('createLiveStateRelay: hub is required')
  if (typeof lookupMatch !== 'function') throw new TypeError('createLiveStateRelay: lookupMatch is required')

  const cache = new Map() // externalId -> { value, expires }
  const pending = new Map() // externalId -> Promise

  async function resolve(externalId) {
    const now = Date.now()
    const hit = cache.get(externalId)
    if (hit && hit.expires > now) return hit.value
    if (pending.has(externalId)) return pending.get(externalId)
    const p = (async () => {
      try {
        const row = await lookupMatch(externalId)
        const value = row && row.id != null ? row : null
        if (cache.size >= maxCacheEntries) cache.delete(cache.keys().next().value)
        cache.set(externalId, { value, expires: Date.now() + (value ? cacheTtlMs : negativeCacheTtlMs) })
        return value
      } finally {
        pending.delete(externalId)
      }
    })()
    pending.set(externalId, p)
    return p
  }

  /**
   * @param {object} client   server.js clientInfo ({ role, matchId, ... })
   * @param {{ matchId: string, liveState: object }} message
   * @returns {Promise<{ ok: boolean, reason?: string, sent?: number }>}
   */
  async function handle(client, message) {
    const externalId = message?.matchId
    const liveState = message?.liveState
    if (externalId == null || (typeof externalId !== 'string' && typeof externalId !== 'number')) return { ok: false, reason: 'missing_match_id' }
    if (!liveState || typeof liveState !== 'object' || Array.isArray(liveState)) return { ok: false, reason: 'invalid_live_state' }
    if (!isAuthorized(client, message)) return { ok: false, reason: 'forbidden' }
    let size
    try { size = JSON.stringify(liveState).length } catch { return { ok: false, reason: 'invalid_live_state' } }
    if (size > maxPayloadBytes) return { ok: false, reason: 'too_large' }

    let match
    try {
      match = await resolve(String(externalId))
    } catch (err) {
      return { ok: false, reason: 'lookup_failed', error: err }
    }
    if (!match) return { ok: false, reason: 'unknown_match' }

    const row = {}
    for (const [k, v] of Object.entries(liveState)) {
      if (k.startsWith('__')) continue
      if (allowColumn && !allowColumn(table, k)) continue
      row[k] = v
    }
    // Never trust the client for the keys subscribers filter on.
    row[fkColumn] = match.id
    for (const c of carryColumns) {
      if (match[c] !== undefined) row[c] = match[c]
    }
    const sent = hub.broadcastDbChange(table, 'UPDATE', [row])
    return { ok: true, sent }
  }

  return {
    handle,
    resolve,
    /** Forget a cached match (call after a matches DELETE or external_id change). */
    invalidate(externalId) { cache.delete(String(externalId)) },
    clear() { cache.clear() }
  }
}
