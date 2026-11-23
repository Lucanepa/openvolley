/**
 * PERM-12 (audit 2611, db/058): an outsider who became a club's manager
 * through a club manager link, and was then taken off the managers, kept the
 * club membership the manager row had given (db/030 / db/036: "leaving does
 * not take the membership away"). With a scorer role from anywhere it scored
 * the club's home games and read its lists. Now the membership the manager
 * row alone gave goes with it; one the account had before stays.
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js) or OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'
import { zurichDay } from '../lib/clubs.js'

describe('a removed club manager leaves the club (PERM-12)', { skip: SKIP }, () => {
  let db, srv, sql, club
  let ipSeq = 1
  const nextIp = () => `198.51.100.${ipSeq++}`
  const users = {}
  const PASSWORD = 'correct-horse-battery'

  async function account (name, roles = []) {
    const email = `${name.toLowerCase()}-${randomBytes(3).toString('hex')}@example.ch`
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
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, email }
    if (roles.length) await grantRoles(sql, u.id, roles)
    users[name] = u
    return u
  }
  const call = (user, method, path, body) => api(srv.base, path, { method, token: user.token, body, proto: null, headers: { 'cf-connecting-ip': nextIp() } })
  const clubsOf = async (user) => (await call(user, 'GET', '/api/me')).json.data.clubs.map((c) => c.name)
  const todayGames = async (user) => (await call(user, 'GET', '/api/games/today')).json.data.games.map((g) => String(g.game_number))

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    srv = await bootServer({ DATABASE_URL: db.appUrl(), TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' })
    await sql.query(`INSERT INTO public.svrz_games (game_number, team_home, team_away, league, datetime) VALUES
      ('930301', 'SC Testheim H2', 'VBC Gast H1', '3L', $1)`, [`${zurichDay()}T20:00:00`])
    await account('admin', ['admin'])
    club = (await call(users.admin, 'POST', '/api/admin/clubs', { name: 'SC Testheim', teams: ['SC Testheim H2'] })).json.data.club
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
  })

  it('an outsider made manager by a link, then taken off: no member, no home games any more', async () => {
    // a scorer role from anywhere (another club's code, an admin)
    const out = await account('Outsider', ['scorer'])
    const inv = await call(users.admin, 'POST', `/api/admin/clubs/${club.id}/manager-invites`, { email: out.email })
    assert.equal(inv.status, 201, inv.text)
    const red = await call(out, 'POST', '/api/account/redeem-invite', { code: inv.json.data.code })
    assert.equal(red.status, 200, red.text)
    assert.equal(red.json.data.role_granted, 'club_manager')
    assert.deepEqual(await clubsOf(out), ['SC Testheim'])
    assert.deepEqual(await todayGames(out), ['930301'])
    // the admin takes the managers off
    const put = await call(users.admin, 'PUT', `/api/admin/clubs/${club.id}/managers`, { user_ids: [] })
    assert.equal(put.status, 200, put.text)
    assert.deepEqual(await clubsOf(out), [])
    assert.deepEqual(await todayGames(out), [])
    const me = (await call(out, 'GET', '/api/me')).json.data
    assert.ok(!me.roles.includes('club_manager'), JSON.stringify(me.roles))
    const { rows } = await sql.query("SELECT details FROM public.audit_log WHERE action = 'account.clubs' AND target_user_id = $1 AND details ->> 'reason' = 'club_manager_removed'", [out.id])
    assert.equal(rows.length, 1)
  })

  it('a scorer of the club made manager, then taken off: still a member', async () => {
    const own = await account('OwnScorer', ['scorer'])
    const put = await call(users.admin, 'PUT', `/api/admin/accounts/${own.id}/clubs`, { club_ids: [club.id] })
    assert.equal(put.status, 200, put.text)
    assert.equal((await call(users.admin, 'PUT', `/api/admin/clubs/${club.id}/managers`, { user_ids: [own.id] })).status, 200)
    assert.equal((await call(users.admin, 'PUT', `/api/admin/clubs/${club.id}/managers`, { user_ids: [] })).status, 200)
    assert.deepEqual(await clubsOf(own), ['SC Testheim'])
    assert.deepEqual(await todayGames(own), ['930301'])
  })

  it('a manager who redeemed the club\'s scorer code meanwhile keeps that membership', async () => {
    const both = await account('Both')
    const inv = await call(users.admin, 'POST', `/api/admin/clubs/${club.id}/manager-invites`, { email: both.email })
    assert.equal((await call(both, 'POST', '/api/account/redeem-invite', { code: inv.json.data.code })).status, 200)
    const code = await call(users.admin, 'POST', '/api/admin/invites', { label: 'SC Testheim scorers', club_id: club.id, max_uses: 5 })
    assert.equal(code.status, 201, code.text)
    const red = await call(both, 'POST', '/api/account/redeem-invite', { code: code.json.data.code })
    assert.equal(red.status, 200, red.text)
    assert.equal(red.json.data.role_granted, 'scorer')
    assert.equal((await call(users.admin, 'PUT', `/api/admin/clubs/${club.id}/managers`, { user_ids: [] })).status, 200)
    assert.deepEqual(await clubsOf(both), ['SC Testheim'])
  })
})
