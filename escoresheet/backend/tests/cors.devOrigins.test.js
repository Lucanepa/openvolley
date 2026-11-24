// SEC-60: a production cloud backend trusts no dev-branch site. Production's
// .env listed 10 dev-*.openvolley.app hosts and 6 dev.openvolley-*.pages.dev
// aliases, trusted with credentials and named in the CSP. On the cloud they
// are dropped at the start with a loud line (not a stop: the .env may still
// list them); the test backend says OV_ALLOW_DEV_ORIGINS=1 and keeps them; a
// venue server and local development keep theirs.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createOriginPolicy, isDevOrigin, parsePublicOrigins, withoutDevOrigins } from '../lib/cors.js'
import { bootServer } from './helpers/e2eServer.js'

const PROD_LIKE = [
  'https://app.openvolley.app',
  'https://dev-app.openvolley.app',
  'https://dev-beach.openvolley.app',
  'https://dev.openvolley.app',
  'https://dev.openvolley-app.pages.dev',
  'https://openvolley-referee.pages.dev',
  'https://club.example.org'
]

describe('dev-branch origins (lib/cors.js)', () => {
  it('names the Pages aliases and the dev sites, nothing else', () => {
    for (const o of ['https://dev-app.openvolley.app', 'https://dev-referee.openvolley.app', 'https://dev.openvolley.app',
      'https://dev.openvolley-app.pages.dev', 'https://abc123.openvolley-manager.pages.dev', 'https://DEV-APP.openvolley.app']) {
      assert.equal(isDevOrigin(o), true, o)
    }
    for (const o of ['https://app.openvolley.app', 'https://openvolley.app', 'https://devices.example.org', 'https://developer.openvolley.app',
      'https://manager-beach.openvolley.app', 'http://localhost:5173', 'https://club.example.org', 'not a url', '']) {
      assert.equal(isDevOrigin(o), false, o)
    }
  })

  it('the cloud drops them; the test backend and a venue server keep the list', () => {
    const list = parsePublicOrigins(PROD_LIKE.join(','))
    const cloud = withoutDevOrigins(list, { isCloud: true })
    assert.deepEqual(cloud.kept, ['https://app.openvolley.app', 'https://club.example.org'])
    assert.equal(cloud.dropped.length, 5)
    assert.deepEqual(withoutDevOrigins(list, { isCloud: true, allowDev: true }), { kept: list, dropped: [] })
    assert.deepEqual(withoutDevOrigins(list, { isCloud: false }), { kept: list, dropped: [] })
    // what the policy then trusts
    const policy = createOriginPolicy({ isCloud: true, publicOrigins: cloud.kept })
    assert.equal(policy.isTrustedOrigin('https://dev.openvolley-app.pages.dev'), false)
    assert.equal(policy.isTrustedOrigin('https://dev-app.openvolley.app'), false)
    assert.equal(policy.isTrustedOrigin('https://club.example.org'), true)
  })
})

describe('dev-branch origins: server.js', () => {
  const servers = []
  after(async () => { for (const s of servers) await s.stop() })
  let prod
  let test
  let venue
  before(async () => {
    prod = await bootServer({ IS_CLOUD: '1', PUBLIC_ORIGINS: PROD_LIKE.join(',') }, ['--local'])
    test = await bootServer({ IS_CLOUD: '1', PUBLIC_ORIGINS: PROD_LIKE.join(','), OV_ALLOW_DEV_ORIGINS: '1' }, ['--local'])
    venue = await bootServer({ PUBLIC_ORIGINS: PROD_LIKE.join(',') }, ['--local'])
    servers.push(prod, test, venue)
  })

  const preflight = async (srv, origin) => {
    const res = await fetch(`${srv.base}/api/match/list`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } })
    await res.text()
    return { acao: res.headers.get('access-control-allow-origin'), credentials: res.headers.get('access-control-allow-credentials'), csp: res.headers.get('content-security-policy') }
  }

  it('production: a dev origin gets no CORS answer and is not in the CSP; the start says so', async () => {
    for (const o of ['https://dev.openvolley-app.pages.dev', 'https://dev-app.openvolley.app']) {
      const r = await preflight(prod, o)
      assert.notEqual(r.acao, o, o)
      assert.equal(r.credentials, null, o)
      assert.ok(!r.csp.includes(new URL(o).host), o)
    }
    const kept = await preflight(prod, 'https://club.example.org')
    assert.equal(kept.acao, 'https://club.example.org')
    assert.match(prod.output.join(''), /PUBLIC_ORIGINS: 5 dev-branch origin\(s\) NOT trusted/)
    // a write from such a page is refused before any route
    const write = await fetch(`${prod.base}/api/match/validate-pin`, { method: 'POST', headers: { Origin: 'https://dev-app.openvolley.app', 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(write.status, 403)
    await write.text()
  })

  it('the test backend (OV_ALLOW_DEV_ORIGINS=1) and a venue server keep them', async () => {
    for (const srv of [test, venue]) {
      const r = await preflight(srv, 'https://dev.openvolley-app.pages.dev')
      assert.equal(r.acao, 'https://dev.openvolley-app.pages.dev')
      assert.equal(r.credentials, 'true')
      assert.doesNotMatch(srv.output.join(''), /dev-branch origin/)
    }
  })
})
