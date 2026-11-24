/**
 * The operator's error digest (lib/errorAlerts.js) and what a report may put
 * into it (lib/errorTracker.js redactText, audit SEC-33). Anyone may report
 * an error. Before, a report's message became the mail's subject, kept full
 * links and its line breaks, so "Scoreboard failed\n\n   Open: https://..."
 * added an "Open:" line of its own next to the real one, and junk groups
 * could use up the hour's digests.
 *
 * From the audit's poc/errors-logs/redact-probe.mjs and mail-routes-6.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { redactText, checkClientEvent, cleanBreadcrumbs } from '../lib/errorTracker.js'
import { renderDigest, renderPush, createErrorAlerts, groupLink, ANONYMOUS_PER_MAIL, ANONYMOUS_RESERVE, MAX_PER_HOUR } from '../lib/errorAlerts.js'

const PHISH = 'Scoreboard failed\r\n\r\n   Open: https://0penvolley.app/fix\nline3'
const event = (over = {}) => ({
  uid: randomUUID(),
  client_ts: new Date().toISOString(),
  kind: 'js.error',
  level: 'error',
  product: 'openvolley',
  tool: 'scorer',
  message: 'x',
  ...over
})
const alertOf = (over = {}, group = {}) => ({
  group: { id: randomUUID(), product: 'openvolley', source: 'client', kind: 'js.error', title: 'TypeError: x is undefined', last_alert_at: null, ...group },
  reason: 'new',
  since: new Date(Date.now() - 60000).toISOString(),
  count: 3,
  tools: ['scorer'],
  versions: ['3.4.2'],
  devices: 1,
  accounts: 0,
  guests: 1,
  duringMatch: false,
  last: { ...checkClientEvent(event()).row, at: new Date().toISOString() },
  members: [],
  ...over
})

describe('error digest: reported text (SEC-33)', () => {
  it('one line, and a link to another host becomes [link]; OpenVolley\'s own hosts stay', () => {
    assert.equal(redactText('line1\r\nOpen: https://evil.example/phish\nline3'), 'line1 Open: [link] line3')
    assert.equal(redactText('Backup key leaked: rotate it now at https://ov-admin-rotate.example/login'), 'Backup key leaked: rotate it now at [link]')
    assert.equal(redactText('see www.evil.example/x and javascript:alert(1)'), 'see [link] and [link]')
    assert.equal(redactText('https://openvolley.app.evil.example/x'), '[link]')
    assert.equal(redactText('GET https://backend.openvolley.app/api/x?token=abc failed'), 'GET https://backend.openvolley.app/api/x failed')
    assert.equal(redactText('tab\tand separator'), 'tab and separator')
    const row = checkClientEvent(event({ message: PHISH, breadcrumbs: [{ c: 'app', m: 'a\nOpen: https://evil.example' }] })).row
    assert.equal(row.message, 'Scoreboard failed Open: [link] line3')
    assert.deepEqual(cleanBreadcrumbs([{ c: 'app', m: 'a\nOpen: https://evil.example' }]), [{ c: 'app', m: 'a Open: [link]' }])
    assert.equal(row.breadcrumbs[0].m, 'a Open: [link]')
  })

  it('the subject names the count, kind and tool only; no reported line becomes a line of the mail', () => {
    // a group as a version before this fix stored it: the title with its line breaks
    const a = alertOf({ last: { ...checkClientEvent(event({ view: 'scoreboard' })).row, at: new Date().toISOString(), view: 'x\n   Open: https://evil.example/v', breadcrumbs: [{ c: 'app', m: 'b\r\n   Open: https://evil.example/b' }] } }, { title: PHISH })
    const d = renderDigest([a], { managerUrl: 'https://manager.example' })
    assert.equal(d.subject, '[OpenVolley] New error — 3× js.error · scorer')
    assert.ok(!d.subject.includes('Scoreboard'))
    const open = d.text.split('\n').filter((l) => /^\s*Open:/.test(l))
    assert.deepEqual(open, [`   Open: ${groupLink('https://manager.example', a.group.id)}`])
    assert.ok(!d.text.split('\n').some((l) => /^\s*line3/.test(l)))
    const two = renderDigest([a, alertOf({ reason: 'regression' })], { managerUrl: 'https://manager.example' })
    assert.equal(two.subject, '[OpenVolley] 6 errors in 2 kinds — 3× js.error · scorer, …')
    assert.equal(two.text.split('\n').filter((l) => /^\s*Open:/.test(l)).length, 2)
    // the push: the title on one line, then the device line
    const p = renderPush([a])
    assert.equal(p.body.split('\n').length, 2)
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
const fakePool = (sentLastHour) => ({
  async query(sql) {
    if (/FROM public\.audit_log/.test(sql)) return { rows: [{ n: sentLastHour }] }
    return { rows: [], rowCount: 0 }
  }
})
const quiet = { log() {}, warn() {}, error() {} }

describe('error digest: groups only guests fed get a smaller share (SEC-33)', () => {
  const pass = (due, sent) => {
    const tracker = fakeTracker(due)
    const mails = []
    const alerts = createErrorAlerts({
      tracker, pool: fakePool(sent), to: 'admin@example.test', log: quiet,
      mailer: { enabled: true, async sendOps(m) { mails.push(m); return { sent: true } } }
    })
    return { tracker, mails, alerts }
  }

  it('a few of them in a mail, after the others', async () => {
    const known = alertOf({}, { title: 'a scorer\'s crash' })
    const junk = Array.from({ length: 9 }, (_, i) => alertOf({}, { anonymous: true, title: `junk ${i}` }))
    const { tracker, mails, alerts } = pass([...junk, known], 0)
    const r = await alerts.tick()
    assert.equal(r.sent, 1 + ANONYMOUS_PER_MAIL)
    assert.equal(tracker.calls.marked[0], known.group.id)
    assert.equal(tracker.calls.marked.length, 1 + ANONYMOUS_PER_MAIL)
    assert.match(mails[0].text, /a scorer's crash/)
    // the rest stays due for the next pass
    assert.deepEqual(tracker.calls.deferred, [])
  })

  it('late in the hour only the others go; the guests\' groups wait', async () => {
    const t = Date.now()
    const known = alertOf({}, { title: 'a scorer\'s crash' })
    const junk = alertOf({}, { anonymous: true })
    const late = pass([junk, known], MAX_PER_HOUR - ANONYMOUS_RESERVE)
    const r = await late.alerts.tick()
    assert.equal(r.sent, 1)
    assert.deepEqual(late.tracker.calls.marked, [known.group.id])
    assert.deepEqual(late.tracker.calls.deferred[0].ids, [junk.group.id])
    assert.ok(late.tracker.calls.deferred[0].until >= t)

    const only = pass([alertOf({}, { anonymous: true })], MAX_PER_HOUR - ANONYMOUS_RESERVE)
    const r2 = await only.alerts.tick()
    assert.equal(r2.deferred, 1)
    assert.equal(only.mails.length, 0)
    assert.deepEqual(only.tracker.calls.marked, [])
  })
})
