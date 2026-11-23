/**
 * PERM-14 (audit 2611): POST /api/account/invite-preview and redeem-invite.
 * Before, only the attempt limiter guarded them (10 per 10 minutes per
 * account and per address, counted up front, refunded on a 200): a sequence
 * of successful calls was unlimited (a DB transaction each), and a burst of
 * parallel calls left the refused ones counted, so one double-tap or a few
 * typos locked every account behind the hall's Wi-Fi for 10 minutes. Now:
 *   - every call counts in a per-account bucket of ACCOUNT_RATE_LIMIT_MAX (30)
 *     a minute (429, Retry-After 60);
 *   - only failures (a code refused) count towards the lock; a success, a
 *     refused call and a server error are refunded;
 *   - the address has a higher ceiling (50 failures) than an account (10).
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js) or OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'

describe('invite preview / redeem limits (PERM-14)', { skip: SKIP }, () => {
  let db, srv, sql, code
  let ipSeq = 1
  const nextIp = () => `198.51.100.${ipSeq++}`
  const users = {}
  const PASSWORD = 'correct-horse-battery'

  async function account (name, roles = []) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const ip = nextIp()
    const up = await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password: PASSWORD, metadata: { first_name: name } } })
    assert.equal(up.status, 200, up.text)
    let inn
    for (let attempt = 0; attempt < 10; attempt++) {
      inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password: PASSWORD } })
      if (!(inn.status === 503 && inn.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    assert.equal(inn.status, 200, inn.text)
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, email }
    if (roles.length) await grantRoles(sql, u.id, roles)
    users[name] = u
    return u
  }
  const preview = (user, c, ip) => api(srv.base, '/api/account/invite-preview', { token: user.token, body: { code: c }, proto: null, headers: { 'cf-connecting-ip': ip } })
  const redeem = (user, c, ip) => api(srv.base, '/api/account/redeem-invite', { token: user.token, body: { code: c }, proto: null, headers: { 'cf-connecting-ip': ip } })
  const wrong = (i) => `ZZZZ-ZZZZ-${String.fromCharCode(65 + (i % 20))}${String.fromCharCode(65 + Math.floor(i / 20) % 20)}ZZ`.replace(/[ILOU]/g, 'Z')

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    srv = await bootServer({ DATABASE_URL: db.appUrl(), TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' })
    await account('admin', ['admin'])
    const inv = await api(srv.base, '/api/admin/invites', { token: users.admin.token, proto: null, body: { label: 'Hall code', max_uses: 100 } })
    assert.equal(inv.status, 201, inv.text)
    code = inv.json.data.code
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
  })

  it('successful calls of one account: 30 a minute, then 429 (no unlimited loop)', async () => {
    const u = await account('looper')
    const ip = '203.0.113.10'
    for (let i = 0; i < 30; i++) {
      const r = await preview(u, code, ip)
      assert.equal(r.status, 200, `${i}: ${r.text}`)
      assert.equal(r.json.data.preview, true)
    }
    const over = await preview(u, code, ip)
    assert.equal(over.status, 429, over.text)
    assert.equal(over.headers.get('retry-after'), '60')
    // the bucket is the account's: another account at the same address goes on
    const other = await account('neighbour')
    assert.equal((await preview(other, code, ip)).status, 200)
  })

  it('a burst of parallel calls locks nobody behind the address', async () => {
    const tapper = await account('tapper')
    const ip = '203.0.113.20'
    const burst = await Promise.all(Array.from({ length: 30 }, () => preview(tapper, code, ip)))
    assert.ok(burst.some((r) => r.status === 200), JSON.stringify(burst.map((r) => r.status)))
    // a moment later another account at the hall redeems the code
    const next = await account('nextScorer')
    const r = await redeem(next, code, ip)
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.data.role_granted, 'scorer')
  })

  it('wrong codes: 10 lock the account, not the others at its address', async () => {
    const ip = '203.0.113.30'
    const brute = await account('brute')
    for (let i = 0; i < 10; i++) {
      const r = await redeem(brute, wrong(i), ip)
      assert.equal(r.status, 404, r.text)
      assert.equal(r.json.error.code, 'OV_INVITE_INVALID')
    }
    const locked = await redeem(brute, code, ip)
    assert.equal(locked.status, 429, locked.text)
    assert.equal(locked.json.error.code, 'OV_TOO_MANY_ATTEMPTS')
    assert.equal(locked.headers.get('retry-after'), '600')
    // another account at the same address: its own attempts
    const typo = await account('typo')
    assert.equal((await redeem(typo, wrong(50), ip)).status, 404)
    assert.equal((await redeem(typo, code, ip)).status, 200)
  })

  it('the address locks only after 50 failures, from several accounts', async () => {
    const ip = '203.0.113.40'
    let failures = 0
    for (let a = 0; a < 5; a++) {
      const u = await account(`guesser${a}`)
      for (let i = 0; i < 10; i++) {
        const r = await redeem(u, wrong(a * 10 + i), ip)
        assert.equal(r.status, 404, `${a}/${i}: ${r.text}`)
        failures++
      }
    }
    assert.equal(failures, 50)
    const late = await account('late')
    const r = await redeem(late, code, ip)
    assert.equal(r.status, 429, r.text)
    // elsewhere the same account is fine
    assert.equal((await redeem(late, code, '203.0.113.41')).status, 200)
  })
})
