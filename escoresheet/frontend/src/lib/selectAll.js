/**
 * selectAll: read every row of an /api/db select, not just the first page.
 *
 * The backend caps each select at DB_MAX_ROWS rows (pgQuery cfg.maxRows) and
 * says nothing when it cuts. It has no offset and no OR filters, so this pages
 * by keyset on one unique column: ORDER BY key ASC, key > last, LIMIT pageSize,
 * with the caller's filters on every page, until a page comes back short.
 *
 *   const { data, error } = await selectAll(
 *     () => apiFrom('referee_database').select('id, last_name').contains('sport_type', '["indoor"]'),
 *     { order: [{ column: 'last_name' }] })
 *
 * - `build` returns a fresh builder with the columns and filters, and no
 *   order, limit or single(): the paging owns those. The columns must include
 *   `key`.
 * - `key` must be unique and never null (a primary key). The server compares
 *   it with its own ordering, so text and uuid keys page correctly.
 * - `order` sorts the full result on the client, like .order() would on the
 *   server (ASC puts nulls last, DESC first; ties keep key order). Strings
 *   compare with localeCompare, so the order of accented names can differ
 *   from the database collation.
 * - The result is { data, error, status } like one apiFrom request, and it
 *   never rejects for a failed request (only for a misuse such as an ordered
 *   builder). Any page that fails fails the whole read (data null): a partial
 *   list would be the same silent truncation this exists to prevent.
 *
 * Kept out of apiClient.js so tests that mock apiClient's apiFrom still run
 * the real paging over their mock builder.
 */

// The backend's row cap per select (backend/lib/pgQuery.js cfg.maxRows).
// pageSize must not exceed it: a page cut by the server would look like the
// last page.
export const DB_MAX_ROWS = 1000

// Safety ceiling: 200 pages of 1000 rows. Past it the read fails loudly
// instead of looping or loading an unbounded table into the page.
export const SELECT_ALL_MAX_PAGES = 200

let collator = null
function compareText(a, b) {
  try {
    if (!collator) collator = new Intl.Collator(undefined, { sensitivity: 'variant' })
    return collator.compare(a, b)
  } catch {
    return a < b ? -1 : a > b ? 1 : 0
  }
}

function compareValues(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  return compareText(String(a), String(b))
}

/** Sort rows like ORDER BY on the server; stable, so ties keep their order. */
export function sortRows(rows, order) {
  const terms = (order || []).filter(o => o && o.column)
  if (!terms.length) return rows
  return rows
    .map((row, i) => ({ row, i }))
    .sort((x, y) => {
      for (const { column, ascending = true, nullsFirst } of terms) {
        const a = x.row?.[column]
        const b = y.row?.[column]
        const aNull = a === null || a === undefined
        const bNull = b === null || b === undefined
        if (aNull || bNull) {
          if (aNull && bNull) continue
          // Postgres default: NULLS LAST for ASC, NULLS FIRST for DESC
          const first = nullsFirst ?? !ascending
          return (aNull ? -1 : 1) * (first ? 1 : -1)
        }
        const c = compareValues(a, b)
        if (c !== 0) return ascending ? c : -c
      }
      return x.i - y.i
    })
    .map(({ row }) => row)
}

function pagingError(code, message) {
  return { data: null, error: { code, message, status: 0 }, count: undefined, status: 0 }
}

/**
 * @param {() => object} build returns a fresh apiFrom(...).select(...) builder with filters
 * @param {{key?: string, pageSize?: number, maxPages?: number,
 *          order?: {column: string, ascending?: boolean, nullsFirst?: boolean}[]}} [opts]
 * @returns {Promise<{data: object[]|null, error: object|null, count: undefined, status: number}>}
 */
export async function selectAll(build, { key = 'id', pageSize = DB_MAX_ROWS, maxPages = SELECT_ALL_MAX_PAGES, order } = {}) {
  if (typeof build !== 'function') throw new TypeError('selectAll needs a function that builds the query')
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > DB_MAX_ROWS) {
    throw new RangeError(`selectAll pageSize must be 1..${DB_MAX_ROWS}`)
  }
  const rows = []
  let last
  let status = 200
  for (let page = 0; page < maxPages; page++) {
    let q = build()
    // A builder that already orders would page in the wrong order
    if (Array.isArray(q?._params?.order) && q._params.order.length) {
      throw new Error('selectAll: pass the final order as opts.order, not .order() on the builder')
    }
    q = q.order(key, { ascending: true })
    if (last !== undefined) q = q.gt(key, last)
    let result
    try {
      result = await q.limit(pageSize)
    } catch (err) {
      // Resolve, like the builder does without a reject handler: callers may
      // use .then() alone
      return { data: null, error: { message: err?.message || String(err) }, count: undefined, status: 0 }
    }
    if (result?.error) {
      return { data: null, error: result.error, count: undefined, status: result.status ?? result.error.status ?? 0 }
    }
    if (result?.status !== undefined) status = result.status
    const batch = Array.isArray(result?.data) ? result.data : []
    for (const row of batch) rows.push(row)
    if (batch.length < pageSize) return { data: sortRows(rows, order), error: null, count: undefined, status }
    const next = batch[batch.length - 1]?.[key]
    if (next === undefined || next === null) {
      return pagingError('OV_SELECT_ALL_NO_KEY', `selectAll: the rows carry no "${key}"; select it`)
    }
    if (next === last) {
      return pagingError('OV_SELECT_ALL_STALLED', `selectAll: "${key}" did not advance; it must be unique`)
    }
    last = next
  }
  return pagingError('OV_SELECT_ALL_TOO_MANY_PAGES', `selectAll: more than ${maxPages * pageSize} rows; stopped after ${maxPages} pages`)
}
