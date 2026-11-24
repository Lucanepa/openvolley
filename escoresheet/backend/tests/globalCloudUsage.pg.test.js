/**
 * scripts/global-cloud-usage.mjs (2611 review, GLOBAL-CLOUD-WRITE-BUDGET-SIZING):
 * the operator's read-only estimate of what a Global cloud copy costs the
 * write budget everyone shares, to size OV_GLOBAL_CLOUD_WRITE_MB_DAY before a
 * deploy. Against Postgres as ov_app, with copies saved through
 * lib/globalMatches.js; the estimate's constants follow the module's.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import { SKIP_PG, createTestDatabase } from './helpers/pgTestDb.js'
import { createGlobalMatches, QUOTA_DEFAULTS, WAL_ROW_BYTES as MODULE_WAL_ROW_BYTES } from '../lib/globalMatches.js'
import { parseArgs, usage, WAL_ROW_BYTES, NET_SHARE } from '../scripts/global-cloud-usage.mjs'

const silent = { log() {}, warn() {}, error() {} }
const newKey = () => crypto.randomBytes(16).toString('base64url')
const summary = { home: { name: 'A' }, away: { name: 'B' }, status: 'live' }
const bundleOf = (n) => ({ version: 1, match: { id: 1 }, events: [{ note: 'x'.repeat(n) }] })
const pdfOf = (n) => Buffer.concat([Buffer.from('%PDF-1.7\n'), crypto.randomBytes(n), Buffer.from('\nstartxref\n0\n%%EOF\n')]).toString('base64')

describe('global-cloud-usage.mjs: arguments', () => {
  it('defaults to 30 days and the budget of OV_GLOBAL_CLOUD_WRITE_MB_DAY (1024 without it); refuses nonsense', () => {
    assert.deepEqual(parseArgs([], {}), { days: 30, writeMbDay: 1024, help: false })
    assert.equal(parseArgs([], { OV_GLOBAL_CLOUD_WRITE_MB_DAY: '2048' }).writeMbDay, 2048)
    assert.deepEqual(parseArgs(['--days', '7', '--write-mb-day', '512'], {}), { days: 7, writeMbDay: 512, help: false })
    assert.throws(() => parseArgs(['--days', '0'], {}), /--days/)
    assert.throws(() => parseArgs(['--write-mb-day', '-1'], {}), /--write-mb-day/)
    assert.throws(() => parseArgs(['--delete'], {}), /unknown argument/)
  })

  it('its constants are the server\'s', () => {
    assert.equal(WAL_ROW_BYTES, MODULE_WAL_ROW_BYTES)
    assert.equal(NET_SHARE, QUOTA_DEFAULTS.writtenNetShare)
  })
})

describe('global-cloud-usage.mjs against Postgres', { skip: SKIP_PG }, () => {
  let tdb, pool
  before(async () => {
    tdb = await createTestDatabase('globalusage')
    pool = new pg.Pool({ connectionString: await tdb.createAppRole(), max: 3 })
    pool.on('error', () => {})
  })
  after(async () => { await pool?.end(); await tdb?.drop() })

  it('counts the copies, their stored size and saves, and estimates a match\'s charge and the matches a budget serves', async () => {
    const gm = createGlobalMatches({ pool, logger: silent })
    const ip = { ip: '198.51.100.30' }
    for (let m = 0; m < 3; m++) {
      const key = newKey()
      for (let s = 0; s < 4; s++) assert.equal((await gm.save(key, '4321', { bundle: bundleOf(2000 + s), summary }, ip)).status, 200)
      // the final save with its PDF
      assert.equal((await gm.save(key, '4321', { bundle: bundleOf(2100), summary: { ...summary, status: 'final' }, pdf: pdfOf(4096) }, ip)).status, 200)
    }
    const r = await usage(pool, { days: 30, writeMbDay: 1024 })
    assert.deepEqual(r.copies, { total: 3, withPdf: 3, withOrganizer: 0 })
    assert.ok(r.row.avgBytes > 0 && r.row.p95Bytes >= r.row.avgBytes * 0.5)
    assert.ok(r.row.pdfAvgBytes >= 4096)
    // Postgres's counters may lag a moment; at least the inserts are known once flushed
    if (r.saves.inserts > 0) {
      assert.ok(r.saves.perCopy >= 1)
      assert.ok(r.perMatch.bytes >= r.row.avgBytes + WAL_ROW_BYTES)
      assert.equal(r.budget.matchesPerDay, Math.floor(1024 * 1024 * 1024 / r.perMatch.bytes))
      assert.equal(r.budget.matchesPerDayPerNetwork, Math.floor(1024 * 1024 * 1024 * NET_SHARE / r.perMatch.bytes))
      assert.ok(r.budget.suggestedWriteMbDay >= 1024)
    }
    assert.equal(r.days.busiest, 3)
    assert.equal(r.days.window, 30)
    assert.equal(JSON.stringify(r).includes('4321'), false, 'never a PIN')
  })
})
