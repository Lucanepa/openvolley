// The Global store's shares (audit 2026-11-23 SEC-17): one anonymous caller
// filled the whole store (4 GiB) under fresh keys, and every later save got
// 507 OV_GLOBAL_FULL until the junk was 180 days old. Now each network (IPv6
// /64 and /56, an IPv4 address) has a daily share, and a full store evicts
// (never loaded, largest, newest first) instead of refusing everyone.
//   cd escoresheet/backend && node --test tests/globalStore.quota.test.js
import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createGlobalStore, DEFAULTS } from '../lib/globalStore.js'
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
  it('defaults: 200 keys and 1 GiB a day per /64, 500 keys and 2 GiB per /56', () => {
    assert.deepEqual(DEFAULTS.perNetwork.map((l) => [l.name, l.max.keys, l.max.bytes]), [['/64', 200, 1024 * MiB], ['/56', 500, 2048 * MiB]])
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
  it('the audit\'s filler (many networks) takes the store; a victim still saves, and the victim\'s earlier key survives', async () => {
    // global-store-full.mjs, limits scaled down: 1 MiB store, 3 KiB files
    const alerts = []
    const s = createGlobalStore({ root, logger: silent, statfs: plenty, minFreeBytes: 0, reserveBytes: 0, maxTotalBytes: MiB, maxFileBytes: 12 * 256, onAlert: (m) => alerts.push(m) })
    const victimEarlier = key()
    assert.equal((await savePdf(s, victimEarlier, 800, '198.51.100.20')).status, 200)
    assert.equal((await load(s, victimEarlier)).status, 200) // opened on another tablet: loaded
    let filled = 0
    for (let i = 0; i < 400; i++) {
      const r = await savePdf(s, key(), 12 * 256, `2001:db8:${i.toString(16)}::1`)
      assert.equal(r.status, 200, `filler save ${i}: ${JSON.stringify(r.body.error)}`)
      filled++
    }
    assert.ok(filled * 12 * 256 > MiB, 'the filler wrote more than the store holds')
    const victim = await savePdf(s, key(), 1000, '198.51.100.21')
    assert.equal(victim.status, 200, 'not 507: the store evicted the filler\'s files')
    assert.equal((await load(s, victimEarlier)).body.data?.contentType, 'application/pdf', 'the loaded, small, older key stays')
    const u = await s.usage()
    assert.ok(u.bytes <= MiB, `the cap holds: ${u.bytes}`)
    assert.ok(alerts.some((m) => /over 50% full/.test(m)), 'alerted at half')
    assert.ok(alerts.some((m) => /evicted/.test(m)), 'alerted when it evicted')
    assert.equal(alerts.filter((m) => /evicted/.test(m)).length, 1, 'at most hourly')
  })

  it('the order: never loaded before loaded, then the largest, then the newest; never the key being saved', async () => {
    let t = Date.parse('2026-11-23T10:00:00Z')
    const s = createGlobalStore({ root, logger: silent, statfs: plenty, minFreeBytes: 0, reserveBytes: 0, maxTotalBytes: 10 * KiB, now: () => t })
    const big = key(); const small = key(); const loadedBig = key(); const newer = key()
    await savePdf(s, loadedBig, 3 * KiB, '192.0.2.1')
    await load(s, loadedBig)
    await savePdf(s, big, 3 * KiB, '192.0.2.2')
    await savePdf(s, small, 1 * KiB, '192.0.2.3')
    await savePdf(s, newer, 2 * KiB, '192.0.2.4') // 9 KiB in all
    // 3 KiB more: the largest never-loaded key goes (big), nothing else
    assert.equal((await savePdf(s, key(), 3 * KiB, '192.0.2.5')).status, 200)
    assert.equal((await load(s, big)).body.error?.code, 'OV_GLOBAL_NOT_FOUND')
    for (const k of [small, loadedBig, newer]) assert.equal((await load(s, k)).status, 200)
    // a key that grows past the cap: the others make room, never itself
    const r = await savePdf(s, loadedBig, 9 * KiB, '192.0.2.1')
    assert.equal(r.status, 200)
    assert.equal((await load(s, loadedBig)).status, 200)
    assert.ok((await s.usage()).bytes <= 10 * KiB)
  })

  it('the key count too: a store at maxKeys evicts one for a new key', async () => {
    const s = createGlobalStore({ root, logger: silent, statfs: plenty, minFreeBytes: 0, reserveBytes: 0, maxKeys: 3 })
    const keys = [key(), key(), key()]
    for (const k of keys) await savePdf(s, k, 500, '192.0.2.9')
    assert.equal((await savePdf(s, key(), 500, '192.0.2.10')).status, 200)
    assert.equal((await s.usage()).keys, 3)
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
    assert.equal(over.headers.get('retry-after'), '3600')
    assert.equal((await save('2001:db8:6::1')).status, 200)
  })
})
