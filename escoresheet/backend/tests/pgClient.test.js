// A Postgres session lost while a client is checked out (restart, OOM kill,
// pg_terminate_backend) fails the request, never the process (lib/pgClient.js).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { connectClient } from '../lib/pgClient.js'
import { createPgQuery } from '../lib/pgQuery.js'
import { SKIP_PG, createTestDatabase, quietLogger } from './helpers/pgTestDb.js'

function fakePool() {
  const released = []
  const client = new EventEmitter()
  const pool = {
    released,
    client,
    async connect() {
      client.release = (err) => released.push(err ?? null)
      return client
    }
  }
  return pool
}

describe('connectClient', () => {
  it('listens for errors while checked out and hands the error to the pool on release', async () => {
    const pool = fakePool()
    const errors = []
    const client = await connectClient(pool, { error: (m) => errors.push(m) })
    // Without a listener this emit throws (an unhandled 'error' event)
    assert.doesNotThrow(() => client.emit('error', new Error('Connection terminated unexpectedly')))
    assert.doesNotThrow(() => client.emit('error', new Error('again')))
    assert.equal(errors.length, 1, 'the loss is logged once')
    assert.match(errors[0], /connection lost/)
    client.release()
    assert.equal(pool.released.length, 1)
    assert.match(pool.released[0].message, /terminated unexpectedly/, 'the pool drops the broken client')
    assert.equal(client.listenerCount('error'), 0, 'the listener goes with the checkout')
  })

  it('releases a healthy client without an error', async () => {
    const pool = fakePool()
    const client = await connectClient(pool)
    client.release()
    assert.deepEqual(pool.released, [null])
    assert.equal(client.listenerCount('error'), 0)
  })

  it('passes an explicit release error on', async () => {
    const pool = fakePool()
    const client = await connectClient(pool)
    const e = new Error('rollback failed')
    client.release(e)
    assert.equal(pool.released[0], e)
  })

  it('every pool.connect() of the backend goes through connectClient', () => {
    const files = ['pgQuery', 'accountRequests', 'accounts', 'approvals', 'clubs', 'activityLog', 'finalMail', 'auth', 'scoresheets', 'teams', 'licences', 'beachTournaments', 'savedTeams']
    for (const f of files) {
      const src = readFileSync(new URL(`../lib/${f}.js`, import.meta.url), 'utf8')
      assert.ok(!/await pool\.connect\(\)/.test(src), `lib/${f}.js checks a client out without connectClient`)
      assert.ok(/connectClient\(pool/.test(src), `lib/${f}.js uses connectClient`)
    }
  })
})

describe('a Postgres session ended during a transaction', { skip: SKIP_PG }, () => {
  let tdb
  let db
  let admin

  before(async () => {
    tdb = await createTestDatabase('pgclient', { schemaSql: '' })
    db = createPgQuery({ connectionString: tdb.url, logger: quietLogger(), allowedTables: [] })
    admin = new pg.Client({ connectionString: tdb.url })
    await admin.connect()
  })

  after(async () => {
    await admin?.end()
    await db?.close()
    await tdb?.drop()
  })

  it('fails the transaction, keeps the process and the pool usable', async () => {
    const tx = db.withTransaction(async (client) => {
      await client.query("SET application_name = 'ov-pgclient-victim'")
      await client.query('SELECT pg_sleep(5)')
      return 'done'
    })
    // the victim's backend is busy in pg_sleep
    let pid = null
    for (let i = 0; i < 50 && !pid; i++) {
      const { rows } = await admin.query("SELECT pid FROM pg_stat_activity WHERE application_name = 'ov-pgclient-victim' AND state = 'active'")
      pid = rows[0]?.pid ?? null
      if (!pid) await new Promise((r) => setTimeout(r, 50))
    }
    assert.ok(pid, 'the transaction runs')
    await admin.query('SELECT pg_terminate_backend($1)', [pid])
    await assert.rejects(tx, /terminat/i)
    // let the client's 'error' event (after the socket end) fire
    await new Promise((r) => setTimeout(r, 200))
    // the pool lends a fresh client: the next transaction works
    assert.equal(await db.withTransaction(async (client) => (await client.query('SELECT 1 AS one')).rows[0].one), 1)
  })
})
