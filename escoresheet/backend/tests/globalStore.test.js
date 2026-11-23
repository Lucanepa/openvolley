// Tests for lib/globalStore.js (the Global tool's anonymous backup/scoresheet store).
//   cd escoresheet/backend && node --test tests/globalStore.test.js
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createGlobalStore } from '../lib/globalStore.js'

const silent = { error() {}, warn() {}, log() {} }
const KEY = 'AbCdEfGhIjKlMnOpQrStUv' // 22 chars
const b64 = (s) => Buffer.from(s).toString('base64')
const pdf = b64('%PDF-1.4 test')
// a backup as the app writes it (frontend utils/backupCrypto/envelope.js): the
// store keeps nothing else under kind 'backup'
const sealed = (n = 1) => JSON.stringify({ format: 'openvolley-encrypted-backup', formatVersion: 2, about: 'x', readable: { gameN: null, homeTeam: 'A', awayTeam: 'B', sets: [] }, cipher: { alg: 'AES-256-GCM', iv: 'AAAA' }, slots: [{ kind: 'pin', pin: 'referee', iv: 'AAAA', wrappedKey: 'AAAA' }], ciphertext: 'QUJD'.repeat(n) })
const sealedB64 = (n) => b64(sealed(n))
let root
const make = async (limits = {}, { sentinel = true } = {}) => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ov-global-'))
  if (sentinel) await fs.writeFile(path.join(root, '.ovdata'), '')
}

describe('globalStore', () => {
  beforeEach(() => make())

  it('saves and loads a backup and replaces it', async () => {
    const s = createGlobalStore({ root, logger: silent })
    const r = await s.handle('save', { key: KEY, kind: 'backup', contentType: 'application/json', fileBase64: sealedB64(1) })
    assert.equal(r.status, 200)
    const l = await s.handle('load', { key: KEY, kind: 'backup' })
    assert.equal(Buffer.from(l.body.data.fileBase64, 'base64').toString(), sealed(1))
    const r2 = await s.handle('save', { key: KEY, kind: 'backup', contentType: 'application/json', fileBase64: sealedB64(2) })
    assert.equal(r2.body.data.replaced, true)
    assert.equal(Buffer.from((await s.handle('load', { key: KEY, kind: 'backup' })).body.data.fileBase64, 'base64').toString(), sealed(2))
  })

  it('stores a PDF scoresheet, refuses a fake one', async () => {
    const s = createGlobalStore({ root, logger: silent })
    assert.equal((await s.handle('save', { key: KEY, kind: 'scoresheet-final', contentType: 'application/pdf', fileBase64: pdf })).status, 200)
    assert.equal((await s.handle('save', { key: KEY, kind: 'scoresheet', contentType: 'application/pdf', fileBase64: b64('hello') })).status, 415)
    assert.equal((await s.handle('save', { key: KEY, kind: 'scoresheet', contentType: 'text/html', fileBase64: pdf })).status, 415)
  })

  it('refuses bad keys, kinds, base64 and non-JSON backups', async () => {
    const s = createGlobalStore({ root, logger: silent })
    const ok = { kind: 'backup', contentType: 'application/json', fileBase64: sealedB64() }
    for (const key of ['short', '../../etc/passwd/xxxxxxxxxx', KEY + '/x', 123, undefined]) {
      assert.equal((await s.handle('save', { ...ok, key })).status, 400)
      assert.equal((await s.handle('load', { key, kind: 'backup' })).status, 400)
    }
    assert.equal((await s.handle('save', { ...ok, key: KEY, kind: '../x' })).status, 400)
    assert.equal((await s.handle('save', { ...ok, key: KEY, fileBase64: '***' })).status, 400)
    assert.equal((await s.handle('save', { ...ok, key: KEY, fileBase64: b64('not json') })).status, 400)
    assert.equal((await s.handle('nope', {})).status, 404)
  })

  it('a missing file is a normal answer, a wrong key reads nothing', async () => {
    const s = createGlobalStore({ root, logger: silent })
    await s.handle('save', { key: KEY, kind: 'backup', contentType: 'application/json', fileBase64: sealedB64() })
    const other = await s.handle('load', { key: 'ZyXwVuTsRqPoNmLkJiHgFe', kind: 'backup' })
    assert.equal(other.status, 200)
    assert.equal(other.body.error.code, 'OV_GLOBAL_NOT_FOUND')
  })

  it('enforces the size caps', async () => {
    // maxEvictPerSave 0: the cap itself (a full store evicts since 2026-11-23, SEC-17: globalStore.quota.test.js)
    const s = createGlobalStore({ root, logger: silent, maxFileBytes: 100, maxBytesPerKey: 150, maxKeys: 1, maxEvictPerSave: 0 })
    const big = b64('{"x":"' + 'a'.repeat(200) + '"}')
    assert.equal((await s.handle('save', { key: KEY, kind: 'backup', contentType: 'application/json', fileBase64: big })).status, 413)
    const f = (n) => b64('%PDF-' + 'a'.repeat(n))
    assert.equal((await s.handle('save', { key: KEY, kind: 'scoresheet', contentType: 'application/pdf', fileBase64: f(90) })).status, 200)
    assert.equal((await s.handle('save', { key: KEY, kind: 'scoresheet-final', contentType: 'application/pdf', fileBase64: f(90) })).status, 413)
    // a second key is refused when the store holds maxKeys
    assert.equal((await s.handle('save', { key: 'ZyXwVuTsRqPoNmLkJiHgFe', kind: 'scoresheet', contentType: 'application/pdf', fileBase64: f(10) })).status, 507)
  })

  it('refuses writes without the sentinel (volume not mounted)', async () => {
    await make({}, { sentinel: false })
    const s = createGlobalStore({ root, logger: silent })
    assert.equal((await s.handle('save', { key: KEY, kind: 'backup', contentType: 'application/json', fileBase64: sealedB64() })).status, 503)
  })

  it('keeps the volume above its free-space floor (the room the league\'s backups share)', async () => {
    let free = 10_000
    const statfs = async () => ({ bavail: free, bsize: 1 })
    const s = createGlobalStore({ root, logger: silent, statfs, minFreeBytes: 9_000, reserveBytes: 0 })
    const save = () => s.handle('save', { key: KEY, kind: 'backup', contentType: 'application/json', fileBase64: sealedB64() })
    assert.equal((await save()).status, 200)
    free = 9_000 + Buffer.byteLength(sealed()) - 1 // one byte short of the floor
    const r = await save()
    assert.equal(r.status, 507)
    assert.equal(r.body.error.code, 'OV_GLOBAL_FULL')
    const broken = createGlobalStore({ root, logger: silent, statfs: async () => { throw new Error('EIO') } })
    assert.equal((await broken.handle('save', { key: KEY, kind: 'backup', contentType: 'application/json', fileBase64: sealedB64() })).status, 503)
    // nothing left behind in the temp folder
    assert.deepEqual(await fs.readdir(path.join(root, '.tmp')), [])
  })

  it('sweeps keys untouched for the retention time', async () => {
    let t = Date.now()
    const s = createGlobalStore({ root, logger: silent, now: () => t, retentionDays: 10 })
    await s.handle('save', { key: KEY, kind: 'backup', contentType: 'application/json', fileBase64: sealedB64() })
    assert.equal(await s.sweep(), 0)
    t += 11 * 86400_000
    assert.equal(await s.sweep(), 1)
    assert.equal((await s.handle('load', { key: KEY, kind: 'backup' })).body.error.code, 'OV_GLOBAL_NOT_FOUND')
  })
  // Audit of the Global surfaces (2026-11-14)
  it('keeps only an encrypted backup: plain match JSON (names, birth dates) is refused', async () => {
    const s = createGlobalStore({ root, logger: silent })
    const save = (text) => s.handle('save', { key: KEY, kind: 'backup', contentType: 'application/json', fileBase64: b64(text) })
    const plain = JSON.stringify({ version: 1, match: { id: 1 }, homeTeam: { name: 'A' }, players: [{ firstName: 'Ann', dob: '2012-01-01' }] })
    for (const text of [
      plain, '{}', '[]', '"x"', 'null',
      JSON.stringify({ ...JSON.parse(sealed()), players: [{ firstName: 'Ann' }] }), // a plain field beside the envelope
      JSON.stringify({ ...JSON.parse(sealed()), slots: [] }),
      JSON.stringify({ ...JSON.parse(sealed()), ciphertext: '' }),
      JSON.stringify({ ...JSON.parse(sealed()), ciphertext: 'not base64!' }),
      JSON.stringify({ ...JSON.parse(sealed()), format: 'other' })
    ]) {
      const r = await save(text)
      assert.equal(r.status, 400, text)
      assert.equal(r.body.error.code, 'OV_GLOBAL_NOT_SEALED', text)
    }
    assert.equal((await save(sealed())).status, 200)
  })

  it('refuses kinds that are Object.prototype names', async () => {
    const s = createGlobalStore({ root, logger: silent })
    for (const kind of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      assert.equal((await s.handle('save', { key: KEY, kind, contentType: 'application/pdf', fileBase64: pdf })).status, 400, kind)
      assert.equal((await s.handle('load', { key: KEY, kind })).status, 400, kind)
    }
  })

  it('keeps the total cap when keys that exist grow (not only for new keys)', async () => {
    // maxEvictPerSave 0: the cap itself, without the eviction of a full store (SEC-17, globalStore.quota.test.js)
    const s = createGlobalStore({ root, logger: silent, maxFileBytes: 1000, maxBytesPerKey: 1000, maxTotalBytes: 400, maxKeys: 100, maxEvictPerSave: 0 })
    const f = (n) => b64('%PDF-' + 'a'.repeat(n - 5))
    const K2 = 'ZyXwVuTsRqPoNmLkJiHgFe'
    const save = (key, n) => s.handle('save', { key, kind: 'scoresheet', contentType: 'application/pdf', fileBase64: f(n) })
    assert.equal((await save(KEY, 10)).status, 200)
    assert.equal((await save(K2, 10)).status, 200)
    assert.equal((await save(KEY, 250)).status, 200) // 260 in all
    const r = await save(K2, 250) // would be 500
    assert.equal(r.status, 507)
    assert.equal(r.body.error.code, 'OV_GLOBAL_FULL')
    assert.equal((await save(K2, 100)).status, 200) // 350: fits
    assert.deepEqual({ keys: (await s.usage()).keys, bytes: (await s.usage()).bytes }, { keys: 2, bytes: 350 })
    assert.equal((await save(KEY, 10)).status, 200) // a smaller file gives the room back
    assert.equal((await s.usage()).bytes, 110)
  })

  it('stops a reserve above the volume\'s floor, so the league\'s backups (same floor) keep room', async () => {
    let free = 10_000
    const statfs = async () => ({ bavail: free, bsize: 1 })
    const s = createGlobalStore({ root, logger: silent, statfs, minFreeBytes: 5_000, reserveBytes: 4_000 })
    const save = () => s.handle('save', { key: KEY, kind: 'scoresheet', contentType: 'application/pdf', fileBase64: pdf })
    assert.equal((await save()).status, 200)
    free = 9_005 // above the floor (5000), inside the reserve
    assert.equal((await save()).status, 507)
  })

  it('deletes expired keys also when nothing is saved any more (a load, or the timer, sweeps)', async () => {
    let t = Date.now()
    const s = createGlobalStore({ root, logger: silent, now: () => t, retentionDays: 10, sweepEveryMs: 1000 })
    await s.handle('save', { key: KEY, kind: 'backup', contentType: 'application/json', fileBase64: sealedB64() })
    t += 11 * 86400_000
    // only loads from here on
    await s.handle('load', { key: 'ZyXwVuTsRqPoNmLkJiHgFe', kind: 'backup' })
    for (let i = 0; i < 50 && (await fs.readdir(path.join(root, 'global', KEY.slice(0, 2))).catch(() => [])).length; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal((await s.handle('load', { key: KEY, kind: 'backup' })).body.error?.code, 'OV_GLOBAL_NOT_FOUND')
    // maybeSweep (server.js runs it on a timer): at most every sweepEveryMs
    await s.handle('save', { key: KEY, kind: 'backup', contentType: 'application/json', fileBase64: sealedB64() })
    t += 11 * 86400_000
    assert.equal(await s.maybeSweep(), 1)
    assert.equal(await s.maybeSweep(), null) // too soon
  })
})
