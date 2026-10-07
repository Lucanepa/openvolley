/**
 * db/012_app_memberships.sql on a database in the state before it (005 to
 * 011, with accounts, invite codes, audit entries and matches), the way it
 * will meet production. It runs twice; every existing account becomes an
 * indoor member and nobody becomes a beach member; existing invite codes are
 * indoor and existing audit entries keep app NULL; the 2.2.0 backend's
 * INSERTs keep working; a match's sport cannot change; a beach match's close
 * entry names its app; the app role reaches the new table.
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
const M012 = sqlOf('012_app_memberships.sql')

describe('db/012_app_memberships.sql', { skip: SKIP_PG }, () => {
  let tdb, raw
  const ids = {}

  const expectCode = async (sql, params, code) => {
    await assert.rejects(() => raw.query(sql, params), (err) => {
      assert.equal(err.code, code, err.message)
      return true
    })
  }
  const memberships = async () => (await raw.query(
    'SELECT user_id, app, joined_via FROM auth.app_memberships ORDER BY user_id, app')).rows

  before(async () => {
    tdb = await createTestDatabase('mig012', {
      schemaSql: [SCHEMA_SQL_005_ONLY, ...['006_matches_updated_at.sql', '007_scorer_accounts.sql', '008_live_state_tto.sql',
        '009_beach_saved_teams.sql', '010_auth_tokens.sql', '011_account_approvals.sql'].map(sqlOf)].join('\n')
    })
    raw = new pg.Client({ connectionString: tdb.url, options: '-c TimeZone=UTC' })
    await raw.connect()
    for (const k of ['a', 'b', 'c']) {
      ids[k] = randomUUID()
      await raw.query("INSERT INTO auth.users (id, email, created_at) VALUES ($1, $2, now() - interval '30 days')", [ids[k], `${k}-${ids[k]}@example.ch`])
    }
    await raw.query("INSERT INTO public.profiles (user_id, roles) VALUES ($1, '{scorer}'), ($2, '{}')", [ids.a, ids.b])
    await raw.query(`INSERT INTO public.invite_codes (code_hash, code_hint, label, role)
      VALUES (decode(repeat('ab', 32), 'hex'), 'ABCD', 'Old code', 'scorer')`)
    await raw.query("INSERT INTO public.audit_log (actor_id, action, details) VALUES ($1, 'account.roles', '{}')", [ids.a])
    const { rows: [m] } = await raw.query("INSERT INTO public.matches (external_id, status, sport_type) VALUES ('m012_indoor', 'live', 'indoor') RETURNING id")
    ids.indoorMatch = m.id
    const { rows: [b] } = await raw.query("INSERT INTO public.matches (external_id, status, sport_type) VALUES ('m012_beach', 'live', 'beach') RETURNING id")
    ids.beachMatch = b.id
  })

  after(async () => {
    await raw?.end()
    await tdb?.drop()
  })

  it('runs twice: every existing account is an indoor member, nobody a beach member', async () => {
    await raw.query(M012)
    const first = await memberships()
    assert.deepEqual(first.map((r) => [r.user_id, r.app, r.joined_via]).sort(),
      [[ids.a, 'indoor', 'backfill'], [ids.b, 'indoor', 'backfill'], [ids.c, 'indoor', 'backfill']].sort())
    const { rows: [j] } = await raw.query('SELECT joined_at FROM auth.app_memberships WHERE user_id = $1', [ids.a])
    assert.ok(Date.now() - j.joined_at.getTime() > 29 * 86400000, 'joined_at is the account creation')
    // an account that joined only OpenBeach in between is not made indoor by a re-run
    ids.beachOnly = randomUUID()
    await raw.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [ids.beachOnly, `bo-${ids.beachOnly}@example.ch`])
    await raw.query("INSERT INTO auth.app_memberships (user_id, app, joined_via) VALUES ($1, 'beach', 'signup')", [ids.beachOnly])
    // and one created by the old backend after the first run is backfilled
    ids.late = randomUUID()
    await raw.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [ids.late, `late-${ids.late}@example.ch`])
    await raw.query(M012)
    const again = await memberships()
    assert.deepEqual(again.filter((r) => r.user_id === ids.beachOnly).map((r) => r.app), ['beach'])
    assert.deepEqual(again.filter((r) => r.user_id === ids.late).map((r) => r.app), ['indoor'])
    assert.equal(again.length, first.length + 2)
    // roles are untouched
    assert.deepEqual((await raw.query('SELECT roles FROM public.profiles WHERE user_id = $1', [ids.a])).rows[0].roles, ['scorer'])
  })

  it('memberships: one per app, known apps only, gone with the account', async () => {
    await expectCode("INSERT INTO auth.app_memberships (user_id, app) VALUES ($1, 'indoor')", [ids.a], '23505')
    await expectCode("INSERT INTO auth.app_memberships (user_id, app) VALUES ($1, 'snow')", [ids.a], '23514')
    await expectCode("INSERT INTO auth.app_memberships (user_id, app, joined_via) VALUES ($1, 'beach', 'magic')", [ids.a], '23514')
    await raw.query("INSERT INTO auth.app_memberships (user_id, app, joined_via) VALUES ($1, 'beach', 'join')", [ids.c])
    await raw.query('DELETE FROM auth.users WHERE id = $1', [ids.c])
    assert.equal((await raw.query('SELECT count(*)::int n FROM auth.app_memberships WHERE user_id = $1', [ids.c])).rows[0].n, 0)
  })

  it('invite codes: existing ones are indoor; the 2.2.0 INSERT still works; sport is checked', async () => {
    assert.deepEqual((await raw.query('SELECT DISTINCT sport FROM public.invite_codes')).rows, [{ sport: 'indoor' }])
    // lib/accounts.js of 2.2.0 names no sport
    const { rows: [old] } = await raw.query(`INSERT INTO public.invite_codes (code_hash, code_hint, label, club, role, max_uses, expires_at, created_by)
      VALUES (decode(repeat('cd', 32), 'hex'), 'WXYZ', 'New old-style', NULL, 'referee', 1, NULL, NULL) RETURNING sport`)
    assert.equal(old.sport, 'indoor')
    await raw.query(`INSERT INTO public.invite_codes (code_hash, code_hint, label, role, sport)
      VALUES (decode(repeat('ef', 32), 'hex'), 'BEAC', 'Beach tour', 'scorer', 'beach')`)
    await expectCode(`INSERT INTO public.invite_codes (code_hash, code_hint, label, role, sport)
      VALUES (decode(repeat('01', 32), 'hex'), 'SNOW', 'x', 'scorer', 'snow')`, [], '23514')
    // the role stays plain: a prefixed role is refused by 007's CHECK
    await expectCode(`INSERT INTO public.invite_codes (code_hash, code_hint, label, role, sport)
      VALUES (decode(repeat('02', 32), 'hex'), 'PREF', 'x', 'beach:scorer', 'beach')`, [], '23514')
  })

  it('audit entries: existing ones keep app NULL; app is NULL, indoor or beach', async () => {
    assert.deepEqual((await raw.query('SELECT DISTINCT app FROM public.audit_log')).rows, [{ app: null }])
    await raw.query("INSERT INTO public.audit_log (action, details) VALUES ('invite.create', '{}')") // 2.2.0's INSERT
    await raw.query("INSERT INTO public.audit_log (action, details, app) VALUES ('invite.create', '{}', 'beach')")
    await expectCode("INSERT INTO public.audit_log (action, details, app) VALUES ('invite.create', '{}', 'snow')", [], '23514')
  })

  it('a match closes with its app in the audit entry (indoor NULL as before)', async () => {
    await raw.query("UPDATE public.matches SET status = 'final' WHERE id = ANY($1::uuid[])", [[ids.indoorMatch, ids.beachMatch]])
    const { rows } = await raw.query("SELECT match_id, app FROM public.audit_log WHERE action = 'match.close' ORDER BY id")
    assert.deepEqual(rows.map((r) => [r.match_id, r.app]).sort(), [[ids.indoorMatch, null], [ids.beachMatch, 'beach']].sort())
  })

  it('a match keeps its sport: indoor <-> beach is refused, NULL <-> indoor is not a change', async () => {
    const { rows: [m] } = await raw.query("INSERT INTO public.matches (external_id, status, sport_type) VALUES ('m012_lock', 'live', 'indoor') RETURNING id")
    await expectCode("UPDATE public.matches SET sport_type = 'beach' WHERE id = $1", [m.id], 'OVS01')
    await expectCode(`INSERT INTO public.matches (external_id, sport_type) VALUES ('m012_lock', 'beach')
      ON CONFLICT (external_id) DO UPDATE SET sport_type = EXCLUDED.sport_type`, [], 'OVS01')
    await raw.query('UPDATE public.matches SET sport_type = NULL WHERE id = $1', [m.id])
    await raw.query("UPDATE public.matches SET sport_type = 'indoor', status = 'ended' WHERE id = $1", [m.id])
    await raw.query("UPDATE public.matches SET status = 'live' WHERE id = $1", [m.id]) // other columns: no check
    const { rows: [b] } = await raw.query("INSERT INTO public.matches (external_id, sport_type, test) VALUES ('m012_lock_b', 'beach', true) RETURNING id")
    await expectCode('UPDATE public.matches SET sport_type = NULL WHERE id = $1', [b.id], 'OVS01')
    await expectCode("UPDATE public.matches SET sport_type = 'indoor' WHERE id = $1", [b.id], 'OVS01')
  })

  it('the app role (grants as in roles.sql) reaches the memberships', async () => {
    const appUrl = await tdb.createAppRole()
    const role = new URL(appUrl).username
    await raw.query(`GRANT USAGE ON SCHEMA auth TO "${role}"`)
    await raw.query(`GRANT SELECT, INSERT, DELETE ON auth.app_memberships TO "${role}"`)
    const app = new pg.Client({ connectionString: appUrl })
    await app.connect()
    try {
      await app.query("INSERT INTO auth.app_memberships (user_id, app, joined_via) VALUES ($1, 'beach', 'join') ON CONFLICT DO NOTHING", [ids.a])
      assert.equal((await app.query("SELECT count(*)::int n FROM auth.app_memberships WHERE user_id = $1 AND app = 'beach'", [ids.a])).rows[0].n, 1)
      // no UPDATE: a membership is added or removed, never moved
      await assert.rejects(() => app.query("UPDATE auth.app_memberships SET app = 'indoor' WHERE user_id = $1", [ids.a]), (err) => err.code === '42501')
    } finally {
      await app.end()
    }
  })
})
