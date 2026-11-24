/**
 * db/031: the manager-role trigger (db/030) works for ov_app, which has no
 * EXECUTE on any function (roles.sql). Owner 2026-11-11: approving a sign-up
 * request with a team manager or club manager part failed with 42501
 * "permission denied for function ov_sync_manager_roles". Since db/036 only
 * a club manager joins the club.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { SKIP_PG, createTestDatabase } from './helpers/pgTestDb.js'

describe('db/031: club and team managers written by ov_app', { skip: SKIP_PG }, () => {
  let tdb, raw, app
  const user = randomUUID()
  let clubId, teamId

  before(async () => {
    tdb = await createTestDatabase('mgrroles')
    const appUrl = await tdb.createAppRole()
    raw = new pg.Client({ connectionString: tdb.url })
    await raw.connect()
    // as roles.sql: nobody but the owner may call a function
    await raw.query('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC')
    await raw.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [user, 'manager@example.ch'])
    await raw.query("INSERT INTO public.profiles (user_id, first_name, last_name, roles) VALUES ($1, 'Mia', 'Test', '{scorer}')", [user])
    clubId = (await raw.query("INSERT INTO public.clubs (name) VALUES ('VBC Test') RETURNING id")).rows[0].id
    teamId = (await raw.query("INSERT INTO public.club_teams (club_id, team_name) VALUES ($1, 'VBC Test H1') RETURNING id", [clubId])).rows[0].id
    app = new pg.Client({ connectionString: appUrl })
    await app.connect()
  })
  after(async () => {
    await app?.end()
    await raw?.end()
    await tdb?.drop()
  })

  const rolesOf = async () => (await raw.query('SELECT roles FROM public.profiles WHERE user_id = $1', [user])).rows[0].roles

  const memberOf = async () => (await raw.query('SELECT 1 FROM public.account_clubs WHERE user_id = $1 AND club_id = $2', [user, clubId])).rows.length

  it('a team manager row: the role, no permission error, and no club (db/036)', async () => {
    await app.query('INSERT INTO public.team_managers (team_id, user_id) VALUES ($1, $2)', [teamId, user])
    assert.deepEqual(await rolesOf(), ['scorer', 'team_manager'])
    assert.equal(await memberOf(), 0)
  })

  it('a club manager row (the role and the club), then both removed: the roles follow', async () => {
    await app.query('INSERT INTO public.club_managers (club_id, user_id) VALUES ($1, $2)', [clubId, user])
    assert.deepEqual(await rolesOf(), ['scorer', 'club_manager', 'team_manager'])
    assert.equal(await memberOf(), 1)
    await app.query('DELETE FROM public.club_managers WHERE user_id = $1', [user])
    await app.query('DELETE FROM public.team_managers WHERE user_id = $1', [user])
    assert.deepEqual(await rolesOf(), ['scorer'])
  })

  it('ov_app still cannot call the functions itself', async () => {
    await assert.rejects(app.query('SELECT public.ov_sync_manager_roles($1)', [user]), (e) => e.code === '42501')
  })
})
