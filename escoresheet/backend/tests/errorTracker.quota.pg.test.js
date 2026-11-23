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
 * Review of the first fix: reports without a session could fill the whole
 * ceiling, and then a signed-in scorer's new crash was answered accepted and
 * lost (ET-3); a report the shared new-group window refused was answered
 * accepted too, so the device deleted it, and nobody was told (ET-4). Now
 * reports without a session fill at most their share of the ceiling, what a
 * shared limit refuses is answered as dropped (the device keeps it), the
 * owner hears of each once an hour, and the Errors tab deletes the groups
 * only reports without a session fed.
 *
 * Needs PG_TEST_URL (see tests/helpers/pgTestDb.js).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import pg from 'pg'
import { SKIP_PG, createTestDatabase, quietLogger } from './helpers/pgTestDb.js'
import { createErrorTracker, NEW_GROUP_LIMITS, EVENTS_KEPT_PER_GROUP, ANONYMOUS_STORE_SHARE } from '../lib/errorTracker.js'

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
    let clock = Date.now()
    const t = createErrorTracker({ pool, log: quietLogger(), now: () => clock, newGroupLimits: { ip: { max: 5, windowMs: 3600_000 }, anonymous: { max: 8, windowMs: 3600_000 } } })
    // one address: 5 new groups, then nothing new; over its own window each answer is an accept (the device drops it, no endless retry)
    const r1 = await t.ingest({ body: { events: Array.from({ length: 10 }, () => report()) }, ipKey: '2001:db8:1::' })
    assert.equal(r1.status, 200)
    assert.equal(r1.body.data.accepted.length, 10)
    assert.equal(await groups(), 5)
    assert.equal(await events(), 5)
    // other addresses: the total of 8 for everyone without a session. What
    // that shared window refuses is answered as dropped: the device keeps it
    // and sends it again later (ET-4)
    const second = Array.from({ length: 5 }, () => report())
    const r2 = await t.ingest({ body: { events: second }, ipKey: '2001:db8:2::' })
    assert.equal(r2.status, 202)
    assert.deepEqual(r2.body.data.accepted, second.slice(0, 3).map((e) => e.uid))
    assert.equal(r2.body.data.dropped, 2)
    const r3 = await t.ingest({ body: { events: Array.from({ length: 5 }, () => report()) }, ipKey: '2001:db8:3::' })
    assert.equal(r3.status, 202)
    assert.deepEqual([r3.body.data.accepted, r3.body.data.dropped], [[], 5])
    assert.equal(await groups(), 8)
    assert.equal(t.stats().refusedGroups, 5 + 2 + 5)
    // the owner hears of it: one server error, however many were refused
    let flood
    for (let i = 0; i < 50 && !flood; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      flood = (await pool.query("SELECT event_count FROM public.error_groups WHERE source = 'server' AND title LIKE '%new-group window%'")).rows[0]
    }
    assert.equal(Number(flood?.event_count), 1, 'one notice an hour')
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
    assert.equal(await groups(), 8 + 1 + 1 + 1 + 1, '+ the notice')
    // an hour later the windows are new: the dropped reports go in when the
    // device sends them again, and the shared window's refusals cost their
    // address nothing (2001:db8:3:: still has its 5)
    clock += 3600_000
    const again = await t.ingest({ body: { events: Array.from({ length: 6 }, () => report()) }, ipKey: '2001:db8:3::' })
    assert.equal(again.status, 200)
    assert.equal(await count("SELECT count(*) AS n FROM public.error_groups WHERE source = 'client' AND anonymous"), 8 + 5)
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
    // client events: the owner's notice below is a server error, whose new group keeps its first event
    const clientEvents = () => count("SELECT count(*) AS n FROM public.error_events WHERE source = 'client'")
    const before = await clientEvents()
    const known = report({ message: 'before the store was full' })
    const r = await t.ingest({ body: { events: [known, report(), report()] }, accountId: account, ipKey: '198.51.100.9' })
    // the known group counts it (taken); a new group cannot open: answered as
    // dropped, the device keeps those and sends them again later (ET-3, ET-4;
    // before they were taken and lost)
    assert.equal(r.status, 202)
    assert.deepEqual(r.body.data.accepted, [known.uid])
    assert.equal(r.body.data.dropped, 2)
    assert.equal(await clientEvents(), before, 'no event stored')
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
    assert.equal(await clientEvents(), before + 1)
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

  it('reports without a session fill only their share; signed-in reports and server errors keep the rest (ET-3)', async () => {
    await reset()
    const log = quietLogger()
    // a share of 2 KB: one anonymous group (2 KB by the estimate) with its event fills it
    const t = createErrorTracker({ pool, log, maxStoreBytes: 10 * 1024 * 1024, anonymousStoreShare: 2000 / (10 * 1024 * 1024) })
    const first = await t.ingest({ body: { events: [report({ message: 'a guest bug' })] }, ipKey: '198.51.100.50' })
    assert.equal(first.status, 200)
    assert.equal(await events(), 1)
    // the share is full: a new anonymous group is dropped (kept on the device), a known one only counts
    const fresh = await t.ingest({ body: { events: [report()] }, ipKey: '198.51.100.51' })
    assert.equal(fresh.status, 202)
    assert.equal(fresh.body.data.dropped, 1)
    const known = await t.ingest({ body: { events: [report({ message: 'a guest bug' })] }, ipKey: '198.51.100.52' })
    assert.equal(known.status, 200)
    assert.equal(await count("SELECT event_count AS n FROM public.error_groups WHERE title = 'a guest bug'"), 2)
    // client events only: the owner's notice of the full share (a server
    // event, setImmediate after `fresh`) may land before this count
    assert.equal(await count("SELECT count(*) AS n FROM public.error_events WHERE source = 'client'"), 1, 'counted, not stored')
    // a signed-in scorer's new crash and the server's own error still go in
    const crash = await t.ingest({ body: { events: [report({ message: 'the scorer crashed in an official match' })] }, accountId: account, ipKey: '198.51.100.53' })
    assert.equal(crash.status, 200)
    assert.equal((await t.captureServer(new Error('a server error while guests flood'), { view: 'share test' })).stored, true)
    assert.equal(await count("SELECT count(*) AS n FROM public.error_events WHERE source = 'client'"), 2)
    assert.deepEqual([t.stats().storeFull, t.stats().anonymousFull], [false, true])
    assert.match(log.lines.join('\n'), /reports without a session hold about/)
    let notice
    for (let i = 0; i < 50 && !notice; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      notice = (await pool.query("SELECT id FROM public.error_groups WHERE source = 'server' AND title LIKE '%filled their share%'")).rows[0]
    }
    assert.ok(notice, 'the owner is told')
  })

  it('a cleanup shows: the Errors tab\'s delete and, while full, a fresh look every 5 minutes (ET-3)', async () => {
    await reset()
    let clock = Date.now()
    const g = await createErrorTracker({ pool, log: quietLogger() }).ingest({ body: { events: [report({ message: 'stored before' })] }, accountId: account, ipKey: '198.51.100.60' })
    assert.equal(g.status, 200)
    // full with a group and its event (about 2.9 KB by the estimate), not with a group alone (2 KB)
    const t = createErrorTracker({ pool, log: quietLogger(), now: () => clock, maxStoreBytes: 2600 })
    assert.equal((await t.ingest({ body: { events: [report()] }, accountId: account, ipKey: '198.51.100.61' })).status, 202)
    assert.equal(t.stats().storeFull, true)
    // (the owner's notice of it lands first: a server error)
    for (let i = 0; i < 50 && !(await count("SELECT count(*) AS n FROM public.error_groups WHERE source = 'server'")); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    // deleted by hand (an account deletion, the SQL tab): within 5 minutes it is seen
    await reset()
    clock += 60_000
    assert.equal((await t.ingest({ body: { events: [report()] }, accountId: account, ipKey: '198.51.100.61' })).status, 202, 'not yet read again')
    clock += 5 * 60_000
    assert.equal((await t.ingest({ body: { events: [report()] }, accountId: account, ipKey: '198.51.100.61' })).status, 200, 'read again')
    assert.equal(t.stats().storeFull, false)
    // the Errors tab's delete: at once
    assert.equal((await t.ingest({ body: { events: [report()] }, accountId: account, ipKey: '198.51.100.61' })).status, 202, 'full again')
    const del = await t.deleteEvents({ actorId: account, query: { account, confirm: 'yes' } })
    assert.equal(del.status, 200)
    assert.equal((await t.ingest({ body: { events: [report()] }, accountId: account, ipKey: '198.51.100.61' })).status, 200)
  })

  it('the Errors tab deletes the groups only reports without a session fed (not those marked important)', async () => {
    await reset()
    const entries = []
    const t = createErrorTracker({ pool, log: quietLogger(), audit: async (_c, e) => { entries.push(e) } })
    await t.ingest({ body: { events: [report({ message: 'guest junk one' }), report({ message: 'guest junk two' }), report({ message: 'guest junk two' })] }, ipKey: '198.51.100.70' })
    await t.ingest({ body: { events: [report({ message: 'a guest bug worth keeping' })] }, ipKey: '198.51.100.71' })
    await pool.query("UPDATE public.error_groups SET important = true WHERE title = 'a guest bug worth keeping'")
    await t.ingest({ body: { events: [report({ message: 'a scorer crash' })] }, accountId: account, ipKey: '198.51.100.72' })
    // a guest's report into a known group stays with the group
    await t.ingest({ body: { events: [report({ message: 'a scorer crash' })] }, ipKey: '198.51.100.73' })
    await t.captureServer(new Error('a server error'), { view: 'delete test' })
    for (const query of [{ anonymous: '1' }, { anonymous: '1', device: 'dev-1', confirm: 'yes' }, { anonymous: 'yes', confirm: 'yes' }]) {
      assert.equal((await t.deleteEvents({ actorId: account, query })).status, 400, JSON.stringify(query))
    }
    const del = await t.deleteEvents({ actorId: account, query: { anonymous: '1', confirm: 'yes' } })
    assert.equal(del.status, 200)
    assert.deepEqual(del.body.data, { deleted: 3, groups: 2 })
    const titles = (await pool.query('SELECT title FROM public.error_groups ORDER BY title')).rows.map((r) => r.title)
    assert.ok(!titles.some((x) => x.startsWith('guest junk')), titles.join())
    assert.ok(titles.includes('a guest bug worth keeping') && titles.includes('a scorer crash'))
    assert.equal(await count("SELECT count(*) AS n FROM public.error_events e JOIN public.error_groups g ON g.id = e.group_id WHERE g.title = 'a scorer crash'"), 2)
    assert.deepEqual(entries.at(-1).details, { device: null, account: null, anonymous: true, groups: 2, rows: 3 })
  })

  it('the defaults: a quota well above a hall\'s real errors, two weeks of events per group, most of the store for guests', () => {
    assert.ok(NEW_GROUP_LIMITS.ip.max >= 10 && NEW_GROUP_LIMITS.anonymous.max >= NEW_GROUP_LIMITS.ip.max)
    assert.equal(EVENTS_KEPT_PER_GROUP, 14 * 500)
    assert.ok(ANONYMOUS_STORE_SHARE > 0.3 && ANONYMOUS_STORE_SHARE < 0.9)
  })
})
