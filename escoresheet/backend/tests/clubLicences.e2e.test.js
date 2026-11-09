/**
 * A club's licence lists from VolleyManager (db/024, lib/licences.js,
 * docs/club-licences-spec.md): the club manager's upload (replace semantics,
 * the five fields only), who reads what, the teams of each person, the
 * gender rule on squads and game rosters (the players only: the officials may
 * be anyone of the club), the audit and ON DELETE CASCADE.
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

const dayPlus = (day, n) => { const t = new Date(`${day}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10) }
// made-up people of VBC Musterdorf (no real person)
const ANNA = { sv_number: '100001', last_name: 'Beispiel', first_name: 'Anna', dob: '2004-05-06', gender: 'f' }
const LEA = { sv_number: '100002', last_name: 'Muster', first_name: 'Lea', dob: '2006-01-31', gender: 'f' }
const MARCO = { sv_number: '100003', last_name: 'Probe', first_name: 'Marco', dob: '2001-11-02', gender: 'm' }
const NOAH = { sv_number: '100004', last_name: 'Testmann', first_name: 'Noah', dob: null, gender: 'm' }
const COACH = { sv_number: '200001', last_name: 'Trainer', first_name: 'Tina', dob: '1980-03-04', gender: 'f' }
const player = (number, p, extra = {}) => ({ number, first_name: p.first_name, last_name: p.last_name, dob: p.dob, license_number: p.sv_number, ...extra })
const official = (role, p) => ({ role, first_name: p.first_name, last_name: p.last_name, dob: p.dob, license_number: p.sv_number })
const FIVE = ['dob', 'first_name', 'gender', 'last_name', 'sv_number']

describe('club licence lists', { skip: SKIP }, () => {
  let db, srv, sql
  let ipSeq = 1
  const users = {}
  const today = zurichDay()
  let musterdorf, other, h1, d1, mixed

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
  const put = (user, clubId, list, people) => call(user, 'PUT', `/api/club/${clubId}/licences/${list}`, { people })

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    srv = await bootServer({ DATABASE_URL: db.url, TRUST_PROXY: 'cloudflare', TRUST_PROXY_FROM: '127.0.0.1/32,::1/128' })
    // H1 plays men's games (vmSync writes 'men'), D1 women's, X1 a mixed one
    await sql.query(`INSERT INTO public.svrz_games (game_number, team_home, team_away, league, gender, hall, city, match_format, datetime) VALUES
      ('950001', 'VBC Musterdorf H1', 'VBC Other H1', '2L Herren', 'men', 'MSH', 'Musterdorf', 5, '${dayPlus(today, 2)}T18:00:00'),
      ('950002', 'VBC Other H1', 'VBC Musterdorf H1', '2L Herren', '', 'Halle Other', 'Bern', 5, '${dayPlus(today, 5)}T20:00:00'),
      ('950003', 'VBC Musterdorf D1', 'VBC Other D1', '3L Damen', 'women', 'MSH', 'Musterdorf', 5, '${dayPlus(today, 3)}T16:00:00'),
      ('950004', 'VBC Musterdorf X1', 'VBC Other X1', 'Mixed', 'mixed', 'MSH', 'Musterdorf', 5, '${dayPlus(today, 4)}T16:00:00')`)
    const admin = await account('admin', ['admin'])
    await account('clubmgr', null)
    await account('othermgr', null)
    await account('scorer', ['scorer'])
    await account('otherscorer', ['scorer'])
    await account('coach', null)
    await account('stranger', null)
    musterdorf = (await call(admin, 'POST', '/api/admin/clubs', { name: 'VBC Musterdorf', teams: ['VBC Musterdorf H1', 'VBC Musterdorf D1', 'VBC Musterdorf X1'] })).json.data.club
    other = (await call(admin, 'POST', '/api/admin/clubs', { name: 'VBC Other', teams: ['VBC Other H1', 'VBC Other D1'] })).json.data.club
    assert.equal((await call(admin, 'PUT', `/api/admin/clubs/${musterdorf.id}/managers`, { emails: [users.clubmgr.email] })).status, 200)
    assert.equal((await call(admin, 'PUT', `/api/admin/clubs/${other.id}/managers`, { emails: [users.othermgr.email] })).status, 200)
    await call(admin, 'PUT', `/api/admin/accounts/${users.scorer.id}/clubs`, { club_ids: [musterdorf.id] })
    await call(admin, 'PUT', `/api/admin/accounts/${users.otherscorer.id}/clubs`, { club_ids: [other.id] })
    const teams = (await call(users.clubmgr, 'GET', `/api/club/${musterdorf.id}/teams`)).json.data.teams
    h1 = teams.find((t) => t.name === 'VBC Musterdorf H1')
    d1 = teams.find((t) => t.name === 'VBC Musterdorf D1')
    mixed = teams.find((t) => t.name === 'VBC Musterdorf X1')
    // the coach manages H1 only (a team link)
    const link = await call(users.clubmgr, 'POST', `/api/club/${musterdorf.id}/teams/${h1.id}/invites`, { max_uses: 1 })
    assert.equal(link.status, 201, link.text)
    assert.equal((await call(users.coach, 'POST', '/api/account/redeem-invite', { code: link.json.data.code })).status, 200)
  })

  after(async () => {
    await sql?.end().catch(() => {})
    await srv?.stop()
    await db?.drop()
  })

  it('the club manager uploads a list: the five fields, a licence number twice is one person', async () => {
    const r = await put(users.clubmgr, musterdorf.id, 'players', [ANNA, LEA, MARCO, { ...MARCO, first_name: null, dob: null }, { ...NOAH, sv_number: Number(NOAH.sv_number) }])
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.data.list, 'players')
    assert.equal(r.json.data.count, 4)
    const { rows } = await sql.query('SELECT sv_number, last_name, first_name, dob::text AS dob, gender, imported_by FROM public.club_licences WHERE club_id = $1 ORDER BY sv_number', [musterdorf.id])
    assert.deepEqual(rows.map((x) => [x.sv_number, x.last_name, x.first_name, x.dob, x.gender]), [
      ['100001', 'Beispiel', 'Anna', '2004-05-06', 'f'],
      ['100002', 'Muster', 'Lea', '2006-01-31', 'f'],
      ['100003', 'Probe', 'Marco', '2001-11-02', 'm'],
      ['100004', 'Testmann', 'Noah', null, 'm']
    ])
    assert.ok(rows.every((x) => x.imported_by === users.clubmgr.id))
    assert.equal((await put(users.clubmgr, musterdorf.id, 'coaches', [COACH, { ...MARCO }])).status, 200)
  })

  it('refuses anything but the five fields, and bad values', async () => {
    const bad = async (people) => {
      const r = await put(users.clubmgr, musterdorf.id, 'players', people)
      assert.equal(r.status, 400, r.text)
      return r.json.error.details
    }
    assert.match(await bad([{ ...ANNA, email: 'anna@example.ch' }]), /email: not accepted/)
    assert.match(await bad([{ ...ANNA, phone: '000' }]), /phone: not accepted/)
    assert.match(await bad([{ ...ANNA, sv_number: '12' }]), /sv_number/)
    assert.match(await bad([{ ...ANNA, sv_number: '12a45' }]), /sv_number/)
    assert.match(await bad([{ ...ANNA, last_name: '  ' }]), /last_name/)
    assert.match(await bad([{ ...ANNA, last_name: 'x'.repeat(101) }]), /last_name/)
    assert.match(await bad([{ ...ANNA, dob: '06.05.2004' }]), /dob/)
    assert.match(await bad([{ ...ANNA, dob: '2004-02-30' }]), /dob/)
    assert.match(await bad([{ ...ANNA, gender: 'D' }]), /gender/)
    assert.match(await bad(Array.from({ length: 2001 }, (_, i) => ({ sv_number: String(300000 + i), last_name: 'L' }))), /at most 2000/)
    assert.equal((await call(users.clubmgr, 'PUT', `/api/club/${musterdorf.id}/licences/players`, { list: [] })).status, 400)
    // a list that does not exist: no such route
    assert.equal((await put(users.clubmgr, musterdorf.id, 'referees', [ANNA])).status, 404)
    // nothing of it was stored: the list is as before
    const { rows } = await sql.query("SELECT count(*)::int AS n FROM public.club_licences WHERE club_id = $1 AND list = 'players'", [musterdorf.id])
    assert.equal(rows[0].n, 4)
  })

  it('who may: the club\'s managers and admins; not another club\'s manager, a team manager, a scorer or anonymous', async () => {
    assert.equal((await put(users.othermgr, musterdorf.id, 'players', [ANNA])).status, 403)
    assert.equal((await call(users.othermgr, 'GET', `/api/club/${musterdorf.id}/licences`)).status, 403)
    assert.equal((await call(users.coach, 'GET', `/api/club/${musterdorf.id}/licences`)).status, 403)
    assert.equal((await put(users.coach, musterdorf.id, 'players', [ANNA])).status, 403)
    assert.equal((await call(users.scorer, 'GET', `/api/club/${musterdorf.id}/licences`)).status, 403)
    assert.equal((await call(null, 'GET', `/api/club/${musterdorf.id}/licences`)).status, 401)
    assert.equal((await put(null, musterdorf.id, 'players', [ANNA])).status, 401)
    assert.equal((await call(null, 'GET', `/api/team/${h1.id}/club-players`)).status, 401)
    assert.equal((await call(null, 'GET', '/api/club-licences')).status, 401)
    assert.equal((await call(users.admin, 'GET', `/api/club/${musterdorf.id}/licences`)).status, 200)
    // the other club's manager reads its own (empty) lists
    const own = await call(users.othermgr, 'GET', `/api/club/${other.id}/licences`)
    assert.equal(own.status, 200, own.text)
    assert.deepEqual(own.json.data.people, [])
    assert.deepEqual(own.json.data.lists.players, { count: 0, imported_at: null, imported_by_name: null })
  })

  it('the team manager reads the club\'s lists through its team only, with the team\'s gender', async () => {
    const r = await call(users.coach, 'GET', `/api/team/${h1.id}/club-players`)
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.data.gender, 'm')
    assert.equal(r.json.data.team.club_id, musterdorf.id)
    // players: the players list (the player rows, as before)
    assert.deepEqual(r.json.data.players.map((p) => p.sv_number), ['100001', '100002', '100003', '100004'])
    assert.deepEqual(Object.keys(r.json.data.players[0]).sort(), FIVE)
    // people: everyone of the three lists once, with its lists (the team officials)
    assert.deepEqual(r.json.data.people.map((p) => [p.sv_number, p.lists]), [
      ['100001', ['players']], ['100002', ['players']], ['100003', ['players', 'coaches']], ['100004', ['players']], ['200001', ['coaches']]
    ])
    assert.deepEqual(Object.keys(r.json.data.people[0]).sort(), [...FIVE, 'lists'].sort())
    assert.deepEqual(r.json.data.people.find((p) => p.sv_number === '200001'), { ...COACH, lists: ['coaches'] })
    // not the club's other teams
    assert.equal((await call(users.coach, 'GET', `/api/team/${d1.id}/club-players`)).status, 403)
    assert.equal((await call(users.stranger, 'GET', `/api/team/${h1.id}/club-players`)).status, 403)
    // the club manager acts for each team; a mixed team has no gender
    assert.equal((await call(users.clubmgr, 'GET', `/api/team/${d1.id}/club-players`)).json.data.gender, 'f')
    assert.equal((await call(users.clubmgr, 'GET', `/api/team/${mixed.id}/club-players`)).json.data.gender, null)
  })

  it('a scorer downloads the lists of its own clubs only', async () => {
    const r = await call(users.scorer, 'GET', '/api/club-licences')
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.data.clubs.length, 1)
    const c = r.json.data.clubs[0]
    assert.equal(c.club_id, musterdorf.id)
    assert.deepEqual(c.team_names, ['VBC Musterdorf D1', 'VBC Musterdorf H1', 'VBC Musterdorf X1'])
    assert.deepEqual(c.team_genders, { 'VBC Musterdorf D1': 'f', 'VBC Musterdorf H1': 'm', 'VBC Musterdorf X1': null })
    // players: the players list only, as release 3.0.15 reads it (five fields)
    assert.deepEqual(c.players.map((p) => p.sv_number), ['100001', '100002', '100003', '100004'])
    assert.deepEqual(Object.keys(c.players[0]).sort(), FIVE)
    // people: the whole club once, with its lists, for the bench officials
    assert.deepEqual(c.people.map((p) => [p.last_name, p.lists]), [
      ['Beispiel', ['players']], ['Muster', ['players']], ['Probe', ['players', 'coaches']], ['Testmann', ['players']], ['Trainer', ['coaches']]
    ])
    assert.deepEqual(c.people.find((p) => p.sv_number === '100003'), { ...MARCO, lists: ['players', 'coaches'] })
    const o = await call(users.otherscorer, 'GET', '/api/club-licences')
    assert.equal(o.status, 200, o.text)
    assert.deepEqual(o.json.data.clubs.map((x) => [x.club_id, x.players.length, x.people.length]), [[other.id, 0, 0]])
    // a team manager without a scoring role reads nothing here
    assert.equal((await call(users.coach, 'GET', '/api/club-licences')).status, 403)
    assert.equal((await call(users.clubmgr, 'GET', '/api/club-licences')).status, 403)
  })

  it('a player of the club with the other gender than the team\'s is refused in the squad and in a game roster', async () => {
    // the men's team: Anna (f) at index 1
    const squad = await call(users.coach, 'PUT', `/api/team/${h1.id}/squad`, { players: [player(1, MARCO), player(2, ANNA), player(3, NOAH)], staff: [] })
    assert.equal(squad.status, 400, squad.text)
    assert.equal(squad.json.error.code, 'OV_WRONG_GENDER')
    assert.equal(squad.json.error.index, 1)
    const roster = await call(users.coach, 'PUT', `/api/team/${h1.id}/roster?game=950001`, { players: [player(1, MARCO), player(2, NOAH), player(3, LEA)], staff: [] })
    assert.equal(roster.status, 400, roster.text)
    assert.equal(roster.json.error.code, 'OV_WRONG_GENDER')
    assert.equal(roster.json.error.index, 2)
    // the right gender, a licence not in the list, a player without a licence: fine
    const ok1 = await call(users.coach, 'PUT', `/api/team/${h1.id}/squad`, { players: [player(1, MARCO), player(3, NOAH), player(5, { ...ANNA, sv_number: '999999' }), { number: 6, first_name: 'Ohne', last_name: 'Lizenz' }], staff: [player(null, COACH)].map(({ number, ...s }) => ({ ...s, role: 'Coach' })) })
    assert.equal(ok1.status, 200, ok1.text)
    assert.equal((await call(users.coach, 'PUT', `/api/team/${h1.id}/roster?game=950001`, { players: [player(1, MARCO), player(3, NOAH)], staff: [] })).status, 200)
    // the women's team takes the women; a team without a known gender is not checked
    assert.equal((await call(users.clubmgr, 'PUT', `/api/team/${d1.id}/squad`, { players: [player(1, ANNA), player(2, MARCO)], staff: [] })).json.error?.code, 'OV_WRONG_GENDER')
    assert.equal((await call(users.clubmgr, 'PUT', `/api/team/${d1.id}/squad`, { players: [player(1, ANNA), player(2, LEA)], staff: [] })).status, 200)
    assert.equal((await call(users.clubmgr, 'PUT', `/api/team/${mixed.id}/squad`, { players: [player(1, ANNA), player(2, MARCO)], staff: [] })).status, 200)
  })

  it('the team\'s officials may be anyone of the club, of either gender: never refused', async () => {
    // the men's team: Anna (f, players list) and Tina (f, coaches list) on the bench
    const roster = await call(users.coach, 'PUT', `/api/team/${h1.id}/roster?game=950001`, {
      players: [player(1, MARCO), player(3, NOAH)],
      staff: [official('Coach', ANNA), official('Assistant Coach 1', COACH)]
    })
    assert.equal(roster.status, 200, roster.text)
    const squad = await call(users.coach, 'PUT', `/api/team/${h1.id}/squad`, {
      players: [player(1, MARCO), player(3, NOAH), player(5, { ...ANNA, sv_number: '999999' }), { number: 6, first_name: 'Ohne', last_name: 'Lizenz' }],
      staff: [official('Coach', COACH), official('Assistant Coach 1', ANNA)]
    })
    assert.equal(squad.status, 200, squad.text)
    // the women's team: Marco (m, players and coaches lists) as coach
    assert.equal((await call(users.clubmgr, 'PUT', `/api/team/${d1.id}/squad`, { players: [player(1, ANNA), player(2, LEA)], staff: [official('Coach', MARCO)] })).status, 200)
    // still refused: the same person as a player of the other gender
    const wrong = await call(users.clubmgr, 'PUT', `/api/team/${d1.id}/squad`, { players: [player(1, ANNA), player(2, MARCO)], staff: [official('Coach', MARCO)] })
    assert.equal(wrong.json.error?.code, 'OV_WRONG_GENDER')
    assert.equal(wrong.json.error.index, 1)
  })

  it('the club\'s list: each person once, with its lists and the teams whose saved team has it', async () => {
    const r = await call(users.clubmgr, 'GET', `/api/club/${musterdorf.id}/licences`)
    assert.equal(r.status, 200, r.text)
    const d = r.json.data
    assert.equal(d.lists.players.count, 4)
    assert.equal(d.lists.coaches.count, 2)
    assert.equal(d.lists.scorers.count, 0)
    assert.equal(d.lists.players.imported_by_name, 'clubmgr Test')
    assert.ok(d.lists.players.imported_at)
    const by = Object.fromEntries(d.people.map((p) => [p.sv_number, p]))
    assert.deepEqual(d.people.map((p) => p.last_name), ['Beispiel', 'Muster', 'Probe', 'Testmann', 'Trainer'])
    assert.deepEqual(by['100003'].lists, ['players', 'coaches'])
    assert.deepEqual(by['200001'].lists, ['coaches'])
    // an official of the saved team counts too: Marco coaches D1, Anna is H1's assistant coach
    assert.deepEqual(by['100003'].teams.map((t) => t.name), ['VBC Musterdorf D1', 'VBC Musterdorf H1', 'VBC Musterdorf X1'])
    assert.deepEqual(by['100001'].teams.map((t) => t.name), ['VBC Musterdorf D1', 'VBC Musterdorf H1', 'VBC Musterdorf X1'])
    assert.deepEqual(by['200001'].teams.map((t) => [t.id, t.name]), [[h1.id, 'VBC Musterdorf H1']])
    assert.deepEqual(by['100004'].teams.map((t) => t.name), ['VBC Musterdorf H1'])
    assert.equal(by['100004'].dob, null)
    assert.deepEqual(Object.keys(by['100001']).sort(), ['dob', 'first_name', 'gender', 'last_name', 'lists', 'sv_number', 'teams'])
  })

  it('a new upload replaces that list only; an empty one clears it', async () => {
    const r = await put(users.clubmgr, musterdorf.id, 'players', [LEA, { ...MARCO, last_name: 'Probe-Neu' }])
    assert.equal(r.status, 200, r.text)
    const { rows } = await sql.query('SELECT list, sv_number, last_name FROM public.club_licences WHERE club_id = $1 ORDER BY list, sv_number', [musterdorf.id])
    assert.deepEqual(rows.map((x) => `${x.list}:${x.sv_number}:${x.last_name}`), [
      'coaches:100003:Probe', 'coaches:200001:Trainer', 'players:100002:Muster', 'players:100003:Probe-Neu'
    ])
    assert.equal((await put(users.admin, musterdorf.id, 'coaches', [])).status, 200)
    const left = await call(users.clubmgr, 'GET', `/api/club/${musterdorf.id}/licences`)
    assert.equal(left.json.data.lists.coaches.count, 0)
    assert.deepEqual(left.json.data.people.map((p) => p.sv_number), ['100002', '100003'])
    // Anna is no longer in the list: the men's team takes her now
    assert.equal((await call(users.coach, 'PUT', `/api/team/${h1.id}/roster?game=950001`, { players: [player(1, MARCO), player(2, ANNA)], staff: [] })).status, 200)
  })

  it('the audit keeps the club, the list and the count, never a name', async () => {
    const { rows } = await sql.query("SELECT actor_id, details FROM public.audit_log WHERE action = 'club.licences' ORDER BY at")
    assert.ok(rows.length >= 4)
    for (const r of rows) {
      assert.deepEqual(Object.keys(r.details).sort(), ['club_id', 'count', 'list'])
      const text = JSON.stringify(r.details)
      for (const name of ['Beispiel', 'Muster', 'Probe', 'Testmann', 'Trainer', '100001']) assert.ok(!text.includes(name), name)
    }
    assert.deepEqual(rows.slice(0, 2).map((r) => [r.details.list, r.details.count]), [['players', 4], ['coaches', 2]])
    assert.equal(rows[0].actor_id, users.clubmgr.id)
    const list = await call(users.admin, 'GET', '/api/admin/audit?action=club.licences')
    assert.equal(list.status, 200, list.text)
    assert.ok(list.json.data.entries.length >= 4)
  })

  it('the lists go with the club (ON DELETE CASCADE)', async () => {
    assert.equal((await put(users.clubmgr, musterdorf.id, 'scorers', [NOAH])).status, 200)
    const before = await sql.query('SELECT count(*)::int AS n FROM public.club_licences WHERE club_id = $1', [musterdorf.id])
    assert.ok(before.rows[0].n > 0)
    assert.equal((await call(users.admin, 'DELETE', `/api/admin/clubs/${musterdorf.id}`)).status, 200)
    const { rows } = await sql.query('SELECT count(*)::int AS n FROM public.club_licences WHERE club_id = $1', [musterdorf.id])
    assert.equal(rows[0].n, 0)
    assert.equal((await call(users.admin, 'GET', `/api/club/${musterdorf.id}/licences`)).status, 404)
    assert.equal((await put(users.admin, musterdorf.id, 'players', [ANNA])).status, 404)
  })
})
