/**
 * The game PIN of a match in the manage console (owner 2026-11-15: "can i get
 * the match pin here? ... otherwise how can i reopen the game from thin air?"),
 * end to end with the production grants (ov_app, db/roles.sql) and a PIN
 * secret, as in production:
 *
 *   GET  /api/admin/matches/:id/pin   admins only, audited (match.pin_viewed,
 *                                     no PIN); a hashed PIN cannot be read back,
 *                                     a legacy plaintext one is shown
 *   POST /api/admin/matches/:id/pin   admins only: a new game PIN, answered once,
 *                                     stored hashed, audited (match.pin_reset);
 *                                     the scorer app's restore (game number +
 *                                     game PIN) finds the match with it, the old
 *                                     PIN no more; editors by the old PIN end
 *
 * The closed-match list and the other reads never carry a PIN.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'

const GAME_PIN = '582914'
const GAME_N = 9561

describe('the game PIN in the manage console', { skip: SKIP }, () => {
  let db, srv, sql
  let ipSeq = 1
  const nextIp = () => `198.51.100.${ipSeq++}`
  const users = {}
  const ext = `pin_${Date.now()}_${randomBytes(3).toString('hex')}`
  let matchId
  let newPin

  async function account (name, roles) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const password = 'correct-horse-battery'
    const ip = nextIp()
    const up = await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password } })
    assert.equal(up.status, 200, up.text)
    const inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password } })
    assert.equal(inn.status, 200, inn.text)
    const u = { id: inn.json.data.user.id, email, token: inn.json.data.session.access_token }
    await grantRoles(sql, u.id, roles)
    return u
  }
  const call = (user, method, path, body) => api(srv.base, path, { method, token: user?.token, body, proto: null, headers: { 'cf-connecting-ip': nextIp() } })
  const dbCall = (user, table, action, params) =>
    api(srv.base, '/api/db', { token: user?.token, proto: action === 'select' ? null : '2', body: { table, action, params } })
  const auditOf = async (action) => (await sql.query('SELECT actor_id, match_id, details FROM public.audit_log WHERE action = $1 ORDER BY id', [action])).rows
  const storedPin = async () => (await sql.query('SELECT game_pin FROM public.matches WHERE id = $1', [matchId])).rows[0]?.game_pin
  const restoreByPin = (pin) => api(srv.base, '/api/match/restore-by-pin', { proto: null, headers: { 'cf-connecting-ip': nextIp() }, body: { gameN: GAME_N, pin } })

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    srv = await bootServer({
      DATABASE_URL: db.appUrl(),
      TRUST_PROXY: 'cloudflare',
      TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
      OV_PIN_SECRET: randomBytes(32).toString('base64url')
    })
    users.scorer = await account('scorer', ['scorer'])
    users.taker = await account('taker', ['scorer']) // an editor by the game PIN
    users.helper = await account('helper', ['scorer']) // an editor an admin added
    users.manager = await account('manager', ['competition_manager'])
    users.admin = await account('admin', ['admin'])

    const ins = await dbCall(users.scorer, 'matches', 'upsert', {
      data: { external_id: ext, game_n: GAME_N, game_pin: GAME_PIN, status: 'live', sport_type: 'indoor', home_team: { name: 'Home VC' }, away_team: { name: 'Away VC' } },
      onConflict: 'external_id', returning: 'id', single: true
    })
    assert.equal(ins.status, 200, ins.text)
    matchId = ins.json.data.id
    const claim = await call(users.taker, 'POST', '/api/match/claim', { externalId: ext, pin: GAME_PIN })
    assert.equal(claim.status, 200, claim.text)
    const add = await call(users.admin, 'POST', `/api/admin/matches/${matchId}/editors`, { email: users.helper.email })
    assert.equal(add.status, 200, add.text)
    const close = await dbCall(users.scorer, 'matches', 'update', { data: { status: 'final', approval: { ok: true } }, filters: [{ type: 'eq', column: 'external_id', value: ext }] })
    assert.equal(close.status, 200, close.text)
    const { rows: [m] } = await sql.query('SELECT closed_at, game_pin FROM public.matches WHERE id = $1', [matchId])
    assert.ok(m.closed_at, 'the match is closed')
    assert.match(m.game_pin, /^h1:/, 'stored as its HMAC, as in production')
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
  })

  it('anonymous callers and accounts without the admin role are refused, nothing is audited', async () => {
    for (const method of ['GET', 'POST']) {
      assert.equal((await call(null, method, `/api/admin/matches/${matchId}/pin`)).status, 401, `${method} anonymous`)
      for (const u of [users.scorer, users.manager]) {
        const r = await call(u, method, `/api/admin/matches/${matchId}/pin`)
        assert.equal(r.status, 403, `${method} ${r.text}`)
        assert.equal(r.json.error.code, 'OV_FORBIDDEN')
      }
    }
    assert.deepEqual(await auditOf('match.pin_viewed'), [])
    assert.deepEqual(await auditOf('match.pin_reset'), [])
    assert.match(await storedPin(), /^h1:/)
  })

  it('an admin reads it: a hashed PIN cannot be read back, the read is audited without it', async () => {
    const r = await call(users.admin, 'GET', `/api/admin/matches/${matchId}/pin`)
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.data, { pin: null, stored: 'hashed', game_n: GAME_N })
    assert.match(r.headers.get('cache-control') || '', /no-store/)
    const entries = await auditOf('match.pin_viewed')
    assert.equal(entries.length, 1)
    assert.equal(entries[0].actor_id, users.admin.id)
    assert.equal(entries[0].match_id, matchId)
    assert.deepEqual(entries[0].details, { external_id: ext, game_n: GAME_N, shown: false })
  })

  it('an admin sets a new PIN: answered once, stored hashed, audited without it, the match stays closed', async () => {
    const r = await call(users.admin, 'POST', `/api/admin/matches/${matchId}/pin`)
    assert.equal(r.status, 200, r.text)
    assert.match(r.json.data.pin, /^\d{6}$/)
    assert.equal(r.json.data.stored, 'hashed')
    assert.match(r.headers.get('cache-control') || '', /no-store/)
    newPin = r.json.data.pin
    const stored = await storedPin()
    assert.match(stored, /^h1:/)
    assert.equal(stored.includes(newPin), false)
    const [entry] = await auditOf('match.pin_reset')
    assert.equal(entry.actor_id, users.admin.id)
    assert.deepEqual(entry.details, { external_id: ext, game_n: GAME_N })
    const all = JSON.stringify((await sql.query('SELECT details FROM public.audit_log')).rows)
    assert.equal(all.includes(newPin), false, 'no PIN in the audit log')
    assert.equal(all.includes(GAME_PIN), false)
    assert.ok((await sql.query('SELECT closed_at FROM public.matches WHERE id = $1', [matchId])).rows[0].closed_at)
    // the editor by the old PIN ends, the one an admin added stays
    const { rows: editors } = await sql.query('SELECT user_id::text AS id FROM public.match_editors WHERE match_id = $1', [matchId])
    assert.deepEqual(editors.map((e) => e.id), [users.helper.id])
  })

  it('reopened, the scorer app finds the match by game number and the new PIN, the old PIN no more', async () => {
    const reopen = await call(users.admin, 'POST', `/api/admin/matches/${matchId}/reopen`, { reason: 'Wrong final score' })
    assert.equal(reopen.status, 200, reopen.text)
    const found = await restoreByPin(newPin)
    assert.equal(found.status, 200, found.text)
    assert.equal(found.json.data.match.external_id, ext)
    assert.equal('game_pin' in found.json.data.match, false)
    const old = await restoreByPin(GAME_PIN)
    assert.equal(old.status, 404, old.text)
  })

  it('the match lists and reads never carry a PIN', async () => {
    for (const path of [`/api/admin/matches?state=all&q=${GAME_N}`, `/api/admin/matches?state=open&q=${GAME_N}`, `/api/match-editors/${matchId}`]) {
      const r = await call(users.admin, 'GET', path)
      assert.equal(r.status, 200, `${path} ${r.text}`)
      for (const secret of [newPin, GAME_PIN, 'game_pin', 'h1:']) assert.equal(r.text.includes(secret), false, `${path} carries ${secret}`)
    }
    const list = await call(users.admin, 'GET', `/api/admin/matches?state=all&q=${GAME_N}`)
    assert.ok(list.json.data.matches.some((m) => m.id === matchId), 'the match is in the list')
    const sel = await dbCall(users.admin, 'matches', 'select', { columns: '*', filters: [{ type: 'eq', column: 'id', value: matchId }] })
    assert.equal(sel.status, 200, sel.text)
    assert.equal(sel.text.includes(newPin), false)
    assert.equal('game_pin' in (sel.json.data[0] || {}), false)
  })

  it('a PIN stored before the secret (plaintext) is shown; an unknown match is 404', async () => {
    const legacyExt = `${ext}_legacy`
    const { rows: [m] } = await sql.query(
      "INSERT INTO public.matches (external_id, game_n, game_pin, status, sport_type) VALUES ($1, 9562, '135790', 'ended', 'indoor') RETURNING id", [legacyExt])
    const r = await call(users.admin, 'GET', `/api/admin/matches/${m.id}/pin`)
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.data, { pin: '135790', stored: 'plain', game_n: 9562 })
    const entry = (await auditOf('match.pin_viewed')).find((a) => a.match_id === m.id)
    assert.deepEqual(entry.details, { external_id: legacyExt, game_n: 9562, shown: true })
    const unknown = '6f1c2a9b-0000-4000-8000-0000000000ff'
    assert.equal((await call(users.admin, 'GET', `/api/admin/matches/${unknown}/pin`)).status, 404)
    assert.equal((await call(users.admin, 'POST', `/api/admin/matches/${unknown}/pin`)).status, 404)
  })
})
