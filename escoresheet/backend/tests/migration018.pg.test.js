/**
 * db/018_clubs.sql on a database in the state before it (the synthetic schema
 * with 005 to 017), the way it will meet production: it runs twice, the rule
 * starts off, stored matches are untouched, and the guard refuses exactly what
 * it should when it is on (SQLSTATEs OVL01-OVL03), for the writer named by
 * ov.user_id only. The app role (roles.sql grants) may use the new tables.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { SKIP_PG, createTestDatabase } from './helpers/pgTestDb.js'

const here = dirname(fileURLToPath(import.meta.url))
const sqlOf = (f) => readFileSync(join(here, '..', 'db', f), 'utf8')
const BEFORE_018 = [
  readFileSync(join(here, 'fixtures', 'synthetic_schema.sql'), 'utf8'),
  ...['005_match_ownership.sql', '006_matches_updated_at.sql', '007_scorer_accounts.sql', '008_live_state_tto.sql',
    '009_beach_saved_teams.sql', '010_auth_tokens.sql', '011_account_approvals.sql', '012_app_memberships.sql',
    '013_beach_official_index.sql', '014_beach_tournaments.sql', '015_event_revisions.sql', '016_activity_log.sql',
    '017_match_remarks.sql'].map(sqlOf)
].join('\n')

describe('db/018 (clubs)', { skip: SKIP_PG }, () => {
  let tdb, raw, app
  const ids = {}

  const expectCode = async (client, sql, params, code) => {
    await assert.rejects(() => client.query(sql, params), (err) => {
      assert.equal(err.code, code, err.message)
      return true
    })
  }
  // a write as the account `who` (what pgQuery does: set_config in the transaction)
  const as = async (who, sql, params = []) => {
    await raw.query('BEGIN')
    try {
      await raw.query("SELECT set_config('ov.user_id', $1, true)", [who ?? ''])
      const r = await raw.query(sql, params)
      await raw.query('COMMIT')
      return r
    } catch (err) {
      await raw.query('ROLLBACK')
      throw err
    }
  }
  const insertGame = (who, ext, n, extra = '') => as(who, `INSERT INTO public.matches (external_id, status, game_n${extra ? ', ' + extra.split('=')[0] : ''}) VALUES ($1, 'live', $2${extra ? ', ' + extra.split('=')[1] : ''})`, [ext, n])

  before(async () => {
    tdb = await createTestDatabase('mig018', { schemaSql: BEFORE_018 })
    raw = new pg.Client({ connectionString: tdb.url, options: '-c TimeZone=UTC' })
    await raw.connect()
    for (const name of ['admin', 'scorer', 'other']) {
      const { rows: [u] } = await raw.query('INSERT INTO auth.users (email) VALUES ($1) RETURNING id', [`${name}@example.ch`])
      ids[name] = u.id
      await raw.query('INSERT INTO public.profiles (user_id, roles) VALUES ($1, $2)', [u.id, name === 'admin' ? ['admin'] : ['scorer']])
    }
    await raw.query(`INSERT INTO public.svrz_games (game_number, team_home, team_away) VALUES
      ('800001', 'KSC Wiedikon H1', 'VBC Other H1'), ('800002', 'VBC Other H1', 'KSC Wiedikon H1'),
      ('800004', 'KSC Wiedikon H1', 'VBC Other H2'), ('800005', 'KSC Wiedikon H1', 'VBC Other H3')`)
    // a match scored before 018 by an account that will have no club
    await raw.query("INSERT INTO public.matches (external_id, status, game_n) VALUES ('m018_old', 'live', 800002)")
  })

  after(async () => {
    await app?.end().catch(() => {})
    await raw?.end()
    await tdb?.drop()
  })

  it('018 runs twice; the rule starts off; nothing stored changes', async () => {
    const m018 = sqlOf('018_clubs.sql')
    for (let i = 0; i < 2; i++) await raw.query(m018)
    const { rows } = await raw.query('SELECT id, enabled FROM public.club_rule')
    assert.deepEqual(rows, [{ id: true, enabled: false }])
    const { rows: [n] } = await raw.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'matches_club_guard'")
    assert.equal(n.n, 1)
    const { rows: [old] } = await raw.query("SELECT game_n, status FROM public.matches WHERE external_id = 'm018_old'")
    assert.deepEqual(old, { game_n: 800002, status: 'live' })
    // off: anyone scores anything
    await insertGame(ids.other, 'm018_off', 800001)
  })

  it('on: no club, not a home game of the clubs, a game VolleyManager does not know', async () => {
    await raw.query('UPDATE public.club_rule SET enabled = true')
    const { rows: [c] } = await raw.query("INSERT INTO public.clubs (name) VALUES ('KSC Wiedikon') RETURNING id")
    await raw.query("INSERT INTO public.club_teams (club_id, team_name) VALUES ($1, 'KSC Wiedikon H1')", [c.id])
    await expectCode(raw, 'INSERT INTO public.club_teams (club_id, team_name) VALUES ($1, $2)', [c.id, ' ksc wiedikon h1 '], '23505')

    await assert.rejects(() => insertGame(ids.other, 'm018_a', 800004), (e) => e.code === 'OVL01')
    await raw.query('INSERT INTO public.account_clubs (user_id, club_id) VALUES ($1, $2)', [ids.scorer, c.id])
    await insertGame(ids.scorer, 'm018_home', 800004)
    await assert.rejects(() => insertGame(ids.scorer, 'm018_away', 800002), (e) => e.code === 'OVL02')
    await assert.rejects(() => insertGame(ids.scorer, 'm018_unknown', 800003), (e) => e.code === 'OVL03')
  })

  it('not checked: test, beach, numberless and exempt matches, admins, server code; stored matches keep going', async () => {
    await insertGame(ids.scorer, 'm018_test', 800002, 'test=true')
    await insertGame(ids.scorer, 'm018_beach', 800002, "sport_type='beach'")
    await insertGame(ids.scorer, 'm018_none', null)
    await insertGame(ids.admin, 'm018_admin', 800006) // not even in the schedule: admins are not checked
    await insertGame(null, 'm018_server', 800003)
    // the old match of the club-less account: further writes pass
    await as(ids.other, "UPDATE public.matches SET status = 'ended' WHERE external_id = 'm018_old'")
    // an upsert of a stored match decides on its UPDATE (same game: passes)
    await as(ids.other, `INSERT INTO public.matches (external_id, status, game_n) VALUES ('m018_old', 'ended', 800002)
                         ON CONFLICT (external_id) DO UPDATE SET status = EXCLUDED.status`)
    // ...but moving it to another game is a new claim
    await assert.rejects(() => as(ids.other, "UPDATE public.matches SET game_n = 800005 WHERE external_id = 'm018_old'"), (e) => e.code === 'OVL01')
    // a test match turned official is checked then
    await assert.rejects(() => as(ids.scorer, "UPDATE public.matches SET test = false WHERE external_id = 'm018_test'"), (e) => e.code === 'OVL02')
    // an admin's exemption lifted later claims the game anew (CodeRabbit on #11)
    await raw.query("INSERT INTO public.matches (external_id, status, game_n, official_game_exempt) VALUES ('m018_exempt', 'live', 800002, true)")
    await assert.rejects(() => as(ids.other, "UPDATE public.matches SET official_game_exempt = false WHERE external_id = 'm018_exempt'"), (e) => e.code === 'OVL01')
  })

  it('account deletion and club deletion cascade', async () => {
    const { rows: [c] } = await raw.query("INSERT INTO public.clubs (name) VALUES ('Gone') RETURNING id")
    await raw.query('INSERT INTO public.account_clubs (user_id, club_id) VALUES ($1, $2)', [ids.other, c.id])
    await raw.query('DELETE FROM public.clubs WHERE id = $1', [c.id])
    const { rows: [n] } = await raw.query('SELECT count(*)::int AS n FROM public.account_clubs WHERE user_id = $1', [ids.other])
    assert.equal(n.n, 0)
  })

  it('the app role uses the new tables', async () => {
    app = new pg.Client({ connectionString: await tdb.createAppRole() })
    await app.connect()
    const { rows: [c] } = await app.query("INSERT INTO public.clubs (name) VALUES ('From the app') RETURNING id")
    await app.query("INSERT INTO public.club_teams (club_id, team_name) VALUES ($1, 'App H1')", [c.id])
    await app.query('INSERT INTO public.account_clubs (user_id, club_id) VALUES ($1, $2)', [ids.other, c.id])
    await app.query('UPDATE public.club_rule SET enabled = true')
    const { rows } = await app.query('SELECT name FROM public.clubs ORDER BY name')
    assert.ok(rows.some((r) => r.name === 'From the app'))
  })
})
