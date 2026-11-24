/**
 * lib/vectorPdf.js: the backend's client of the render service (field-spec
 * 17.20). Off without its settings; one request at a time; every failure an
 * answer, never a throw.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createVectorPdf } from '../lib/vectorPdf.js'
import { setsMatchClose } from '../lib/scoresheets.js'

const TOKEN = 't'.repeat(32)
const PDF = Buffer.from('%PDF-1.4\n% vector\n%%EOF\n')
const quiet = { error () {}, warn () {} }
const record = { match: { id: 'm' }, sets: [], events: [] }
const pdfResponse = (headers = {}) => new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf', 'x-ov-filename': encodeURIComponent('game1_X_2026-11-15.pdf'), ...headers } })

describe('vectorPdf', () => {
  it('is off without a URL or a token of 24+ characters, and says so', async () => {
    for (const o of [{}, { url: 'http://r:8090' }, { url: 'http://r:8090', token: 'short' }, { token: TOKEN }]) {
      const v = createVectorPdf({ ...o, fetchImpl: () => assert.fail('no request when off'), logger: quiet })
      assert.equal(v.enabled, false)
      const r = await v.render({ record })
      assert.deepEqual([r.ok, r.status, r.code], [false, 503, 'OV_RENDER_UNAVAILABLE'])
    }
  })

  it('posts the record with the shared token and returns the PDF and its name', async () => {
    const calls = []
    const v = createVectorPdf({
      url: 'http://ov-render:8090/', token: TOKEN, logger: quiet,
      fetchImpl: async (url, init) => { calls.push({ url, init }); return pdfResponse() }
    })
    const r = await v.render({ record, rebuildReason: 'Times corrected', rebuiltAt: '2026-11-16T13:03:00Z' })
    assert.equal(r.ok, true)
    assert.ok(r.pdf.equals(PDF))
    assert.equal(r.filename, 'game1_X_2026-11-15.pdf')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'http://ov-render:8090/render')
    assert.equal(calls[0].init.headers['x-ov-render-token'], TOKEN)
    assert.deepEqual(JSON.parse(calls[0].init.body), { record, rebuildReason: 'Times corrected', rebuiltAt: '2026-11-16T13:03:00Z' })
  })

  it('one request at a time; past the waiting limit it answers busy at once', async () => {
    let running = 0
    let peak = 0
    const release = []
    const v = createVectorPdf({
      url: 'http://r:8090', token: TOKEN, maxWaiting: 2, logger: quiet,
      fetchImpl: () => new Promise((resolve) => {
        running++
        peak = Math.max(peak, running)
        release.push(() => { running--; resolve(pdfResponse()) })
      })
    })
    const a = v.render({ record })
    const b = v.render({ record })
    const c = await v.render({ record })
    assert.deepEqual([c.ok, c.status, c.code], [false, 503, 'OV_RENDER_BUSY'])
    while (release.length < 1) await new Promise((r) => setTimeout(r, 5))
    release.shift()()
    while (release.length < 1) await new Promise((r) => setTimeout(r, 5))
    release.shift()()
    assert.equal((await a).ok, true)
    assert.equal((await b).ok, true)
    assert.equal(peak, 1)
  })

  it('a refusal, an unreachable service, a timeout or a non-PDF answer is an answer, not a throw', async () => {
    const cases = [
      [async () => new Response(JSON.stringify({ code: 'OV_RENDER_SHEET', error: 'x' }), { status: 422 }), 422, 'OV_RENDER_SHEET'],
      [async () => new Response(JSON.stringify({ code: 'OV_RENDER_BUSY' }), { status: 503 }), 503, 'OV_RENDER_BUSY'],
      [async () => { throw new TypeError('fetch failed') }, 503, 'OV_RENDER_UNREACHABLE'],
      [async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }) }, 504, 'OV_RENDER_TIMEOUT'],
      [async () => new Response('<html>', { status: 200 }), 503, 'OV_RENDER_FAILED']
    ]
    for (const [fetchImpl, status, code] of cases) {
      const r = await createVectorPdf({ url: 'http://r', token: TOKEN, fetchImpl, logger: quiet }).render({ record })
      assert.deepEqual([r.ok, r.status, r.code], [false, status, code])
    }
  })

  it('setsMatchClose: every finished set ends on the score of its last point and of the close; no finished set, no copy', () => {
    const ev = (set, seq, home, away) => ({ set_index: set, seq, type: 'point', payload: { score: { home, away } } })
    const sets = [{ index: 1, finished: true, home_points: 25, away_points: 20 }]
    // the result the close wrote (owner decision 3: the full check, tests/scoresheets.vectorGate.e2e.test.js)
    const match = { set_results: [{ set: 1, home: 25, away: 20 }], final_score: '1-0', winner: 'home' }
    assert.equal(setsMatchClose({ match, sets, events: [ev(1, 1, 1, 0), ev(1, 50, 25, 20)] }), true)
    // the device's last points still on their way
    assert.equal(setsMatchClose({ match, sets, events: [ev(1, 1, 1, 0), ev(1, 40, 24, 20)] }), false)
    // (before LOG-09 a record without the close's result passed)
    assert.equal(setsMatchClose({ sets, events: [ev(1, 1, 1, 0), ev(1, 50, 25, 20)] }), false)
    assert.equal(setsMatchClose({ match, sets: [{ index: 1, finished: false }], events: [] }), false)
    assert.equal(setsMatchClose({ match, sets: [], events: [] }), false)
  })

  it('the render service\'s count of missing pictures comes back with the PDF', async () => {
    const v = (headers) => createVectorPdf({ url: 'http://r', token: TOKEN, logger: quiet, fetchImpl: async () => pdfResponse(headers) })
    assert.equal((await v({ 'x-ov-missing-pictures': '2' }).render({ record })).missingPictures, 2)
    assert.equal((await v({ 'x-ov-missing-pictures': '0' }).render({ record })).missingPictures, 0)
    // an older service without the header
    assert.equal((await v({}).render({ record })).missingPictures, 0)
  })
})
