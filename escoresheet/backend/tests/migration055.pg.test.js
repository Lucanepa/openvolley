/**
 * db/055_beach_ownership.sql (PERM-09, PERM-18; owner decision 5) on a
 * database in production's state before it (the synthetic schema with 005 to
 * 052): competitions.created_by and its foreign key are there (db/007), and
 * a beach competition without an owner gets one once from the audit log (the
 * latest saved-teams entry naming it, by an account that still holds
 * beach:competition_manager), else from its oldest team's creator with the
 * role; an indoor competition, an owned one and one without such an account
 * stay as they are; the NOTICE counts them. The co-manager invitations table
 * (lower-case address, one per tournament and address, gone with the
 * tournament) and the claimed-by index. A second run changes nothing.
 * Made-up accounts only.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { SKIP_PG, createTestDatabase } from './helpers/pgTestDb.js'

const here = dirname(fileURLToPath(import.meta.url))
const DB = join(here, '..', 'db')
const sqlOf = (f) => readFileSync(join(DB, f), 'utf8')
const FILE_055 = sqlOf('055_beach_ownership.sql')
const BEFORE_055 = [
  readFileSync(join(here, 'fixtures', 'synthetic_schema.sql'), 'utf8'),
  ...readdirSync(DB).filter((f) => /^0(0[5-9]|[1-4]\d|5[0-2])_[a-z0-9_]+\.sql$/.test(f)).sort().map(sqlOf),
  sqlOf('current_definitions.sql'),
  'UPDATE public.club_rule SET enabled = false WHERE id;'
].join('\n')
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

describe('db/055 (beach competition owners, co-manager invitations)', { skip: SKIP_PG }, () => {
  let tdb, raw
  const notices = []
  const one = async (sql, args = []) => (await raw.query(sql, args)).rows[0]
  const owner = async (id) => (await one('SELECT created_by FROM public.competitions WHERE id = $1', [id])).created_by

  before(async () => {
    tdb = await createTestDatabase('fix_beach_backend_m055', { schemaSql: BEFORE_055 })
    raw = new pg.Client({ connectionString: tdb.url })
    await raw.connect()
    raw.on('notice', (n) => notices.push(n.message))
  })
  after(async () => {
    await raw?.end()
    await tdb?.drop()
  })

  it('backfills the owner of a beach competition without one, and nothing else; a second run changes nothing', async () => {
    assert.equal((await one("SELECT to_regclass('public.beach_tournament_invites') AS t")).t, null, 'before 055')
    const accounts = [[1, ['beach:competition_manager']], [2, ['beach:competition_manager']], [3, ['beach:scorer']], [4, ['admin']], [5, [' Beach:Competition_Manager ']]]
    for (const [n, roles] of accounts) {
      await raw.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [uid(n), `m055-${n}@example.invalid`])
      await raw.query('INSERT INTO public.profiles (user_id, roles) VALUES ($1, $2::text[])', [uid(n), roles])
    }
    const comp = async (n, sport, createdBy) => {
      await raw.query("INSERT INTO public.competitions (id, name, season, sport, created_by) VALUES ($1, $2, $3, $4, $5)",
        [uid(100 + n), `C${n}`, sport === 'beach' ? '2026' : '2026/27', sport, createdBy])
      return uid(100 + n)
    }
    const audit = (actor, action, competitionId, at) => raw.query(
      "INSERT INTO public.audit_log (actor_id, action, details, at, app) VALUES ($1, $2, jsonb_build_object('competition_id', $3::text), $4, 'beach')",
      [actor, action, competitionId, at])
    const team = (competitionId, createdBy, at) => raw.query(
      'INSERT INTO public.competition_teams (competition_id, name, created_by, created_at) VALUES ($1, $2, $3, $4)',
      [competitionId, `T ${createdBy} ${at}`, createdBy, at])

    const fromAudit = await comp(1, 'beach', null) // edited by 1, then by 2 (latest), then by the scorer and the admin
    await audit(uid(1), 'saved_teams.roster', fromAudit, '2026-05-01T10:00:00Z')
    await audit(uid(2), 'saved_teams.roster', fromAudit, '2026-06-01T10:00:00Z')
    await audit(uid(3), 'saved_teams.roster', fromAudit, '2026-07-01T10:00:00Z')
    await audit(uid(4), 'saved_teams.team_delete', fromAudit, '2026-08-01T10:00:00Z')
    const fromTeams = await comp(2, 'beach', null) // no audit entry; its oldest team by 5 (the role, spelled loosely)
    await team(fromTeams, uid(3), '2026-04-01T10:00:00Z')
    await team(fromTeams, uid(5), '2026-04-02T10:00:00Z')
    await team(fromTeams, uid(1), '2026-04-03T10:00:00Z')
    const none = await comp(3, 'beach', null) // only the admin's entries: stays without an owner
    await audit(uid(4), 'saved_teams.roster', none, '2026-06-01T10:00:00Z')
    const owned = await comp(4, 'beach', uid(1)) // has its owner
    await audit(uid(2), 'saved_teams.roster', owned, '2026-06-01T10:00:00Z')
    const indoor = await comp(5, 'indoor', null) // indoor: untouched
    await audit(uid(1), 'saved_teams.roster', indoor, '2026-06-01T10:00:00Z')
    const other = await comp(6, 'beach', null) // another competition's entries do not count
    await audit(uid(1), 'saved_teams.roster', fromAudit, '2026-04-01T10:00:00Z')

    notices.length = 0
    await raw.query(FILE_055)
    assert.equal(await owner(fromAudit), uid(2), 'the latest entry by a beach competition manager')
    assert.equal(await owner(fromTeams), uid(5), 'the oldest team by a beach competition manager')
    assert.equal(await owner(none), null)
    assert.equal(await owner(owned), uid(1))
    assert.equal(await owner(indoor), null)
    assert.equal(await owner(other), null)
    assert.ok(notices.some((m) => m === 'db/055: 5 beach competition(s); owner from the audit log: 1, from the first team: 1, still without an owner: 2'), notices.join('\n'))

    // the foreign key: SET NULL with the account
    const fk = await one(`SELECT confdeltype FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
                           WHERE c.conrelid = 'public.competitions'::regclass AND c.contype = 'f' AND a.attname = 'created_by'`)
    assert.equal(fk.confdeltype, 'n')

    // a second run: the same rows, the same counts
    notices.length = 0
    await raw.query(FILE_055)
    assert.equal(await owner(fromAudit), uid(2))
    assert.equal(await owner(none), null)
    assert.ok(notices.some((m) => m === 'db/055: 5 beach competition(s); owner from the audit log: 0, from the first team: 0, still without an owner: 2'), notices.join('\n'))
  })

  it('the invitations table: lower-case addresses, one per tournament and address, gone with the tournament', async () => {
    const { rows: [t] } = await raw.query(
      "INSERT INTO public.beach_tournaments (slug, title, starts_on, ends_on, created_by) VALUES ('m055-cup', 'Cup', '2026-07-04', '2026-07-04', $1) RETURNING id", [uid(1)])
    await raw.query('INSERT INTO public.beach_tournament_invites (tournament_id, email, invited_by) VALUES ($1, $2, $3)', [t.id, 'someone@example.invalid', uid(1)])
    await assert.rejects(raw.query('INSERT INTO public.beach_tournament_invites (tournament_id, email) VALUES ($1, $2)', [t.id, 'someone@example.invalid']), /beach_tournament_invites_once/)
    await assert.rejects(raw.query('INSERT INTO public.beach_tournament_invites (tournament_id, email) VALUES ($1, $2)', [t.id, 'Upper@example.invalid']), /beach_tournament_invites_email_check/)
    // the inviter's account goes: the invitation stays, without it
    await raw.query('DELETE FROM public.profiles WHERE user_id = $1', [uid(1)])
    await raw.query('UPDATE public.beach_tournaments SET created_by = NULL WHERE id = $1', [t.id])
    await raw.query('UPDATE public.competitions SET created_by = NULL WHERE created_by = $1', [uid(1)])
    await raw.query('DELETE FROM auth.users WHERE id = $1', [uid(1)])
    assert.equal((await one('SELECT invited_by FROM public.beach_tournament_invites WHERE tournament_id = $1', [t.id])).invited_by, null)
    await raw.query('DELETE FROM public.beach_tournaments WHERE id = $1', [t.id])
    assert.equal((await one('SELECT count(*)::int AS n FROM public.beach_tournament_invites')).n, 0)
    const idx = await one("SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'beach_tmatches_claimed_by_idx'")
    assert.match(idx.indexdef, /\(claimed_by\) WHERE \(claimed_by IS NOT NULL\)/)
  })
})
