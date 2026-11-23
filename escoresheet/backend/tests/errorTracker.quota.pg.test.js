/**
 * The error tracker's stored volume (audit SEC-02, db/054): reports without
 * a session cannot open groups without end, the tables have a ceiling past
 * which reports only count, a group keeps only its newest events, and open
 * groups without events go after the retention too. Signed-in reports and
 * the server's own errors are still stored while anonymous ones are capped.
 *
 * From the audit's poc/errors-logs/storage-flood.mjs: there 1200 anonymous
 * events with unique messages opened 1200 groups (about 19 KB each) that
 * purge() never removed.
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP_PG, createTestDatabase, quietLogger } from './helpers/pgTestDb.js'
import { createErrorTracker, NEW_GROUP_LIMITS, EVENTS_KEPT_PER_GROUP } from '../lib/errorTracker.js'

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
// text that survives redactText (no digits, no long runs): a new message each time, a new group each time
const noise = (n) => [...randomBytes(n)].map((b, i) => (i % 18 === 17 ? '~' : ALPHA[b % ALPHA.length])).join('')
const report = (over = {}) => ({
  uid: randomUUID(),
  client_ts: new Date().toISOString(),
  kind: 'js.error',
  level: 'error',
  product: 'openvolley',
  tool: 'scorer',
  message: `boom ${noise(40)}`,
  frames: ['onPoint@/assets/index-AbC12xYz.js:1:23456'],
  ...over
})

describe('error tracker: the stored volume (SEC-02)', { skip: SKIP_PG }, () => {
  let tdb, pool, account
  const count = async (sql, values = []) => Number((await pool.query(sql, values)).rows[0].n)
  const groups = () => count('SELECT count(*) AS n FROM public.error_groups')
  const events = () => count('SELECT count(*) AS n FROM public.error_events')
  const reset = () => pool.query('DELETE FROM public.error_events; DELETE FROM public.error_groups')

  before(async () => {
    tdb = await createTestDatabase('error_quota')
    pool = new pg.Pool({ connectionString: tdb.url, max: 4 })
    account = randomUUID()
    await pool.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [account, 'scorer-quota@example.ch'])
  })
  after(async () => {
    await pool?.end()
    await tdb?.drop()
  })

  it('db/054: error_groups.anonymous, false for what was stored before', async () => {
    const { rows } = await pool.query(`SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'error_groups' AND column_name = 'anonymous'`)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].data_type, 'boolean')
    assert.equal(rows[0].is_nullable, 'NO')
    assert.equal(rows[0].column_default, 'false')
  })

  it('anonymous reports stop opening groups at the quota; signed-in reports and the server\'s own errors still go in', async () => {
    await reset()
    const t = createErrorTracker({ pool, log: quietLogger(), newGroupLimits: { ip: { max: 5, windowMs: 3600_000 }, anonymous: { max: 8, windowMs: 3600_000 } } })
    // one address: 5 new groups, then nothing new (but each answer is an accept: the device drops it, no endless retry)
    const r1 = await t.ingest({ body: { events: Array.from({ length: 10 }, () => report()) }, ipKey: '2001:db8:1::' })
    assert.equal(r1.status, 200)
    assert.equal(r1.body.data.accepted.length, 10)
    assert.equal(await groups(), 5)
    assert.equal(await events(), 5)
    // other addresses: the total of 8 for everyone without a session
    for (const ip of ['2001:db8:2::', '2001:db8:3::']) await t.ingest({ body: { events: Array.from({ length: 5 }, () => report()) }, ipKey: ip })
    assert.equal(await groups(), 8)
    assert.equal(t.stats().refusedGroups, 5 + 2 + 5)
    // nothing of a refused group stays behind
    assert.equal(await count('SELECT count(*) AS n FROM public.error_groups g WHERE NOT EXISTS (SELECT 1 FROM public.error_events e WHERE e.group_id = g.id)'), 0)
    // an existing group still counts its events (anonymous too)
    const known = report({ message: 'a known bug of the scorer' })
    await t.ingest({ body: { events: [known] }, accountId: account, ipKey: '2001:db8:9::' })
    await t.ingest({ body: { events: [report({ message: 'a known bug of the scorer' })] }, ipKey: '2001:db8:1::' })
    assert.equal(await count("SELECT event_count AS n FROM public.error_groups WHERE title = 'a known bug of the scorer'"), 2)
    // a signed-in report opens its group, the server's own error too
    const signed = await t.ingest({ body: { events: [report()] }, accountId: account, ipKey: '2001:db8:1::' })
    assert.equal(signed.status, 200)
    const s = await t.captureServer(new Error('the server failed in a new way'), { kind: 'job.failed', view: 'quota test' })
    assert.equal(s.stored, true)
    assert.equal(await groups(), 8 + 1 + 1 + 1)
  })

  it('the groups only anonymous reports fed are marked; a signed-in report or a server error clears the mark', async () => {
    await reset()
    const t = createErrorTracker({ pool, log: quietLogger() })
    const anon = report({ message: 'only guests see this' })
    await t.ingest({ body: { events: [anon] }, ipKey: '198.51.100.1' })
    const mark = async () => (await pool.query("SELECT anonymous FROM public.error_groups WHERE title = 'only guests see this'")).rows[0]?.anonymous
    assert.equal(await mark(), true)
    await t.ingest({ body: { events: [report({ message: 'only guests see this' })] }, ipKey: '198.51.100.2' })
    assert.equal(await mark(), true)
    await t.ingest({ body: { events: [report({ message: 'only guests see this' })] }, accountId: account, ipKey: '198.51.100.3' })
    assert.equal(await mark(), false)
    await t.ingest({ body: { events: [report({ message: 'only guests see this' })] }, ipKey: '198.51.100.4' })
    assert.equal(await mark(), false, 'a signed-in report made it known for good')
    await t.captureServer(new Error('a server error'), { view: 'mark test' })
    assert.equal((await pool.query("SELECT anonymous FROM public.error_groups WHERE source = 'server'")).rows[0].anonymous, false)
  })

  it('the digest lists the groups only guests fed after the others', async () => {
    await reset()
    const t = createErrorTracker({ pool, log: quietLogger(), debounceMs: 0 })
    await t.ingest({ body: { events: [report({ message: 'guest junk one' }), report({ message: 'guest junk two' })] }, ipKey: '198.51.100.30' })
    await t.ingest({ body: { events: [report({ message: 'a scorer crash' })] }, accountId: account, ipKey: '198.51.100.31' })
    const due = await t.dueAlerts({ limit: 10 })
    assert.equal(due.length, 3)
    assert.deepEqual([due[0].group.title, due[0].group.anonymous], ['a scorer crash', false])
    assert.deepEqual(due.slice(1).map((a) => [a.group.title, a.group.anonymous]).sort(), [['guest junk one', true], ['guest junk two', true]])
  })

  it('past the ceiling reports only count: no event, no new client group; the server keeps its first event; the owner is told', async () => {
    await reset()
    const g = await createErrorTracker({ pool, log: quietLogger() }).ingest({ body: { events: [report({ message: 'before the store was full' })] }, accountId: account, ipKey: '198.51.100.9' })
    assert.equal(g.status, 200)
    const log = quietLogger()
    // a ceiling the table already passes
    const t = createErrorTracker({ pool, log, maxStoreBytes: 1 })
    const before = await events()
    const r = await t.ingest({ body: { events: [report({ message: 'before the store was full' }), report(), report()] }, accountId: account, ipKey: '198.51.100.9' })
    assert.equal(r.status, 200)
    assert.equal(r.body.data.accepted.length, 3, 'taken (counted): the device drops them')
    assert.equal(await events(), before, 'no event stored')
    assert.equal(await count("SELECT event_count AS n FROM public.error_groups WHERE title = 'before the store was full'"), 2)
    assert.equal(await count("SELECT count(*) AS n FROM public.error_groups WHERE source = 'client'"), 1, 'no new client group')
    assert.equal(t.stats().storeFull, true)
    assert.match(log.lines.join('\n'), /reports are counted, not stored/)
    // the owner hears of it: a server error (its group alerts as any other)
    let notice
    for (let i = 0; i < 50 && !notice; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      notice = (await pool.query("SELECT id, event_count FROM public.error_groups WHERE source = 'server' AND title LIKE '%error store is full%'")).rows[0]
    }
    assert.ok(notice, 'the full store is reported')
    assert.equal(await count('SELECT count(*) AS n FROM public.error_events WHERE group_id = $1', [notice.id]), 1, 'a new server group keeps its first event')
    // a ceiling far away: stored again
    const roomy = createErrorTracker({ pool, log: quietLogger() })
    await roomy.ingest({ body: { events: [report({ message: 'before the store was full' })] }, accountId: account, ipKey: '198.51.100.9' })
    assert.equal(await events(), before + 2)
  })

  it('purge: open groups without events go after the retention too; a group keeps only its newest events', async () => {
    await reset()
    const t = createErrorTracker({ pool, log: quietLogger(), eventsKeptPerGroup: 3, dailyEventsPerGroup: 100 })
    for (let i = 0; i < 5; i++) await t.ingest({ body: { events: [report({ message: 'a busy group', client_ts: new Date(Date.now() - i * 1000).toISOString() })] }, accountId: account, ipKey: `198.51.100.${20 + i}` })
    await t.ingest({ body: { events: [report({ message: 'a flood group' })] }, ipKey: '198.51.100.40' })
    // the flood group: events gone after 90 days, the group itself open and untriaged, last seen 200 days ago
    await pool.query("UPDATE public.error_events SET at = now() - interval '100 days' WHERE group_id = (SELECT id FROM public.error_groups WHERE title = 'a flood group')")
    await pool.query("UPDATE public.error_groups SET last_seen = now() - interval '200 days' WHERE title = 'a flood group'")
    // an open group seen lately stays even without events
    await pool.query("INSERT INTO public.error_groups (fingerprint, product, source, kind, title) VALUES ('fresh-empty', 'openvolley', 'client', 'js.error', 'seen yesterday')")
    const newest = (await pool.query("SELECT e.id FROM public.error_events e JOIN public.error_groups g ON g.id = e.group_id WHERE g.title = 'a busy group' ORDER BY e.id DESC LIMIT 3")).rows.map((r) => String(r.id))
    const r = await t.purge()
    assert.equal(r.trimmed, 2)
    assert.equal(r.groups, 1)
    assert.equal(r.events, 3, 'the flood event (retention) and two of the busy group (trimmed)')
    const left = (await pool.query("SELECT e.id FROM public.error_events e JOIN public.error_groups g ON g.id = e.group_id WHERE g.title = 'a busy group' ORDER BY e.id DESC")).rows.map((x) => String(x.id))
    assert.deepEqual(left, newest)
    assert.equal(await count("SELECT count(*) AS n FROM public.error_groups WHERE title = 'a flood group'"), 0)
    assert.equal(await count("SELECT count(*) AS n FROM public.error_groups WHERE title = 'seen yesterday'"), 1)
    assert.equal(await count("SELECT event_count AS n FROM public.error_groups WHERE title = 'a busy group'"), 5, 'the count stays')
  })

  it('the defaults: a quota well above a hall\'s real errors, two weeks of events per group', () => {
    assert.ok(NEW_GROUP_LIMITS.ip.max >= 10 && NEW_GROUP_LIMITS.anonymous.max >= NEW_GROUP_LIMITS.ip.max)
    assert.equal(EVENTS_KEPT_PER_GROUP, 14 * 500)
  })
})
