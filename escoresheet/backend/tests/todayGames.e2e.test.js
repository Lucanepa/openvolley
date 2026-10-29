/**
 * GET /api/games/today (lib/clubs.js todayGames; ~/ov-ops/club-manager-home-
 * email-PLAN.md step 3): the scorer app's Official game lists today's HOME
 * games of the account's clubs, with the schedule fields it fills the match
 * from and whether a match claims the game already.
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

describe('today\'s home games of the account\'s clubs', { skip: SKIP }, () => {
  let db, srv, sql
  let ipSeq = 1
  const users = {}
  const today = zurichDay()
  const tomorrow = (() => { const t = new Date(`${today}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10) })()

  async function account (name, roles) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const ip = `198.51.100.${ipSeq++}`
    await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password: 'correct-horse-battery', metadata: { first_name: name, last_name: 'Test' } } })
    let inn
    for (let attempt = 0; attempt < 10; attempt++) {
      inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password: 'correct-horse-battery' } })
      if (!(inn.status === 503 && inn.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    assert.equal(inn.status, 200, inn.text)
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, email }
    if (roles) await grantRoles(sql, u.id, roles)
    users[name] = u
    return u
  }
  const call = (user, method, path, body) => api(srv.base, path, { method, token: user?.token, body, proto: method === 'GET' ? null : '2' })
  const insertMatch = (user, data) => api(srv.base, '/api/db', { token: user.token, body: { table: 'matches', action: 'insert', params: { data: { external_id: `match_${Date.now()}_${randomBytes(3).toString('hex')}`, status: 'live', ...data }, returning: 'id', single: true } } })

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    srv = await bootServer({ DATABASE_URL: db.url, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' })
    await sql.query(`INSERT INTO public.svrz_games (game_number, team_home, team_away, league, gender, hall, city, match_format, referee_1_first_name, referee_1_last_name, datetime) VALUES
      ('930001', 'KSC Wiedikon H1', 'VBC Other H1', '2L', 'men', 'Halle Wiedikon', 'Zürich', 5, 'Rita', 'Ref', '${today}T18:00:00'),
      ('930002', 'ksc wiedikon d2 ', 'VBC Other D1', '3L', 'women', 'Halle Wiedikon', 'Zürich', 5, null, null, '${today}T16:00:00'),
      ('930003', 'VBC Other H1', 'KSC Wiedikon H1', '2L', 'men', 'Halle Other', 'Bern', 5, null, null, '${today}T20:00:00'),
      ('930004', 'KSC Wiedikon H1', 'VBC Third H1', '2L', 'men', 'Halle Wiedikon', 'Zürich', 5, null, null, '${tomorrow}T18:00:00'),
      ('930005', 'VBC Other D1', 'VBC Third D1', '3L', 'women', 'Halle Other', 'Bern', 5, null, null, '${today}T14:00:00')`)
    const admin = await account('admin', ['admin'])
    await account('ksc', ['scorer'])
    await account('other', ['scorer'])
    await account('noclub', ['scorer'])
    const ksc = (await call(admin, 'POST', '/api/admin/clubs', { name: 'KSC Wiedikon', teams: ['KSC Wiedikon H1', 'KSC Wiedikon D2'] })).json.data.club
    const other = (await call(admin, 'POST', '/api/admin/clubs', { name: 'VBC Other', teams: ['VBC Other H1', 'VBC Other D1'] })).json.data.club
    await call(admin, 'PUT', `/api/admin/accounts/${users.ksc.id}/clubs`, { club_ids: [ksc.id] })
    await call(admin, 'PUT', `/api/admin/accounts/${users.other.id}/clubs`, { club_ids: [other.id] })
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
  })

  it('needs a session', async () => {
    const r = await api(srv.base, '/api/games/today')
    assert.equal(r.status, 401, r.text)
  })

  it('today\'s home games of the account\'s clubs only, in time order, with the fields the match is filled from', async () => {
    const r = await call(users.ksc, 'GET', '/api/games/today')
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.data.day, today)
    assert.deepEqual(r.json.data.clubs, ['KSC Wiedikon'])
    // not the away game (930003), not tomorrow's (930004), not another club's (930005)
    assert.deepEqual(r.json.data.games.map((g) => g.game_number), ['930002', '930001'])
    const g = r.json.data.games[1]
    assert.equal(g.team_home, 'KSC Wiedikon H1')
    assert.equal(g.club, 'KSC Wiedikon')
    assert.equal(g.hall, 'Halle Wiedikon')
    assert.equal(g.match_format, 5)
    assert.equal(g.referee_1_first_name, 'Rita')
    assert.equal(g.claim, null)
    assert.equal(r.json.data.games[0].club, 'KSC Wiedikon', 'the team name is matched without case and spaces')
  })

  it('a game a match claims says whose', async () => {
    assert.equal((await insertMatch(users.ksc, { game_n: 930001, scheduled_at: `${today}T16:00:00Z` })).status, 200)
    const mine = (await call(users.ksc, 'GET', '/api/games/today')).json.data.games.find((g) => g.game_number === '930001')
    assert.deepEqual(mine.claim, { mine: true, closed: false })
    const r = await call(users.other, 'GET', '/api/games/today')
    assert.deepEqual(r.json.data.games.map((g) => g.game_number), ['930005', '930003'], 'the other club\'s home games')
  })

  it('an account without a club gets no games', async () => {
    const r = await call(users.noclub, 'GET', '/api/games/today')
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.data.games, [])
    assert.deepEqual(r.json.data.clubs, [])
  })
})
