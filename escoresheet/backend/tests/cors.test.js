import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ALLOWED_ORIGINS, createOriginPolicy, isLanHost, parsePublicOrigins } from '../lib/cors.js'

const req = (origin) => ({ headers: origin === undefined ? {} : { origin } })

describe('CORS origin policy (lib/cors.js)', () => {
  const cloud = createOriginPolicy({ isCloud: true, publicOrigins: ['https://dev.openvolley-app.pages.dev'] })
  const lan = createOriginPolicy({ isCloud: false })

  it('lists manager.openvolley.app with the other sites', () => {
    for (const o of ['https://app.openvolley.app', 'https://referee.openvolley.app', 'https://manager.openvolley.app']) {
      assert.ok(ALLOWED_ORIGINS.includes(o), o)
    }
  })

  it('cloud: the manager site gets credentialed CORS', () => {
    assert.deepEqual(cloud.getCorsOrigin(req('https://manager.openvolley.app')), { origin: 'https://manager.openvolley.app', credentials: true })
  })

  it('cloud: the OpenBeach manager (manager-beach) is listed and gets credentialed CORS; look-alikes do not', () => {
    assert.ok(ALLOWED_ORIGINS.includes('https://manager-beach.openvolley.app'))
    assert.deepEqual(cloud.getCorsOrigin(req('https://manager-beach.openvolley.app')), { origin: 'https://manager-beach.openvolley.app', credentials: true })
    for (const o of ['http://manager-beach.openvolley.app', 'https://manager-beach.openvolley.app.evil.test', 'https://manager-beach.openvolley.app:8443']) {
      assert.equal(cloud.isTrustedOrigin(o), false, o)
    }
  })

  it('cloud: the sites, the native shells and PUBLIC_ORIGINS are trusted', () => {
    for (const o of [
      'https://app.openvolley.app', 'https://www.openvolley.app', 'https://beach.openvolley.app',
      'https://beach-referee.openvolley.app', 'https://referee-beach.openvolley.app',
      'https://localhost', 'capacitor://localhost', 'tauri://localhost',
      'http://tauri.localhost', 'http://localhost:5173',
      'https://dev.openvolley-app.pages.dev'
    ]) assert.equal(cloud.isTrustedOrigin(o), true, o)
  })

  it('cloud: no wildcard: other hosts under openvolley.app are strangers', () => {
    for (const o of ['https://dev-app.openvolley.app', 'https://support.openvolley.app', 'https://get.openvolley.app',
      'https://old.openvolley.app', 'https://backend.openvolley.app']) {
      assert.equal(cloud.isTrustedOrigin(o), false, o)
      assert.deepEqual(cloud.getCorsOrigin(req(o)), { origin: 'https://openvolley.app', credentials: false }, o)
    }
    // a dev build is trusted only when PUBLIC_ORIGINS names it
    const withDev = createOriginPolicy({ isCloud: true, publicOrigins: ['https://dev-app.openvolley.app'] })
    assert.equal(withDev.isTrustedOrigin('https://dev-app.openvolley.app'), true)
  })

  it("the server's own pages: an origin whose host is the request's Host", () => {
    assert.equal(cloud.isTrustedOrigin('https://backend.openvolley.app', { host: 'backend.openvolley.app' }), true)
    assert.equal(cloud.isTrustedOrigin('https://backend.openvolley.app', { host: 'other.example' }), false)
    assert.equal(lan.isTrustedOrigin('http://scoretable:8080', { host: 'scoretable:8080' }), true)
    assert.equal(lan.isTrustedOrigin('http://scoretable:8080', { host: 'scoretable:8081' }), false)
    assert.deepEqual(cloud.getCorsOrigin({ headers: { origin: 'https://backend.openvolley.app', host: 'backend.openvolley.app' } }),
      { origin: 'https://backend.openvolley.app', credentials: true })
  })

  it("the server's own pages: only by a name no outside party can point at the server (DNS rebinding)", () => {
    const own = (policy, origin) => policy.isTrustedOrigin(origin, { host: new URL(origin).host })
    // addresses, localhost, .local and single-label names: on a venue server and on the cloud
    for (const o of ['http://192.168.1.20:8080', 'http://203.0.113.5:8080', 'http://[2001:db8::5]:8080', 'http://localhost:8080',
      'http://scoretable.local:8080', 'http://scoretable:8080']) {
      assert.equal(own(lan, o), true, o)
      assert.equal(own(cloud, o), true, o)
    }
    // the cloud's own name and the hosts of PUBLIC_ORIGINS (any port or scheme)
    assert.equal(own(cloud, 'https://backend.openvolley.app'), true)
    assert.equal(own(cloud, 'http://backend.openvolley.app:8080'), true)
    assert.equal(own(cloud, 'http://dev.openvolley-app.pages.dev:8080'), true)
    // any other name may be an outside page re-pointed at the server's address
    for (const o of ['http://rebind.attacker.example:8080', 'http://scorer-pc.fritz.box:8080', 'http://10.0.0.7.nip.io:8080',
      'https://backend.openvolley.app.evil.test', 'https://dev-backend.openvolley.app']) {
      assert.equal(own(lan, o), false, o)
      assert.equal(own(cloud, o), false, o)
    }
    // a dev backend is its own page once PUBLIC_ORIGINS names it
    const dev = createOriginPolicy({ isCloud: true, publicOrigins: ['https://dev-backend.openvolley.app'] })
    assert.equal(dev.isTrustedOrigin('http://dev-backend.openvolley.app:8080', { host: 'dev-backend.openvolley.app:8080' }), true)
  })

  it('cloud: both desktop apps\' windows are trusted on their own ports only', () => {
    // OpenVolley eScoresheet on 5173, OpenBeach on 5174 (src-tauri flavour.rs)
    for (const o of ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:5174', 'http://127.0.0.1:5174']) {
      assert.deepEqual(cloud.getCorsOrigin(req(o)), { origin: o, credentials: true }, o)
    }
    for (const o of ['http://localhost:5175', 'http://localhost:8081', 'https://localhost:5174', 'http://192.168.1.20:5174']) {
      assert.equal(cloud.isTrustedOrigin(o), false, o)
    }
  })

  it('cloud: Pages previews are trusted only through PUBLIC_ORIGINS', () => {
    assert.equal(cloud.isTrustedOrigin('https://dev.openvolley-manager.pages.dev'), false)
    const withPreview = createOriginPolicy({ isCloud: true, publicOrigins: parsePublicOrigins('https://dev.openvolley-manager.pages.dev/') })
    assert.equal(withPreview.isTrustedOrigin('https://dev.openvolley-manager.pages.dev'), true)
  })

  it('cloud: look-alikes, http, LAN pages and no origin are refused (no credentials, no reflection)', () => {
    for (const o of [
      'https://manager.openvolley.app.evil.test', 'https://evilopenvolley.app', 'http://manager.openvolley.app',
      'https://a.b.openvolley.app', 'http://192.168.1.20:5173', 'https://evil.test', undefined
    ]) {
      assert.equal(cloud.isTrustedOrigin(o), false, String(o))
      assert.deepEqual(cloud.getCorsOrigin(req(o)), { origin: 'https://openvolley.app', credentials: false }, String(o))
    }
  })

  it('LAN server: pages of the venue network are trusted, no other origin is reflected', () => {
    assert.deepEqual(lan.getCorsOrigin(req('http://192.168.1.20:5173')), { origin: 'http://192.168.1.20:5173', credentials: true })
    assert.deepEqual(lan.getCorsOrigin(req('https://manager.openvolley.app')), { origin: 'https://manager.openvolley.app', credentials: true })
    assert.deepEqual(lan.getCorsOrigin(req('https://evil.test')), { origin: 'https://openvolley.app', credentials: false })
    assert.deepEqual(lan.getCorsOrigin(req(undefined)), { origin: 'https://openvolley.app', credentials: false })
  })

  it('LAN server: private ranges are tested on the parsed address, not as a prefix', () => {
    for (const o of [
      'http://10.0.0.7', 'http://10.255.1.2:8080', 'http://172.16.0.1:5173', 'http://172.31.255.254',
      'http://192.168.1.20:5173', 'https://192.168.0.5', 'http://169.254.10.1', 'http://127.0.0.1:9000',
      'http://localhost:8080', 'http://[::1]:5173', 'http://[fd12:3456::1]:5173', 'http://[fe80::1]',
      'http://[::ffff:c0a8:114]:5173', 'http://scoretable.local:5173', 'http://ov.hall.local'
    ]) assert.equal(lan.isTrustedOrigin(o), true, o)
    for (const o of [
      // look-alike names and public addresses
      'http://10.evil.example', 'http://192.168.evil.example', 'http://127.0.0.1.evil.example',
      'http://10.0.0.7.nip.io', 'http://172.32.0.1', 'http://172.15.0.1', 'http://8.8.8.8', 'http://1.2.3.4:5173',
      'http://[2001:db8::1]', 'http://[::ffff:808:808]', 'http://local', 'http://evil.local.example',
      // not an origin, or not http(s)
      'ftp://192.168.1.20', 'http://192.168.1.20/path', 'http://user@192.168.1.20', 'file://', 'null', 'http://192.168.1.20:80'
    ]) {
      assert.equal(lan.isTrustedOrigin(o), false, o)
      assert.deepEqual(lan.getCorsOrigin(req(o)), { origin: 'https://openvolley.app', credentials: false }, o)
    }
  })

  it('isLanHost: addresses and .local names only', () => {
    for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.0.1', '169.254.0.1', '::1', 'fd00::1', 'fe80::1', 'board.local']) {
      assert.equal(isLanHost(h), true, h)
    }
    for (const h of ['', '10.example.test', '192.168.1.1.example', '100.64.0.1', '8.8.8.8', '2001:db8::1', 'example.com', 'local']) {
      assert.equal(isLanHost(h), false, h)
    }
  })

  it('parsePublicOrigins trims, drops trailing slashes and blanks', () => {
    assert.deepEqual(parsePublicOrigins(' https://a.test/ , ,https://b.test//'), ['https://a.test', 'https://b.test'])
    assert.deepEqual(parsePublicOrigins(undefined), [])
  })
})
