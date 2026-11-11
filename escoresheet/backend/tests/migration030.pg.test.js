/**
 * db/030_manager_roles.sql: the managers there are before it get the club and
 * team manager roles and their club; afterwards the triggers keep the roles
 * in step (added with the first row, gone with the last, also by cascade),
 * leave the other roles alone, and never take a membership away.
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { SKIP_PG, createTestDatabase } from './helpers/pgTestDb.js'

const here = dirname(fileURLToPath(import.meta.url))
const sqlOf = (f) => readFileSync(join(here, '..', 'db', f), 'utf8')
// the schema as it was before 030
const BEFORE_030 = [
  readFileSync(join(here, 'fixtures', 'synthetic_schema.sql'), 'utf8'),
  ...['005_match_ownership.sql', '006_matches_updated_at.sql', '007_scorer_accounts.sql', '008_live_state_tto.sql',
    '009_beach_saved_teams.sql', '010_auth_tokens.sql', '011_account_approvals.sql', '012_app_memberships.sql',
    '013_beach_official_index.sql', '014_beach_tournaments.sql', '015_event_revisions.sql', '016_activity_log.sql',
    '017_match_remarks.sql', '018_clubs.sql', '019_match_scorer_device.sql', '020_club_managers.sql',
    '021_final_mail.sql', '022_passkeys.sql', '023_team_managers.sql', '024_club_licences.sql',
    '025_account_requests.sql', '026_club_licences_manual.sql', '027_account_deactivate.sql',
    '028_notifications.sql', '029_club_manager_links.sql'].map(sqlOf)
].join('\n')

describe('migration 030: club and team manager roles', { skip: SKIP_PG }, () => {
  let t, raw, app
  const roles = async (id) => (await raw.query('SELECT roles FROM public.profiles WHERE user_id = $1', [id])).rows[0].roles
  const member = async (id, club) => (await raw.query('SELECT count(*)::int AS n FROM public.account_clubs WHERE user_id = $1 AND club_id = $2', [id, club])).rows[0].n
  async function user (r = []) {
    const id = randomUUID()
    await raw.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `${id}@example.ch`])
    await raw.query('INSERT INTO public.profiles (user_id, roles) VALUES ($1, $2::text[])', [id, r])
    return id
  }
  let club, team, oldClubMgr, oldTeamMgr

  before(async () => {
    // the schema before 030, then rows, then 030
    t = await createTestDatabase('mig030', { schemaSql: BEFORE_030 })
    raw = new pg.Client({ connectionString: t.url })
    await raw.connect()
    club = randomUUID()
    team = randomUUID()
    await raw.query("INSERT INTO public.clubs (id, name) VALUES ($1, 'VBC Musterdorf')", [club])
    await raw.query("INSERT INTO public.club_teams (id, club_id, team_name) VALUES ($1, $2, 'VBC Musterdorf H1')", [team, club])
    oldClubMgr = await user(['referee'])
    oldTeamMgr = await user([])
    await raw.query('INSERT INTO public.club_managers (club_id, user_id) VALUES ($1, $2)', [club, oldClubMgr])
    await raw.query('INSERT INTO public.team_managers (team_id, user_id) VALUES ($1, $2)', [team, oldTeamMgr])
    await raw.query(sqlOf('030_manager_roles.sql'))
  })
  after(async () => {
    await app?.end().catch(() => {})
    await raw?.end()
    await t?.drop()
  })

  it('the managers before it: their roles and their club', async () => {
    assert.deepEqual(await roles(oldClubMgr), ['referee', 'club_manager'])
    assert.deepEqual(await roles(oldTeamMgr), ['team_manager'])
    assert.equal(await member(oldClubMgr, club), 1)
    assert.equal(await member(oldTeamMgr, club), 1)
  })

  it('is idempotent', async () => {
    await raw.query(sqlOf('030_manager_roles.sql'))
    assert.deepEqual(await roles(oldClubMgr), ['referee', 'club_manager'])
  })

  it('a new manager gets the role and the club; the last row gone takes the role, never the club or other roles', async () => {
    const u = await user(['scorer'])
    await raw.query('INSERT INTO public.team_managers (team_id, user_id) VALUES ($1, $2)', [team, u])
    assert.deepEqual(await roles(u), ['scorer', 'team_manager'])
    assert.equal(await member(u, club), 1)
    await raw.query('INSERT INTO public.club_managers (club_id, user_id) VALUES ($1, $2)', [club, u])
    assert.deepEqual(await roles(u), ['scorer', 'club_manager', 'team_manager'])
    await raw.query('DELETE FROM public.club_managers WHERE user_id = $1', [u])
    assert.deepEqual(await roles(u), ['scorer', 'team_manager'])
    // the team deleted: the team_managers row goes by cascade, and the role with it
    await raw.query('DELETE FROM public.club_teams WHERE id = $1', [team])
    assert.deepEqual(await roles(u), ['scorer'])
    assert.equal(await member(u, club), 1)
  })

  it('works as the app role (no rights on auth, no DDL)', async () => {
    app = new pg.Client({ connectionString: await t.createAppRole() })
    await app.connect()
    const u = await user([])
    const t2 = randomUUID()
    await raw.query("INSERT INTO public.club_teams (id, club_id, team_name) VALUES ($1, $2, 'VBC Musterdorf D2')", [t2, club])
    await app.query('INSERT INTO public.team_managers (team_id, user_id) VALUES ($1, $2)', [t2, u])
    assert.deepEqual(await roles(u), ['team_manager'])
    assert.equal(await member(u, club), 1)
    await app.query('DELETE FROM public.team_managers WHERE user_id = $1', [u])
    assert.deepEqual(await roles(u), [])
  })
})
