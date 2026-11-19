/**
 * The save-back end to end (lib/rosterSaveBack.js, owner 2026-11-19): a
 * scorer writes an official match through /api/db as the app does (set up,
 * then the coin toss with the rosters); a moment later the team's saved team
 * has the players with their shirt numbers (the scorer's saved-teams
 * download and the team manager's squad show it) and the club's lists have
 * the licences. A test match writes nothing. With the production grants
 * (db/roles.sql). Made-up clubs and people only.
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js) or OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep, waitUntil } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'
import { zurichDay } from '../lib/clubs.js'

const H1 = 'VBC Musterdorf H1'
const H2 = 'VBC Beispiel H2'
const dayPlus = (day, n) => { const t = new Date(`${day}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10) }
const player = (number, first, last, dob) => ({ number, first_name: first, last_name: last, dob, libero: '', is_captain: false, is_lfp: false })

describe('save-back end to end: an official match fills the squad and the club list', { skip: SKIP }, () => {
  let db, srv, sql, club, team
  let ipSeq = 1
  const users = {}
  const today = zurichDay()

  async function account (name, roles) {
    const email = `${name}-${randomBytes(3).toString('hex')}@example.ch`
    const ip = `198.51.100.${ipSeq++}`
    const up = await api(srv.base, '/api/auth/sign-up', { headers: { 'cf-connecting-ip': ip }, body: { email, password: 'correct-horse-battery', metadata: { first_name: name, last_name: 'Test' } } })
    assert.equal(up.status, 200, up.text)
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
  const write = (user, action, params) => api(srv.base, '/api/db', { token: user.token, body: { table: 'matches', action, params } })
  const savedTeamOf = async (user, name) => (await call(user, 'GET', '/api/saved-teams')).json?.data?.teams?.find((t) => t.svrz_team_name === name) || null

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    srv = await bootServer({ DATABASE_URL: db.appUrl(), TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128', OV_SAVE_BACK_TEST_MS: '300' })
    await sql.query(`INSERT INTO public.svrz_games (game_number, team_home, team_away, league, gender, hall, city, match_format, datetime) VALUES
      ('970001', $1, $2, '3L Herren', 'm', 'Halle Musterdorf', 'Zürich', 5, '${dayPlus(today, 1)}T18:00:00'),
      ('970002', $1, $2, '3L Herren', 'm', 'Halle Musterdorf', 'Zürich', 5, '${dayPlus(today, 2)}T18:00:00')`, [H1, H2])
    const admin = await account('admin', ['admin'])
    await account('scorer', ['scorer'])
    await account('clubmgr', null)
    club = (await call(admin, 'POST', '/api/admin/clubs', { name: 'VBC Musterdorf', teams: [H1] })).json.data.club
    await sql.query('INSERT INTO public.club_managers (club_id, user_id) VALUES ($1, $2)', [club.id, users.clubmgr.id])
    await call(admin, 'PUT', `/api/admin/accounts/${users.scorer.id}/clubs`, { club_ids: [club.id] })
    team = (await call(users.clubmgr, 'GET', `/api/club/${club.id}/teams`)).json.data.teams.find((t) => t.name === H1)
    // the club manager gets the team's squad (as its manager would)
    await sql.query('INSERT INTO public.team_managers (team_id, user_id) VALUES ($1, $2)', [team.id, users.clubmgr.id]).catch(() => {})
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
  })

  it('set up, then the coin toss: the saved team and the club list a moment later', async () => {
    const ext = `match_${Date.now()}_${randomBytes(3).toString('hex')}`
    const ins = await write(users.scorer, 'insert', {
      data: { external_id: ext, status: 'setup', game_n: 970001, scheduled_at: `${dayPlus(today, 1)}T17:00:00Z`, home_team: { name: H1 }, away_team: { name: H2 } },
      returning: 'id', single: true
    })
    assert.equal(ins.status, 200, ins.text)
    await sleep(800)
    assert.equal(await savedTeamOf(users.scorer, H1), null, 'nothing before the coin toss')
    // the coin toss: the rosters and status live (CoinToss.jsx's update)
    const toss = await write(users.scorer, 'update', {
      data: {
        status: 'live',
        players_home: [player(7, 'Anna', 'Muster', '100001'), player(12, 'Ben', 'Beispiel', '100002'), player(3, 'Cleo', 'Ohnelizenz', null)],
        players_away: [player(1, 'Eva', 'Gast', '200001')],
        bench_home: [{ role: 'Coach', first_name: 'Carla', last_name: 'Trainer', dob: '5001' }],
        bench_away: []
      },
      filters: [{ type: 'eq', column: 'external_id', value: ext }]
    })
    assert.equal(toss.status, 200, toss.text)
    const saved = await waitUntil(async () => {
      const t = await savedTeamOf(users.scorer, H1)
      return t?.players?.length === 3 ? t : null
    }, { what: 'the saved team of the home team', timeoutMs: 20000 })
    assert.deepEqual(saved.players.map((p) => [p.last_name, p.number, p.license_number]), [['Muster', 7, '100001'], ['Beispiel', 12, '100002'], ['Ohnelizenz', 3, null]])
    assert.deepEqual(saved.staff.map((s) => [s.role, s.last_name, s.license_number]), [['Coach', 'Trainer', '5001']])
    assert.equal(saved.club, 'VBC Musterdorf')
    // the opponent the scorer meets at home has one too
    const away = await savedTeamOf(users.scorer, H2)
    assert.deepEqual(away?.players.map((p) => [p.last_name, p.number]), [['Gast', 1]])
    // the team manager's squad is that saved team
    const sq = await call(users.clubmgr, 'GET', `/api/team/${team.id}/squad`)
    assert.equal(sq.status, 200, sq.text)
    assert.equal(sq.json.data.squad.id, saved.id)
    // the club's list: the licences, as rows no upload brought (the gray shield)
    const list = await call(users.clubmgr, 'GET', `/api/club/${club.id}/licences`)
    assert.equal(list.status, 200, list.text)
    assert.deepEqual(list.json.data.people.map((p) => [p.sv_number, p.last_name, p.lists, p.manual]).sort(),
      [['100001', 'Muster', ['players'], true], ['100002', 'Beispiel', ['players'], true], ['5001', 'Trainer', ['coaches'], true]])
    // "Add from club" offers them to the team
    const offer = await call(users.clubmgr, 'GET', `/api/team/${team.id}/club-players`)
    assert.deepEqual(offer.json.data.players.map((p) => p.sv_number).sort(), ['100001', '100002'])
  })

  it('a test match writes nothing', async () => {
    const before = await savedTeamOf(users.scorer, H1)
    const ext = `match_${Date.now()}_${randomBytes(3).toString('hex')}`
    const ins = await write(users.scorer, 'insert', {
      data: { external_id: ext, test: true, status: 'live', game_n: 970002, home_team: { name: H1 }, away_team: { name: H2 }, players_home: [player(99, 'Test', 'Person', '100099')] },
      returning: 'id', single: true
    })
    assert.equal(ins.status, 200, ins.text)
    await sleep(1200)
    const after = await savedTeamOf(users.scorer, H1)
    assert.deepEqual(after.players, before.players)
    const { rows } = await sql.query("SELECT count(*)::int AS n FROM public.club_licences WHERE sv_number = '100099'")
    assert.equal(rows[0].n, 0)
  })
})
