// SEC-46: the policy the backend sends with the pages it hands out (a venue
// server, a standalone SEA build: backend/public) is the app's own policy,
// frontend/csp.js. It used to lack 'wasm-unsafe-eval', so a venue server's
// app could not seal its backups (hash-wasm Argon2id: WebAssembly.compile was
// refused), and had drifted on worker-src, frame-src blob:, object-src,
// base-uri and form-action (the audit's PoC poc/web-hardening/csp-wasm.mjs).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { contentSecurityPolicy } from '../../frontend/csp.js'
import { pageContentSecurityPolicy, pageCspDirectives, LAN_CONNECT_SRC } from '../lib/pageCsp.js'
import { bootServer } from './helpers/e2eServer.js'

const directives = (policy) => new Map(policy.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
  const [name, ...values] = d.split(/\s+/)
  return [name, values.join(' ')]
}))

describe('page CSP: the backend copy of frontend/csp.js', () => {
  it('is the same policy, directive for directive, on a venue server', () => {
    assert.equal(pageContentSecurityPolicy(), contentSecurityPolicy())
    assert.equal(pageContentSecurityPolicy({ frameAncestors: null }), contentSecurityPolicy({ frameAncestors: null }))
  })

  it('allows WebAssembly (the sealed backups) and nothing that evaluates text', () => {
    const scriptSrc = directives(pageContentSecurityPolicy()).get('script-src').split(' ')
    assert.ok(scriptSrc.includes("'wasm-unsafe-eval'"))
    assert.ok(!scriptSrc.includes("'unsafe-eval'"))
    assert.ok(!scriptSrc.includes("'unsafe-inline'"))
  })

  it('the cloud differs only in connect-src and frame-ancestors', () => {
    const cloud = directives(pageContentSecurityPolicy({ connectSrc: "'self' https://*.openvolley.app", frameAncestors: "'none'" }))
    const app = directives(contentSecurityPolicy())
    for (const [name, value] of app) {
      if (name === 'connect-src' || name === 'frame-ancestors') continue
      assert.equal(cloud.get(name), value, name)
    }
    assert.equal(cloud.get('connect-src'), "'self' https://*.openvolley.app")
    assert.equal(cloud.get('frame-ancestors'), "'none'")
    assert.equal(pageCspDirectives().find(([n]) => n === 'connect-src')[1], LAN_CONNECT_SRC)
  })
})

describe('page CSP: what server.js sends', () => {
  let venue
  let cloud
  before(async () => {
    venue = await bootServer({}, ['--local'])
    cloud = await bootServer({ IS_CLOUD: '1', PUBLIC_ORIGINS: 'https://club.example.org' }, ['--local'])
  })
  after(async () => {
    await venue?.stop()
    await cloud?.stop()
  })

  it('a venue server sends the app\'s policy (wasm-unsafe-eval, blob: frames and workers)', async () => {
    const res = await fetch(`${venue.base}/`)
    await res.text()
    assert.equal(res.headers.get('content-security-policy'), contentSecurityPolicy())
  })

  it('the cloud sends it with its own connect-src and no framing', async () => {
    const res = await fetch(`${cloud.base}/health/live`)
    await res.text()
    const got = directives(res.headers.get('content-security-policy'))
    assert.ok(got.get('script-src').split(' ').includes("'wasm-unsafe-eval'"))
    assert.equal(got.get('worker-src'), "'self' blob:")
    assert.equal(got.get('frame-src'), "'self' blob:")
    assert.equal(got.get('object-src'), "'none'")
    assert.equal(got.get('base-uri'), "'self'")
    assert.equal(got.get('form-action'), "'self'")
    assert.equal(got.get('frame-ancestors'), "'none'")
    const connect = got.get('connect-src').split(' ')
    for (const s of ["'self'", 'https://*.openvolley.app', 'wss://*.openvolley.app', 'https://club.example.org', 'wss://club.example.org']) {
      assert.ok(connect.includes(s), s)
    }
    assert.ok(!connect.includes('http:') && !connect.includes('ws:'))
  })
})
