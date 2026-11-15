/**
 * dataAdmin — the manager's Data tab: every table of the public schema, read
 * and changed one row at a time (super admins only, lib/manageApi.js).
 *
 *   GET  /api/admin/data/tables                        the tables, their columns and keys
 *   GET  /api/admin/data/tables/:t?q=&col=&op=&val=&sort=&dir=&limit=&offset=
 *                                                      a page of rows (long values cut)
 *   GET  /api/admin/data/tables/:t/row?key=<json>      one row whole
 *   POST /api/admin/data/tables/:t/rows   { values }   insert (audited data.insert)
 *   PATCH /api/admin/data/tables/:t/row   { key, before, set }
 *                                                      update (audited data.update)
 *   POST /api/admin/data/tables/:t/row/delete { key, confirm: true }
 *                                                      delete (audited data.delete)
 *
 * What it never does:
 * - The auth schema (passwords, sessions, passkeys, approval PINs) is not
 *   listed at all; only `public`.
 * - Secret columns (SECRET_COLUMN_RE: game PINs, token and code hashes, ...)
 *   are never returned, searched, sorted on or written.
 * - READ_ONLY_TABLES (the logs and the records of closed matches) are read
 *   only; so is a table without a primary key.
 * - It writes as the backend role (ov_app) with ov.user_id and ov.admin set,
 *   the same as an admin session of /api/db, and NOT ov.allow_closed: the
 *   closed-match lock of db/007 / db/039 still holds (a closed match is
 *   reopened first, in Closed matches, which keeps its record).
 *
 * Writes:
 * - Values are typed by Postgres itself: the row is built with
 *   jsonb_populate_record(NULL::public.<table>, $json), so an enum, an array
 *   or a json column takes what its column takes. Identifiers come from the
 *   catalog only (never from the request as text).
 * - An update names the values it was made from (`before`); when any of them
 *   changed in the meantime it is refused (409 OV_DATA_CHANGED) with the
 *   current ones. The key columns are not changed (delete and insert instead).
 * - Every write is one transaction with its audit entry. The entry keeps the
 *   table, the key, the columns and their values, except values that may be
 *   personal (text that is long or has a personal name, json, dates): those
 *   read "[personal]" / "[json]" (db/038: the audit log outlives an account).
 * - A write to matches / sets / events / match_live_state returns `changes`
 *   for the realtime write-through (server.js publishChanges).
 */

import { connectClient } from './pgClient.js'
import { fail, invalid, notFound, ok, unavailable } from './accounts.js'

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/
export const SCHEMA = 'public'

// The logs and the records: rows that only the backend's own code may write
export const READ_ONLY_TABLES = Object.freeze([
  'audit_log', 'activity_log', 'event_revisions', 'match_closures', 'match_approvals',
  'match_final_mails', 'match_scoresheets', 'deleted_matches', 'invite_redemptions',
  'svrz_sync_log', 'svrz_games_removed'
])
// Never returned, searched, sorted or written: PINs, hashes, tokens and their kin
export const SECRET_COLUMN_RE = /(^|_)(pin|pins|password|secret|token|salt|mac)(_|$)|(^|_)hash$/
// Values of these columns are not copied into the audit log
// (text only: ids, numbers, flags and times are kept as they are)
const PERSONAL_COLUMN_RE = /name|mail|dob|birth|phone|sign|player|staff|bench|official|referee|coach|captain|meta|note|remark|address|team|display|licen|sv_number|reason|label|title|venue|city|hall|linesman|scorer|country/
// The tables whose writes the realtime feed carries (lib/pgQuery.js changeTables)
const CHANGE_TABLES = new Set(['matches', 'sets', 'events', 'match_live_state'])
const OPS = Object.freeze(['eq', 'ne', 'like', 'gt', 'gte', 'lt', 'lte', 'null', 'notnull'])
const CELL_MAX = 160
const PAGE_MAX = 200
const COUNT_CAP = 10000
const CATALOG_TTL_MS = 60_000

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const q = (id) => `"${id}"`

/** The kind of a column for the console's editor (pg_type.typcategory, the type name). */
export function kindOf (typcategory, type) {
  if (/^jsonb?$/.test(type)) return 'json'
  if (type === 'uuid') return 'uuid'
  if (type === 'date') return 'date'
  if (type === 'bytea') return 'bytea'
  switch (typcategory) {
    case 'B': return 'bool'
    case 'N': return 'number'
    case 'S': return 'text'
    case 'D': return 'timestamp'
    case 'A': return 'array'
    case 'E': return 'enum'
    default: return 'other'
  }
}

/** A value of a list cell: short as it is, long cut to a preview (the row endpoint has it whole). */
export function cellOf (v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v.length > CELL_MAX ? { $cut: v.slice(0, CELL_MAX), $len: v.length } : v
  if (typeof v === 'object') {
    const s = JSON.stringify(v)
    return s.length > CELL_MAX ? { $cut: s.slice(0, CELL_MAX), $len: s.length } : v
  }
  return v
}

/** A value as the audit log keeps it (module header). */
export function auditValue (col, v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'boolean' || typeof v === 'number') return v
  if (col.kind === 'json' || col.kind === 'array' || typeof v === 'object') return '[json]'
  if (col.kind === 'date') return '[personal]'
  if (col.kind === 'uuid' || col.kind === 'timestamp' || col.kind === 'number' || col.kind === 'bool') return v
  const s = String(v)
  return PERSONAL_COLUMN_RE.test(col.name) || s.length > 80 ? '[personal]' : s
}

/** JSON equality of two values as to_jsonb gives them (key order of objects does not matter). */
export function sameValue (a, b) {
  if (a === b) return true
  if (a === null || b === null || a === undefined || b === undefined) return (a ?? null) === (b ?? null)
  if (typeof a !== typeof b) return false
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => sameValue(x, b[i]))
  if (typeof a === 'object') {
    if (Array.isArray(b)) return false
    const ka = Object.keys(a)
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && sameValue(a[k], b[k]))
  }
  return false
}

const like = (s) => '%' + String(s).replace(/[\\%_]/g, (c) => '\\' + c) + '%'

/** A Postgres error as the console's answer: what the database refused, never a 500. */
export function pgError (err) {
  const code = String(err?.code || '')
  const message = String(err?.message || '').slice(0, 300)
  const details = { sqlstate: code || undefined, column: err?.column || undefined, constraint: err?.constraint || undefined }
  if (code === 'OVC01') return fail(409, 'OV_MATCH_CLOSED', 'The match is closed: reopen it first (Closed matches).', details)
  if (code === 'OVC02') return fail(409, 'OV_MATCH_RECORD', message, details)
  if (code === '23505') return fail(409, 'OV_DATA_DUPLICATE', message, details)
  if (code === '23503') return fail(409, 'OV_DATA_REFERENCED', message, details)
  if (code === '23502') return fail(400, 'OV_DATA_REQUIRED', message, details)
  if (code === '23514' || code === '23P01') return fail(409, 'OV_DATA_CHECK', message, details)
  if (code.startsWith('22')) return fail(400, 'OV_DATA_INVALID', message, details)
  if (code === '42501') return fail(403, 'OV_DATA_DENIED', message, details)
  if (code === '57014') return fail(503, 'OV_DATA_TIMEOUT', 'The database took too long. Narrow the search.', details)
  if (code === 'P0001' || code.startsWith('OV') || code.startsWith('23')) return fail(409, 'OV_DATA_REFUSED', message, details)
  return null
}

/**
 * @param {{ pool: import('pg').Pool, audit: Function, logger?: Console }} deps
 *   audit: lib/accounts.js audit(client, entry), inside the write's transaction
 */
export function createDataAdmin ({ pool, audit, logger = console }) {
  const log = logger || console
  let catalog = null
  let catalogAt = 0

  async function loadCatalog (force = false) {
    if (!force && catalog && Date.now() - catalogAt < CATALOG_TTL_MS) return catalog
    const { rows } = await pool.query(
      `SELECT c.relname AS table_name, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
              t.typcategory AS cat, NOT a.attnotnull AS nullable, a.atthasdef AS has_default,
              a.attidentity AS identity, a.attgenerated AS generated,
              coalesce(a.attnum = ANY (i.indkey), false) AS pk,
              (SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = a.atttypid) AS enum_values,
              greatest(c.reltuples, 0)::bigint AS estimate
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
         JOIN pg_type t ON t.oid = a.atttypid
         LEFT JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary
        WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
        ORDER BY c.relname, a.attnum`, [SCHEMA])
    const tables = new Map()
    for (const r of rows) {
      if (!IDENT_RE.test(r.table_name) || !IDENT_RE.test(r.name)) continue
      let t = tables.get(r.table_name)
      if (!t) {
        t = { name: r.table_name, columns: [], byName: new Map(), pk: [], estimate: Number(r.estimate) || 0 }
        tables.set(r.table_name, t)
      }
      const col = {
        name: r.name,
        type: r.type,
        kind: kindOf(r.cat, r.type),
        nullable: r.nullable,
        has_default: r.has_default || r.identity !== '' || r.generated !== '',
        // GENERATED ALWAYS (identity or stored): Postgres refuses a value
        generated: r.identity === 'a' || r.generated !== '',
        pk: r.pk,
        secret: SECRET_COLUMN_RE.test(r.name),
        ...(r.enum_values ? { enum: r.enum_values } : {})
      }
      t.columns.push(col)
      t.byName.set(col.name, col)
      if (col.pk) t.pk.push(col.name)
    }
    for (const t of tables.values()) {
      t.secret = t.columns.filter((c) => c.secret).map((c) => c.name)
      t.readOnly = READ_ONLY_TABLES.includes(t.name) ? 'log' : t.pk.length === 0 ? 'no_key' : null
      // a key that is secret (auth-like tables) cannot name a row to the console
      if (!t.readOnly && t.pk.some((k) => t.byName.get(k).secret)) t.readOnly = 'secret_key'
    }
    catalog = tables
    catalogAt = Date.now()
    return catalog
  }

  async function guarded (where, fn) {
    try {
      return await fn()
    } catch (err) {
      if (err && err.__result) return err.__result
      const known = pgError(err)
      if (known) return known
      log.error?.(`[data] ${where} failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 200)}`)
      return unavailable()
    }
  }
  const abort = (result) => Object.assign(new Error('abort'), { __result: result })

  async function tableOf (name) {
    if (typeof name !== 'string' || !IDENT_RE.test(name)) throw abort(notFound())
    let t = (await loadCatalog()).get(name)
    // a table added by a migration since the last load
    if (!t) t = (await loadCatalog(true)).get(name)
    if (!t) throw abort(notFound())
    return t
  }

  const publicColumn = (c) => ({ name: c.name, type: c.type, kind: c.kind, nullable: c.nullable, has_default: c.has_default, generated: c.generated, pk: c.pk, ...(c.enum ? { enum: c.enum } : {}) })
  const visibleColumns = (t) => t.columns.filter((c) => !c.secret)

  /** The key of a row from the request: exactly the key columns, none secret. */
  function keyOf (t, raw) {
    let key = raw
    if (typeof raw === 'string') {
      try { key = JSON.parse(raw) } catch { throw abort(invalid({ key: 'not JSON' })) }
    }
    if (!isPlainObject(key)) throw abort(invalid({ key: 'required' }))
    if (t.pk.length === 0) throw abort(fail(409, 'OV_DATA_READ_ONLY', 'This table has no primary key: rows cannot be named.'))
    const names = Object.keys(key)
    if (names.length !== t.pk.length || !t.pk.every((k) => Object.hasOwn(key, k) && key[k] !== null && key[k] !== undefined)) {
      throw abort(invalid({ key: `the key is ${t.pk.join(', ')}` }))
    }
    return key
  }

  const keyWhere = (t, alias, k) => t.pk.map((c) => `${alias}.${q(c)} = ${k}.${q(c)}`).join(' AND ')
  const rowType = (t) => `NULL::${q(SCHEMA)}.${q(t.name)}`
  const strip = (t, row) => {
    if (!row) return row
    const out = { ...row }
    for (const s of t.secret) delete out[s]
    return out
  }

  function writable (t) {
    if (t.readOnly) {
      throw abort(fail(409, 'OV_DATA_READ_ONLY', t.readOnly === 'log'
        ? 'This table is a log or a record: it is only written by the app itself.'
        : 'This table has no usable key: its rows cannot be changed here.'))
    }
  }

  /** The columns of a write: known, visible, not generated; `allowKey` for an insert. */
  function valuesOf (t, raw, { allowKey }) {
    if (!isPlainObject(raw) || Object.keys(raw).length === 0) throw abort(invalid({ values: 'required' }))
    const bad = []
    for (const k of Object.keys(raw)) {
      const c = t.byName.get(k)
      if (!c || c.secret) bad.push(`${k}: unknown`)
      else if (c.generated) bad.push(`${k}: generated by the database`)
      else if (c.pk && !allowKey) bad.push(`${k}: part of the key (delete and add the row instead)`)
    }
    if (bad.length) throw abort(invalid({ columns: bad }))
    return raw
  }

  async function withTx (actorId, fn) {
    const client = await connectClient(pool, log)
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('ov.user_id', $1, true), set_config('ov.admin', 'on', true)", [actorId])
      const out = await fn(client)
      await client.query('COMMIT')
      return out
    } catch (err) {
      try { await client.query('ROLLBACK') } catch { /* connection already gone */ }
      throw err
    } finally {
      client.release()
    }
  }

  const matchIdOf = (t, row) => (t.name === 'matches' ? row?.id : row?.match_id) || null
  const auditRow = (t, row, names) => Object.fromEntries(names.filter((n) => t.byName.has(n) && !t.byName.get(n).secret).map((n) => [n, auditValue(t.byName.get(n), row?.[n])]))
  const changesOf = (t, eventType, row) => (CHANGE_TABLES.has(t.name) && row ? [{ table: t.name, eventType, row: strip(t, row) }] : undefined)

  // ---------------------------------------------------------------- reads

  async function listTables () {
    return guarded('tables', async () => {
      const cat = await loadCatalog(true)
      return ok({
        schema: SCHEMA,
        tables: [...cat.values()].map((t) => ({
          name: t.name,
          pk: t.pk,
          read_only: t.readOnly,
          estimate: t.estimate,
          columns: visibleColumns(t).map(publicColumn),
          secret_columns: t.secret
        }))
      })
    })
  }

  /** The WHERE of a list: one column filter and a free-text search over the visible values. */
  function listWhere (t, query, params) {
    const where = []
    const text = String(query.get('q') ?? '').trim().slice(0, 200)
    if (text) {
      params.push(t.secret, like(text))
      where.push(`(to_jsonb(t) - $${params.length - 1}::text[])::text ILIKE $${params.length}`)
    }
    const colName = query.get('col')
    if (colName) {
      const c = t.byName.get(colName)
      if (!c || c.secret) throw abort(invalid({ col: 'unknown column' }))
      const op = query.get('op') || 'eq'
      if (!OPS.includes(op)) throw abort(invalid({ op: `one of ${OPS.join(', ')}` }))
      const col = `t.${q(c.name)}`
      if (op === 'null') where.push(`${col} IS NULL`)
      else if (op === 'notnull') where.push(`${col} IS NOT NULL`)
      else if (op === 'like') {
        params.push(like(query.get('val') ?? ''))
        where.push(`${col}::text ILIKE $${params.length}`)
      } else {
        if (c.kind === 'json' && op !== 'eq' && op !== 'ne') throw abort(invalid({ op: 'a json column takes eq, ne, like, null' }))
        // the value typed as the column (jsonb_populate_record); json compared as jsonb
        params.push(JSON.stringify({ [c.name]: query.get('val') ?? '' }))
        const v = `(jsonb_populate_record(${rowType(t)}, $${params.length}::jsonb)).${q(c.name)}`
        const sqlOp = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op]
        where.push(c.kind === 'json'
          ? `to_jsonb(${col}) ${op === 'eq' ? '=' : '<>'} to_jsonb(${v})`
          : `${col} ${sqlOp} ${v}`)
      }
    }
    return where.length ? `WHERE ${where.join(' AND ')}` : ''
  }

  function orderOf (t, query) {
    const sort = query.get('sort')
    const dir = query.get('dir') === 'asc' ? 'ASC' : query.get('dir') === 'desc' ? 'DESC' : null
    let first = null
    if (sort) {
      const c = t.byName.get(sort)
      if (!c || c.secret || c.kind === 'json') throw abort(invalid({ sort: 'unknown or unsortable column' }))
      first = `t.${q(c.name)} ${dir || 'ASC'} NULLS LAST`
    } else {
      // newest first where the table says when; else by key
      const when = ['at', 'created_at', 'updated_at'].find((n) => t.byName.has(n))
      if (when) first = `t.${q(when)} ${dir || 'DESC'} NULLS LAST`
    }
    const tie = t.pk.map((c) => `t.${q(c)}`)
    const parts = [first, ...tie].filter(Boolean)
    return parts.length ? `ORDER BY ${parts.join(', ')}` : ''
  }

  async function listRows ({ table, query }) {
    return guarded('rows', async () => {
      const t = await tableOf(table)
      const limit = Math.min(Math.max(parseInt(query.get('limit') ?? '50', 10) || 50, 1), PAGE_MAX)
      const offset = Math.max(parseInt(query.get('offset') ?? '0', 10) || 0, 0)
      const params = []
      const where = listWhere(t, query, params)
      const order = orderOf(t, query)
      const from = `FROM ${q(SCHEMA)}.${q(t.name)} t ${where}`
      const n = params.length
      const [{ rows }, { rows: [cnt] }] = await Promise.all([
        pool.query(`SELECT to_jsonb(t) - $${n + 1}::text[] AS row ${from} ${order} LIMIT $${n + 2} OFFSET $${n + 3}`, [...params, t.secret, limit, offset]),
        pool.query(`SELECT count(*)::int AS n FROM (SELECT 1 ${from} LIMIT ${COUNT_CAP + 1}) x`, params)
      ])
      return ok({
        table: t.name,
        rows: rows.map((r) => Object.fromEntries(Object.entries(r.row).map(([k, v]) => [k, cellOf(v)]))),
        total: Math.min(cnt.n, COUNT_CAP),
        more_than: cnt.n > COUNT_CAP,
        limit,
        offset
      })
    })
  }

  async function getRow ({ table, key: rawKey }) {
    return guarded('row', async () => {
      const t = await tableOf(table)
      const key = keyOf(t, rawKey)
      const { rows: [r] } = await pool.query(
        `SELECT to_jsonb(t) - $2::text[] AS row FROM ${q(SCHEMA)}.${q(t.name)} t, jsonb_populate_record(${rowType(t)}, $1::jsonb) k WHERE ${keyWhere(t, 't', 'k')}`,
        [JSON.stringify(key), t.secret])
      if (!r) return notFound()
      return ok({ table: t.name, row: r.row })
    })
  }

  // ---------------------------------------------------------------- writes

  async function insertRow ({ actorId, table, body }) {
    let changes
    const res = await guarded('insert', async () => {
      const t = await tableOf(table)
      writable(t)
      const values = valuesOf(t, body?.values, { allowKey: true })
      const cols = Object.keys(values)
      const row = await withTx(actorId, async (client) => {
        const { rows: [r] } = await client.query(
          `INSERT INTO ${q(SCHEMA)}.${q(t.name)} AS t (${cols.map(q).join(', ')})
           SELECT ${cols.map((c) => `v.${q(c)}`).join(', ')} FROM jsonb_populate_record(${rowType(t)}, $1::jsonb) v
           RETURNING to_jsonb(t) AS row`, [JSON.stringify(values)])
        await audit(client, {
          actorId,
          action: 'data.insert',
          matchId: matchIdOf(t, r.row),
          details: { table: t.name, key: auditRow(t, r.row, t.pk), values: auditRow(t, r.row, cols) }
        })
        return r.row
      })
      changes = changesOf(t, 'INSERT', row)
      // 200, not 201: server.js publishes the changes of a 200
      return ok({ table: t.name, row: strip(t, row) })
    })
    return changes ? { ...res, changes } : res
  }

  async function updateRow ({ actorId, table, body }) {
    let changes
    const res = await guarded('update', async () => {
      const t = await tableOf(table)
      writable(t)
      const key = keyOf(t, body?.key)
      const set = valuesOf(t, body?.set, { allowKey: false })
      const cols = Object.keys(set)
      const before = body?.before
      if (!isPlainObject(before) || !cols.every((c) => Object.hasOwn(before, c))) {
        throw abort(invalid({ before: 'the values the change was made from, one per changed column' }))
      }
      const row = await withTx(actorId, async (client) => {
        const { rows: [cur] } = await client.query(
          `SELECT to_jsonb(t) AS row FROM ${q(SCHEMA)}.${q(t.name)} t, jsonb_populate_record(${rowType(t)}, $1::jsonb) k
            WHERE ${keyWhere(t, 't', 'k')} FOR UPDATE OF t`, [JSON.stringify(key)])
        if (!cur) throw abort(notFound())
        const moved = cols.filter((c) => !sameValue(cur.row[c], before[c]))
        if (moved.length) {
          throw abort(fail(409, 'OV_DATA_CHANGED', 'The row changed since it was read. Check the current values and try again.',
            { columns: moved, current: Object.fromEntries(moved.map((c) => [c, cur.row[c]])) }))
        }
        const { rows: [r] } = await client.query(
          `UPDATE ${q(SCHEMA)}.${q(t.name)} AS t
              SET (${cols.map(q).join(', ')}) = (SELECT ${cols.map((c) => `v.${q(c)}`).join(', ')} FROM jsonb_populate_record(${rowType(t)}, $2::jsonb) v)
             FROM jsonb_populate_record(${rowType(t)}, $1::jsonb) k
            WHERE ${keyWhere(t, 't', 'k')}
        RETURNING to_jsonb(t) AS row`, [JSON.stringify(key), JSON.stringify(set)])
        await audit(client, {
          actorId,
          action: 'data.update',
          matchId: matchIdOf(t, r.row),
          details: { table: t.name, key: auditRow(t, cur.row, t.pk), before: auditRow(t, cur.row, cols), after: auditRow(t, r.row, cols) }
        })
        return r.row
      })
      changes = changesOf(t, 'UPDATE', row)
      return ok({ table: t.name, row: strip(t, row) })
    })
    return changes ? { ...res, changes } : res
  }

  async function deleteRow ({ actorId, table, body }) {
    let changes
    const res = await guarded('delete', async () => {
      const t = await tableOf(table)
      writable(t)
      const key = keyOf(t, body?.key)
      if (body?.confirm !== true) throw abort(invalid({ confirm: 'true to delete the row' }))
      const row = await withTx(actorId, async (client) => {
        const { rows: [r] } = await client.query(
          `DELETE FROM ${q(SCHEMA)}.${q(t.name)} AS t USING jsonb_populate_record(${rowType(t)}, $1::jsonb) k
            WHERE ${keyWhere(t, 't', 'k')} RETURNING to_jsonb(t) AS row`, [JSON.stringify(key)])
        if (!r) throw abort(notFound())
        await audit(client, {
          actorId,
          action: 'data.delete',
          // the match row itself is gone: the entry keeps its id (no FK, db/007)
          matchId: matchIdOf(t, r.row),
          details: { table: t.name, key: auditRow(t, r.row, t.pk), values: auditRow(t, r.row, visibleColumns(t).map((c) => c.name).filter((n) => !t.pk.includes(n))) }
        })
        return r.row
      })
      changes = changesOf(t, 'DELETE', row)
      return ok({ table: t.name, deleted: true })
    })
    return changes ? { ...res, changes } : res
  }

  return { listTables, listRows, getRow, insertRow, updateRow, deleteRow, _loadCatalog: loadCatalog }
}
