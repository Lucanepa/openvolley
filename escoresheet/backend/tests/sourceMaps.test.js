/**
 * Readable stack frames (lib/sourceMaps.js): the mappings are scanned, not
 * decoded whole; only the app's own sites are asked; a missing map is
 * remembered; the digest mail shows the readable frame (lib/errorAlerts.js).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { originalPosition, parseFrame, hostFor, cleanSource, createSourceMaps } from '../lib/sourceMaps.js'
import { renderDigest } from '../lib/errorAlerts.js'

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function vlq(n) {
  let v = n < 0 ? (-n << 1) | 1 : n << 1
  let out = ''
  do {
    let digit = v & 31
    v >>>= 5
    if (v > 0) digit |= 32
    out += B64[digit]
  } while (v > 0)
  return out
}
/** lines: [[ [genCol, src, srcLine, srcCol, name?], ... ], ...] with absolute values; encoded relative. */
function mappingsOf(lines) {
  let src = 0
  let srcLine = 0
  let srcCol = 0
  let name = 0
  return lines.map((segs) => {
    let genCol = 0
    return segs.map((s) => {
      const parts = [vlq(s[0] - genCol), vlq(s[1] - src), vlq(s[2] - srcLine), vlq(s[3] - srcCol)]
      genCol = s[0]; src = s[1]; srcLine = s[2]; srcCol = s[3]
      if (s.length === 5) { parts.push(vlq(s[4] - name)); name = s[4] }
      return parts.join('')
    }).join(',')
  }).join(';')
}

const MAP = {
  version: 3,
  sources: ['../../src/components/Scoreboard.jsx', '../../node_modules/react-dom/cjs/react-dom.production.js'],
  names: ['onPoint', 'commitRoot'],
  mappings: mappingsOf([
    [[0, 0, 9, 4, 0], [100, 1, 0, 0, 1], [200, 0, 40, 2]],
    [[5, 0, 20, 2]]
  ]),
  sourcesContent: ['x'.repeat(1000), 'y'.repeat(1000)]
}

describe('source maps: one position', () => {
  it('finds the segment at or before the column, on the right line', () => {
    assert.deepEqual(originalPosition(MAP, 1, 50), { source: 'src/components/Scoreboard.jsx', line: 10, column: 5, name: 'onPoint' })
    assert.deepEqual(originalPosition(MAP, 1, 150), { source: 'node_modules/react-dom/cjs/react-dom.production.js', line: 1, column: 1, name: 'commitRoot' })
    assert.deepEqual(originalPosition(MAP, 1, 250), { source: 'src/components/Scoreboard.jsx', line: 41, column: 3, name: null })
    assert.deepEqual(originalPosition(MAP, 2, 10), { source: 'src/components/Scoreboard.jsx', line: 21, column: 3, name: null })
    assert.equal(originalPosition(MAP, 2, 1), null, 'before the first segment of the line')
    assert.equal(originalPosition(MAP, 9, 1), null, 'no such line')
    assert.equal(originalPosition({ mappings: 'A!A' }, 1, 1), null, 'garbage')
  })

  it('reads frames of every engine and cleans sources', () => {
    assert.deepEqual(parseFrame('onPoint@/assets/_build_app-V03cqV1j.js:1:23456'), { fn: 'onPoint', path: '/assets/_build_app-V03cqV1j.js', line: 1, col: 23456 })
    assert.deepEqual(parseFrame('onPoint (/assets/x.js:3:4)'), { fn: 'onPoint', path: '/assets/x.js', line: 3, col: 4 })
    assert.deepEqual(parseFrame('/assets/x.js:3:4'), { fn: null, path: '/assets/x.js', line: 3, col: 4 })
    assert.equal(parseFrame('eval (eval at evaluate (:311:30), <anonymous>:1:32)'), null)
    assert.equal(cleanSource('webpack:///../../src/a.jsx'), 'src/a.jsx')
  })

  it('asks only the app\'s own sites', () => {
    assert.equal(hostFor('openvolley', 'scorer'), 'app.openvolley.app')
    assert.equal(hostFor('openvolley', 'manager'), 'manager.openvolley.app')
    assert.equal(hostFor('openbeach', 'manager'), 'manager-beach.openvolley.app')
    assert.equal(hostFor('openbeach', 'referee'), 'beach.openvolley.app')
    assert.equal(hostFor('openvolley', 'tv'), null)
    assert.equal(hostFor('openvolley', 'server'), null)
  })
})

describe('source maps: fetching', () => {
  const quiet = { warn() {} }
  const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) })

  it('fetches a map once, keeps it without sourcesContent, and maps the frames', async () => {
    const urls = []
    const sm = createSourceMaps({ log: quiet, fetchImpl: async (u) => { urls.push(u); return ok(MAP) } })
    const out = await sm.symbolicate(['onPoint@/assets/_build_app-X.js:1:51', 'x (/assets/_build_app-X.js:2:11)', 'not a frame'], { product: 'openvolley', tool: 'scorer' })
    assert.deepEqual(out, ['src/components/Scoreboard.jsx:10:5 (onPoint)', 'src/components/Scoreboard.jsx:21:3 (x)', null])
    assert.deepEqual(urls, ['https://app.openvolley.app/assets/_build_app-X.js.map'])
  })

  it('remembers a missing map, refuses a too big one, and never asks for the TV page or the server', async () => {
    let calls = 0
    const sm = createSourceMaps({ log: quiet, maxBytes: 100, fetchImpl: async (u) => { calls++; return u.includes('big') ? ok(MAP) : { ok: false, status: 404, headers: { get: () => null } } } })
    assert.deepEqual(await sm.symbolicate(['a@/assets/gone.js:1:1'], { product: 'openvolley', tool: 'referee' }), [null])
    assert.deepEqual(await sm.symbolicate(['a@/assets/gone.js:1:1'], { product: 'openvolley', tool: 'referee' }), [null])
    assert.equal(calls, 1, 'the missing map is not asked for again at once')
    assert.deepEqual(await sm.symbolicate(['a@/assets/big.js:1:1'], { product: 'openvolley', tool: 'referee' }), [null])
    const before = calls
    assert.deepEqual(await sm.symbolicate(['a@/assets/x.js:1:1'], { product: 'openvolley', tool: 'tv' }), [null])
    assert.equal(calls, before)
  })
})

describe('the digest mail shows the readable frame', () => {
  it('uses frames_source where there is one', () => {
    const d = renderDigest([{
      group: { id: '00000000-0000-4000-8000-000000000001', product: 'openvolley', source: 'client', kind: 'js.error', title: 'TypeError: x', last_alert_at: null },
      reason: 'new', since: new Date().toISOString(), count: 1, tools: ['scorer'], versions: ['3.5.0'], devices: 1, accounts: 0, guests: 1, duringMatch: false, members: [],
      last: { tool: 'scorer', frames: ['onPoint@/assets/_build_app-X.js:1:51', 'b@/assets/v.js:1:1'], frames_source: ['src/components/Scoreboard.jsx:10:5 (onPoint)', null], at: new Date().toISOString() }
    }], { managerUrl: 'https://manager.example' })
    assert.match(d.text, /src\/components\/Scoreboard\.jsx:10:5 \(onPoint\)/)
    assert.match(d.text, /b@\/assets\/v\.js:1:1/)
  })
})
