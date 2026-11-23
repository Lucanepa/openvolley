// The Global store's shares (audit 2026-11-23 SEC-17): one anonymous caller
// filled the whole store (4 GiB) under fresh keys, and every later save got
// 507 OV_GLOBAL_FULL until the junk was 180 days old. Now each network (IPv6
// /64, /56 and /48, an IPv4 address and its /24) has a daily share, and a
// full store evicts the newest keys of the networks that created more than a
// tenth of it, instead of refusing everyone. GCS-R2 (the review of that fix)
// changed the eviction: it chose never-loaded and large keys first, which
// genuine final backups and PDFs are, so a flood of tiny files deleted them.
//   cd escoresheet/backend && node --test tests/globalStore.quota.test.js
import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createGlobalStore, DEFAULTS } from '../lib/globalStore.js'
import { QUOTA_DEFAULTS } from '../lib/globalMatches.js'
import { createNetworkBudget } from '../lib/globalQuota.js'
import { bootServer } from './helpers/e2eServer.js'

const silent = { error() {}, warn() {}, log() {} }
const KiB = 1024
const MiB = 1024 * KiB
const key = () => crypto.randomBytes(16).toString('base64url')
const pdf = (n) => Buffer.concat([Buffer.from('%PDF-1.7\n'), crypto.randomBytes(Math.max(0, n - 9))]).toString('base64')
const plenty = async () => ({ bavail: 1e12, bsize: 1 })
const savePdf = (s, k, n, ip) => s.handle('save', { key: k, kind: 'scoresheet', contentType: 'application/pdf', fileBase64: pdf(n) }, { ip })
const load = (s, k) => s.handle('load', { key: k, kind: 'scoresheet' })

let root
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ov-global-quota-'))
  await fs.writeFile(path.join(root, '.ovdata'), '')
})
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

describe('a network\'s share of the Global store', () => {
  it('defaults: 200 keys and 1 GiB a day per /64, 500 keys and 2 GiB per /56, 1000 keys and 2 GiB per /48 (an IPv4 /24)', () => {
    assert.deepEqual(DEFAULTS.perNetwork.map((l) => [l.name, l.max.keys, l.max.bytes]), [['/64', 200, 1024 * MiB], ['/56', 500, 2048 * MiB], ['/48', 1000, 2048 * MiB]])
    assert.deepEqual(DEFAULTS.perNetwork.map((l) => l.v4Bits), [32, 32, 24])
    // an IPv4 address (a hall behind its NAT) gets its /24's share (SR-4)
    assert.deepEqual(DEFAULTS.perNetwork.map((l) => l.v4Max ? [l.v4Max.keys, l.v4Max.bytes] : null), [[1000, 2048 * MiB], [1000, 2048 * MiB], null])
    assert.equal(DEFAULTS.evictShare, 0.1)
  })

  // 2611 review, SR-4: a one-day Global tournament of 10 courts x 9 matches
  // behind the hall's single IPv4 address got 429 from about match 100 on
  // (and, in the cloud copy, from about match 50): the IPv6 /64 tier's
  // numbers applied to the whole hall. Its final uploads were never retried.
  it('a tournament day of 100 matches behind one IPv4 address fits both stores\' defaults; an IPv6 /64 keeps its smaller share', () => {
    const hallIp = '198.51.100.20'
    const store = createNetworkBudget({ limits: DEFAULTS.perNetwork })
    const cloud = createNetworkBudget({ limits: QUOTA_DEFAULTS.perNetwork })
    for (let m = 0; m < 100; m++) {
      // the store: the final backup and the PDFs of a match, about 10 MB
      assert.equal(store.over(hallIp, { keys: 1, bytes: 10 * MiB }), null, `store, match ${m + 1}`)
      store.charge(hallIp, { keys: 1, bytes: 10 * MiB })
      // the cloud copy: 2-3 MB a match with its PDF
      assert.equal(cloud.over(hallIp, { keys: 1, bytes: 3 * MiB }), null, `cloud copy, match ${m + 1}`)
      cloud.charge(hallIp, { keys: 1, bytes: 3 * MiB })
    }
    // the same from one IPv6 /64 stops at its share, as before
    const v6 = '2001:db8:77:1::5'
    let refused = null
    for (let m = 0; m < 100 && !refused; m++) {
      refused = cloud.over(v6, { keys: 1, bytes: 3 * MiB })
      if (!refused) cloud.charge(v6, { keys: 1, bytes: 3 * MiB })
    }
    assert.equal(refused?.limit, '/64')
    assert.ok(refused.retryMs > 0 && refused.retryMs <= 24 * 3600 * 1000, 'says when that network\'s day ends')
    // an IPv4-mapped IPv6 address is an IPv4 caller too
    assert.equal(cloud.over('::ffff:192.0.2.21', { keys: 1, bytes: 300 * MiB }), null)
    assert.equal(cloud.over('2001:db8:79:1::5', { keys: 1, bytes: 300 * MiB })?.limit, '/64')
  })

  it('a network\'s spent day answers 429 with the time until it ends (Retry-After)', async () => {
    let t = Date.parse('2026-11-23T10:00:00Z')
    const s = createGlobalStore({ root, logger: silent, statfs: plenty, minFreeBytes: 0, reserveBytes: 0, now: () => t,
      perNetwork: [{ name: '/64', v6Bits: 64, max: { keys: 1 }, v4Max: { keys: 2 } }] })
    assert.equal((await savePdf(s, key(), 1000, '203.0.113.60')).status, 200)
    assert.equal((await savePdf(s, key(), 1000, '203.0.113.60')).status, 200, 'an IPv4 address: v4Max')
    t += 3600 * 1000
    const r = await savePdf(s, key(), 1000, '203.0.113.60')
    assert.equal(r.status, 429)
    assert.equal(r.retryAfter, 23 * 3600)
    assert.equal((await savePdf(s, key(), 1000, '2001:db8:78:1::5')).status, 200)
    assert.equal((await savePdf(s, key(), 1000, '2001:db8:78:1::6')).status, 429, 'an IPv6 /64: max')
  })

  it('fresh keys from one address stop at its daily share (429 OV_GLOBAL_QUOTA); another network saves; the next day it is back', async () => {
    let t = Date.parse('2026-11-23T10:00:00Z')
    const s = createGlobalStore({ root, logger: silent, statfs: plenty, minFreeBytes: 0, reserveBytes: 0, now: () => t,
      perNetwork: [{ name: '/64', v6Bits: 64, max: { keys: 3, bytes: 10 * MiB } }] })
    const statuses = []
    for (let i = 0; i < 5; i++) statuses.push((await savePdf(s, key(), 1000, '203.0.113.50')).status)
    assert.deepEqual(statuses, [200, 200, 200, 429, 429])
    const r = await savePdf(s, key(), 1000, '203.0.113.50')
    assert.equal(r.body.error.code, 'OV_GLOBAL_QUOTA')
    assert.equal((await savePdf(s, key(), 1000, '198.51.100.7')).status, 200)
    t += 24 * 3600 * 1000
    assert.equal((await savePdf(s, key(), 1000, '203.0.113.50')).status, 200)
  })

  it('bytes: what a write adds counts (a file that replaces a same-size one adds nothing); every /64 of a /56 shares the /56', async () => {
    const s = createGlobalStore({ root, logger: silent, statfs: plenty, minFreeBytes: 0, reserveBytes: 0,
      perNetwork: [{ name: '/64', v6Bits: 64, max: { bytes: 30 * KiB } }, { name: '/56', v6Bits: 56, max: { bytes: 50 * KiB } }] })
    const k = key()
    const a = '2001:db8:0:101::1'
    assert.equal((await savePdf(s, k, 20 * KiB, a)).status, 200)
    for (let i = 0; i < 5; i++) assert.equal((await savePdf(s, k, 20 * KiB, a)).status, 200, 'the backup a minute replaces itself')
    assert.equal((await savePdf(s, key(), 20 * KiB, a)).status, 429, 'past the /64 share')
    assert.equal((await savePdf(s, key(), 20 * KiB, '2001:db8:0:102::1')).status, 200, 'another /64: 40 KiB in the /56')
    assert.equal((await savePdf(s, key(), 20 * KiB, '2001:db8:0:103::1')).status, 429, 'past the /56 share')
    assert.equal((await savePdf(s, key(), 20 * KiB, '2001:db8:0:200::1')).status, 200, 'another /56')
  })
})

describe('a full Global store makes room instead of refusing everyone', () => {
  // one IPv6 /48 (a tunnel broker's), through its /56s and /64s: one caller
  const in48 = (i) => `2001:db8:66:${(((i >> 4) & 255) << 8 | (i & 15)).toString(16)}::1`
  // a hall: an IPv4 /24 each
  const hall = (i) => `198.${18 + (i >> 8)}.${i & 255}.7`

  it('the audit\'s filler from one /48 takes the store; a victim still saves, and the victim\'s earlier key survives unloaded', async () => {
    // global-store-full.mjs, limits scaled down: 1 MiB store, 3 KiB files
    const alerts = []
    const s = createGlobalStore({ root, logger: silent, statfs: plenty, minFreeBytes: 0, reserveBytes: 0, maxTotalBytes: MiB, maxFileBytes: 12 * 256, onAlert: (m) => alerts.push(m) })
    const victimEarlier = key()
    assert.equal((await savePdf(s, victimEarlier, 800, hall(1))).status, 200)
    let filled = 0
    for (let i = 0; i < 400; i++) {
      const r = await savePdf(s, key(), 12 * 256, in48(i))
      if (r.status !== 200) {
        assert.equal(r.status, 507, `filler save ${i}: ${JSON.stringify(r.body.error)}`)
        continue
      }
      filled++
    }
    assert.ok(filled * 12 * 256 <= MiB + 12 * 256, 'the filler gets no room from itself once over its share')
    const victim = await savePdf(s, key(), 12 * 256, hall(2))
    assert.equal(victim.status, 200, 'not 507: the store evicted the filler\'s newest file')
    assert.equal((await load(s, victimEarlier)).body.data?.contentType, 'application/pdf', 'the never loaded, older key stays')
    const u = await s.usage()
    assert.ok(u.bytes <= MiB, `the cap holds: ${u.bytes}`)
    assert.ok(alerts.some((m) => /over 50% full/.test(m)), 'alerted at half')
    assert.ok(alerts.some((m) => /evicted/.test(m)), 'alerted when it evicted')
    assert.equal(alerts.filter((m) => /evicted/.test(m)).length, 1, 'at most hourly')
  })

  it('the reviewer\'s flood (GCS-R2): 40 genuine final PDFs, never loaded and far larger, survive 700 tiny ones from one /48', async () => {
    // store-evict.mjs: the shipped defaults, maxKeys scaled from 20000 to 600
    const s = createGlobalStore({ root, logger: silent, statfs: plenty, minFreeBytes: 0, reserveBytes: 0, maxKeys: 600 })
    const finalPdf = (k, n, ip) => s.handle('save', { key: k, kind: 'scoresheet-final', contentType: 'application/pdf', fileBase64: pdf(n) }, { ip })
    const genuine = []
    for (let i = 0; i < 40; i++) {
      const k = key()
      assert.equal((await finalPdf(k, 300 * KiB, hall(i))).status, 200)
      genuine.push(k)
    }
    const statuses = {}
    for (let i = 0; i < 700; i++) {
      const r = await finalPdf(key(), 5, `2001:db8:66:${(((i / 400) | 0) << 8 | (i % 200)).toString(16)}::1`)
      statuses[r.status] = (statuses[r.status] || 0) + 1
    }
    assert.equal(statuses[200], 560, JSON.stringify(statuses))
    assert.equal(statuses[507], 140, 'the flood\'s own saves get no room')
    let left = 0
    for (const k of genuine) if ((await s.handle('load', { key: k, kind: 'scoresheet-final' })).body.data) left++
    assert.equal(left, 40)
    // a genuine new key still gets room (from the flood's newest)
    assert.equal((await finalPdf(key(), 300 * KiB, hall(77))).status, 200)
    assert.equal((await s.usage()).keys, 600)
  })

  it('the order: the newest keys of the network over its share, by creation (a re-save does not make a key new); never the key being saved', async () => {
    let t = Date.parse('2026-11-23T10:00:00Z')
    const s = createGlobalStore({ root, logger: silent, statfs: plenty, minFreeBytes: 0, reserveBytes: 0, maxTotalBytes: 20 * KiB, now: () => t })
    const genuine = key()
    await savePdf(s, genuine, 3 * KiB, hall(1))
    const flood = []
    for (let i = 0; i < 5; i++) { const k = key(); await savePdf(s, k, 3 * KiB, in48(i)); flood.push(k); t += 1000 }
    // the flood's first key re-saved (its mtime is now the newest): still its oldest by creation
    await savePdf(s, flood[0], 3 * KiB, in48(9))
    // 18 KiB in all: 6 KiB more evicts two keys, the flood's two newest
    assert.equal((await savePdf(s, key(), 6 * KiB, hall(2))).status, 200)
    for (const k of [flood[3], flood[4]]) assert.equal((await load(s, k)).body.error?.code, 'OV_GLOBAL_NOT_FOUND')
    for (const k of [genuine, flood[0], flood[1], flood[2]]) assert.equal((await load(s, k)).status, 200)
    assert.ok((await s.usage()).bytes <= 20 * KiB)
    // a key of the flood's that grows past the cap: no room from its own network
    assert.equal((await savePdf(s, flood[0], 9 * KiB, in48(9))).status, 507)
    assert.equal((await load(s, flood[0])).status, 200, 'never the key being saved')
  })

  it('no network over its share, or a restart forgot who created what: 507 as before, nothing is deleted', async () => {
    const s = createGlobalStore({ root, logger: silent, statfs: plenty, minFreeBytes: 0, reserveBytes: 0, maxKeys: 30 })
    // 30 halls, one key each (none over a tenth): full
    const keys = []
    for (let i = 0; i < 30; i++) { const k = key(); await savePdf(s, k, 500, hall(i)); keys.push(k) }
    assert.equal((await savePdf(s, key(), 500, hall(40))).status, 507)
    for (const k of keys) assert.equal((await load(s, k)).status, 200)
    // a flood that filled a store before a restart: unknown creators
    await fs.rm(path.join(root, 'global'), { recursive: true, force: true })
    const before = createGlobalStore({ root, logger: silent, statfs: plenty, minFreeBytes: 0, reserveBytes: 0, maxKeys: 30 })
    for (let i = 0; i < 30; i++) assert.equal((await savePdf(before, key(), 500, in48(i))).status, 200)
    const again = createGlobalStore({ root, logger: silent, statfs: plenty, minFreeBytes: 0, reserveBytes: 0, maxKeys: 30 })
    assert.equal((await savePdf(again, key(), 500, hall(41))).status, 507)
    assert.equal((await again.usage()).keys, 30)
  })

  it('the key count too: a store at maxKeys evicts the newest key of the network over its share for another network\'s new key', async () => {
    const s = createGlobalStore({ root, logger: silent, statfs: plenty, minFreeBytes: 0, reserveBytes: 0, maxKeys: 3 })
    const keys = [key(), key(), key()]
    for (const k of keys) await savePdf(s, k, 500, '192.0.2.9')
    assert.equal((await savePdf(s, key(), 500, '192.0.2.10')).status, 507, 'the same /24: no room from itself')
    assert.equal((await savePdf(s, key(), 500, '198.51.100.10')).status, 200)
    assert.equal((await s.usage()).keys, 3)
    assert.equal((await load(s, keys[2])).body.error?.code, 'OV_GLOBAL_NOT_FOUND')
    assert.equal(s.createdBy('192.0.2.200').keys, 2)
  })
})

describe('POST /api/global/save passes the caller\'s address (server.js --local)', () => {
  let srv, sroot
  before(async () => {
    sroot = await fs.mkdtemp(path.join(os.tmpdir(), 'ov-global-quota-e2e-'))
    await fs.writeFile(path.join(sroot, '.ovdata'), '')
    srv = await bootServer({ STORAGE_ROOT: sroot, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128', STORAGE_BACKUP_MIN_FREE_MB: '1', STORAGE_SCORESHEETS_MIN_FREE_MB: '1' }, ['--local'])
  })
  after(async () => { await srv?.stop(); await fs.rm(sroot, { recursive: true, force: true }) })

  it('the 501st new key from one /56 is refused (each of its /64s under the per-minute limit), another /56 saves', async () => {
    const save = (ip) => fetch(`${srv.base}/api/global/save`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify({ key: key(), kind: 'scoresheet', contentType: 'application/pdf', fileBase64: pdf(64) }) })
    // five /64s at once, each one save after the other (one address holds one slot at a time)
    const statuses = await Promise.all(Array.from({ length: 5 }, async (_, n) => {
      const out = []
      for (let i = 0; i < 100; i++) out.push((await save(`2001:db8:5:${n}::1`)).status)
      return out
    }))
    assert.deepEqual([...new Set(statuses.flat())], [200])
    const over = await save('2001:db8:5:9::1')
    assert.equal(over.status, 429)
    assert.equal((await over.json()).error.code, 'OV_GLOBAL_QUOTA')
    // when the /56's day ends (it began with this test's first save), not a flat hour (SR-4)
    const retry = Number(over.headers.get('retry-after'))
    assert.ok(retry > 23 * 3600 && retry <= 24 * 3600, `Retry-After ${retry}`)
    assert.equal((await save('2001:db8:6::1')).status, 200)
  })
})
