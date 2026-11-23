// SEC-61: the cloud answered plain http (ports 80 and 8080 through
// Cloudflare: http://backend.openvolley.app/... 200), so a typed or scanned
// http:// link carried tokens, PINs and relay frames in the clear. A request
// whose cf-visitor (Cloudflare: the visitor's scheme) is http now goes to
// https; the health checks, a request without cf-visitor (local callers, the
// tunnel's own checks) and a venue server answer as before.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { bootServer } from './helpers/e2eServer.js'

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

describe('cloud over plain http goes to https (SEC-61)', () => {
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

  it('a page or an API read over http: 301 to the same address on https', async () => {
    const page = await request(cloud, { path: '/', headers: HTTP_VISITOR })
    assert.equal(page.status, 301)
    assert.equal(page.headers.location, 'https://backend.openvolley.app/')
    const api = await request(cloud, { path: '/api/match/list?x=1', headers: { ...HTTP_VISITOR, host: 'backend.openvolley.app:8080' } })
    assert.equal(api.status, 301)
    assert.equal(api.headers.location, 'https://backend.openvolley.app/api/match/list?x=1')
    assert.ok(!api.text.includes('matches'))
  })

  it('a write over http: 308 (an older app keeps its method and body)', async () => {
    const r = await request(cloud, { method: 'POST', path: '/api/match/validate-pin', headers: { ...HTTP_VISITOR, 'content-type': 'application/json' }, body: '{"pin":"123456","type":"referee"}' })
    assert.equal(r.status, 308)
    assert.equal(r.headers.location, 'https://backend.openvolley.app/api/match/validate-pin')
  })

  it('https visitors, requests without cf-visitor and the health checks are served', async () => {
    const https = await request(cloud, { path: '/', headers: { host: 'backend.openvolley.app', 'cf-visitor': '{"scheme":"https"}' } })
    assert.equal(https.status, 200)
    const none = await request(cloud, { path: '/', headers: { host: 'backend.openvolley.app' } })
    assert.equal(none.status, 200)
    for (const path of ['/health/live', '/health']) {
      const r = await request(cloud, { path, headers: HTTP_VISITOR })
      assert.notEqual(r.status, 301, path)
      assert.notEqual(r.status, 308, path)
    }
    // a header that is not Cloudflare's JSON changes nothing
    const junk = await request(cloud, { path: '/', headers: { host: 'backend.openvolley.app', 'cf-visitor': 'http' } })
    assert.equal(junk.status, 200)
  })

  it('a venue server (plain http on the hall network) is never redirected', async () => {
    const r = await request(venue, { path: '/', headers: { host: '192.168.1.20:8080', 'cf-visitor': '{"scheme":"http"}' } })
    assert.equal(r.status, 200)
  })
})
