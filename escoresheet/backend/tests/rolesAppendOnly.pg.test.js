/**
 * db/roles.sql keeps event_revisions (db/015) and activity_log (db/016)
 * append-only for ov_app, but lib/auth.js deleteAccount still detaches the
 * account from them (cfg.detachedColumns: UPDATE ... SET <column> = NULL, as
 * ov_app). The grants are taken from roles.sql itself (its \gexec blocks for
 * these tables), so this fails when the two drift apart again: without the
 * column grants every account deletion is refused (42501, checked even when
 * no row matches).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { SKIP_PG, createTestDatabase } from './helpers/pgTestDb.js'

const here = dirname(fileURLToPath(import.meta.url))
const ROLES_SQL = readFileSync(join(here, '..', 'db', 'roles.sql'), 'utf8')
const APPEND_ONLY = ['public.event_revisions', 'public.activity_log']
// lib/auth.js DEFAULTS.detachedColumns of the append-only tables
const DETACHED = [
  ['public.event_revisions', 'actor_id'],
  ['public.activity_log', 'account_id'],
  ['public.activity_log', 'uploader_id']
]

/** roles.sql's `SELECT format(...) ... \gexec` statements about the append-only tables. */
function appendOnlyGexecBlocks () {
  const blocks = []
  const re = /^SELECT format\([\s\S]*?\\gexec/gm
  for (const m of ROLES_SQL.matchAll(re)) {
    if (APPEND_ONLY.some((t) => m[0].includes(t))) blocks.push(m[0].replace(/\\gexec$/, ''))
  }
  return blocks
}

describe('roles.sql: append-only logs, detachable accounts', { skip: SKIP_PG }, () => {
  let tdb, raw, app

  before(async () => {
    tdb = await createTestDatabase('rolesappend')
    const appUrl = await tdb.createAppRole()
    const role = new URL(appUrl).username
    raw = new pg.Client({ connectionString: tdb.url })
    await raw.connect()
    const blocks = appendOnlyGexecBlocks()
    assert.ok(blocks.length >= 2, 'roles.sql: the REVOKE / GRANT blocks of the append-only tables')
    for (const block of blocks) {
      const { rows } = await raw.query(block)
      for (const row of rows) {
        const stmt = Object.values(row)[0].replace(/\bov_app\b/g, `"${role}"`)
        await raw.query(stmt)
      }
    }
    app = new pg.Client({ connectionString: appUrl })
    await app.connect()
  })

  after(async () => {
    await app?.end().catch(() => {})
    await raw?.end().catch(() => {})
    await tdb?.drop()
  })

  it('the app role can detach an account from both tables', async () => {
    for (const [table, column] of DETACHED) {
      await app.query(`UPDATE ${table} SET ${column} = NULL WHERE ${column} = '00000000-0000-0000-0000-000000000001'`)
    }
  })

  it('the app role cannot rewrite them otherwise, but can insert and delete', async () => {
    await assert.rejects(() => app.query("UPDATE public.activity_log SET kind = 'x.y' WHERE false"), (e) => e.code === '42501')
    await assert.rejects(() => app.query("UPDATE public.event_revisions SET op = 'void' WHERE false"), (e) => e.code === '42501')
    await app.query("INSERT INTO public.activity_log (uid, client_ts, kind) VALUES (gen_random_uuid(), now(), 'app.start')")
    await app.query("DELETE FROM public.activity_log WHERE kind = 'app.start'")
  })
})
