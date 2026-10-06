/**
 * db/009_beach_saved_teams.sql on a database that already has 007's saved
 * teams, the way it will meet production: indoor competitions, teams and
 * players. It runs twice; the 2.1.0 backend's INSERTs keep working; the new
 * CHECKs hold; the app role (table-level DML, like ov_app after roles.sql)
 * reaches the new columns.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { SKIP_PG, SCHEMA_SQL_005_ONLY, createTestDatabase } from './helpers/pgTestDb.js'

const here = dirname(fileURLToPath(import.meta.url))
const sqlOf = (f) => readFileSync(join(here, '..', 'db', f), 'utf8')
const M009 = sqlOf('009_beach_saved_teams.sql')

describe('db/009_beach_saved_teams.sql', { skip: SKIP_PG }, () => {
  let tdb, raw
  const notices = []
  const ids = {}

  const expectCode = async (sql, params, code) => {
    await assert.rejects(() => raw.query(sql, params), (err) => {
      assert.equal(err.code, code, err.message)
      return true
    })
  }

  before(async () => {
    // The production state before 009: 005 to 008, with 2.1.0's saved teams
    tdb = await createTestDatabase('mig009', {
      schemaSql: [SCHEMA_SQL_005_ONLY, sqlOf('006_matches_updated_at.sql'), sqlOf('007_scorer_accounts.sql'), sqlOf('008_live_state_tto.sql')].join('\n')
    })
    raw = new pg.Client({ connectionString: tdb.url, options: '-c TimeZone=UTC' })
    await raw.connect()
    raw.on('notice', (n) => notices.push(n.message))
    for (const [key, name, season] of [['c1', '2. Liga Herren', '2026/27'], ['c2', '3. Liga Damen', '2025/26']]) {
      const { rows: [c] } = await raw.query(
        "INSERT INTO public.competitions (name, season, gender, vm_leagues) VALUES ($1, $2, 'men', '{2L}') RETURNING id", [name, season])
      ids[key] = c.id
      const { rows: [t] } = await raw.query('INSERT INTO public.competition_teams (competition_id, name) VALUES ($1, $2) RETURNING id', [c.id, `${name} Team`])
      ids[key + 't'] = t.id
      await raw.query(`INSERT INTO public.competition_players (team_id, number, first_name, last_name, is_libero, is_captain, sort_order)
        VALUES ($1, 7, 'A', 'Muster', false, true, 0), ($1, 1, 'B', 'Libero', true, false, 1)`, [t.id])
    }
  })

  after(async () => {
    await raw?.end()
    await tdb?.drop()
  })

  it('runs twice and keeps the existing rows indoor, seasons unchanged, country NULL', async () => {
    const before = (await raw.query('SELECT id, season, updated_at FROM public.competitions ORDER BY id')).rows
    await raw.query(M009)
    assert.equal(notices.filter((n) => n.includes('dropped the indoor-only season check')).length, 1, notices.join('\n'))
    notices.length = 0
    await raw.query(M009)
    assert.equal(notices.filter((n) => n.includes('dropped')).length, 0, 'nothing to drop on a re-run')

    const after = (await raw.query('SELECT id, season, updated_at, sport FROM public.competitions ORDER BY id')).rows
    assert.deepEqual(after.map(({ sport, ...r }) => r), before, 'seasons and updated_at unchanged')
    assert.deepEqual(after.map((r) => r.sport), ['indoor', 'indoor'])
    const { rows: [p] } = await raw.query('SELECT count(*)::int n, count(country)::int c FROM public.competition_players')
    assert.deepEqual(p, { n: 4, c: 0 })
  })

  it("a 2.1.0-style INSERT without sport is indoor; the season format follows the sport", async () => {
    const { rows: [c] } = await raw.query("INSERT INTO public.competitions (name, season, gender, category, vm_leagues, created_by) VALUES ('Old client', '2026/27', null, null, '{}', null) RETURNING sport")
    assert.equal(c.sport, 'indoor')
    const { rows: [b] } = await raw.query("INSERT INTO public.competitions (name, season, sport) VALUES ('Coop Beachtour', '2026', 'beach') RETURNING id, sport")
    assert.equal(b.sport, 'beach')
    ids.beach = b.id
    await expectCode("INSERT INTO public.competitions (name, season, sport) VALUES ('X', '2026/27', 'beach')", [], '23514')
    await expectCode("INSERT INTO public.competitions (name, season, sport) VALUES ('X', '2026', 'indoor')", [], '23514')
    await expectCode("INSERT INTO public.competitions (name, season) VALUES ('X', '2026')", [], '23514')
    await expectCode("INSERT INTO public.competitions (name, season, sport) VALUES ('X', '2026', 'x')", [], '23514')
    await expectCode("INSERT INTO public.competitions (name, season, sport) VALUES ('X', '2026/27', 'snow')", [], '23514')
  })

  it('competition_players.country: NULL or 3 upper-case letters', async () => {
    const { rows: [t] } = await raw.query("INSERT INTO public.competition_teams (competition_id, name) VALUES ($1, 'Müller / Weber') RETURNING id", [ids.beach])
    const ins = (country) => raw.query("INSERT INTO public.competition_players (team_id, number, last_name, country) VALUES ($1, 1, 'Müller', $2)", [t.id, country])
    await expectCode("INSERT INTO public.competition_players (team_id, number, last_name, country) VALUES ($1, 1, 'M', 'che')", [t.id], '23514')
    await expectCode("INSERT INTO public.competition_players (team_id, number, last_name, country) VALUES ($1, 1, 'M', 'CH')", [t.id], '23514')
    await expectCode("INSERT INTO public.competition_players (team_id, number, last_name, country) VALUES ($1, 1, 'M', 'CHEE')", [t.id], '23514')
    await ins('CHE')
    await ins(null)
    assert.equal((await raw.query('SELECT count(country)::int n FROM public.competition_players WHERE team_id = $1', [t.id])).rows[0].n, 1)
  })

  it('no CHECK on competitions other than the two new ones mentions season', async () => {
    const { rows } = await raw.query(`SELECT conname FROM pg_constraint
      WHERE conrelid = 'public.competitions'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%season%' ORDER BY conname`)
    assert.deepEqual(rows.map((r) => r.conname), ['competitions_season_sport_check'])
    const { rows: named } = await raw.query(`SELECT conname FROM pg_constraint
      WHERE conname IN ('competitions_sport_check', 'competitions_season_sport_check', 'competition_players_country_check') ORDER BY conname`)
    assert.equal(named.length, 3)
  })

  it('the app role reaches the new columns through its table-level grants', async () => {
    const appUrl = await tdb.createAppRole()
    const role = new URL(appUrl).username
    const check = async (r) => {
      const { rows: [g] } = await raw.query(`SELECT
        has_column_privilege($1, 'public.competitions', 'sport', 'SELECT,INSERT,UPDATE') AS sport,
        has_column_privilege($1, 'public.competition_players', 'country', 'SELECT,INSERT,UPDATE') AS country`, [r])
      assert.deepEqual(g, { sport: true, country: true }, r)
    }
    await check(role)
    // When the cluster has the production role (a rehearsal restore that ran roles.sql)
    const { rows: ovApp } = await raw.query("SELECT 1 FROM pg_roles WHERE rolname = 'ov_app'")
    const { rows: granted } = await raw.query("SELECT 1 FROM information_schema.role_table_grants WHERE grantee = 'ov_app' AND table_name = 'competitions'")
    if (ovApp.length && granted.length) await check('ov_app')

    const app = new pg.Client({ connectionString: appUrl })
    await app.connect()
    try {
      const { rows: [c] } = await app.query("INSERT INTO public.competitions (name, season, sport) VALUES ('App beach', '2027', 'beach') RETURNING id")
      const { rows: [t] } = await app.query("INSERT INTO public.competition_teams (competition_id, name) VALUES ($1, 'A / B') RETURNING id", [c.id])
      await app.query("INSERT INTO public.competition_players (id, team_id, number, last_name, country) VALUES ($1, $2, 1, 'A', 'ITA')", [randomUUID(), t.id])
      await app.query("UPDATE public.competition_players SET country = 'CHE' WHERE team_id = $1", [t.id])
    } finally { await app.end() }
  })
})
