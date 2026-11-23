/**
 * PERM-13 (audit 2611): a club API token with the read scope reaches no
 * personal data (docs/club-api.md). The games routes answered each game's
 * roster summary with the name of the team manager who sent the roster
 * (updated_by_name) and of the scorer who accepted it (used_by_name): a
 * website widget's token listed the club's team managers and scorers. The
 * read routes keep the counts and the times, the names are null.
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js) or OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep } from './helpers/e2eServer.js'
import { seasonOf } from '../lib/officialGame.js'

describe('club API read scope: no names in the games (PERM-13)', { skip: SKIP }, () => {
  let db, srv, sql, club, teamId, readTok
  let ipSeq = 1
  const nextIp = () => `198.51.100.${ipSeq++}`
  const users = {}
  const PASSWORD = 'correct-horse-battery'

  async function account (name, last) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const ip = nextIp()
    const up = await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password: PASSWORD, metadata: { first_name: name, last_name: last } } })
    assert.equal(up.status, 200, up.text)
    let inn
    for (let attempt = 0; attempt < 10; attempt++) {
      inn = await api(srv.base, '/api/auth/sign-in', { headers: { 'cf-connecting-ip': ip }, body: { email, password: PASSWORD } })
      if (!(inn.status === 503 && inn.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    assert.equal(inn.status, 200, inn.text)
    users[name] = { id: inn.json.data.user.id, token: inn.json.data.session.access_token, email }
    return users[name]
  }
  const session = (user, method, path, body) => api(srv.base, path, { method, token: user.token, body, proto: method === 'GET' ? null : '2' })
  const clubCall = (token, path) => api(srv.base, '/api/club/v1' + path, { method: 'GET', proto: null, headers: { Authorization: `Bearer ${token}` } })

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    srv = await bootServer({ DATABASE_URL: db.appUrl(), TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' })
    await sql.query(`INSERT INTO public.svrz_games (game_number, team_home, team_away, league, datetime) VALUES
      ('920101', 'VBC Musterdorf H1', 'VBC Other H1', '2L', to_char(now() + interval '3 days', 'YYYY-MM-DD"T"18:00:00'))`)
    await account('admin', 'Admin')
    await account('Clara', 'Clubmanagerin')
    await account('Tina', 'Teammanagerin')
    await account('Sam', 'Schreiber')
    await sql.query(`UPDATE public.profiles SET roles = ARRAY['admin'] WHERE user_id = $1`, [users.admin.id])
    club = (await session(users.admin, 'POST', '/api/admin/clubs', { name: 'VBC Musterdorf', teams: ['VBC Musterdorf H1'] })).json.data.club
    teamId = (await sql.query('SELECT id FROM public.club_teams WHERE club_id = $1', [club.id])).rows[0].id
    await sql.query('INSERT INTO public.club_managers (club_id, user_id) VALUES ($1, $2)', [club.id, users.Clara.id])
    await sql.query('INSERT INTO public.team_managers (team_id, user_id) VALUES ($1, $2)', [teamId, users.Tina.id])
    // the team manager sends the roster of game 920101 ...
    const players = Array.from({ length: 6 }, (_, i) => ({ number: i + 1, first_name: `P${i}`, last_name: 'Spieler', active: true }))
    const put = await session(users.Tina, 'PUT', `/api/team/${teamId}/roster?game=920101`, { players, staff: [] })
    assert.equal(put.status, 200, put.text)
    // ... and a scorer accepted it (as markUsed records it)
    await sql.query('UPDATE public.game_rosters SET used_by = $1, used_at = now() WHERE game_number = $2 AND season = $3', [users.Sam.id, '920101', seasonOf(new Date())])
    const tok = await session(users.Clara, 'POST', `/api/club/${club.id}/api-tokens`, { label: 'Website', scopes: ['read'] })
    assert.equal(tok.status, 201, tok.text)
    readTok = tok.json.data.token
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
  })

  it('the manager console still names who sent and who accepted the roster', async () => {
    const g = await session(users.Clara, 'GET', `/api/team/${teamId}/games`)
    assert.equal(g.status, 200, g.text)
    const r = g.json.data.games.find((x) => x.game_number === '920101').roster
    assert.equal(r.updated_by_name, 'Tina Teammanagerin')
    assert.equal(r.used_by_name, 'Sam Schreiber')
  })

  for (const path of ['/teams/:team/games', '/games']) {
    it(`GET ${path} with a read token: the summary without the names`, async () => {
      const res = await clubCall(readTok, path.replace(':team', teamId))
      assert.equal(res.status, 200, res.text)
      const game = res.json.data.games.find((x) => x.game_number === '920101')
      assert.ok(game, res.text)
      assert.equal(game.roster.players, 6)
      assert.ok(game.roster.updated_at, 'the time stays')
      assert.ok(game.roster.used_at, 'the time stays')
      assert.equal(game.roster.updated_by_name, null)
      assert.equal(game.roster.used_by_name, null)
      for (const name of ['Tina', 'Teammanagerin', 'Sam', 'Schreiber', 'Clubmanagerin']) assert.ok(!res.text.includes(name), `${name} in ${res.text}`)
    })
  }
})
