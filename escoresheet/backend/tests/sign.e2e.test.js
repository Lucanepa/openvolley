/**
 * Sign on phone on the cloud backend (DATABASE_URL, docs/qr-signing-spec.md
 * 8.1): who may start (D2), the shared HTTP scenario with a scorer's session,
 * context sanitising, the start limit, CORS of the app origins, the phone
 * page, OV_SIGN_DISABLED, and that no secret, stroke, context or PIN ever
 * reaches the server output.
 *
 * Needs PG_TEST_URL (a throwaway Postgres, see tests/helpers/pgTestDb.js) or
 * OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'
import { signHttpScenario, signPageCheck } from '../../frontend/electron/__fixtures__/signHttpScenario.mjs'

const PASSWORD = 'correct-horse-battery'
const MARKER_NAME = 'Marker Signer Zx9'
const CTX = { home: 'VBC Wiedikon', away: 'Volley 05' }
const INK = { pad: { w: 4000, h: 2000 }, strokes: [[0, 1888, 300, 1888]] }

describe('Sign on phone, cloud backend', { skip: SKIP }, () => {
  let db, srv, sql, storageRoot, statusDir
  let ipSeq = 10
  const nextIp = () => `203.0.113.${ipSeq++}`
  const users = {}
  const tokensSeen = []

  const env = (extra = {}) => ({
    DATABASE_URL: db.url,
    STORAGE_ROOT: storageRoot,
    STATUS_DIR: statusDir,
    TRUST_PROXY: 'cloudflare',
    TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
    OV_PIN_SECRET: 'p'.repeat(48),
    STORAGE_BACKUP_MIN_FREE_MB: '1',
    STORAGE_SCORESHEETS_MIN_FREE_MB: '1',
    ...extra
  })

  async function account (name, roles = null) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const ip = nextIp()
    const up = await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password: PASSWORD, metadata: { first_name: name, last_name: 'Test' } } })
    assert.equal(up.status, 200, up.text)
    let inn
    for (let attempt = 0; attempt < 10; attempt++) {
      inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password: PASSWORD } })
      if (!(inn.status === 503 && inn.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    assert.equal(inn.status, 200, inn.text)
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, ip }
    if (roles) await grantRoles(sql, u.id, roles)
    users[name] = u
    return u
  }
  const start = (user, body = { slot: 'scorer', matchKey: 'm1', context: CTX }, headers = {}) =>
    api(srv.base, '/api/sign/start', { token: user?.token, body, proto: null, headers: { 'cf-connecting-ip': user?.ip || '203.0.113.250', ...headers } })
  const phone = (endpoint, body, ip = '198.51.100.7') =>
    api(srv.base, `/api/sign/${endpoint}`, { body, proto: null, headers: { 'cf-connecting-ip': ip } })
  const code = (r, status, c) => {
    assert.equal(r.status, status, r.text)
    if (c) assert.equal(r.json?.code, c, r.text)
  }

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-sign-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-sign-status-'))
    writeFileSync(join(statusDir, 'last_backup'), new Date().toISOString())
    srv = await bootServer(env())
    await account('pending')
    await account('scorer', ['scorer'])
    await account('referee', ['referee'])
    await account('beachScorer', ['beach:scorer'])
    await account('admin', ['admin'])
    await account('manager', ['competition_manager'])
  })

  after(async () => {
    await srv?.stop()
    await sql?.end().catch(() => {})
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
    if (statusDir) rmSync(statusDir, { recursive: true, force: true })
  })

  it('start needs a session: 401 without one or with a bad one', async () => {
    code(await start(null), 401, 'OV_AUTH_REQUIRED')
    code(await start({ token: 'x'.repeat(40), ip: nextIp() }), 401, 'OV_AUTH_REQUIRED')
  })

  it('start needs a scorer, referee or admin account (D2)', async () => {
    code(await start(users.pending), 403, 'OV_SIGN_FORBIDDEN')
    code(await start(users.manager), 403, 'OV_SIGN_FORBIDDEN')
    for (const who of ['scorer', 'referee', 'beachScorer', 'admin']) {
      const r = await start(users[who])
      code(r, 201)
      tokensSeen.push(r.json.token, r.json.watch)
      await phone('close', { watch: r.json.watch })
    }
  })

  it('the phone needs no account, and the full flow works over HTTP', async () => {
    const failures = await signHttpScenario({
      httpBase: srv.base,
      startHeaders: { Authorization: `Bearer ${users.scorer.token}`, 'cf-connecting-ip': users.scorer.ip }
    })
    assert.deepEqual(failures, [])
  })

  it('sanitises the context the phone sees, and hands out nothing else', async () => {
    const r = await start(users.referee, {
      slot: 'ref1',
      matchKey: 'm-ctx',
      context: { home: '‮VBC\u0000 Wiedikon⁦', away: 'v'.repeat(70), name: MARKER_NAME, when: '12.10.2026 20:15', lang: 'fr', userId: users.referee.id, gamePin: '123456' }
    })
    code(r, 201)
    tokensSeen.push(r.json.token, r.json.watch)
    const open = await phone('open', { k: r.json.token })
    code(open, 200)
    assert.deepEqual(open.json.context, { home: 'VBC Wiedikon', away: 'v'.repeat(60), name: MARKER_NAME, when: '12.10.2026 20:15', lang: 'fr' })
    assert.deepEqual(Object.keys(open.json).sort(), ['context', 'expiresAt', 'ok', 'slot', 'state'])
    assert.ok(!open.text.includes(users.referee.id) && !open.text.includes('123456'))
    code(await phone('submit', { k: r.json.token, ...INK }), 200)
    const done = await phone('wait', { watch: r.json.watch, known: 'opened' })
    assert.deepEqual(done.json.strokes, INK.strokes)
    assert.ok(!done.text.includes(users.referee.id))
    code(await phone('close', { watch: r.json.watch }), 200)
  })

  it('OpenBeach: a session of a beach match opens with app beach (the page shows OpenBeach), indoor and unknown ones without', async () => {
    const insertMatch = async (sport) => {
      const ext = `sign_${sport}_${randomBytes(4).toString('hex')}`
      await sql.query('INSERT INTO public.matches (external_id, status, created_by, sport_type) VALUES ($1, $2, $3, $4)', [ext, 'live', users.admin.id, sport])
      return ext
    }
    const beachExt = await insertMatch('beach')
    const indoorExt = await insertMatch('indoor')
    const both = await account('bothSigner', ['scorer', 'beach:scorer'])
    const appOf = async (user, body) => {
      const r = await start(user, { slot: 'ref1', context: CTX, ...body })
      code(r, 201)
      tokensSeen.push(r.json.token, r.json.watch)
      // the starter learns nothing new (the same answer as before)
      assert.deepEqual(Object.keys(r.json).sort(), ['expiresAt', 'ok', 'path', 'token', 'ttlSeconds', 'watch'])
      const open = await phone('open', { k: r.json.token })
      code(open, 200)
      await phone('close', { watch: r.json.watch })
      return open.json.app ?? null
    }
    // by the match's sport, whoever starts it
    assert.equal(await appOf(users.beachScorer, { matchKey: beachExt }), 'beach')
    assert.equal(await appOf(both, { matchKey: beachExt }), 'beach')
    assert.equal(await appOf(users.admin, { matchKey: beachExt }), 'beach')
    assert.equal(await appOf(both, { matchKey: indoorExt }), null)
    assert.equal(await appOf(users.scorer, { matchKey: indoorExt }), null)
    // the body cannot choose it
    assert.equal(await appOf(users.scorer, { matchKey: indoorExt, app: 'beach' }), null)
    // a match the server does not have yet: a beach-only account is OpenBeach's
    assert.equal(await appOf(users.beachScorer, { matchKey: 'not-synced-yet' }), 'beach')
    assert.equal(await appOf(users.beachScorer, {}), 'beach')
    assert.equal(await appOf(both, { matchKey: 'not-synced-yet' }), null)
    assert.equal(await appOf(users.referee, {}), null)
    // the token checks are as before: a wrong token is 404 and names no app
    const bad = await phone('open', { k: 'B'.repeat(43) })
    code(bad, 404, 'OV_SIGN_NOT_FOUND')
    assert.equal(bad.json.app, undefined)
    // the one page carries both marks; sign.js shows the one open names
    const page = await fetch(`${srv.base}/sign`)
    const html = await page.text()
    assert.ok(html.includes('<header class="brand" data-app="openvolley">'))
    assert.ok(html.includes('<header class="brand" data-app="beach" hidden>'))
    assert.ok(html.includes('<span>OpenBeach</span>'))
    assert.ok((await (await fetch(`${srv.base}/sign/sign.js`)).text()).includes("APP_NAMES = { beach: 'OpenBeach' }"))
  })

  it('submit over 64 KB: 413', async () => {
    const r = await start(users.scorer)
    code(r, 201)
    tokensSeen.push(r.json.token, r.json.watch)
    const raw = JSON.stringify({ k: r.json.token, pad: INK.pad, strokes: [[0, 0]], pad2: 'x'.repeat(65536) })
    const res = await fetch(`${srv.base}/api/sign/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw })
    assert.equal(res.status, 413)
    assert.equal((await res.json()).code, 'OV_SIGN_TOO_LARGE')
    // just under: read, then refused for its content
    const under = JSON.stringify({ k: r.json.token, pad: INK.pad, strokes: [[0, 0]], x: 'x'.repeat(65536 - 200) })
    assert.ok(under.length <= 65536)
    code(await phone('submit', JSON.parse(under)), 400, 'OV_SIGN_INK_INVALID')
    await phone('close', { watch: r.json.watch })
  })

  it('30 starts per account and 5 minutes, then 429 with Retry-After', async () => {
    const u = await account('busyScorer', ['scorer'])
    for (let i = 0; i < 30; i++) {
      const r = await start(u)
      code(r, 201)
      tokensSeen.push(r.json.token, r.json.watch)
      await phone('close', { watch: r.json.watch }) // live sessions stay under 20
    }
    const r = await start(u)
    code(r, 429, 'OV_SIGN_RATE_LIMITED')
    assert.ok(Number(r.headers.get('retry-after')) > 0)
    // Another account is not affected
    code(await start(users.admin), 201)
  })

  it('20 live sessions per account', async () => {
    const u = await account('manyScorer', ['scorer'])
    const watches = []
    for (let i = 0; i < 20; i++) {
      const r = await start(u)
      code(r, 201)
      tokensSeen.push(r.json.token, r.json.watch)
      watches.push(r.json.watch)
    }
    code(await start(u), 429, 'OV_SIGN_RATE_LIMITED')
    for (const watch of watches) await phone('close', { watch })
    code(await start(u), 201)
  })

  it('the phone calls are limited per IP (120 per 5 minutes)', async () => {
    const ip = '198.51.100.200'
    let last
    for (let i = 0; i < 121; i++) last = await phone('open', { k: 'A'.repeat(43) }, ip)
    code(last, 429, 'OV_SIGN_RATE_LIMITED')
    code(await phone('open', { k: 'A'.repeat(43) }, '198.51.100.201'), 404, 'OV_SIGN_NOT_FOUND')
  })

  it('CORS: the app origin may call start, an unknown origin may not', async () => {
    const pre = (origin) => fetch(`${srv.base}/api/sign/start`, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' }
    })
    const ok = await pre('https://app.openvolley.app')
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://app.openvolley.app')
    assert.match(ok.headers.get('access-control-allow-headers') || '', /Authorization/)
    const bad = await pre('https://evil.example')
    assert.notEqual(bad.headers.get('access-control-allow-origin'), 'https://evil.example')
    assert.notEqual(bad.headers.get('access-control-allow-origin'), '*')
  })

  it('serves the phone page with its CSP', async () => {
    assert.deepEqual(await signPageCheck({ httpBase: srv.base, expectBody: 'OpenVolley' }), [])
  })

  it('no token, watch secret, stroke, context or PIN in the server output', async () => {
    await sleep(200)
    const out = srv.output.join('')
    assert.ok(/sign\.start ref=[0-9a-f]{8} slot=\S+ via=cloud/.test(out), 'transitions are logged')
    assert.ok(tokensSeen.length > 40)
    for (const secret of tokensSeen) assert.ok(!out.includes(secret), 'a sign secret reached the server output')
    for (const marker of [MARKER_NAME, '1888', '123456', 'Wiedikon']) assert.ok(!out.includes(marker), `${marker} reached the server output`)
  })

  it('OV_SIGN_DISABLED=1 switches it off', async () => {
    const off = await bootServer(env({ OV_SIGN_DISABLED: '1' }))
    try {
      const r = await api(off.base, '/api/sign/start', { token: users.scorer.token, body: { slot: 'scorer', context: CTX }, proto: null, headers: { 'cf-connecting-ip': users.scorer.ip } })
      code(r, 503, 'OV_SIGN_UNAVAILABLE')
      const o = await api(off.base, '/api/sign/open', { body: { k: 'A'.repeat(43) }, proto: null })
      code(o, 503, 'OV_SIGN_UNAVAILABLE')
    } finally {
      await off.stop()
    }
  })
})
