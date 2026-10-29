/**
 * POST /api/contact through server.js (--local, no database) WITHOUT any mail
 * settings, so nothing can be mailed: the route reads the multipart body and
 * answers what lib/contact.js decides (503 for a valid message, as no mail is
 * configured), the 413 of a too large body, the honeypot, CORS for the
 * openvolley.app support page, the per-IP limit and the 10 requests at
 * once (an 11th is busy; every way a request ends frees its slot). The mail itself:
 * tests/contact.test.js. Each case comes from its own client address
 * (cf-connecting-ip, trusted from loopback only), so the 3-per-minute limit
 * applies per case.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { bootServer } from './helpers/e2eServer.js'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('test')])
let ipSeq = 10
const nextIp = () => `198.51.100.${ipSeq++}`
// the requests-at-once case: many clients, each its own address
let ipSeq2 = 1
const nextIp2 = () => `203.0.113.${ipSeq2++}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function form(entries) {
  const fd = new FormData()
  for (const [name, value, filename] of entries) {
    if (Buffer.isBuffer(value)) fd.append(name, new Blob([value]), filename)
    else fd.append(name, value)
  }
  return fd
}

const VALID = [
  ['contactType', 'support'], ['area', 'connections'], ['supportType', 'help'], ['email', 'tester@example.ch'],
  ['comments', 'The referee tablet does not find the match.'], ['source', 'website'], ['language', 'en']
]

describe('POST /api/contact (server.js, no mail configured)', () => {
  let srv
  before(async () => {
    // Blank mail settings: the route can never reach an SMTP server here
    srv = await bootServer({
      SMTP_HOST: '', SMTP_PASS: '', SMTP_USER: '', MAIL_FROM: '', SMTP_LEGACY_ROUTES: '', RESEND_API_KEY: '',
      TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128'
    }, ['--local'])
  })
  after(async () => { await srv?.stop() })

  const post = async (body, { ip = nextIp(), headers = {} } = {}) => {
    const res = await fetch(`${srv.base}/api/contact`, { method: 'POST', body, headers: { 'cf-connecting-ip': ip, ...headers } })
    return { status: res.status, json: await res.json().catch(() => null), headers: res.headers }
  }

  it('reads a valid message with an attachment, and says 503 (no mail configured) instead of pretending', async () => {
    const r = await post(form([...VALID, ['files', PNG, 'shot.png']]), { headers: { Origin: 'https://openvolley.app' } })
    assert.equal(r.status, 503)
    assert.deepEqual(r.json, { success: false, code: 'unavailable', error: 'The support form is not available right now' })
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://openvolley.app', 'the support page may read the answer')
  })

  it('refuses a bad address, a file type, too many files', async () => {
    const bad = await post(form(VALID.map(([k, v]) => [k, k === 'email' ? 'x@y.ch\r\nBcc: z@example.org' : v])))
    assert.deepEqual([bad.status, bad.json.code], [400, 'invalid_email'])
    const exe = await post(form([...VALID, ['files', Buffer.from('MZ\x90\x00', 'latin1'), 'setup.exe']]))
    assert.deepEqual([exe.status, exe.json.code, exe.json.file], [415, 'file_type', 'setup.exe'])
    const six = await post(form([...VALID, ...Array.from({ length: 6 }, (_, i) => ['files', PNG, `${i}.png`])]))
    assert.deepEqual([six.status, six.json.code], [400, 'too_many_files'])
  })

  it('a filled honeypot: 200, as for a person', async () => {
    const r = await post(form([...VALID, ['website', 'https://spam.example']]))
    assert.deepEqual([r.status, r.json], [200, { success: true }])
  })

  it('attachments over 10 MB: 413 files_too_large', async () => {
    const r = await post(form([...VALID, ['files', Buffer.alloc(10.5 * 1024 * 1024, 0x41), 'big.txt']]))
    assert.equal(r.status, 413)
    assert.equal(r.json.code, 'files_too_large')
  })

  it('a body declared over 11 MB: 413 before it is read, the connection closed', async () => {
    // node:http, not fetch: only the headers go out, the answer comes before
    // any of the body (which is then never sent)
    const r = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no answer to the oversized body')), 10000)
      const out = request(`${srv.base}/api/contact`, {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': 11 * 1024 * 1024 + 1, 'cf-connecting-ip': nextIp() }
      }, (res) => {
        let text = ''
        res.on('data', (d) => { text += d })
        res.on('end', () => {
          clearTimeout(timer)
          resolve({ status: res.statusCode, connection: res.headers.connection, json: JSON.parse(text) })
          out.destroy()
        })
      })
      out.on('error', (err) => { if (!['EPIPE', 'ECONNRESET'].includes(err.code)) reject(err) })
      out.flushHeaders()
    })
    assert.deepEqual([r.status, r.json.code, r.connection], [413, 'files_too_large', 'close'])
  })

  it('3 per minute per client, then 429', async () => {
    const ip = nextIp()
    for (let i = 0; i < 3; i++) assert.equal((await post(form(VALID), { ip })).status, 503)
    const r = await post(form(VALID), { ip })
    assert.equal(r.status, 429)
    assert.equal(r.headers.get('retry-after'), '60')
  })

  it('10 requests at once: the 11th gets 503 busy at once; each way a request ends frees its slot', async () => {
    const boundary = 'ov-slot-test'
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="contactType"\r\n\r\nsupport\r\n`)
    /** A request whose body never finishes (a phone uploading on hall Wi-Fi): it holds its slot. */
    const hanging = () => {
      const state = { answered: null, error: null }
      const req = request(`${srv.base}/api/contact`, {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': 64 * 1024, 'cf-connecting-ip': nextIp2() }
      }, (res) => {
        state.answered = res.statusCode
        res.resume()
      })
      req.on('error', (err) => { state.error = err.code })
      req.write(head)
      state.req = req
      return state
    }
    const postFrom = (ip, body, headers = {}) => post(body, { ip, headers })

    // 1. Twelve requests that end every way but by a timeout (30 s): none
    // may keep its slot, or the ten below would not all get one
    const valid = form(VALID)
    for (let i = 0; i < 3; i++) assert.equal((await postFrom(nextIp2(), valid)).json.code, 'unavailable', 'no mail configured')
    for (let i = 0; i < 2; i++) assert.equal((await postFrom(nextIp2(), form(VALID.map(([k, v]) => [k, k === 'email' ? 'nope' : v])))).json.code, 'invalid_email')
    for (let i = 0; i < 2; i++) assert.deepEqual((await postFrom(nextIp2(), form([...VALID, ['website', 'x']]))).json, { success: true })
    for (let i = 0; i < 2; i++) assert.equal((await postFrom(nextIp2(), 'not json', { 'content-type': 'application/json' })).json.code, 'invalid_body')
    for (let i = 0; i < 3; i++) {
      const gone = hanging()
      await sleep(50)
      gone.req.destroy() // the client went away mid-body
    }
    await sleep(200)

    // 2. Ten uploads at once: each holds a slot, none is answered
    const ten = Array.from({ length: 10 }, () => hanging())
    await sleep(300)
    assert.deepEqual(ten.map((h) => h.answered), Array(10).fill(null), 'all ten are being received')

    // 3. The eleventh: the hourly cap's 503 busy, at once; its body (here
    // 2 MB) is read and thrown away, so the client gets the answer
    const busy = await postFrom(nextIp2(), form([...VALID, ['files', Buffer.alloc(2 * 1024 * 1024, 0x41), 'log.txt']]))
    assert.equal(busy.status, 503)
    assert.deepEqual(busy.json, { success: false, code: 'busy', error: 'Too many messages right now. Please try again later' })
    assert.match(srv.output.join(''), /\[Contact\] 10 messages already being received: busy/)

    // 4. The ten clients go away: their slots are freed, all ten
    for (const h of ten) h.req.destroy()
    await sleep(200)
    const again = Array.from({ length: 10 }, () => hanging())
    await sleep(300)
    assert.deepEqual(again.map((h) => h.answered), Array(10).fill(null), 'ten slots again')
    assert.equal((await postFrom(nextIp2(), valid)).json.code, 'busy')
    for (const h of again) h.req.destroy()
    await sleep(200)
    assert.equal((await postFrom(nextIp2(), valid)).json.code, 'unavailable', 'free again')
  })

  it('logs no full address', () => {
    const out = srv.output.join('')
    assert.match(out, /\[Contact\] support\/connections P3 from te\*\*\*@example\.ch \(website, 1 attachment\(s\)\) not mailed: support mail is off/)
    assert.doesNotMatch(out, /tester@example\.ch/)
  })
})
