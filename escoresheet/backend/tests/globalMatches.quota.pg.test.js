// The Global cloud copy's ceiling and network budgets (audit 2026-11-23
// SEC-01: anonymous saves under fresh keys filled the database volume that
// holds the official match records). lib/globalMatches.js on Postgres with
// db/053; the limits scaled down so a test fills them in a few saves.
// Needs PG_TEST_URL (tests/helpers/pgTestDb.js).
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import { SKIP_PG, createTestDatabase } from './helpers/pgTestDb.js'
import { createGlobalMatches, cloudLimitsFromEnv, QUOTA_DEFAULTS } from '../lib/globalMatches.js'
import { minimalPdf } from './helpers/pdfFixture.js'

const silent = { error() {}, warn() {}, log() {} }
const KiB = 1024
const MiB = 1024 * KiB
const newKey = () => crypto.randomBytes(16).toString('base64url') // 22 characters, as the app's backup code
const summary = { home: { name: 'Bergtal IS' }, away: { name: 'Seeblick IS' }, status: 'live' }
// a bundle of about n bytes (the device's export of the match)
const bundleOf = (n) => ({ version: 1, match: { id: 1 }, events: [{ note: 'x'.repeat(Math.max(0, n - 60)) }] })
// one Postgres cannot compress (TOAST would shrink the one above to almost nothing)
const randomBundleOf = (n) => ({ version: 1, match: { id: 1 }, events: [{ note: crypto.randomBytes(Math.ceil(n * 0.75)).toString('base64') }] })
const net = (i) => `2001:db8:${(i >> 8).toString(16)}:${(i & 255).toString(16)}00::1` // a /56 each
const count = async (pool) => (await pool.query('SELECT count(*)::int AS n FROM public.global_matches')).rows[0].n

describe('the ceilings from the environment', () => {
  it('2 GiB and 50000 copies by default; OV_GLOBAL_CLOUD_MAX_MB / _ROWS set them, a typo stops the start', () => {
    assert.equal(QUOTA_DEFAULTS.maxTotalBytes, 2 * 1024 * MiB)
    assert.equal(QUOTA_DEFAULTS.maxRows, 50000)
    assert.deepEqual(cloudLimitsFromEnv({}), {})
    assert.deepEqual(cloudLimitsFromEnv({ OV_GLOBAL_CLOUD_MAX_MB: '512', OV_GLOBAL_CLOUD_MAX_ROWS: '1000' }), { maxTotalBytes: 512 * MiB, maxRows: 1000 })
    assert.throws(() => cloudLimitsFromEnv({ OV_GLOBAL_CLOUD_MAX_MB: 'lots' }), /OV_GLOBAL_CLOUD_MAX_MB/)
    assert.throws(() => cloudLimitsFromEnv({ OV_GLOBAL_CLOUD_MAX_ROWS: '-1' }), /OV_GLOBAL_CLOUD_MAX_ROWS/)
  })

  it('what everyone writes, sized to the WAL archive (GCS-R1): 16 MiB a minute, 256 MiB an hour, 1 GiB a day; OV_GLOBAL_CLOUD_WRITE_MB_DAY / _WAL_MAX_MB', () => {
    assert.equal(QUOTA_DEFAULTS.writtenPerMinute, 16 * MiB)
    assert.equal(QUOTA_DEFAULTS.writtenPerHour, 256 * MiB)
    assert.equal(QUOTA_DEFAULTS.writtenPerDay, 1024 * MiB)
    assert.equal(QUOTA_DEFAULTS.writtenNetShare, 0.25)
    assert.equal(QUOTA_DEFAULTS.walMaxBytes, 1024 * MiB)
    assert.deepEqual(cloudLimitsFromEnv({ OV_GLOBAL_CLOUD_WRITE_MB_DAY: '2048', OV_GLOBAL_CLOUD_WAL_MAX_MB: '512' }),
      { writtenPerDay: 2048 * MiB, writtenPerHour: 512 * MiB, writtenPerMinute: 32 * MiB, walMaxBytes: 512 * MiB })
    assert.throws(() => cloudLimitsFromEnv({ OV_GLOBAL_CLOUD_WRITE_MB_DAY: '0' }), /OV_GLOBAL_CLOUD_WRITE_MB_DAY/)
    // the network tiers: an IPv6 /48 and an IPv4 /24 too (GCS-R4)
    assert.deepEqual(QUOTA_DEFAULTS.perNetwork.map((l) => [l.name, l.v6Bits, l.v4Bits]), [['/64', 64, 32], ['/56', 56, 32], ['/48', 48, 24]])
    // an IPv4 address (a hall behind its NAT) gets its /24's share (SR-4)
    assert.deepEqual(QUOTA_DEFAULTS.perNetwork.map((l) => l.v4Max ? [l.v4Max.keys, l.v4Max.bytes] : null), [[1000, 512 * MiB], [1000, 512 * MiB], null])
  })
})

describe('Global cloud: the ceiling and the network budgets (SEC-01)', { skip: SKIP_PG }, () => {
  let tdb, pool
  before(async () => {
    tdb = await createTestDatabase('globalquota')
    pool = new pg.Pool({ connectionString: await tdb.createAppRole() })
  })
  after(async () => { await pool?.end(); await tdb?.drop() })
  beforeEach(async () => {
    const owner = new pg.Client({ connectionString: tdb.url })
    await owner.connect()
    try { await owner.query('DELETE FROM public.global_matches') } finally { await owner.end() }
  })

  it('the audit\'s flood: fresh keys from one address stop at its daily budget (429), rows stay; another network still saves', async () => {
    const gm = createGlobalMatches({
      pool, logger: silent,
      perNetwork: [{ name: '/64', v6Bits: 64, max: { keys: 5, bytes: 64 * MiB } }, { name: '/56', v6Bits: 56, max: { keys: 8, bytes: 64 * MiB } }]
    })
    const attacker = { ip: '203.0.113.50' }
    const statuses = []
    for (let i = 0; i < 12; i++) statuses.push((await gm.save(newKey(), '1234', { bundle: bundleOf(4 * KiB), summary }, attacker)).status)
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429, 429, 429, 429, 429, 429])
    const r = await gm.save(newKey(), '1234', { bundle: bundleOf(4 * KiB), summary }, attacker)
    assert.equal(r.body.error.code, 'OV_GLOBAL_QUOTA')
    // when the network's day ends, for the app's retry of a refused final copy (SR-4)
    assert.ok(r.retryAfter > 23 * 3600 && r.retryAfter <= 24 * 3600, `retryAfter ${r.retryAfter}`)
    assert.equal(await count(pool), 5, 'no row for a refused save')
    // a hall elsewhere: its own budget
    assert.equal((await gm.save(newKey(), '1234', { bundle: bundleOf(4 * KiB), summary }, { ip: '198.51.100.7' })).status, 200)
    // the copies the attacker has may still be saved again (no new key)
    assert.equal(await count(pool), 6)
  })

  it('IPv6: every /64 of one /56 shares the /56 budget; another /56 has its own', async () => {
    const gm = createGlobalMatches({
      pool, logger: silent,
      perNetwork: [{ name: '/64', v6Bits: 64, max: { keys: 2 } }, { name: '/56', v6Bits: 56, max: { keys: 5 } }]
    })
    const in56 = (i) => ({ ip: `2001:db8:0:1${i.toString(16).padStart(2, '0')}::${i + 1}` }) // 2001:db8:0:100::/56, a /64 each
    const statuses = []
    for (let i = 0; i < 4; i++) {
      statuses.push((await gm.save(newKey(), '1234', { bundle: bundleOf(KiB), summary }, in56(i))).status)
      statuses.push((await gm.save(newKey(), '1234', { bundle: bundleOf(KiB), summary }, in56(i))).status)
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429, 429])
    assert.equal((await gm.save(newKey(), '1234', { bundle: bundleOf(KiB), summary }, { ip: '2001:db8:0:200::1' })).status, 200)
  })

  it('the table\'s ceiling: past it a new copy gets 507 OV_GLOBAL_FULL (rows stay), a copy that exists still saves; an alert at half', async () => {
    const alerts = []
    const gm = createGlobalMatches({ pool, logger: silent, maxTotalBytes: 200 * KiB, maxRows: 1000, onAlert: (m) => alerts.push(m) })
    const keys = []
    let i = 0
    let r
    for (;;) {
      const key = newKey()
      r = await gm.save(key, '1234', { bundle: bundleOf(30 * KiB), summary }, { ip: net(i++) }) // a network each: the ceiling, not a budget
      if (r.status !== 200) break
      keys.push(key)
      assert.ok(i < 50, 'the ceiling must stop the flood')
    }
    assert.equal(r.status, 507)
    assert.equal(r.body.error.code, 'OV_GLOBAL_FULL')
    assert.equal(keys.length, 6, '6 copies of ~30 KiB fit under 200 KiB')
    assert.equal(await count(pool), 6)
    assert.ok(alerts.some((m) => /over 50% full/.test(m)), 'alerted at half')
    assert.ok(alerts.some((m) => /is full/.test(m)), 'alerted when full')
    // the match in progress keeps its cloud copy: a re-save (also somewhat larger) passes
    assert.equal((await gm.save(keys[0], '1234', { bundle: bundleOf(30 * KiB), summary }, { ip: net(99) })).status, 200)
    assert.equal((await gm.save(keys[0], '1234', { bundle: bundleOf(40 * KiB), summary }, { ip: net(99) })).status, 200)
    // ... but not without end (growHeadroom: 25% above the ceiling)
    assert.equal((await gm.save(keys[1], '1234', { bundle: bundleOf(90 * KiB), summary }, { ip: net(99) })).status, 507)
    // a deleted copy makes room again
    assert.equal((await gm.del(keys[2], '1234', { ip: net(99) })).status, 200)
    assert.equal((await gm.del(keys[3], '1234', { ip: net(99) })).status, 200)
    assert.equal((await gm.save(newKey(), '1234', { bundle: bundleOf(30 * KiB), summary }, { ip: net(98) })).status, 200)
  })

  it('the row ceiling, counted on the table: copies from before db/053 (stored_bytes NULL) count, and a new process counts them too', async () => {
    const owner = new pg.Client({ connectionString: tdb.url })
    await owner.connect()
    try {
      for (let n = 0; n < 3; n++) {
        await owner.query(`INSERT INTO public.global_matches (key_hash, pin_hash, summary, bundle) VALUES ($1, $2, '{}'::jsonb, $3::jsonb)`,
          [crypto.randomBytes(32).toString('hex'), crypto.randomBytes(32).toString('hex'), JSON.stringify(randomBundleOf(20 * KiB))])
      }
    } finally { await owner.end() }
    const gm = createGlobalMatches({ pool, logger: silent, maxTotalBytes: 10 * MiB, maxRows: 4 })
    assert.equal((await gm.save(newKey(), '1234', { bundle: bundleOf(KiB), summary }, { ip: net(1) })).status, 200)
    assert.equal((await gm.save(newKey(), '1234', { bundle: bundleOf(KiB), summary }, { ip: net(2) })).status, 507)
    const u = await gm.usage()
    assert.equal(u.rows, 4)
    assert.ok(u.bytes >= 3 * 20 * KiB, `the old rows are counted (pg_column_size): ${u.bytes}`)
    // a restart: the count comes from the table
    const again = createGlobalMatches({ pool, logger: silent, maxTotalBytes: 10 * MiB, maxRows: 4 })
    assert.equal((await again.save(newKey(), '1234', { bundle: bundleOf(KiB), summary }, { ip: net(3) })).status, 507)
    const { rows: [s] } = await pool.query('SELECT count(*)::int AS n FROM public.global_matches WHERE stored_bytes IS NOT NULL')
    assert.equal(s.n, 1, 'stored_bytes is written for the new copy')
  })

  it('stored_bytes counts the bundle, the summary and the PDF; a save without pdf keeps the PDF counted', async () => {
    const gm = createGlobalMatches({ pool, logger: silent })
    const key = newKey()
    const pdf = minimalPdf({ pad: 20 * KiB })
    await gm.save(key, '1234', { bundle: bundleOf(KiB), summary, pdf: pdf.toString('base64') }, { ip: net(5) })
    const one = Number((await pool.query('SELECT stored_bytes FROM public.global_matches')).rows[0].stored_bytes)
    assert.ok(one > pdf.length + KiB && one < pdf.length + 2 * KiB, String(one))
    await gm.save(key, '1234', { bundle: bundleOf(KiB), summary }, { ip: net(5) })
    assert.equal(Number((await pool.query('SELECT stored_bytes FROM public.global_matches')).rows[0].stored_bytes), one)
  })

  it('a network\'s bytes: what its saves add to the table a day; re-saves of one copy add nothing', async () => {
    // (what re-saves write is the shared write budget's: globalMatches.writes.pg.test.js)
    const gm = createGlobalMatches({
      pool, logger: silent,
      perNetwork: [{ name: '/64', v6Bits: 64, max: { keys: 100, bytes: 100 * KiB } }]
    })
    const ip = { ip: '192.0.2.20' }
    const key = newKey()
    assert.equal((await gm.save(key, '1234', { bundle: bundleOf(60 * KiB), summary }, ip)).status, 200)
    // a second copy would add more than the 100 KiB the network may add
    assert.equal((await gm.save(newKey(), '1234', { bundle: bundleOf(60 * KiB), summary }, ip)).status, 429)
    // re-saves of the same size add nothing
    for (let i = 0; i < 4; i++) assert.equal((await gm.save(key, '1234', { bundle: bundleOf(60 * KiB), summary }, ip)).status, 200)
    // growing the copy adds
    assert.equal((await gm.save(key, '1234', { bundle: bundleOf(120 * KiB), summary }, ip)).status, 429)
  })

  it('a day later the network\'s budget is back', async () => {
    let t = Date.parse('2026-11-23T10:00:00Z')
    const gm = createGlobalMatches({ pool, logger: silent, now: () => new Date(t), perNetwork: [{ name: '/64', v6Bits: 64, max: { keys: 1 } }] })
    assert.equal((await gm.save(newKey(), '1234', { bundle: bundleOf(KiB), summary }, { ip: '192.0.2.30' })).status, 200)
    assert.equal((await gm.save(newKey(), '1234', { bundle: bundleOf(KiB), summary }, { ip: '192.0.2.30' })).status, 429)
    t += 24 * 3600 * 1000
    assert.equal((await gm.save(newKey(), '1234', { bundle: bundleOf(KiB), summary }, { ip: '192.0.2.30' })).status, 200)
  })

  it('everyone together: a save is let in while the minute has room and counted as stored; beyond, a retryable 503 OV_BUSY', async () => {
    // GCS-R1 changed this: the minute is counted as Postgres stores what a
    // save wrote (incompressible here), and a save is let in while there is
    // room (it was refused when its raw size would pass the minute)
    let t = Date.parse('2026-11-23T10:00:00Z')
    const gm = createGlobalMatches({ pool, logger: silent, now: () => new Date(t), writtenPerMinute: 200 * KiB, writtenReserveShare: 0 })
    const statuses = []
    for (let i = 0; i < 5; i++) statuses.push((await gm.save(newKey(), '1234', { bundle: randomBundleOf(60 * KiB), summary }, { ip: `192.0.${10 + i}.1` })).status)
    assert.deepEqual(statuses, [200, 200, 200, 200, 503])
    const r = await gm.save(newKey(), '1234', { bundle: randomBundleOf(60 * KiB), summary }, { ip: '192.0.20.1' })
    assert.equal(r.status, 503)
    assert.equal(r.body.error.code, 'OV_BUSY')
    assert.equal(r.body.error.retryable, true)
    assert.ok(r.retryAfter > 0 && r.retryAfter <= 60, String(r.retryAfter))
    t += 60 * 1000
    assert.equal((await gm.save(newKey(), '1234', { bundle: randomBundleOf(60 * KiB), summary }, { ip: '192.0.20.1' })).status, 200)
  })

  it('a normal match under the limits saves as before (defaults: a whole tournament day behind one address)', async () => {
    const gm = createGlobalMatches({ pool, logger: silent })
    const venue = { ip: '198.51.100.99' }
    // 60 matches, each saved 5 times here (about once a minute in a real match), the last with its PDF
    const pdf = minimalPdf({ pad: 50 * KiB }).toString('base64')
    for (let m = 0; m < 60; m++) {
      const key = newKey()
      for (let s = 0; s < 4; s++) assert.equal((await gm.save(key, '4711', { bundle: bundleOf(20 * KiB), summary }, venue)).status, 200)
      assert.equal((await gm.save(key, '4711', { bundle: bundleOf(20 * KiB), summary, pdf }, venue)).status, 200)
    }
    assert.equal(await count(pool), 60)
  })
})
