/**
 * Team managers and sent game rosters (db/023, lib/teams.js,
 * docs/team-managers-spec.md): the club manager's team link, the team
 * manager's squad and game rosters, and what a scoring tablet downloads.
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
import { seasonOf } from '../lib/officialGame.js'

const dayPlus = (day, n) => { const t = new Date(`${day}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10) }
const player = (number, last, extra = {}) => ({ number, first_name: 'P', last_name: last, dob: '2001-02-03', ...extra })
// a tiny valid PNG data URL (a signature drawn ahead)
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

describe('team managers and sent game rosters', { skip: SKIP }, () => {
  let db, srv, sql
  let ipSeq = 1
  const users = {}
  const today = zurichDay()
  const season = seasonOf(new Date())
  let musterdorf, other, h1, d2

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

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    srv = await bootServer({ DATABASE_URL: db.url, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' })
    await sql.query(`INSERT INTO public.svrz_games (game_number, team_home, team_away, league, gender, hall, city, match_format, datetime) VALUES
      ('940001', 'VBC Musterdorf H1', 'VBC Other H1', '2L Herren', 'm', 'Halle Musterdorf', 'Zürich', 5, '${dayPlus(today, 2)}T18:00:00'),
      ('940002', 'VBC Other H1', 'VBC Musterdorf H1', '2L Herren', 'm', 'Halle Other', 'Bern', 5, '${dayPlus(today, 5)}T20:00:00'),
      ('940003', 'VBC Musterdorf H1', 'VBC Third H1', '2L Herren', 'm', 'Halle Musterdorf', 'Zürich', 5, '${dayPlus(today, -1)}T18:00:00'),
      ('940004', 'VBC Musterdorf D2', 'VBC Other D1', '3L Damen', 'f', 'Halle Musterdorf', 'Zürich', 5, '${dayPlus(today, 3)}T16:00:00'),
      ('940005', 'VBC Musterdorf H1', 'VBC Fourth H1', '2L Herren', 'm', 'Halle Musterdorf', 'Zürich', 5, '${dayPlus(today, 12)}T18:00:00'),
      ('940006', 'VBC Musterdorf H1', 'VBC Fifth H1', '2L Herren', 'm', 'Halle Musterdorf', 'Zürich', 5, '${today}T00:00:01')`)
    // the game page's where and who (owner 2026-11-10): address and referees of one game
    await sql.query(`UPDATE public.svrz_games SET hall_address = 'Sportweg 1', hall_postal_code = '8000',
      referee_1 = 'Rita Referee', referee_1_dob = '1980-01-02', referee_2 = 'Sam Second' WHERE game_number = '940001'`)
    // A roster of a game long past: the first write sweeps it (14 days)
    await sql.query(`INSERT INTO public.game_rosters (game_number, season, side, team_name, players, staff, kickoff)
      VALUES ('939999', $1, 'home', 'VBC Musterdorf H1', '[]', '[]', $2)`, [season, `${dayPlus(today, -30)}T18:00:00`])
    const admin = await account('admin', ['admin'])
    await account('clubmgr', null)
    await account('scorer', ['scorer'])
    await account('otherscorer', ['scorer'])
    await account('coach', null)
    await account('stranger', null)
    await account('coach2', null)
    await account('friend', null)
    musterdorf = (await call(admin, 'POST', '/api/admin/clubs', { name: 'VBC Musterdorf', teams: ['VBC Musterdorf H1', 'VBC Musterdorf D2'] })).json.data.club
    other = (await call(admin, 'POST', '/api/admin/clubs', { name: 'VBC Other', teams: ['VBC Other H1', 'VBC Other D1'] })).json.data.club
    await sql.query('INSERT INTO public.club_managers (club_id, user_id) VALUES ($1, $2)', [musterdorf.id, users.clubmgr.id])
    await call(admin, 'PUT', `/api/admin/accounts/${users.scorer.id}/clubs`, { club_ids: [musterdorf.id] })
    await call(admin, 'PUT', `/api/admin/accounts/${users.otherscorer.id}/clubs`, { club_ids: [other.id] })
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
  })

  it('the club manager lists its club\'s teams with ids; nobody else does', async () => {
    const r = await call(users.clubmgr, 'GET', `/api/club/${musterdorf.id}/teams`)
    assert.equal(r.status, 200, r.text)
    const names = r.json.data.teams.map((t) => t.name)
    assert.deepEqual(names, ['VBC Musterdorf D2', 'VBC Musterdorf H1'])
    h1 = r.json.data.teams.find((t) => t.name === 'VBC Musterdorf H1')
    d2 = r.json.data.teams.find((t) => t.name === 'VBC Musterdorf D2')
    assert.deepEqual(h1.managers, [])
    assert.equal((await call(users.scorer, 'GET', `/api/club/${musterdorf.id}/teams`)).status, 403)
    // another club's team through this club's path is unknown
    const otherTeams = (await call(users.admin, 'GET', `/api/club/${other.id}/teams`)).json.data.teams
    const r2 = await call(users.clubmgr, 'POST', `/api/club/${musterdorf.id}/teams/${otherTeams[0].id}/invites`, {})
    assert.equal(r2.status, 404, r2.text)
  })

  it('/api/me gives the club manager every team of its club (via club)', async () => {
    const r = await call(users.clubmgr, 'GET', '/api/me')
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.data.managedTeams.map((t) => [t.name, t.via]), [['VBC Musterdorf D2', 'club'], ['VBC Musterdorf H1', 'club']])
    // the manager's Club / Gender / Team pickers (owner 2026-11-11): the gender of the
    // team's games, and whether it plays this season
    assert.deepEqual(r.json.data.managedTeams.map((t) => [t.name, t.gender, t.active]), [['VBC Musterdorf D2', 'f', true], ['VBC Musterdorf H1', 'm', true]])
  })

  let code
  it('a team link: within limits, shown once, listed with the club\'s codes', async () => {
    assert.equal((await call(users.clubmgr, 'POST', `/api/club/${musterdorf.id}/teams/${h1.id}/invites`, { max_uses: 11 })).status, 400)
    const far = new Date(Date.now() + 91 * 24 * 3600 * 1000).toISOString()
    assert.equal((await call(users.clubmgr, 'POST', `/api/club/${musterdorf.id}/teams/${h1.id}/invites`, { expires_at: far })).status, 400)
    const r = await call(users.clubmgr, 'POST', `/api/club/${musterdorf.id}/teams/${h1.id}/invites`, { max_uses: 1 })
    assert.equal(r.status, 201, r.text)
    code = r.json.data.code
    assert.match(code, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/)
    assert.equal(r.json.data.invite.role, 'team_manager')
    assert.equal(r.json.data.invite.team_id, h1.id)
    assert.equal(r.json.data.invite.team_name, 'VBC Musterdorf H1')
    assert.equal(r.json.data.invite.club_id, musterdorf.id)
    const list = await call(users.clubmgr, 'GET', `/api/club/${musterdorf.id}/invites`)
    assert.ok(list.json.data.invites.some((i) => i.team_id === h1.id && i.team_name === 'VBC Musterdorf H1'))
    const teams = (await call(users.clubmgr, 'GET', `/api/club/${musterdorf.id}/teams`)).json.data.teams
    assert.equal(teams.find((t) => t.id === h1.id).open_links, 1)
  })

  it('redeeming it makes the account a manager of that team: the team manager role (db/030), no club (db/036)', async () => {
    const r = await call(users.coach, 'POST', '/api/account/redeem-invite', { code })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.data.role_granted, 'team_manager')
    assert.equal(r.json.data.team.id, h1.id)
    assert.deepEqual(r.json.data.roles, ['team_manager'])
    const again = await call(users.coach, 'POST', '/api/account/redeem-invite', { code })
    assert.equal(again.status, 200, again.text)
    assert.equal(again.json.data.already_had, true)
    // single use: used up for anyone else
    const used = await call(users.stranger, 'POST', '/api/account/redeem-invite', { code })
    assert.equal(used.status, 409, used.text)
    const me = (await call(users.coach, 'GET', '/api/me')).json.data
    assert.deepEqual(me.managedTeams, [{ id: h1.id, name: 'VBC Musterdorf H1', club_id: musterdorf.id, club_name: 'VBC Musterdorf', via: 'team', gender: 'm', active: true }])
    assert.deepEqual(me.roles, ['team_manager'])
    // db/036 (var-roleless-reads-1): no member of the team's club; its reads go through the team
    assert.deepEqual(me.clubs, [])
    assert.equal(me.canScore, false)
    assert.equal(me.isPending, false)
    const teams = (await call(users.clubmgr, 'GET', `/api/club/${musterdorf.id}/teams`)).json.data.teams
    assert.deepEqual(teams.find((t) => t.id === h1.id).managers.map((m) => m.user_id), [users.coach.id])
  })

  it('the team manager sees its own team\'s games from today, home and away, and no other team', async () => {
    const r = await call(users.coach, 'GET', `/api/team/${h1.id}/games`)
    assert.equal(r.status, 200, r.text)
    const games = r.json.data.games
    assert.deepEqual(games.map((g) => [g.game_number, g.side]), [['940006', 'home'], ['940001', 'home'], ['940002', 'away'], ['940005', 'home']])
    assert.equal(games.find((g) => g.game_number === '940006').started, true)
    assert.equal(games.find((g) => g.game_number === '940001').started, false)
    assert.equal(games[1].roster, null)
    // where and who: the hall's address and the referees' names, never their dates of birth
    const g1 = games.find((g) => g.game_number === '940001')
    assert.deepEqual([g1.hall, g1.hall_address, g1.hall_postal_code, g1.city, g1.referees], ['Halle Musterdorf', 'Sportweg 1', '8000', 'Zürich', ['Rita Referee', 'Sam Second']])
    assert.deepEqual(games.find((g) => g.game_number === '940002').referees, [])
    assert.equal(JSON.stringify(games).includes('1980-01-02'), false)
    assert.equal((await call(users.coach, 'GET', `/api/team/${d2.id}/games`)).status, 403)
    assert.equal((await call(users.stranger, 'GET', `/api/team/${h1.id}/games`)).status, 403)
  })

  it('a game roster: the game rules, its own games only, no lock after kick-off', async () => {
    const path = (n) => `/api/team/${h1.id}/roster?game=${n}`
    const fifteen = Array.from({ length: 15 }, (_, i) => player(i + 1, `L${i}`))
    assert.equal((await call(users.coach, 'PUT', path('940001'), { players: fifteen, staff: [] })).status, 400)
    assert.equal((await call(users.coach, 'PUT', path('940001'), { players: [player(null, 'NoNumber')], staff: [] })).status, 400)
    // 13 or 14 players only with two liberos (owner 2026-11-11)
    const thirteen = Array.from({ length: 13 }, (_, i) => player(i + 1, `T${i}`, { is_libero: i === 0 }))
    const t13 = await call(users.coach, 'PUT', path('940001'), { players: thirteen, staff: [] })
    assert.equal(t13.status, 400, t13.text)
    assert.match(t13.json.error.details || t13.json.error.message || '', /2 liberos/)
    const fourteen = Array.from({ length: 14 }, (_, i) => player(i + 1, `F${i}`, { is_libero: i < 2 }))
    const f14 = await call(users.coach, 'PUT', path('940001'), { players: fourteen, staff: [] })
    assert.equal(f14.status, 200, f14.text)
    const threeLiberos = [1, 2, 3].map((n) => player(n, `Lib${n}`, { is_libero: true }))
    assert.equal((await call(users.coach, 'PUT', path('940001'), { players: threeLiberos, staff: [] })).status, 400)
    const twoCoaches = [{ role: 'Coach', last_name: 'A' }, { role: 'Coach', last_name: 'B' }]
    assert.equal((await call(users.coach, 'PUT', path('940001'), { players: [player(1, 'A')], staff: twoCoaches })).status, 400)
    // another team's game, a game not in the schedule
    const notMine = await call(users.coach, 'PUT', path('940004'), { players: [player(1, 'A')], staff: [] })
    assert.equal(notMine.status, 404, notMine.text)
    assert.equal(notMine.json.error.code, 'OV_GAME_NOT_YOURS')
    assert.equal((await call(users.coach, 'PUT', `/api/team/${h1.id}/roster?game=abc`, { players: [], staff: [] })).status, 400)
    // started: still open (owner 2026-11-08, no lock)
    const late = await call(users.coach, 'PUT', path('940006'), { players: [player(1, 'A')], staff: [] })
    assert.equal(late.status, 200, late.text)
    assert.equal(late.json.data.started, true)
    // signatures made ahead: PNG data URLs, a coach's needs a Coach, a captain's a captain
    assert.equal((await call(users.coach, 'PUT', path('940001'), { players: [player(1, 'A', { is_captain: true })], staff: [], coach_signature: SIG })).status, 400)
    assert.equal((await call(users.coach, 'PUT', path('940001'), { players: [player(1, 'A')], staff: [], captain_signature: SIG })).status, 400)
    assert.equal((await call(users.coach, 'PUT', path('940001'), { players: [player(1, 'A', { is_captain: true })], staff: [], captain_signature: 'data:image/svg+xml;base64,PHN2Zz4=' })).status, 400)
    assert.equal((await call(users.coach, 'PUT', path('940001'), { players: [player(1, 'A', { is_captain: true })], staff: [], captain_signature: 'x'.repeat(10) })).status, 400)

    const players = [player(4, 'Muster', { is_captain: true }), player(7, 'Libero', { is_libero: true }), ...[1, 2, 3, 5, 6, 8].map((n) => player(n, `Spieler${n}`))]
    const staff = [{ role: 'Assistant Coach 1', first_name: 'A', last_name: 'Assist' }, { role: 'Coach', first_name: 'C', last_name: 'Coach', dob: '1980-01-01' }]
    const ok1 = await call(users.coach, 'PUT', path('940001'), { players, staff, coach_signature: SIG, captain_signature: SIG })
    assert.equal(ok1.status, 200, ok1.text)
    assert.equal(ok1.json.data.roster.coach_signature, SIG)
    assert.equal(ok1.json.data.roster.used_at, null)
    assert.equal(ok1.json.data.side, 'home')
    assert.equal(ok1.json.data.roster.players.length, 8)
    assert.deepEqual(ok1.json.data.roster.staff.map((s) => s.role), ['Coach', 'Assistant Coach 1'])
    assert.equal(ok1.json.data.roster.updated_by_name, 'coach Test')
    const away = await call(users.coach, 'PUT', path('940002'), { players: players.slice(0, 6), staff: [] })
    assert.equal(away.status, 200, away.text)
    assert.equal(away.json.data.side, 'away')

    const read = await call(users.coach, 'GET', path('940001'))
    assert.equal(read.status, 200, read.text)
    assert.equal(read.json.data.roster.players[0].last_name, 'Muster')
    const games = (await call(users.coach, 'GET', `/api/team/${h1.id}/games`)).json.data.games
    assert.equal(games.find((g) => g.game_number === '940001').roster.players, 8)
    assert.deepEqual(games.find((g) => g.game_number === '940001').roster.signed, { coach: true, captain: true })
    // the club manager acts for the team too
    assert.equal((await call(users.clubmgr, 'GET', path('940001'))).status, 200)
  })

  it('the first write swept a roster of a game more than 14 days ago', async () => {
    const { rows } = await sql.query("SELECT 1 FROM public.game_rosters WHERE game_number = '939999'")
    assert.equal(rows.length, 0)
  })

  it('the home club\'s scorer downloads the rosters of its home games (both teams), other scorers ask by game', async () => {
    const r = await call(users.scorer, 'GET', '/api/game-rosters')
    assert.equal(r.status, 200, r.text)
    // home games of VBCM today .. +7 days: 940006, 940001, 940004 (not 940002, an away game; not 940005, +12 days)
    assert.deepEqual(r.json.data.games.map((g) => g.game_number).sort(), ['940001', '940004', '940006'])
    assert.deepEqual(r.json.data.rosters.map((x) => [x.game_number, x.side]).sort(), [['940001', 'home'], ['940006', 'home']])
    const sent = r.json.data.rosters.find((x) => x.game_number === '940001')
    assert.equal(sent.coach_signature, SIG)
    assert.equal(sent.captain_signature, SIG)
    assert.equal(sent.team_name, 'VBC Musterdorf H1')
    assert.equal(sent.players.length, 8)
    assert.equal(sent.players[0].dob, '2001-02-03')
    assert.equal(sent.season, season)

    const o = await call(users.otherscorer, 'GET', '/api/game-rosters')
    assert.equal(o.status, 200, o.text)
    assert.deepEqual(o.json.data.rosters.map((x) => x.game_number), ['940002'])
    // db/035: by game number only the home club's games, a match the caller holds, or its own team's roster
    const byGame = await call(users.otherscorer, 'GET', '/api/game-rosters?games=940001,940002')
    assert.deepEqual(byGame.json.data.rosters.map((x) => `${x.game_number}|${x.side}`).sort(), ['940002|away'])
    const { rows: [m] } = await sql.query(
      "INSERT INTO public.matches (external_id, status, created_by, game_n, sport_type) VALUES ('m-940001', 'setup', $1, 940001, 'indoor') RETURNING id, official_season",
      [users.otherscorer.id])
    assert.equal(m.official_season, season)
    const held = await call(users.otherscorer, 'GET', '/api/game-rosters?games=940001')
    assert.deepEqual(held.json.data.rosters.map((x) => `${x.game_number}|${x.side}`), ['940001|home'])
    // the signatures made ahead name the account that sent them
    assert.equal(held.json.data.rosters[0].coach_signed_by_name, 'coach Test')
    await sql.query("DELETE FROM public.matches WHERE external_id = 'm-940001'")
    assert.deepEqual((await call(users.otherscorer, 'GET', '/api/game-rosters?games=940001')).json.data.rosters, [])
    // every read that hands out a roster is audited (game numbers and sides only)
    const { rows: reads } = await sql.query("SELECT details FROM public.audit_log WHERE action = 'team.roster' AND actor_id = $1 AND details ? 'read'", [users.otherscorer.id])
    assert.ok(reads.some((x) => x.details.read.includes('940001|home')))
    assert.ok(!JSON.stringify(reads).includes('Muster'))
    assert.equal((await call(users.otherscorer, 'GET', '/api/game-rosters?games=1;2')).status, 400)
    // a team manager without a scoring role reads nothing here
    assert.equal((await call(users.coach, 'GET', '/api/game-rosters')).status, 403)
    assert.equal((await api(srv.base, '/api/game-rosters')).status, 401)
  })

  it('accepted in Match Setup: the content stays until it expires, the team sees "accepted", a new version is offered again', async () => {
    const r = await call(users.scorer, 'GET', '/api/game-rosters?games=940006')
    const sent = r.json.data.rosters[0]
    // another version than the one on the tablet: left alone
    const stale = await call(users.scorer, 'POST', '/api/game-rosters/used', { game_number: '940006', side: 'home', season: sent.season, updated_at: '2020-01-01T00:00:00.000Z' })
    assert.deepEqual(stale.json.data, { used: false, reason: 'changed' })
    assert.equal((await call(users.coach, 'POST', '/api/game-rosters/used', { game_number: '940006', side: 'home', updated_at: sent.updated_at })).status, 403)
    // db/035: a scorer of another club can't accept it (the same answer as no roster)
    const foreign = await call(users.otherscorer, 'POST', '/api/game-rosters/used', { game_number: '940006', side: 'home', season: sent.season, updated_at: sent.updated_at })
    assert.deepEqual(foreign.json.data, { used: false, reason: 'gone' })
    assert.equal((await sql.query("SELECT used_at FROM public.game_rosters WHERE game_number = '940006'")).rows[0].used_at, null)
    const used = await call(users.scorer, 'POST', '/api/game-rosters/used', { game_number: '940006', side: 'home', season: sent.season, updated_at: sent.updated_at })
    assert.equal(used.status, 200, used.text)
    assert.deepEqual(used.json.data, { used: true })
    const { rows: [row] } = await sql.query("SELECT players, staff, used_at, used_by, used_match_id, expires_at FROM public.game_rosters WHERE game_number = '940006'")
    assert.equal(row.players.length, 1)
    assert.equal(row.used_match_id, null)
    assert.ok(row.expires_at > new Date())
    assert.ok(row.used_at)
    assert.equal(row.used_by, users.scorer.id)
    // scorers no longer get it (the game is still covered, so tablets drop their copy)
    const after = await call(users.scorer, 'GET', '/api/game-rosters')
    assert.ok(!after.json.data.rosters.some((x) => x.game_number === '940006'))
    assert.ok(after.json.data.games.some((g) => g.game_number === '940006'))
    // the team sees who accepted it, when
    const view = (await call(users.coach, 'GET', `/api/team/${h1.id}/roster?game=940006`)).json.data.roster
    assert.equal(view.players.length, 1)
    assert.equal(view.used_by_name, 'scorer Test')
    const g = (await call(users.coach, 'GET', `/api/team/${h1.id}/games`)).json.data.games.find((x) => x.game_number === '940006')
    assert.ok(g.roster.used_at)
    // idempotent
    assert.equal((await call(users.scorer, 'POST', '/api/game-rosters/used', { game_number: '940006', side: 'home', updated_at: sent.updated_at })).json.data.already, true)
    // a new version is a fresh roster again
    const again = await call(users.coach, 'PUT', `/api/team/${h1.id}/roster?game=940006`, { players: [player(2, 'B')], staff: [] })
    assert.equal(again.json.data.roster.used_at, null)
    assert.ok((await call(users.scorer, 'GET', '/api/game-rosters')).json.data.rosters.some((x) => x.game_number === '940006'))
    assert.equal((await call(users.scorer, 'POST', '/api/game-rosters/used', { game_number: 'x', side: 'home', updated_at: sent.updated_at })).status, 400)
  })

  it('a signature made ahead belongs to the roster it was made on and names its sender (db/035)', async () => {
    const path = `/api/team/${h1.id}/roster?game=940001`
    const before = (await call(users.coach, 'GET', path)).json.data.roster
    assert.equal(before.coach_signature, SIG)
    // the same images sent again with another list of players: dropped
    const changed = await call(users.clubmgr, 'PUT', path, { players: [...before.players, player(9, 'Extra')], staff: before.staff, coach_signature: SIG, captain_signature: SIG })
    assert.equal(changed.status, 200, changed.text)
    assert.equal(changed.json.data.roster.coach_signature, null)
    assert.equal(changed.json.data.roster.captain_signature, null)
    // a new image is the sender's; sent again unchanged it stays
    const SIG2 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAAC'
    const signed = await call(users.coach, 'PUT', path, { players: before.players, staff: before.staff, coach_signature: SIG2 })
    assert.equal(signed.json.data.roster.coach_signature, SIG2)
    const same = await call(users.clubmgr, 'PUT', path, { players: before.players, staff: before.staff, coach_signature: SIG2 })
    assert.equal(same.json.data.roster.coach_signature, SIG2)
    const { rows: [r] } = await sql.query("SELECT coach_signed_by, coach_signed_hash, club_id, team_id FROM public.game_rosters WHERE game_number = '940001'")
    assert.equal(r.coach_signed_by, users.coach.id)
    assert.match(r.coach_signed_hash, /^[0-9a-f]{64}$/)
    assert.deepEqual([r.club_id, r.team_id], [musterdorf.id, h1.id])
  })

  it('rosters go at expires_at (also without requests) and with their team (db/035)', async () => {
    const { createTeams } = await import('../lib/teams.js')
    const pool = new pg.Pool({ connectionString: db.url, max: 2 })
    try {
      await sql.query(`INSERT INTO public.game_rosters (game_number, season, side, team_name, club_id, team_id, kickoff, expires_at)
        VALUES ('940098', $1, 'home', 'VBC Musterdorf H1', $2, $3, $4, now() - interval '1 minute')`, [season, musterdorf.id, h1.id, `${today}T18:00:00`])
      const tms = createTeams({ pool, audit: async () => {}, savedTeams: null, clubs: null, logger: { info () {}, warn () {}, error () {} } })
      assert.ok(await tms.sweep({ force: true }) >= 1)
      assert.equal((await sql.query("SELECT 1 FROM public.game_rosters WHERE game_number = '940098'")).rows.length, 0)
      assert.equal((await sql.query("SELECT 1 FROM public.game_rosters WHERE game_number = '940001'")).rows.length, 1)
    } finally { await pool.end() }
    const { rows: [t] } = await sql.query("INSERT INTO public.club_teams (club_id, team_name) VALUES ($1, 'VBC Musterdorf X9') RETURNING id", [musterdorf.id])
    await sql.query(`INSERT INTO public.game_rosters (game_number, season, side, team_name, club_id, team_id, expires_at)
      VALUES ('940099', $1, 'home', 'VBC Musterdorf X9', $2, $3, now() + interval '1 day')`, [season, musterdorf.id, t.id])
    await sql.query('DELETE FROM public.club_teams WHERE id = $1', [t.id])
    assert.equal((await sql.query("SELECT 1 FROM public.game_rosters WHERE game_number = '940099'")).rows.length, 0)
  })

  it('/api/me gives an admin every team of every club', async () => {
    const me = (await call(users.admin, 'GET', '/api/me')).json.data
    assert.deepEqual(me.managedTeams.map((t) => [t.club_name, t.name, t.via]), [
      ['VBC Musterdorf', 'VBC Musterdorf D2', 'admin'], ['VBC Musterdorf', 'VBC Musterdorf H1', 'admin'],
      ['VBC Other', 'VBC Other D1', 'admin'], ['VBC Other', 'VBC Other H1', 'admin']
    ])
    assert.equal((await call(users.admin, 'GET', `/api/team/${h1.id}/games`)).status, 200)
  })

  it('the squad: none yet, the first save makes the saved team in the league\'s competition, scorers load it', async () => {
    const r0 = await call(users.coach, 'GET', `/api/team/${h1.id}/squad`)
    assert.equal(r0.status, 200, r0.text)
    assert.equal(r0.json.data.squad, null)
    const body = { players: [player(4, 'Muster', { is_captain: true, license_number: 'L-4' }), player(9, 'Reserve', { active: false })], staff: [{ role: 'Coach', last_name: 'Coach' }] }
    const r1 = await call(users.coach, 'PUT', `/api/team/${h1.id}/squad`, body)
    assert.equal(r1.status, 200, r1.text)
    assert.equal(r1.json.data.squad.svrz_team_name, 'VBC Musterdorf H1')
    assert.equal(r1.json.data.squad.club, 'VBC Musterdorf')
    assert.equal(r1.json.data.squad.players.length, 2)
    const bundle = (await call(users.scorer, 'GET', '/api/saved-teams')).json.data
    const comp = bundle.competitions.find((c) => c.vm_leagues.includes('2L Herren'))
    assert.ok(comp, 'a competition for the league')
    assert.equal(comp.gender, 'men')
    assert.ok(bundle.teams.some((t) => t.svrz_team_name === 'VBC Musterdorf H1' && t.competition_id === comp.id))
    // a second save edits the same saved team
    const r2 = await call(users.coach, 'PUT', `/api/team/${h1.id}/squad`, { ...body, players: body.players.slice(0, 1) })
    assert.equal(r2.status, 200, r2.text)
    assert.equal(r2.json.data.squad.id, r1.json.data.squad.id)
    // D2's first save finds an existing competition of its league (made by a competition manager)
    const made = await call(users.admin, 'POST', '/api/saved-teams/competitions', { name: 'Damen 3. Liga', season: r0.json.data.season, gender: 'women', vm_leagues: ['3L Damen'] })
    assert.equal(made.status, 201, made.text)
    const r3 = await call(users.clubmgr, 'PUT', `/api/team/${d2.id}/squad`, { players: [player(1, 'D')], staff: [] })
    assert.equal(r3.status, 200, r3.text)
    assert.equal(r3.json.data.squad.competition_id, made.json.data.competition.id)
  })

  it('an admin editing the club\'s teams keeps the team\'s id and managers; taking the team off drops them', async () => {
    const r = await call(users.admin, 'PATCH', `/api/admin/clubs/${musterdorf.id}`, { teams: ['VBC Musterdorf H1', 'VBC Musterdorf D2', 'VBC Musterdorf H2'] })
    assert.equal(r.status, 200, r.text)
    const teams = (await call(users.clubmgr, 'GET', `/api/club/${musterdorf.id}/teams`)).json.data.teams
    assert.equal(teams.find((t) => t.name === 'VBC Musterdorf H1').id, h1.id)
    assert.deepEqual(teams.find((t) => t.name === 'VBC Musterdorf H1').managers.map((m) => m.user_id), [users.coach.id])
    const r2 = await call(users.admin, 'PATCH', `/api/admin/clubs/${musterdorf.id}`, { teams: ['VBC Musterdorf H1', 'VBC Musterdorf H2'] })
    assert.equal(r2.status, 200, r2.text)
    assert.equal((await call(users.clubmgr, 'GET', `/api/team/${d2.id}`)).status, 403)
  })

  it('the club manager takes a team manager off; the account keeps nothing of the team', async () => {
    const r = await call(users.clubmgr, 'DELETE', `/api/club/${musterdorf.id}/teams/${h1.id}/managers/${users.coach.id}`)
    assert.equal(r.status, 200, r.text)
    assert.deepEqual((await call(users.coach, 'GET', '/api/me')).json.data.managedTeams, [])
    assert.equal((await call(users.coach, 'GET', `/api/team/${h1.id}/games`)).status, 403)
    assert.equal((await call(users.clubmgr, 'DELETE', `/api/club/${musterdorf.id}/teams/${h1.id}/managers/${users.coach.id}`)).status, 404)
    const { rows } = await sql.query("SELECT action, details FROM public.audit_log WHERE action LIKE 'team.%' ORDER BY at")
    assert.ok(rows.some((x) => x.action === 'team.roster' && x.details.players === 8 && !JSON.stringify(x.details).includes('Muster')))
    assert.ok(rows.some((x) => x.action === 'team.managers' && x.details.removed === true))
  })

  it('a team manager taken off does not come back with its link, nor does anyone it passes the link to (be-clubs-teams-5)', async () => {
    const link = await call(users.clubmgr, 'POST', `/api/club/${musterdorf.id}/teams/${h1.id}/invites`, { max_uses: 3 })
    assert.equal(link.status, 201, link.text)
    const linkCode = link.json.data.code
    // a preview tells the team and grants nothing
    const peek = await call(users.coach2, 'POST', '/api/account/invite-preview', { code: linkCode })
    assert.equal(peek.status, 200, peek.text)
    assert.deepEqual([peek.json.data.preview, peek.json.data.role_granted, peek.json.data.team.name, peek.json.data.already_had], [true, 'team_manager', 'VBC Musterdorf H1', false])
    assert.equal((await call(users.coach2, 'GET', `/api/team/${h1.id}/games`)).status, 403)
    assert.equal((await sql.query('SELECT uses FROM public.invite_codes WHERE id = $1', [link.json.data.invite.id])).rows[0].uses, 0)
    const r = await call(users.coach2, 'POST', '/api/account/redeem-invite', { code: linkCode })
    assert.equal(r.status, 200, r.text)
    assert.equal((await call(users.coach2, 'GET', `/api/team/${h1.id}/games`)).status, 200)
    const off = await call(users.clubmgr, 'DELETE', `/api/club/${musterdorf.id}/teams/${h1.id}/managers/${users.coach2.id}`)
    assert.equal(off.status, 200, off.text)
    assert.equal(off.json.data.links_revoked, 1)
    // the same link again: refused, and nothing comes back
    const again = await call(users.coach2, 'POST', '/api/account/redeem-invite', { code: linkCode })
    assert.equal(again.status, 404, again.text)
    assert.equal((await call(users.coach2, 'GET', `/api/team/${h1.id}/games`)).status, 403)
    assert.equal((await call(users.coach2, 'GET', `/api/team/${h1.id}/club-players`)).status, 403)
    const me = (await call(users.coach2, 'GET', '/api/me')).json.data
    assert.deepEqual([me.managedTeams, me.clubs, me.roles], [[], [], []])
    // passed on to someone else: revoked for them too
    assert.equal((await call(users.friend, 'POST', '/api/account/redeem-invite', { code: linkCode })).status, 404)
    const teams = (await call(users.clubmgr, 'GET', `/api/club/${musterdorf.id}/teams`)).json.data.teams
    assert.deepEqual(teams.find((t) => t.id === h1.id).managers.map((m) => m.user_id).filter((id) => id === users.coach2.id || id === users.friend.id), [])
    const { rows: [inv] } = await sql.query('SELECT uses, revoked_at FROM public.invite_codes WHERE id = $1', [link.json.data.invite.id])
    assert.equal(inv.uses, 1)
    assert.ok(inv.revoked_at)
    const { rows: audit } = await sql.query("SELECT details FROM public.audit_log WHERE action = 'invite.revoke' AND details ->> 'invite_id' = $1", [link.json.data.invite.id])
    assert.equal(audit[0]?.details.reason, 'team_manager_removed')
  })

  it('a link not revoked (made again for the same team): the account taken off it is still refused', async () => {
    const link = await call(users.clubmgr, 'POST', `/api/club/${musterdorf.id}/teams/${h1.id}/invites`, { max_uses: 3 })
    const linkCode = link.json.data.code
    assert.equal((await call(users.coach2, 'POST', '/api/account/redeem-invite', { code: linkCode })).status, 200)
    await sql.query('DELETE FROM public.team_managers WHERE team_id = $1 AND user_id = $2', [h1.id, users.coach2.id])
    const again = await call(users.coach2, 'POST', '/api/account/redeem-invite', { code: linkCode })
    assert.equal(again.status, 409, again.text)
    assert.equal(again.json.error.code, 'OV_INVITE_REMOVED')
    assert.equal((await call(users.coach2, 'GET', `/api/team/${h1.id}/games`)).status, 403)
    assert.equal((await sql.query('SELECT uses FROM public.invite_codes WHERE id = $1', [link.json.data.invite.id])).rows[0].uses, 1)
  })

  it('a team manager deletes a sent roster', async () => {
    const r = await call(users.clubmgr, 'DELETE', `/api/team/${h1.id}/roster?game=940002`)
    assert.equal(r.status, 200, r.text)
    const o = await call(users.otherscorer, 'GET', '/api/game-rosters')
    assert.deepEqual(o.json.data.rosters, [])
    assert.ok(o.json.data.games.some((g) => g.game_number === '940002'))
  })
})
