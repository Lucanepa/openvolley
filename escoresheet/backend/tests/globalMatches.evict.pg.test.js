// A full Global cloud table (GCS-R4, the review of the SEC-01 fix): the
// network budgets had IPv6 /64 and /56 tiers only, so one /48 (256 /56s) was
// let in the whole row ceiling in a day, and a full table refused every new
// copy for 180 days, with no way to clear the junk. Now an IPv6 /48 and an
// IPv4 /24 have budgets of their own; a full table evicts the newest copies
// of the networks that created more than a tenth of it (never anyone else's);
// what a network grows above the ceiling is its own headroom; and
// scripts/global-cloud-purge.mjs removes the copies of a creation window.
// Needs PG_TEST_URL (tests/helpers/pgTestDb.js); the /48 budget test does not.
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { SKIP_PG, createTestDatabase } from './helpers/pgTestDb.js'
import { createGlobalMatches, keyHash, QUOTA_DEFAULTS } from '../lib/globalMatches.js'
import { createNetworkBudget } from '../lib/globalQuota.js'

const silent = { error() {}, warn() {}, log() {} }
const KiB = 1024
const MiB = 1024 * KiB
const newKey = () => crypto.randomBytes(16).toString('base64url')
const summary = { home: { name: 'Bergtal IS' }, away: { name: 'Seeblick IS' }, status: 'final' }
const bundleOf = (n) => ({ version: 1, match: { id: 1 }, events: [{ note: 'x'.repeat(Math.max(0, n - 60)) }] })
// one IPv6 /48 (a tunnel broker's): its /56s are 2001:db8:66:XX00::/56
const in48 = (i) => ({ ip: `2001:db8:66:${(((i >> 3) & 255) << 8 | (i & 7)).toString(16)}::1` })
const hall = (i) => ({ ip: `198.${18 + (i >> 8)}.${i & 255}.7` }) // a hall: an IPv4 /24 each
const exec = promisify(execFile)
const PURGE = fileURLToPath(new URL('../scripts/global-cloud-purge.mjs', import.meta.url))

describe('the network tiers (GCS-R4)', () => {
  it('one IPv6 /48 is let in at most its own daily copies, not the whole row ceiling (the reviewer\'s sim)', () => {
    const b = createNetworkBudget({ limits: QUOTA_DEFAULTS.perNetwork })
    let admitted = 0
    for (let s56 = 0; s56 < 256; s56++) {
      for (let s64 = 0; s64 < 256; s64++) {
        const ip = `2001:db8:66:${((s56 << 8) | s64).toString(16)}::1`
        if (b.over(ip, { keys: 1, bytes: 1024 })) continue
        b.charge(ip, { keys: 1, bytes: 1024 })
        admitted++
      }
    }
    const per48 = QUOTA_DEFAULTS.perNetwork.find((l) => l.name === '/48').max.keys
    assert.equal(admitted, per48)
    assert.ok(per48 * 20 <= QUOTA_DEFAULTS.maxRows, 'a /48 needs weeks for the ceiling')
    // an IPv4 /24: 256 addresses share it
    let v4 = 0
    for (let a = 0; a < 256; a++) for (let n = 0; n < 50; n++) {
      const ip = `203.0.113.${a}`
      if (b.over(ip, { keys: 1 })) break
      b.charge(ip, { keys: 1 })
      v4++
    }
    assert.equal(v4, per48)
  })
})

describe('Global cloud: a full table (GCS-R4)', { skip: SKIP_PG }, () => {
  let tdb, pool, owner, appUrl
  before(async () => {
    tdb = await createTestDatabase('gcs_evict')
    appUrl = await tdb.createAppRole()
    pool = new pg.Pool({ connectionString: appUrl })
    owner = new pg.Client({ connectionString: tdb.url })
    await owner.connect()
  })
  after(async () => { await owner?.end(); await pool?.end(); await tdb?.drop() })
  beforeEach(async () => { await owner.query('DELETE FROM public.global_matches') })
  const exists = async (key) => (await owner.query('SELECT 1 FROM public.global_matches WHERE key_hash = $1', [keyHash(key)])).rowCount === 1
  const rows = async () => (await owner.query('SELECT count(*)::int AS n FROM public.global_matches')).rows[0].n

  it('a flood from one /48 fills the table: a hall\'s new copy evicts the flood\'s newest, the flood\'s own gets 507, no genuine copy goes', async () => {
    const alerts = []
    const gm = createGlobalMatches({ pool, logger: silent, maxRows: 40, onAlert: (m) => alerts.push(m) })
    // 10 finished matches of 10 halls, each a larger copy than the flood's, never loaded again
    const genuine = []
    for (let i = 0; i < 10; i++) {
      const key = newKey()
      assert.equal((await gm.save(key, '4711', { bundle: bundleOf(40 * KiB), summary }, hall(i))).status, 200)
      genuine.push(key)
    }
    // the flood: tiny copies under fresh keys from one /48, until the table is full
    const flood = []
    for (let i = 0; i < 60; i++) {
      const key = newKey()
      const r = await gm.save(key, '1111', { bundle: {}, summary: {} }, in48(i))
      if (r.status !== 200) {
        assert.equal(r.status, 507)
        assert.equal(r.body.error.code, 'OV_GLOBAL_FULL')
        break
      }
      flood.push(key)
    }
    assert.equal(flood.length, 30, 'the flood filled the 30 rows left')
    assert.equal(await rows(), 40)
    // a new tournament's first copy: room is made from the flood's newest copy
    const fresh = newKey()
    assert.equal((await gm.save(fresh, '4711', { bundle: bundleOf(40 * KiB), summary }, hall(20))).status, 200)
    assert.equal(await rows(), 40)
    assert.equal(await exists(flood.at(-1)), false, 'the newest flood copy made the room')
    assert.ok(alerts.some((m) => /evicted/.test(m)), alerts.join('\n'))
    // the flood itself gets no room from anyone
    assert.equal((await gm.save(newKey(), '1111', { bundle: {}, summary: {} }, in48(99))).status, 507)
    for (const key of [...genuine, fresh]) assert.equal(await exists(key), true)
    // ten more halls: each takes a flood copy's place
    for (let i = 30; i < 40; i++) assert.equal((await gm.save(newKey(), '4711', { bundle: bundleOf(2 * KiB), summary }, hall(i))).status, 200)
    for (const key of genuine) assert.equal(await exists(key), true)
    assert.deepEqual(gm.createdBy(in48(0).ip).rows, 19)
  })

  it('the byte ceiling too: the network holding the most bytes over its share gives room, newest first', async () => {
    const gm = createGlobalMatches({ pool, logger: silent, maxTotalBytes: 400 * KiB, maxRows: 1000 })
    const genuine = []
    for (let i = 0; i < 4; i++) {
      const key = newKey()
      assert.equal((await gm.save(key, '4711', { bundle: bundleOf(30 * KiB), summary }, hall(i))).status, 200)
      genuine.push(key)
    }
    const flood = []
    for (let i = 0; i < 20; i++) {
      const key = newKey()
      if ((await gm.save(key, '1111', { bundle: bundleOf(60 * KiB), summary: {} }, in48(i))).status !== 200) break
      flood.push(key)
    }
    assert.equal(flood.length, 4)
    // 360 KiB stored: a 60 KiB copy does not fit without room made
    assert.equal((await gm.save(newKey(), '4711', { bundle: bundleOf(60 * KiB), summary }, hall(9))).status, 200)
    assert.equal(await exists(flood.at(-1)), false)
    for (const key of genuine) assert.equal(await exists(key), true)
  })

  it('no network over its share (or a restart forgot who created what): 507 as before, nothing evicted; the purge script clears a creation window', async () => {
    const first = createGlobalMatches({ pool, logger: silent, maxRows: 30 })
    const genuine = []
    for (let i = 0; i < 5; i++) {
      const key = newKey()
      await first.save(key, '4711', { bundle: bundleOf(KiB), summary }, hall(i))
      genuine.push(key)
    }
    await owner.query("UPDATE public.global_matches SET created_at = now() - interval '3 days'")
    for (let i = 0; i < 25; i++) assert.equal((await first.save(newKey(), '1111', { bundle: {}, summary: {} }, in48(i))).status, 200)
    // a new process: it does not know who created the junk
    const gm = createGlobalMatches({ pool, logger: silent, maxRows: 30 })
    assert.equal((await gm.save(newKey(), '4711', { bundle: bundleOf(KiB), summary }, hall(50))).status, 507)
    assert.equal(await rows(), 30, 'nothing evicted')
    // the operator: count first, then remove the window the flood came in
    const from = new Date(Date.now() - 3600_000).toISOString()
    const to = new Date(Date.now() + 60_000).toISOString()
    const env = { ...process.env, DATABASE_URL: appUrl }
    const dry = JSON.parse((await exec(process.execPath, [PURGE, '--from', from, '--to', to, '--no-pdf', '--max-kb', '4'], { env })).stdout)
    assert.equal(dry.matched, 25)
    assert.equal(dry.deleted, 0)
    assert.equal(await rows(), 30)
    const done = JSON.parse((await exec(process.execPath, [PURGE, '--from', from, '--to', to, '--no-pdf', '--max-kb', '4', '--delete'], { env })).stdout)
    assert.equal(done.deleted, 25)
    for (const key of genuine) assert.equal(await exists(key), true, 'outside the window: kept')
    const again = createGlobalMatches({ pool, logger: silent, maxRows: 30 })
    assert.equal((await again.save(newKey(), '4711', { bundle: bundleOf(KiB), summary }, hall(50))).status, 200)
    // bad arguments: exit 2, nothing done
    await assert.rejects(exec(process.execPath, [PURGE, '--from', to, '--to', from], { env }), (e) => e.code === 2)
  })

  it('above the ceiling each network grows its copies by its own headroom only; another network\'s match in progress still grows', async () => {
    const gm = createGlobalMatches({
      pool, logger: silent, maxTotalBytes: 100 * KiB, growHeadroom: 1,
      perNetwork: [{ name: '/48', v6Bits: 48, v4Bits: 24, max: { keys: 1000, bytes: 100 * MiB, headroom: 20 * KiB } }]
    })
    const a = newKey()
    const b = newKey()
    assert.equal((await gm.save(a, '1111', { bundle: bundleOf(45 * KiB), summary }, in48(0))).status, 200)
    assert.equal((await gm.save(b, '4711', { bundle: bundleOf(45 * KiB), summary }, hall(0))).status, 200)
    // the table is near its ceiling: growing passes it
    assert.equal((await gm.save(a, '1111', { bundle: bundleOf(60 * KiB), summary }, in48(1))).status, 200)
    const r = await gm.save(a, '1111', { bundle: bundleOf(75 * KiB), summary }, in48(2))
    assert.equal(r.status, 507, 'the /48\'s headroom is spent')
    assert.equal(r.body.error.code, 'OV_GLOBAL_FULL')
    assert.equal((await gm.save(b, '4711', { bundle: bundleOf(60 * KiB), summary }, hall(0))).status, 200, 'the hall\'s own headroom')
  })
})
