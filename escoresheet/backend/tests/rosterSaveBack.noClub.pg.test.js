/**
 * Review CR-2 of the PERM-04 fix (owner decision 2026-11-23 no. 2): a team of
 * NO club (no club_teams row: most opponents today) got a roster_suggestions
 * row from every closed match that nobody could open (no team page, no
 * manager), and its saved team was never filled again, although the owner
 * wanted it filled "also for a team nobody manages" (2026-11-19). Now it is
 * filled ADD-ONLY, the writer the actor: new people are added and empty
 * fields filled (a shirt number nobody holds, a missing licence), as an older
 * match does; no number of anyone changes, nobody is set active again, no
 * official's role moves, no club lists, no suggestion. Another club's team
 * still gets a suggestion only (rosterSaveBack.closedOnly.pg.test.js).
 * Made-up clubs and people only.
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { SKIP_PG, createTestDatabase, quietLogger } from './helpers/pgTestDb.js'
import { createAccounts } from '../lib/accounts.js'
import { createSavedTeams } from '../lib/savedTeams.js'
import { createLicences } from '../lib/licences.js'
import { createTeams, seasonLabel } from '../lib/teams.js'
import { createRosterSaveBack } from '../lib/rosterSaveBack.js'
import { zurichDay } from '../lib/clubs.js'
import { seasonOf } from '../lib/officialGame.js'

const A1 = 'VBC Musterdorf H3'
const X1 = 'TV Nirgendwo H1'
const today = zurichDay()
const p = (number, first, last, lic = null) => ({ number, first_name: first, last_name: last, dob: lic, libero: '', is_captain: false, is_lfp: false })
const b = (role, first, last, lic = null) => ({ role, first_name: first, last_name: last, dob: lic })

describe('save-back to a team of no club: add-only, the writer the actor (CR-2)', { skip: SKIP_PG }, () => {
  let tdb, pool, raw, saveBack, savedTeams, clubA, scorerA
  let first, second
  const label = seasonLabel(seasonOf(new Date()))

  async function match (gameN, { by = scorerA, home, away, playersHome = [], playersAway = [], benchHome = [], benchAway = [] }) {
    const { rows: [m] } = await raw.query(
      `INSERT INTO public.matches (external_id, game_n, status, home_team, away_team, players_home, players_away, bench_home, bench_away, created_by)
       VALUES ($1, $2, 'final', $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [`match_nc_${gameN}_${Math.random().toString(36).slice(2, 8)}`, gameN, JSON.stringify({ name: home }), JSON.stringify({ name: away }),
        JSON.stringify(playersHome), JSON.stringify(playersAway), JSON.stringify(benchHome), JSON.stringify(benchAway), by])
    return m.id
  }
  async function squadOf (name) {
    const { rows: [t] } = await raw.query(
      `SELECT t.id, t.club FROM public.competition_teams t JOIN public.competitions c ON c.id = t.competition_id
        WHERE lower(t.svrz_team_name) = lower($1) AND c.season = $2`, [name, label])
    if (!t) return null
    const r = await savedTeams.getTeam({ id: t.id })
    return { ...r.body.data.team, club: t.club }
  }
  const players = (team) => team.players.map((x) => [x.last_name, x.number, x.active !== false, x.license_number])
  const suggestionCount = async () => (await raw.query('SELECT count(*)::int AS n FROM public.roster_suggestions')).rows[0].n

  before(async () => {
    tdb = await createTestDatabase('save_back_no_club')
    raw = new pg.Client({ connectionString: tdb.url })
    await raw.connect()
    pool = new pg.Pool({ connectionString: tdb.url })
    const logger = quietLogger()
    clubA = (await raw.query("INSERT INTO public.clubs (name) VALUES ('VBC Musterdorf') RETURNING id")).rows[0].id
    await raw.query('INSERT INTO public.club_teams (club_id, team_name) VALUES ($1, $2)', [clubA, A1])
    scorerA = (await raw.query("INSERT INTO auth.users (id, email) VALUES (gen_random_uuid(), 'scorer-nc@example.ch') RETURNING id")).rows[0].id
    await raw.query('INSERT INTO public.account_clubs (user_id, club_id) VALUES ($1, $2)', [scorerA, clubA])
    // 962001: A at home this morning; 962002: X at home tonight (later); 962003: a match nobody wrote
    await raw.query(`INSERT INTO public.svrz_games (game_number, team_home, team_away, league, gender, datetime) VALUES
      ('962001', $1, $2, '3L Herren', 'm', '${today}T10:00:00'),
      ('962002', $2, $1, '3L Herren', 'm', '${today}T20:00:00'),
      ('962003', $1, $2, '3L Herren', 'm', '${today}T12:00:00')`, [A1, X1])
    const accounts = createAccounts({ pool, logger })
    savedTeams = createSavedTeams({ pool, audit: accounts.audit, logger })
    const licences = createLicences({ pool, audit: accounts.audit, logger })
    const teams = createTeams({ pool, audit: accounts.audit, savedTeams, licences, logger })
    saveBack = createRosterSaveBack({ pool, teams, savedTeams, licences, audit: accounts.audit, logger })
  })

  after(async () => {
    saveBack?.stop()
    await pool?.end().catch(() => {})
    await raw?.end().catch(() => {})
    await tdb?.drop()
  })

  it('the first closed match makes the saved team, with its numbers; no suggestion, no club list', async () => {
    first = await match(962001, {
      home: A1,
      away: X1,
      playersHome: [p(4, 'Anna', 'Heim', '100401')],
      playersAway: [p(1, 'Eva', 'Gast', '200001'), p(2, 'Finn', 'Gast', '200002')],
      benchAway: [b('Coach', 'Gil', 'Gastcoach', '6001')]
    })
    const r = await saveBack.run(first)
    const away = r.sides.find((s) => s.side === 'away')
    assert.deepEqual([away.team, away.own, away.add_only, away.created, away.latest, away.changed], [X1, false, true, true, false, true], JSON.stringify(r))
    const x = await squadOf(X1)
    assert.deepEqual(players(x), [['Gast', 1, true, '200001'], ['Gast', 2, true, '200002']])
    assert.deepEqual(x.staff.map((s) => [s.role, s.last_name]), [['Coach', 'Gastcoach']])
    assert.equal(x.club, null)
    assert.equal(await suggestionCount(), 0, 'no suggestion nobody could open')
    assert.ok(!(await raw.query("SELECT 1 FROM public.club_licences WHERE sv_number IN ('200001', '200002', '6001')")).rowCount)
    // audited with the writer, add-only, never a name or a licence
    const { rows } = await raw.query("SELECT actor_id, details FROM public.audit_log WHERE action = 'team.squad.match' AND match_id = $1 ORDER BY at, id", [first])
    const a = rows.find((x) => x.details.side === 'away')
    assert.equal(a.actor_id, scorerA)
    assert.equal(a.details.add_only, true)
    assert.equal(a.details.latest, false)
    assert.ok(!JSON.stringify(rows).includes('Gast'))
  })

  it('a later match adds people and fills empty fields only: no renumbering, no reactivation, no role moves', async () => {
    // the saved team as someone keeps it: Finn left the team, his number stays; Gil is Coach
    const now = await squadOf(X1)
    const put = await savedTeams.putRoster({
      id: now.id,
      body: {
        players: now.players.map((x) => (x.first_name === 'Finn' ? { ...x, active: false } : x)).concat([{ number: null, first_name: 'Ida', last_name: 'Ohne', license_number: null, is_libero: false, is_captain: false, active: true }]),
        staff: now.staff
      }
    })
    assert.equal(put.status, 200, JSON.stringify(put.body))
    // tonight's game (the latest by kick-off): other numbers, Finn plays, a new player on Eva's number, Gil as assistant
    second = await match(962002, {
      home: A1,
      away: X1,
      playersAway: [p(9, 'Eva', 'Gast', '200001'), p(5, 'Finn', 'Gast', '200002'), p(1, 'Falsch', 'Neu', '200009'), p(7, 'Neo', 'Neu', '200007'), p(8, 'Ida', 'Ohne', '200008')],
      benchAway: [b('Assistant Coach 1', 'Gil', 'Gastcoach', '6001'), b('Medic', 'Mia', 'Medic')]
    })
    const r = await saveBack.run(second)
    const away = r.sides.find((s) => s.side === 'away')
    assert.deepEqual([away.add_only, away.latest, away.changed], [true, false, true], JSON.stringify(r))
    assert.deepEqual([away.counts.cleared, away.counts.roles, away.counts.moved], [0, 0, 0])
    const x = await squadOf(X1)
    assert.deepEqual(players(x), [
      ['Gast', 1, true, '200001'], // Eva keeps her number
      ['Gast', 2, false, '200002'], // Finn stays inactive, with his number
      ['Ohne', 8, true, '200008'], // Ida: an empty number nobody holds, and the missing licence
      ['Neu', null, true, '200009'], // a new player on a held number: none
      ['Neu', 7, true, '200007']
    ])
    assert.deepEqual(x.staff.map((s) => [s.role, s.last_name]), [['Coach', 'Gastcoach'], ['Medic', 'Medic']])
    assert.equal(await suggestionCount(), 0)
  })

  it('the same match again changes nothing; a match without a writer leaves the team alone', async () => {
    const before = JSON.stringify(await squadOf(X1))
    const r = await saveBack.run(second)
    assert.equal(r.sides.find((s) => s.side === 'away').changed, false)
    const orphan = await match(962003, { by: null, home: A1, away: X1, playersAway: [p(3, 'Otto', 'Niemand', '200003')] })
    const o = await saveBack.run(orphan)
    assert.deepEqual(o.sides.find((s) => s.side === 'away'), { side: 'away', team: X1, own: false, skipped: 'no_writer' })
    assert.equal(JSON.stringify(await squadOf(X1)), before)
    assert.equal(await suggestionCount(), 0)
  })
})
