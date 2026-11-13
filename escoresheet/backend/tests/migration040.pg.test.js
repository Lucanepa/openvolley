/**
 * db/040_final_mail.sql on a database in the state before it (the synthetic
 * schema with 005 to 033), with final-mail rows of the backend before it: it
 * runs twice, keeps the rows and their outcomes, marks only the closes an
 * admin had reopened already as told (no old reopen notices at the deploy),
 * takes the new outcomes and still the previous backend's inserts.
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
const BEFORE_040 = [
  readFileSync(join(here, 'fixtures', 'synthetic_schema.sql'), 'utf8'),
  ...['005_match_ownership.sql', '006_matches_updated_at.sql', '007_scorer_accounts.sql', '008_live_state_tto.sql',
    '009_beach_saved_teams.sql', '010_auth_tokens.sql', '011_account_approvals.sql', '012_app_memberships.sql',
    '013_beach_official_index.sql', '014_beach_tournaments.sql', '015_event_revisions.sql', '016_activity_log.sql',
    '017_match_remarks.sql', '018_clubs.sql', '019_match_scorer_device.sql', '020_club_managers.sql',
    '021_final_mail.sql', '022_passkeys.sql', '023_team_managers.sql', '024_club_licences.sql',
    '025_account_requests.sql', '026_club_licences_manual.sql', '027_account_deactivate.sql',
    '028_notifications.sql', '029_club_manager_links.sql', '030_manager_roles.sql',
    '031_manager_roles_definer.sql', '032_match_id_scoping.sql', '033_match_scoresheets.sql', 'current_definitions.sql'].map(sqlOf)
].join('\n')

describe('db/040 (the final mail\'s state per close, released matches)', { skip: SKIP_PG }, () => {
  let tdb, raw
  const id = {}
  const row = async (matchId) => (await raw.query(
    'SELECT outcome, recipients, attempts, next_try_at, delivered, reopen_notice FROM public.match_final_mails WHERE match_id = $1', [matchId])).rows[0]

  before(async () => {
    tdb = await createTestDatabase('mig040', { schemaSql: BEFORE_040 })
    raw = new pg.Client({ connectionString: tdb.url })
    await raw.connect()
    for (const k of ['mailed', 'reopened', 'nopdf']) {
      id[k] = (await raw.query("INSERT INTO public.matches (external_id, status, game_n) VALUES ($1, 'live', $2) RETURNING id", [`match_${k}`, 960000 + Object.keys(id).length])).rows[0].id
    }
    const close = '2026-11-01T18:00:00.000123Z'
    await raw.query("INSERT INTO public.match_final_mails (match_id, closed_at, outcome, recipients) VALUES ($1, $4, 'sent', 5), ($2, $4, 'sent', 3), ($3, $4, 'no_pdf', 0)",
      [id.mailed, id.reopened, id.nopdf, close])
    // an admin reopened one of them after its mail
    await raw.query("INSERT INTO public.audit_log (action, match_id, details, at) VALUES ('match.reopen', $1, '{}', '2026-11-01T19:00:00Z')", [id.reopened])
    await raw.query(sqlOf('040_final_mail.sql'))
    await raw.query(sqlOf('040_final_mail.sql'))
  })
  after(async () => {
    await raw?.end().catch(() => {})
    await tdb?.drop()
  })

  it('keeps the rows; only the close reopened before it counts as told', async () => {
    assert.deepEqual(await row(id.mailed), { outcome: 'sent', recipients: 5, attempts: 0, next_try_at: null, delivered: [], reopen_notice: null })
    assert.equal((await row(id.reopened)).reopen_notice, 'none')
    assert.equal((await row(id.nopdf)).outcome, 'no_pdf')
  })

  it('takes the new outcomes, refuses unknown ones, and the previous backend\'s inserts still work', async () => {
    for (const outcome of ['pending', 'deferred', 'sent_no_pdf', 'partial', 'failed']) {
      await raw.query('UPDATE public.match_final_mails SET outcome = $2 WHERE match_id = $1', [id.mailed, outcome])
    }
    await assert.rejects(raw.query("UPDATE public.match_final_mails SET outcome = 'mailed' WHERE match_id = $1", [id.mailed]), /check constraint/)
    await assert.rejects(raw.query("UPDATE public.match_final_mails SET reopen_notice = 'maybe' WHERE match_id = $1", [id.mailed]), /check constraint/)
    await raw.query("INSERT INTO public.match_final_mails (match_id, closed_at, outcome, recipients, corrected) VALUES ($1, now(), 'sent', 2, true)", [id.nopdf])
  })

  it('adds matches.released_at, empty', async () => {
    const { rows } = await raw.query('SELECT count(*)::int AS n, count(released_at)::int AS released FROM public.matches')
    assert.deepEqual(rows[0], { n: 3, released: 0 })
  })
})
