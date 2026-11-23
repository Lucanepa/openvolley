// SEC-61: the cloud answered plain http (ports 80 and 8080 through
// Cloudflare: http://backend.openvolley.app/... 200), so a typed or scanned
// http:// link carried tokens, PINs and relay frames in the clear. A page or
// an address opened in the browser whose cf-visitor (Cloudflare: the
// visitor's scheme) is http now goes to https.
//
// The API calls and CORS preflights of older apps are answered as before
// (fix-up of the review): a 3.x app set to http://backend.openvolley.app
// (ServerConnectionScreen gave a bare address http:// before 13.11.2026)
// sends a preflight, which fails on any redirect, and a call that follows a
// redirect to https arrives with Origin: null, which the origin rule does not
// trust. They are counted in the ops log instead, and so are ws:// upgrades,
// still accepted. The health checks, a request without cf-visitor (local
// callers, the tunnel's own checks) and a venue server answer as before.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { bootServer, openSocket, waitUntil } from './helpers/e2eServer.js'

/** A raw request with the headers as given (fetch cannot set Host). */
function request(srv, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, method, path, headers }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (d) => { text += d })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

const HTTP_VISITOR = { host: 'backend.openvolley.app', 'cf-visitor': '{"scheme":"http"}' }
// The Android app's page (Capacitor androidScheme https): a trusted origin
const APP_ORIGIN = 'https://localhost'

const isRedirect = (status) => status === 301 || status === 308

describe('cloud over plain http: pages go to https, older apps keep their API (SEC-61)', () => {
  let cloud
  let venue
  before(async () => {
    cloud = await bootServer({ IS_CLOUD: '1' }, ['--local'])
    venue = await bootServer({}, ['--local'])
  })
  after(async () => {
    await cloud?.stop()
    await venue?.stop()
  })

  it('a page over http: 301 to the same address on https', async () => {
    const page = await request(cloud, { path: '/', headers: HTTP_VISITOR })
    assert.equal(page.status, 301)
    assert.equal(page.headers.location, 'https://backend.openvolley.app/')
    const tv = await request(cloud, { path: '/tv?code=ABC123', headers: { ...HTTP_VISITOR, host: 'backend.openvolley.app:8080' } })
    assert.equal(tv.status, 301)
    assert.equal(tv.headers.location, 'https://backend.openvolley.app/tv?code=ABC123')
    const sign = await request(cloud, { path: '/sign/x', headers: HTTP_VISITOR })
    assert.equal(sign.status, 301)
    assert.equal(sign.headers.location, 'https://backend.openvolley.app/sign/x')
  })

  it('an API address opened in the browser (Sec-Fetch-Mode: navigate) goes to https too', async () => {
    const r = await request(cloud, { path: '/api/match/list?x=1', headers: { ...HTTP_VISITOR, 'sec-fetch-mode': 'navigate' } })
    assert.equal(r.status, 301)
    assert.equal(r.headers.location, 'https://backend.openvolley.app/api/match/list?x=1')
    assert.ok(!r.text.includes('matches'))
    // a form posted as a page: 308 keeps its method
    const post = await request(cloud, { method: 'POST', path: '/api/contact', headers: { ...HTTP_VISITOR, 'sec-fetch-mode': 'navigate', 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=b' })
    assert.equal(post.status, 308)
    assert.equal(post.headers.location, 'https://backend.openvolley.app/api/contact')
  })

  it('an older app\'s CORS preflight over http: 200 with its CORS answer, never a redirect', async () => {
    const r = await request(cloud, {
      method: 'OPTIONS',
      path: '/api/match/validate-pin',
      headers: { ...HTTP_VISITOR, origin: APP_ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' }
    })
    assert.equal(r.status, 200)
    assert.equal(r.headers['access-control-allow-origin'], APP_ORIGIN)
    assert.equal(r.headers['access-control-allow-credentials'], 'true')
    assert.match(r.headers['access-control-allow-methods'], /POST/)
    assert.equal(r.headers.location, undefined)
  })

  it('an older app\'s API calls over http are answered with its CORS answer (read, PIN read, write)', async () => {
    const status = await request(cloud, { path: '/api/server/status', headers: { ...HTTP_VISITOR, origin: APP_ORIGIN } })
    assert.equal(status.status, 200)
    assert.equal(status.headers['access-control-allow-origin'], APP_ORIGIN)
    assert.equal(JSON.parse(status.text).status, 'online')

    const match = await request(cloud, { path: '/api/match/some-match', headers: { ...HTTP_VISITOR, origin: APP_ORIGIN, 'x-ov-match-pin': '123456' } })
    assert.ok(!isRedirect(match.status), `GET /api/match/:id: ${match.status}`)
    assert.equal(match.headers['access-control-allow-origin'], APP_ORIGIN)

    const pin = await request(cloud, {
      method: 'POST',
      path: '/api/match/validate-pin',
      headers: { ...HTTP_VISITOR, origin: APP_ORIGIN, 'content-type': 'application/json' },
      body: '{"pin":"123456","type":"referee"}'
    })
    assert.ok(!isRedirect(pin.status), `POST /api/match/validate-pin: ${pin.status}`)
    assert.equal(pin.headers['access-control-allow-origin'], APP_ORIGIN)
    assert.equal(typeof JSON.parse(pin.text).success, 'boolean')

    // a native client or script (no Origin) too
    const plain = await request(cloud, { path: '/api/server/status', headers: HTTP_VISITOR })
    assert.equal(plain.status, 200)
  })

  it('the http calls that are still answered show up in the ops log, by kind and app origin', async () => {
    await request(cloud, { method: 'OPTIONS', path: '/api/match/validate-pin', headers: { ...HTTP_VISITOR, origin: APP_ORIGIN } })
    await request(cloud, { path: '/api/server/status', headers: { ...HTTP_VISITOR, origin: APP_ORIGIN } })
    const log = await waitUntil(() => {
      const text = cloud.output.join('')
      return text.includes('kind=preflight') && text.includes('kind=api') ? text : null
    }, { timeoutMs: 5000, what: 'the plain http log lines' })
    assert.match(log, /\[HTTP\] plain http answered \(SEC-61\) kind=preflight route=OPTIONS \/api\/match\/validate-pin origin=https:\/\/localhost/)
    assert.match(log, /\[HTTP\] plain http answered \(SEC-61\) kind=api route=GET \/api\/server\/status origin=https:\/\/localhost/)
    // rate limited: one line per kind and origin a minute, however many calls
    for (let i = 0; i < 5; i++) await request(cloud, { path: '/api/server/status', headers: { ...HTTP_VISITOR, origin: APP_ORIGIN } })
    await new Promise((r) => setTimeout(r, 200))
    const lines = cloud.output.join('').split('\n').filter((l) => l.includes('kind=api') && l.includes('origin=https://localhost'))
    assert.equal(lines.length, 1, lines.join('\n'))
    // no PIN, token or address in it
    assert.ok(!/123456/.test(cloud.output.join('').split('\n').filter((l) => l.includes('[HTTP]')).join('\n')))
  })

  it('a ws:// relay socket of an older app is still accepted, and logged', async () => {
    const client = await openSocket(`ws://127.0.0.1:${cloud.port}`, { headers: { 'cf-visitor': '{"scheme":"ws"}', Origin: APP_ORIGIN } })
    try {
      assert.equal(client.messages[0]?.type, 'connected')
    } finally {
      client.ws.close()
    }
    await waitUntil(() => cloud.output.join('').includes('kind=ws'), { timeoutMs: 5000, what: 'the ws log line' })
  })

  it('https visitors, requests without cf-visitor and the health checks are served', async () => {
    const https = await request(cloud, { path: '/', headers: { host: 'backend.openvolley.app', 'cf-visitor': '{"scheme":"https"}' } })
    assert.equal(https.status, 200)
    const none = await request(cloud, { path: '/', headers: { host: 'backend.openvolley.app' } })
    assert.equal(none.status, 200)
    for (const path of ['/health/live', '/health']) {
      const r = await request(cloud, { path, headers: HTTP_VISITOR })
      assert.ok(!isRedirect(r.status), path)
    }
    // a header that is not Cloudflare's JSON changes nothing
    const junk = await request(cloud, { path: '/', headers: { host: 'backend.openvolley.app', 'cf-visitor': 'http' } })
    assert.equal(junk.status, 200)
  })

  it('a venue server (plain http on the hall network) is never redirected', async () => {
    const r = await request(venue, { path: '/', headers: { host: '192.168.1.20:8080', 'cf-visitor': '{"scheme":"http"}' } })
    assert.equal(r.status, 200)
    assert.ok(!venue.output.join('').includes('[HTTP] plain http'))
  })
})
