/**
 * lib/rosterSaveBack.js on Postgres (owner 2026-11-19): an official match's
 * rosters fill the teams' saved teams and the club's lists; the latest
 * official match's numbers win; nobody is removed; the sides are mapped by
 * name; a player of the other gender, a test match and game 0 are left
 * alone. Made-up clubs and people only.
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { SKIP_PG, createTestDatabase, quietLogger } from './helpers/pgTestDb.js'
import { createAccounts } from '../lib/accounts.js'
import { createSavedTeams } from '../lib/savedTeams.js'
import { createLicences, MAX_MANUAL_PER_CLUB } from '../lib/licences.js'
import { createTeams, seasonLabel } from '../lib/teams.js'
import { createRosterSaveBack } from '../lib/rosterSaveBack.js'
import { zurichDay } from '../lib/clubs.js'
import { seasonOf } from '../lib/officialGame.js'

const H1 = 'VBC Musterdorf H1'
const H2 = 'VBC Beispiel H2'
const today = zurichDay()
const p = (number, first, last, dob = null, extra = {}) => ({ number, first_name: first, last_name: last, dob, libero: '', is_captain: false, is_lfp: false, ...extra })
const b = (role, first, last, dob = null) => ({ role, first_name: first, last_name: last, dob })

describe('rosterSaveBack: official rosters to saved teams and club lists', { skip: SKIP_PG }, () => {
  let tdb, pool, raw, saveBack, savedTeams, licencesOf, club, logger
  const season = seasonOf(new Date())
  const label = seasonLabel(season)

  async function match (gameN, { status = 'live', test = false, home, away, playersHome = [], playersAway = [], benchHome = [], benchAway = [] } = {}) {
    const { rows: [m] } = await raw.query(
      `INSERT INTO public.matches (external_id, game_n, status, test, home_team, away_team, players_home, players_away, bench_home, bench_away)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, official_season`,
      [`match_sb_${gameN}_${Math.random().toString(36).slice(2, 8)}`, gameN, status, test, JSON.stringify({ name: home }), JSON.stringify({ name: away }),
        JSON.stringify(playersHome), JSON.stringify(playersAway), JSON.stringify(benchHome), JSON.stringify(benchAway)])
    return m.id
  }
  async function squadOf (name) {
    const { rows: [t] } = await raw.query(
      `SELECT t.id, t.club, c.season FROM public.competition_teams t JOIN public.competitions c ON c.id = t.competition_id
        WHERE lower(t.svrz_team_name) = lower($1) AND c.season = $2`, [name, label])
    if (!t) return null
    const r = await savedTeams.getTeam({ id: t.id })
    return { ...r.body.data.team, club: t.club }
  }
  const numbers = (team) => Object.fromEntries(team.players.map((x) => [x.last_name, x.number]))
  const clubRows = async () => (await raw.query(
    'SELECT list, sv_number, last_name, first_name, gender, source FROM public.club_licences WHERE club_id = $1 ORDER BY list, sv_number', [club])).rows

  before(async () => {
    tdb = await createTestDatabase('save_back')
    raw = new pg.Client({ connectionString: tdb.url })
    await raw.connect()
    pool = new pg.Pool({ connectionString: tdb.url })
    logger = quietLogger()
    const { rows: [c] } = await raw.query("INSERT INTO public.clubs (name) VALUES ('VBC Musterdorf') RETURNING id")
    club = c.id
    await raw.query('INSERT INTO public.club_teams (club_id, team_name) VALUES ($1, $2)', [club, H1])
    // 960001: H1 at home; 960002 later the same day, H2 at home (the scorer keeps H1 on the left);
    // 960003 a test; 960004 a team of the other gender's game
    await raw.query(`INSERT INTO public.svrz_games (game_number, team_home, team_away, league, gender, datetime) VALUES
      ('960001', $1, $2, '3L Herren', 'm', '${today}T10:00:00'),
      ('960002', $2, $1, '3L Herren', 'm', '${today}T20:00:00'),
      ('960003', $1, $2, '3L Herren', 'm', '${today}T12:00:00')`, [H1, H2])
    // the club's players list: an upload with a woman's licence, and one licence the upload has
    await raw.query(`INSERT INTO public.club_licences (club_id, list, sv_number, last_name, first_name, gender, source, season) VALUES
      ($1, 'players', '700001', 'Andere', 'Frida', 'f', 'import', $2),
      ($1, 'players', '100002', 'Upload', 'Name', 'm', 'import', $2)`, [club, season])
    const accounts = createAccounts({ pool, logger })
    savedTeams = createSavedTeams({ pool, audit: accounts.audit, logger })
    const licences = createLicences({ pool, audit: accounts.audit, logger })
    licencesOf = licences
    const teams = createTeams({ pool, audit: accounts.audit, savedTeams, licences, logger })
    saveBack = createRosterSaveBack({ pool, teams, savedTeams, licences, audit: accounts.audit, logger })
  })

  after(async () => {
    saveBack?.stop()
    await pool?.end().catch(() => {})
    await raw?.end().catch(() => {})
    await tdb?.drop()
  })

  let first
  it('an official match past its coin toss: both teams get their saved team, the club its lists', async () => {
    first = await match(960001, {
      home: H1,
      away: H2,
      playersHome: [
        p(7, 'Anna', 'Muster', '100001', { is_captain: true }), p(10, 'Ben', 'Beispiel', '100002'), p(3, 'Cleo', 'Ohnelizenz'),
        // the scorer typed a date of birth: it stays on the sheet
        p(5, 'Dora', 'Datum', '14.03.2008'), p(8, 'Frida', 'Andere', '700001')
      ],
      benchHome: [b('Coach', 'Carla', 'Trainer', '5001'), b('Medic', 'Mia', 'Medic', '5002'), b('Assistant Coach 1', '', '')],
      playersAway: [p(1, 'Eva', 'Gast', '200001'), p(2, 'Finn', 'Gast', '200002')],
      benchAway: [b('Coach', 'Gil', 'Gastcoach', '6001')]
    })
    const r = await saveBack.run(first)
    // (960002 is later the same day, but nobody has scored it yet: this match is the latest)
    assert.deepEqual(r.sides.map((s) => [s.side, s.team, s.created, s.latest, s.changed]), [['home', H1, true, true, true], ['away', H2, true, true, true]],
      JSON.stringify(r))
    const h1 = await squadOf(H1)
    assert.deepEqual(numbers(h1), { Muster: 7, Beispiel: 10, Ohnelizenz: 3, Datum: 5 })
    assert.deepEqual(h1.players.map((x) => [x.last_name, x.license_number, x.is_captain, x.is_libero, x.active]), [
      ['Muster', '100001', false, false, true], ['Beispiel', '100002', false, false, true], ['Ohnelizenz', null, false, false, true], ['Datum', null, false, false, true]
    ])
    assert.equal(h1.club, 'VBC Musterdorf')
    assert.deepEqual(h1.staff.map((s) => [s.role, s.last_name, s.license_number]), [['Coach', 'Trainer', '5001'], ['Medic', 'Medic', '5002']])
    // the other team is no club's: a saved team all the same, no club name, no list
    const h2 = await squadOf(H2)
    assert.deepEqual(Object.fromEntries(h2.players.map((x) => [x.first_name, x.number])), { Eva: 1, Finn: 2 })
    assert.deepEqual(h2.staff.map((s) => s.last_name), ['Gastcoach'])
    assert.equal(h2.club, null)
    // the club's lists: the licences it lacked, as 'match' rows without a gender; the
    // upload's row stays as it was; the medic is no coach; nobody without a licence
    assert.deepEqual(await clubRows(), [
      { list: 'coaches', sv_number: '5001', last_name: 'Trainer', first_name: 'Carla', gender: null, source: 'match' },
      { list: 'players', sv_number: '100001', last_name: 'Muster', first_name: 'Anna', gender: null, source: 'match' },
      { list: 'players', sv_number: '100002', last_name: 'Upload', first_name: 'Name', gender: 'm', source: 'import' },
      { list: 'players', sv_number: '700001', last_name: 'Andere', first_name: 'Frida', gender: 'f', source: 'import' }
    ])
    // audited: counts and ids, never a name or a licence
    const { rows: audit } = await raw.query("SELECT match_id, details FROM public.audit_log WHERE action = 'team.squad.match' ORDER BY at, id")
    assert.equal(audit.length, 2)
    assert.equal(audit[0].match_id, first)
    assert.equal(audit[0].details.game_number, '960001')
    assert.equal(audit[0].details.side, 'home')
    assert.equal(audit[0].details.added, 6)
    assert.equal(audit[0].details.skipped, 1, 'the player of the other gender')
    assert.equal(audit[0].details.club_added, 2)
    const text = JSON.stringify(audit)
    for (const s of ['Muster', 'Trainer', '100001', '5001', 'Gast']) assert.ok(!text.includes(s), s)
  })

  it('the same match again: nothing changes, nothing is audited', async () => {
    const r = await saveBack.run(first)
    assert.deepEqual(r.sides.map((s) => s.changed), [false, false])
    assert.equal((await raw.query("SELECT count(*)::int AS n FROM public.audit_log WHERE action = 'team.squad.match'")).rows[0].n, 2)
  })

  let second
  it('a later match with other numbers, the sides swapped: the latest wins, the old holder loses the number', async () => {
    // 960002: H2 is at home in the schedule; the scorer has H1 on the home side
    second = await match(960002, {
      home: H1,
      away: H2,
      playersHome: [p(10, 'Anna', 'Muster', '100001'), p(4, 'Neo', 'Neu', '100004')],
      playersAway: [p(9, 'Eva', 'Gast', '200001')]
    })
    const r = await saveBack.run(second)
    assert.deepEqual(r.sides.map((s) => [s.side, s.team, s.latest]), [['home', H1, true], ['away', H2, true]])
    const h1 = await squadOf(H1)
    assert.deepEqual(numbers(h1), { Muster: 10, Beispiel: null, Ohnelizenz: 3, Datum: 5, Neu: 4 })
    assert.equal(h1.players.length, 5, 'nobody is removed')
    assert.equal(h1.staff.length, 2)
    const h2 = await squadOf(H2)
    assert.deepEqual(Object.fromEntries(h2.players.map((x) => [x.first_name, x.number])), { Eva: 9, Finn: 2 })
    assert.ok((await clubRows()).some((x) => x.sv_number === '100004' && x.source === 'match'))
  })

  it('the earlier match written again later: its numbers do not come back', async () => {
    const r = await saveBack.run(first)
    assert.deepEqual(r.sides.map((s) => s.latest), [false, false])
    const h1 = await squadOf(H1)
    assert.deepEqual(numbers(h1), { Muster: 10, Beispiel: null, Ohnelizenz: 3, Datum: 5, Neu: 4 })
  })

  it('the latest match\'s officials take its roles; the earlier match written again changes none back', async () => {
    // 960002 names the coach Assistant Coach 1 and the medic Coach (the sheet's roles)
    await raw.query('UPDATE public.matches SET bench_home = $2 WHERE id = $1',
      [second, JSON.stringify([b('Coach', 'Mia', 'Medic', '5002'), b('Assistant Coach 1', 'Carla', 'Trainer', '5001')])])
    const before = await squadOf(H1)
    const r = await saveBack.run(second)
    const home = r.sides.find((s) => s.side === 'home')
    assert.deepEqual([home.latest, home.changed, home.counts.roles, home.counts.added], [true, true, 2, 0])
    const h1 = await squadOf(H1)
    assert.deepEqual(h1.staff.map((s) => [s.last_name, s.role, s.license_number]), [['Trainer', 'Assistant Coach 1', '5001'], ['Medic', 'Coach', '5002']])
    assert.deepEqual(h1.staff.map((s) => s.id), before.staff.map((s) => s.id), 'the same people, nobody replaced')
    const { rows: [a] } = await raw.query("SELECT details FROM public.audit_log WHERE action = 'team.squad.match' AND match_id = $1 ORDER BY at DESC, id DESC LIMIT 1", [second])
    assert.equal(a.details.roles, 2)
    // 960001 (earlier: Trainer Coach, Medic Medic) written again: no role changes back
    const again = await saveBack.run(first)
    assert.deepEqual(again.sides.map((s) => [s.latest, s.changed]), [[false, false], [false, false]])
    assert.deepEqual((await squadOf(H1)).staff.map((s) => [s.last_name, s.role]), [['Trainer', 'Assistant Coach 1'], ['Medic', 'Coach']])
  })

  it('a test match and a match without a game number are never touched', async () => {
    const before = JSON.stringify(await squadOf(H1))
    const t = await match(960003, { test: true, home: H1, away: H2, playersHome: [p(99, 'Test', 'Person', '100099')] })
    assert.deepEqual(await saveBack.run(t), { skipped: 'not_official' })
    const z = await match(0, { home: H1, away: H2, playersHome: [p(98, 'Zero', 'Person', '100098')] })
    assert.deepEqual(await saveBack.run(z), { skipped: 'not_official' })
    const s = await match(null, { home: H1, away: H2, status: 'setup', playersHome: [p(97, 'Setup', 'Person', '100097')] })
    assert.deepEqual(await saveBack.run(s), { skipped: 'not_official' })
    assert.equal(JSON.stringify(await squadOf(H1)), before)
    assert.ok(!(await clubRows()).some((x) => ['100099', '100098', '100097'].includes(x.sv_number)))
  })

  it('before the coin toss: nothing yet', async () => {
    await raw.query("UPDATE public.matches SET status = 'setup' WHERE id = $1", [second])
    assert.deepEqual(await saveBack.run(second), { skipped: 'no_coin_toss' })
    await raw.query("UPDATE public.matches SET status = 'ended' WHERE id = $1", [second])
  })

  it('a team the names do not point to is left alone', async () => {
    await raw.query("UPDATE public.matches SET home_team = '{\"name\": \"Home\"}', away_team = '{\"name\": \"Guests\"}' WHERE id = $1", [second])
    const r = await saveBack.run(second)
    assert.deepEqual(r.sides, [{ side: 'home', skipped: 'team_unknown' }, { side: 'away', skipped: 'team_unknown' }])
  })

  it('the club\'s rows no upload brought stay within the cap: the rest is left out, never an error', async () => {
    await raw.query(`INSERT INTO public.club_licences (club_id, list, sv_number, last_name, source, season)
      SELECT $1, 'scorers', (300000 + g)::text, 'Hand' || g, 'manual', $2 FROM generate_series(1, $3::int) g`,
    [club, season, MAX_MANUAL_PER_CLUB - (await clubRows()).filter((x) => x.source !== 'import').length - 1])
    await raw.query(`UPDATE public.matches SET home_team = '{"name": "VBC Musterdorf H1"}', away_team = '{"name": "VBC Beispiel H2"}',
      players_home = $2 WHERE id = $1`, [second, JSON.stringify([p(10, 'Anna', 'Muster', '100001'), p(21, 'Ida', 'Eins', '100021'), p(22, 'Jan', 'Zwei', '100022')])])
    const r = await saveBack.run(second)
    const home = r.sides.find((s) => s.side === 'home')
    assert.deepEqual([home.club.added, home.club.capped], [1, 1])
    const rows = await clubRows()
    assert.equal(rows.filter((x) => x.source !== 'import').length, MAX_MANUAL_PER_CLUB)
    // the saved team takes both all the same
    assert.equal(numbers(await squadOf(H1)).Zwei, 22)
  })

  it('a club manager deletes a row a match brought, as one added by hand', async () => {
    const { rows: [r] } = await raw.query("SELECT id FROM public.club_licences WHERE club_id = $1 AND sv_number = '100021'", [club])
    const out = await licencesOf.deleteRow({ clubId: club, rowId: r.id })
    assert.equal(out.status, 200, JSON.stringify(out.body))
    assert.ok(!(await clubRows()).some((x) => x.sv_number === '100021'))
  })

  it('note(): a write of an official match waits for its run; one of a test match does not', async () => {
    saveBack.note([{ table: 'matches', eventType: 'UPDATE', row: { id: second, test: false, game_n: 960002, status: 'ended' } }])
    saveBack.note([{ table: 'matches', eventType: 'UPDATE', row: { id: first, test: true, game_n: 960001, status: 'live' } }])
    assert.deepEqual(saveBack.pending(), [second])
    await saveBack.flush()
    assert.deepEqual(saveBack.pending(), [])
    // what a restart forgot: the matches written lately
    assert.equal(await saveBack.catchUp(), 2)
    saveBack.stop()
  })
})
