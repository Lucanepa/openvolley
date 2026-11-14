/**
 * db/038: an approval is deleted only with its match, and the audit entries
 * of "add editor" / "edit details" keep a digest instead of the address
 * (the same digest as lib/accounts.js emailDigest). Run twice: idempotent.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { SKIP_PG, createTestDatabase } from './helpers/pgTestDb.js'
import { emailDigest } from '../lib/accounts.js'

const here = dirname(fileURLToPath(import.meta.url))
const M038 = readFileSync(join(here, '..', 'db', '038_audit_protection.sql'), 'utf8')

describe('db/038 (approvals deleted with their match only, audit without addresses)', { skip: SKIP_PG }, () => {
  let tdb, raw

  before(async () => {
    tdb = await createTestDatabase('m038')
    raw = new pg.Client({ connectionString: tdb.url })
    await raw.connect()
  })
  after(async () => {
    await raw?.end().catch(() => {})
    await tdb?.drop()
  })

  it('replaces the addresses of old entries by their digest, and runs twice', async () => {
    await raw.query("INSERT INTO public.audit_log (action, details) VALUES ('match.editor_add', '{\"email\":\"Some.One@Example.test\"}')")
    await raw.query(`INSERT INTO public.audit_log (action, details) VALUES ('account.profile',
      '{"changed":["email","first_name"],"before":{"email":"old@example.test","first_name":"A"},"after":{"email":"new@example.test","first_name":"B"}}')`)
    await raw.query(M038)
    await raw.query(M038)
    const { rows } = await raw.query("SELECT action, details FROM public.audit_log WHERE action IN ('match.editor_add', 'account.profile') ORDER BY id")
    assert.ok(!JSON.stringify(rows).includes('@'), JSON.stringify(rows))
    assert.equal(rows[0].details.email_sha256, emailDigest('some.one@example.test'))
    assert.equal(rows[1].details.before.email_sha256, emailDigest('old@example.test'))
    assert.equal(rows[1].details.after.email_sha256, emailDigest('new@example.test'))
    assert.equal(rows[1].details.after.first_name, 'B')
  })

  it('refuses to delete an approval unless its match goes', async () => {
    const { rows: [m] } = await raw.query("INSERT INTO public.matches (external_id, status) VALUES ('m038', 'setup') RETURNING id")
    await raw.query(`INSERT INTO public.match_approvals (match_id, slot, display_name, match_status, result_key, result_hash)
      VALUES ($1, 'scorer', 'Test Scorer', 'setup', 'k', sha256('k'::bytea))`, [m.id])
    await assert.rejects(() => raw.query('DELETE FROM public.match_approvals WHERE match_id = $1', [m.id]), (e) => e.code === '23514')
    await raw.query('DELETE FROM public.matches WHERE id = $1', [m.id])
    const { rows: [n] } = await raw.query('SELECT count(*)::int AS n FROM public.match_approvals WHERE match_id = $1', [m.id])
    assert.equal(n.n, 0)
  })
})
