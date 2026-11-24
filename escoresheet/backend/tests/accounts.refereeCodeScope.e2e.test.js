/**
 * PERM-20 (audit 2611): a club's referee invite code made whoever redeemed
 * it a member of the club (account_clubs, "scores for this club"), whatever
 * the code's role. With a scorer role from anywhere (another club's scorer)
 * the account then claimed the club's home games under the club rule and
 * read its licence lists, sent rosters and saved teams. A referee code now
 * gives the referee role only, as an approved referee request does; a
 * scorer code still joins its club. Leaving another club does not take a
 * referee role this club's code gave.
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

describe('a referee code joins no club (PERM-20)', { skip: SKIP }, () => {
  let db, srv, sql, alpha, beta, refCode
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
    const u = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, email, ip }
    if (roles.length) await grantRoles(sql, u.id, roles)
    users[name] = u
    return u
  }
  const call = (user, method, path, body) => api(srv.base, path, { method, token: user.token, body, proto: method === 'GET' ? null : '2', headers: { 'cf-connecting-ip': user.ip } })
  const clubsOf = async (u) => (await call(u, 'GET', '/api/me')).json.data.clubs.map((c) => c.name).sort()
  const rolesOf = async (u) => (await sql.query('SELECT roles FROM public.profiles WHERE user_id = $1', [u.id])).rows[0]?.roles ?? []

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    srv = await bootServer({ DATABASE_URL: db.appUrl(), TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' })
    await sql.query(`INSERT INTO public.svrz_games (game_number, team_home, team_away, league, datetime) VALUES
      ('940106', 'VBC Alpha H1', 'VBC Beta H1', '3L', $1)`, [`${zurichDay()}T20:00:00`])
    await account('admin', ['admin'])
    await account('mgrA')
    await account('mgrB')
    alpha = (await call(users.admin, 'POST', '/api/admin/clubs', { name: 'VBC Alpha', teams: ['VBC Alpha H1'] })).json.data.club
    beta = (await call(users.admin, 'POST', '/api/admin/clubs', { name: 'VBC Beta', teams: ['VBC Beta H1'] })).json.data.club
    await sql.query('INSERT INTO public.club_managers (club_id, user_id) VALUES ($1, $2), ($3, $4)', [alpha.id, users.mgrA.id, beta.id, users.mgrB.id])
    assert.equal((await call(users.admin, 'PUT', '/api/admin/club-rule', { enabled: true })).status, 200)
    const r = await call(users.mgrA, 'POST', `/api/club/${alpha.id}/invites`, { label: 'Alpha referees', role: 'referee', max_uses: 10 })
    assert.equal(r.status, 201, r.text)
    refCode = r.json.data.code
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
  })

  it('another club\'s scorer redeems it: the referee role, and nothing of the club', async () => {
    const s = await account('ScorerB', ['scorer'])
    assert.equal((await call(users.admin, 'PUT', `/api/admin/accounts/${s.id}/clubs`, { club_ids: [beta.id] })).status, 200)
    const red = await call(s, 'POST', '/api/account/redeem-invite', { code: refCode })
    assert.equal(red.status, 200, red.text)
    assert.equal(red.json.data.role_granted, 'referee')
    assert.deepEqual((await rolesOf(s)).sort(), ['referee', 'scorer'])
    assert.deepEqual(await clubsOf(s), ['VBC Beta'])
    // the club rule: Alpha's home game is not this account's to claim
    const claim = await api(srv.base, '/api/db', {
      token: s.token,
      body: { table: 'matches', action: 'insert', params: { data: { external_id: `match_${Date.now()}_ref`, status: 'setup', game_n: 940106, home_team: { name: 'VBC Alpha H1' }, away_team: { name: 'VBC Beta H1' } } } }
    })
    assert.equal(claim.status, 403, claim.text)
    assert.equal(claim.json.error.code, 'OV_NOT_YOUR_CLUB')
    // Alpha's games of the day and licence lists are not its own
    const today = await call(s, 'GET', '/api/games/today')
    assert.equal(today.status, 200, today.text)
    assert.deepEqual(today.json.data.games.map((g) => String(g.game_number)), [])
    const lists = await call(s, 'GET', '/api/club-licences')
    assert.equal(lists.status, 200, lists.text)
    assert.deepEqual(lists.json.data.clubs.map((c) => c.club_name), ['VBC Beta'])
  })

  it('a referee without any club redeems it: the referee role only', async () => {
    const r = await account('Referee')
    const red = await call(r, 'POST', '/api/account/redeem-invite', { code: refCode })
    assert.equal(red.status, 200, red.text)
    assert.deepEqual(await rolesOf(r), ['referee'])
    assert.deepEqual(await clubsOf(r), [])
    // redeemed again: nothing new, no use counted
    const { rows: [before] } = await sql.query("SELECT uses FROM public.invite_codes WHERE label = 'Alpha referees'")
    const again = await call(r, 'POST', '/api/account/redeem-invite', { code: refCode })
    assert.equal(again.status, 200, again.text)
    assert.equal(again.json.data.already_had, true)
    const { rows: [after] } = await sql.query("SELECT uses FROM public.invite_codes WHERE label = 'Alpha referees'")
    assert.equal(after.uses, before.uses)
  })

  it('a scorer code still joins its club', async () => {
    const c = await call(users.mgrA, 'POST', `/api/club/${alpha.id}/invites`, { label: 'Alpha scorers', role: 'scorer', max_uses: 10 })
    assert.equal(c.status, 201, c.text)
    const n = await account('NewScorer')
    const red = await call(n, 'POST', '/api/account/redeem-invite', { code: c.json.data.code })
    assert.equal(red.status, 200, red.text)
    assert.deepEqual(await clubsOf(n), ['VBC Alpha'])
  })

  it('Beta takes off its scorer: the scorer role Beta\'s code gave goes, the referee role Alpha\'s code gave stays', async () => {
    const b = await call(users.mgrB, 'POST', `/api/club/${beta.id}/invites`, { label: 'Beta scorers', role: 'scorer', max_uses: 10 })
    assert.equal(b.status, 201, b.text)
    const s = await account('BetaScorer')
    assert.equal((await call(s, 'POST', '/api/account/redeem-invite', { code: b.json.data.code })).status, 200)
    assert.equal((await call(s, 'POST', '/api/account/redeem-invite', { code: refCode })).status, 200)
    assert.deepEqual(await clubsOf(s), ['VBC Beta'])
    const rm = await call(users.mgrB, 'DELETE', `/api/club/${beta.id}/members/${s.id}`)
    assert.equal(rm.status, 200, rm.text)
    assert.deepEqual(rm.json.data.roles_removed, ['scorer'])
    assert.deepEqual(await clubsOf(s), [])
    assert.deepEqual(await rolesOf(s), ['referee'])
  })
})
