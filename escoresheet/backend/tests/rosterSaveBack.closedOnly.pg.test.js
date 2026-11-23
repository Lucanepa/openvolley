/**
 * PERM-04 (audit 2611), owner decision 2026-11-23 no. 2, on Postgres. The
 * finding: club A's scorer made the official match of an upcoming A-home
 * game against club B two days early, wrote status 'live', a fake coin toss
 * and an away roster (B's real players renumbered, invented players and a
 * coach); a minute later club B's saved team was renumbered and the invented
 * people were in B's licence lists, with no actor in the audit, and they
 * stayed after the match was deleted (poc clubs_managers/saveback_cross_club
 * .mjs, match_ownership/t3_saveback.mjs, t4_saveback_numbers.mjs). Now:
 *   - nothing is saved back before the match is closed;
 *   - closed: the writer's own club's team at once, the writer the actor;
 *     the other club gets a suggestion only (no write to its saved team or
 *     lists) that its manager confirms or rejects;
 *   - a match only suggested to a team never makes the team's own matches
 *     "older"; a deleted match is never "latest" and its suggestions go;
 *   - the rows no upload brought count the same in both caps.
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
import { createLicences, MAX_MANUAL_PER_CLUB } from '../lib/licences.js'
import { createTeams } from '../lib/teams.js'
import { createRosterSaveBack } from '../lib/rosterSaveBack.js'
import { zurichDay } from '../lib/clubs.js'

const A1 = 'VBC Musterdorf D2'
const B1 = 'VC Beispielstadt D1'
const X1 = 'SC Drittort D1'
const today = zurichDay()
const dayPlus = (n) => { const t = new Date(`${today}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10) }
const p = (number, first, last, lic) => ({ number, first_name: first, last_name: last, dob: lic, libero: '', is_captain: false, is_lfp: false })
const coach = (first, last, lic) => ({ role: 'Coach', first_name: first, last_name: last, dob: lic })
const B_REAL = [
  { number: 1, first_name: 'Gina', last_name: 'Gast', license_number: '970201', is_libero: false, is_captain: false, active: true },
  { number: 2, first_name: 'Hanna', last_name: 'Heim', license_number: '970202', is_libero: false, is_captain: false, active: true },
  { number: 3, first_name: 'Ida', last_name: 'Ingold', license_number: '970203', is_libero: false, is_captain: false, active: true }
]

describe('save-back from a closed match only; the other club gets suggestions (PERM-04)', { skip: SKIP_PG }, () => {
  let tdb, pool, raw, saveBack, teams, licences, logger
  let clubA, clubB, teamA, teamB, scorerA, scorerB, managerB
  let attack, ownB, laterB

  async function account (email) {
    const { rows: [u] } = await raw.query("INSERT INTO auth.users (id, email) VALUES (gen_random_uuid(), $1) RETURNING id", [email])
    await raw.query("INSERT INTO public.profiles (user_id, roles) VALUES ($1, '{scorer}')", [u.id])
    return u.id
  }
  async function match (gameN, { by, status = 'live', home, away, playersHome = [], playersAway = [], benchHome = [], benchAway = [] }) {
    const { rows: [m] } = await raw.query(
      `INSERT INTO public.matches (external_id, game_n, status, home_team, away_team, players_home, players_away, bench_home, bench_away, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [`match_co_${gameN}_${Math.random().toString(36).slice(2, 8)}`, gameN, status, JSON.stringify({ name: home }), JSON.stringify({ name: away }),
        JSON.stringify(playersHome), JSON.stringify(playersAway), JSON.stringify(benchHome), JSON.stringify(benchAway), by])
    return m.id
  }
  const squadB = async () => (await teams.squad({ teamId: teamB })).body.data.squad
  const numbersB = async () => Object.fromEntries((await squadB()).players.map((x) => [x.last_name, x.number]))
  const clubRows = async (club) => (await raw.query('SELECT sv_number, source, imported_by FROM public.club_licences WHERE club_id = $1 ORDER BY sv_number', [club])).rows
  const suggestions = async (matchId) => (await raw.query('SELECT id, side, team_name, club_id, status, actor_id FROM public.roster_suggestions WHERE match_id = $1 ORDER BY side', [matchId])).rows
  const close = (id) => raw.query("UPDATE public.matches SET status = 'final' WHERE id = $1", [id])

  before(async () => {
    tdb = await createTestDatabase('save_back_closed')
    raw = new pg.Client({ connectionString: tdb.url })
    await raw.connect()
    pool = new pg.Pool({ connectionString: tdb.url })
    logger = quietLogger()
    clubA = (await raw.query("INSERT INTO public.clubs (name) VALUES ('VBC Musterdorf') RETURNING id")).rows[0].id
    clubB = (await raw.query("INSERT INTO public.clubs (name) VALUES ('VC Beispielstadt') RETURNING id")).rows[0].id
    teamA = (await raw.query('INSERT INTO public.club_teams (club_id, team_name) VALUES ($1, $2) RETURNING id', [clubA, A1])).rows[0].id
    teamB = (await raw.query('INSERT INTO public.club_teams (club_id, team_name) VALUES ($1, $2) RETURNING id', [clubB, B1])).rows[0].id
    scorerA = await account('scorer-a@example.ch')
    scorerB = await account('scorer-b@example.ch')
    managerB = await account('manager-b@example.ch')
    await raw.query('INSERT INTO public.account_clubs (user_id, club_id) VALUES ($1, $2), ($3, $4)', [scorerA, clubA, scorerB, clubB])
    await raw.query('INSERT INTO public.club_managers (club_id, user_id) VALUES ($1, $2)', [clubB, managerB])
    // 961001: A at home two days ahead (the attack); 961002: B at home this morning;
    // 961003: B at home tonight (later than 961002)
    await raw.query(`INSERT INTO public.svrz_games (game_number, team_home, team_away, league, gender, datetime) VALUES
      ('961001', $1, $2, '4L Damen', 'f', '${dayPlus(2)}T18:00:00'),
      ('961002', $2, $3, '4L Damen', 'f', '${today}T10:00:00'),
      ('961003', $2, $1, '4L Damen', 'f', '${today}T20:00:00')`, [A1, B1, X1])
    const accounts = createAccounts({ pool, logger })
    const savedTeams = createSavedTeams({ pool, audit: accounts.audit, logger })
    licences = createLicences({ pool, audit: accounts.audit, logger })
    teams = createTeams({ pool, audit: accounts.audit, savedTeams, licences, logger })
    saveBack = createRosterSaveBack({ pool, teams, savedTeams, licences, audit: accounts.audit, logger })
    // club B's own saved team, as its manager saved it
    const put = await teams.putSquad({ actorId: managerB, teamId: teamB, body: { players: B_REAL, staff: [] } })
    assert.equal(put.status, 200, JSON.stringify(put.body))
  })

  after(async () => {
    saveBack?.stop()
    await pool?.end().catch(() => {})
    await raw?.end().catch(() => {})
    await tdb?.drop()
  })

  it('before the close: nothing at all (live, ended), whatever the client wrote', async () => {
    attack = await match(961001, {
      by: scorerA,
      home: A1,
      away: B1,
      playersHome: [p(5, 'Heim', 'Muster', '970101')],
      // B's real players with other numbers, two invented players, an invented coach
      playersAway: [p(2, 'Gina', 'Gast', '970201'), p(3, 'Erfunden', 'Niemand', '971999'), p(1, 'Planted', 'Person', '971998')],
      benchAway: [coach('Falscher', 'Trainer', '971997')]
    })
    for (const status of ['live', 'ended']) {
      await raw.query('UPDATE public.matches SET status = $2 WHERE id = $1', [attack, status])
      assert.deepEqual(await saveBack.run(attack), { skipped: 'not_closed' }, status)
    }
    assert.deepEqual(await numbersB(), { Gast: 1, Heim: 2, Ingold: 3 })
    assert.deepEqual(await clubRows(clubB), [])
    assert.deepEqual(await suggestions(attack), [])
  })

  it('closed: the writer\'s club\'s team at once (the writer the actor); club B gets a suggestion only', async () => {
    await close(attack)
    const r = await saveBack.run(attack)
    const home = r.sides.find((s) => s.side === 'home')
    const away = r.sides.find((s) => s.side === 'away')
    assert.deepEqual([home.own, home.changed], [true, true], JSON.stringify(r))
    assert.deepEqual([away.own, away.suggested], [false, true], JSON.stringify(r))
    // club B: its saved team and its lists as they were
    assert.deepEqual(await numbersB(), { Gast: 1, Heim: 2, Ingold: 3 })
    assert.equal((await squadB()).players.length, 3)
    assert.deepEqual((await squadB()).staff, [])
    assert.deepEqual(await clubRows(clubB), [])
    // club A: its lists, imported_by the writer
    assert.deepEqual(await clubRows(clubA), [{ sv_number: '970101', source: 'match', imported_by: scorerA }])
    // the suggestion: club B's team, open, the writer
    const sug = await suggestions(attack)
    assert.deepEqual(sug.map((x) => [x.side, x.team_name, x.club_id, x.status, x.actor_id]), [['away', B1, clubB, 'open', scorerA]])
    // audited with the writer as actor
    const { rows } = await raw.query("SELECT actor_id, action, details FROM public.audit_log WHERE match_id = $1 AND action IN ('team.squad.match', 'team.squad.suggestion') ORDER BY id", [attack])
    assert.deepEqual(rows.map((a) => [a.action, a.actor_id, a.details.side]), [['team.squad.match', scorerA, 'home'], ['team.squad.suggestion', scorerA, 'away']])
    assert.ok(!JSON.stringify(rows).match(/Niemand|Planted|971999/))
  })

  it('the manager of club B sees what it would change, and rejects it: nothing changes', async () => {
    const list = await saveBack.listSuggestions({ teamId: teamB })
    assert.equal(list.status, 200, JSON.stringify(list.body))
    const [s] = list.body.data.suggestions
    assert.equal(s.game_number, '961001')
    assert.equal(s.changed, true)
    assert.deepEqual(s.players.map((x) => [x.last_name, x.number, x.known]), [['Gast', 2, true], ['Niemand', 3, false], ['Person', 1, false]])
    assert.deepEqual(s.staff.map((x) => [x.role, x.last_name, x.known]), [['Coach', 'Trainer', false]])
    assert.equal(s.counts.added, 3)
    assert.equal(s.club_new, 4)
    // not another team's
    assert.equal((await saveBack.decideSuggestion({ actorId: managerB, teamId: teamA, id: s.id, body: { decision: 'reject' } })).status, 404)
    const no = await saveBack.decideSuggestion({ actorId: managerB, teamId: teamB, id: s.id, body: { decision: 'reject' } })
    assert.equal(no.status, 200, JSON.stringify(no.body))
    assert.equal(no.body.data.suggestion.status, 'rejected')
    const twice = await saveBack.decideSuggestion({ actorId: managerB, teamId: teamB, id: s.id, body: { decision: 'confirm' } })
    assert.equal(twice.status, 409)
    assert.equal(twice.body.error.code, 'OV_SUGGESTION_DECIDED')
    assert.deepEqual(await numbersB(), { Gast: 1, Heim: 2, Ingold: 3 })
    assert.deepEqual(await clubRows(clubB), [])
    assert.deepEqual((await saveBack.listSuggestions({ teamId: teamB })).body.data.suggestions, [])
    // the match written again: the decided suggestion stays decided
    await saveBack.run(attack)
    assert.deepEqual((await suggestions(attack)).map((x) => x.status), ['rejected'])
  })

  it('a match only suggested to club B never makes B\'s own (earlier) match older', async () => {
    // B's home game of this morning, scored by B's scorer: its numbers win although the attack's kick-off is later
    ownB = await match(961002, { by: scorerB, status: 'final', home: B1, away: X1, playersHome: [p(7, 'Gina', 'Gast', '970201'), p(2, 'Hanna', 'Heim', '970202')] })
    const r = await saveBack.run(ownB)
    const home = r.sides.find((s) => s.side === 'home')
    assert.deepEqual([home.own, home.latest, home.changed], [true, true, true], JSON.stringify(r))
    assert.deepEqual(await numbersB(), { Gast: 7, Heim: 2, Ingold: 3 })
    const { rows: [a] } = await raw.query("SELECT actor_id FROM public.audit_log WHERE match_id = $1 AND action = 'team.squad.match'", [ownB])
    assert.equal(a.actor_id, scorerB)
  })

  it('a deleted match is never the latest, and its suggestions go with it', async () => {
    // B's home game of tonight (later than this morning's), scored by B: the latest
    laterB = await match(961003, { by: scorerB, status: 'final', home: B1, away: A1, playersHome: [p(9, 'Gina', 'Gast', '970201')], playersAway: [p(4, 'Heim', 'Muster', '970101'), p(6, 'Neue', 'Spielerin', '970106')] })
    const r = await saveBack.run(laterB)
    assert.equal(r.sides.find((s) => s.side === 'home').latest, true)
    assert.equal((await numbersB()).Gast, 9)
    // its away side (club A's team, not of B's scorer's clubs): a suggestion for A
    // (a new player: a side that brings nothing new is suggested nothing)
    assert.deepEqual((await suggestions(laterB)).map((x) => [x.side, x.team_name, x.club_id]), [['away', A1, clubA]])
    // this morning's match again: older now, its numbers do not come back
    assert.equal((await saveBack.run(ownB)).sides.find((s) => s.side === 'home').latest, false)
    assert.equal((await numbersB()).Gast, 9)
    // tonight's match deleted (an admin's delete: it is closed)
    await raw.query('BEGIN')
    await raw.query("SET LOCAL ov.allow_closed = 'on'")
    await raw.query('DELETE FROM public.matches WHERE id = $1', [laterB])
    await raw.query('COMMIT')
    assert.deepEqual(await suggestions(laterB), [], 'its suggestion went with it')
    // this morning's match is the latest again
    const again = await saveBack.run(ownB)
    assert.equal(again.sides.find((s) => s.side === 'home').latest, true)
    assert.equal((await numbersB()).Gast, 7)
  })

  it('the rows no upload brought: the same count for a hand-added row as for a match\'s', async () => {
    const have = (await clubRows(clubB)).length
    await raw.query(`INSERT INTO public.club_licences (club_id, list, sv_number, last_name, source, season)
      SELECT $1, 'players', (500000 + g)::text, 'Match' || g, 'match', $2 FROM generate_series(1, $3::int) g`,
    [clubB, Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) < 7 ? 1 : 0), MAX_MANUAL_PER_CLUB - have - 1])
    const r = await licences.addPeople({ clubId: clubB, userId: managerB, body: { people: [
      { list: 'scorers', sv_number: '880001', last_name: 'Hand', first_name: 'Eins', gender: 'f' },
      { list: 'scorers', sv_number: '880002', last_name: 'Hand', first_name: 'Zwei', gender: 'f' }
    ] } })
    assert.equal(r.status, 409, JSON.stringify(r.body))
    assert.equal(r.body.error.code, 'OV_MANUAL_LIMIT')
    const one = await licences.addPeople({ clubId: clubB, userId: managerB, body: { people: [{ list: 'scorers', sv_number: '880001', last_name: 'Hand', first_name: 'Eins', gender: 'f' }] } })
    assert.equal(one.status, 200, JSON.stringify(one.body))
  })
})
