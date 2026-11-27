/**
 * POST /api/errors' rate limits (lib/errorTracker.js ingest, audit SEC-19):
 * the caller's own limits (address, device) come before the shared ones, the
 * shared ones are per product and count only the events that passed the
 * check, and reports without a session cannot take the part kept for
 * signed-in accounts. Before, one address drained the one global counter
 * with junk entries (the number 1) and every real report of every device
 * was answered 202 dropped for the rest of the window.
 *
 * From the audit's poc/errors-logs/total-limit-starve.mjs and
 * poc/verify-medium/errors-single-ip.mjs. No database: a pool double.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createErrorTracker, RATE_LIMITS, isCrawlerUserAgent, isCrawlerArtifact } from '../lib/errorTracker.js'

const quiet = { log() {}, warn() {}, error() {} }
const real = (over = {}) => ({
  uid: randomUUID(),
  client_ts: new Date().toISOString(),
  kind: 'js.error',
  level: 'error',
  product: 'openvolley',
  tool: 'scorer',
  message: 'TypeError: a real bug on a scorer tablet',
  frames: ['onPoint@/assets/index-AbC12xYz.js:1:23456'],
  ...over
})

/** A pool double: every report goes in (counted in `stored`). */
function fakePool() {
  const stored = []
  const client = {
    async query(sql, values = []) {
      if (/^INSERT INTO public\.error_groups/.test(sql.trim())) {
        return { rows: [{ id: randomUUID(), status: 'open', level: values[4], stored_day: null, stored_today: 0, regressed: false, alert_due_at: null, last_alert_at: null }] }
      }
      if (/^INSERT INTO public\.error_events/.test(sql.trim())) {
        stored.push(values[1])
        return { rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
    release() {}
  }
  return { stored, async connect() { return client }, async query() { return { rows: [] } } }
}
const tracker = (opts = {}) => {
  const pool = fakePool()
  return { pool, t: createErrorTracker({ pool, log: quiet, maxStoreBytes: 0, ...opts }) }
}
const junk = (n) => ({ events: Array.from({ length: n }, () => 1) })

describe('error tracker: rate limits (SEC-19)', () => {
  it('one address sending junk cannot drain the shared budget (verify-medium/errors-single-ip.mjs)', async () => {
    const { pool, t } = tracker()
    const seen = {}
    for (let i = 0; i < 250; i++) {
      const r = await t.ingest({ body: junk(20), ipKey: '198.51.100.7' })
      const k = `${r.status}${r.body?.data?.dropped ? ' dropped' : ''}`
      seen[k] = (seen[k] || 0) + 1
    }
    // junk is never a report: nothing is charged, nothing stored
    assert.deepEqual(seen, { 200: 250 })
    const victim = await t.ingest({ body: { events: [real()] }, ipKey: '203.0.113.9' })
    assert.equal(victim.status, 200, JSON.stringify(victim.body))
    assert.equal(victim.body.data.accepted.length, 1)
    assert.equal(pool.stored.length, 1)
  })

  it('five addresses sending junk at once leave the others\' reports alone (errors-logs/total-limit-starve.mjs)', async () => {
    const { t } = tracker()
    const all = []
    for (const ip of ['203.0.113.61', '203.0.113.62', '203.0.113.63', '203.0.113.64', '203.0.113.65']) {
      for (let i = 0; i < 50; i++) all.push(t.ingest({ body: junk(20), ipKey: ip }))
    }
    await Promise.all(all)
    for (let i = 0; i < 5; i++) {
      const r = await t.ingest({ body: { events: [real()] }, ipKey: `198.51.100.${80 + i}` })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.equal(r.body.data.accepted.length, 1)
    }
  })

  it('an address over its own limit spends nothing of the shared budget', async () => {
    const { t } = tracker({ rateLimits: { total: { max: 200, windowMs: 300_000 }, anonymous: { max: 200, windowMs: 300_000 } } })
    // 120 per address: 6 requests of 20 go in, the rest is dropped before the shared budget
    const answers = []
    for (let i = 0; i < 30; i++) answers.push((await t.ingest({ body: { events: Array.from({ length: 20 }, () => real()) }, ipKey: '198.51.100.7' })).status)
    assert.equal(answers.filter((s) => s === 200).length, RATE_LIMITS.ip.max / 20)
    assert.equal(answers.filter((s) => s === 202).length, 30 - RATE_LIMITS.ip.max / 20)
    // the shared 200 had 120 taken: 80 are left for everyone else
    const other = await t.ingest({ body: { events: Array.from({ length: 20 }, () => real()) }, ipKey: '203.0.113.20' })
    assert.equal(other.status, 200)
  })

  it('entries that fail the check are charged to the caller only, never to the shared budget', async () => {
    const { t } = tracker({ rateLimits: { total: { max: 30, windowMs: 300_000 }, anonymous: { max: 30, windowMs: 300_000 } } })
    for (let i = 0; i < 10; i++) {
      const r = await t.ingest({ body: { events: Array.from({ length: 20 }, () => ({ uid: randomUUID(), kind: 'nope' })) }, ipKey: `203.0.113.${100 + i}` })
      assert.equal(r.status, 200)
      assert.equal(r.body.data.rejected.length, 20)
    }
    const r = await t.ingest({ body: { events: Array.from({ length: 20 }, () => real()) }, ipKey: '198.51.100.50' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    // the shared budget holds: 20 of 30 taken, another 19 do not fit
    const over = await t.ingest({ body: { events: [...Array.from({ length: 19 }, () => real()), { uid: 'bad' }] }, ipKey: '198.51.100.51' })
    assert.equal(over.status, 202)
    assert.equal(over.body.data.dropped, 19)
    assert.deepEqual(over.body.data.rejected, [{ uid: 'bad', code: 'OV_ERROR_INVALID' }])
    assert.deepEqual(over.body.data.accepted, [])
  })

  it('reports without a session leave the signed-in part of a product\'s budget; each product has its own', async () => {
    const { t } = tracker({ rateLimits: { total: { max: 40, windowMs: 300_000 }, anonymous: { max: 20, windowMs: 300_000 } } })
    assert.equal((await t.ingest({ body: { events: Array.from({ length: 20 }, () => real()) }, ipKey: '198.51.100.60' })).status, 200)
    // the anonymous share is used up
    assert.equal((await t.ingest({ body: { events: [real()] }, ipKey: '198.51.100.61' })).status, 202)
    // a signed-in scorer still reports
    const signed = await t.ingest({ body: { events: [real()] }, accountId: randomUUID(), ipKey: '198.51.100.62' })
    assert.equal(signed.status, 200, JSON.stringify(signed.body))
    // OpenBeach has its own budget
    const beach = await t.ingest({ body: { events: [real({ product: 'openbeach' })] }, ipKey: '198.51.100.63' })
    assert.equal(beach.status, 200, JSON.stringify(beach.body))
  })

  it('the answers keep their shape for the apps in the field', async () => {
    const { t } = tracker()
    const ok = await t.ingest({ body: { events: [real(), { uid: 'x' }] }, ipKey: '198.51.100.70' })
    assert.deepEqual(Object.keys(ok.body.data).sort(), ['accepted', 'rejected'])
    for (let i = 0; i < 6; i++) await t.ingest({ body: { events: Array.from({ length: 20 }, () => real()) }, ipKey: '198.51.100.71' })
    const dropped = await t.ingest({ body: { events: [real()] }, ipKey: '198.51.100.71' })
    assert.equal(dropped.status, 202)
    assert.deepEqual(dropped.body.data, { accepted: [], rejected: [], dropped: 1 })
  })
})

describe('error tracker: crawlers are not errors (27.11.2026)', () => {
  const GOOGLEBOT = 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.8103.78 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
  const TABLET = 'Mozilla/5.0 (Linux; Android 11; SM-T220) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
  const wrs = (over = {}) => real({ kind: 'js.unhandledrejection', message: 'Error: Rejected', frames: ['wrsParams.serviceWorkers.navigator.serviceWorker.register (<anonymous>:13:648)', '/registerSW.js:1:98'], ...over })

  it('knows the crawlers and headless browsers, not a scorer\'s tablet', () => {
    assert.equal(isCrawlerUserAgent(GOOGLEBOT), true)
    assert.equal(isCrawlerUserAgent('Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)'), true)
    assert.equal(isCrawlerUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36'), true)
    assert.equal(isCrawlerUserAgent(TABLET), false)
    assert.equal(isCrawlerUserAgent(null), false)
    assert.equal(isCrawlerArtifact(wrs()), true)
    assert.equal(isCrawlerArtifact(real()), false)
  })

  it('a crawler\'s reports are answered as taken and never stored', async () => {
    const { pool, t } = tracker()
    const a = wrs(); const b = real()
    const r = await t.ingest({ body: { events: [a, b] }, ipKey: '66.249.66.1', userAgent: GOOGLEBOT })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.data.accepted.sort(), [a.uid, b.uid].sort())
    assert.equal(pool.stored.length, 0)
  })

  it('a WRS stack is dropped even without a crawler User-Agent; the real report beside it is stored', async () => {
    const { pool, t } = tracker()
    const a = wrs(); const b = real()
    const r = await t.ingest({ body: { events: [a, b] }, ipKey: '203.0.113.40', userAgent: TABLET })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.data.accepted.sort(), [a.uid, b.uid].sort())
    assert.equal(pool.stored.length, 1)
    const only = await t.ingest({ body: { events: [wrs()] }, ipKey: '203.0.113.41', userAgent: TABLET })
    assert.equal(only.status, 200)
    assert.equal(only.body.data.accepted.length, 1)
    assert.equal(pool.stored.length, 1)
  })

  it('a scorer\'s tablet report goes in as before', async () => {
    const { pool, t } = tracker()
    const r = await t.ingest({ body: { events: [real()] }, ipKey: '203.0.113.42', userAgent: TABLET })
    assert.equal(r.status, 200)
    assert.equal(pool.stored.length, 1)
  })
})

