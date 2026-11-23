/**
 * LOG-24 (audit 26.11): since the sync writes Romandie and Ticino team names
 * in their region's language (a66c1abba), the German names held in
 * club_teams, saved teams and older schedule rows stopped matching the
 * schedule: a Ticino club's scorer could no longer score its home game under
 * the club rule, and its contact got no final mail. The sync now renames the
 * German names to the region's ones (teamNameRenames + followTeamRenames).
 *
 * Unit cases on the renames, then a sync on Postgres against the fake
 * VolleyManager (no network): club_teams, saved teams and older rows follow,
 * the club rule (db/018) takes the club's scorer again, and the final mail
 * finds the club's contact. Needs PG_TEST_URL for the second part.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { runVmSync, teamNameRenames, followTeamRenames, teamName } from '../lib/vmSync.js'
import { createFinalMail } from '../lib/finalMail.js'
import { createFakeVolleyManager, makeGame, FAKE_USER, FAKE_PASSWORD } from './helpers/fakeVolleyManager.js'
import { SKIP_PG, createTestDatabase, grantRoles, quietLogger } from './helpers/pgTestDb.js'

const here = dirname(fileURLToPath(import.meta.url))
// the schedule's tables as the sync writes them (as vmSync.pg.test.js): the
// synthetic schema's svrz_games is a reader's stand-in
const SVRZ_SQL = ['fixtures/svrz_schema.sql', '../db/003_svrz_games_local_time.sql', '../db/041_schedule_sync.sql', '../db/051_referee_licences.sql', '../db/052_redacted_people.sql']
  .map((f) => readFileSync(join(here, f), 'utf8')).join('\n')

const ticino = (it, de, identifier = '915123') => ({ name: it, club: { identifier }, translations: { de: { name: de }, it: { name: it }, fr: { name: it } } })
const german = (de, identifier = '912001') => ({ name: de, club: { identifier }, translations: { de: { name: de }, it: { name: `${de} IT` }, fr: { name: `${de} FR` } } })
const item = (n, home, away, startingDateTime) => {
  const g = makeGame(n, startingDateTime ? { startingDateTime } : {})
  g.game.encounter = { teamHome: home, teamAway: away }
  return g
}

describe('teamNameRenames (pure)', () => {
  it('a Romandie or Ticino team whose region name differs: its German name -> the region\'s; a German-speaking team: none', () => {
    const home = ticino('VBC Esempio 1', 'VBC Esempio HU23-1')
    assert.equal(teamName(home), 'VBC Esempio 1', 'what the sync writes since a66c1abba')
    const r = teamNameRenames([item(1, home, german('VBC Musterdorf H1')), item(2, ticino('Volley Lugano', 'Volley Lugano'), german('VC Beispielstadt D1'))])
    assert.deepEqual([...r], [['vbc esempio hu23-1', 'VBC Esempio 1']])
  })
  it('left out when unclear: two region names for one German name, one region name for two, a region name that is another team\'s German name', () => {
    assert.equal(teamNameRenames([item(1, ticino('A 1', 'A HU23-1'), german('X')), item(2, ticino('A 2', 'A HU23-1'), german('Y'))]).size, 0)
    assert.equal(teamNameRenames([item(1, ticino('B 1', 'B HU23-1'), german('X')), item(2, ticino('B 1', 'B H1'), german('Y'))]).size, 0)
    assert.equal(teamNameRenames([item(1, ticino('VBC Musterdorf H1', 'C HU23-1'), german('VBC Musterdorf H1'))]).size, 0)
    assert.equal(teamNameRenames(null).size, 0)
  })
})

describe('vm-sync: club teams, saved teams and older rows follow the region\'s team names (LOG-24)', { skip: SKIP_PG }, () => {
  let db, sql, pool
  const NOW = new Date('2026-11-23T08:00:00Z')
  const http = { sleep: async () => {}, backoffMs: 1, timeoutMs: 5000 }
  const people = {}
  let clubId, competitionId

  before(async () => {
    db = await createTestDatabase('mail_teamnames')
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    await sql.query('DROP TABLE IF EXISTS public.svrz_games, public.svrz_sync_log, public.svrz_games_removed CASCADE')
    await sql.query(SVRZ_SQL)
    pool = new pg.Pool({ connectionString: db.url, max: 4 })
    pool.on('error', () => {})
    for (const name of ['scorer', 'admin']) {
      const { rows: [u] } = await sql.query('INSERT INTO auth.users (email, email_confirmed_at) VALUES ($1, now()) RETURNING id', [`${name}-${randomBytes(3).toString('hex')}@example.ch`])
      await grantRoles(sql, u.id, name === 'admin' ? ['admin'] : ['scorer'])
      people[name] = { id: u.id }
    }
    // the club as an admin made it before the switch: its team by the German name the schedule had
    ;({ rows: [{ id: clubId }] } = await sql.query("INSERT INTO public.clubs (name, contact_email) VALUES ('VBC Esempio', 'contatto@esempio.example.ch') RETURNING id"))
    await sql.query("INSERT INTO public.club_teams (club_id, team_name) VALUES ($1, 'VBC Esempio HU23-1')", [clubId])
    await sql.query('INSERT INTO public.account_clubs (user_id, club_id) VALUES ($1, $2)', [people.scorer.id, clubId])
    await sql.query('UPDATE public.club_rule SET enabled = true, changed_at = now() WHERE id')
    // saved teams: one with the svrz name, one with only the German name; an archived competition stays as it is
    ;({ rows: [{ id: competitionId }] } = await sql.query("INSERT INTO public.competitions (name, season) VALUES ('Lega 3', '2026/27') RETURNING id"))
    await sql.query("INSERT INTO public.competition_teams (competition_id, name, svrz_team_name) VALUES ($1, 'Esempio U23', 'VBC Esempio HU23-1'), ($1, 'VBC Esempio HU23-1', NULL)", [competitionId])
    const { rows: [{ id: archived }] } = await sql.query("INSERT INTO public.competitions (name, season, archived) VALUES ('Lega 3 old', '2025/26', true) RETURNING id")
    await sql.query("INSERT INTO public.competition_teams (competition_id, name, svrz_team_name) VALUES ($1, 'Esempio old', 'VBC Esempio HU23-1')", [archived])
    // an older schedule row, outside the sync's window, with the German name
    await sql.query("INSERT INTO public.svrz_games (game_number, datetime, team_home, team_away) VALUES ('880001', '2026-10-01T18:00:00', 'VBC Esempio HU23-1', 'VBC Musterdorf H1')")
  })
  after(async () => {
    await pool?.end().catch(() => {})
    await sql?.end().catch(() => {})
    await db?.drop()
  })

  /** A scorer's write of an official match of `gameN`, as the club rule (db/018) sees it: null, or the refusal's code. */
  async function scorerCreates (gameN) {
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query("SELECT set_config('ov.user_id', $1, true)", [people.scorer.id])
      await c.query(`INSERT INTO public.matches (external_id, status, game_n, created_by, home_team, away_team)
                     VALUES ($1, 'setup', $2, $3, '{"name":"VBC Esempio 1"}', '{"name":"VBC Musterdorf H1"}')`, [`m_${randomBytes(6).toString('hex')}`, gameN, people.scorer.id])
      return null
    } catch (err) {
      return err.code
    } finally {
      await c.query('ROLLBACK').catch(() => {})
      c.release()
    }
  }

  it('without the renames the club rule refuses the club\'s own home game (the finding)', async () => {
    await sql.query("INSERT INTO public.svrz_games (game_number, datetime, team_home, team_away) VALUES ('880099', '2026-11-24T18:00:00', 'VBC Esempio 1', 'VBC Musterdorf H1')")
    assert.equal(await scorerCreates(880099), 'OVL02', 'not a home game of the account\'s clubs')
    await sql.query("DELETE FROM public.svrz_games WHERE game_number = '880099'")
  })

  it('a sync renames club_teams, the open saved teams and older rows; the club rule takes the scorer; the final mail finds the club\'s contact', async () => {
    const vm = createFakeVolleyManager({
      games: [item(880002, ticino('VBC Esempio 1', 'VBC Esempio HU23-1'), german('VBC Musterdorf H1'), '2026-11-24T18:00:00.000Z')]
    })
    const r = await runVmSync({ pool, fetch: vm.fetch, baseUrl: vm.baseUrl, http, now: NOW, credentials: { username: FAKE_USER, password: FAKE_PASSWORD }, logger: quietLogger(), pageDelayMs: 0 })
    assert.equal(r.status, 'success', r.message)
    assert.deepEqual(r.renamedTeams, { clubTeams: 1, savedTeams: 2, games: 1 })
    assert.match(r.message, /1 club and 2 saved team name\(s\) now in their region's language/)
    assert.deepEqual((await sql.query('SELECT team_name FROM public.club_teams WHERE club_id = $1', [clubId])).rows, [{ team_name: 'VBC Esempio 1' }])
    assert.deepEqual((await sql.query('SELECT name, svrz_team_name FROM public.competition_teams ORDER BY name')).rows, [
      { name: 'Esempio U23', svrz_team_name: 'VBC Esempio 1' },
      { name: 'Esempio old', svrz_team_name: 'VBC Esempio HU23-1' }, // archived: as it was
      { name: 'VBC Esempio HU23-1', svrz_team_name: 'VBC Esempio 1' } // its name stays, the svrz name links it
    ])
    assert.deepEqual((await sql.query("SELECT team_home FROM public.svrz_games WHERE game_number = '880001'")).rows, [{ team_home: 'VBC Esempio 1' }])
    // the club rule: the club's scorer takes its home game again
    assert.equal(await scorerCreates(880002), null)
    // the final mail: the club's contact of the schedule's home team
    const mails = []
    const fm = createFinalMail({
      pool,
      mailer: { enabled: true, async send (kind, o) { mails.push({ kind, ...o }); return { sent: true } } },
      scoresheets: { async latestPdf () { return { data: Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n'), filename: 'Scoresheet.pdf', mtimeMs: Date.now() } } },
      audit: async () => {},
      logger: quietLogger()
    })
    await sql.query('UPDATE public.app_settings SET send_final_email = true, changed_at = now() - interval \'1 day\'')
    await sql.query('SET session_replication_role = replica')
    try {
      await sql.query(`INSERT INTO public.matches (external_id, status, game_n, created_by, closed_by, closed_at, home_team, away_team, officials)
                       VALUES ($1, 'final', 880002, $2, $2, now() - interval '5 minutes', '{"name":"VBC Esempio 1"}', '{"name":"VBC Musterdorf H1"}', '[]')`,
      [`m_${randomBytes(6).toString('hex')}`, people.scorer.id])
    } finally {
      await sql.query('SET session_replication_role = origin')
    }
    await fm.sweep()
    assert.ok(mails.some((m) => m.kind === 'scoresheet' && m.to === 'contatto@esempio.example.ch'), JSON.stringify(mails.map((m) => m.to)))
  })

  it('idempotent: a second sync renames nothing', async () => {
    const renamed = await followTeamRenames(pool, new Map([['vbc esempio hu23-1', 'VBC Esempio 1']]))
    assert.deepEqual(renamed, { clubTeams: 0, savedTeams: 0, games: 0 })
  })
})
