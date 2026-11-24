/**
 * db/058_club_membership_suggestions.sql (audit 2611, PERM-12 / PERM-04):
 *   - a new club manager who was no member joins the club marked 'manager',
 *     and leaves it again (audited) when its club_managers row goes;
 *   - a member of before keeps its membership; a team manager joins nothing;
 *   - an account or a club deleted: the cascade works (no audit row naming
 *     a deleted account);
 *   - roster_suggestions go with their match;
 *   - a second run changes nothing; memberships of before are not rewritten.
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
const MIGRATION = readFileSync(join(here, '..', 'db', '058_club_membership_suggestions.sql'), 'utf8')

describe('migration 058: manager memberships and roster suggestions', { skip: SKIP_PG }, () => {
  let t, raw, club, team
  async function user (name) {
    const id = randomUUID()
    await raw.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `${name}-${id.slice(0, 6)}@example.ch`])
    await raw.query("INSERT INTO public.profiles (user_id, roles) VALUES ($1, '{scorer}')", [id])
    return id
  }
  const membership = async (u, c = club) => (await raw.query('SELECT granted_via FROM public.account_clubs WHERE user_id = $1 AND club_id = $2', [u, c])).rows[0] ?? null
  const removals = async (u) => (await raw.query("SELECT details FROM public.audit_log WHERE action = 'account.clubs' AND target_user_id = $1 AND details ->> 'reason' = 'club_manager_removed'", [u])).rows

  before(async () => {
    t = await createTestDatabase('mig058')
    raw = new pg.Client({ connectionString: t.url })
    await raw.connect()
    club = (await raw.query("INSERT INTO public.clubs (name) VALUES ('VBC Muster') RETURNING id")).rows[0].id
    team = (await raw.query("INSERT INTO public.club_teams (club_id, team_name) VALUES ($1, 'VBC Muster H1') RETURNING id", [club])).rows[0].id
  })
  after(async () => { await raw?.end().catch(() => {}); await t?.drop() })

  it('a manager who was no member: joins marked, leaves again with the manager row (audited)', async () => {
    const u = await user('outsider')
    await raw.query('INSERT INTO public.club_managers (club_id, user_id) VALUES ($1, $2)', [club, u])
    assert.deepEqual(await membership(u), { granted_via: 'manager' })
    await raw.query('DELETE FROM public.club_managers WHERE club_id = $1 AND user_id = $2', [club, u])
    assert.equal(await membership(u), null, 'no member any more')
    const a = await removals(u)
    assert.equal(a.length, 1)
    assert.equal(a[0].details.removed, club)
    const { rows: [p] } = await raw.query('SELECT roles FROM public.profiles WHERE user_id = $1', [u])
    assert.deepEqual(p.roles, ['scorer'], 'the manager role goes as before')
  })

  it('a member of before stays a member when its manager row goes', async () => {
    const u = await user('member')
    await raw.query('INSERT INTO public.account_clubs (user_id, club_id) VALUES ($1, $2)', [u, club])
    await raw.query('INSERT INTO public.club_managers (club_id, user_id) VALUES ($1, $2)', [club, u])
    assert.deepEqual(await membership(u), { granted_via: null })
    await raw.query('DELETE FROM public.club_managers WHERE club_id = $1 AND user_id = $2', [club, u])
    assert.deepEqual(await membership(u), { granted_via: null })
    assert.equal((await removals(u)).length, 0)
  })

  it('a membership made its own since (granted_via cleared) stays', async () => {
    const u = await user('joinedSince')
    await raw.query('INSERT INTO public.club_managers (club_id, user_id) VALUES ($1, $2)', [club, u])
    // as lib/accounts.js redeemFound does with a club code redeemed later
    await raw.query("UPDATE public.account_clubs SET granted_via = NULL WHERE user_id = $1 AND club_id = $2 AND granted_via = 'manager'", [u, club])
    await raw.query('DELETE FROM public.club_managers WHERE club_id = $1 AND user_id = $2', [club, u])
    assert.deepEqual(await membership(u), { granted_via: null })
  })

  it('a team manager joins no club; its row going takes nothing', async () => {
    const u = await user('teamOnly')
    await raw.query('INSERT INTO public.team_managers (team_id, user_id) VALUES ($1, $2)', [team, u])
    assert.equal(await membership(u), null)
    await raw.query('DELETE FROM public.team_managers WHERE team_id = $1 AND user_id = $2', [team, u])
    assert.equal(await membership(u), null)
  })

  it('an account or a club deleted: the cascade goes through, no audit row for it', async () => {
    const u = await user('leaving')
    await raw.query('INSERT INTO public.club_managers (club_id, user_id) VALUES ($1, $2)', [club, u])
    await raw.query('DELETE FROM auth.users WHERE id = $1', [u])
    assert.equal(await membership(u), null)
    const other = (await raw.query("INSERT INTO public.clubs (name) VALUES ('VBC Gone') RETURNING id")).rows[0].id
    const v = await user('clubGone')
    await raw.query('INSERT INTO public.club_managers (club_id, user_id) VALUES ($1, $2)', [other, v])
    await raw.query('DELETE FROM public.clubs WHERE id = $1', [other])
    assert.equal(await membership(v, other), null)
    assert.equal((await removals(v)).length, 0)
  })

  it('roster suggestions go with their match', async () => {
    const { rows: [m] } = await raw.query("INSERT INTO public.matches (external_id, game_n, status) VALUES ('match_058_a', 958001, 'final') RETURNING id")
    await raw.query("INSERT INTO public.roster_suggestions (match_id, side, team_name, club_id, team_id, season) VALUES ($1, 'away', 'VBC Muster H1', $2, $3, 2026)", [m.id, club, team])
    await assert.rejects(raw.query("INSERT INTO public.roster_suggestions (match_id, side, team_name, season) VALUES ($1, 'away', 'VBC Muster H1', 2026)", [m.id]), (e) => e.code === '23505', 'one per match and side')
    await assert.rejects(raw.query("UPDATE public.roster_suggestions SET status = 'confirmed' WHERE match_id = $1", [m.id]), (e) => e.code === '23514', 'a decision has its time')
    await raw.query("SET ov.allow_closed = 'on'")
    await raw.query('DELETE FROM public.matches WHERE id = $1', [m.id])
    await raw.query('RESET ov.allow_closed')
    assert.equal((await raw.query('SELECT count(*)::int AS n FROM public.roster_suggestions')).rows[0].n, 0)
  })

  it('a second run changes nothing', async () => {
    const before = (await raw.query('SELECT user_id, club_id, granted_via FROM public.account_clubs ORDER BY user_id, club_id')).rows
    await raw.query(MIGRATION)
    await raw.query(MIGRATION)
    const after = (await raw.query('SELECT user_id, club_id, granted_via FROM public.account_clubs ORDER BY user_id, club_id')).rows
    assert.deepEqual(after, before)
  })
})
