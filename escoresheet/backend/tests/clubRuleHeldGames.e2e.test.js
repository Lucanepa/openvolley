/**
 * Official games held outside their home club (db/018 club rule, db/034),
 * end to end: the manager's Clubs tab lists the open official matches an
 * account outside the home club holds (to release them), and with the rule
 * on a scorer of the home club takes over such a game while its match is
 * still in setup (audited); a started match, a holder of the home club or a
 * scorer of another club changes nothing.
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js) or OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'

describe('official games held outside the home club', { skip: SKIP }, () => {
  let db, srv, sql
  let ipSeq = 1
  const nextIp = () => `198.51.100.${ipSeq++}`
  const users = {}
  const held = {}

  async function account (name, roles) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const password = 'correct-horse-battery'
    const ip = nextIp()
    const up = await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password, metadata: { first_name: name, last_name: 'Test' } } })
    assert.equal(up.status, 200, up.text)
    let inn
    for (let attempt = 0; attempt < 10; attempt++) {
      inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password } })
      if (!(inn.status === 503 && inn.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    assert.equal(inn.status, 200, inn.text)
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token }
    if (roles) await grantRoles(sql, u.id, roles)
    users[name] = u
    return u
  }
  const call = (user, method, path, body) => api(srv.base, path, { method, token: user?.token, body, proto: method === 'GET' ? null : '2' })
  const expectCode = (r, status, code) => {
    assert.equal(r.status, status, r.text)
    assert.equal(r.json?.error?.code, code, r.text)
  }
  const ext = () => `match_${Date.now()}_${randomBytes(3).toString('hex')}`
  const insertMatch = (user, data) => api(srv.base, '/api/db', { token: user.token, body: { table: 'matches', action: 'insert', params: { data: { external_id: ext(), status: 'setup', ...data }, returning: 'id,external_id', single: true } } })
  const exempt = async (id) => (await sql.query('SELECT official_game_exempt FROM public.matches WHERE id = $1', [id])).rows[0].official_game_exempt
  const heldList = async () => {
    const r = await call(users.admin, 'GET', '/api/admin/clubs')
    assert.equal(r.status, 200, r.text)
    return r.json.data.held_outside
  }

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    srv = await bootServer({ DATABASE_URL: db.url, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' })
    await sql.query(`INSERT INTO public.svrz_games (game_number, team_home, team_away, league, datetime) VALUES
      ('960001', 'Alpha H1', 'Beta H1', '2L', '2026-11-21T16:00:00'),
      ('960002', 'Alpha H1', 'Gamma H1', '2L', '2026-11-22T16:00:00'),
      ('960003', 'Alpha H1', 'Beta H1', '2L', '2026-11-28T16:00:00'),
      ('960004', 'Beta H1', 'Alpha H1', '2L', '2026-11-29T16:00:00'),
      ('960005', 'Alpha H1', 'Gamma H1', '2L', '2026-12-05T16:00:00')`)
    await account('admin', ['admin'])
    await account('alpha', ['scorer'])
    await account('alpha2', ['scorer'])
    await account('beta', ['scorer'])
    await account('gamma', ['scorer'])
    const clubs = {}
    for (const [name, team] of [['Club Alpha', 'Alpha H1'], ['Club Beta', 'Beta H1'], ['Club Gamma', 'Gamma H1']]) {
      const r = await call(users.admin, 'POST', '/api/admin/clubs', { name, teams: [team] })
      assert.equal(r.status, 201, r.text)
      clubs[name] = r.json.data.club.id
    }
    for (const [who, club] of [['alpha', 'Club Alpha'], ['alpha2', 'Club Alpha'], ['beta', 'Club Beta'], ['gamma', 'Club Gamma']]) {
      const r = await call(users.admin, 'PUT', `/api/admin/accounts/${users[who].id}/clubs`, { club_ids: [clubs[club]] })
      assert.equal(r.status, 200, r.text)
    }
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
  })

  it('the Clubs tab lists the official matches held outside their home club', async () => {
    // the rule is off here (pgTestDb): the scorer of another club takes Alpha's home games first
    for (const [n, status] of [[960001, 'setup'], [960002, 'live'], [960003, 'setup']]) {
      const r = await insertMatch(users.beta, { game_n: n, status })
      assert.equal(r.status, 200, r.text)
      held[n] = r.json.data.id
    }
    // the home club's own matches, a test match and Beta's own home game are not listed
    assert.equal((await insertMatch(users.alpha, { game_n: 960005 })).status, 200)
    assert.equal((await insertMatch(users.beta, { game_n: 960004 })).status, 200)
    assert.equal((await insertMatch(users.gamma, { game_n: 960005, test: true })).status, 200)
    const list = await heldList()
    assert.deepEqual(list.map((m) => m.game_n).sort(), [960001, 960002, 960003])
    const one = list.find((m) => m.game_n === 960001)
    assert.deepEqual({ ...one, scheduled_at: undefined }, {
      match_id: held[960001], game_n: 960001, status: 'setup', scheduled_at: undefined,
      home_team: 'Alpha H1', club: 'Club Alpha', scorer_name: 'beta Test'
    })
  })

  it('with the rule off the home club\'s scorer is refused (an admin releases the game)', async () => {
    expectCode(await insertMatch(users.alpha, { game_n: 960001 }), 409, 'OV_GAME_TAKEN')
    assert.equal(await exempt(held[960001]), false)
  })

  it('with the rule on a home-club scorer takes over a game still in setup, audited', async () => {
    assert.equal((await call(users.admin, 'PUT', '/api/admin/club-rule', { enabled: true })).status, 200)
    const r = await insertMatch(users.alpha, { game_n: 960001 })
    assert.equal(r.status, 200, r.text)
    assert.equal(await exempt(held[960001]), true, 'the outside match no longer holds the game')
    const { rows } = await sql.query("SELECT actor_id, target_user_id, match_id, details FROM public.audit_log WHERE action = 'match.game_taken_over'")
    assert.equal(rows.length, 1)
    assert.equal(rows[0].actor_id, users.alpha.id)
    assert.equal(rows[0].target_user_id, users.beta.id)
    assert.equal(rows[0].match_id, held[960001])
    assert.equal(rows[0].details.game_n, 960001)
    assert.deepEqual((await heldList()).map((m) => m.game_n).sort(), [960002, 960003])
  })

  it('a started match, or a scorer of another club, takes nothing over', async () => {
    expectCode(await insertMatch(users.alpha2, { game_n: 960002 }), 409, 'OV_GAME_TAKEN')
    assert.equal(await exempt(held[960002]), false)
    const other = await insertMatch(users.gamma, { game_n: 960003 })
    assert.notEqual(other.status, 200, other.text)
    assert.equal(await exempt(held[960003]), false)
    // a game the home club holds already is not taken over by its own other scorer
    const own = await insertMatch(users.alpha2, { game_n: 960001 })
    expectCode(own, 409, 'OV_GAME_TAKEN')
    assert.equal((await sql.query("SELECT count(*)::int AS n FROM public.audit_log WHERE action = 'match.game_taken_over'")).rows[0].n, 1)
  })
})
