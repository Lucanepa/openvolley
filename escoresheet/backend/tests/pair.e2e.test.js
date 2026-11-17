/**
 * Pair a phone on the cloud backend (DATABASE_URL, docs/phone-keyboard-spec.md):
 * who may start (a scorer, referee or admin account, as Sign on phone) and
 * for which match (one the account writes: its stored teams reach the phone),
 * the shared HTTP scenario with a scorer's session, CORS of the app origins,
 * the phone page, OV_PAIR_DISABLED, and that no secret, code, context or
 * typed text reaches the server output.
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
import { pairHttpScenario, pairPageCheck } from '../../frontend/electron/__fixtures__/pairHttpScenario.mjs'

const PASSWORD = 'correct-horse-battery'
const CTX = { home: 'VBC Musterdorf', away: 'Volley 05' }
const MARKER = 'Marker Typed Qz7'

describe('Pair a phone, cloud backend', { skip: SKIP }, () => {
  let db, srv, sql, storageRoot, statusDir
  let ipSeq = 10
  const nextIp = () => `203.0.113.${ipSeq++}`
  const users = {}
  const secrets = []

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

  async function storedMatch (owner, { home = CTX.home, away = CTX.away, gameN = null } = {}) {
    const ext = `pair_${randomBytes(4).toString('hex')}`
    await sql.query(`INSERT INTO public.matches (external_id, status, created_by, sport_type, game_n, home_team, away_team) VALUES ($1, 'live', $2, 'indoor', $3, $4, $5)`,
      [ext, owner.id, gameN, JSON.stringify({ name: home }), JSON.stringify({ name: away })])
    return ext
  }
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
    u.match = await storedMatch(u)
    users[name] = u
    return u
  }
  const start = (user, body = { matchKey: user?.match, context: CTX }) =>
    api(srv.base, '/api/pair/start', { token: user?.token, body, proto: null, headers: { 'cf-connecting-ip': user?.ip || '203.0.113.250' } })
  const call = (endpoint, body, ip = '198.51.100.7') => api(srv.base, `/api/pair/${endpoint}`, { body, proto: null, headers: { 'cf-connecting-ip': ip } })
  const code = (r, status, c) => {
    assert.equal(r.status, status, r.text)
    if (c) assert.equal(r.json?.code, c, r.text)
  }

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-pair-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-pair-status-'))
    writeFileSync(join(statusDir, 'last_backup'), new Date().toISOString())
    srv = await bootServer(env())
    await account('pending')
    await account('scorer', ['scorer'])
    await account('referee', ['referee'])
    await account('manager', ['competition_manager'])
  })

  after(async () => {
    await srv?.stop()
    await sql?.end().catch(() => {})
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
    if (statusDir) rmSync(statusDir, { recursive: true, force: true })
  })

  it('start needs a session of a scorer, referee or admin account', async () => {
    code(await start(null), 401, 'OV_AUTH_REQUIRED')
    code(await start(users.pending), 403, 'OV_PAIR_FORBIDDEN')
    code(await start(users.manager), 403, 'OV_PAIR_FORBIDDEN')
    for (const who of ['scorer', 'referee']) {
      const r = await start(users[who])
      code(r, 201)
      secrets.push(r.json.token, r.json.watch, r.json.code)
      await call('close', { watch: r.json.watch })
    }
  })

  it('start names a stored match the account writes; the phone sees its stored teams', async () => {
    const theirs = await storedMatch(users.referee, { home: 'Stored Home', away: 'Stored Away', gameN: 4242 })
    for (const matchKey of [theirs, 'not-synced-yet', undefined]) {
      code(await start(users.scorer, { matchKey, context: { home: 'Made Up', away: 'Names' } }), 403, 'OV_PAIR_MATCH')
    }
    const r = await start(users.referee, { matchKey: theirs, context: { home: 'Made Up', away: 'Names', matchNo: '1' } })
    code(r, 201)
    secrets.push(r.json.token, r.json.watch, r.json.code)
    const joined = await call('join', { code: r.json.code })
    code(joined, 200)
    secrets.push(joined.json.phone)
    assert.deepEqual(joined.json.context, { matchNo: '4242', home: 'Stored Home', away: 'Stored Away' })
    await call('close', { watch: r.json.watch })
  })

  it('the phone needs no account, and the whole flow works over HTTP', async () => {
    const failures = await pairHttpScenario({
      httpBase: srv.base,
      matchKey: await storedMatch(users.scorer, { gameN: 4711 }),
      context: { ...CTX, matchNo: '1' },
      expectContext: { ...CTX, matchNo: '4711' },
      startHeaders: { Authorization: `Bearer ${users.scorer.token}`, 'cf-connecting-ip': users.scorer.ip }
    })
    assert.deepEqual(failures, [])
  })

  it('CORS: the app origin may call start, an unknown origin may not', async () => {
    const pre = (origin) => fetch(`${srv.base}/api/pair/start`, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' }
    })
    const ok = await pre('https://app.openvolley.app')
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://app.openvolley.app')
    const bad = await pre('https://evil.example')
    assert.notEqual(bad.headers.get('access-control-allow-origin'), 'https://evil.example')
    assert.notEqual(bad.headers.get('access-control-allow-origin'), '*')
  })

  it('serves the phone page with its CSP', async () => {
    assert.deepEqual(await pairPageCheck({ httpBase: srv.base, expectBody: 'OpenVolley' }), [])
  })

  it('no secret, code, context or typed text in the server output', async () => {
    const r = await start(users.scorer)
    code(r, 201)
    const j = await call('join', { k: r.json.token })
    secrets.push(r.json.token, r.json.watch, r.json.code, j.json.phone)
    await call('focus', { watch: r.json.watch, field: { id: 'f', label: MARKER, text: MARKER } })
    code(await call('input', { phone: j.json.phone, n: 1, field: 'f', text: `${MARKER} more` }), 200)
    await call('close', { watch: r.json.watch })
    await sleep(200)
    const out = srv.output.join('')
    assert.ok(/pair\.start ref=[0-9a-f]{8} via=cloud/.test(out), 'transitions are logged')
    for (const s of secrets) assert.ok(!out.includes(s), 'a pair secret or code reached the server output')
    for (const marker of [MARKER, 'Musterdorf', 'Stored Home']) assert.ok(!out.includes(marker), `${marker} reached the server output`)
  })

  it('OV_PAIR_DISABLED=1 switches it off', async () => {
    const off = await bootServer(env({ OV_PAIR_DISABLED: '1' }))
    try {
      const r = await api(off.base, '/api/pair/start', { token: users.scorer.token, body: { context: CTX }, proto: null, headers: { 'cf-connecting-ip': users.scorer.ip } })
      code(r, 503, 'OV_PAIR_UNAVAILABLE')
      code(await api(off.base, '/api/pair/join', { body: { code: 'ABCDEFGH' }, proto: null }), 503, 'OV_PAIR_UNAVAILABLE')
    } finally {
      await off.stop()
    }
  })
})
