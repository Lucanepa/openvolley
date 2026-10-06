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
    assert.deepEqual({ ...r1.players[0], id: undefined }, { id: undefined, number: 7, first_name: 'Anna', last_name: 'Muster', dob: '2001-02-03', license_number: 'L-7', is_libero: false, is_captain: true, active: true, sort_order: 0 })
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
    assert.deepEqual(Object.keys(b).sort(), ['competitions', 'fetched_at', 'teams', 'version'])
    const bt = b.teams.find((x) => x.id === team.id)
    assert.deepEqual(Object.keys(bt).sort(), ['club', 'color', 'competition_id', 'id', 'name', 'players', 'short_name', 'staff', 'svrz_team_name', 'updated_at'])
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
})
