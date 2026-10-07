import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ALLOWED_ORIGINS, createOriginPolicy, parsePublicOrigins } from '../lib/cors.js'

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

  it('cloud: the sites, the native shells, *.openvolley.app and PUBLIC_ORIGINS are trusted', () => {
    for (const o of [
      'https://app.openvolley.app', 'https://localhost', 'capacitor://localhost', 'tauri://localhost',
      'http://tauri.localhost', 'http://localhost:5173', 'https://dev-app.openvolley.app',
      'https://dev.openvolley-app.pages.dev'
    ]) assert.equal(cloud.isTrustedOrigin(o), true, o)
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

  it('LAN server: private-range pages are trusted, others reflected without credentials', () => {
    assert.deepEqual(lan.getCorsOrigin(req('http://192.168.1.20:5173')), { origin: 'http://192.168.1.20:5173', credentials: true })
    assert.deepEqual(lan.getCorsOrigin(req('https://manager.openvolley.app')), { origin: 'https://manager.openvolley.app', credentials: true })
    assert.deepEqual(lan.getCorsOrigin(req('https://evil.test')), { origin: 'https://evil.test', credentials: false })
    assert.deepEqual(lan.getCorsOrigin(req(undefined)), { origin: '*', credentials: false })
  })

  it('parsePublicOrigins trims, drops trailing slashes and blanks', () => {
    assert.deepEqual(parsePublicOrigins(' https://a.test/ , ,https://b.test//'), ['https://a.test', 'https://b.test'])
    assert.deepEqual(parsePublicOrigins(undefined), [])
  })
})
