/**
 * db/017_match_remarks.sql on a database in the state before it (the
 * synthetic schema with 005 to 016), the way it will meet production: it runs
 * twice, adds matches.remarks (text, at most 8000 characters), keeps existing
 * rows, and the app role (roles.sql grants) may read and write the column.
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
const BEFORE_017 = [
  readFileSync(join(here, 'fixtures', 'synthetic_schema.sql'), 'utf8'),
  ...['005_match_ownership.sql', '006_matches_updated_at.sql', '007_scorer_accounts.sql', '008_live_state_tto.sql',
    '009_beach_saved_teams.sql', '010_auth_tokens.sql', '011_account_approvals.sql', '012_app_memberships.sql',
    '013_beach_official_index.sql', '014_beach_tournaments.sql', '015_event_revisions.sql', '016_activity_log.sql'].map(sqlOf)
].join('\n')

describe('db/017 (match remarks)', { skip: SKIP_PG }, () => {
  let tdb, raw, app

  const expectCode = async (client, sql, params, code) => {
    await assert.rejects(() => client.query(sql, params), (err) => {
      assert.equal(err.code, code, err.message)
      return true
    })
  }

  before(async () => {
    tdb = await createTestDatabase('mig017', { schemaSql: BEFORE_017 })
    raw = new pg.Client({ connectionString: tdb.url, options: '-c TimeZone=UTC' })
    await raw.connect()
    await raw.query("INSERT INTO public.matches (external_id, status) VALUES ('m017_old', 'live')")
  })

  after(async () => {
    await app?.end().catch(() => {})
    await raw?.end()
    await tdb?.drop()
  })

  it('before 017 there is no remarks column', async () => {
    await expectCode(raw, "UPDATE public.matches SET remarks = 'x' WHERE external_id = 'm017_old'", [], '42703')
  })

  it('017 runs twice and adds a nullable text column', async () => {
    const m017 = sqlOf('017_match_remarks.sql')
    for (let i = 0; i < 2; i++) await raw.query(m017)
    const { rows: [c] } = await raw.query(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'matches' AND column_name = 'remarks'`)
    assert.equal(c.data_type, 'text')
    assert.equal(c.is_nullable, 'YES')
    assert.equal(c.column_default, null)
    const { rows: [n] } = await raw.query(
      "SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'matches_remarks_length_check'")
    assert.equal(n.n, 1)
    // the existing row is untouched
    const { rows: [m] } = await raw.query("SELECT status, remarks FROM public.matches WHERE external_id = 'm017_old'")
    assert.equal(m.status, 'live')
    assert.equal(m.remarks, null)
  })

  it('remarks hold up to 8000 characters (multi-line, any script), not more', async () => {
    const text = 'Actual start time: 18:05\nTeam A, Set 1, Result 3:2: médical 🏐\n' + 'x'.repeat(100)
    await raw.query("UPDATE public.matches SET remarks = $1 WHERE external_id = 'm017_old'", [text])
    const { rows: [m] } = await raw.query("SELECT remarks FROM public.matches WHERE external_id = 'm017_old'")
    assert.equal(m.remarks, text)
    // 8000 characters, not bytes: 8000 emoji pass
    await raw.query("UPDATE public.matches SET remarks = $1 WHERE external_id = 'm017_old'", ['🏐'.repeat(8000)])
    await expectCode(raw, "UPDATE public.matches SET remarks = $1 WHERE external_id = 'm017_old'", ['x'.repeat(8001)], '23514')
  })

  it('the app role reads and writes remarks', async () => {
    app = new pg.Client({ connectionString: await tdb.createAppRole() })
    await app.connect()
    await app.query("UPDATE public.matches SET remarks = 'from the app' WHERE external_id = 'm017_old'")
    const { rows: [m] } = await app.query("SELECT remarks FROM public.matches WHERE external_id = 'm017_old'")
    assert.equal(m.remarks, 'from the app')
  })

  it('a closed match keeps its remarks (db/007 lock), a resent copy of the same text passes', async () => {
    await raw.query("INSERT INTO public.matches (external_id, status, remarks) VALUES ('m017_closed', 'ended', 'Final remark')")
    await raw.query("UPDATE public.matches SET status = 'approved' WHERE external_id = 'm017_closed'")
    await expectCode(raw, "UPDATE public.matches SET remarks = 'changed' WHERE external_id = 'm017_closed'", [], 'OVC01')
    await raw.query("UPDATE public.matches SET remarks = 'Final remark' WHERE external_id = 'm017_closed'")
  })
})
