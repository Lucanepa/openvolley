/**
 * Sign on phone sessions, the backend's generated copy (lib/signSessions.js,
 * docs/qr-signing-spec.md 8.1): the shared vectors of
 * frontend/electron/__fixtures__/sign-vectors.json (the same file the LAN core
 * and src-tauri/src/sign.rs run), with node:crypto injected as server.js does,
 * the cloud caps, and a double submit.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash, randomBytes } from 'node:crypto'
import * as core from '../lib/signSessions.js'

const require = createRequire(import.meta.url)
const vectors = require('../../frontend/electron/__fixtures__/sign-vectors.json')
const { runSignVectors } = require('../../frontend/electron/__fixtures__/signVectorRunner.cjs')

const sha256 = (t) => createHash('sha256').update(t, 'utf8').digest('hex')
const ctx = { home: 'A', away: 'B' }
const ink = { pad: { w: 4000, h: 2000 }, strokes: [[0, 1000, 300, 1000]] }

describe('lib/signSessions.js', () => {
  it('agrees with every shared vector', async () => {
    assert.deepEqual(await runSignVectors(core, vectors), [])
  })

  it('agrees with them with node:crypto injected, too', async () => {
    const injected = { ...core, createSignSessions: (o) => core.createSignSessions({ ...o, randomBytes, sha256 }) }
    assert.deepEqual(await runSignVectors(injected, vectors), [])
  })

  it('the cloud caps', () => {
    const s = core.createSignSessions({ via: 'cloud', log: () => {} })
    assert.deepEqual(s.caps, { total: 2000, perOwner: 20, startPerOwner: 30, phonePerIp: 120, waiters: 1000 })
  })

  it('a double submit: exactly one wins', () => {
    const s = core.createSignSessions({ via: 'cloud', randomBytes, sha256, log: () => {} })
    const { token } = s.start({ slot: 'captain-a', context: ctx }, { owner: 'u1' }).body
    const answers = [s.submit({ k: token, ...ink }, { ipKey: 'a' }), s.submit({ k: token, ...ink }, { ipKey: 'b' })]
    assert.deepEqual(answers.map((r) => r.status).sort(), [200, 409])
    assert.equal(answers.find((r) => r.status === 409).body.code, 'OV_SIGN_USED')
    s.dispose()
  })

  it('logs one value-free line per transition', async () => {
    const lines = []
    const s = core.createSignSessions({ via: 'cloud', log: (l) => lines.push(l) })
    const r = s.start({ slot: 'scorer', context: { ...ctx, name: 'Lea Muster' } }, { owner: 'u1' }).body
    s.open({ k: r.token }, { ipKey: 'a' })
    s.submit({ k: r.token, ...ink }, { ipKey: 'a' })
    s.close({ watch: r.watch })
    assert.deepEqual(lines.map((l) => l.split(' ')[0]), ['sign.start', 'sign.open', 'sign.submit', 'sign.close'])
    for (const l of lines) {
      assert.match(l, /^sign\.\w+ ref=[0-9a-f]{8} slot=scorer via=cloud$/)
      assert.ok(!l.includes(r.token) && !l.includes(r.watch) && !l.includes('Lea'))
    }
    s.dispose()
  })
})
