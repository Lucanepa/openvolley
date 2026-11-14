/**
 * db/036_team_manager_confirm.sql on a database with data: the memberships
 * db/030 gave team managers go where nothing else explains them (also of a
 * team manager taken off since), the others stay; from then on a team
 * manager joins no club and a club manager does; club manager links get
 * their address from the label; the open codes of a club deleted before are
 * revoked; a second run changes nothing.
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP_PG, createTestDatabase } from './helpers/pgTestDb.js'

const here = dirname(fileURLToPath(import.meta.url))
const sqlOf = (f) => readFileSync(join(here, '..', 'db', f), 'utf8')
// the schema as it was before 036 (the numbered files only: their own trigger bodies)
const BEFORE_036 = [
  readFileSync(join(here, 'fixtures', 'synthetic_schema.sql'), 'utf8'),
  ...['005_match_ownership.sql', '006_matches_updated_at.sql', '007_scorer_accounts.sql', '008_live_state_tto.sql',
    '009_beach_saved_teams.sql', '010_auth_tokens.sql', '011_account_approvals.sql', '012_app_memberships.sql',
    '013_beach_official_index.sql', '014_beach_tournaments.sql', '015_event_revisions.sql', '016_activity_log.sql',
    '017_match_remarks.sql', '018_clubs.sql', '019_match_scorer_device.sql', '020_club_managers.sql',
    '021_final_mail.sql', '022_passkeys.sql', '023_team_managers.sql', '024_club_licences.sql',
    '025_account_requests.sql', '026_club_licences_manual.sql', '027_account_deactivate.sql',
    '028_notifications.sql', '029_club_manager_links.sql', '030_manager_roles.sql', '031_manager_roles_definer.sql',
    '032_match_id_scoping.sql', '033_match_scoresheets.sql'].map(sqlOf)
].join('\n')
const MIGRATION = sqlOf('036_team_manager_confirm.sql') + '\n' + sqlOf('current_definitions.sql')

describe('migration 036: team managers confirmed, no club membership', { skip: SKIP_PG }, () => {
  let t, raw
  let club, h1, d2, gone
  const u = {}
  const member = async (id, c = club) => (await raw.query('SELECT count(*)::int AS n FROM public.account_clubs WHERE user_id = $1 AND club_id = $2', [id, c])).rows[0].n
  async function user (name) {
    const id = randomUUID()
    await raw.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `${name}@example.ch`])
    await raw.query("INSERT INTO public.profiles (user_id, roles) VALUES ($1, '{}')", [id])
    u[name] = id
    return id
  }
  async function code (role, { clubId = club, teamId = null, label = 'A code' } = {}) {
    const { rows: [r] } = await raw.query(
      `INSERT INTO public.invite_codes (code_hash, code_hint, label, role, club_id, team_id, sport)
       VALUES ($1, 'ABCD', $2, $3, $4, $5, 'indoor') RETURNING id`, [randomBytes(32), label, role, clubId, teamId])
    await raw.query("INSERT INTO public.audit_log (action, details) VALUES ('invite.create', jsonb_build_object('invite_id', $1::text, 'club_id', $2::text))", [r.id, clubId])
    return r.id
  }
  const redeem = (inviteId, userId) => raw.query('INSERT INTO public.invite_redemptions (invite_id, user_id) VALUES ($1, $2)', [inviteId, userId])
  const manage = (teamId, userId) => raw.query('INSERT INTO public.team_managers (team_id, user_id) VALUES ($1, $2)', [teamId, userId])

  before(async () => {
    t = await createTestDatabase('mig036', { schemaSql: BEFORE_036 })
    raw = new pg.Client({ connectionString: t.url })
    await raw.connect()
    club = (await raw.query("INSERT INTO public.clubs (name) VALUES ('VBC Musterdorf') RETURNING id")).rows[0].id
    h1 = (await raw.query("INSERT INTO public.club_teams (club_id, team_name) VALUES ($1, 'VBC Musterdorf H1') RETURNING id", [club])).rows[0].id
    d2 = (await raw.query("INSERT INTO public.club_teams (club_id, team_name) VALUES ($1, 'VBC Musterdorf D2') RETURNING id", [club])).rows[0].id
    const link = await code('team_manager', { teamId: h1, label: 'Team link' })
    // a team manager by its link: db/030 made it a member
    await user('linked'); await redeem(link, u.linked); await manage(h1, u.linked)
    // a team manager taken off: the membership stayed
    await user('removed'); await redeem(link, u.removed); await manage(h1, u.removed)
    await raw.query('DELETE FROM public.team_managers WHERE user_id = $1', [u.removed])
    // a team manager approved from its sign-up request
    await user('approved')
    await raw.query("INSERT INTO public.audit_log (action, target_user_id, details) VALUES ('account.request_approve', $1, jsonb_build_object('kind', 'team_manager', 'club_id', $2::text, 'team_id', $3::text))", [u.approved, club, d2])
    await manage(d2, u.approved)
    // a scorer of the club by its code, then a team manager
    await user('scorer'); const sc = await code('scorer'); await redeem(sc, u.scorer)
    await raw.query('INSERT INTO public.account_clubs (user_id, club_id) VALUES ($1, $2)', [u.scorer, club])
    await manage(h1, u.scorer)
    // a member before it managed a team
    await user('earlier')
    await raw.query("INSERT INTO public.account_clubs (user_id, club_id, granted_at) VALUES ($1, $2, now() - interval '1 day')", [u.earlier, club])
    await manage(h1, u.earlier)
    // a club manager that manages a team too
    await user('boss'); await raw.query('INSERT INTO public.club_managers (club_id, user_id) VALUES ($1, $2)', [club, u.boss]); await manage(d2, u.boss)
    // a team manager an admin then put in the club
    await user('placed'); await manage(d2, u.placed)
    await raw.query("INSERT INTO public.audit_log (action, target_user_id, details) VALUES ('account.clubs', $1, jsonb_build_object('before', '[]'::jsonb, 'after', jsonb_build_array($2::text)))", [u.placed, club])
    // a club manager link made before (its address only in the label)
    u.mgrLink = await code('club_manager', { label: 'Club manager · Mia.Muster@Example.ch' })
    // a club deleted before, with an open code
    gone = (await raw.query("INSERT INTO public.clubs (name) VALUES ('VBC Gone') RETURNING id")).rows[0].id
    u.goneCode = await code('scorer', { clubId: gone, label: 'Gone scorers' })
    await raw.query('DELETE FROM public.clubs WHERE id = $1', [gone])
    // before 036: every one of them is a member
    for (const name of ['linked', 'removed', 'approved', 'scorer', 'earlier', 'boss', 'placed']) assert.equal(await member(u[name]), 1, name)
    await raw.query(MIGRATION)
  })
  after(async () => {
    await raw?.end()
    await t?.drop()
  })

  it('the memberships only a team gave go, also of a team manager taken off; the rest stay', async () => {
    for (const name of ['linked', 'removed', 'approved']) assert.equal(await member(u[name]), 0, name)
    for (const name of ['scorer', 'earlier', 'boss', 'placed']) assert.equal(await member(u[name]), 1, name)
    // still team managers, with the role
    const { rows } = await raw.query('SELECT roles FROM public.profiles WHERE user_id = $1', [u.linked])
    assert.deepEqual(rows[0].roles, ['team_manager'])
    const { rows: audit } = await raw.query("SELECT target_user_id, details FROM public.audit_log WHERE action = 'account.clubs' AND details ->> 'reason' = 'team_manager' ORDER BY target_user_id")
    assert.deepEqual(audit.map((a) => a.target_user_id).sort(), [u.linked, u.removed, u.approved].sort())
    assert.ok(audit.every((a) => a.details.removed === club))
  })

  it('from now on a team manager joins no club, a club manager does', async () => {
    const n = await user('newcoach')
    await manage(h1, n)
    assert.equal(await member(n), 0)
    const { rows } = await raw.query('SELECT roles FROM public.profiles WHERE user_id = $1', [n])
    assert.deepEqual(rows[0].roles, ['team_manager'])
    const m = await user('newboss')
    await raw.query('INSERT INTO public.club_managers (club_id, user_id) VALUES ($1, $2)', [club, m])
    assert.equal(await member(m), 1)
  })

  it('a club manager link knows its address; the open code of a deleted club is revoked', async () => {
    const { rows: [l] } = await raw.query('SELECT invited_email FROM public.invite_codes WHERE id = $1', [u.mgrLink])
    assert.equal(l.invited_email, 'mia.muster@example.ch')
    const { rows: [g] } = await raw.query('SELECT revoked_at FROM public.invite_codes WHERE id = $1', [u.goneCode])
    assert.ok(g.revoked_at)
    const { rows: [e] } = await raw.query("SELECT details FROM public.audit_log WHERE action = 'invite.revoke' AND details ->> 'invite_id' = $1", [u.goneCode])
    assert.equal(e.details.reason, 'club_deleted')
    // codes of clubs that still exist stay
    const { rows: open } = await raw.query('SELECT count(*)::int AS n FROM public.invite_codes WHERE revoked_at IS NULL AND club_id = $1', [club])
    assert.equal(open[0].n, 3)
  })

  it('a team manager part may be proposed; other parts may not', async () => {
    const who = await user('applicant')
    const { rows: [r] } = await raw.query(
      "INSERT INTO public.account_requests (user_id, kind, club_id, team_id) VALUES ($1, 'team_manager', $2, $3) RETURNING id", [who, club, h1])
    await raw.query('UPDATE public.account_requests SET proposed_by = $2, proposed_at = now() WHERE id = $1', [r.id, u.linked])
    await assert.rejects(raw.query("INSERT INTO public.account_requests (user_id, kind, club_id, proposed_at) VALUES ($1, 'scorer', $2, now())", [who, club]), (err) => err.code === '23514')
    await raw.query("INSERT INTO public.notifications (user_id, kind, subject_user_id, target) VALUES ($1, 'team_manager_proposal', $2, 'myclub/x')", [u.boss, who])
  })

  it('is idempotent: a second run removes and revokes nothing more', async () => {
    const count = async () => (await raw.query("SELECT count(*)::int AS n FROM public.audit_log WHERE details ->> 'by' = 'db/036'")).rows[0].n
    const before = await count()
    await raw.query(MIGRATION)
    assert.equal(await count(), before)
    for (const name of ['scorer', 'earlier', 'boss', 'placed']) assert.equal(await member(u[name]), 1, name)
  })
})
