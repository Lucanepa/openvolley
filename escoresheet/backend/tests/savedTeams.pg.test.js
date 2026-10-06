// lib/savedTeams.js on Postgres: competitions and teams CRUD, duplicate names,
// cascades, the roster PUT and the bundle.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { createSavedTeams, validateRoster } from '../lib/savedTeams.js'
import { SKIP_PG, createTestDatabase, quietLogger } from './helpers/pgTestDb.js'

const player = (number, last, extra = {}) => ({ number, first_name: 'P', last_name: last, dob: null, license_number: null, is_libero: false, is_captain: false, active: true, ...extra })

describe('validateRoster (pure)', () => {
  const details = (body) => validateRoster(body).error?.body.error.details
  it('accepts a full roster and sets sort_order', () => {
    const v = validateRoster({ players: [player(7, 'Muster', { is_captain: true }), player(null, 'NoNumber'), player(7, 'Old', { active: false, is_captain: true })], staff: [{ role: 'Coach', last_name: 'Trainer' }] })
    assert.equal(v.error, undefined)
    assert.deepEqual(v.players.map((p) => p.sort_order), [0, 1, 2])
    assert.equal(v.staff[0].first_name, '')
  })
  it('names the row of the first error', () => {
    assert.match(details({ players: [player(1, 'A'), player(2, '')], staff: [] }), /^players\[1\]\.last_name/)
    assert.match(details({ players: [player(100, 'A')], staff: [] }), /^players\[0\]\.number/)
    assert.match(details({ players: [player(5, 'A'), player(5, 'B')], staff: [] }), /^players\[1\]\.number: 5 is used twice/)
    assert.match(details({ players: [player(5, 'A', { is_captain: true }), player(6, 'B', { is_captain: true })], staff: [] }), /^players\[1\]\.is_captain/)
    assert.match(details({ players: [player(5, 'A', { dob: '31.12.1990' })], staff: [] }), /^players\[0\]\.dob/)
    assert.match(details({ players: [player(5, 'A', { dob: '2001-02-30' })], staff: [] }), /^players\[0\]\.dob/)
    assert.match(details({ players: [], staff: [{ role: 'Mascot', last_name: 'X' }] }), /^staff\[0\]\.role/)
    assert.match(details({ players: Array.from({ length: 41 }, (_, i) => player(null, `P${i}`)), staff: [] }), /^players: at most 40/)
    assert.match(details({ players: [], staff: Array.from({ length: 11 }, () => ({ role: 'Medic', last_name: 'M' })) }), /^staff: at most 10/)
    assert.match(details({ players: [] }), /^staff/)
    assert.match(details({ players: [player(1, 'A', { id: 'nope' })], staff: [] }), /^players\[0\]\.id/)
  })
})

describe('validateRoster beach (pure)', () => {
  const beach = (body) => validateRoster(body, { sport: 'beach' })
  const details = (body) => beach(body).error?.body.error.details
  const bp = (number, last, extra = {}) => ({ number, first_name: 'P', last_name: last, dob: null, license_number: null, ...extra })

  it('accepts a pair and a coach, normalises the country and stores the fixed flags', () => {
    const v = beach({ players: [bp(1, 'Müller', { country: ' che ', is_libero: false, is_captain: null, active: true }), bp(2, 'Weber', { country: '' })], staff: [{ role: 'Coach', last_name: 'Kunz' }] })
    assert.equal(v.error, undefined)
    assert.deepEqual(v.players.map((p) => [p.number, p.country, p.is_libero, p.is_captain, p.active, p.sort_order]),
      [[1, 'CHE', false, false, true, 0], [2, null, false, false, true, 1]])
    assert.deepEqual(v.staff.map((x) => x.role), ['Coach'])
    assert.equal(beach({ players: [], staff: [] }).error, undefined, 'an empty team is allowed')
    assert.equal(beach({ players: [bp(2, 'Only')], staff: [] }).error, undefined, 'one player is allowed')
  })

  it('answers each rule with its exact details', () => {
    const cases = [
      [{ players: [bp(1, 'A'), bp(2, 'B'), bp(1, 'C')], staff: [] }, 'players: at most 2 in beach'],
      [{ players: [], staff: [{ role: 'Coach', last_name: 'A' }, { role: 'Coach', last_name: 'B' }] }, 'staff: at most 1 (the coach) in beach'],
      [{ players: [bp(1, '')], staff: [] }, 'players[0].last_name: required'],
      [{ players: [bp(1, 'A', { dob: '05.01.1998' })], staff: [] }, 'players[0].dob: YYYY-MM-DD or null'],
      [{ players: [bp(1, 'A', { license_number: 'x'.repeat(41) })], staff: [] }, 'players[0].license_number: at most 40 characters'],
      [{ players: [bp(3, 'A')], staff: [] }, 'players[0].number: 1 or 2'],
      [{ players: [bp(null, 'A')], staff: [] }, 'players[0].number: 1 or 2'],
      [{ players: [bp(1.5, 'A')], staff: [] }, 'players[0].number: 1 or 2'],
      [{ players: [bp(2, 'A'), bp(2, 'B')], staff: [] }, 'players[1].number: 2 is used twice'],
      [{ players: [bp(1, 'A', { is_libero: 'yes' })], staff: [] }, 'players[0].is_libero: true or false'],
      [{ players: [bp(1, 'A', { is_libero: true })], staff: [] }, 'players[0].is_libero: not in beach'],
      [{ players: [bp(1, 'A'), bp(2, 'B', { is_captain: true })], staff: [] }, 'players[1].is_captain: not in beach'],
      [{ players: [bp(1, 'A', { active: 0 })], staff: [] }, 'players[0].active: true or false'],
      [{ players: [bp(1, 'A', { active: false })], staff: [] }, 'players[0].active: not in beach'],
      [{ players: [bp(1, 'A', { country: 'CH' })], staff: [] }, "players[0].country: 3 letters like 'CHE'"],
      [{ players: [bp(1, 'A', { country: 'C1E' })], staff: [] }, "players[0].country: 3 letters like 'CHE'"],
      [{ players: [], staff: [{ role: 'Assistant Coach 1', last_name: 'A' }] }, 'staff[0].role: Coach only in beach'],
      [{ players: [], staff: [{ last_name: 'A' }] }, 'staff[0].role: Coach only in beach'],
      [{ players: {}, staff: [] }, 'players: an array'],
      ['x', 'body: must be an object']
    ]
    for (const [body, want] of cases) assert.equal(details(body), want, JSON.stringify(body))
  })

  it('indoor refuses a country; the one-argument call keeps the 2.1.0 rules', () => {
    assert.equal(validateRoster({ players: [player(5, 'A', { country: 'CHE' })], staff: [] }).error?.body.error.details, 'players[0].country: only for beach')
    assert.equal(validateRoster({ players: [player(5, 'A', { country: 'CHE' })], staff: [] }, { sport: 'indoor' }).error?.body.error.code, 'OV_INVALID_REQUEST')
    const v = validateRoster({ players: [player(5, 'A', { country: '' }), player(6, 'B', { country: null, is_libero: true })], staff: [{ role: 'Medic', last_name: 'M' }] })
    assert.equal(v.error, undefined)
    assert.deepEqual(v.players.map((p) => p.country), [null, null])
    assert.equal(v.players[1].is_libero, true)
  })
})

describe('savedTeams on Postgres', { skip: SKIP_PG }, () => {
  let tdb, pool, st, cm
  before(async () => {
    tdb = await createTestDatabase('savedteams')
    pool = new pg.Pool({ connectionString: tdb.url, options: '-c TimeZone=UTC' })
    st = createSavedTeams({ pool, logger: quietLogger() })
    cm = randomUUID()
    await pool.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [cm, 'cm@example.ch'])
  })
  after(async () => {
    await pool?.end()
    await tdb?.drop()
  })

  it('the bundle of an empty database has version 0', async () => {
    const b = await st.getBundle()
    assert.equal(b.status, 200)
    assert.equal(b.body.data.version, '0')
    assert.deepEqual(b.body.data.competitions, [])
    assert.deepEqual(b.body.data.teams, [])
    for (const sport of ['beach', 'all']) assert.equal((await st.getBundle({ sport })).body.data.version, '0', sport)
  })

  it('competitions: create, validate, patch, archive', async () => {
    const r = await st.createCompetition({ actorId: cm, body: { name: ' 2. Liga Herren ', season: '2026/27', gender: 'men', vm_leagues: ['2L', '2L', ' 2L H '] } })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    const c = r.body.data.competition
    assert.equal(c.name, '2. Liga Herren')
    assert.deepEqual(c.vm_leagues, ['2L', '2L H'])
    assert.equal(c.archived, false)
    for (const body of [{ season: '2026/27' }, { name: 'x', season: '2026/28' }, { name: 'x', season: '26/27' }, { name: 'x', season: '2026/27', gender: 'boys' },
      { name: 'x', season: '2026/27', vm_leagues: Array(21).fill('L') }, { name: 'x'.repeat(121), season: '2026/27' }]) {
      const bad = await st.createCompetition({ actorId: cm, body })
      assert.equal(bad.status, 400, JSON.stringify(body))
      assert.equal(bad.body.error.code, 'OV_INVALID_REQUEST')
    }
    const p = await st.updateCompetition({ id: c.id, body: { archived: true, category: 'Aktive' } })
    assert.equal(p.status, 200)
    assert.equal(p.body.data.competition.archived, true)
    assert.equal(p.body.data.competition.name, '2. Liga Herren')
    assert.equal((await st.updateCompetition({ id: randomUUID(), body: { archived: false } })).status, 404)
    assert.equal((await st.updateCompetition({ id: c.id, body: { archived: 'yes' } })).status, 400)
  })

  it('teams: create, duplicate name 409, patch, roster round trip, bundle', async () => {
    const { body: { data: { competition: c } } } = await st.createCompetition({ actorId: cm, body: { name: '3. Liga', season: '2026/27' } })
    const t = await st.createTeam({ actorId: cm, body: { competition_id: c.id, name: 'VBC Test', short_name: 'VBC', color: '#E2001A', svrz_team_name: 'VBC Test 1' } })
    assert.equal(t.status, 201, JSON.stringify(t.body))
    const team = t.body.data.team
    assert.equal(team.color, '#e2001a')
    assert.deepEqual([team.players, team.staff], [[], []])
    const dup = await st.createTeam({ actorId: cm, body: { competition_id: c.id, name: 'vbc test' } })
    assert.equal(dup.status, 409)
    assert.equal(dup.body.error.code, 'OV_DUPLICATE')
    assert.equal((await st.createTeam({ actorId: cm, body: { competition_id: randomUUID(), name: 'X' } })).status, 404)
    assert.equal((await st.createTeam({ actorId: cm, body: { competition_id: c.id, name: 'X', color: 'red' } })).status, 400)
    const t2 = await st.createTeam({ actorId: cm, body: { competition_id: c.id, name: 'Other' } })
    assert.equal((await st.updateTeam({ id: t2.body.data.team.id, body: { name: 'VBC TEST' } })).status, 409)
    assert.equal((await st.updateTeam({ id: team.id, body: { competition_id: c.id } })).status, 400)
    assert.equal((await st.updateTeam({ id: team.id, body: { club: 'VBC Club', short_name: '' } })).body.data.team.short_name, null)

    const before = (await st.getBundle()).body.data.version
    await new Promise((resolve) => setTimeout(resolve, 5))
    const put = await st.putRoster({ id: team.id, body: {
      players: [player(7, 'Muster', { first_name: 'Anna', dob: '2001-02-03', license_number: 'L-7', is_captain: true }), player(1, 'Libero', { is_libero: true })],
      staff: [{ role: 'Coach', first_name: 'Carl', last_name: 'Coach', dob: '1970-01-01' }]
    } })
    assert.equal(put.status, 200, JSON.stringify(put.body))
    const r1 = put.body.data.team
    assert.equal(r1.players.length, 2)
    assert.deepEqual({ ...r1.players[0], id: undefined }, { id: undefined, number: 7, first_name: 'Anna', last_name: 'Muster', dob: '2001-02-03', license_number: 'L-7', is_libero: false, is_captain: true, active: true, sort_order: 0, country: null })
    assert.equal(r1.staff[0].dob, '1970-01-01')
    const after1 = (await st.getBundle()).body.data.version
    assert.ok(after1 > before, 'the version moves')

    // keep Muster (by id, renumbered), drop Libero, add a new one
    const put2 = await st.putRoster({ id: team.id, body: {
      players: [player(3, 'New'), { ...r1.players[0], number: 8 }],
      staff: []
    } })
    assert.equal(put2.status, 200, JSON.stringify(put2.body))
    const r2 = put2.body.data.team
    assert.deepEqual(r2.players.map((p) => [p.last_name, p.number, p.sort_order]), [['New', 3, 0], ['Muster', 8, 1]])
    assert.equal(r2.players[1].id, r1.players[0].id, 'the id is kept')
    assert.equal(r2.staff.length, 0)
    assert.equal((await pool.query('SELECT count(*)::int n FROM competition_players WHERE team_id = $1', [team.id])).rows[0].n, 2)

    // an id of another team's player is refused, nothing changes
    const other = await st.putRoster({ id: t2.body.data.team.id, body: { players: [player(4, 'Theirs')], staff: [] } })
    const foreign = await st.putRoster({ id: team.id, body: { players: [{ ...other.body.data.team.players[0], number: 9 }], staff: [] } })
    assert.equal(foreign.status, 400)
    assert.match(foreign.body.error.details, /^players\[0\]\.id: belongs to another team/)
    assert.equal((await pool.query('SELECT count(*)::int n FROM competition_players WHERE team_id = $1', [team.id])).rows[0].n, 2)
    // an unknown id is a new row with a server id
    const ghostId = randomUUID()
    const ghost = await st.putRoster({ id: t2.body.data.team.id, body: { players: [player(4, 'Ghost', { id: ghostId })], staff: [] } })
    assert.notEqual(ghost.body.data.team.players[0].id, ghostId)
    assert.equal((await st.putRoster({ id: randomUUID(), body: { players: [], staff: [] } })).status, 404)

    const b = (await st.getBundle()).body.data
    assert.deepEqual(Object.keys(b).sort(), ['competitions', 'fetched_at', 'sport', 'teams', 'version'])
    assert.equal(b.sport, 'indoor')
    const bt = b.teams.find((x) => x.id === team.id)
    assert.deepEqual(Object.keys(bt).sort(), ['club', 'color', 'competition_id', 'id', 'name', 'players', 'short_name', 'sport', 'staff', 'svrz_team_name', 'updated_at'])
    assert.equal(bt.sport, 'indoor')
    assert.equal(bt.players.length, 2)
    assert.ok(b.competitions.some((x) => x.archived === true), 'archived competitions are included')
  })

  it('deletes cascade: team -> roster, competition -> teams', async () => {
    const { body: { data: { competition: c } } } = await st.createCompetition({ actorId: cm, body: { name: 'Cascade', season: '2025/26' } })
    const { body: { data: { team } } } = await st.createTeam({ actorId: cm, body: { competition_id: c.id, name: 'T1' } })
    const { body: { data: { team: t2 } } } = await st.createTeam({ actorId: cm, body: { competition_id: c.id, name: 'T2' } })
    await st.putRoster({ id: team.id, body: { players: [player(1, 'A')], staff: [{ role: 'Medic', last_name: 'M' }] } })
    await st.putRoster({ id: t2.id, body: { players: [player(1, 'B')], staff: [] } })
    assert.deepEqual((await st.deleteTeam({ id: team.id })).body.data, { deleted: true })
    assert.equal((await pool.query('SELECT count(*)::int n FROM competition_players WHERE team_id = $1', [team.id])).rows[0].n, 0)
    assert.equal((await pool.query('SELECT count(*)::int n FROM competition_staff WHERE team_id = $1', [team.id])).rows[0].n, 0)
    assert.equal((await st.deleteTeam({ id: team.id })).status, 404)
    assert.equal((await st.deleteCompetition({ id: c.id })).status, 200)
    assert.equal((await pool.query('SELECT count(*)::int n FROM competition_teams WHERE competition_id = $1', [c.id])).rows[0].n, 0)
    assert.equal((await pool.query('SELECT count(*)::int n FROM competition_players WHERE team_id = $1', [t2.id])).rows[0].n, 0)
    assert.equal((await st.deleteCompetition({ id: c.id })).status, 404)
    assert.equal((await st.deleteCompetition({ id: 'not-a-uuid' })).status, 404)
  })
  describe('beach', () => {
    let beachComp, beachTeam

    it('create: no sport is indoor; beach takes a year and no VolleyManager leagues', async () => {
      const indoor = await st.createCompetition({ actorId: cm, body: { name: 'No sport', season: '2026/27' } })
      assert.equal(indoor.status, 201)
      assert.equal(indoor.body.data.competition.sport, 'indoor')
      const r = await st.createCompetition({ actorId: cm, body: { name: 'Coop Beachtour', season: '2026', gender: 'women', sport: 'beach', vm_leagues: [] } })
      assert.equal(r.status, 201, JSON.stringify(r.body))
      beachComp = r.body.data.competition
      assert.equal(beachComp.sport, 'beach')
      assert.equal(beachComp.season, '2026')
      assert.deepEqual(beachComp.vm_leagues, [])
      const bad = async (body, details) => {
        const x = await st.createCompetition({ actorId: cm, body })
        assert.equal(x.status, 400, JSON.stringify(body))
        assert.equal(x.body.error.code, 'OV_INVALID_REQUEST')
        assert.equal(x.body.error.details, details)
      }
      await bad({ name: 'B', season: '2026/27', sport: 'beach' }, "season: like '2026'")
      await bad({ name: 'B', season: '1999', sport: 'beach' }, "season: like '2026'")
      await bad({ name: 'B', season: '2026', sport: 'beach', vm_leagues: ['2L'] }, 'vm_leagues: not for beach')
      await bad({ name: 'I', season: '2026' }, "season: like '2026/27'")
      await bad({ name: 'X', season: '2026', sport: 'Beach' }, 'sport: indoor or beach')
      await bad({ name: 'X', season: '2026', sport: 'snow' }, 'sport: indoor or beach')
      assert.equal((await st.createCompetition({ actorId: cm, body: { name: 'B null', season: '2027', sport: 'beach', vm_leagues: null } })).status, 201)
      assert.equal((await st.createCompetition({ actorId: cm, body: { name: 'I null', season: '2026/27', sport: null } })).body.data.competition.sport, 'indoor')
    })

    it('patch: the sport never changes; season and leagues follow the competition\'s sport', async () => {
      for (const id of [beachComp.id, randomUUID()]) {
        const x = await st.updateCompetition({ id, body: { sport: 'indoor' } })
        assert.equal(x.status, 400)
        assert.equal(x.body.error.details, 'sport: cannot be changed')
      }
      assert.equal((await st.updateCompetition({ id: beachComp.id, body: { season: '2026/27' } })).body.error.details, "season: like '2026'")
      assert.equal((await st.updateCompetition({ id: beachComp.id, body: { vm_leagues: ['1L'] } })).body.error.details, 'vm_leagues: not for beach')
      const p = await st.updateCompetition({ id: beachComp.id, body: { season: '2027', category: 'A1' } })
      assert.equal(p.status, 200, JSON.stringify(p.body))
      assert.deepEqual([p.body.data.competition.season, p.body.data.competition.sport], ['2027', 'beach'])
      assert.equal((await st.updateCompetition({ id: beachComp.id, body: { season: '2026' } })).status, 200)
      assert.equal((await st.updateCompetition({ id: randomUUID(), body: { season: '2026' } })).status, 404)
      // an indoor competition keeps the indoor format
      const { body: { data: { competition: ic } } } = await st.createCompetition({ actorId: cm, body: { name: 'Indoor patch', season: '2026/27' } })
      assert.equal((await st.updateCompetition({ id: ic.id, body: { season: '2026' } })).body.error.details, "season: like '2026/27'")
      assert.equal((await st.updateCompetition({ id: ic.id, body: { season: '2027/28', vm_leagues: ['3L'] } })).status, 200)
    })

    it('a beach roster round trip: a pair with countries and a coach', async () => {
      const t = await st.createTeam({ actorId: cm, body: { competition_id: beachComp.id, name: 'Müller / Weber', short_name: 'MÜLLER/WEBER', club: 'BC Zürich', color: '#3b82f6' } })
      assert.equal(t.status, 201, JSON.stringify(t.body))
      beachTeam = t.body.data.team
      assert.equal(beachTeam.sport, 'beach')
      const put = await st.putRoster({ id: beachTeam.id, body: {
        players: [
          { number: 2, first_name: 'Sara', last_name: 'Weber', dob: '1997-03-12', country: 'che' },
          { number: 1, first_name: 'Anna', last_name: 'Müller', dob: '1998-01-05', license_number: 'B-1', country: 'CHE', is_libero: false, is_captain: false, active: true }
        ],
        staff: [{ role: 'Coach', first_name: 'Eva', last_name: 'Kunz' }]
      } })
      assert.equal(put.status, 200, JSON.stringify(put.body))
      const r = put.body.data.team
      assert.equal(r.sport, 'beach')
      assert.deepEqual(r.players.map((p) => [p.number, p.last_name, p.country, p.is_libero, p.is_captain, p.active]),
        [[2, 'Weber', 'CHE', false, false, true], [1, 'Müller', 'CHE', false, false, true]])
      assert.deepEqual(r.staff.map((x) => [x.role, x.last_name]), [['Coach', 'Kunz']])
      // keep the ids, swap the numbers
      const put2 = await st.putRoster({ id: beachTeam.id, body: { players: [{ ...r.players[0], number: 1 }, { ...r.players[1], number: 2, country: 'ITA' }], staff: [] } })
      assert.equal(put2.status, 200, JSON.stringify(put2.body))
      assert.deepEqual(put2.body.data.team.players.map((p) => p.id), r.players.map((p) => p.id))
      assert.equal(put2.body.data.team.players[1].country, 'ITA')
      // PATCH answers sport and country too
      const pt = await st.updateTeam({ id: beachTeam.id, body: { club: 'BC Bern' } })
      assert.equal(pt.body.data.team.sport, 'beach')
      assert.equal(pt.body.data.team.players[1].country, 'ITA')
    })

    it('a beach roster refuses indoor rosters, and nothing changes', async () => {
      const bp = (number, last, extra = {}) => ({ number, last_name: last, ...extra })
      const cases = [
        [{ players: [bp(1, 'A'), bp(2, 'B'), bp(3, 'C')], staff: [] }, 'players: at most 2 in beach'],
        [{ players: [bp(3, 'A')], staff: [] }, 'players[0].number: 1 or 2'],
        [{ players: [bp(1, 'A'), bp(1, 'B')], staff: [] }, 'players[1].number: 1 is used twice'],
        [{ players: [bp(1, 'A', { is_libero: true })], staff: [] }, 'players[0].is_libero: not in beach'],
        [{ players: [bp(1, 'A', { is_captain: true })], staff: [] }, 'players[0].is_captain: not in beach'],
        [{ players: [bp(1, 'A', { active: false })], staff: [] }, 'players[0].active: not in beach'],
        [{ players: [], staff: [{ role: 'Coach', last_name: 'A' }, { role: 'Coach', last_name: 'B' }] }, 'staff: at most 1 (the coach) in beach'],
        [{ players: [], staff: [{ role: 'Assistant Coach 1', last_name: 'A' }] }, 'staff[0].role: Coach only in beach']
      ]
      const before = (await pool.query('SELECT id, number, country FROM competition_players WHERE team_id = $1 ORDER BY id', [beachTeam.id])).rows
      for (const [body, details] of cases) {
        const x = await st.putRoster({ id: beachTeam.id, body })
        assert.equal(x.status, 400, JSON.stringify(body))
        assert.equal(x.body.error.code, 'OV_INVALID_REQUEST')
        assert.equal(x.body.error.details, details)
      }
      assert.deepEqual((await pool.query('SELECT id, number, country FROM competition_players WHERE team_id = $1 ORDER BY id', [beachTeam.id])).rows, before)
      // shape errors before the database; unknown team 404 after the shape check
      assert.equal((await st.putRoster({ id: beachTeam.id, body: { players: 'x', staff: [] } })).body.error.details, 'players: an array')
      assert.equal((await st.putRoster({ id: randomUUID(), body: { players: [], staff: [] } })).status, 404)
      assert.equal((await st.putRoster({ id: 'nope', body: { players: [], staff: [] } })).status, 404)
    })

    it('an indoor team refuses a country', async () => {
      const { body: { data: { competition: c } } } = await st.createCompetition({ actorId: cm, body: { name: 'Indoor country', season: '2026/27' } })
      const { body: { data: { team } } } = await st.createTeam({ actorId: cm, body: { competition_id: c.id, name: 'Indoor T' } })
      const x = await st.putRoster({ id: team.id, body: { players: [player(4, 'A', { country: 'CHE' })], staff: [] } })
      assert.equal(x.status, 400)
      assert.equal(x.body.error.details, 'players[0].country: only for beach')
      const ok = await st.putRoster({ id: team.id, body: { players: [player(4, 'A', { is_libero: true, is_captain: true })], staff: [{ role: 'Medic', last_name: 'M' }] } })
      assert.equal(ok.status, 200)
      assert.equal(ok.body.data.team.players[0].country, null)
      assert.equal(ok.body.data.team.sport, 'indoor')
    })

    it('the bundle filters by sport (no sport = indoor), with a version per filter', async () => {
      const indoor = await st.getBundle()
      const indoorExplicit = await st.getBundle({ sport: 'indoor' })
      const beach = await st.getBundle({ sport: 'beach' })
      const all = await st.getBundle({ sport: 'all' })
      for (const b of [indoor, indoorExplicit, beach, all]) assert.equal(b.status, 200)
      assert.equal(indoor.body.data.sport, 'indoor')
      assert.equal((await st.getBundle({ sport: '' })).body.data.sport, 'indoor')
      assert.equal(beach.body.data.sport, 'beach')
      assert.equal(all.body.data.sport, 'all')
      const sportsOf = (b) => [...new Set(b.body.data.competitions.map((c) => c.sport))].sort()
      assert.deepEqual(sportsOf(indoor), ['indoor'])
      assert.deepEqual(sportsOf(beach), ['beach'])
      assert.deepEqual(sportsOf(all), ['beach', 'indoor'])
      assert.deepEqual(indoor.body.data.competitions.map((c) => c.id), indoorExplicit.body.data.competitions.map((c) => c.id))
      assert.ok(indoor.body.data.teams.every((t) => t.sport === 'indoor'))
      assert.ok(beach.body.data.teams.every((t) => t.sport === 'beach'))
      assert.ok(beach.body.data.teams.some((t) => t.id === beachTeam.id))
      assert.equal(indoor.body.data.teams.some((t) => t.id === beachTeam.id), false)
      assert.equal(all.body.data.teams.length, indoor.body.data.teams.length + beach.body.data.teams.length)
      assert.equal(all.body.data.competitions.length, indoor.body.data.competitions.length + beach.body.data.competitions.length)
      const bt = beach.body.data.teams.find((t) => t.id === beachTeam.id)
      assert.ok(bt.players.every((p) => /^[A-Z]{3}$/.test(p.country)))

      // the version follows the filtered rows only
      const max = (b) => [...b.body.data.competitions, ...b.body.data.teams].map((x) => x.updated_at).sort().at(-1)
      assert.equal(beach.body.data.version, max(beach))
      assert.equal(indoor.body.data.version, max(indoor))
      assert.equal(all.body.data.version, [indoor.body.data.version, beach.body.data.version].sort().at(-1))
      await new Promise((resolve) => setTimeout(resolve, 5))
      await st.updateTeam({ id: beachTeam.id, body: { club: 'BC Basel' } })
      assert.ok((await st.getBundle({ sport: 'beach' })).body.data.version > beach.body.data.version, 'a beach change moves the beach version')
      assert.equal((await st.getBundle()).body.data.version, indoor.body.data.version, 'and not the indoor one')

      for (const sport of ['Beach', 'nope', 'INDOOR', 'all ']) {
        const x = await st.getBundle({ sport })
        assert.equal(x.status, 400, sport)
        assert.equal(x.body.error.details, 'sport: indoor, beach or all')
      }
    })
  })
})
