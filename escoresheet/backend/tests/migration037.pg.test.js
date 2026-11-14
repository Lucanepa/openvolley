/**
 * db/037_club_data_scope.sql on a database in the state before it (the
 * synthetic schema with 005 to 033): before it, lib/licences.js reads every
 * row as one of the current season and answers 503 to an upload; it runs
 * twice on rows of before, each takes the season of its upload time (July to
 * June, Europe/Zurich) and an id of its own, a row an older backend writes
 * gets the current season, and the app role (roles.sql grants) writes both
 * columns.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { SKIP_PG, createTestDatabase, quietLogger } from './helpers/pgTestDb.js'
import { createLicences } from '../lib/licences.js'
import { seasonOf } from '../lib/officialGame.js'

const here = dirname(fileURLToPath(import.meta.url))
const sqlOf = (f) => readFileSync(join(here, '..', 'db', f), 'utf8')
const BEFORE_037 = [
  readFileSync(join(here, 'fixtures', 'synthetic_schema.sql'), 'utf8'),
  ...['005_match_ownership.sql', '006_matches_updated_at.sql', '007_scorer_accounts.sql', '008_live_state_tto.sql',
    '009_beach_saved_teams.sql', '010_auth_tokens.sql', '011_account_approvals.sql', '012_app_memberships.sql',
    '013_beach_official_index.sql', '014_beach_tournaments.sql', '015_event_revisions.sql', '016_activity_log.sql',
    '017_match_remarks.sql', '018_clubs.sql', '019_match_scorer_device.sql', '020_club_managers.sql',
    '021_final_mail.sql', '022_passkeys.sql', '023_team_managers.sql', '024_club_licences.sql',
    '025_account_requests.sql', '026_club_licences_manual.sql', '027_account_deactivate.sql', '028_notifications.sql',
    '029_club_manager_links.sql', '030_manager_roles.sql', '031_manager_roles_definer.sql', '032_match_id_scoping.sql',
    '033_match_scoresheets.sql', 'current_definitions.sql'].map(sqlOf)
].join('\n')

describe('db/037 (club licence lists per season, row ids)', { skip: SKIP_PG }, () => {
  let tdb, raw, app, pool, club, team
  const insert = (db, sv, at) => db.query(
    `INSERT INTO public.club_licences (club_id, list, sv_number, last_name${at ? ', imported_at' : ''})
     VALUES ($1, 'players', $2, 'Beispiel'${at ? ', $3' : ''})`, at ? [club, sv, at] : [club, sv])
  const rowOf = async (sv) => (await raw.query('SELECT season, id FROM public.club_licences WHERE club_id = $1 AND sv_number = $2', [club, sv])).rows[0]

  before(async () => {
    tdb = await createTestDatabase('mig037', { schemaSql: BEFORE_037 })
    raw = new pg.Client({ connectionString: tdb.url })
    await raw.connect()
    const { rows: [c] } = await raw.query("INSERT INTO public.clubs (name) VALUES ('VBC Musterdorf') RETURNING id")
    club = c.id
    const { rows: [t] } = await raw.query("INSERT INTO public.club_teams (club_id, team_name) VALUES ($1, 'VBC Musterdorf H1') RETURNING id", [club])
    team = t.id
    // rows of uploads of before 037: March 2025 (season 2024), September 2026
    // (2026), and 30 June 2026 23:30 UTC, which is 1 July in Zurich (2026)
    await insert(raw, '100001', '2025-03-01T10:00:00Z')
    await insert(raw, '100002', '2026-09-01T10:00:00Z')
    await insert(raw, '100003', '2026-06-30T23:30:00Z')
    pool = new pg.Pool({ connectionString: tdb.url })
  })

  after(async () => {
    await pool?.end().catch(() => {})
    await app?.end().catch(() => {})
    await raw?.end()
    await tdb?.drop()
  })

  it('before 037: the reads take every row as one of the current season, an upload answers 503', async () => {
    const logger = quietLogger()
    const lic = createLicences({ pool, audit: async () => {}, logger })
    const c = await lic.clubList({ clubId: club })
    assert.equal(c.status, 200, JSON.stringify(c.body))
    assert.deepEqual(c.body.data.people.map((p) => [p.sv_number, p.id]), [['100001', null], ['100002', null], ['100003', null]])
    const r = await lic.teamClubPlayers({ teamId: team })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.data.players.length, 3)
    const up = await lic.putList({ clubId: club, list: 'players', people: [{ sv_number: '100009', last_name: 'Neu' }] })
    assert.equal(up.status, 503)
    assert.equal((await raw.query('SELECT count(*)::int AS n FROM public.club_licences WHERE club_id = $1', [club])).rows[0].n, 3)
    // the daily sweep does nothing there
    assert.equal(await lic.sweep(), 0)
  })

  it('037 runs twice: each row of before has the season of its upload and an id of its own', async () => {
    const m037 = sqlOf('037_club_data_scope.sql')
    await raw.query(m037)
    const first = { a: await rowOf('100001'), b: await rowOf('100002'), c: await rowOf('100003') }
    assert.deepEqual([first.a.season, first.b.season, first.c.season], [2024, 2026, 2026])
    assert.equal(new Set([first.a.id, first.b.id, first.c.id]).size, 3)
    await raw.query(m037)
    assert.deepEqual(await rowOf('100001'), first.a)
    assert.deepEqual(await rowOf('100003'), first.c)
    const { rows: cols } = await raw.query(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'club_licences' AND column_name IN ('season', 'id') ORDER BY column_name`)
    assert.deepEqual(cols.map((x) => [x.column_name, x.is_nullable]), [['id', 'NO'], ['season', 'NO']])
    const { rows: idx } = await raw.query("SELECT indexname FROM pg_indexes WHERE tablename = 'club_licences' AND indexname IN ('club_licences_id_uidx', 'club_licences_season_idx') ORDER BY 1")
    assert.deepEqual(idx.map((x) => x.indexname), ['club_licences_id_uidx', 'club_licences_season_idx'])
  })

  it('a row written as before (no season, no id) is one of the current season', async () => {
    await insert(raw, '100004')
    const r = await rowOf('100004')
    assert.equal(r.season, seasonOf(new Date()))
    assert.match(r.id, /^[0-9a-f-]{36}$/)
    await assert.rejects(raw.query("INSERT INTO public.club_licences (club_id, list, sv_number, last_name, season) VALUES ($1, 'players', '100005', 'B', 1900)", [club]),
      (err) => err.code === '23514')
  })

  it('after 037: a past season is not served and the sweep deletes it', async () => {
    const lic = createLicences({ pool, audit: async () => {}, logger: quietLogger() })
    const c = await lic.clubList({ clubId: club })
    // 100001 is of season 2024 (a past one from July 2025 on)
    assert.equal(c.body.data.people.some((p) => p.sv_number === '100001'), seasonOf(new Date()) <= 2024)
    assert.ok(c.body.data.people.every((p) => /^[0-9a-f-]{36}$/.test(p.id)))
    const swept = await lic.sweep()
    assert.equal(swept, seasonOf(new Date()) > 2024 ? 1 : 0)
  })

  it('the app role writes the columns', async () => {
    app = new pg.Client({ connectionString: await tdb.createAppRole() })
    await app.connect()
    await app.query(`INSERT INTO public.club_licences (club_id, list, sv_number, last_name, season) VALUES ($1, 'players', '100006', 'Beispiel', $2)`, [club, seasonOf(new Date())])
    await app.query("UPDATE public.club_licences SET season = season WHERE club_id = $1 AND sv_number = '100006'", [club])
    await app.query("DELETE FROM public.club_licences WHERE club_id = $1 AND sv_number = '100006'", [club])
    assert.equal(await rowOf('100006'), undefined)
  })
})
