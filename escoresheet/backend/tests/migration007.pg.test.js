/**
 * db/007_scorer_accounts.sql on a database that already has data, the way it
 * will meet production: existing roles, approved/final matches and duplicate
 * official games. Then every guard case as a role with DML only and no
 * function EXECUTE (like ov_app after roles.sql).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { SKIP_PG, SCHEMA_SQL_005_ONLY, createTestDatabase } from './helpers/pgTestDb.js'

const here = dirname(fileURLToPath(import.meta.url))
const sqlOf = (f) => readFileSync(join(here, '..', 'db', f), 'utf8')
const M006 = sqlOf('006_matches_updated_at.sql')
const M007 = sqlOf('007_scorer_accounts.sql')
const OLD = '2025-11-01T10:00:00.000Z'

describe('db/007_scorer_accounts.sql', { skip: SKIP_PG }, () => {
  let tdb, raw, app
  const u = {}
  const m = {}
  const notices = []

  async function insertMatch (key, row) {
    const cols = Object.keys(row)
    const { rows: [r] } = await raw.query(
      `INSERT INTO public.matches (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      cols.map((c) => (row[c] !== null && typeof row[c] === 'object' ? JSON.stringify(row[c]) : row[c])))
    m[key] = r.id
    return r.id
  }
  const matchRow = async (id) => (await raw.query('SELECT * FROM public.matches WHERE id = $1', [id])).rows[0]

  before(async () => {
    // The production state before 007: 005 and 006 only, with data
    tdb = await createTestDatabase('mig007', { schemaSql: SCHEMA_SQL_005_ONLY + '\n' + M006 })
    raw = new pg.Client({ connectionString: tdb.url, options: '-c TimeZone=UTC' })
    await raw.connect()
    raw.on('notice', (n) => notices.push(n.message))
    for (const [name, roles] of [['admin', ['admin']], ['scorer', ['scorer']], ['odd', ['Scorer', 'visitor']], ['none', null]]) {
      const id = randomUUID()
      await raw.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `${name}@example.ch`])
      if (roles) await raw.query('INSERT INTO public.profiles (user_id, roles) VALUES ($1, $2)', [id, roles])
      else await raw.query('INSERT INTO public.profiles (user_id) VALUES ($1)', [id]) // the old default: {scorer}
      u[name] = id
    }
    // three non-test matches for game 500 in season 2026 (one rescheduled), plus a test match and another season
    await insertMatch('dupFirst', { external_id: 'dup_first', game_n: 500, status: 'final', scheduled_at: '2026-10-10T16:00:00Z', created_at: '2026-10-01T08:00:00Z', updated_at: OLD, created_by: u.scorer })
    await insertMatch('dupSecond', { external_id: 'dup_second', game_n: 500, status: 'live', scheduled_at: '2026-10-11T16:00:00Z', created_at: '2026-10-02T08:00:00Z', updated_at: OLD })
    await insertMatch('dupThird', { external_id: 'dup_third', game_n: 500, status: 'setup', scheduled_at: '2027-02-01T16:00:00Z', created_at: '2026-10-03T08:00:00Z', updated_at: OLD })
    await insertMatch('dupTest', { external_id: 'dup_test', game_n: 500, test: true, status: 'final', scheduled_at: '2026-10-10T16:00:00Z', created_at: '2026-10-04T08:00:00Z', updated_at: OLD })
    await insertMatch('lastSeason', { external_id: 'last_season', game_n: 500, status: 'approved', scheduled_at: '2025-10-10T16:00:00Z', created_at: '2025-10-01T08:00:00Z', updated_at: OLD, created_by: u.admin })
    await insertMatch('beach', { external_id: 'beach_500', game_n: 500, sport_type: 'beach', status: 'live', scheduled_at: '2026-10-10T16:00:00Z', updated_at: OLD })
    await insertMatch('friendly', { external_id: 'friendly', game_n: null, status: 'final', updated_at: OLD })
    await insertMatch('approvedNoUpdated', { external_id: 'approved_null', game_n: 777, status: 'approved', created_at: '2026-09-01T08:00:00Z', updated_at: null })
    await raw.query("INSERT INTO public.sets (external_id, match_id, index) VALUES ('dup_first:s:1', $1, 1)", [m.dupFirst])
  })

  after(async () => {
    await app?.end().catch(() => {})
    await raw?.end()
    await tdb?.drop()
  })

  it('runs twice, reports and exempts the later duplicates, keeps roles and updated_at', async () => {
    const rolesBefore = (await raw.query('SELECT user_id, roles FROM public.profiles ORDER BY user_id')).rows
    const stampsBefore = (await raw.query('SELECT id, updated_at FROM public.matches ORDER BY id')).rows

    await raw.query(M007)
    const dupNotices = notices.filter((n) => n.includes('duplicate official game'))
    assert.equal(dupNotices.length, 2, notices.join('\n'))
    assert.ok(dupNotices.some((n) => n.includes('dup_second')))
    assert.ok(dupNotices.some((n) => n.includes('dup_third')))
    assert.ok(notices.some((n) => /2 duplicate official-game match\(es\) exempted/.test(n)))

    notices.length = 0
    await raw.query(M007)
    assert.equal(notices.filter((n) => n.includes('duplicate official game')).length, 0, 'nothing new on a re-run')

    const exempt = (await raw.query('SELECT external_id FROM public.matches WHERE official_game_exempt ORDER BY external_id')).rows.map((r) => r.external_id)
    assert.deepEqual(exempt, ['dup_second', 'dup_third'], 'the first created keeps the claim')
    assert.deepEqual((await raw.query('SELECT user_id, roles FROM public.profiles ORDER BY user_id')).rows, rolesBefore, 'roles untouched')
    assert.deepEqual((await raw.query('SELECT id, updated_at FROM public.matches ORDER BY id')).rows, stampsBefore, 'updated_at untouched')
    const { rows: [def] } = await raw.query("SELECT column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'roles'")
    assert.match(def.column_default, /'\{\}'::text\[\]/)
    assert.ok((await raw.query("SELECT 1 FROM pg_indexes WHERE indexname = 'matches_official_game_uidx'")).rows.length)
  })

  it('closes the existing non-test approved/final matches only', async () => {
    const first = await matchRow(m.dupFirst)
    assert.equal(first.closed_at.toISOString(), OLD)
    assert.equal(first.closed_by, u.scorer)
    assert.equal((await matchRow(m.lastSeason)).closed_by, u.admin)
    assert.ok((await matchRow(m.friendly)).closed_at, 'a friendly too')
    assert.equal((await matchRow(m.approvedNoUpdated)).closed_at.toISOString(), '2026-09-01T08:00:00.000Z')
    assert.equal((await matchRow(m.dupTest)).closed_at, null, 'test match')
    assert.equal((await matchRow(m.dupSecond)).closed_at, null, 'live match')
    // the backfill writes no audit entries
    assert.equal((await raw.query('SELECT count(*)::int n FROM public.audit_log')).rows[0].n, 0)
  })

  describe('guards, as a role without function EXECUTE', () => {
    const q = (sql, params) => app.query(sql, params)
    const expectState = async (sql, params, code) => {
      await assert.rejects(() => q(sql, params), (err) => {
        assert.equal(err.code, code, err.message)
        return true
      })
    }

    before(async () => {
      const appUrl = await tdb.createAppRole()
      // roles.sql: no function EXECUTE for the app role
      await raw.query('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC')
      app = new pg.Client({ connectionString: appUrl, options: '-c TimeZone=UTC' })
      await app.connect()
      const { rows: [r] } = await app.query("SELECT has_function_privilege('public.ov_matches_guard()', 'EXECUTE') AS can")
      assert.equal(r.can, false)
    })

    it('inserts and updates; the index takes one match per game and season, beach apart', async () => {
      const ins = (ext, gameN, at, extra = '') => q(`INSERT INTO public.matches (external_id, game_n, scheduled_at${extra ? ', sport_type' : ''}) VALUES ($1, $2, $3${extra ? `, '${extra}'` : ''}) RETURNING id`, [ext, gameN, at])
      const { rows: [a] } = await ins('g900_a', 900, '2026-10-10T16:00:00Z')
      await q("UPDATE public.matches SET status = 'live' WHERE id = $1", [a.id])
      await expectState("INSERT INTO public.matches (external_id, game_n, scheduled_at) VALUES ('g900_b', 900, '2027-03-01T16:00:00Z')", [], '23505')
      await ins('g900_next', 900, '2027-08-01T16:00:00Z')
      await ins('g900_beach', 900, '2026-10-10T16:00:00Z', 'beach')
      await q("INSERT INTO public.matches (external_id, game_n, test) VALUES ('g900_test', 900, true)")
      await q("INSERT INTO public.matches (external_id, game_n, official_game_exempt, scheduled_at) VALUES ('g900_exempt', 900, true, '2026-10-10T16:00:00Z')")
      // the existing claim of game 500 (season 2026) holds, the exempted ones do not count
      await expectState("INSERT INTO public.matches (external_id, game_n, scheduled_at) VALUES ('g500_new', 500, '2026-12-01T16:00:00Z')", [], '23505')
    })

    it('a closing write stamps closed_at and closed_by from ov.user_id, once, with one audit row per close', async () => {
      await q('BEGIN')
      await q("SELECT set_config('ov.user_id', $1, true)", [u.scorer])
      // the client sends closed_* itself: ignored on insert
      const { rows: [r] } = await q(`INSERT INTO public.matches (external_id, game_n, status, closed_at, closed_by)
        VALUES ('close_ins', 901, 'live', '2001-01-01T00:00:00Z', $1) RETURNING closed_at, closed_by`, [u.admin])
      await q('COMMIT')
      assert.deepEqual(r, { closed_at: null, closed_by: null })

      // an upsert that closes: exactly one match.close row
      await q('BEGIN')
      await q("SELECT set_config('ov.user_id', $1, true)", [u.scorer])
      await q(`INSERT INTO public.matches (external_id, game_n, status) VALUES ('close_ins', 901, 'approved')
        ON CONFLICT (external_id) DO UPDATE SET status = EXCLUDED.status`)
      await q('COMMIT')
      const { rows: [c] } = await q("SELECT id, closed_at, closed_by FROM public.matches WHERE external_id = 'close_ins'")
      assert.ok(c.closed_at)
      assert.equal(c.closed_by, u.scorer)
      const audits = (await raw.query("SELECT actor_id, details FROM public.audit_log WHERE action = 'match.close' AND match_id = $1", [c.id])).rows
      assert.equal(audits.length, 1)
      assert.equal(audits[0].actor_id, u.scorer)
      assert.equal(audits[0].details.status, 'approved')
      m.closeIns = c.id

      // an insert that is already final closes at once (no actor: closed_by NULL)
      const { rows: [f] } = await q("INSERT INTO public.matches (external_id, game_n, status) VALUES ('close_final', 902, 'final') RETURNING id, closed_at, closed_by")
      assert.ok(f.closed_at)
      assert.equal(f.closed_by, null)
      // a test match never closes
      const { rows: [t] } = await q("INSERT INTO public.matches (external_id, test, status) VALUES ('close_test', true, 'final') RETURNING closed_at")
      assert.equal(t.closed_at, null)
    })

    it('a closed match refuses changes, child writes and deletes; allows approved -> final, no-op rewrites', async () => {
      const id = m.closeIns
      await expectState("UPDATE public.matches SET status = 'live' WHERE id = $1", [id], 'OVC01')
      await expectState("UPDATE public.matches SET home_team = '{\"name\":\"X\"}' WHERE id = $1", [id], 'OVC01')
      await expectState('UPDATE public.matches SET closed_at = NULL WHERE id = $1', [id], 'OVC01')
      await expectState('UPDATE public.matches SET official_game_exempt = true WHERE id = $1', [id], 'OVC01')
      await expectState('UPDATE public.matches SET created_by = $2 WHERE id = $1', [id, u.admin], 'OVC01')
      await expectState('DELETE FROM public.matches WHERE id = $1', [id], 'OVC01')
      await expectState("INSERT INTO public.sets (external_id, match_id, index) VALUES ('close_ins:s:1', $1, 1)", [id], 'OVC01')
      await expectState("INSERT INTO public.events (external_id, match_id, set_index, type, seq) VALUES ('close_ins:e:1', $1, 1, 'point', 1)", [id], 'OVC01')
      // a set of the backfilled closed match: no update, no delete, no move
      await expectState('UPDATE public.sets SET home_points = 3 WHERE match_id = $1', [m.dupFirst], 'OVC01')
      await expectState('DELETE FROM public.sets WHERE match_id = $1', [m.dupFirst], 'OVC01')
      const { rows: [open] } = await q("INSERT INTO public.matches (external_id, game_n, status) VALUES ('open_one', 903, 'live') RETURNING id")
      await q("INSERT INTO public.sets (external_id, match_id, index) VALUES ('open_one:s:1', $1, 1)", [open.id])
      await expectState('UPDATE public.sets SET match_id = $1 WHERE match_id = $2', [id, open.id], 'OVC01')

      const before = (await raw.query('SELECT closed_at, closed_by FROM public.matches WHERE id = $1', [id])).rows[0]
      await q("UPDATE public.matches SET status = 'approved' WHERE id = $1", [id]) // no-op rewrite (a resent job)
      await q("UPDATE public.matches SET status = 'final' WHERE id = $1", [id])
      await expectState("UPDATE public.matches SET status = 'approved' WHERE id = $1", [id], 'OVC01')
      const after = (await raw.query('SELECT closed_at, closed_by, status FROM public.matches WHERE id = $1', [id])).rows[0]
      assert.deepEqual({ closed_at: after.closed_at, closed_by: after.closed_by }, before, 'the stamp stays')
      assert.equal(after.status, 'final')
      // the stored live score is frozen too (review: livescore showed a closed match as live)
      await expectState('INSERT INTO public.match_live_state (match_id, points_a) VALUES ($1, 1)', [id], 'OVC01')
      await raw.query("SELECT set_config('ov.allow_closed', 'on', false)")
      await raw.query('INSERT INTO public.match_live_state (match_id, points_a) VALUES ($1, 1)', [id])
      await raw.query("SELECT set_config('ov.allow_closed', '', false)")
      await expectState('UPDATE public.match_live_state SET points_a = 99 WHERE match_id = $1', [id], 'OVC01')
      await expectState('DELETE FROM public.match_live_state WHERE match_id = $1', [id], 'OVC01')
      // moving an open match's live state onto the closed match
      await q('INSERT INTO public.match_live_state (match_id, points_a) VALUES ($1, 1)', [open.id])
      await expectState('UPDATE public.match_live_state SET match_id = $1 WHERE match_id = $2', [id, open.id], 'OVC01')
    })

    it('an exemption holds for its key only: moving an exempt match onto a claimed game hits the index', async () => {
      const { rows: [a] } = await q("INSERT INTO public.matches (external_id, game_n, scheduled_at) VALUES ('ex_a', 74004, '2026-10-10T16:00:00Z') RETURNING id")
      const { rows: [b] } = await q("INSERT INTO public.matches (external_id, game_n, scheduled_at) VALUES ('ex_b', 74005, '2026-10-11T16:00:00Z') RETURNING id")
      assert.ok(a.id)
      await raw.query('UPDATE public.matches SET official_game_exempt = true WHERE id = $1', [b.id])
      // same key: the exemption stays (a time correction, a status change)
      await q("UPDATE public.matches SET scheduled_at = '2026-10-11T18:00:00Z', status = 'live' WHERE id = $1", [b.id])
      assert.equal((await raw.query('SELECT official_game_exempt FROM public.matches WHERE id = $1', [b.id])).rows[0].official_game_exempt, true)
      // onto game 74004 of the same season: the exemption ends, the index refuses
      await expectState('UPDATE public.matches SET game_n = 74004 WHERE id = $1', [b.id], '23505')
      // onto a free game: allowed, and no longer exempt
      await q('UPDATE public.matches SET game_n = 74006 WHERE id = $1', [b.id])
      assert.equal((await raw.query('SELECT official_game_exempt FROM public.matches WHERE id = $1', [b.id])).rows[0].official_game_exempt, false)
      // another season by date: the key changes too
      await raw.query('UPDATE public.matches SET official_game_exempt = true WHERE id = $1', [b.id])
      await q("UPDATE public.matches SET scheduled_at = '2027-10-11T16:00:00Z' WHERE id = $1", [b.id])
      assert.equal((await raw.query('SELECT official_game_exempt FROM public.matches WHERE id = $1', [b.id])).rows[0].official_game_exempt, false)
      // ov.allow_closed (the admin endpoints) keeps what they set
      await q('BEGIN')
      await q("SELECT set_config('ov.allow_closed', 'on', true)")
      await q('UPDATE public.matches SET official_game_exempt = true, game_n = 74004, scheduled_at = $2 WHERE id = $1', [b.id, '2026-10-10T16:00:00Z'])
      await q('COMMIT')
      assert.equal((await raw.query('SELECT official_game_exempt FROM public.matches WHERE id = $1', [b.id])).rows[0].official_game_exempt, true)
    })

    it('ov.allow_closed lifts the lock (admin reopen), and closing again stamps again', async () => {
      const id = m.closeIns
      await q('BEGIN')
      await q("SELECT set_config('ov.allow_closed', 'on', true)")
      await q("UPDATE public.matches SET status = 'ended', closed_at = NULL, closed_by = NULL WHERE id = $1", [id])
      await q('COMMIT')
      assert.equal((await raw.query('SELECT closed_at FROM public.matches WHERE id = $1', [id])).rows[0].closed_at, null)
      await q("INSERT INTO public.sets (external_id, match_id, index) VALUES ('close_ins:s:1', $1, 1)", [id])
      await q('BEGIN')
      await q("SELECT set_config('ov.user_id', $1, true)", [u.admin])
      await q("UPDATE public.matches SET status = 'approved' WHERE id = $1", [id])
      await q('COMMIT')
      const r = (await raw.query('SELECT closed_at, closed_by FROM public.matches WHERE id = $1', [id])).rows[0]
      assert.ok(r.closed_at)
      assert.equal(r.closed_by, u.admin)
      assert.equal((await raw.query("SELECT count(*)::int n FROM public.audit_log WHERE action = 'match.close' AND match_id = $1", [id])).rows[0].n, 2)
    })

    it('deleting an account clears created_by / closed_by of its closed matches', async () => {
      await raw.query('DELETE FROM auth.users WHERE id = $1', [u.scorer])
      const r = await matchRow(m.dupFirst)
      assert.equal(r.created_by, null)
      assert.equal(r.closed_by, null)
      assert.ok(r.closed_at, 'still closed')
    })

    it('the app role may write the new tables', async () => {
      await q("INSERT INTO public.audit_log (action, details) VALUES ('invite.create', '{}')")
      const { rows: [c] } = await q("INSERT INTO public.competitions (name, season) VALUES ('Liga', '2026/27') RETURNING id")
      await expectState("INSERT INTO public.competitions (name, season) VALUES ('Liga', '2026-27')", [], '23514')
      const { rows: [t] } = await q("INSERT INTO public.competition_teams (competition_id, name) VALUES ($1, 'Team') RETURNING id", [c.id])
      await expectState("INSERT INTO public.competition_teams (competition_id, name) VALUES ($1, 'TEAM')", [c.id], '23505')
      await q("INSERT INTO public.competition_players (team_id, number, last_name) VALUES ($1, 7, 'Muster')", [t.id])
      await q("INSERT INTO public.competition_staff (team_id, role, last_name) VALUES ($1, 'Coach', 'Trainer')", [t.id])
      await expectState("INSERT INTO public.competition_staff (team_id, role, last_name) VALUES ($1, 'Mascot', 'X')", [t.id], '23514')
    })
  })
})
