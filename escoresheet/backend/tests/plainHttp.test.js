// SEC-61 (lib/plainHttp.js): what a cloud request over plain http gets. Pages
// and browser-opened addresses go to https; an older app's API calls and CORS
// preflights are answered as before (a redirected preflight fails, and a
// redirected call arrives with Origin: null), and only counted.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { visitorScheme, isPlainVisitor, plainHttpAnswer, formatPlainHttpLine, plainHttpLogKey, plainHttpSource } from '../lib/plainHttp.js'

const req = (method, url, headers = {}) => ({ method, url, headers: { host: 'backend.openvolley.app', 'cf-visitor': '{"scheme":"http"}', ...headers } })

describe('plainHttp: the visitor scheme', () => {
  it('reads Cloudflare\'s JSON, nothing else', () => {
    assert.equal(visitorScheme({ 'cf-visitor': '{"scheme":"http"}' }), 'http')
    assert.equal(visitorScheme({ 'cf-visitor': '{"scheme":"HTTPS"}' }), 'https')
    assert.equal(visitorScheme({ 'cf-visitor': 'http' }), null)
    assert.equal(visitorScheme({ 'cf-visitor': '{"scheme":1}' }), null)
    assert.equal(visitorScheme({}), null)
    assert.equal(visitorScheme(undefined), null)
    assert.equal(visitorScheme({ 'cf-visitor': '{"scheme":"http"}'.padEnd(300, ' ') }), null)
  })
  it('plain means http:// or ws://', () => {
    assert.equal(isPlainVisitor({ 'cf-visitor': '{"scheme":"http"}' }), true)
    assert.equal(isPlainVisitor({ 'cf-visitor': '{"scheme":"ws"}' }), true)
    assert.equal(isPlainVisitor({ 'cf-visitor': '{"scheme":"https"}' }), false)
    assert.equal(isPlainVisitor({ 'cf-visitor': '{"scheme":"wss"}' }), false)
    assert.equal(isPlainVisitor({}), false)
  })
})

describe('plainHttp: the answer', () => {
  it('pages and scripts go to https: 301 for GET/HEAD, 308 otherwise', () => {
    assert.deepEqual(plainHttpAnswer(req('GET', '/')), { action: 'redirect', status: 301, location: 'https://backend.openvolley.app/' })
    assert.deepEqual(plainHttpAnswer(req('HEAD', '/tv?code=1', { host: 'backend.openvolley.app:8080' })), { action: 'redirect', status: 301, location: 'https://backend.openvolley.app/tv?code=1' })
    assert.deepEqual(plainHttpAnswer(req('GET', '/embed/livescore.js')), { action: 'redirect', status: 301, location: 'https://backend.openvolley.app/embed/livescore.js' })
    assert.equal(plainHttpAnswer(req('POST', '/sign/x')).status, 308)
  })

  it('an API address opened as a page goes to https', () => {
    assert.deepEqual(plainHttpAnswer(req('GET', '/api/match/list', { 'sec-fetch-mode': 'navigate' })), { action: 'redirect', status: 301, location: 'https://backend.openvolley.app/api/match/list' })
    assert.equal(plainHttpAnswer(req('POST', '/api/contact', { 'sec-fetch-mode': 'navigate' })).status, 308)
  })

  it('an older app\'s API calls and every preflight are served (counted, not redirected)', () => {
    assert.deepEqual(plainHttpAnswer(req('OPTIONS', '/api/match/validate-pin', { origin: 'https://localhost' })), { action: 'serve', kind: 'preflight' })
    assert.deepEqual(plainHttpAnswer(req('OPTIONS', '/anything')), { action: 'serve', kind: 'preflight' })
    assert.deepEqual(plainHttpAnswer(req('POST', '/api/match/validate-pin', { origin: 'https://localhost' })), { action: 'serve', kind: 'api' })
    assert.deepEqual(plainHttpAnswer(req('GET', '/api/match/abc', { 'sec-fetch-mode': 'cors' })), { action: 'serve', kind: 'api' })
    // a native client or a script (no Origin, no Sec-Fetch-Mode)
    assert.deepEqual(plainHttpAnswer(req('GET', '/api/server/status')), { action: 'serve', kind: 'api' })
    // even without a usable Host
    assert.deepEqual(plainHttpAnswer(req('GET', '/api/server/status', { host: '' })), { action: 'serve', kind: 'api' })
    // /apiary is no API address
    assert.equal(plainHttpAnswer(req('GET', '/apiary')).action, 'redirect')
  })

  it('nothing to do: https, no cf-visitor, the health checks, no usable Host', () => {
    assert.equal(plainHttpAnswer(req('GET', '/', { 'cf-visitor': '{"scheme":"https"}' })), null)
    assert.equal(plainHttpAnswer({ method: 'GET', url: '/', headers: { host: 'backend.openvolley.app' } }), null)
    assert.equal(plainHttpAnswer(req('GET', '/health')), null)
    assert.equal(plainHttpAnswer(req('GET', '/health/live')), null)
    assert.equal(plainHttpAnswer(req('GET', '/', { host: 'localhost' })), null)
    assert.equal(plainHttpAnswer(req('GET', '/', { host: 'evil.example/x' })), null)
  })

  it('a request target that is not a path goes to the root', () => {
    assert.equal(plainHttpAnswer(req('GET', 'http://other.example/x')).location, 'https://backend.openvolley.app/')
  })
})

describe('plainHttp: the ops line', () => {
  it('names the kind, the masked route and a trusted origin only', () => {
    assert.equal(formatPlainHttpLine({ kind: 'api', route: 'GET /api/match/:id', origin: 'https://localhost', trusted: true }),
      '[HTTP] plain http answered (SEC-61) kind=api route=GET /api/match/:id origin=https://localhost')
    assert.match(formatPlainHttpLine({ kind: 'api', route: 'GET /', origin: 'https://evil.example', trusted: false }), /origin=untrusted$/)
    assert.match(formatPlainHttpLine({ kind: 'ws', route: 'GET /', trusted: false }), /origin=none$/)
    // a visitor's bytes never reach the log as they are
    assert.ok(!formatPlainHttpLine({ kind: 'api\n[x]', route: 'GET /\r\nInjected', origin: 'x', trusted: false }).includes('\n'))
  })
  it('one limiter key per kind and source', () => {
    assert.equal(plainHttpSource({ trusted: false }), 'none')
    assert.equal(plainHttpLogKey({ kind: 'api', origin: 'https://localhost', trusted: true }), 'api-https___localhost')
    assert.equal(plainHttpLogKey({ kind: 'api', origin: 'https://a.example', trusted: false }), 'api-untrusted')
    assert.notEqual(plainHttpLogKey({ kind: 'api', origin: 'https://localhost', trusted: true }), plainHttpLogKey({ kind: 'preflight', origin: 'https://localhost', trusted: true }))
  })
})
