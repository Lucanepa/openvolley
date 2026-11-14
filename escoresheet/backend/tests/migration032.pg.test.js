/**
 * db/032_match_id_scoping.sql on a database in the state before it (the
 * synthetic schema with 005 to 031), the way it will meet production: it runs
 * twice, db/015's born-voided trigger then takes the revisions of the event's
 * own match only, and what revisions and rows of another match did before it
 * is undone: voids set or lifted by them, pending revisions filed under a
 * match that does not own the event id, sets and events of a test match that
 * carry another match's ids. Official matches' rows are only counted.
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
const BEFORE_032 = [
  readFileSync(join(here, 'fixtures', 'synthetic_schema.sql'), 'utf8'),
  ...['005_match_ownership.sql', '006_matches_updated_at.sql', '007_scorer_accounts.sql', '008_live_state_tto.sql',
    '009_beach_saved_teams.sql', '010_auth_tokens.sql', '011_account_approvals.sql', '012_app_memberships.sql',
    '013_beach_official_index.sql', '014_beach_tournaments.sql', '015_event_revisions.sql', '016_activity_log.sql',
    '017_match_remarks.sql', '018_clubs.sql', '019_match_scorer_device.sql', '020_club_managers.sql',
    '021_final_mail.sql', '022_passkeys.sql', '023_team_managers.sql', '024_club_licences.sql',
    '025_account_requests.sql', '026_club_licences_manual.sql', '027_account_deactivate.sql',
    '028_notifications.sql', '029_club_manager_links.sql', '030_manager_roles.sql',
    '031_manager_roles_definer.sql'].map(sqlOf)
].join('\n')

// Each id a prefix of the next: the outsider's test matches 'match' and
// 'match_1730000000000' are prefixes of every id of V.
const V = 'match_1730000000000_v1c7aa' // an official match, still running
const C = 'match_1730000000001_c105ed' // an official match, closed meanwhile
const H = 'match_1730000000002_h157aa' // an official match that holds a row under V's id
const T = 'test-match-default-0a1b2c3d4e5f' // a test match with its own data only
const T1 = '2026-11-01T10:00:00.000Z'
const T2 = '2026-11-01T10:01:00.000Z'
const T3 = '2026-11-01T10:02:00.000Z'

describe('db/032 (sets, events and revisions belong to their match by the match row)', { skip: SKIP_PG }, () => {
  let tdb, raw
  const notices = []
  const id = {}
  let vera, mallory

  const user = async (email) => (await raw.query('INSERT INTO auth.users (email) VALUES ($1) RETURNING id', [email])).rows[0].id
  const match = async (ext, { test = false, gameN = null } = {}) =>
    (await raw.query("INSERT INTO public.matches (external_id, status, test, game_n) VALUES ($1, 'live', $2, $3) RETURNING id", [ext, test, gameN])).rows[0].id
  const event = (matchId, ext) =>
    raw.query("INSERT INTO public.events (match_id, external_id, set_index, type, seq) VALUES ($1, $2, 1, 'point', 1)", [matchId, ext])
  const revision = (matchId, eventExt, op, actor, ts) =>
    raw.query(`INSERT INTO public.event_revisions (rev_uid, match_id, event_external_id, op, reason, applied, actor_id, client_ts)
               VALUES (gen_random_uuid(), $1, $2, $3, 'undo', false, $4, $5)`, [matchId, eventExt, op, actor, ts])
  const eventRow = async (ext) =>
    (await raw.query('SELECT match_id, voided_at, voided_by, void_reason FROM public.events WHERE external_id = $1', [ext])).rows[0]
  const count = async (sql, params = []) => (await raw.query(sql, params)).rows[0].n

  before(async () => {
    tdb = await createTestDatabase('mig032', { schemaSql: BEFORE_032 })
    raw = new pg.Client({ connectionString: tdb.url, options: '-c TimeZone=UTC' })
    await raw.connect()
    raw.on('notice', (n) => notices.push(n.message))
    vera = await user('vera@example.invalid') // V's scorer
    mallory = await user('mallory@example.invalid') // an account without a role
    id.V = await match(V, { gameN: 3201 })
    id.C = await match(C, { gameN: 3202 })
    id.H = await match(H, { gameN: 3203 })
    id.T = await match(T, { test: true })
    id.A1 = await match('match', { test: true })
    id.A2 = await match('match_1730000000000', { test: true })

    // V's own undo of point 6 before it was uploaded, and of point 7
    await revision(id.V, `${V}:e:6`, 'void', vera, T1)
    await revision(id.V, `${V}:e:7`, 'void', vera, T1)
    // filed through the outsider's test matches (accepted before 032)
    await revision(id.A1, `${V}:e:5`, 'void', mallory, T2)
    await revision(id.A1, `${V}:e:6`, 'restore', mallory, T3)
    await revision(id.A2, `${V}:e:8`, 'void', mallory, T2)
    await revision(id.A1, `${C}:e:3`, 'void', mallory, T2)
    // V's scorer uploads its points (and C's scorer before the close)
    for (const n of [1, 5, 6, 7]) await event(id.V, `${V}:e:${n}`)
    await event(id.C, `${C}:e:3`)
    await raw.query("UPDATE public.matches SET status = 'approved' WHERE id = $1", [id.C])
    // ids of V taken in the outsider's test match, and in an official match
    await event(id.A1, `${V}:e:20`)
    await raw.query('INSERT INTO public.sets (match_id, external_id, index) VALUES ($1, $2, 2)', [id.A1, `${V}:s:2`])
    await event(id.H, `${V}:e:30`)
    // a test match's own data
    await event(id.T, `${T}:e:1`)
    await revision(id.T, `${T}:e:4`, 'void', vera, T1)
    // ids only the old rule took as their own match's (no app builds them)
    await event(id.V, `${V}_legacy`)
    await raw.query('INSERT INTO public.sets (match_id, external_id, index) VALUES ($1, $2, 1)', [id.T, `${T}_s1`])
  })

  after(async () => {
    await raw?.end()
    await tdb?.drop()
  })

  it('before 032 a revision filed under another match decides the void of the event', async () => {
    const e5 = await eventRow(`${V}:e:5`)
    assert.equal(e5.voided_by, mallory)
    assert.equal(e5.voided_at.toISOString(), T2)
    // V's own undo of point 6 was cancelled by the planted restore
    assert.equal((await eventRow(`${V}:e:6`)).voided_at, null)
    assert.equal((await eventRow(`${C}:e:3`)).voided_by, mallory)
    assert.ok((await raw.query('SELECT closed_at FROM public.matches WHERE id = $1', [id.C])).rows[0].closed_at)
  })

  it('032 runs twice and undoes what the other match did', async () => {
    const m032 = sqlOf('032_match_id_scoping.sql')
    notices.length = 0
    await raw.query(m032)
    const first = [...notices]
    notices.length = 0
    await raw.query(m032)
    const second = [...notices]

    // voids: the event's own match's revisions decide
    const e5 = await eventRow(`${V}:e:5`)
    assert.deepEqual([e5.voided_at, e5.voided_by, e5.void_reason], [null, null, null])
    const e6 = await eventRow(`${V}:e:6`)
    assert.deepEqual([e6.voided_at?.toISOString(), e6.voided_by, e6.void_reason], [T1, vera, 'undo'])
    const e7 = await eventRow(`${V}:e:7`)
    assert.deepEqual([e7.voided_at?.toISOString(), e7.voided_by], [T1, vera], 'its own void is kept')
    assert.equal((await eventRow(`${V}:e:1`)).voided_at, null)
    assert.equal((await eventRow(`${C}:e:3`)).voided_at, null, 'in a closed match too')
    assert.ok((await raw.query('SELECT closed_at FROM public.matches WHERE id = $1', [id.C])).rows[0].closed_at, 'which stays closed')

    // the outsider's pending revisions are gone, the matches' own are kept
    assert.equal(await count('SELECT count(*)::int n FROM public.event_revisions WHERE actor_id = $1', [mallory]), 0)
    assert.deepEqual((await raw.query('SELECT event_external_id FROM public.event_revisions ORDER BY id')).rows.map(r => r.event_external_id),
      [`${V}:e:6`, `${V}:e:7`, `${T}:e:4`])

    // V's ids are free again in the test match; the official match's row is only counted
    assert.equal(await count('SELECT count(*)::int n FROM public.events WHERE match_id = $1', [id.A1]), 0)
    assert.equal(await count('SELECT count(*)::int n FROM public.sets WHERE match_id = $1', [id.A1]), 0)
    assert.equal((await eventRow(`${V}:e:30`)).match_id, id.H)
    assert.equal((await eventRow(`${T}:e:1`)).match_id, id.T)

    // the NOTICEs the deploy reads: what was found and the matches concerned
    // (nothing more on the second run; the official match's row and the old
    // ids are still there, for an admin)
    const said = (list, re) => list.find((m) => re.test(m)) || ''
    const of = (...labels) => ` (matches ${labels.join(', ')})`
    const v = `${V} game 3201`
    const c = `${C} game 3202`
    assert.match(said(first, /of test matches/), /^032: 2 /, first.join('\n'))
    assert.ok(said(first, /of test matches/).endsWith(of(v)), first.join('\n'))
    assert.match(said(first, /of official matches/), /^032: 1 /, first.join('\n'))
    assert.ok(said(first, /of official matches/).endsWith(of(v)), first.join('\n'))
    assert.match(said(first, /void/), /^032: 3 /, first.join('\n'))
    assert.ok(said(first, /void/).endsWith(of(v, c)), first.join('\n'))
    assert.match(said(first, /pending revision/), /^032: 4 /, first.join('\n'))
    assert.ok(said(first, /pending revision/).endsWith(of(v, c)), first.join('\n'))
    assert.match(said(first, /only the old rule/), /^032: 2 /, first.join('\n'))
    assert.ok(said(first, /only the old rule/).endsWith(of(v, T)), first.join('\n'))
    for (const re of [/of test matches/, /void/, /pending revision/]) {
      assert.match(said(second, re), /^032: 0 /, second.join('\n'))
      assert.doesNotMatch(said(second, re), /\(matches/, second.join('\n'))
    }
    assert.match(said(second, /of official matches/), /^032: 1 /, second.join('\n'))
    assert.match(said(second, /only the old rule/), /^032: 2 /, second.join('\n'))
    assert.equal((await eventRow(`${V}_legacy`)).match_id, id.V, 'only counted')
  })

  it('after 032 only the event\'s own match makes it born voided', async () => {
    await revision(id.A1, `${V}:e:10`, 'void', mallory, T2)
    await event(id.V, `${V}:e:10`)
    assert.equal((await eventRow(`${V}:e:10`)).voided_at, null)
    await revision(id.V, `${V}:e:12`, 'void', vera, T1)
    await event(id.V, `${V}:e:12`)
    assert.equal((await eventRow(`${V}:e:12`)).voided_by, vera)
    // a restore deletes and inserts the match's events: the same
    await raw.query('DELETE FROM public.events WHERE match_id = $1', [id.V])
    for (const n of [5, 6, 10, 12]) await event(id.V, `${V}:e:${n}`)
    const voided = (await raw.query('SELECT external_id FROM public.events WHERE match_id = $1 AND voided_at IS NOT NULL ORDER BY external_id', [id.V])).rows
    assert.deepEqual(voided.map(r => r.external_id), [`${V}:e:12`, `${V}:e:6`])
  })

  it('after 032 a match with sets, events or revisions keeps its external_id (OVI01)', async () => {
    const locked = (sql, params) => assert.rejects(() => raw.query(sql, params), (e) => e.code === 'OVI01', sql)
    const rename = "UPDATE public.matches SET external_id = 'z_moved' WHERE id = $1"
    await locked(rename, [id.V]) // events
    await locked(rename, [id.T]) // events, sets and a revision
    await locked("INSERT INTO public.matches (id, external_id, test) VALUES ($1, 'z_moved', true) ON CONFLICT (id) DO UPDATE SET external_id = EXCLUDED.external_id", [id.T])
    const withSet = await match('match_1730000000003_5e7aa0', { test: true })
    await raw.query('INSERT INTO public.sets (match_id, external_id, index) VALUES ($1, $2, 1)', [withSet, 'match_1730000000003_5e7aa0:s:1'])
    await locked(rename, [withSet])
    const withRevision = await match('match_1730000000004_7e7aa0', { test: true })
    await revision(withRevision, 'match_1730000000004_7e7aa0:e:2', 'void', mallory, T1)
    await locked(rename, [withRevision])
    assert.equal((await raw.query('SELECT external_id FROM public.matches WHERE id = $1', [id.V])).rows[0].external_id, V)
    // the same value is no change, and a match without children may move
    await raw.query("UPDATE public.matches SET external_id = external_id, status = 'live' WHERE id = $1", [id.V])
    const bare = await match('match_1730000000005_ba7e00', { test: true })
    await raw.query(rename, [bare])
    assert.equal((await raw.query('SELECT external_id FROM public.matches WHERE id = $1', [bare])).rows[0].external_id, 'z_moved')
  })

  it('a NOTICE names at most 50 matches, then how many more', async () => {
    const held = await match('match_1730000000006_4e1d00', { test: true })
    const named = []
    for (let i = 0; i < 52; i++) {
      const ext = `match_1730000001${String(i).padStart(3, '0')}_k${String(i).padStart(5, '0')}`
      await match(ext, { gameN: 3300 + i })
      await event(held, `${ext}:e:1`)
      named.push(`${ext} game ${3300 + i}`)
    }
    notices.length = 0
    await raw.query(sqlOf('032_match_id_scoping.sql'))
    const line = notices.find((m) => /of test matches/.test(m)) || ''
    assert.match(line, /^032: 52 /, notices.join('\n'))
    assert.ok(line.endsWith(` (matches ${named.slice(0, 50).join(', ')} and 2 more)`), line)
    assert.equal(await count('SELECT count(*)::int n FROM public.events WHERE match_id = $1', [held]), 0)
  })
})
