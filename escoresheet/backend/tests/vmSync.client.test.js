import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CookieJar, vmLogin, fetchAllGames, fetchWithRetry, followRedirects, extractFormFields,
  extractCsrfToken, createRedactor, VmHttpError
} from '../lib/vmSync.js'
import {
  createFakeVolleyManager, makeGame, FAKE_BASE, FAKE_USER, FAKE_PASSWORD, FAKE_CSRF,
  FAKE_SESSION_1, FAKE_SESSION_2, TRUSTED_PROPERTIES
} from './helpers/fakeVolleyManager.js'

const noSleep = async () => {}
const http = { sleep: noSleep, backoffMs: 1, timeoutMs: 2000 }
const creds = { username: FAKE_USER, password: FAKE_PASSWORD }

function memLogger() {
  const lines = []
  const push = (lvl) => (...a) => lines.push(`${lvl} ${a.join(' ')}`)
  return { lines, log: push('log'), warn: push('warn'), error: push('error') }
}

describe('CookieJar', () => {
  it('collects Set-Cookie headers (multiple, with Expires commas)', () => {
    const jar = new CookieJar()
    const h = new Headers()
    h.append('set-cookie', 'a=1; Path=/; HttpOnly')
    h.append('set-cookie', 'b=two=2; Expires=Thu, 01 Jan 2099 00:00:00 GMT; Secure')
    jar.update({ headers: h })
    assert.equal(jar.header(), 'a=1; b=two=2')
    assert.equal(jar.size, 2)
  })

  it('overwrites by name and deletes on Max-Age=0 / past Expires', () => {
    const jar = new CookieJar()
    jar.setFromHeader('s=old')
    jar.setFromHeader('s=new; Path=/')
    jar.setFromHeader('t=x')
    jar.setFromHeader('u=y')
    jar.setFromHeader('t=; Max-Age=0')
    jar.setFromHeader('u=deleted; Expires=Thu, 01 Jan 1970 00:00:00 GMT')
    assert.equal(jar.header(), 's=new')
  })

  it('falls back to a folded set-cookie header without getSetCookie', () => {
    const jar = new CookieJar()
    const joined = 'a=1; Expires=Wed, 21 Oct 2099 07:28:00 GMT; Path=/, b=2; Path=/'
    jar.update({ headers: { get: (k) => (k === 'set-cookie' ? joined : null) } })
    assert.equal(jar.header(), 'a=1; b=2')
  })

  it('ignores junk lines', () => {
    const jar = new CookieJar()
    jar.setFromHeader('novalue')
    jar.setFromHeader('=x')
    assert.equal(jar.size, 0)
  })
})

describe('form and CSRF parsing', () => {
  it('reads inputs in any attribute order, decodes entities, skips unchecked boxes', () => {
    const fields = extractFormFields(`
      <input type="hidden" name="__referrer[@package]" value="A&amp;B">
      <input value="x&quot;y" name="__trustedProperties" type="hidden">
      <input type='hidden' name='single' value='q'>
      <input type="checkbox" name="remember" value="1">
      <input type="checkbox" name="checkedBox" value="1" checked>
      <input type="submit" name="login" value="Anmelden">
      <input type="button" name="noop" value="x">
      <input name="noValue">`)
    assert.deepEqual(fields, {
      '__referrer[@package]': 'A&B',
      __trustedProperties: 'x"y',
      single: 'q',
      checkedBox: '1',
      login: 'Anmelden',
      noValue: ''
    })
  })

  it('finds the CSRF token', () => {
    assert.equal(extractCsrfToken('<div data-csrf-token="abc&amp;d"></div>'), 'abc&d')
    assert.equal(extractCsrfToken('<div></div>'), null)
  })
})

describe('login flow against a fake VolleyManager', () => {
  it('logs in, follows redirects with the right cookies and returns the CSRF token', async () => {
    const vm = createFakeVolleyManager()
    const logger = memLogger()
    const { jar, csrfToken } = await vmLogin(creds, { fetch: vm.fetch, baseUrl: vm.baseUrl, http, logger })
    assert.equal(csrfToken, FAKE_CSRF)
    assert.equal(jar.header(), `Neos_Flow_Session=${FAKE_SESSION_2}`, 'session cookie rotated, deleted cookie gone')
    assert.deepEqual(vm.calls.map((c) => `${c.method} ${c.path}`), [
      'GET /login',
      'POST /sportmanager.security/authentication/authenticate',
      'GET /dashboard',
      'GET /indoorvolleyball.refadmin/refereegame/index'
    ])
    assert.equal(vm.calls[1].cookies.Neos_Flow_Session, FAKE_SESSION_1)
    assert.equal(vm.calls[2].cookies.Neos_Flow_Session, FAKE_SESSION_2, 'cookie from the 303 is used on the next hop')
    assert.ok(vm.calls.every((c) => c.redirect === 'manual'))
    const form = new URLSearchParams(vm.calls[1].body)
    assert.equal(form.get('__trustedProperties'), TRUSTED_PROPERTIES, 'hidden field sent decoded, like a browser')
    assert.equal(form.has('rememberMe'), false)
    const out = logger.lines.join('\n')
    for (const secret of [FAKE_PASSWORD, FAKE_CSRF, FAKE_SESSION_1, FAKE_SESSION_2]) {
      assert.ok(!out.includes(secret), `log must not contain ${secret}`)
    }
  })

  it('a wrong password fails with a clear message (no secret in it)', async () => {
    const vm = createFakeVolleyManager({ password: 'something-else' })
    await assert.rejects(
      vmLogin(creds, { fetch: vm.fetch, baseUrl: vm.baseUrl, http }),
      (err) => /login failed/.test(err.message) && !err.message.includes(FAKE_PASSWORD)
    )
  })

  it('refuses missing credentials before any request', async () => {
    const vm = createFakeVolleyManager()
    await assert.rejects(vmLogin({ username: FAKE_USER }, { fetch: vm.fetch, baseUrl: vm.baseUrl, http }), /credentials missing/)
    assert.equal(vm.calls.length, 0)
  })

  it('retries transient 503s with backoff', async () => {
    const vm = createFakeVolleyManager({ transient500: 2 })
    const sleeps = []
    const { csrfToken } = await vmLogin(creds, {
      fetch: vm.fetch, baseUrl: vm.baseUrl, http: { ...http, sleep: async (ms) => { sleeps.push(ms) }, backoffMs: 100 }
    })
    assert.equal(csrfToken, FAKE_CSRF)
    assert.equal(sleeps.length, 2)
    assert.ok(sleeps[1] > sleeps[0], 'exponential backoff')
  })

  it('does not follow a redirect off the VolleyManager origin (cookies stay home)', async () => {
    const calls = []
    const fetch = async (url, init) => {
      calls.push({ url, cookie: new Headers(init.headers).get('cookie') })
      return new Response(null, { status: 302, headers: { location: 'https://evil.test.invalid/x', 'set-cookie': 's=1' } })
    }
    const jar = new CookieJar()
    await assert.rejects(followRedirects(`${FAKE_BASE}/login`, jar, {}, { fetch, baseUrl: FAKE_BASE, http }), /redirected off/)
    assert.equal(calls.length, 1)
  })
})

describe('fetchWithRetry', () => {
  it('times out a hanging request and gives up after the retries', async () => {
    let n = 0
    const fetch = (url, init) => new Promise((resolve, reject) => {
      n++
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })
    await assert.rejects(
      fetchWithRetry(fetch, `${FAKE_BASE}/x`, {}, { label: 'x', timeoutMs: 20, retries: 2, sleep: noSleep }),
      (err) => err instanceof VmHttpError && /timed out after 20 ms/.test(err.message)
    )
    assert.equal(n, 3)
  })

  it('does not retry a 4xx', async () => {
    let n = 0
    const fetch = async () => { n++; return new Response('nope', { status: 403 }) }
    const r = await fetchWithRetry(fetch, `${FAKE_BASE}/x`, {}, { retries: 3, sleep: noSleep })
    assert.equal(r.status, 403)
    assert.equal(n, 1)
  })

  it('retries network errors', async () => {
    let n = 0
    const fetch = async () => {
      n++
      if (n < 3) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })
      return new Response('ok')
    }
    const r = await fetchWithRetry(fetch, `${FAKE_BASE}/x`, {}, { retries: 2, sleep: noSleep })
    assert.equal(r.body, 'ok')
  })
})

describe('fetchAllGames', () => {
  const login = async (vm) => vmLogin(creds, { fetch: vm.fetch, baseUrl: vm.baseUrl, http })

  it('pages through the search API', async () => {
    const games = Array.from({ length: 5 }, (_, i) => makeGame(1000 + i))
    const vm = createFakeVolleyManager({ games })
    const { jar, csrfToken } = await login(vm)
    const r = await fetchAllGames(jar, csrfToken, 'a', 'b', { fetch: vm.fetch, baseUrl: vm.baseUrl, http, batchSize: 2, sleep: noSleep })
    assert.equal(r.items.length, 5)
    assert.equal(r.total, 5)
    assert.equal(r.incomplete, false)
    const offsets = vm.calls.filter((c) => c.path.startsWith('/api/')).map((c) => new URLSearchParams(c.body).get('searchConfiguration[offset]'))
    assert.deepEqual(offsets, ['0', '2', '4'])
  })

  it('a failing later page returns what was fetched, marked incomplete', async () => {
    const games = Array.from({ length: 5 }, (_, i) => makeGame(1000 + i))
    const vm = createFakeVolleyManager({ games, failSearchAt: 4 })
    const { jar, csrfToken } = await login(vm)
    const r = await fetchAllGames(jar, csrfToken, 'a', 'b', { fetch: vm.fetch, baseUrl: vm.baseUrl, http, batchSize: 2, sleep: noSleep })
    assert.equal(r.items.length, 4)
    assert.equal(r.incomplete, true)
    assert.match(r.pageError, /HTTP 500/)
  })

  it('stops when VM reports more than it returns', async () => {
    const vm = createFakeVolleyManager({ games: [makeGame(1)], reportTotal: 50 })
    const { jar, csrfToken } = await login(vm)
    const r = await fetchAllGames(jar, csrfToken, 'a', 'b', { fetch: vm.fetch, baseUrl: vm.baseUrl, http, batchSize: 10, sleep: noSleep })
    assert.equal(r.items.length, 1)
    assert.equal(r.incomplete, true)
  })

  it('an unauthenticated search (redirect to login) is an error', async () => {
    const vm = createFakeVolleyManager()
    const jar = new CookieJar()
    await assert.rejects(
      fetchAllGames(jar, 'wrong', 'a', 'b', { fetch: vm.fetch, baseUrl: vm.baseUrl, http, sleep: noSleep }),
      /session not authenticated/
    )
  })
})

describe('createRedactor', () => {
  it('scrubs secrets, URL-encoded secrets and newlines', () => {
    const r = createRedactor(() => ['pw-S3cret!&=+', 'tok-123456', null, 'ab'])
    assert.equal(r('a pw-S3cret!&=+ b'), 'a [redacted] b')
    assert.equal(r(`x=${encodeURIComponent('pw-S3cret!&=+')}`), 'x=[redacted]')
    assert.equal(r(new Error('bad tok-123456\nline')), 'bad [redacted] line')
    assert.equal(r('ab stays'), 'ab stays', 'too-short secrets ignored')
  })
})
