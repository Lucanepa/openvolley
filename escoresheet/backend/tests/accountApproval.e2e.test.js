/**
 * Approval with an account is OFF (owner 27.11.2026: signatures only, the
 * approval PIN is being removed). server.js builds lib/approvals.js without a
 * secret even when OV_PIN_SECRET is set, so every approval endpoint answers
 * 503 OV_APPROVAL_UNAVAILABLE and the PIN status says unavailable; apps
 * already installed then show "feature off on the server" next to the
 * signature. The server still needs OV_PIN_SECRET (game PINs, match tokens).
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

const PIN_SECRET = 'x'.repeat(40)
const PASSWORD = 'correct-horse-battery'
// Marker values of the hygiene check: they must never reach the server output or the audit log
const MARKER_PIN = '804613'
const MARKER_PASSWORD = 'Pw-marker-7c1e'
const SETS = [[1, 25, 20], [2, 23, 25], [3, 25, 18]]

describe('account approvals are off end to end', { skip: SKIP }, () => {
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
  // The match setup's officials: the referees' addresses stored with the
  // match, which a referee approval is bound to
  const officialsOf = (ref1, ref2) => JSON.stringify([
    ...(ref1 ? [{ role: '1st referee', firstName: 'First', lastName: 'Referee', email: ref1.email }] : []),
    ...(ref2 ? [{ role: '2nd referee', firstName: 'Second', lastName: 'Referee', email: ref2.email }] : [])])
  const nameOfficials = (m, ref1, ref2) => sql.query('UPDATE public.matches SET officials = $2 WHERE id = $1', [m.id, officialsOf(ref1, ref2)])
  async function endedMatch (owner, { ref1 = users.ref1, ref2 = users.ref2 } = {}) {
    const ext = `e2e_appr_${randomBytes(4).toString('hex')}`
    const { rows: [m] } = await sql.query(
      "INSERT INTO public.matches (external_id, status, created_by, game_n, sport_type, officials) VALUES ($1, 'ended', $2, $3, 'indoor', $4) RETURNING id",
      [ext, owner.id, gameSeq++, officialsOf(ref1, ref2)])
    for (const [i, h, a] of SETS) await sql.query('INSERT INTO public.sets (match_id, index, home_points, away_points, finished) VALUES ($1, $2, $3, $4, true)', [m.id, i, h, a])
    return { id: m.id, ext }
  }
  const approveBody = (m, slot, official, pin) => ({ external_id: m.ext, slot, email: official.email, pin, result: { sets: SETS } })
  // An OpenBeach match as OpenBeach syncs it: team1_points / team2_points on beach sets
  const BEACH_SETS = [[1, 21, 19], [2, 18, 21], [3, 15, 12]]
  async function endedBeachMatch (owner) {
    const ext = `e2e_appr_beach_${randomBytes(4).toString('hex')}`
    const { rows: [m] } = await sql.query(
      "INSERT INTO public.matches (external_id, status, created_by, game_n, sport_type) VALUES ($1, 'ended', $2, $3, 'beach') RETURNING id",
      [ext, owner.id, gameSeq++])
    for (const [i, t1, t2] of BEACH_SETS) {
      await sql.query("INSERT INTO public.sets (match_id, index, team1_points, team2_points, finished, sport_type) VALUES ($1, $2, $3, $4, true, 'beach')", [m.id, i, t1, t2])
    }
    return { id: m.id, ext }
  }

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

  it('the PIN status says unavailable and every approval endpoint answers 503, although OV_PIN_SECRET is set', async () => {
    const { owner, ref1 } = users
    const st = await call(ref1, 'GET', '/api/account/approval-pin')
    assert.equal(st.status, 200, st.text)
    assert.equal(st.json.data.available, false)
    expectCode(await call(ref1, 'POST', '/api/account/approval-pin', { password: MARKER_PASSWORD, pin: MARKER_PIN }), 503, 'OV_APPROVAL_UNAVAILABLE')
    const m = await endedMatch(owner)
    expectCode(await call(owner, 'POST', '/api/approvals', approveBody(m, 'referee1', ref1, MARKER_PIN)), 503, 'OV_APPROVAL_UNAVAILABLE')
    const b = await endedBeachMatch(owner)
    expectCode(await call(owner, 'POST', '/api/approvals', approveBody(b, 'referee1', ref1, MARKER_PIN)), 503, 'OV_APPROVAL_UNAVAILABLE')
    const { rows: [n] } = await sql.query('SELECT count(*)::int AS n FROM public.match_approvals')
    assert.equal(n.n, 0)
  })

  it('without OV_PIN_SECRET the database backend still does not start (game PINs are never plaintext)', async () => {
    await assert.rejects(bootServer({ ...env(), OV_PIN_SECRET: '' }), /OV_PIN_SECRET is required/)
  })
})
