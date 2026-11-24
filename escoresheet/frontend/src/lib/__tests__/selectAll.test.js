import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../../utils/backendConfig', () => ({
  getApiUrl: (path) => `http://relay.test${path}`,
  getCloudApiUrl: (path) => `http://backend.test${path}`
}))

import { selectAll, sortRows, DB_MAX_ROWS, SELECT_ALL_MAX_PAGES } from '../selectAll'
import { apiFrom } from '../apiClient'

// An in-memory table answering like /api/db: eq/gt filters, ORDER BY, and a
// silent row cap. Records every request.
function fakeTable(rows, { cap = DB_MAX_ROWS, failOnPage = null, error = { message: 'boom', status: 503 } } = {}) {
  const requests = []
  const build = () => {
    const q = { filters: [], order: [], limit: null }
    const b = {
      eq(c, v) { q.filters.push(['eq', c, v]); return b },
      gt(c, v) { q.filters.push(['gt', c, v]); return b },
      order(c, o) { q.order.push([c, o?.ascending !== false]); return b },
      limit(n) { q.limit = n; return b },
      then(resolve, reject) {
        requests.push(q)
        if (failOnPage === requests.length) return Promise.resolve({ data: null, error, status: error.status }).then(resolve, reject)
        let data = rows.filter(r => q.filters.every(([t, c, v]) => (t === 'eq' ? r[c] === v : r[c] > v)))
        for (const [c, asc] of [...q.order].reverse()) {
          data.sort((a, z) => (a[c] < z[c] ? -1 : a[c] > z[c] ? 1 : 0) * (asc ? 1 : -1))
        }
        data = data.slice(0, Math.min(q.limit ?? cap, cap))
        return Promise.resolve({ data, error: null, status: 200 }).then(resolve, reject)
      }
    }
    return b
  }
  return { build, requests }
}

const range = (n, f = (i) => ({ id: i + 1 })) => Array.from({ length: n }, (_, i) => f(i))

describe('selectAll', () => {
  it('reads every row past the server cap, in pages keyed on id', async () => {
    const t = fakeTable(range(1442).reverse()) // storage order is not id order
    const { data, error, status } = await selectAll(t.build)
    expect(error).toBeNull()
    expect(status).toBe(200)
    expect(data).toHaveLength(1442)
    expect(new Set(data.map(r => r.id)).size).toBe(1442)
    expect(t.requests).toHaveLength(2)
    expect(t.requests[0]).toEqual({ filters: [], order: [['id', true]], limit: 1000 })
    expect(t.requests[1]).toEqual({ filters: [['gt', 'id', 1000]], order: [['id', true]], limit: 1000 })
  })

  it('keeps the caller filters on every page', async () => {
    const rows = range(2500, i => ({ id: i + 1, league: i % 2 ? '3L' : '1L' }))
    const t = fakeTable(rows)
    const { data } = await selectAll(() => t.build().eq('league', '3L'), { pageSize: 500 })
    expect(data).toHaveLength(1250)
    expect(data.every(r => r.league === '3L')).toBe(true)
    expect(t.requests).toHaveLength(3)
    for (const q of t.requests) expect(q.filters[0]).toEqual(['eq', 'league', '3L'])
  })

  it('an exact multiple of the page size ends on one empty page', async () => {
    const t = fakeTable(range(2000))
    const { data, error } = await selectAll(t.build)
    expect(error).toBeNull()
    expect(data).toHaveLength(2000)
    expect(t.requests).toHaveLength(3)
    expect(t.requests[2].filters).toEqual([['gt', 'id', 2000]])
  })

  it('an empty table is one request and an empty list', async () => {
    const t = fakeTable([])
    const result = await selectAll(t.build)
    expect(result.data).toEqual([])
    expect(result.error).toBeNull()
    expect(t.requests).toHaveLength(1)
  })

  it('a failing page fails the whole read: no partial list', async () => {
    const t = fakeTable(range(2500), { failOnPage: 2 })
    const { data, error, status } = await selectAll(t.build)
    expect(data).toBeNull()
    expect(error).toEqual({ message: 'boom', status: 503 })
    expect(status).toBe(503)
    expect(t.requests).toHaveLength(2) // stops at the failure
  })

  it('a page that throws resolves as an error, never rejects', async () => {
    let n = 0
    const build = () => {
      const b = {
        order: () => b, gt: () => b, limit: () => b,
        then: (resolve, reject) => {
          n += 1
          if (n === 2) return Promise.reject(new Error('bad JSON')).then(resolve, reject)
          return Promise.resolve({ data: range(2), error: null }).then(resolve, reject)
        }
      }
      return b
    }
    const result = await selectAll(build, { pageSize: 2 })
    expect(result.data).toBeNull()
    expect(result.error).toEqual({ message: 'bad JSON' })
  })

  it('pages on a uuid/text key with the server ordering', async () => {
    const ids = ['f0', '0a', 'c3', '7b', '19', 'aa', '3e']
    const t = fakeTable(ids.map(id => ({ id })))
    const { data } = await selectAll(t.build, { pageSize: 3 })
    expect(data.map(r => r.id)).toEqual(['0a', '19', '3e', '7b', 'aa', 'c3', 'f0'])
    expect(t.requests.map(q => q.filters)).toEqual([[], [['gt', 'id', '3e']], [['gt', 'id', 'c3']]])
  })

  it('sorts the full result by opts.order; equal values keep key order', async () => {
    const rows = [
      { id: 1, last_name: 'Zeller' }, { id: 2, last_name: 'Keller' }, { id: 3, last_name: 'Müller' },
      { id: 4, last_name: 'Keller' }, { id: 5, last_name: null }, { id: 6, last_name: 'Abt' }, { id: 7, last_name: 'Keller' }
    ]
    const t = fakeTable(rows)
    const { data } = await selectAll(t.build, { pageSize: 2, order: [{ column: 'last_name' }] })
    expect(data.map(r => r.id)).toEqual([6, 2, 4, 7, 3, 1, 5]) // no duplicate lost, null last
  })

  it('refuses a builder that already orders (it would page in the wrong order)', async () => {
    await expect(selectAll(() => apiFrom('svrz_games').select('id').order('datetime'))).rejects.toThrow(/opts.order/)
  })

  it('a page size above the server cap is refused (a cut page would look like the last)', async () => {
    await expect(selectAll(fakeTable([]).build, { pageSize: 2000 })).rejects.toThrow(RangeError)
  })

  it('rows without the key fail instead of looping', async () => {
    const t = fakeTable(range(5, () => ({ league: '1L' })))
    const { data, error } = await selectAll(t.build, { pageSize: 5 })
    expect(data).toBeNull()
    expect(error.code).toBe('OV_SELECT_ALL_NO_KEY')
  })

  it('a key that does not advance fails instead of looping', async () => {
    // A server that ignores gt returns the same page forever
    const page = range(3)
    const build = () => {
      const b = { order: () => b, gt: () => b, limit: () => b, then: (r) => Promise.resolve({ data: page, error: null }).then(r) }
      return b
    }
    const { error } = await selectAll(build, { pageSize: 3 })
    expect(error.code).toBe('OV_SELECT_ALL_STALLED')
  })

  it('stops at the page ceiling with a clear error', async () => {
    const t = fakeTable(range(50))
    const { data, error } = await selectAll(t.build, { pageSize: 10, maxPages: 3 })
    expect(data).toBeNull()
    expect(error.code).toBe('OV_SELECT_ALL_TOO_MANY_PAGES')
    expect(error.message).toMatch(/3 pages/)
    expect(t.requests).toHaveLength(3)
    expect(SELECT_ALL_MAX_PAGES).toBeGreaterThan(1)
  })
})

describe('selectAll over the real apiFrom', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('sends order id asc, gt the last id and limit 1000 with the caller filters', async () => {
    const pages = [range(1000), range(442, i => ({ id: 1001 + i }))]
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: pages.shift(), error: null }) }))
    const { data, error } = await selectAll(() => apiFrom('svrz_games').select('id, league').in('league', ['1L', '3L']))
    expect(error).toBeNull()
    expect(data).toHaveLength(1442)
    const bodies = globalThis.fetch.mock.calls.map(c => JSON.parse(c[1].body))
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toEqual({
      table: 'svrz_games',
      action: 'select',
      params: {
        columns: 'id, league',
        filters: [{ type: 'in', column: 'league', value: ['1L', '3L'] }],
        order: [{ column: 'id', ascending: true }],
        limit: 1000
      }
    })
    expect(bodies[1].params.filters).toEqual([
      { type: 'in', column: 'league', value: ['1L', '3L'] },
      { type: 'gt', column: 'id', value: 1000 }
    ])
  })

  it('a network failure on a later page comes back as that error', async () => {
    let n = 0
    globalThis.fetch = vi.fn(async () => {
      n += 1
      if (n === 2) throw new Error('offline')
      return { ok: true, status: 200, json: async () => ({ data: range(1000), error: null }) }
    })
    const { data, error, status } = await selectAll(() => apiFrom('svrz_games').select('id'))
    expect(data).toBeNull()
    expect(error).toMatchObject({ network: true, status: 0 })
    expect(status).toBe(0)
  })
})

describe('sortRows', () => {
  it('DESC puts nulls first, ASC last, and nullsFirst overrides', () => {
    const rows = [{ v: 2 }, { v: null }, { v: 10 }]
    expect(sortRows(rows, [{ column: 'v', ascending: false }]).map(r => r.v)).toEqual([null, 10, 2])
    expect(sortRows(rows, [{ column: 'v' }]).map(r => r.v)).toEqual([2, 10, null])
    expect(sortRows(rows, [{ column: 'v', nullsFirst: true }]).map(r => r.v)).toEqual([null, 2, 10])
  })

  it('without an order returns the rows as they came', () => {
    const rows = [{ id: 2 }, { id: 1 }]
    expect(sortRows(rows, undefined)).toBe(rows)
  })
})
