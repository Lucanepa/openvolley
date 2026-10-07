/**
 * Approval with an account, end to end through server.js
 * (docs/account-approval-spec.md 6.1): the HTTP flow with its rate limits,
 * the /api/approvals prefix next to the relay's GET /api/match/:id, no
 * /api/db or live-socket access to match_approvals, secret hygiene of the
 * server output and the audit log, and the server without OV_PIN_SECRET.
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
import { SKIP, bootServer, api, provisionDatabase, sleep, openSocket } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'

const PIN_SECRET = 'x'.repeat(40)
const PASSWORD = 'correct-horse-battery'
// Marker values of the hygiene check: they must never reach the server output or the audit log
const MARKER_PIN = '804613'
const MARKER_PASSWORD = 'Pw-marker-7c1e'
const SETS = [[1, 25, 20], [2, 23, 25], [3, 25, 18]]

describe('account approvals end to end', { skip: SKIP }, () => {
  let db, srv, sql, storageRoot, statusDir
  let ipSeq = 10
  const nextIp = () => `203.0.113.${ipSeq++}`
  const users = {}
  let gameSeq = 72100

  const env = () => ({
    DATABASE_URL: db.url,
    STORAGE_ROOT: storageRoot,
    STATUS_DIR: statusDir,
    TRUST_PROXY: 'cloudflare',
    TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
    STORAGE_BACKUP_MIN_FREE_MB: '1',
    STORAGE_SCORESHEETS_MIN_FREE_MB: '1'
  })

  async function account (name, { first = name, last = 'Test', roles = null, password = PASSWORD } = {}) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const ip = nextIp()
    const up = await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password, metadata: { first_name: first, last_name: last } } })
    assert.equal(up.status, 200, up.text)
    let inn
    for (let attempt = 0; attempt < 10; attempt++) {
      inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password } })
      if (!(inn.status === 503 && inn.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    assert.equal(inn.status, 200, inn.text)
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, email, ip, password }
    if (roles) await grantRoles(sql, u.id, roles)
    users[name] = u
    return u
  }
  const call = (user, method, path, body, headers = {}) =>
    api(srv.base, path, { method, token: user?.token, body, proto: null, headers: { 'cf-connecting-ip': user?.ip || '203.0.113.250', ...headers } })
  const expectCode = (r, status, code) => {
    assert.equal(r.status, status, r.text)
    assert.equal(r.json?.error?.code, code, r.text)
  }
  async function endedMatch (owner) {
    const ext = `e2e_appr_${randomBytes(4).toString('hex')}`
    const { rows: [m] } = await sql.query(
      "INSERT INTO public.matches (external_id, status, created_by, game_n, sport_type) VALUES ($1, 'ended', $2, $3, 'indoor') RETURNING id",
      [ext, owner.id, gameSeq++])
    for (const [i, h, a] of SETS) await sql.query('INSERT INTO public.sets (match_id, index, home_points, away_points, finished) VALUES ($1, $2, $3, $4, true)', [m.id, i, h, a])
    return { id: m.id, ext }
  }
  const approveBody = (m, slot, official, pin) => ({ external_id: m.ext, slot, email: official.email, pin, result: { sets: SETS } })

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-approval-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-approval-status-'))
    writeFileSync(join(statusDir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
    srv = await bootServer({ ...env(), OV_PIN_SECRET: PIN_SECRET })
    await account('owner', { first: 'Olga', last: 'Owner', roles: ['scorer'] })
    await account('ref1', { first: 'Anna', last: 'Muster', roles: ['referee'], password: MARKER_PASSWORD })
    await account('ref2', { first: 'Ben', last: 'Beispiel', roles: ['referee'] })
    await account('admin', { first: 'Ada', last: 'Admin', roles: ['admin'] })
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
    if (statusDir) rmSync(statusDir, { recursive: true, force: true })
  })

  it('sets a PIN, approves, lists and undoes over HTTP (no-store, the relay does not swallow the GET)', async () => {
    const { owner, ref1, ref2 } = users
    const st = await call(ref1, 'GET', '/api/account/approval-pin')
    assert.equal(st.status, 200, st.text)
    assert.equal(st.headers.get('cache-control'), 'no-store')
    assert.deepEqual(st.json.data, { available: true, eligible: true, set: false, set_at: null, locked_until: null, disabled: false })
    expectCode(await call(ref1, 'POST', '/api/account/approval-pin', { password: 'wrong-one', pin: MARKER_PIN }), 403, 'OV_PASSWORD_INVALID')
    const set = await call(ref1, 'POST', '/api/account/approval-pin', { password: MARKER_PASSWORD, pin: MARKER_PIN })
    assert.equal(set.status, 200, set.text)
    assert.equal((await call(ref2, 'POST', '/api/account/approval-pin', { password: PASSWORD, pin: '730164' })).status, 200)
    expectCode(await call(owner, 'GET', '/api/account/approval-pin/remove'), 405, 'OV_METHOD_NOT_ALLOWED')
    // no session: 401
    assert.equal((await api(srv.base, '/api/account/approval-pin', { method: 'GET', proto: null })).status, 401)

    const m = await endedMatch(owner)
    // a wrong PIN (the marker, but for another official) and the right one
    expectCode(await call(owner, 'POST', '/api/approvals', approveBody(m, 'referee2', ref2, MARKER_PIN)), 403, 'OV_APPROVAL_PIN_INVALID')
    const ok = await call(owner, 'POST', '/api/approvals', { ...approveBody(m, 'referee1', ref1, MARKER_PIN), device_id: '6f1c2a9b-0000-4000-8000-000000000001' })
    assert.equal(ok.status, 200, ok.text)
    assert.equal(ok.headers.get('cache-control'), 'no-store')
    const rec = ok.json.data.approval
    assert.equal(rec.name, 'Muster Anna')
    assert.equal(rec.slot, 'referee1')

    const list = await call(owner, 'GET', `/api/approvals?external_id=${encodeURIComponent(m.ext)}`)
    assert.equal(list.status, 200, list.text)
    assert.deepEqual(list.json.data.approvals.map((a) => a.id), [rec.id])
    assert.equal(list.json.data.match.status, 'ended')
    const own = await call(ref1, 'GET', `/api/approvals?external_id=${encodeURIComponent(m.ext)}`)
    assert.equal(own.json.data.approvals[0].mine, true)

    // the admin search finds it by the short id on the PDF
    const adm = await call(users.admin, 'GET', `/api/admin/approvals?q=${rec.short_id}`)
    assert.equal(adm.status, 200, adm.text)
    assert.equal(adm.json.data.approvals[0].email, ref1.email)
    expectCode(await call(owner, 'GET', `/api/admin/approvals?q=${rec.short_id}`), 403, 'OV_FORBIDDEN')
    // the admin match list carries it
    const ml = await call(users.admin, 'GET', '/api/admin/matches?state=open')
    assert.deepEqual(ml.json.data.matches.find((x) => x.external_id === m.ext).approvals.map((a) => a.short_id), [rec.short_id])

    const undo = await call(owner, 'DELETE', `/api/approvals/${rec.id}`)
    assert.equal(undo.status, 200, undo.text)
    assert.equal(undo.json.data.approval.revoked_reason, 'undo')
    expectCode(await call(owner, 'DELETE', '/api/approvals/not-an-id'), 404, 'OV_NOT_FOUND')
  })

  it('review fix: a scorer with the referee role cannot approve a referee slot under a borrowed name; the official lists their approvals', async () => {
    const dual = await account('dualE2e', { first: 'Dora', last: 'Doppel', roles: ['scorer', 'referee'] })
    assert.equal((await call(dual, 'POST', '/api/account/approval-pin', { password: PASSWORD, pin: '583027' })).status, 200)
    const m = await endedMatch(dual)
    const rename = await api(srv.base, '/api/db', {
      token: dual.token,
      headers: { 'cf-connecting-ip': dual.ip },
      body: { table: 'profiles', action: 'update', params: { data: { first_name: 'Anna', last_name: 'Muster' }, filters: [{ type: 'eq', column: 'user_id', value: dual.id }] } }
    })
    assert.equal(rename.status, 200, rename.text)
    expectCode(await call(dual, 'POST', '/api/approvals', approveBody(m, 'referee1', dual, '583027')), 403, 'OV_APPROVAL_SCORER_NOT_REFEREE')
    assert.equal((await sql.query('SELECT count(*)::int AS n FROM public.match_approvals WHERE match_id = $1', [m.id])).rows[0].n, 0)
    // a malformed PIN is a 400, not a counted failure
    expectCode(await call(dual, 'POST', '/api/approvals', approveBody(m, 'referee1', users.ref1, '123')), 400, 'OV_APPROVAL_PIN_FORMAT')
    // the real referee approves; the referee sees it in their own list
    const ok = await call(dual, 'POST', '/api/approvals', approveBody(m, 'referee1', users.ref1, MARKER_PIN))
    assert.equal(ok.status, 200, ok.text)
    const mine = await call(users.ref1, 'GET', '/api/account/approvals')
    assert.equal(mine.status, 200, mine.text)
    assert.equal(mine.headers.get('cache-control'), 'no-store')
    const rec = mine.json.data.approvals.find((a) => a.id === ok.json.data.approval.id)
    assert.ok(rec, mine.text)
    assert.equal(rec.requested_by_name, 'Anna Muster', 'the sender as their profile says now')
    assert.equal(rec.match.external_id, m.ext)
    expectCode(await call(users.ref1, 'POST', '/api/account/approvals', {}), 405, 'OV_METHOD_NOT_ALLOWED')
  })

  it('/api/db cannot read match_approvals and live sockets never carry it', async () => {
    const { owner, ref1 } = users
    const m = await endedMatch(owner)
    const live = await openSocket(`${srv.wsUrl}/?purpose=live`)
    try {
      live.send({ type: 'subscribe-db', id: 'appr', subs: [{ table: 'match_approvals', event: '*' }] })
      const ack = await live.waitFor((x) => x.id === 'appr', 5000, 'subscribe ack')
      assert.equal(ack.type, 'subscribe-db-error', JSON.stringify(ack))
      live.send({ type: 'subscribe-db', id: 'm', subs: [{ table: 'matches', event: '*', column: 'external_id', value: m.ext }] })
      await live.waitFor((x) => x.id === 'm' && x.type === 'subscribe-db-ack', 5000, 'matches ack')

      const ok = await call(owner, 'POST', '/api/approvals', approveBody(m, 'referee1', ref1, MARKER_PIN))
      assert.equal(ok.status, 200, ok.text)
      for (const who of [owner, null]) {
        const r = await api(srv.base, '/api/db', { token: who?.token, proto: null, body: { table: 'match_approvals', action: 'select', params: { columns: '*' } } })
        assert.equal(r.status, 400, r.text)
        assert.equal(r.json.data, null)
        assert.ok(['OV_TABLE_NOT_ALLOWED', 'OV_INVALID_REQUEST'].includes(r.json.error.code), r.text)
        assert.equal(r.text.includes('Muster'), false)
      }
      await sleep(300)
      assert.equal(live.raw.some((t) => t.includes('match_approvals') && !t.includes('subscribe-db-error')), false)
      assert.equal(live.raw.some((t) => t.includes('Muster Anna')), false)
    } finally {
      live.ws.close()
    }
  })

  it('limits: the 11th wrong PIN of a caller is 429; a success is refunded', async () => {
    const caller = await account('limitOwner', { first: 'Lim', last: 'Owner', roles: ['scorer'] })
    const m = await endedMatch(caller)
    const m2 = await endedMatch(caller)
    const ghost = (match) => ({ ...approveBody(match, 'referee2', { email: 'ghost@example.ch' }, '111112') })
    for (let i = 0; i < 9; i++) expectCode(await call(caller, 'POST', '/api/approvals', ghost(m)), 403, 'OV_APPROVAL_PIN_INVALID')
    // a success and other refusals are refunded
    assert.equal((await call(caller, 'POST', '/api/approvals', approveBody(m2, 'referee1', users.ref1, MARKER_PIN))).status, 200)
    expectCode(await call(caller, 'POST', '/api/approvals', { ...ghost(m), slot: 'nope' }), 400, 'OV_INVALID_REQUEST')
    expectCode(await call(caller, 'POST', '/api/approvals', ghost(m)), 403, 'OV_APPROVAL_PIN_INVALID') // the 10th failure
    const limited = await call(caller, 'POST', '/api/approvals', ghost(m))
    expectCode(limited, 429, 'OV_TOO_MANY_ATTEMPTS')
    assert.equal(limited.headers.get('retry-after'), '600')
    // the GET of the same family is not part of this budget
    assert.equal((await call(caller, 'GET', `/api/approvals?external_id=${encodeURIComponent(m2.ext)}`)).status, 200)

    // wrong passwords on set PIN: 5 per 15 minutes
    const pw = await account('pwRef', { roles: ['referee'] })
    for (let i = 0; i < 5; i++) expectCode(await call(pw, 'POST', '/api/account/approval-pin', { password: `bad-${i}`, pin: '518203' }), 403, 'OV_PASSWORD_INVALID')
    const pwLimited = await call(pw, 'POST', '/api/account/approval-pin', { password: PASSWORD, pin: '518203' })
    expectCode(pwLimited, 429, 'OV_TOO_MANY_ATTEMPTS')
    assert.equal(pwLimited.headers.get('retry-after'), '900')
  })

  it('secret hygiene: no marker PIN or password in the server output or the audit log', async () => {
    const out = srv.output.join('')
    assert.ok(out.length > 0)
    for (const marker of [MARKER_PIN, MARKER_PASSWORD]) {
      assert.equal(out.includes(marker), false, `server output contains ${marker}`)
    }
    const { rows } = await sql.query('SELECT action, details::text AS d FROM public.audit_log')
    assert.ok(rows.some((r) => r.action === 'match.approve'))
    assert.ok(rows.some((r) => r.action === 'approval_pin.set'))
    for (const r of rows) {
      for (const marker of [MARKER_PIN, MARKER_PASSWORD]) assert.equal(r.d.includes(marker), false, `${r.action} details contain ${marker}`)
      assert.equal(r.d.includes(users.ref1.email), false)
    }
  })

  it('without OV_PIN_SECRET every endpoint is 503 OV_APPROVAL_UNAVAILABLE; the status says unavailable', async () => {
    const off = await bootServer({ ...env(), OV_PIN_SECRET: '' })
    try {
      const { owner, ref1 } = users
      const c = (method, path, body) => api(off.base, path, { method, token: owner.token, body, proto: null, headers: { 'cf-connecting-ip': '203.0.113.240' } })
      const st = await c('GET', '/api/account/approval-pin')
      assert.equal(st.status, 200, st.text)
      assert.deepEqual(st.json.data, { available: false, eligible: false, set: false, set_at: null, locked_until: null, disabled: false })
      expectCode(await c('POST', '/api/account/approval-pin', { password: PASSWORD, pin: '518203' }), 503, 'OV_APPROVAL_UNAVAILABLE')
      expectCode(await c('POST', '/api/account/approval-pin/remove', { password: PASSWORD }), 503, 'OV_APPROVAL_UNAVAILABLE')
      const m = await endedMatch(owner)
      expectCode(await c('POST', '/api/approvals', approveBody(m, 'referee1', ref1, MARKER_PIN)), 503, 'OV_APPROVAL_UNAVAILABLE')
      expectCode(await c('GET', `/api/approvals?external_id=${encodeURIComponent(m.ext)}`), 503, 'OV_APPROVAL_UNAVAILABLE')
      expectCode(await c('DELETE', '/api/approvals/6f1c2a9b-0000-4000-8000-000000000001'), 503, 'OV_APPROVAL_UNAVAILABLE')
      assert.ok(off.output.join('').includes('approval with an account is off'))
    } finally {
      await off.stop()
    }
  })
})
