/**
 * db/025_account_requests.sql on a database in the state before it (the
 * synthetic schema with 005 to 024): it runs twice, the CHECKs refuse every
 * part that does not fit its kind (a referee with a club, a team of another
 * club), a part is there once, and the rows go with their account, club and
 * team. The app role (roles.sql grants) may use the table.
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
const BEFORE_025 = [
  readFileSync(join(here, 'fixtures', 'synthetic_schema.sql'), 'utf8'),
  ...['005_match_ownership.sql', '006_matches_updated_at.sql', '007_scorer_accounts.sql', '008_live_state_tto.sql',
    '009_beach_saved_teams.sql', '010_auth_tokens.sql', '011_account_approvals.sql', '012_app_memberships.sql',
    '013_beach_official_index.sql', '014_beach_tournaments.sql', '015_event_revisions.sql', '016_activity_log.sql',
    '017_match_remarks.sql', '018_clubs.sql', '019_match_scorer_device.sql', '020_club_managers.sql',
    '021_final_mail.sql', '022_passkeys.sql', '023_team_managers.sql', '024_club_licences.sql'].map(sqlOf)
].join('\n')

describe('db/025 (account requests)', { skip: SKIP_PG }, () => {
  let tdb, raw, app
  const ids = {}
  const insert = (user, kind, club = null, team = null) => raw.query(
    'INSERT INTO public.account_requests (user_id, kind, club_id, team_id) VALUES ($1, $2, $3, $4) RETURNING id', [user, kind, club, team])
  const expectCode = async (promise, code) => {
    await assert.rejects(promise, (err) => {
      assert.equal(err.code, code, err.message)
      return true
    })
  }
  const countOf = async (user) => (await raw.query('SELECT count(*)::int AS n FROM public.account_requests WHERE user_id = $1', [user])).rows[0].n

  before(async () => {
    tdb = await createTestDatabase('mig025', { schemaSql: BEFORE_025 })
    raw = new pg.Client({ connectionString: tdb.url })
    await raw.connect()
    for (const name of ['anna', 'ben', 'carla']) {
      const { rows: [u] } = await raw.query('INSERT INTO auth.users (email) VALUES ($1) RETURNING id', [`${name}@example.ch`])
      ids[name] = u.id
    }
    for (const [key, name, teams] of [['must', 'VBC Musterdorf', ['VBC Musterdorf H1']], ['msh', 'VBC Mustershausen', ['VBC Mustershausen H1']]]) {
      const { rows: [c] } = await raw.query('INSERT INTO public.clubs (name) VALUES ($1) RETURNING id', [name])
      ids[key] = c.id
      for (const t of teams) {
        const { rows: [ct] } = await raw.query('INSERT INTO public.club_teams (club_id, team_name) VALUES ($1, $2) RETURNING id', [c.id, t])
        ids[`${key}H1`] = ct.id
      }
    }
  })

  after(async () => {
    await app?.end().catch(() => {})
    await raw?.end()
    await tdb?.drop()
  })

  it('025 runs twice', async () => {
    const m025 = sqlOf('025_account_requests.sql')
    for (let i = 0; i < 2; i++) await raw.query(m025)
    const { rows } = await raw.query("SELECT conname FROM pg_constraint WHERE conrelid = 'public.account_requests'::regclass ORDER BY conname")
    assert.ok(rows.some((r) => r.conname === 'account_requests_team_club_fkey'))
    assert.ok(rows.some((r) => r.conname === 'account_requests_part_check'))
  })

  it('each kind takes exactly its club and team', async () => {
    await insert(ids.anna, 'referee')
    await insert(ids.anna, 'scorer', ids.must)
    await insert(ids.anna, 'club_manager', ids.must)
    await insert(ids.anna, 'team_manager', ids.must, ids.mustH1)
    await expectCode(insert(ids.ben, 'referee', ids.must), '23514')
    await expectCode(insert(ids.ben, 'scorer'), '23514')
    await expectCode(insert(ids.ben, 'scorer', ids.must, ids.mustH1), '23514')
    await expectCode(insert(ids.ben, 'club_manager'), '23514')
    await expectCode(insert(ids.ben, 'team_manager', null, ids.mustH1), '23514')
    await expectCode(insert(ids.ben, 'team_manager', ids.must), '23514')
    await expectCode(insert(ids.ben, 'competition_manager'), '23514')
    // a team of another club
    await expectCode(insert(ids.ben, 'team_manager', ids.msh, ids.mustH1), '23503')
    // a part is there once (also the referee, without a club)
    await expectCode(insert(ids.anna, 'referee'), '23505')
    await expectCode(insert(ids.anna, 'scorer', ids.must), '23505')
    await insert(ids.anna, 'scorer', ids.msh)
    assert.equal(await countOf(ids.anna), 5)
  })

  it('the rows go with their team, their club and their account', async () => {
    await insert(ids.ben, 'team_manager', ids.msh, ids.mshH1)
    await insert(ids.ben, 'scorer', ids.msh)
    await insert(ids.ben, 'referee')
    await raw.query('DELETE FROM public.club_teams WHERE id = $1', [ids.mshH1])
    assert.equal(await countOf(ids.ben), 2)
    await raw.query('DELETE FROM public.clubs WHERE id = $1', [ids.msh])
    assert.equal(await countOf(ids.ben), 1)
    assert.equal(await countOf(ids.anna), 4)
    await raw.query('DELETE FROM auth.users WHERE id = $1', [ids.ben])
    assert.equal(await countOf(ids.ben), 0)
  })

  it('the app role uses the table', async () => {
    app = new pg.Client({ connectionString: await tdb.createAppRole() })
    await app.connect()
    const { rows: [r] } = await app.query("INSERT INTO public.account_requests (user_id, kind) VALUES ($1, 'referee') RETURNING id", [ids.carla])
    assert.ok(r.id)
    await app.query('DELETE FROM public.account_requests WHERE id = $1', [r.id])
    const { rows: [n] } = await app.query('SELECT count(*)::int AS n FROM public.account_requests WHERE user_id = $1', [ids.carla])
    assert.equal(n.n, 0)
  })
})
