/**
 * A rich but legitimate report fits db/050's 16 KB CHECK on frames +
 * breadcrumbs + data (audit SEC-41). Each part had its own bound, not their
 * sum: 20 breadcrumbs with a 4 KB detail each, or data of many small numbers
 * (jsonb takes 12 bytes for "1,"), failed the INSERT with 23514, ingest
 * answered 503 for the whole request and the device sent it again every
 * minute, for ever. Now the event is trimmed to fit (newest breadcrumbs and
 * top frames kept), and a 23514 that still happens refuses that one report
 * for good (OV_ERROR_TOO_LARGE), which the device drops.
 *
 * The Postgres part needs PG_TEST_URL (see tests/helpers/pgTestDb.js).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { SKIP_PG, createTestDatabase, quietLogger } from './helpers/pgTestDb.js'
import { checkClientEvent, serverEvent, jsonbSizeEstimate, fitEventJson, EVENT_JSON_MAX_BYTES, createErrorTracker } from '../lib/errorTracker.js'

const words = (n, w = 'abcdefgh') => Array.from({ length: Math.ceil(n / (w.length + 1)) }, () => w).join(' ').slice(0, n)
// the largest report each part allows on its own
const rich = (over = {}) => ({
  uid: randomUUID(),
  client_ts: new Date().toISOString(),
  kind: 'react.crash',
  level: 'error',
  product: 'openvolley',
  tool: 'scorer',
  message: 'Rendering the scoreboard failed',
  frames: Array.from({ length: 20 }, (_, i) => `render${i}@/assets/${words(170, 'chunk')}.js:1:${i + 1}`),
  breadcrumbs: Array.from({ length: 20 }, (_, i) => ({
    t: new Date().toISOString(), c: 'app', m: `step ${words(150, 'tap')}`,
    d: Object.fromEntries(Array.from({ length: 8 }, (_, k) => [`k${k}`, words(190, `v${i}`)]))
  })),
  data: Object.fromEntries(Array.from({ length: 19 }, (_, k) => [`field${k}`, words(190, 'value')])),
  ...over
})
const jsonSize = (row) => jsonbSizeEstimate(row.frames) + jsonbSizeEstimate(row.breadcrumbs) + jsonbSizeEstimate(row.data)

describe('error tracker: an event fits the database (SEC-41)', () => {
  it('a rich report is trimmed to fit: newest breadcrumbs and the top frames kept, the cut marked', () => {
    const e = rich()
    const { row } = checkClientEvent(e)
    assert.ok(row, 'taken')
    assert.ok(jsonSize(row) <= EVENT_JSON_MAX_BYTES, String(jsonSize(row)))
    assert.equal(row.frames[0], checkClientEvent({ ...e, breadcrumbs: [], data: {} }).row.frames[0], 'the top frame stays')
    assert.equal(row.breadcrumbs.at(-1).m, checkClientEvent({ ...e, frames: [], data: {} }).row.breadcrumbs.at(-1).m, 'the newest breadcrumb stays')
    assert.equal(row.data._trimmed === true || row.data._truncated === true, true)
    // a report that fits is left as it is
    const small = checkClientEvent(rich({ frames: ['a@/x.js:1:2'], breadcrumbs: [{ c: 'app', m: 'tap' }], data: { a: 1 } })).row
    assert.deepEqual(small.data, { a: 1 })
  })

  it('small numbers count as jsonb counts them (12 bytes each), not as their text', () => {
    const nums = Array.from({ length: 20 }, () => Array.from({ length: 20 }, () => 1))
    const e = rich({ frames: [], breadcrumbs: [], data: { a: nums, b: nums, c: nums, d: nums } })
    const { row } = checkClientEvent(e)
    assert.ok(JSON.stringify(e.data).length < 4096, 'within cleanData\'s own bound')
    assert.ok(jsonbSizeEstimate(checkClientEvent({ ...e, data: {} }).row.data) < 100)
    assert.ok(jsonSize(row) <= EVENT_JSON_MAX_BYTES)
    assert.deepEqual(row.data, { _truncated: true })
  })

  it('every part trimmed, the event still goes; the server\'s own events too', () => {
    const row = fitEventJson({ frames: Array.from({ length: 20 }, () => 'é'.repeat(200)), breadcrumbs: Array.from({ length: 20 }, () => ({ c: 'app', m: '€'.repeat(160) })), data: {} }, 600)
    assert.ok(jsonSize(row) <= 600, String(jsonSize(row)))
    const s = serverEvent(new Error('boom'), { data: { a: 1 } })
    assert.ok(jsonSize(s) <= EVENT_JSON_MAX_BYTES)
  })

  it('a 23514 from the database refuses that one report, not the request (no 503, no endless resend)', async () => {
    const tooBig = randomUUID()
    const stored = []
    const client = {
      async query(sql, values = []) {
        if (/^INSERT INTO public\.error_groups/.test(sql.trim())) return { rows: [{ id: randomUUID(), status: 'open', level: 'error', stored_day: null, stored_today: 0 }] }
        if (/^INSERT INTO public\.error_events/.test(sql.trim())) {
          if (values[1] === tooBig) throw Object.assign(new Error('new row for relation "error_events" violates check constraint "error_events_check"'), { code: '23514', constraint: 'error_events_check' })
          stored.push(values[1])
          return { rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      },
      release() {}
    }
    const t = createErrorTracker({ pool: { async connect() { return client } }, log: quietLogger(), maxStoreBytes: 0 })
    const ok = rich({ breadcrumbs: [], frames: [] })
    const r = await t.ingest({ body: { events: [rich({ uid: tooBig }), ok] }, ipKey: '198.51.100.1' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.data.rejected, [{ uid: tooBig, code: 'OV_ERROR_TOO_LARGE' }])
    assert.deepEqual(r.body.data.accepted, [ok.uid])
    assert.deepEqual(stored, [ok.uid])
    assert.equal(t.stats().tooLarge, 1)
  })
})

describe('error tracker: the estimate never undercounts Postgres (SEC-41)', { skip: SKIP_PG }, () => {
  let tdb, pool
  before(async () => {
    tdb = await createTestDatabase('error_size')
    pool = new pg.Pool({ connectionString: tdb.url, max: 2 })
  })
  after(async () => {
    await pool?.end()
    await tdb?.drop()
  })

  it('jsonbSizeEstimate >= pg_column_size(::jsonb) for every shape a report can have', async () => {
    const shapes = [
      {}, [], { a: 1 }, [1, 2, 3], { _truncated: true },
      Array.from({ length: 400 }, () => 1),
      Array.from({ length: 50 }, (_, i) => i * 1234.5678),
      [0, -0, 1e21, 1e-7, 123456789012345, 0.1, 1.7976931348623157e308, 5e-324, -42.125],
      { x: Array.from({ length: 20 }, () => Array.from({ length: 20 }, () => 12345)) },
      { a: null, b: true, c: false, d: 'é€😀', 'ключ': 'значение' },
      Array.from({ length: 20 }, () => ({ t: new Date().toISOString(), c: 'click', m: 'button "Point A"', d: { status: 500, ok: false, n: 3 } })),
      Array.from({ length: 20 }, () => 'onPoint@/assets/index-AbC12xYz.js:1:23456'),
      checkClientEvent(rich()).row.breadcrumbs,
      checkClientEvent(rich()).row.frames,
      checkClientEvent(rich()).row.data
    ]
    for (const v of shapes) {
      const { rows: [r] } = await pool.query('SELECT pg_column_size($1::jsonb) AS n', [JSON.stringify(v)])
      assert.ok(jsonbSizeEstimate(v) >= Number(r.n), `${JSON.stringify(v).slice(0, 80)}: estimate ${jsonbSizeEstimate(v)} < ${r.n}`)
    }
  })

  it('the richest report a device may send is stored, trimmed', async () => {
    const t = createErrorTracker({ pool, log: quietLogger() })
    const nums = Array.from({ length: 20 }, () => Array.from({ length: 20 }, () => 1))
    const events = [rich(), rich({ data: { a: nums, b: nums, c: nums, d: nums } })]
    const r = await t.ingest({ body: { events }, ipKey: '198.51.100.2' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.data.rejected, [])
    const { rows } = await pool.query('SELECT pg_column_size(frames) + pg_column_size(breadcrumbs) + pg_column_size(data) AS n FROM public.error_events WHERE uid = ANY($1::uuid[])', [events.map((e) => e.uid)])
    assert.equal(rows.length, 2)
    for (const x of rows) assert.ok(Number(x.n) <= 16384)
  })
})
