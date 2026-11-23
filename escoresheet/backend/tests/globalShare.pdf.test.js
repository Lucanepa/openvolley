// The PDFs the Global cloud's share link and organizer list hand out (audit
// 2026-11-23 PERM-15): only a complete PDF is stored (a "%PDF" prefix with a
// web page after it made the server an anonymous host of anything), it counts
// in the copy's size (db/053 stored_bytes), and it is served as a download
// with nosniff and a sandbox CSP, never inline.
// The HTTP part needs PG_TEST_URL (tests/helpers/pgTestDb.js) or OV_E2E_DOCKER=1.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { isPdfFile, decodePdf, createGlobalMatches, PDF_MAX_BYTES, PDF_MIN_BYTES } from '../lib/globalMatches.js'
import { SKIP, bootServer, api, provisionDatabase } from './helpers/e2eServer.js'
import { minimalPdf } from './helpers/pdfFixture.js'

const KEY = crypto.randomBytes(16).toString('base64url')
const html = Buffer.from(`%PDF-1.4\n<html><body><script>alert(document.domain)</script>${'x'.repeat(2000)}</body></html>\n`)

describe('isPdfFile: header, trailer, size', () => {
  it('takes a complete PDF (the jsPDF shape), with or without a newline at its end', () => {
    assert.equal(isPdfFile(minimalPdf()), true)
    assert.equal(isPdfFile(Buffer.from(minimalPdf().toString('latin1').trimEnd(), 'latin1')), true)
    assert.equal(isPdfFile(Buffer.concat([minimalPdf(), Buffer.from('\r\n  \n')])), true)
    assert.equal(isPdfFile(minimalPdf({ version: '2.0' })), true)
  })
  it('refuses a page behind a %PDF prefix, a cut-off file, a skeleton and anything too large', () => {
    assert.equal(isPdfFile(html), false, 'no trailer')
    const full = minimalPdf()
    assert.equal(isPdfFile(full.subarray(0, full.length - 10)), false, 'cut off before %%EOF')
    assert.equal(isPdfFile(Buffer.from(full.toString('latin1').replace('startxref', 'startxyz'), 'latin1')), false, 'no startxref')
    assert.equal(isPdfFile(Buffer.concat([full, Buffer.from('<script>1</script>')])), false, 'something after %%EOF')
    assert.equal(isPdfFile(Buffer.from('%PDF-1.7\nstartxref\n0\n%%EOF\n')), false, `under ${PDF_MIN_BYTES} bytes`)
    assert.equal(isPdfFile(Buffer.from(`%PDX-1.7\n${full.toString('latin1').slice(9)}`, 'latin1')), false, 'no header')
    assert.equal(isPdfFile(minimalPdf({ pad: PDF_MAX_BYTES })), false, 'too large')
    assert.equal(isPdfFile('not a buffer'), false)
  })
  it('decodePdf and save refuse a fake PDF before the database (400 Invalid PDF)', async () => {
    assert.equal(decodePdf(html.toString('base64')), false)
    assert.ok(Buffer.isBuffer(decodePdf(minimalPdf().toString('base64'))))
    const gm = createGlobalMatches({ pool: { query: async () => { throw new Error('no query expected') } } })
    const r = await gm.save(KEY, '1234', { bundle: {}, pdf: html.toString('base64') })
    assert.equal(r.status, 400)
    assert.equal(r.body.error.message, 'Invalid PDF')
  })
})

describe('share link and organizer PDFs over HTTP', { skip: SKIP }, () => {
  let db, srv
  const ip = { 'cf-connecting-ip': '203.0.113.80' }
  const post = (action, body) => api(srv.base, `/api/global/cloud/${action}`, { body, headers: ip, proto: null })
  before(async () => {
    db = await provisionDatabase()
    srv = await bootServer({ DATABASE_URL: db.appUrl(), TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' })
  })
  after(async () => { await srv?.stop(); await db?.drop() })

  it('a fake PDF is refused; a real one is served as an attachment with nosniff and a sandbox CSP', async () => {
    const fake = await post('save', { key: KEY, pin: '1234', bundle: { match: { id: 1 } }, summary: {}, organizer: 'ABCDEFGHJK', pdf: html.toString('base64') })
    assert.equal(fake.status, 400, fake.text)
    const pdf = minimalPdf({ pad: 4000 })
    const saved = await post('save', { key: KEY, pin: '1234', bundle: { match: { id: 1 } }, summary: {}, organizer: 'ABCDEFGHJK', pdf: pdf.toString('base64') })
    assert.equal(saved.status, 200, saved.text)
    const share = await post('share', { key: KEY, pin: '1234', on: true })
    const token = share.json.data.shareToken
    const res = await fetch(`${srv.base}/api/global/shared/${token}/pdf`, { headers: ip })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/pdf')
    assert.match(res.headers.get('content-disposition'), /^attachment; filename="scoresheet\.pdf"$/)
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.match(res.headers.get('content-security-policy'), /^sandbox; default-src 'none'$/)
    assert.equal(res.headers.get('access-control-allow-origin'), '*', 'the livescore page still links it')
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), pdf)
    const list = await fetch(`${srv.base}/api/global/organizer/ABCDEFGHJK`, { headers: ip }).then((r) => r.json())
    const one = await fetch(`${srv.base}/api/global/organizer/ABCDEFGHJK/${list.data.matches[0].id}/pdf`, { headers: ip })
    assert.equal(one.status, 200)
    assert.match(one.headers.get('content-disposition'), /^attachment;/)
    assert.match(one.headers.get('content-security-policy'), /sandbox/)
    await one.arrayBuffer()
  })
})
