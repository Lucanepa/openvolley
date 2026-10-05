/**
 * pgQuery — the Postgres replacement for the Supabase/PostgREST calls behind
 * POST /api/db.
 *
 * It accepts exactly what `frontend/src/lib/apiClient.js` sends today
 *   { table, action: select|insert|update|upsert|delete,
 *     params: { columns, filters:[{type,column,value}], order:[{column,ascending,nullsFirst}],
 *               limit, single, maybeSingle, count, head, onConflict, data, returning } }
 * and answers with the same shape as before: { data, error, count }.
 *
 * Safety model (see the migration plan, section 4 Phase 2):
 * - Every value is a bind parameter. Identifiers are never taken from the
 *   request as text: each one must be a plain identifier that exists in the
 *   catalog, which is loaded lazily from information_schema (and retried with
 *   backoff while the database is down).
 * - Tables must be on the allowlist. Per-table secret columns can never be
 *   selected, returned, filtered, ordered on or used as an upsert target, also
 *   not through aliases, JSON paths or casts. A select naming a secret column
 *   silently leaves it out (that is what the redacting proxy returned before).
 * - Output is built with json_agg, which is how PostgREST serialises rows.
 * - `update` on the configured JSON columns of `matches` merges objects on the
 *   server, atomically: col = col || $value.
 * - sets/events: every external_id must start with its match's external_id
 *   followed by a separator, and update/delete must be scoped to one match.
 *   An upsert never overwrites or moves a conflicting row of another match.
 * - Writes need X-OV-Proto >= 2 (426 otherwise).
 * - `internal: true` (trusted server code only) skips redaction, the secret
 *   bans and the protocol gate.
 *
 * Usage (server.js loads this lazily, only when DATABASE_URL is set):
 *   const { createPgQuery } = await import('./lib/pgQuery.js')
 *   const db = createPgQuery({ connectionString: process.env.DATABASE_URL, secretColumns: SECRET_COLUMNS })
 *   const r = await db.runQuery({ table, action, params }, { proto: req.headers['x-ov-proto'] })
 *   res.writeHead(r.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r.body))
 */

import pg from 'pg'

// ---------------------------------------------------------------------------
// Defaults (mirror server.js / frontend matchRepository.js as of 2026-10)
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG = Object.freeze({
  schema: 'public',
  allowedTables: ['matches', 'sets', 'events', 'match_live_state', 'profiles', 'referee_database',
    'user_matches', 'svrz_games', 'beach_competition_matches', 'teams'],
  // Never returned, filtered, ordered or used as conflict target (unless internal).
  // Names that do not exist in the catalog are simply ignored.
  secretColumns: {
    matches: ['game_pin', 'connection_pins'],
    events: ['game_pin'],
    match_live_state: ['game_pin', 'connection_pins']
  },
  // `update` of these columns merges a JSON object into the stored object.
  // Server copy of JSONB_COLUMNS (frontend/src/db/matchRepository.js:24).
  mergeJsonColumns: {
    matches: ['connections', 'connection_pins', 'team_a', 'team_b', 'officials', 'coin_toss', 'set_results', 'sanctions']
  },
  // Child tables whose external_id must be prefixed with the parent's external_id.
  scopedChildren: {
    sets: { fk: 'match_id', ext: 'external_id' },
    events: { fk: 'match_id', ext: 'external_id' }
  },
  scopeParent: { table: 'matches', key: 'id', ext: 'external_id' },
  // Characters allowed right after the match external_id in a child id
  // (`${seed}:s:${n}` from syncIds.js, `${externalId}_set_${n}` from backupManager).
  scopeSeparators: [':', '_'],
  // The only embedded selects that are understood. Matched after removing whitespace.
  embeds: {
    match_live_state: [{
      select: '*, matches!match_live_state_match_id_fkey_cascade(set_results)',
      as: 'matches',
      table: 'matches',
      localColumn: 'match_id',
      foreignColumn: 'id',
      columns: ['set_results']
    }]
  },
  // Match ownership (opts.matchOwner): who may write a match and its children.
  // Owned = parent.ownerColumn is the caller, or an editors row names the
  // caller. Applied only when the caller passes opts.matchOwner (server.js
  // does for every non-admin session); never for other tables.
  ownership: {
    parent: 'matches',
    key: 'id',
    ownerColumn: 'created_by',
    editors: { table: 'match_editors', matchColumn: 'match_id', userColumn: 'user_id' },
    children: { sets: 'match_id', events: 'match_id', match_live_state: 'match_id' }
  },
  // Tables whose writes produce `changes` (for the realtime write-through).
  changeTables: ['matches', 'sets', 'events', 'match_live_state'],
  maxRows: 1000,
  minWriteProto: 2,
  statementTimeoutMs: 10000,
  poolMax: 5,
  catalogRetryInitialMs: 1000,
  catalogRetryMaxMs: 30000,
  catalogRefreshMinMs: 60000
})

const ACTIONS = ['select', 'insert', 'update', 'upsert', 'delete']
const FILTER_TYPES = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'in', 'contains', 'is']
const COMPARE_OPS = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/
const COLUMN_REF_RE = /^([A-Za-z_][A-Za-z0-9_]{0,62})(?:->>([a-z0-9_]{1,63}))?$/
const GENERIC_MESSAGE = 'Database operation failed'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DB_ERROR_INVALIDATES_CATALOG = new Set(['42P01', '42703'])

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class PgQueryError extends Error {
  constructor (status, code, details, message = GENERIC_MESSAGE) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

function fail (code, details, status = 400) {
  throw new PgQueryError(status, code, details)
}

function safeText (v) {
  return String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120)
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Double-quote an identifier that already passed IDENT_RE and the catalog. */
export function quoteIdent (name) {
  return '"' + String(name).replace(/"/g, '""') + '"'
}

/** Lower-cased identifier-like tokens of a raw reference ("x:game_pin::text" -> x, game_pin, text). */
function tokensOf (raw) {
  return String(raw).toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean)
}

/** True when any token of `raw` names a secret column (catches aliases, casts, JSON paths, quoting). */
export function mentionsSecret (raw, secretSet) {
  if (!secretSet || secretSet.size === 0) return false
  return tokensOf(raw).some(t => secretSet.has(t))
}

/** Parse `col` or `col->>key`. Returns null when the shape is not allowed. */
export function parseColumnRef (raw) {
  if (typeof raw !== 'string') return null
  const m = COLUMN_REF_RE.exec(raw.trim())
  if (!m) return null
  return { column: m[1], jsonKey: m[2] || null }
}

/** Split a PostgREST-style column list. Returns ['*'] for empty input. Throws on bad shapes. */
export function parseColumnList (raw, { what = 'select' } = {}) {
  if (raw == null || raw === true) return ['*']
  if (typeof raw !== 'string' || raw.length > 4000) fail('OV_INVALID_SELECT', `${what} must be a string`)
  const parts = raw.split(',').map(s => s.trim())
  if (parts.length === 1 && parts[0] === '') return ['*']
  for (const p of parts) {
    if (p !== '*' && !IDENT_RE.test(p)) fail('OV_INVALID_SELECT', `unsupported ${what} item "${safeText(p)}"`)
  }
  return parts
}

// Transient SQLSTATEs: the same request can succeed when retried, so they are
// 5xx (the sync queue keeps 5xx jobs queued and drops 4xx ones).
const RETRYABLE_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300' // too_many_connections
])

/** HTTP status for a Postgres SQLSTATE: 504 timeout, 503 transient, 400 otherwise. */
export function sqlstateStatus (code) {
  if (code === '57014') return 504
  if (RETRYABLE_SQLSTATES.has(code) || String(code).startsWith('08')) return 503
  return 400
}

function isScalar (v) {
  return typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
}

function isPlainObject (v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {string} [options.connectionString]  DATABASE_URL
 * @param {pg.Pool} [options.pool]             existing pool (tests); must set TimeZone=UTC itself
 * @param {object} [options.logger]            console-like ({log, warn, error})
 * plus any DEFAULT_CONFIG key to override.
 */
export function createPgQuery (options = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...options }
  const log = options.logger || console
  for (const t of cfg.allowedTables) {
    if (!IDENT_RE.test(t)) throw new Error(`pgQuery: invalid table name in allowedTables: ${t}`)
  }
  if (!IDENT_RE.test(cfg.schema)) throw new Error('pgQuery: invalid schema name')

  const pool = options.pool || new pg.Pool({
    connectionString: cfg.connectionString,
    max: cfg.poolMax,
    // Every connection serialises timestamps as UTC (like Supabase) and has a statement timeout.
    options: `-c TimeZone=UTC -c statement_timeout=${Number(cfg.statementTimeoutMs) | 0}`,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000
  })
  const ownsPool = !options.pool
  // An idle client losing its connection must not crash the process.
  pool.on('error', (err) => log.error('[pgQuery] idle client error:', err.message))

  const secretSets = new Map()
  for (const [table, cols] of Object.entries(cfg.secretColumns || {})) {
    secretSets.set(table, new Set(cols.map(c => String(c).toLowerCase())))
  }
  const NO_SECRETS = new Set()
  const secretsFor = (table, internal) => (internal ? NO_SECRETS : (secretSets.get(table) || NO_SECRETS))

  // ------------------------------------------------------------------ catalog
  let catalog = null
  let catalogPromise = null
  let catalogError = null
  let catalogLoadedAt = null
  let retryDelay = cfg.catalogRetryInitialMs
  let nextAttemptAt = 0

  async function loadCatalogNow () {
    const cols = await pool.query(
      `SELECT isc.table_name, isc.column_name, isc.data_type, isc.udt_name,
              format_type(a.atttypid, a.atttypmod) AS type_sql
         FROM information_schema.columns isc
         JOIN pg_catalog.pg_namespace n ON n.nspname = isc.table_schema
         JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = isc.table_name
         JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attname = isc.column_name
        WHERE isc.table_schema = $1
        ORDER BY isc.table_name, isc.ordinal_position`, [cfg.schema])
    const pks = await pool.query(
      `SELECT c.relname AS table_name, a.attname AS column_name
         FROM pg_catalog.pg_index i
         JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
        WHERE n.nspname = $1 AND i.indisprimary
        ORDER BY c.relname, array_position(i.indkey::int2[], a.attnum)`, [cfg.schema])
    const tables = new Map()
    for (const r of cols.rows) {
      if (!IDENT_RE.test(r.table_name) || !IDENT_RE.test(r.column_name)) continue
      let t = tables.get(r.table_name)
      if (!t) { t = { name: r.table_name, columns: new Map(), order: [], pk: [] }; tables.set(r.table_name, t) }
      t.columns.set(r.column_name, {
        name: r.column_name,
        dataType: r.data_type,
        udtName: r.udt_name,
        typeSql: r.type_sql,
        isJson: r.data_type === 'json' || r.data_type === 'jsonb',
        isArray: r.data_type === 'ARRAY'
      })
      t.order.push(r.column_name)
    }
    for (const r of pks.rows) tables.get(r.table_name)?.pk.push(r.column_name)
    return { tables, allowed: cfg.allowedTables.filter(t => tables.has(t)) }
  }

  /** Load the catalog on first use; on failure retry with backoff (1, 2, 4 ... 30 s). */
  async function ensureCatalog () {
    if (catalog) return catalog
    if (catalogPromise) return catalogPromise
    if (Date.now() < nextAttemptAt) {
      throw new PgQueryError(503, 'OV_DB_UNAVAILABLE', 'catalog not loaded yet', 'Database unavailable')
    }
    catalogPromise = (async () => {
      try {
        const c = await loadCatalogNow()
        if (c.allowed.length === 0) throw new Error(`no allowlisted tables in schema ${cfg.schema}`)
        catalog = c
        catalogError = null
        catalogLoadedAt = new Date().toISOString()
        lastRefreshAt = Date.now()
        retryDelay = cfg.catalogRetryInitialMs
        log.log?.(`[pgQuery] catalog loaded: ${c.tables.size} tables, ${c.allowed.length} allowed`)
        return c
      } catch (err) {
        catalogError = err.message
        nextAttemptAt = Date.now() + retryDelay
        log.warn?.(`[pgQuery] catalog load failed (retry in ${retryDelay} ms):`, err.message)
        retryDelay = Math.min(retryDelay * 2, cfg.catalogRetryMaxMs)
        throw new PgQueryError(503, 'OV_DB_UNAVAILABLE', 'catalog not loaded yet', 'Database unavailable')
      } finally {
        catalogPromise = null
      }
    })()
    return catalogPromise
  }

  /** Drop the catalog; the next request reloads it (503 while the database is down). */
  function invalidateCatalog () {
    catalog = null
    nextAttemptAt = 0
  }

  // Background refresh after an unknown table/column (e.g. a column added after
  // startup). The old catalog keeps serving until the new one is loaded, and a
  // refresh runs at most once per catalogRefreshMinMs, so clients cannot force reloads.
  let lastRefreshAt = 0
  let refreshPromise = null
  function scheduleCatalogRefresh () {
    if (!catalog || refreshPromise || Date.now() - lastRefreshAt < cfg.catalogRefreshMinMs) return
    lastRefreshAt = Date.now()
    refreshPromise = loadCatalogNow()
      .then((c) => {
        if (c.allowed.length === 0) return
        catalog = c
        catalogLoadedAt = new Date().toISOString()
      })
      .catch((err) => log.warn?.('[pgQuery] catalog refresh failed:', err.message))
      .finally(() => { refreshPromise = null })
  }

  function catalogStatus () {
    return {
      ok: !!catalog,
      tables: catalog ? catalog.allowed.length : 0,
      loadedAt: catalogLoadedAt,
      error: catalog ? null : catalogError
    }
  }

  // ------------------------------------------------------------ SQL helpers
  const qTable = (name) => `${quoteIdent(cfg.schema)}.${quoteIdent(name)}`

  function tableDef (cat, table) {
    if (typeof table !== 'string' || !cfg.allowedTables.includes(table)) fail('OV_TABLE_NOT_ALLOWED', 'table not allowed')
    const t = cat.tables.get(table)
    if (!t) {
      scheduleCatalogRefresh()
      fail('42P01', `relation "${table}" does not exist`)
    }
    return t
  }

  function requireColumn (t, name, what = 'column') {
    if (typeof name !== 'string' || !IDENT_RE.test(name) || !t.columns.has(name)) {
      log.warn?.(`[pgQuery] unknown ${what} on ${t.name}: ${safeText(name)}`)
      if (typeof name === 'string' && IDENT_RE.test(name)) scheduleCatalogRefresh()
      fail('PGRST204', `unknown ${what} "${safeText(name)}" on ${t.name}`)
    }
    return t.columns.get(name)
  }

  /** Resolve `col` / `col->>key` for filters and order. Secret references are refused. */
  function resolveRef (t, raw, secrets, ctx) {
    if (typeof raw !== 'string' || raw.length > 200) fail('OV_INVALID_FILTER', 'column must be a string')
    if (mentionsSecret(raw, secrets)) fail('OV_SECRET_FILTER', 'secret column')
    const ref = parseColumnRef(raw)
    if (!ref) fail('OV_INVALID_FILTER', `unsupported column reference "${safeText(raw)}"`)
    const col = requireColumn(t, ref.column)
    if (!ref.jsonKey) return { col, sql: `t.${quoteIdent(col.name)}`, isText: false }
    if (!col.isJson) fail('OV_INVALID_FILTER', `"${col.name}" is not a JSON column`)
    return { col, sql: `(t.${quoteIdent(col.name)} ->> ${ctx.p(ref.jsonKey)}::text)`, isText: true }
  }

  function buildFilter (t, f, secrets, ctx) {
    if (!isPlainObject(f) || !FILTER_TYPES.includes(f.type)) fail('OV_INVALID_FILTER', 'unknown filter type')
    const ref = resolveRef(t, f.column, secrets, ctx)
    const v = f.value
    if (COMPARE_OPS[f.type]) {
      if (!isScalar(v)) fail('OV_INVALID_FILTER', `${f.type} needs a scalar value`)
      return `${ref.sql} ${COMPARE_OPS[f.type]} ${ctx.p(v)}${ref.isText ? '::text' : ''}`
    }
    if (f.type === 'like' || f.type === 'ilike') {
      if (typeof v !== 'string') fail('OV_INVALID_FILTER', `${f.type} needs a string`)
      return `${ref.sql} ${f.type === 'like' ? 'LIKE' : 'ILIKE'} ${ctx.p(v.replace(/\*/g, '%'))}::text`
    }
    if (f.type === 'in') {
      if (!Array.isArray(v) || v.length > 10000 || !v.every(isScalar)) fail('OV_INVALID_FILTER', 'in needs an array of scalars')
      return `${ref.sql} = ANY(${ctx.p(v.map(x => (typeof x === 'string' ? x : String(x))))}${ref.isText ? '::text[]' : ''})`
    }
    if (f.type === 'is') {
      const s = v === null ? 'null' : String(v).toLowerCase()
      if (s === 'null') return `${ref.sql} IS NULL`
      if (s === 'true') return `${ref.sql} IS TRUE`
      if (s === 'false') return `${ref.sql} IS FALSE`
      if (s === 'unknown') return `${ref.sql} IS UNKNOWN`
      fail('OV_INVALID_FILTER', 'is needs null, true or false')
    }
    // contains
    if (ref.isText) fail('OV_INVALID_FILTER', 'contains is not supported on a JSON path')
    if (ref.col.isJson) {
      let json
      if (typeof v === 'string') {
        try { JSON.parse(v) } catch { fail('OV_INVALID_FILTER', 'contains needs valid JSON') }
        json = v
      } else {
        json = JSON.stringify(v)
      }
      if (json === undefined) fail('OV_INVALID_FILTER', 'contains needs a value')
      return `${ref.sql}::jsonb @> ${ctx.p(json)}::jsonb`
    }
    if (ref.col.isArray) {
      const arr = typeof v === 'string' ? safeJsonArray(v) : v
      if (!Array.isArray(arr) || !arr.every(isScalar)) fail('OV_INVALID_FILTER', 'contains on an array column needs an array')
      return `${ref.sql} @> ${ctx.p(arr.map(String))}`
    }
    fail('OV_INVALID_FILTER', 'contains needs a JSON or array column')
  }

  function safeJsonArray (s) {
    try { return JSON.parse(s) } catch { return null }
  }

  /** WHERE clause plus the effective (client + forced) filter list. */
  function buildWhere (t, params, secrets, ctx, scope) {
    let clientFilters = params.filters ?? []
    if (!Array.isArray(clientFilters) || clientFilters.length > 50) fail('OV_INVALID_FILTER', 'filters must be an array')
    // Owner scoping: client filters on the scope column are ignored, the forced one wins.
    if (scope) clientFilters = clientFilters.filter(f => !(isPlainObject(f) && f.column === scope.column))
    const parts = clientFilters.map(f => buildFilter(t, f, secrets, ctx))
    const filters = [...clientFilters]
    if (scope) {
      const forced = { type: 'eq', column: scope.column, value: scope.value }
      parts.push(buildFilter(t, forced, NO_SECRETS, ctx))
      filters.push(forced)
    }
    return { sql: parts.length ? ` WHERE ${parts.join(' AND ')}` : '', filters }
  }

  function buildOrder (t, params, secrets, ctx) {
    if (params.order == null) return ''
    const list = Array.isArray(params.order) ? params.order : [params.order]
    if (list.length > 10) fail('OV_INVALID_ORDER', 'too many order terms')
    const parts = list.map(o => {
      if (!isPlainObject(o)) fail('OV_INVALID_ORDER', 'order must be {column, ascending}')
      const ref = resolveRef(t, o.column, secrets, ctx)
      let s = `${ref.sql} ${o.ascending === false ? 'DESC' : 'ASC'}`
      if (o.nullsFirst === true) s += ' NULLS FIRST'
      else if (o.nullsFirst === false) s += ' NULLS LAST'
      return s
    })
    return parts.length ? ` ORDER BY ${parts.join(', ')}` : ''
  }

  // opts.maxRows comes from server code only (the request body cannot reach opts).
  function effectiveLimit (params, opts) {
    const cap = Number.isInteger(opts.maxRows) && opts.maxRows > 0 ? opts.maxRows : cfg.maxRows
    if (params.limit == null) return cap
    const n = Number(params.limit)
    if (!Number.isInteger(n) || n < 0) fail('OV_INVALID_LIMIT', 'limit must be a non-negative integer')
    return Math.min(n, cap)
  }

  /** Visible (selectable) column names of a table, catalog order. */
  function visibleColumns (t, secrets) {
    return t.order.filter(c => !secrets.has(c.toLowerCase()))
  }

  /** Columns for select/returning: '*' expands, secrets are dropped, unknown names fail. */
  function projection (t, raw, secrets, what) {
    const items = parseColumnList(raw, { what })
    const out = []
    for (const item of items) {
      const names = item === '*' ? visibleColumns(t, secrets) : [item]
      for (const n of names) {
        if (secrets.has(n.toLowerCase())) continue
        requireColumn(t, n)
        if (!out.includes(n)) out.push(n)
      }
    }
    return out
  }

  function findEmbed (table, raw) {
    if (typeof raw !== 'string' || !/[!(]/.test(raw)) return null
    const norm = raw.replace(/\s+/g, '')
    const spec = (cfg.embeds[table] || []).find(e => e.select.replace(/\s+/g, '') === norm)
    if (!spec) fail('OV_INVALID_SELECT', 'embedded selects are not supported')
    return spec
  }

  // ------------------------------------------------------------------ select
  async function runSelect (cat, t, params, opts, ctx) {
    const secrets = secretsFor(t.name, opts.internal)
    const embed = findEmbed(t.name, params.columns)
    const cols = projection(t, embed ? '*' : params.columns, secrets, 'select')
    const selectParts = cols.map(c => `t.${quoteIdent(c)}`)
    let from = `${qTable(t.name)} AS t`
    if (embed) {
      const et = tableDef(cat, embed.table)
      const esecrets = secretsFor(embed.table, opts.internal)
      const fcol = requireColumn(et, embed.foreignColumn)
      const lcol = requireColumn(t, embed.localColumn)
      if (!IDENT_RE.test(embed.as)) throw new Error('pgQuery: invalid embed alias')
      const pairs = embed.columns.map(c => {
        if (esecrets.has(c.toLowerCase())) fail('OV_SECRET_FILTER', 'secret column in embed')
        requireColumn(et, c)
        return `${ctx.p(c)}::text, e.${quoteIdent(c)}`
      })
      from += ` LEFT JOIN ${qTable(et.name)} AS e ON e.${quoteIdent(fcol.name)} = t.${quoteIdent(lcol.name)}`
      selectParts.push(`CASE WHEN e.${quoteIdent(fcol.name)} IS NULL THEN NULL ELSE json_build_object(${pairs.join(', ')}) END AS ${quoteIdent(embed.as)}`)
    }
    const where = buildWhere(t, params, secrets, ctx, opts.scope)
    const order = buildOrder(t, params, secrets, ctx)
    // A validated integer, inlined: an unused bind parameter (head:true) could not be typed.
    const limit = String(effectiveLimit(params, opts))
    const inner = `SELECT ${selectParts.join(', ')} FROM ${from}${where.sql}${order} LIMIT ${limit}`
    const wantData = !params.head
    const wantCount = !!params.count
    const sql = `SELECT ${wantData ? `(SELECT coalesce(json_agg(q), '[]'::json) FROM (${inner}) q)` : 'NULL::json'} AS data, ` +
      `${wantCount ? `(SELECT count(*) FROM ${qTable(t.name)} AS t${where.sql})` : 'NULL::bigint'} AS count`
    const res = await (opts.client || pool).query(sql, ctx.values)
    const rows = res.rows[0].data
    const count = wantCount ? Number(res.rows[0].count) : undefined
    let data = wantData ? rows : null
    if (wantData && (params.single || params.maybeSingle)) data = singleOf(rows, !!params.single)
    return { status: 200, body: { data, error: null, count } }
  }

  function singleOf (rows, strict) {
    if (rows.length === 1) return rows[0]
    if (rows.length === 0 && !strict) return null
    throw new PgQueryError(406, 'PGRST116', `${rows.length} rows`, 'JSON object requested, multiple (or no) rows returned')
  }

  // ------------------------------------------------------------------ writes
  function writeRows (t, params, scope) {
    const data = params.data
    const rows = Array.isArray(data) ? data : [data]
    if (rows.length === 0) fail('OV_INVALID_DATA', 'no rows')
    if (!rows.every(isPlainObject)) fail('OV_INVALID_DATA', 'rows must be objects')
    const out = rows.map(r => (scope ? { ...r, [scope.column]: scope.value } : r))
    const cols = []
    for (const r of out) {
      for (const k of Object.keys(r)) {
        if (!cols.includes(k)) { requireColumn(t, k); cols.push(k) }
      }
    }
    return { rows: out, cols }
  }

  /** Reject child ids that do not start with their match's external_id (+ separator). */
  async function assertChildrenScoped (client, cat, table, pairs) {
    const spec = cfg.scopedChildren[table]
    if (!spec || pairs.length === 0) return
    const parent = tableDef(cat, cfg.scopeParent.table)
    const pkey = requireColumn(parent, cfg.scopeParent.key)
    const pext = requireColumn(parent, cfg.scopeParent.ext)
    for (const { ext, mid } of pairs) {
      if (typeof ext !== 'string' || ext === '' || mid == null || mid === '') {
        fail('OV_UNSCOPED_EXTERNAL_ID', `${table} rows need ${spec.ext} and ${spec.fk}`)
      }
    }
    const sql = `SELECT count(*)::int AS bad
      FROM unnest($1::text[], $2::text[]) AS r(ext, mid)
      LEFT JOIN ${qTable(parent.name)} AS m ON m.${quoteIdent(pkey.name)} = r.mid::${pkey.typeSql}
     WHERE m.${quoteIdent(pkey.name)} IS NULL
        OR m.${quoteIdent(pext.name)} IS NULL OR m.${quoteIdent(pext.name)} = ''
        OR length(r.ext) <= length(m.${quoteIdent(pext.name)})
        OR NOT starts_with(r.ext, m.${quoteIdent(pext.name)})
        OR NOT (substr(r.ext, length(m.${quoteIdent(pext.name)}) + 1, 1) = ANY($3::text[]))`
    const res = await client.query(sql, [pairs.map(p => p.ext), pairs.map(p => String(p.mid)), cfg.scopeSeparators])
    if (res.rows[0].bad > 0) fail('OV_UNSCOPED_EXTERNAL_ID', `${res.rows[0].bad} ${table} row(s) not scoped to their match`)
  }

  /** update/delete on a child table must target one match. */
  function assertChildFilterScoped (table, filters) {
    const spec = cfg.scopedChildren[table]
    if (!spec) return
    const ok = filters.some(f => isPlainObject(f) && f.type === 'eq' && (
      (f.column === spec.fk && f.value != null && f.value !== '') ||
      (f.column === spec.ext && typeof f.value === 'string' && f.value !== '' && !/^\d+$/.test(f.value))
    ))
    if (!ok) fail('OV_UNSCOPED_WRITE', `${table} update/delete needs eq on ${spec.fk} or a scoped ${spec.ext}`)
  }

  function mergeExpr (t, col, ref) {
    const c = quoteIdent(col.name)
    return `CASE WHEN jsonb_typeof(${ref}.${c}::jsonb) = 'object' AND jsonb_typeof(t.${c}::jsonb) = 'object' ` +
      `THEN (t.${c}::jsonb || ${ref}.${c}::jsonb)::${col.typeSql} ELSE ${ref}.${c} END`
  }

  // ------------------------------------------------------------ ownership
  /**
   * The ownership guard for this write, or null. opts.matchOwner = { userId }
   * applies to the parent (matches) and its child tables only.
   */
  function ownershipGuard (cat, t, opts) {
    const own = cfg.ownership
    const mo = opts.matchOwner
    if (!mo || !own) return null
    const isParent = t.name === own.parent
    const fk = own.children?.[t.name] || null
    if (!isParent && !fk) return null
    if (typeof mo.userId !== 'string' || !UUID_RE.test(mo.userId)) fail('OV_NOT_MATCH_OWNER', 'no user', 403)
    const parent = cat.tables.get(own.parent)
    const editors = cat.tables.get(own.editors.table)
    if (!parent || !parent.columns.has(own.ownerColumn) || !parent.columns.has(own.key) || !editors ||
        !editors.columns.has(own.editors.matchColumn) || !editors.columns.has(own.editors.userColumn)) {
      // db/005_match_ownership.sql has not run: refuse (retryable), never write unguarded.
      scheduleCatalogRefresh()
      fail('OV_OWNERSHIP_UNAVAILABLE', 'match ownership columns missing (run db/005_match_ownership.sql)', 503)
    }
    if (fk) requireColumn(t, fk, 'match column')
    // admin: the creator is still recorded on insert, but nothing is checked
    return { userId: mo.userId, isParent, fk, parent, admin: mo.admin === true }
  }

  /** SQL: the match row `alias` is owned by the user (creator or editor). */
  function ownedSql (alias, ctx, userId) {
    const own = cfg.ownership
    const u = ctx.p(userId)
    // coalesce: a row without an owner (NULL) is owned by nobody, also under NOT
    return `(coalesce(${alias}.${quoteIdent(own.ownerColumn)} = ${u}::uuid, false) OR EXISTS (SELECT 1 FROM ${qTable(own.editors.table)} AS oe ` +
      `WHERE oe.${quoteIdent(own.editors.matchColumn)} = ${alias}.${quoteIdent(own.key)} AND oe.${quoteIdent(own.editors.userColumn)} = ${u}::uuid))`
  }

  /** SQL: the child row `alias` belongs to a match the user owns. */
  function childOwnedSql (alias, fk, ctx, userId) {
    const own = cfg.ownership
    return `EXISTS (SELECT 1 FROM ${qTable(own.parent)} AS om WHERE om.${quoteIdent(own.key)} = ${alias}.${quoteIdent(fk)} AND ${ownedSql('om', ctx, userId)})`
  }

  const notOwner = (details) => fail('OV_NOT_MATCH_OWNER', details, 403)
  const freshCtx = () => {
    const values = []
    return { values, p: (v) => { values.push(v); return '$' + values.length } }
  }

  /** Every match id in `ids` exists and is owned (null/unknown ids are not). */
  async function assertMatchIdsOwned (client, guard, ids) {
    const own = cfg.ownership
    const c = freshCtx()
    const pkey = requireColumn(guard.parent, own.key)
    const arr = c.p([...new Set(ids.map(v => (v == null ? null : String(v))))])
    const sql = `SELECT count(*)::int AS bad FROM unnest(${arr}::text[]) AS r(mid)
      LEFT JOIN ${qTable(own.parent)} AS m ON m.${quoteIdent(own.key)} = r.mid::${pkey.typeSql}
     WHERE m.${quoteIdent(own.key)} IS NULL OR NOT ${ownedSql('m', c, guard.userId)}`
    const res = await client.query(sql, c.values)
    if (res.rows[0].bad > 0) notOwner(`${res.rows[0].bad} match(es) not owned`)
  }

  /** No row matched by `params` (update/delete) belongs to a match the user does not own. */
  async function assertFilteredRowsOwned (client, t, params, secrets, guard) {
    const c = freshCtx()
    const where = buildWhere(t, params, secrets, c, null)
    const owned = guard.isParent ? ownedSql('t', c, guard.userId) : childOwnedSql('t', guard.fk, c, guard.userId)
    const sql = `SELECT count(*)::int AS bad FROM ${qTable(t.name)} AS t${where.sql ? where.sql + ' AND' : ' WHERE'} NOT ${owned}`
    const res = await client.query(sql, c.values)
    if (res.rows[0].bad > 0) notOwner(`${res.rows[0].bad} ${t.name} row(s) of a match you do not own`)
  }

  async function runWrite (cat, t, action, params, opts, ctx) {
    const internal = !!opts.internal
    const secrets = secretsFor(t.name, internal)
    const scope = opts.scope || null
    if (scope) requireColumn(t, scope.column, 'scope column')
    const childSpec = cfg.scopedChildren[t.name]
    const guard = ownershipGuard(cat, t, opts)
    // The checks (an admin's guard records the creator only)
    const enforce = guard && !guard.admin ? guard : null
    const ownerCol = cfg.ownership?.ownerColumn
    let ownPre = null
    const wantReturning = params.returning != null && params.returning !== false
    const returningCols = wantReturning ? projection(t, params.returning === true ? '*' : params.returning, secrets, 'returning') : []
    const collectChanges = opts.collectChanges ?? cfg.changeTables.includes(t.name)
    const qt = qTable(t.name)

    let dml
    let postCheck = false
    if (action === 'insert' || action === 'upsert') {
      if (guard?.isParent) {
        // The creator is the caller, whatever the client sent.
        const list = Array.isArray(params.data) ? params.data : [params.data]
        if (list.length && list.every(isPlainObject)) {
          const forced = list.map(r => ({ ...r, [ownerCol]: guard.userId }))
          params = { ...params, data: Array.isArray(params.data) ? forced : forced[0] }
        }
      }
      const { rows, cols } = writeRows(t, params, scope)
      if (enforce && !enforce.isParent) {
        const ids = rows.map(r => r[enforce.fk])
        ownPre = (client) => assertMatchIdsOwned(client, enforce, ids)
      }
      const rowsParam = `${ctx.p(JSON.stringify(rows))}::json`
      const colSql = cols.map(quoteIdent).join(', ')
      dml = cols.length
        ? `INSERT INTO ${qt} AS t (${colSql}) SELECT ${colSql} FROM json_populate_recordset(NULL::${qt}, ${rowsParam})`
        : `INSERT INTO ${qt} AS t SELECT FROM json_populate_recordset(NULL::${qt}, ${rowsParam})`
      if (action === 'upsert') {
        let target
        if (params.onConflict != null) {
          if (typeof params.onConflict !== 'string' || params.onConflict.length > 500) fail('OV_INVALID_CONFLICT', 'onConflict must be a string')
          target = params.onConflict.split(',').map(s => s.trim())
          for (const c of target) {
            if (mentionsSecret(c, secrets)) fail('OV_SECRET_FILTER', 'secret column')
            if (!IDENT_RE.test(c)) fail('OV_INVALID_CONFLICT', `unsupported onConflict item "${safeText(c)}"`)
            requireColumn(t, c, 'onConflict column')
          }
        } else {
          target = t.pk
          if (!target.length) fail('OV_INVALID_CONFLICT', 'table has no primary key; onConflict is required')
        }
        // The creator of an existing match never changes through an upsert.
        const updatable = cols.filter(c => !target.includes(c) && !(guard?.isParent && c === ownerCol))
        // Server code may ask for JSON objects to be merged into the stored ones
        // (matchRestore: connection_pins), like `update` does for mergeJsonColumns.
        const mergeOnUpsert = new Set(Array.isArray(opts.mergeOnUpsert) ? opts.mergeOnUpsert : [])
        const sets = (updatable.length ? updatable : [target[0]]).map(c => {
          const col = t.columns.get(c)
          return mergeOnUpsert.has(c) && col.isJson
            ? `${quoteIdent(c)} = ${mergeExpr(t, col, 'EXCLUDED')}`
            : `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`
        })
        dml += ` ON CONFLICT (${target.map(quoteIdent).join(', ')}) DO UPDATE SET ${sets.join(', ')}`
        const guards = []
        // A conflicting row owned by someone else is neither changed nor returned.
        if (scope) guards.push(`t.${quoteIdent(scope.column)} = ${ctx.p(scope.value)}`)
        // A conflicting set/event of another match is never overwritten or moved
        // (an upsert on id, or on an external_id that collided historically).
        if (childSpec) guards.push(`t.${quoteIdent(childSpec.fk)} IS NOT DISTINCT FROM EXCLUDED.${quoteIdent(childSpec.fk)}`)
        // A conflicting row of a match the caller does not own is never changed.
        if (enforce) guards.push(enforce.isParent ? ownedSql('t', ctx, enforce.userId) : childOwnedSql('t', enforce.fk, ctx, enforce.userId))
        if (guards.length) dml += ` WHERE ${guards.join(' AND ')}`
        if (childSpec || enforce) {
          ctx.expectRows = rows.length
          // sets/events: the new rows' match is owned (checked first), so a
          // skipped row is one of another match; otherwise it is not owned.
          ctx.expectRowsCode = childSpec ? 'OV_UNSCOPED_WRITE' : 'OV_NOT_MATCH_OWNER'
        }
      }
      if (childSpec) ctx.preCheck = rows.map(r => ({ ext: r[childSpec.ext], mid: r[childSpec.fk] }))
    } else if (action === 'update') {
      if (!isPlainObject(params.data)) fail('OV_INVALID_DATA', 'update data must be an object')
      const { rows: [row], cols } = writeRows(t, { data: params.data }, scope)
      const where = buildWhere(t, params, secrets, ctx, scope)
      if (where.filters.length === 0) fail('OV_UNFILTERED_WRITE', 'update needs a filter')
      if (guard?.isParent && cols.includes(ownerCol)) fail('OV_INVALID_DATA', `${ownerCol} is set by the server`)
      if (enforce) {
        const moved = !enforce.isParent && cols.includes(enforce.fk) ? [row[enforce.fk]] : null
        const p0 = params
        ownPre = async (client) => {
          await assertFilteredRowsOwned(client, t, p0, secrets, enforce)
          if (moved) await assertMatchIdsOwned(client, enforce, moved)
        }
      }
      if (childSpec) {
        assertChildFilterScoped(t.name, where.filters)
        postCheck = cols.includes(childSpec.ext) || cols.includes(childSpec.fk)
      }
      if (cols.length === 0) {
        // Nothing to set: behave like an update that touched no column.
        return { status: 200, body: { data: wantReturning ? (params.single ? singleOf([], true) : []) : null, error: null, count: params.count ? 0 : undefined } }
      }
      const merge = new Set(cfg.mergeJsonColumns[t.name] || [])
      const sets = cols.map(c => {
        const col = t.columns.get(c)
        return merge.has(c) && col.isJson ? `${quoteIdent(c)} = ${mergeExpr(t, col, 'r')}` : `${quoteIdent(c)} = r.${quoteIdent(c)}`
      })
      dml = `UPDATE ${qt} AS t SET ${sets.join(', ')} FROM json_populate_record(NULL::${qt}, ${ctx.p(JSON.stringify(row))}::json) AS r${where.sql}`
    } else {
      const where = buildWhere(t, params, secrets, ctx, scope)
      if (where.filters.length === 0) fail('OV_UNFILTERED_WRITE', 'delete needs a filter')
      if (childSpec) assertChildFilterScoped(t.name, where.filters)
      if (enforce) {
        const p0 = params
        ownPre = (client) => assertFilteredRowsOwned(client, t, p0, secrets, enforce)
      }
      dml = `DELETE FROM ${qt} AS t${where.sql}`
    }

    // RETURNING: all visible columns when anything needs rows, else just a count.
    const needRows = wantReturning || collectChanges || postCheck
    let retCols = needRows ? visibleColumns(t, secrets) : []
    // Server code may narrow the change rows (e.g. a restore deleting thousands of events).
    if (needRows && !wantReturning && !postCheck && Array.isArray(opts.changeColumns)) {
      const narrowed = retCols.filter(c => opts.changeColumns.includes(c))
      if (narrowed.length) retCols = narrowed
    }
    if (postCheck) {
      for (const c of [childSpec.ext, childSpec.fk]) if (!retCols.includes(c)) retCols.push(c)
    }
    let returning = needRows ? retCols.map(c => `t.${quoteIdent(c)}`).join(', ') : '1 AS one'
    if (needRows && action === 'upsert') returning += (returning ? ', ' : '') + '(t.xmax = 0) AS "__inserted"'
    if (needRows && !returning) returning = '1 AS one'
    const sql = needRows
      ? `WITH w AS (${dml} RETURNING ${returning}) SELECT coalesce(json_agg(w), '[]'::json) AS rows, count(*) AS n FROM w`
      : `WITH w AS (${dml} RETURNING ${returning}) SELECT NULL::json AS rows, count(*) AS n FROM w`

    const run = async (client) => {
      if (ctx.preCheck) await assertChildrenScoped(client, cat, t.name, ctx.preCheck)
      if (ownPre) await ownPre(client)
      const res = await client.query(sql, ctx.values)
      const rows = res.rows[0].rows || []
      const n = Number(res.rows[0].n)
      // Upsert rows skipped by a guard: the conflicting row belongs to another
      // match, or to a match the caller does not own.
      if (ctx.expectRows != null && n < ctx.expectRows) {
        if (ctx.expectRowsCode === 'OV_NOT_MATCH_OWNER') notOwner(`${ctx.expectRows - n} ${t.name} row(s) of a match you do not own`)
        fail('OV_UNSCOPED_WRITE', `${ctx.expectRows - n} ${t.name} row(s) conflict with a row of another match`)
      }
      if (postCheck) await assertChildrenScoped(client, cat, t.name, rows.map(r => ({ ext: r[childSpec.ext], mid: r[childSpec.fk] })))
      let data = null
      if (wantReturning && !params.head) {
        const projected = rows.map(r => Object.fromEntries(returningCols.map(c => [c, r[c]])))
        data = (params.single || params.maybeSingle) ? singleOf(projected, !!params.single) : projected
      }
      return { rows, n, data }
    }

    const out = opts.client ? await run(opts.client) : await withTransaction(run)
    const result = { status: 200, body: { data: out.data, error: null, count: params.count ? out.n : undefined } }
    if (collectChanges) {
      const secretAll = secretSets.get(t.name) || NO_SECRETS
      result.changes = out.rows.map(r => {
        const row = {}
        for (const [k, v] of Object.entries(r)) {
          if (k !== '__inserted' && !secretAll.has(k.toLowerCase())) row[k] = v
        }
        const eventType = action === 'delete' ? 'DELETE'
          : action === 'update' ? 'UPDATE'
            : action === 'insert' ? 'INSERT'
              : (r.__inserted ? 'INSERT' : 'UPDATE')
        return { table: t.name, eventType, row }
      })
    }
    return result
  }

  // ------------------------------------------------------------ public API
  async function withTransaction (fn, { statementTimeoutMs } = {}) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      if (statementTimeoutMs) await client.query(`SET LOCAL statement_timeout = ${Number(statementTimeoutMs) | 0}`)
      const out = await fn(client)
      await client.query('COMMIT')
      return out
    } catch (err) {
      try { await client.query('ROLLBACK') } catch { /* connection already broken */ }
      throw err
    } finally {
      client.release()
    }
  }

  /** Throws PgQueryError / pg errors. Prefer runQuery() in request handlers. */
  async function execute (request, opts = {}) {
    if (!isPlainObject(request)) fail('OV_INVALID_REQUEST', 'request must be an object')
    const { table, action } = request
    const params = request.params ?? {}
    if (!isPlainObject(params)) fail('OV_INVALID_REQUEST', 'params must be an object')
    if (typeof table !== 'string' || !cfg.allowedTables.includes(table)) fail('OV_TABLE_NOT_ALLOWED', 'table not allowed')
    if (!ACTIONS.includes(action)) fail('OV_INVALID_ACTION', 'unknown action')
    const isWrite = action !== 'select'
    if (isWrite && !opts.internal && cfg.minWriteProto != null) {
      const v = Number(opts.proto)
      if (!(v >= cfg.minWriteProto)) {
        throw new PgQueryError(426, 'OV_CLIENT_TOO_OLD', `X-OV-Proto >= ${cfg.minWriteProto} required`, 'This app version is too old to write. Please reload the app.')
      }
    }
    const cat = await ensureCatalog()
    const t = tableDef(cat, table)
    const values = []
    const ctx = { values, p: (v) => { values.push(v); return '$' + values.length } }
    return isWrite ? runWrite(cat, t, action, params, opts, ctx) : runSelect(cat, t, params, opts, ctx)
  }

  /**
   * Run one /api/db request. Never throws.
   * @param {{table:string, action:string, params?:object}} request  body of POST /api/db
   * @param {object} [opts]
   * @param {number|string} [opts.proto]   X-OV-Proto header value (writes need >= minWriteProto)
   * @param {boolean} [opts.internal]      trusted server code: no redaction, no secret bans, no proto gate
   * @param {{column:string, value:any}} [opts.scope]  owner scoping: forced eq filter + forced value on writes
   * @param {{userId:string, admin?:boolean}} [opts.matchOwner] match ownership guard (matches + children):
   *        inserts record the caller as creator; writes to rows of a match the caller neither created
   *        nor edits get 403 OV_NOT_MATCH_OWNER. admin: true records the creator but checks nothing.
   *        Omit for trusted server code.
   * @param {boolean} [opts.collectChanges] return `changes` for realtime (default: changeTables)
   * @param {number} [opts.maxRows]        raise/lower the select row cap (server code only)
   * @param {string[]} [opts.mergeOnUpsert] JSON columns an upsert merges into the stored object (server code only)
   * @param {string[]} [opts.changeColumns] narrow the `changes` rows to these columns (server code only)
   * @param {pg.PoolClient} [opts.client]  run inside the caller's transaction
   * @returns {Promise<{status:number, body:{data:any, error:null|{message,code,details?}, count?:number}, changes?:Array}>}
   */
  async function runQuery (request, opts = {}) {
    try {
      return await execute(request, opts)
    } catch (err) {
      return errorResult(err, request)
    }
  }

  function errorResult (err, request) {
    const where = `${safeText(request?.action)} ${safeText(request?.table)}`
    if (err instanceof PgQueryError) {
      if (err.status >= 500) log.warn?.(`[pgQuery] ${where}: ${err.code}`)
      const error = { message: err.message, code: err.code }
      if (err.details && err.status < 500) error.details = err.details
      if (err.status >= 500) error.retryable = true
      return { status: err.status, body: { data: null, error } }
    }
    if (err instanceof pg.DatabaseError && /^[0-9A-Z]{5}$/.test(err.code || '')) {
      // A Postgres error: report the SQLSTATE, keep the server-side text in the log only.
      log.error?.(`[pgQuery] ${where} error ${err.code}: ${safeText(err.message)}`)
      if (DB_ERROR_INVALIDATES_CATALOG.has(err.code)) scheduleCatalogRefresh()
      const status = sqlstateStatus(err.code)
      const error = { message: GENERIC_MESSAGE, code: err.code }
      if (status >= 500) error.retryable = true
      return { status, body: { data: null, error } }
    }
    log.error?.(`[pgQuery] ${where} failed: ${safeText(err?.message)}`)
    const unavailable = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timeout|terminated|Connection/i.test(String(err?.message))
    const error = { message: GENERIC_MESSAGE, code: unavailable ? 'OV_DB_UNAVAILABLE' : 'OV_INTERNAL' }
    if (unavailable) error.retryable = true
    return { status: unavailable ? 503 : 500, body: { data: null, error } }
  }

  async function ping () {
    const r = await pool.query('SELECT 1 AS ok')
    return r.rows[0].ok === 1
  }

  async function close () {
    if (ownsPool) await pool.end()
  }

  return {
    runQuery,
    execute,
    toErrorResult: errorResult,
    withTransaction,
    ensureCatalog,
    invalidateCatalog,
    catalogStatus,
    ping,
    close,
    pool,
    config: cfg,
    secretColumnsOf: (table) => [...(secretSets.get(table) || [])]
  }
}
