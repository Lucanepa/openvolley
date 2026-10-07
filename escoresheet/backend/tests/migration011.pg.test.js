/**
 * db/011_account_approvals.sql on a database at 010 (the production state
 * before it): runs twice; tables, indexes, triggers and CHECKs; the app role
 * (table-level DML, like ov_app after roles.sql); the closed-match lock; the
 * append-only rule; voiding on reopen; account deletion
 * (docs/account-approval-spec.md 1.6).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { SKIP_PG, SCHEMA_SQL_005_ONLY, createTestDatabase } from './helpers/pgTestDb.js'

const here = dirname(fileURLToPath(import.meta.url))
const sqlOf = (f) => readFileSync(join(here, '..', 'db', f), 'utf8')
const M011 = sqlOf('011_account_approvals.sql')

describe('db/011_account_approvals.sql', { skip: SKIP_PG }, () => {
  let tdb, raw, app
  const ids = {}
  let extSeq = 0

  const expectCode = async (client, sql, params, code) => {
    await assert.rejects(() => client.query(sql, params), (err) => {
      assert.equal(err.code, code, err.message)
      return true
    })
  }
  const newUser = async (name) => {
    const { rows: [u] } = await raw.query('INSERT INTO auth.users (email) VALUES ($1) RETURNING id', [`${name}-${randomBytes(3).toString('hex')}@example.ch`])
    return u.id
  }
  const newMatch = async (status = 'ended', extra = {}) => {
    const { rows: [m] } = await raw.query(
      'INSERT INTO public.matches (external_id, status, created_by, test, game_n) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [`m011_${++extSeq}`, status, ids.owner, extra.test ?? false, extra.game_n ?? null])
    return m.id
  }
  const approval = (client, matchId, slot, userId, extra = '') => client.query(
    `INSERT INTO public.match_approvals (match_id, slot, user_id, display_name, match_status, result_key, result_hash${extra ? ', ' + extra.split('=')[0] : ''})
     VALUES ($1, $2, $3, 'Muster Anna', 'ended', 'ov-result-v1|1:25:20', decode(repeat('ab', 32), 'hex')${extra ? ', ' + extra.split('=')[1] : ''}) RETURNING id`,
    [matchId, slot, userId])
  const activeOf = async (matchId) => (await raw.query('SELECT slot, revoked_reason FROM public.match_approvals WHERE match_id = $1 AND revoked_at IS NULL ORDER BY slot', [matchId])).rows
  const voidAudits = async (matchId) => (await raw.query("SELECT actor_id, details FROM public.audit_log WHERE action = 'match.approval_void' AND match_id = $1", [matchId])).rows

  before(async () => {
    tdb = await createTestDatabase('mig011', {
      schemaSql: [SCHEMA_SQL_005_ONLY, ...['006_matches_updated_at.sql', '007_scorer_accounts.sql', '008_live_state_tto.sql', '009_beach_saved_teams.sql', '010_auth_tokens.sql'].map(sqlOf)].join('\n')
    })
    raw = new pg.Client({ connectionString: tdb.url, options: '-c TimeZone=UTC' })
    await raw.connect()
    ids.owner = await newUser('owner')
    ids.ref = await newUser('ref')
    ids.ref2 = await newUser('ref2')
  })

  after(async () => {
    await app?.end()
    await raw?.end()
    await tdb?.drop()
  })

  it('runs twice and creates the tables, indexes, triggers and CHECKs', async () => {
    await raw.query(M011)
    await raw.query(M011)
    const { rows: tables } = await raw.query("SELECT to_regclass('auth.approval_pins') IS NOT NULL AS pins, to_regclass('public.match_approvals') IS NOT NULL AS approvals")
    assert.deepEqual(tables[0], { pins: true, approvals: true })
    const { rows: idx } = await raw.query("SELECT indexname FROM pg_indexes WHERE tablename = 'match_approvals' ORDER BY indexname")
    assert.deepEqual(idx.map((r) => r.indexname), ['match_approvals_match_idx', 'match_approvals_pkey', 'match_approvals_slot_uidx', 'match_approvals_user_idx', 'match_approvals_user_uidx'])
    const { rows: trg } = await raw.query(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal
      AND tgrelid IN ('public.match_approvals'::regclass, 'public.matches'::regclass) ORDER BY tgname`)
    for (const t of ['match_approvals_closed_guard', 'match_approvals_closed_guard_update', 'match_approvals_immutable', 'matches_void_approvals']) {
      assert.ok(trg.some((r) => r.tgname === t), t)
    }
    const { rows: [n] } = await raw.query("SELECT count(*)::int n FROM pg_trigger WHERE tgname = 'matches_void_approvals'")
    assert.equal(n.n, 1, 'not duplicated by the re-run')

    const m = await newMatch()
    await expectCode(raw, "INSERT INTO public.match_approvals (match_id, slot, display_name, match_status, result_key, result_hash) VALUES ($1, 'assistant', 'A', 'ended', 'k', decode(repeat('ab', 32), 'hex'))", [m], '23514')
    await expectCode(raw, "INSERT INTO public.match_approvals (match_id, slot, display_name, match_status, result_key, result_hash) VALUES ($1, 'scorer', '', 'ended', 'k', decode(repeat('ab', 32), 'hex'))", [m], '23514')
    await expectCode(raw, "INSERT INTO public.match_approvals (match_id, slot, display_name, match_status, result_key, result_hash) VALUES ($1, 'scorer', 'A', 'ended', 'k', decode('ab', 'hex'))", [m], '23514')
    await expectCode(raw, "INSERT INTO public.match_approvals (match_id, slot, display_name, match_status, result_key, result_hash, revoked_at) VALUES ($1, 'scorer', 'A', 'ended', 'k', decode(repeat('ab', 32), 'hex'), now())", [m], '23514')
    await expectCode(raw, "INSERT INTO auth.approval_pins (user_id, salt, mac) VALUES ($1, decode('00', 'hex'), decode(repeat('ab', 32), 'hex'))", [ids.ref], '23514')
    await expectCode(raw, "INSERT INTO auth.approval_pins (user_id, key_id, salt, mac) VALUES ($1, 0, decode(repeat('00', 16), 'hex'), decode(repeat('ab', 32), 'hex'))", [ids.ref], '23514')
  })

  it('the app role reads and writes both tables, and cannot TRUNCATE', async () => {
    const appUrl = await tdb.createAppRole()
    const role = new URL(appUrl).username
    // ov_app's auth grants (roles.sql / 011): USAGE on auth, DML on approval_pins
    await raw.query(`GRANT USAGE ON SCHEMA auth TO "${role}"; GRANT SELECT, INSERT, UPDATE, DELETE ON auth.approval_pins TO "${role}"`)
    app = new pg.Client({ connectionString: appUrl })
    await app.connect()
    const m = await newMatch()
    const { rows: [a] } = await approval(app, m, 'referee1', ids.ref)
    assert.equal((await app.query('SELECT count(*)::int n FROM public.match_approvals WHERE id = $1', [a.id])).rows[0].n, 1)
    await app.query("UPDATE public.match_approvals SET revoked_at = now(), revoked_reason = 'undo', revoked_by = $2 WHERE id = $1", [a.id, ids.owner])
    await app.query("INSERT INTO auth.approval_pins (user_id, salt, mac) VALUES ($1, decode(repeat('00', 16), 'hex'), decode(repeat('ab', 32), 'hex'))", [ids.ref2])
    await app.query('UPDATE auth.approval_pins SET failed_attempts = failed_attempts + 1 WHERE user_id = $1', [ids.ref2])
    await app.query('DELETE FROM auth.approval_pins WHERE user_id = $1', [ids.ref2])
    await expectCode(app, 'TRUNCATE public.match_approvals', [], '42501')
    await expectCode(app, 'TRUNCATE auth.approval_pins', [], '42501')
  })

  it('one active approval per slot and per account', async () => {
    const m = await newMatch()
    await approval(raw, m, 'referee1', ids.ref)
    await expectCode(raw, "INSERT INTO public.match_approvals (match_id, slot, user_id, display_name, match_status, result_key, result_hash) VALUES ($1, 'referee1', $2, 'B', 'ended', 'k', decode(repeat('ab', 32), 'hex'))", [m, ids.ref2], '23505')
    await expectCode(raw, "INSERT INTO public.match_approvals (match_id, slot, user_id, display_name, match_status, result_key, result_hash) VALUES ($1, 'referee2', $2, 'A', 'ended', 'k', decode(repeat('ab', 32), 'hex'))", [m, ids.ref], '23505')
    // a revoked row frees the slot and the account
    await raw.query("UPDATE public.match_approvals SET revoked_at = now(), revoked_reason = 'undo' WHERE match_id = $1", [m])
    await approval(raw, m, 'referee1', ids.ref2)
    await approval(raw, m, 'referee2', ids.ref)
  })

  it('a closed match has frozen approvals; ov.allow_closed lets the admin path through', async () => {
    const m = await newMatch()
    const { rows: [a] } = await approval(raw, m, 'referee1', ids.ref)
    await raw.query("UPDATE public.matches SET status = 'approved' WHERE id = $1", [m])
    assert.equal((await raw.query('SELECT closed_at IS NOT NULL AS c FROM public.matches WHERE id = $1', [m])).rows[0].c, true)
    assert.deepEqual(await activeOf(m), [{ slot: 'referee1', revoked_reason: null }], 'closing does not void')
    await expectCode(raw, "INSERT INTO public.match_approvals (match_id, slot, user_id, display_name, match_status, result_key, result_hash) VALUES ($1, 'scorer', $2, 'O', 'ended', 'k', decode(repeat('ab', 32), 'hex'))", [m, ids.owner], 'OVC01')
    await expectCode(raw, "UPDATE public.match_approvals SET revoked_at = now(), revoked_reason = 'undo' WHERE id = $1", [a.id], 'OVC01')
    await expectCode(raw, 'DELETE FROM public.match_approvals WHERE id = $1', [a.id], 'OVC01')
    await raw.query('BEGIN')
    try {
      await raw.query("SELECT set_config('ov.allow_closed', 'on', true)")
      await approval(raw, m, 'scorer', ids.owner)
    } finally { await raw.query('ROLLBACK') }
    // approved -> final keeps them
    await raw.query("UPDATE public.matches SET status = 'final' WHERE id = $1", [m])
    assert.equal((await activeOf(m)).length, 1)
  })

  it('approvals are append-only: only a single revocation and the FK nulling', async () => {
    const m = await newMatch()
    const { rows: [a] } = await approval(raw, m, 'referee2', ids.ref2, 'requested_by=$3')
    for (const set of ["display_name = 'X'", "slot = 'scorer'", "result_key = 'other'", 'approved_at = now() - interval \'1 day\'', 'match_id = gen_random_uuid()',
      `user_id = '${ids.ref}'`, `requested_by = '${ids.ref}'`, `revoked_by = '${ids.owner}'`, 'ip_hash = decode(repeat(\'01\', 32), \'hex\')']) {
      await expectCode(raw, `UPDATE public.match_approvals SET ${set} WHERE id = $1`, [a.id], 'OVA01')
    }
    // nulling is allowed (ON DELETE SET NULL)
    await raw.query('UPDATE public.match_approvals SET requested_by = NULL WHERE id = $1', [a.id])
    await raw.query("UPDATE public.match_approvals SET revoked_at = now(), revoked_reason = 'undo', revoked_by = $2 WHERE id = $1", [a.id, ids.owner])
    // revoking twice, or changing the revocation, fails
    await expectCode(raw, "UPDATE public.match_approvals SET revoked_at = now() + interval '1 second', revoked_reason = 'undo' WHERE id = $1", [a.id], 'OVA01')
    await expectCode(raw, "UPDATE public.match_approvals SET revoked_reason = 'result_changed' WHERE id = $1", [a.id], 'OVA01')
    await expectCode(raw, "UPDATE public.match_approvals SET revoked_at = NULL, revoked_reason = NULL WHERE id = $1", [a.id], 'OVA01')
    await expectCode(raw, 'UPDATE public.match_approvals SET revoked_by = $2 WHERE id = $1', [a.id, ids.ref], 'OVA01')
    await raw.query('UPDATE public.match_approvals SET revoked_by = NULL WHERE id = $1', [a.id])
  })

  it('reopening voids: admin reopen and ended -> live; not ended -> approved -> final', async () => {
    // ended -> live (the scorer's "Reopen last set", through /api/db)
    const m1 = await newMatch()
    await approval(raw, m1, 'referee1', ids.ref)
    await approval(raw, m1, 'scorer', ids.owner)
    await raw.query('BEGIN')
    await raw.query("SELECT set_config('ov.user_id', $1, true)", [ids.owner])
    await raw.query("UPDATE public.matches SET status = 'live' WHERE id = $1", [m1])
    await raw.query('COMMIT')
    assert.deepEqual(await activeOf(m1), [])
    const { rows: voided } = await raw.query('SELECT revoked_reason, revoked_by FROM public.match_approvals WHERE match_id = $1', [m1])
    assert.deepEqual(voided.map((r) => r.revoked_reason), ['match_reopened', 'match_reopened'])
    assert.deepEqual(voided.map((r) => r.revoked_by), [ids.owner, ids.owner])
    const audits = await voidAudits(m1)
    assert.equal(audits.length, 1, 'one audit row per voiding')
    assert.equal(audits[0].actor_id, ids.owner)
    assert.deepEqual(audits[0].details, { count: 2, reason: 'match_reopened', external_id: `m011_${extSeq}`, game_n: null })
    // a status change without approvals writes no audit row
    await raw.query("UPDATE public.matches SET status = 'ended' WHERE id = $1", [m1])
    await raw.query("UPDATE public.matches SET status = 'live' WHERE id = $1", [m1])
    assert.equal((await voidAudits(m1)).length, 1)

    // ended -> approved -> final: kept; then the admin reopen (closed_at -> NULL, status ended) voids
    const m2 = await newMatch('ended', { game_n: 5011 })
    await approval(raw, m2, 'referee2', ids.ref2)
    await raw.query("UPDATE public.matches SET status = 'approved' WHERE id = $1", [m2])
    await raw.query("UPDATE public.matches SET status = 'final' WHERE id = $1", [m2])
    assert.equal((await activeOf(m2)).length, 1)
    assert.equal((await voidAudits(m2)).length, 0)
    await raw.query('BEGIN')
    await raw.query("SELECT set_config('ov.allow_closed', 'on', true)")
    await raw.query("UPDATE public.matches SET status = 'ended', closed_at = NULL, closed_by = NULL WHERE id = $1", [m2])
    await raw.query('COMMIT')
    assert.deepEqual(await activeOf(m2), [])
    const [audit] = await voidAudits(m2)
    assert.equal(audit.actor_id, null, 'no ov.user_id: no actor')
    assert.equal(audit.details.game_n, 5011)
    // the reopened match takes new approvals
    await approval(raw, m2, 'referee2', ids.ref2)
    assert.equal((await activeOf(m2)).length, 1)

    // a status change that stays inside ended/approved/final, or one from live, does not void
    const m3 = await newMatch('live', { test: true })
    await approval(raw, m3, 'referee1', ids.ref)
    await raw.query("UPDATE public.matches SET status = 'ended' WHERE id = $1", [m3])
    await raw.query("UPDATE public.matches SET status = 'approved' WHERE id = $1", [m3])
    assert.equal((await activeOf(m3)).length, 1, 'a test match never closes; approved keeps them')
    await raw.query("UPDATE public.matches SET status = 'live' WHERE id = $1", [m3])
    assert.equal((await activeOf(m3)).length, 0, 'approved -> live voids')
  })

  it('deleting an account nulls user_id and keeps the row, also on a closed match', async () => {
    const official = await newUser('official')
    const m = await newMatch()
    const { rows: [a] } = await approval(raw, m, 'referee1', official, 'requested_by=$3')
    await raw.query("INSERT INTO auth.approval_pins (user_id, salt, mac) VALUES ($1, decode(repeat('00', 16), 'hex'), decode(repeat('ab', 32), 'hex'))", [official])
    await raw.query("UPDATE public.matches SET status = 'approved' WHERE id = $1", [m])
    await raw.query('DELETE FROM auth.users WHERE id = $1', [official])
    const { rows: [row] } = await raw.query('SELECT user_id, requested_by, display_name, revoked_at FROM public.match_approvals WHERE id = $1', [a.id])
    assert.deepEqual(row, { user_id: null, requested_by: null, display_name: 'Muster Anna', revoked_at: null })
    assert.equal((await raw.query('SELECT count(*)::int n FROM auth.approval_pins WHERE user_id = $1', [official])).rows[0].n, 0, 'the PIN goes with the account')
    // the explicit detach of lib/auth.js (UPDATE ... SET user_id = NULL) passes too
    await raw.query('UPDATE public.match_approvals SET user_id = NULL WHERE user_id = $1', [randomUUID()])
  })
})
