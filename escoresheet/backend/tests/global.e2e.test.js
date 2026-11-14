/**
 * POST /api/global/{save,load} through server.js (--local, no database): the
 * Global tool's anonymous backup and scoresheet store (lib/globalStore.js).
 * Anonymous: no Authorization header anywhere. Own storage root per run.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { bootServer } from './helpers/e2eServer.js'

const KEY = 'AbCdEfGhIjKlMnOpQrStUv'
const b64 = (s) => Buffer.from(s).toString('base64')
let srv
let root
let ipSeq = 1
const post = async (action, body, ip = `198.51.100.${ipSeq++}`) => {
  const res = await fetch(`${srv.base}/api/global/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => null), headers: res.headers }
}

describe('POST /api/global/* (server.js --local)', () => {
  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ov-global-e2e-'))
    await fs.writeFile(path.join(root, '.ovdata'), '')
    srv = await bootServer({ STORAGE_ROOT: root, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' }, ['--local'])
  })
  after(async () => { await srv?.stop(); await fs.rm(root, { recursive: true, force: true }) })

  it('saves and loads a backup with no account', async () => {
    const s = await post('save', { key: KEY, kind: 'backup', contentType: 'application/json', fileBase64: b64('{"match":1}') })
    assert.equal(s.status, 200)
    assert.equal(s.headers.get('cache-control'), 'no-store')
    const l = await post('load', { key: KEY, kind: 'backup' })
    assert.equal(Buffer.from(l.json.data.fileBase64, 'base64').toString(), '{"match":1}')
  })

  it('stores a PDF, refuses other types and bad keys', async () => {
    assert.equal((await post('save', { key: KEY, kind: 'scoresheet-final', contentType: 'application/pdf', fileBase64: b64('%PDF-1.4 x') })).status, 200)
    assert.equal((await post('save', { key: KEY, kind: 'scoresheet', contentType: 'application/pdf', fileBase64: b64('<html>') })).status, 415)
    assert.equal((await post('save', { key: '../../x', kind: 'backup', contentType: 'application/json', fileBase64: b64('{}') })).status, 400)
  })

  it('answers GET with 405, an unknown action with 404, and a missing file with 200 not-found', async () => {
    const g = await fetch(`${srv.base}/api/global/load`)
    assert.equal(g.status, 405)
    assert.equal((await post('list', {})).status, 404)
    const m = await post('load', { key: 'ZyXwVuTsRqPoNmLkJiHgFe', kind: 'backup' })
    assert.equal(m.status, 200)
    assert.equal(m.json.error.code, 'OV_GLOBAL_NOT_FOUND')
  })

  it('limits requests per IP', async () => {
    const ip = '203.0.113.77'
    let last
    for (let i = 0; i < 125; i++) last = await post('load', { key: KEY, kind: 'backup' }, ip)
    assert.equal(last.status, 429)
  })
})
