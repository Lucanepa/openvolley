/**
 * db/026_club_licences_manual.sql on a database in the state before it (the
 * synthetic schema with 005 to 025): before it, lib/licences.js reads every
 * row as imported and answers 503 to a hand-added batch; it runs twice, the
 * rows of before become 'import', the CHECK takes 'import' and 'manual' only,
 * and the app role (roles.sql grants) writes the column.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { SKIP_PG, createTestDatabase, quietLogger } from './helpers/pgTestDb.js'
import { createLicences } from '../lib/licences.js'

const here = dirname(fileURLToPath(import.meta.url))
const sqlOf = (f) => readFileSync(join(here, '..', 'db', f), 'utf8')
const BEFORE_026 = [
  readFileSync(join(here, 'fixtures', 'synthetic_schema.sql'), 'utf8'),
  ...['005_match_ownership.sql', '006_matches_updated_at.sql', '007_scorer_accounts.sql', '008_live_state_tto.sql',
    '009_beach_saved_teams.sql', '010_auth_tokens.sql', '011_account_approvals.sql', '012_app_memberships.sql',
    '013_beach_official_index.sql', '014_beach_tournaments.sql', '015_event_revisions.sql', '016_activity_log.sql',
    '017_match_remarks.sql', '018_clubs.sql', '019_match_scorer_device.sql', '020_club_managers.sql',
    '021_final_mail.sql', '022_passkeys.sql', '023_team_managers.sql', '024_club_licences.sql',
    '025_account_requests.sql'].map(sqlOf)
].join('\n')

describe('db/026 (club licences added by hand)', { skip: SKIP_PG }, () => {
  let tdb, raw, app, pool, club, team
  const insert = (db, sv, source) => db.query(
    `INSERT INTO public.club_licences (club_id, list, sv_number, last_name${source ? ', source' : ''})
     VALUES ($1, 'players', $2, 'Beispiel'${source ? ', $3' : ''})`, source ? [club, sv, source] : [club, sv])
  const sourceOf = async (sv) => (await raw.query('SELECT source FROM public.club_licences WHERE club_id = $1 AND sv_number = $2', [club, sv])).rows[0]?.source

  before(async () => {
    tdb = await createTestDatabase('mig026', { schemaSql: BEFORE_026 })
    raw = new pg.Client({ connectionString: tdb.url })
    await raw.connect()
    const { rows: [c] } = await raw.query("INSERT INTO public.clubs (name) VALUES ('VBC Musterdorf') RETURNING id")
    club = c.id
    const { rows: [t] } = await raw.query("INSERT INTO public.club_teams (club_id, team_name) VALUES ($1, 'VBC Musterdorf H1') RETURNING id", [club])
    team = t.id
    // a row of an upload of before 026
    await insert(raw, '100001')
    pool = new pg.Pool({ connectionString: tdb.url })
  })

  after(async () => {
    await pool?.end().catch(() => {})
    await app?.end().catch(() => {})
    await raw?.end()
    await tdb?.drop()
  })

  it('before 026: the reads take every row as imported, a hand-added batch answers 503', async () => {
    const logger = quietLogger()
    const lic = createLicences({ pool, audit: async () => {}, logger })
    const r = await lic.teamClubPlayers({ teamId: team })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body.data.players.map((p) => [p.sv_number, p.manual]), [['100001', false]])
    assert.deepEqual(r.body.data.people.map((p) => [p.sv_number, p.manual, p.lists]), [['100001', false, ['players']]])
    const c = await lic.clubList({ clubId: club })
    assert.equal(c.status, 200, JSON.stringify(c.body))
    assert.equal(c.body.data.lists.players.count, 1)
    assert.equal(c.body.data.lists.players.manual, 0)
    assert.ok(c.body.data.lists.players.imported_at)
    const add = await lic.addPeople({ teamId: team, body: { people: [{ list: 'players', sv_number: '100009', last_name: 'Handmann' }] } })
    assert.equal(add.status, 503)
    const { rows: [n] } = await raw.query('SELECT count(*)::int AS n FROM public.club_licences WHERE club_id = $1', [club])
    assert.equal(n.n, 1)
    assert.ok(logger.lines.some((l) => l.includes('add-people failed: 42703')))
  })

  it('026 runs twice; the rows of before are imports', async () => {
    const m026 = sqlOf('026_club_licences_manual.sql')
    for (let i = 0; i < 2; i++) await raw.query(m026)
    const { rows: cons } = await raw.query("SELECT conname FROM pg_constraint WHERE conrelid = 'public.club_licences'::regclass AND conname = 'club_licences_source_check'")
    assert.equal(cons.length, 1)
    const { rows: [col] } = await raw.query(
      `SELECT is_nullable, column_default, col_description('public.club_licences'::regclass, ordinal_position) AS comment
         FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'club_licences' AND column_name = 'source'`)
    assert.equal(col.is_nullable, 'NO')
    assert.match(col.column_default, /'import'/)
    assert.match(col.comment, /db\/026/)
    assert.equal(await sourceOf('100001'), 'import')
  })

  it('source is import (the default) or manual, never anything else', async () => {
    await insert(raw, '100002')
    await insert(raw, '100003', 'manual')
    assert.equal(await sourceOf('100002'), 'import')
    assert.equal(await sourceOf('100003'), 'manual')
    await assert.rejects(insert(raw, '100004', 'vm'), (err) => err.code === '23514')
    await assert.rejects(raw.query("INSERT INTO public.club_licences (club_id, list, sv_number, last_name, source) VALUES ($1, 'players', '100005', 'Beispiel', NULL)", [club]),
      (err) => err.code === '23502')
  })

  it('the app role writes the column', async () => {
    app = new pg.Client({ connectionString: await tdb.createAppRole() })
    await app.connect()
    await insert(app, '100006', 'manual')
    await app.query("UPDATE public.club_licences SET source = 'import' WHERE club_id = $1 AND sv_number = '100006'", [club])
    assert.equal(await sourceOf('100006'), 'import')
    await app.query("DELETE FROM public.club_licences WHERE club_id = $1 AND sv_number = '100006'", [club])
    assert.equal(await sourceOf('100006'), undefined)
  })
})
