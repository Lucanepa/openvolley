/**
 * The error tracker (db/050_error_tracker.sql, lib/errorTracker.js,
 * lib/errorAlerts.js): reports are sanitized and grouped, the account comes
 * only from the session, the digest names no member and is never lost to a
 * failed send, the Errors tab is for super admins.
 *
 * The end-to-end part needs PG_TEST_URL (see tests/helpers/pgTestDb.js) or
 * OV_E2E_DOCKER=1.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { SKIP, bootServer, api, provisionDatabase, sleep, waitUntil } from './helpers/e2eServer.js'
import { grantRoles } from './helpers/pgTestDb.js'
import { startFakeSmtp, linkToken } from './helpers/fakeSmtp.js'
import {
  redactText, cleanFrames, framesOfStack, frameFile, fingerprintOf, normalizeMessage, versionAtLeast,
  checkClientEvent, serverEvent, createWindowCounter, cleanBreadcrumbs, cleanData, deviceLine, createErrorTracker
} from '../lib/errorTracker.js'
import { renderDigest, renderPush, whoLine, createErrorAlerts, groupLink } from '../lib/errorAlerts.js'
import { createMailer } from '../lib/mailer.js'

const event = (over = {}) => ({
  uid: randomUUID(),
  client_ts: new Date().toISOString(),
  kind: 'js.error',
  level: 'error',
  product: 'openvolley',
  tool: 'scorer',
  app_version: '3.4.2',
  platform: 'android',
  os_name: 'Android',
  os_version: '15',
  browser: 'Chrome WebView',
  browser_version: '131.0.6778.39',
  runs_as: 'android_app',
  screen: '1280x800',
  viewport: '1280x752',
  dpr: 2,
  lang: 'de-CH',
  tz: 'Europe/Zurich',
  online: true,
  device_id: 'dev-' + randomBytes(4).toString('hex'),
  session_id: 'ses-' + randomBytes(4).toString('hex'),
  view: 'scoreboard',
  error_name: 'TypeError',
  message: "Cannot read properties of undefined (reading 'team1')",
  frames: ['onPoint@/assets/index-AbC12xYz.js:1:23456', 'dispatch@/assets/vendor-Qq9w8e7r.js:2:100'],
  breadcrumbs: [{ t: new Date().toISOString(), c: 'click', m: 'button "Point A"' }],
  ...over
})

describe('error tracker: sanitizing', () => {
  it('free text keeps no address, date, PIN, token, query or Postgres key value', () => {
    assert.equal(redactText('mail anna.muster@example.ch failed'), 'mail [email] failed')
    assert.equal(redactText('born 01.02.2011 here'), 'born [date] here')
    assert.equal(redactText('game pin 123456 wrong'), 'game pin [redacted] wrong')
    assert.doesNotMatch(redactText('Authorization: Bearer abcdefghijklmnopqrstuvwx.yz'), /abcdefgh/)
    assert.match(redactText('sent Bearer abcdefghijklmnopqrstuvwx.yz'), /Bearer \[redacted\]/)
    assert.equal(redactText('GET https://backend.openvolley.app/api/x?token=abc&pin=1234 failed'), 'GET https://backend.openvolley.app/api/x failed')
    assert.equal(redactText('duplicate key value violates unique constraint "u" Key (email)=(a@b.ch) already exists'),
      'duplicate key value violates unique constraint "u" Key (email)=([redacted]) already exists')
    assert.equal(redactText('session=9f8e7d6c5b4a'), 'session=[redacted]')
    assert.match(redactText('x'.repeat(900)), /…$/)
    assert.equal(redactText('x'.repeat(900)).length, 500)
    // ordinary words and codes stay
    assert.equal(redactText('sync failed with code OV_NOT_MATCH_OWNER (403)'), 'sync failed with code OV_NOT_MATCH_OWNER (403)')
  })

  it('frames lose origins and queries but keep line:column; server stacks are read', () => {
    assert.deepEqual(cleanFrames(['at onPoint (https://app.openvolley.app/assets/index-AbC12xYz.js?v=1:1:23456)']),
      ['onPoint (/assets/index-AbC12xYz.js:1:23456)'])
    assert.deepEqual(cleanFrames('TypeError: x\n    at a (capacitor://localhost/assets/a.js:3:4)'), ['a (/assets/a.js:3:4)'])
    const err = new Error('boom')
    const frames = framesOfStack(err.stack)
    assert.ok(frames.length > 0)
    assert.match(frames[0], /errorTracker\.test\.js:\d+:\d+$/)
  })

  it('breadcrumbs and data keep no denied key and no value of one', () => {
    const crumbs = cleanBreadcrumbs([{ c: 'fetch', m: 'POST /api/db 500', d: { status: 500, pin: '1234', token: 'abc' } }, { c: 'weird', m: 'x' }, 'nope'])
    assert.deepEqual(crumbs, [{ c: 'fetch', m: 'POST /api/db 500', d: { status: 500 } }, { c: 'app', m: 'x' }])
    assert.deepEqual(cleanData({ email: 'a@b.ch', hasPin: true, pinSet: true, note: 'call 0791234567' }), { hasPin: true, pinSet: true, note: 'call [redacted]' })
  })
})

describe('error tracker: grouping', () => {
  it('one bug stays one group across builds, ids and numbers', () => {
    const a = event()
    const b = event({ message: "Cannot read properties of undefined (reading 'team1')", frames: ['onPoint@/assets/index-ZZ99yy88.js:1:99999'] })
    assert.equal(frameFile(a.frames[0]), 'index.js')
    assert.equal(fingerprintOf({ ...a, source: 'client' }), fingerprintOf({ ...b, source: 'client' }))
    assert.equal(normalizeMessage('Match 1234 not found (id 9f8e7d6c5b4a3f2e1d)'), 'match # not found (id <id>)')
    // another message, another kind or another product is another group
    assert.notEqual(fingerprintOf({ ...a, source: 'client' }), fingerprintOf({ ...a, source: 'client', message: 'other' }))
    assert.notEqual(fingerprintOf({ ...a, source: 'client' }), fingerprintOf({ ...a, source: 'client', product: 'openbeach' }))
  })

  it('versions compare numerically', () => {
    assert.equal(versionAtLeast('3.4.10', '3.4.9'), true)
    assert.equal(versionAtLeast('3.4.2', '3.4.3'), false)
    assert.equal(versionAtLeast('3.4.3', '3.4.3'), true)
    assert.equal(versionAtLeast(null, '3.4.3'), false)
  })
})

describe('error tracker: checking a report', () => {
  it('takes a full report and never the account from the body', () => {
    const me = randomUUID()
    const r = checkClientEvent(event({ account_id: randomUUID() }), { accountId: me })
    assert.ok(r.row, JSON.stringify(r))
    assert.equal(r.row.account_id, me)
    assert.equal(r.row.source, 'client')
    assert.equal(checkClientEvent(event({ account_id: me }), {}).row.account_id, null)
  })

  it('refuses what a device may not report', () => {
    for (const over of [{ kind: 'server.exception' }, { tool: 'server' }, { tool: 'hack' }, { level: 'info' }, { uid: 'x' },
      { product: 'other' }, { screen: 'big' }, { device_id: 'x y' }, { runs_as: 'server' }, { message: 5 }, { client_ts: 'soon' }]) {
      assert.equal(checkClientEvent(event(over)).code, 'OV_ERROR_INVALID', JSON.stringify(over))
    }
  })

  it('a device clock far off is cut back', () => {
    const now = Date.parse('2026-11-19T12:00:00Z')
    assert.equal(checkClientEvent(event({ client_ts: '2099-01-01T00:00:00Z' }), { now }).row.client_ts, '2026-11-20T12:00:00.000Z')
    assert.equal(checkClientEvent(event({ client_ts: '2001-01-01T00:00:00Z' }), { now }).row.client_ts, '2026-10-20T12:00:00.000Z')
  })

  it('a server error is an event too', () => {
    const e = serverEvent(Object.assign(new Error('relation "x" does not exist'), { code: '42P01' }), { view: 'manage GET /api/admin/x', requestId: 'abcdef123456', status: 503 })
    assert.equal(e.source, 'server')
    assert.equal(e.runs_as, 'server')
    assert.match(e.message, /\(42P#?01\)|\(42P01\)/)
    assert.deepEqual(e.data, { status: 503 })
    assert.equal(e.request_id, 'abcdef123456')
  })

  it('rate limits are fixed windows', () => {
    let t = 0
    const c = createWindowCounter({ max: 3, windowMs: 1000, now: () => t })
    assert.equal(c.take('a', 2), true)
    assert.equal(c.take('a', 2), false)
    assert.equal(c.take('a', 1), true)
    t = 1000
    assert.equal(c.take('a', 3), true)
  })
})

const alertOf = (over = {}) => ({
  group: { id: randomUUID(), product: 'openvolley', source: 'client', kind: 'js.error', title: 'TypeError: x is undefined', last_alert_at: null },
  reason: 'new',
  since: new Date(Date.now() - 60000).toISOString(),
  count: 3,
  tools: ['scorer'],
  versions: ['3.4.2'],
  devices: 2,
  accounts: 1,
  guests: 2,
  duringMatch: false,
  last: { ...checkClientEvent(event()).row, at: new Date().toISOString() },
  members: [{ roles: ['scorer', 'referee'], clubs: ['VBC Musterdorf'] }],
  ...over
})

describe('error alerts: the digest', () => {
  it('names roles and clubs, never a member, and links the group', () => {
    const a = alertOf()
    const d = renderDigest([a], { managerUrl: 'https://manager.example' })
    // the subject: the count, the kind and the tool, never the reported text (SEC-33)
    assert.match(d.subject, /^\[OpenVolley\] New error — 3× js\.error · scorer$/)
    assert.match(d.text, /Who: 1 member: scorer, referee \(VBC Musterdorf\) and guests \(not signed in\)/)
    assert.match(d.text, /Device: Android 15 · Chrome WebView 131\.0\.6778\.39 · android_app · 1280x752/)
    assert.ok(d.text.includes(groupLink('https://manager.example', a.group.id)))
    assert.ok(d.html.includes('Open in Errors'))
    assert.equal(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(d.text), false)
    const two = renderDigest([a, alertOf({ reason: 'regression' })], { managerUrl: 'https://manager.example' })
    assert.match(two.subject, /6 errors in 2 kinds/)
    assert.match(two.text, /REGRESSION/)
  })

  it('who: a guest, one member, a server request', () => {
    assert.equal(whoLine({ members: [], accounts: 0, guests: 1, group: { source: 'client' } }), 'guest (not signed in)')
    assert.equal(whoLine({ members: [{ roles: ['scorer'], clubs: [] }], accounts: 1, guests: 0 }), 'scorer')
    assert.equal(whoLine({ members: [], accounts: 0, guests: 1, group: { source: 'server' } }), 'no session')
  })

  it('the push: short, no name, urgent for the server, a regression or a match', () => {
    const p = renderPush([alertOf()], { managerUrl: 'https://manager.example' })
    assert.match(p.title, /^OpenVolley: new error \(3x\)$/)
    assert.match(p.body, /scorer · Android 15 · 3\.4\.2/)
    assert.equal(p.priority, 3)
    assert.equal(renderPush([alertOf({ duringMatch: true })]).priority, 4)
    assert.equal(renderPush([alertOf({ reason: 'regression' })]).priority, 4)
    assert.equal(deviceLine({ source: 'server', tool: 'server', build: 'abc' }), 'backend · build abc')
  })
})

/** A tracker double for the alert pass. */
function fakeTracker(due) {
  const calls = { marked: [], deferred: [] }
  return {
    calls,
    async dueAlerts() { return due.splice(0) },
    async markAlerted(ids) { calls.marked.push(...ids) },
    async deferAlerts(ids, until) { calls.deferred.push({ ids, until }) }
  }
}
const fakePool = (sentLastHour = 0, admins = []) => ({
  queries: [],
  async query(sql, values) {
    this.queries.push({ sql, values })
    if (/FROM public\.audit_log/.test(sql)) return { rows: [{ n: sentLastHour }] }
    if (/FROM public\.profiles/.test(sql)) return { rows: admins.map((user_id) => ({ user_id })) }
    if (/INSERT INTO public\.notifications/.test(sql)) return { rowCount: admins.length }
    return { rows: [], rowCount: 0 }
  }
})
const quiet = { log() {}, warn() {}, error() {} }

describe('error alerts: one pass', () => {
  it('a failed mail marks nothing and pushes nothing: the next pass sends it', async () => {
    const tracker = fakeTracker([alertOf()])
    const pushes = []
    const alerts = createErrorAlerts({
      tracker, pool: fakePool(), to: 'admin@example.test', log: quiet,
      mailer: { enabled: true, async sendOps() { throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }) } },
      ntfy: { url: 'https://ntfy.example', topic: 't' }, fetchImpl: async (...a) => { pushes.push(a); return { ok: true } }
    })
    const r = await alerts.tick()
    assert.equal(r.mailFailed, 1)
    assert.deepEqual(tracker.calls.marked, [])
    assert.equal(pushes.length, 0)
  })

  it('a sent digest pushes, rings the bell and marks the groups', async () => {
    const a = alertOf()
    const tracker = fakeTracker([a])
    const pushes = []
    const mails = []
    const admin = randomUUID()
    const pool = fakePool(0, [admin])
    const alerts = createErrorAlerts({
      tracker, pool, to: 'admin@example.test', managerUrl: 'https://manager.example', log: quiet,
      mailer: { enabled: true, async sendOps(m) { mails.push(m); return { sent: true } } },
      ntfy: { url: 'https://ntfy.example/', topic: 'openvolley-errors' },
      fetchImpl: async (url, init) => { pushes.push({ url, init }); return { ok: true } },
      audit: async () => {}
    })
    const r = await alerts.tick()
    assert.equal(r.sent, 1)
    assert.equal(mails[0].to, 'admin@example.test')
    assert.equal(pushes[0].url, 'https://ntfy.example/openvolley-errors')
    assert.equal(pushes[0].init.headers.Click, groupLink('https://manager.example', a.group.id))
    assert.ok(pool.queries.some((q) => /INSERT INTO public\.notifications/.test(q.sql) && q.values[2] === `errors/${a.group.id}`))
    assert.deepEqual(tracker.calls.marked, [a.group.id])
  })

  it('the cooldown and the hourly ceiling make a digest wait', async () => {
    const t = Date.parse('2026-11-19T12:00:00Z')
    const cooling = alertOf({ group: { ...alertOf().group, last_alert_at: new Date(t - 10 * 60 * 1000).toISOString() } })
    const tracker = fakeTracker([cooling])
    const alerts = createErrorAlerts({ tracker, pool: fakePool(), now: () => t, log: quiet, mailer: { enabled: true, async sendOps() { return { sent: true } } }, to: 'a@b.test' })
    assert.equal((await alerts.tick()).cooling, 1)
    assert.equal(tracker.calls.deferred[0].until, t + 50 * 60 * 1000)

    const busy = fakeTracker([alertOf()])
    const capped = createErrorAlerts({ tracker: busy, pool: fakePool(6), now: () => t, log: quiet, mailer: { enabled: true, async sendOps() { throw new Error('must not send') } }, to: 'a@b.test' })
    assert.equal((await capped.tick()).deferred, 1)
    assert.equal(busy.calls.deferred[0].until, t + 15 * 60 * 1000)
  })

  it('suppressed: nothing is sent, the groups are marked', async () => {
    const tracker = fakeTracker([alertOf()])
    const lines = []
    const alerts = createErrorAlerts({ tracker, pool: fakePool(), suppressed: true, log: { ...quiet, log: (l) => lines.push(l) }, mailer: { enabled: true, async sendOps() { throw new Error('must not send') } }, to: 'a@b.test' })
    assert.equal((await alerts.tick()).suppressed, 1)
    assert.equal(tracker.calls.marked.length, 1)
    assert.match(lines.join('\n'), /alert suppressed/)
  })
})

describe('error alerts: the push through a given address', () => {
  it('connects to NTFY_ADDRESS and keeps the name in Host', async () => {
    const got = []
    const sink = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => { got.push({ url: req.url, host: req.headers.host, title: req.headers.title, body }); res.writeHead(200); res.end('{}') })
    })
    await new Promise((r) => sink.listen(0, '127.0.0.1', r))
    try {
      const port = sink.address().port
      const alerts = createErrorAlerts({
        tracker: fakeTracker([alertOf()]), pool: fakePool(), log: quiet,
        ntfy: { url: `http://ntfy.example.invalid:${port}`, topic: 'openvolley-errors', address: '127.0.0.1' },
        fetchImpl: async () => { throw new Error('must not resolve the name') }
      })
      const r = await alerts.tick()
      assert.equal(r.pushed, true)
      assert.equal(got[0].url, '/openvolley-errors')
      assert.equal(got[0].host, `ntfy.example.invalid:${port}`)
      assert.match(got[0].title, /^OpenVolley: new error/)
    } finally {
      await new Promise((r) => sink.close(r))
    }
  })
})

describe('mailer: the operator\'s mails', () => {
  it('sendOps sends what it is given, on its own budget', async () => {
    const sent = []
    const m = createMailer({ from: 'OpenVolley <noreply@example.test>', transport: { async sendMail(x) { sent.push(x) }, close() {} }, opsPerHour: 1, logger: quiet })
    assert.deepEqual(await m.sendOps({ to: 'admin@example.test', subject: 'a\nb', text: 't', html: '<p>t</p>' }), { sent: true })
    assert.equal(sent[0].subject, 'a b')
    assert.equal(sent[0].from, 'OpenVolley <noreply@example.test>')
    assert.deepEqual(await m.sendOps({ to: 'admin@example.test', subject: 's', text: 't' }), { sent: false, skipped: 'budget' })
    // the users' budgets are untouched
    assert.equal(m.stats().budgets.account.used, 0)
  })
})

describe('error tracker end to end', { skip: SKIP }, () => {
  let db, srv, sql, smtp, ntfy, storageRoot, statusDir, pool
  const pushes = []
  let ipSeq = 1
  const nextIp = () => `198.51.100.${ipSeq++}`
  const PASSWORD = 'correct-horse-battery'
  const users = {}
  const authCall = (action, body) => api(srv.base, `/api/auth/${action}`, { body, proto: null, headers: { 'cf-connecting-ip': nextIp() } })
  const call = (user, method, path, body) => api(srv.base, path, { method, token: user?.token, body, proto: null })
  const report = (events, { token, ip = nextIp() } = {}) => api(srv.base, '/api/errors', { body: { events }, token, proto: null, headers: { 'cf-connecting-ip': ip } })

  async function account (name, { roles = [] } = {}) {
    const email = `${name.toLowerCase()}-${randomBytes(3).toString('hex')}@example.test`
    const up = await authCall('sign-up', { email, password: PASSWORD, metadata: { first_name: name, last_name: 'Tester' } })
    assert.equal(up.status, 200, up.text)
    const mail = await smtp.waitForMail((m) => m.envelope.to.includes(email))
    assert.equal((await authCall('confirm-email', { token: linkToken(mail).token, password: PASSWORD })).status, 200)
    let r
    for (let i = 0; i < 10; i++) {
      r = await authCall('sign-in', { email, password: PASSWORD })
      if (!(r.status === 503 && r.json?.error?.code === 'auth_busy')) break
      await sleep(1100)
    }
    assert.equal(r.status, 200, r.text)
    const u = { email, name, token: r.json.data.session.access_token, id: r.json.data.user.id }
    if (roles.length) await grantRoles(sql, u.id, roles)
    users[name] = u
    return u
  }

  before(async () => {
    db = await provisionDatabase()
    sql = new pg.Client({ connectionString: db.url })
    await sql.connect()
    pool = new pg.Pool({ connectionString: db.url, max: 2 })
    storageRoot = mkdtempSync(join(tmpdir(), 'ov-err-storage-'))
    writeFileSync(join(storageRoot, '.ovdata'), '')
    statusDir = mkdtempSync(join(tmpdir(), 'ov-err-status-'))
    writeFileSync(join(statusDir, 'last_backup'), new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n')
    smtp = await startFakeSmtp({ implicitTls: false })
    ntfy = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => { pushes.push({ url: req.url, headers: req.headers, body }); res.writeHead(200); res.end('{}') })
    })
    await new Promise((r) => ntfy.listen(0, '127.0.0.1', r))
    srv = await bootServer({
      DATABASE_URL: db.appUrl(),
      STORAGE_ROOT: storageRoot,
      STATUS_DIR: statusDir,
      TRUST_PROXY: 'cloudflare',
      TRUST_PROXY_FROM: '127.0.0.1/32,::1/128',
      STORAGE_BACKUP_MIN_FREE_MB: '1',
      STORAGE_SCORESHEETS_MIN_FREE_MB: '1',
      ERROR_ALERT_EMAIL: 'admin@example.test',
      ERROR_ALERT_TICK_MS: '1000',
      ERROR_ALERT_DEBOUNCE_MS: '0',
      ERROR_ALERT_COOLDOWN_MS: '0',
      // no source maps from the real sites in a test
      ERROR_SOURCE_MAPS: 'off',
      NTFY_URL: `http://127.0.0.1:${ntfy.address().port}`,
      NTFY_TOPIC: 'openvolley-errors',
      ...smtp.env()
    })
    await account('Root', { roles: ['admin', 'super_admin'] })
    await account('Admin', { roles: ['admin'] })
    await account('Scorer', { roles: ['scorer'] })
    const { rows: [club] } = await sql.query(`INSERT INTO public.clubs (name) VALUES ('VBC Musterdorf') RETURNING id`)
    await sql.query('INSERT INTO public.account_clubs (user_id, club_id) VALUES ($1, $2)', [users.Scorer.id, club.id])
  })

  after(async () => {
    await pool?.end().catch(() => {})
    await sql?.end().catch(() => {})
    await srv?.stop()
    await smtp?.close()
    await new Promise((r) => (ntfy ? ntfy.close(r) : r()))
    await db?.drop()
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true })
    if (statusDir) rmSync(statusDir, { recursive: true, force: true })
  })

  let groupId

  it('a guest reports anonymously; a signed-in report names the session account, never the body\'s', async () => {
    const guest = event({ message: 'guest only boom', account_id: users.Root.id })
    const r1 = await report([guest])
    assert.equal(r1.status, 200, r1.text)
    assert.deepEqual(r1.json.data.accepted, [guest.uid])
    const signed = event({ account_id: users.Root.id, frames: ['onPoint@/assets/index-Other999.js:1:5'] })
    const r2 = await report([signed], { token: users.Scorer.token })
    assert.equal(r2.status, 200, r2.text)
    const { rows } = await sql.query('SELECT uid, account_id, group_id FROM public.error_events ORDER BY id')
    assert.equal(rows.find((x) => x.uid === guest.uid).account_id, null)
    assert.equal(rows.find((x) => x.uid === signed.uid).account_id, users.Scorer.id)
    // the same report again counts once
    assert.equal((await report([signed], { token: users.Scorer.token })).status, 200)
    const { rows: [n] } = await sql.query('SELECT count(*)::int AS n FROM public.error_events WHERE uid = $1', [signed.uid])
    assert.equal(n.n, 1)
    groupId = rows.find((x) => x.uid === signed.uid).group_id
    // no address is stored anywhere in the table
    const { rows: cols } = await sql.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'error_events'`)
    assert.equal(cols.some((c) => /ip|address/.test(c.column_name)), false)
  })

  it('the beacon\'s text/plain body is taken too; a bad report is refused one by one', async () => {
    const e = event({ message: 'beacon boom' })
    const res = await fetch(`${srv.base}/api/errors`, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'cf-connecting-ip': nextIp() }, body: JSON.stringify({ events: [e, { uid: 'x' }] }) })
    const j = await res.json()
    assert.equal(res.status, 200)
    assert.deepEqual(j.data.accepted, [e.uid])
    assert.deepEqual(j.data.rejected, [{ uid: 'x', code: 'OV_ERROR_INVALID' }])
    assert.equal((await report(Array.from({ length: 21 }, () => event()))).status, 400)
    const foreign = await fetch(`${srv.base}/api/errors`, { method: 'POST', headers: { 'Content-Type': 'text/plain', Origin: 'https://evil.example', 'cf-connecting-ip': nextIp() }, body: JSON.stringify({ events: [event()] }) })
    assert.equal(foreign.status, 403)
    const form = await fetch(`${srv.base}/api/errors`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': nextIp() }, body: 'a=1' })
    assert.equal(form.status, 415)
  })

  it('a digest goes out: mail without names, a push, the bell for super admins', async () => {
    const mail = await smtp.waitForMail((m) => m.envelope.to.includes('admin@example.test') && m.text.includes(`#errors/${groupId}`))
    assert.match(mail.subject, /^\[OpenVolley\] (New error|\d+ errors in \d+ kinds)/)
    assert.match(mail.text, /NEW · OpenVolley · scorer · js\.error/)
    assert.match(mail.text, /scorer \(VBC Musterdorf\)/)
    for (const u of Object.values(users)) {
      assert.equal(mail.text.includes(u.email), false, 'no address in the mail')
      assert.equal(mail.text.includes(`${u.name} Tester`), false, 'no name in the mail')
    }
    assert.ok(mail.text.includes(`#errors/${groupId}`))
    // one push per digest: the group's own link, or the list's when the digest has more kinds
    const push = await waitUntil(() => pushes.find((p) => p.url === '/openvolley-errors' && /#errors(\/|$)/.test(p.headers.click || '')), { what: 'the push' })
    assert.match(push.headers.title, /^OpenVolley: /)
    assert.equal(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(push.body), false, 'no address in the push')
    const bell = await call(users.Root, 'GET', '/api/notifications?app=indoor')
    assert.equal(bell.status, 200, bell.text)
    const n = bell.json.data.notifications.find((x) => x.kind === 'error' && x.target === `errors/${groupId}`)
    assert.ok(n, bell.text)
    assert.match(n.error.title, /Cannot read properties/)
    const other = await call(users.Admin, 'GET', '/api/notifications?app=indoor')
    assert.equal(other.json.data.notifications.some((x) => x.kind === 'error'), false, 'an admin who is not a super admin gets no error notice')
  })

  it('the Errors tab: super admins only; events name the member, and the read is audited', async () => {
    assert.equal((await call(users.Admin, 'GET', '/api/admin/errors')).status, 403)
    assert.equal((await call(users.Scorer, 'GET', '/api/admin/errors')).status, 403)
    const list = await call(users.Root, 'GET', '/api/admin/errors')
    assert.equal(list.status, 200, list.text)
    const g = list.json.data.groups.find((x) => x.id === groupId)
    assert.ok(g)
    assert.equal(g.event_count, 1)
    assert.deepEqual(g.tools, ['scorer'])
    const detail = await call(users.Root, 'GET', `/api/admin/errors/${groupId}`)
    assert.equal(detail.status, 200, detail.text)
    assert.equal(detail.json.data.days.length, 14)
    assert.equal(detail.json.data.breakdowns.os[0].value, 'Android 15')
    const ev = await call(users.Root, 'GET', `/api/admin/errors/${groupId}/events`)
    assert.equal(ev.status, 200, ev.text)
    const m = ev.json.data.events[0].member
    assert.equal(m.email, users.Scorer.email)
    assert.equal(m.name, 'Scorer Tester')
    assert.deepEqual(m.clubs.map((c) => c.name), ['VBC Musterdorf'])
    const { rows } = await sql.query(`SELECT actor_id, details FROM public.audit_log WHERE action = 'errors.read' ORDER BY id DESC LIMIT 1`)
    assert.equal(rows[0].actor_id, users.Root.id)
  })

  it('resolved in a version: older versions stay quiet, the version itself brings it back', async () => {
    const done = await call(users.Root, 'PATCH', `/api/admin/errors/${groupId}`, { status: 'resolved', resolved_in_version: '3.4.3', note: 'fixed in #999' })
    assert.equal(done.status, 200, done.text)
    assert.equal(done.json.data.group.status, 'resolved')
    await report([event({ app_version: '3.4.2' })])
    let { rows: [g] } = await sql.query('SELECT status, regressed FROM public.error_groups WHERE id = $1', [groupId])
    assert.equal(g.status, 'resolved')
    await report([event({ app_version: '3.4.3' })])
    ;({ rows: [g] } = await sql.query('SELECT status, regressed FROM public.error_groups WHERE id = $1', [groupId]))
    assert.equal(g.status, 'open')
    assert.equal(g.regressed, true)
    const back = await smtp.waitForMail((m) => /REGRESSION/.test(m.text) && m.text.includes(`#errors/${groupId}`))
    assert.match(back.subject, /Error is back|errors in/)
  })

  it('muted: no digest; delete on request; the server\'s own errors are grouped too', async () => {
    assert.equal((await call(users.Root, 'PATCH', `/api/admin/errors/${groupId}`, { status: 'muted', mute: '24h' })).status, 200)
    const mailsOf = () => smtp.mails.filter((m) => m.text.includes(`#errors/${groupId}`)).length
    const before = mailsOf()
    await report([event({ app_version: '3.4.4' })])
    await sleep(2500)
    assert.equal(mailsOf(), before, 'a muted group sends no digest')

    const del = await call(users.Root, 'DELETE', `/api/admin/errors/events?account=${users.Scorer.id}&confirm=yes`)
    assert.equal(del.status, 200, del.text)
    assert.ok(del.json.data.deleted >= 1)
    const { rows: [left] } = await sql.query('SELECT count(*)::int AS n FROM public.error_events WHERE account_id = $1', [users.Scorer.id])
    assert.equal(left.n, 0)

    const tracker = createErrorTracker({ pool, log: quiet })
    const s1 = await tracker.captureServer(new Error('vm sync exploded 1234567'), { kind: 'job.failed', view: 'vm sync' })
    const s2 = await tracker.captureServer(new Error('vm sync exploded 7654321'), { kind: 'job.failed', view: 'vm sync' })
    assert.equal(s1.groupId, s2.groupId)
    const { rows: [sg] } = await sql.query('SELECT source, event_count FROM public.error_groups WHERE id = $1', [s1.groupId])
    assert.equal(sg.source, 'server')
    assert.equal(Number(sg.event_count), 2)
  })

  it('every answer carries its request id, readable cross-origin', async () => {
    const r = await fetch(`${srv.base}/health/live`)
    assert.match(r.headers.get('x-request-id') || '', /^[0-9a-f]{12}$/)
  })
})
