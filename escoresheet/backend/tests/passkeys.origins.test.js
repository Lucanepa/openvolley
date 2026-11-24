// SEC-65: passkey ceremonies come only from the sites that sign in (an
// explicit list), never from the website openvolley.app / www. (the support
// form, another repository, no CSP or frame protection): a script there
// could turn one passkey prompt of a visitor, an admin included, into a
// session. The website stays a CORS origin for its support form.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ALLOWED_ORIGINS, createOriginPolicy } from '../lib/cors.js'
import { PASSKEY_SITES, appOrigins, originAllowed, passkeyConfig } from '../lib/passkeys.js'

const WEBSITE = ['https://openvolley.app', 'https://www.openvolley.app']

describe('passkey origins (SEC-65)', () => {
  const config = passkeyConfig({})

  it('the website never runs a ceremony', () => {
    for (const o of WEBSITE) {
      assert.equal(originAllowed(o, config), false, o)
      assert.ok(!appOrigins('openvolley.app').includes(o), o)
      assert.ok(!PASSKEY_SITES.includes(o), o)
    }
  })

  it('every sign-in site does, and each is one of the server\'s trusted sites', () => {
    for (const o of PASSKEY_SITES) {
      assert.ok(ALLOWED_ORIGINS.includes(o), o)
      assert.equal(new URL(o).protocol, 'https:', o)
      assert.equal(originAllowed(o, config), true, o)
    }
    for (const o of ['https://app.openvolley.app', 'https://manager.openvolley.app', 'https://manager-beach.openvolley.app', 'https://beach.openvolley.app', 'https://referee.openvolley.app']) {
      assert.ok(PASSKEY_SITES.includes(o), o)
    }
  })

  it('the other https sites under openvolley.app that the server trusts are exactly the website', () => {
    const httpsSites = ALLOWED_ORIGINS.filter((o) => o.startsWith('https://') && new URL(o).hostname.endsWith('openvolley.app'))
    assert.deepEqual(httpsSites.filter((o) => !PASSKEY_SITES.includes(o)).sort(), [...WEBSITE].sort())
  })

  it('WEBAUTHN_ORIGINS still replaces the list', () => {
    const own = passkeyConfig({ WEBAUTHN_ORIGINS: 'https://www.openvolley.app' })
    assert.equal(originAllowed('https://www.openvolley.app', own), true)
    assert.equal(originAllowed('https://app.openvolley.app', own), false)
  })

  it('the website keeps its CORS answer (the support form)', () => {
    const cloud = createOriginPolicy({ isCloud: true })
    for (const o of WEBSITE) assert.equal(cloud.isTrustedOrigin(o), true, o)
  })
})
