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
let root
const make = async (limits = {}, { sentinel = true } = {}) => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ov-global-'))
  if (sentinel) await fs.writeFile(path.join(root, '.ovdata'), '')
}

describe('globalStore', () => {
  beforeEach(() => make())

  it('saves and loads a backup and replaces it', async () => {
    const s = createGlobalStore({ root, logger: silent })
    const r = await s.handle('save', { key: KEY, kind: 'backup', contentType: 'application/json', fileBase64: b64('{"a":1}') })
    assert.equal(r.status, 200)
    const l = await s.handle('load', { key: KEY, kind: 'backup' })
    assert.equal(Buffer.from(l.body.data.fileBase64, 'base64').toString(), '{"a":1}')
    const r2 = await s.handle('save', { key: KEY, kind: 'backup', contentType: 'application/json', fileBase64: b64('{"a":2}') })
    assert.equal(r2.body.data.replaced, true)
    assert.equal(Buffer.from((await s.handle('load', { key: KEY, kind: 'backup' })).body.data.fileBase64, 'base64').toString(), '{"a":2}')
  })

  it('stores a PDF scoresheet, refuses a fake one', async () => {
    const s = createGlobalStore({ root, logger: silent })
    assert.equal((await s.handle('save', { key: KEY, kind: 'scoresheet-final', contentType: 'application/pdf', fileBase64: pdf })).status, 200)
    assert.equal((await s.handle('save', { key: KEY, kind: 'scoresheet', contentType: 'application/pdf', fileBase64: b64('hello') })).status, 415)
    assert.equal((await s.handle('save', { key: KEY, kind: 'scoresheet', contentType: 'text/html', fileBase64: pdf })).status, 415)
  })

  it('refuses bad keys, kinds, base64 and non-JSON backups', async () => {
    const s = createGlobalStore({ root, logger: silent })
    const ok = { kind: 'backup', contentType: 'application/json', fileBase64: b64('{}') }
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
    await s.handle('save', { key: KEY, kind: 'backup', contentType: 'application/json', fileBase64: b64('{}') })
    const other = await s.handle('load', { key: 'ZyXwVuTsRqPoNmLkJiHgFe', kind: 'backup' })
    assert.equal(other.status, 200)
    assert.equal(other.body.error.code, 'OV_GLOBAL_NOT_FOUND')
  })

  it('enforces the size caps', async () => {
    const s = createGlobalStore({ root, logger: silent, maxFileBytes: 100, maxBytesPerKey: 150, maxKeys: 1 })
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
    assert.equal((await s.handle('save', { key: KEY, kind: 'backup', contentType: 'application/json', fileBase64: b64('{}') })).status, 503)
  })

  it('sweeps keys untouched for the retention time', async () => {
    let t = Date.now()
    const s = createGlobalStore({ root, logger: silent, now: () => t, retentionDays: 10 })
    await s.handle('save', { key: KEY, kind: 'backup', contentType: 'application/json', fileBase64: b64('{}') })
    assert.equal(await s.sweep(), 0)
    t += 11 * 86400_000
    assert.equal(await s.sweep(), 1)
    assert.equal((await s.handle('load', { key: KEY, kind: 'backup' })).body.error.code, 'OV_GLOBAL_NOT_FOUND')
  })
})
