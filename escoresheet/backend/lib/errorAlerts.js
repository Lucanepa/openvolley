/**
 * errorAlerts — tells the owner about errors (lib/errorTracker.js, db/050).
 *
 * Owner, 2026-11-19: an e-mail digest to admin@openvolley.app, a phone push
 * (the owner's ntfy) and the manager's bell; the mail and the push name the
 * member's roles and clubs only, never a name or an address.
 *
 * A port of svrz_rc's server/erroralerts.ts with its weak spots fixed: the
 * state is in the database (error_groups.alert_due_at / last_alert_at), so a
 * restart or a failed send loses nothing.
 *
 *   tick() (server.js: every minute, cloud only)
 *     1. the due groups (lib/errorTracker.js dueAlerts: a new error, one back
 *        after "resolved", one still happening a day after its last alert;
 *        the first error of a burst waits ALERT_DEBOUNCE_MS, two minutes, so
 *        its burst arrives as one digest);
 *     2. a group alerted less than an hour ago waits for that hour (cooldown);
 *     3. at most MAX_PER_HOUR digests an hour (counted from the audit log's
 *        errors.alert entries, so also across a restart); over it, they wait
 *        a quarter of an hour; a group only reports without a session fed
 *        (error_groups.anonymous, db/054) rides along at most
 *        ANONYMOUS_PER_MAIL a mail and only in the first MAX_PER_HOUR -
 *        ANONYMOUS_RESERVE digests of an hour, so junk reports cannot use up
 *        the hour's digests;
 *     4. the mail; when it fails, nothing is marked: the next tick tries again
 *        (and only then the push and the bell, so they are never repeated);
 *     5. the push to ntfy (best effort, logged when it fails);
 *     6. one bell notice per super admin and group (db/028 kind 'error',
 *        page errors/<id>), brought back unread when the group alerts again;
 *     7. the groups marked alerted; an errors.alert audit entry (counts only).
 *   suppressed (TEST_MODE=1): nothing is sent; the log says what would have
 *   been, and the groups are marked as if it had.
 *
 * Reported text (titles, views, breadcrumbs) is one line each and links to
 * other hosts are [link] (lib/errorTracker.js redactText); the subject says
 * only the count, the kind and the tool, so a report cannot write the
 * owner's subject or an "Open:" line of its own (SEC-33).
 *
 * Configuration (deploy/env.example):
 *   ERROR_ALERTS            on (default in cloud mode) | off
 *   ERROR_ALERT_EMAIL       the digest's recipient (admin@openvolley.app); empty = no mail
 *   NTFY_URL, NTFY_TOPIC    the push (e.g. https://ntfy.example:8445, openvolley-errors); empty = no push
 *   NTFY_TOKEN              optional access token of the topic (secret)
 *   NTFY_ADDRESS            optional: the address to connect to for NTFY_URL's host, the name
 *                           still used for TLS and Host (the owner's ntfy is a tailnet name the
 *                           backend's DNS resolves to public addresses: NTFY_ADDRESS=100.x.y.z)
 */
import https from 'node:https'
import http from 'node:http'
import { isIP } from 'node:net'
import { deviceLine } from './errorTracker.js'

export const COOLDOWN_MS = 60 * 60 * 1000
export const MAX_PER_HOUR = 6
export const CEILING_RETRY_MS = 15 * 60 * 1000
export const MAX_GROUPS_PER_MAIL = 12
// Groups only reports without a session have fed (anyone can send one,
// SEC-33) get a smaller share of the digests: at most this many in a mail,
// and only while fewer than MAX_PER_HOUR - ANONYMOUS_RESERVE digests went out
// in the last hour (the rest of the hour is kept for the others)
export const ANONYMOUS_PER_MAIL = 4
export const ANONYMOUS_RESERVE = 3
const PUSH_TIMEOUT_MS = 8000

const REASON_LABEL = { new: 'NEW', regression: 'REGRESSION', ongoing: 'STILL HAPPENING' }
const TOOL_LABEL = {
  scorer: 'scorer', referee: 'referee app', bench: 'bench app', livescore: 'livescore', scoresheet: 'scoresheet',
  dictate: 'dictate', roster: 'roster upload', manager: 'manager', tv: 'TV live screen', scoreboard: 'scoreboard',
  board: 'Point Hub board', other: 'app', server: 'backend', render: 'render service'
}
const PRODUCT_LABEL = { openvolley: 'OpenVolley', openbeach: 'OpenBeach' }

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const cut = (s, n) => {
  const t = String(s ?? '')
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}
// A reported text on one line (a group stored before redactText made it so
// included): a report never adds a line of its own to the digest (SEC-33)
// eslint-disable-next-line no-control-regex
const flat = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, ' ')
/** "3× js.error · scorer": what a subject says of a group (no reported text) */
const whatOf = (a) => {
  const tools = (a.tools?.length ? a.tools : [a.last?.tool]).filter(Boolean).map((t) => TOOL_LABEL[t] || 'app')
  return `${a.count}× ${a.group.kind}${tools.length ? ` · ${[...new Set(tools)].join(', ')}` : ''}`
}

/** "referee · VBC Musterdorf", "guest", "2 members: scorer (VBC Musterdorf); referee" */
export function whoLine(a) {
  const members = (a.members || []).map((m) => {
    const roles = (m.roles || []).filter((r) => r !== 'super_admin' && r !== 'admin').join(', ') || ((m.roles || []).length ? 'admin' : 'no role')
    return m.clubs?.length ? `${roles} (${m.clubs.join(', ')})` : roles
  })
  const parts = []
  if (members.length === 1 && !a.guests) return members[0]
  if (members.length) parts.push(`${a.accounts} member${a.accounts === 1 ? '' : 's'}: ${members.join('; ')}`)
  if (a.guests) parts.push(a.group?.source === 'server' ? (members.length ? 'and requests without a session' : 'no session') : `${members.length ? 'and ' : ''}guest${a.guests === 1 ? '' : 's'} (not signed in)`)
  return parts.join(' ') || (a.group?.source === 'server' ? 'no session' : 'guest (not signed in)')
}

/** The link that opens a group in the manager's Errors tab. */
export function groupLink(managerUrl, id) {
  return `${String(managerUrl || 'https://manager.openvolley.app').replace(/\/+$/, '')}/#errors/${id}`
}

function whenLine(a) {
  const first = a.since ? new Date(a.since) : null
  const last = a.last?.at ? new Date(a.last.at) : null
  const f = (d) => d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  if (first && last && last - first > 60 * 1000) return `${f(first)} → ${f(last)}`
  return last ? f(last) : first ? f(first) : ''
}

/** The top 5 frames, each in its readable form where a source map gave one (lib/sourceMaps.js). */
function readableFrames(e) {
  const frames = Array.isArray(e?.frames) ? e.frames.slice(0, 5) : []
  return frames.map((f, i) => (Array.isArray(e.frames_source) && e.frames_source[i]) || f)
}

/** One group of a digest as plain lines. */
function groupLines(a, managerUrl) {
  const g = a.group
  const e = a.last || {}
  const lines = [
    `── ${a.count}× ${REASON_LABEL[a.reason] || 'NEW'} · ${PRODUCT_LABEL[g.product] || g.product} · ${(a.tools.length ? a.tools : [e.tool]).filter(Boolean).map((t) => TOOL_LABEL[t] || t).join(', ')} · ${g.kind}`,
    `   ${cut(flat(g.title), 300)}`,
    `   When: ${whenLine(a)}`,
    `   Version: ${flat(a.versions.length ? a.versions.join(', ') : (e.app_version || '–'))}${e.build ? ` (build ${flat(String(e.build).slice(0, 12))})` : ''}`,
    `   Device: ${flat(deviceLine(e)) || '–'}${a.devices > 1 ? ` (${a.devices} devices)` : ''}`,
    `   Who: ${flat(whoLine(a))}`
  ]
  if (e.view) lines.push(`   Where: ${flat(e.view)}`)
  if (e.match_external_id) lines.push(`   Match: ${flat(e.match_external_id)}`)
  if (e.request_id) lines.push(`   Request id: ${flat(e.request_id)}`)
  const frames = readableFrames(e)
  if (frames.length) lines.push('   Stack:', ...frames.map((f) => `     ${flat(f)}`))
  const crumbs = Array.isArray(e.breadcrumbs) ? e.breadcrumbs.slice(-8) : []
  if (crumbs.length) lines.push('   Before it:', ...crumbs.map((b) => `     ${b.t ? flat(String(b.t).slice(11, 19)) + '  ' : ''}${flat(b.c)}: ${flat(b.m)}`))
  lines.push(`   Open: ${groupLink(managerUrl, g.id)}`)
  return lines
}

/**
 * The digest mail of some due groups: { subject, text, html }. Names no
 * member (roles and clubs only). The subject carries no reported text, only
 * the count, the kind and the tool (SEC-33).
 */
export function renderDigest(alerts, { managerUrl } = {}) {
  const shown = alerts.slice(0, MAX_GROUPS_PER_MAIL)
  const total = alerts.reduce((n, a) => n + a.count, 0)
  const head = shown[0]
  const product = PRODUCT_LABEL[head?.group.product] || 'OpenVolley'
  const subject = alerts.length === 1
    ? `[${product}] ${head.reason === 'regression' ? 'Error is back' : head.reason === 'ongoing' ? 'Error still happening' : 'New error'} — ${whatOf(head)}`
    : `[${product}] ${total} errors in ${alerts.length} kinds — ${whatOf(head)}, …`
  const intro = `${total} error${total === 1 ? '' : 's'} in ${alerts.length} kind${alerts.length === 1 ? '' : 's'}.`
  const text = [
    intro,
    '',
    ...shown.flatMap((a) => [...groupLines(a, managerUrl), '']),
    ...(alerts.length > shown.length ? [`… and ${alerts.length - shown.length} more kinds in the Errors tab.`, ''] : []),
    `All errors: ${String(managerUrl || 'https://manager.openvolley.app').replace(/\/+$/, '')}/#errors`,
    '',
    'This message comes from the OpenVolley backend itself. A kind of error alerts again',
    'at the earliest an hour later (a day later while it keeps happening); mute it or',
    'mark it resolved in the manager\'s Errors tab.'
  ].join('\n') + '\n'

  const chip = (label, bg, fg = '#ffffff') => `<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:${bg};color:${fg};font-size:12px;font-weight:600;margin-right:4px">${escapeHtml(label)}</span>`
  const row = (k, v) => (v ? `<tr><td style="padding:2px 12px 2px 0;color:#78716c;vertical-align:top;white-space:nowrap">${escapeHtml(k)}</td><td style="padding:2px 0;color:#1c1917">${escapeHtml(v)}</td></tr>` : '')
  const card = (a) => {
    const g = a.group
    const e = a.last || {}
    const frames = readableFrames(e)
    const crumbs = Array.isArray(e.breadcrumbs) ? e.breadcrumbs.slice(-8) : []
    const reasonBg = a.reason === 'regression' ? '#b45309' : a.reason === 'ongoing' ? '#57534e' : '#e2001a'
    return '<div style="border:1px solid #e7e5e4;border-left:4px solid ' + reasonBg + ';border-radius:8px;padding:12px 14px;margin:0 0 14px">' +
      `<div style="margin:0 0 6px">${chip(`${a.count}×`, '#1c1917')}${chip(REASON_LABEL[a.reason] || 'NEW', reasonBg)}${chip(PRODUCT_LABEL[g.product] || g.product, '#f5f5f4', '#1c1917')}${chip(g.source === 'server' ? 'Server' : 'App', '#f5f5f4', '#1c1917')}</div>` +
      `<div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:#57534e">${escapeHtml(g.kind)}</div>` +
      `<div style="font-weight:600;margin:4px 0 8px;word-break:break-word">${escapeHtml(cut(flat(g.title), 300))}</div>` +
      '<table style="border-collapse:collapse;font-size:13px;margin:0 0 8px">' +
      row('Tool', (a.tools.length ? a.tools : [e.tool]).filter(Boolean).map((t) => TOOL_LABEL[t] || t).join(', ')) +
      row('When', whenLine(a)) +
      row('Version', (a.versions.length ? a.versions.join(', ') : (e.app_version || '')) + (e.build ? ` (build ${String(e.build).slice(0, 12)})` : '')) +
      row('Device', (deviceLine(e) || '') + (a.devices > 1 ? ` (${a.devices} devices)` : '')) +
      row('Who', whoLine(a)) +
      row('Where', e.view) +
      row('Match', e.match_external_id) +
      row('Request id', e.request_id) +
      '</table>' +
      (crumbs.length
        ? '<div style="font-size:12px;color:#78716c;margin:0 0 4px">Before it</div><table style="border-collapse:collapse;font-size:12px;margin:0 0 8px">' +
          crumbs.map((b) => `<tr><td style="padding:1px 10px 1px 0;color:#78716c;font-family:ui-monospace,Menlo,Consolas,monospace">${escapeHtml(b.t ? String(b.t).slice(11, 19) : '')}</td><td style="padding:1px 8px 1px 0;color:#78716c">${escapeHtml(b.c)}</td><td style="padding:1px 0">${escapeHtml(b.m)}</td></tr>`).join('') + '</table>'
        : '') +
      (frames.length ? `<pre style="margin:0 0 8px;padding:8px 10px;background:#1c1917;color:#f5f5f4;border-radius:6px;font-size:11px;line-height:1.45;white-space:pre-wrap;word-break:break-all">${escapeHtml(frames.join('\n'))}</pre>` : '') +
      `<a href="${escapeHtml(groupLink(managerUrl, g.id))}" style="display:inline-block;background:#e2001a;color:#ffffff;text-decoration:none;font-weight:600;padding:8px 14px;border-radius:8px;font-size:13px">Open in Errors</a>` +
      '</div>'
  }
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>' +
    '<body style="margin:0;padding:24px;background:#fafaf9;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1c1917">' +
    '<div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e7e5e4;border-radius:12px;padding:20px">' +
    `<div style="font-weight:700;font-size:16px;margin:0 0 4px">${escapeHtml(product)} errors</div>` +
    `<p style="margin:0 0 16px;color:#57534e">${escapeHtml(intro)}</p>` +
    shown.map(card).join('') +
    (alerts.length > shown.length ? `<p style="margin:0 0 12px;color:#57534e">… and ${alerts.length - shown.length} more kinds in the Errors tab.</p>` : '') +
    `<p style="margin:16px 0 0;font-size:12px;color:#78716c">This message comes from the OpenVolley backend itself. A kind of error alerts again at the earliest an hour later (a day later while it keeps happening); mute it or mark it resolved in the manager's <a href="${escapeHtml(String(managerUrl || 'https://manager.openvolley.app').replace(/\/+$/, '') + '/#errors')}" style="color:#57534e">Errors tab</a>.</p>` +
    '</div></body></html>'
  return { subject, text, html }
}

/** The phone push of a digest: { title, body, click, priority, tags }. No name, no address. */
export function renderPush(alerts, { managerUrl } = {}) {
  const head = alerts[0]
  const total = alerts.reduce((n, a) => n + a.count, 0)
  const product = PRODUCT_LABEL[head.group.product] || 'OpenVolley'
  const e = head.last || {}
  const title = alerts.length === 1
    // ASCII only: the title travels in an HTTP header
    ? `${product}: ${head.reason === 'regression' ? 'error is back' : head.reason === 'ongoing' ? 'error still happening' : 'new error'}${head.count > 1 ? ` (${head.count}x)` : ''}`
    : `${product}: ${total} errors in ${alerts.length} kinds`
  const where = [TOOL_LABEL[e.tool] || e.tool, [e.os_name, e.os_version].filter(Boolean).join(' ') || e.platform, e.app_version].filter(Boolean).join(' · ')
  const body = cut(`${flat(head.group.title)}\n${flat(where)}`, 300) + (alerts.length > 1 ? `\n+${alerts.length - 1} more` : '')
  // high: the server failing, an error back after "resolved", or the scorer during a match
  const urgent = alerts.some((a) => a.group.source === 'server' || a.reason === 'regression' || a.duringMatch)
  return {
    title,
    body,
    click: alerts.length === 1 ? groupLink(managerUrl, head.group.id) : `${String(managerUrl || 'https://manager.openvolley.app').replace(/\/+$/, '')}/#errors`,
    priority: urgent ? 4 : 3,
    tags: urgent ? 'rotating_light' : 'warning'
  }
}

/**
 * A fetch-like POST that connects to `address` instead of resolving the
 * URL's host (TLS and the Host header keep the name): { ok, status }.
 */
export function postVia(address, url, { method = 'POST', body = '', headers = {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? https : http
    const family = isIP(address) || 4
    const req = lib.request(u, {
      method,
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      lookup: (_host, opts, cb) => (opts && opts.all ? cb(null, [{ address, family }]) : cb(null, address, family))
    }, (res) => {
      res.resume()
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }))
    })
    req.on('error', reject)
    signal?.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true })
    req.end(body)
  })
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./errorTracker.js').createErrorTracker>} deps.tracker
 * @param {import('pg').Pool} deps.pool
 * @param {{ enabled: boolean, sendOps?: Function }} [deps.mailer]
 * @param {string} [deps.to]           ERROR_ALERT_EMAIL
 * @param {string} [deps.managerUrl]
 * @param {{ url?: string, topic?: string, token?: string, address?: string }} [deps.ntfy]
 * @param {Function} [deps.audit]      accounts.audit
 * @param {boolean} [deps.suppressed]  TEST_MODE: log only
 */
export function createErrorAlerts({ tracker, pool, mailer = null, to = '', managerUrl = 'https://manager.openvolley.app', ntfy = {}, audit = null, log = console, now = Date.now, suppressed = false, cooldownMs = COOLDOWN_MS, maxPerHour = MAX_PER_HOUR, anonymousPerMail = ANONYMOUS_PER_MAIL, anonymousReserve = ANONYMOUS_RESERVE, fetchImpl = globalThis.fetch } = {}) {
  const recipient = typeof to === 'string' && to.includes('@') ? to.trim() : ''
  const pushUrl = ntfy?.url && ntfy?.topic ? `${String(ntfy.url).replace(/\/+$/, '')}/${encodeURIComponent(String(ntfy.topic))}` : ''
  // NTFY_ADDRESS: connect there, keep the name (a tailnet name public DNS does not resolve to the tailnet)
  const pushAddress = typeof ntfy?.address === 'string' && isIP(ntfy.address.trim()) ? ntfy.address.trim() : ''
  const send = pushAddress ? (url, init) => postVia(pushAddress, url, init) : fetchImpl
  const counters = { digests: 0, mailFailed: 0, pushFailed: 0, deferred: 0, suppressed: 0, lastSentAt: null }
  let running = false

  async function sentLastHour() {
    const { rows: [c] } = await pool.query(
      `SELECT count(*)::int AS n FROM public.audit_log WHERE action = 'errors.alert' AND at > $1::timestamptz - interval '1 hour'`,
      [new Date(now()).toISOString()])
    return Number(c?.n) || 0
  }

  async function push(alerts) {
    if (!pushUrl || typeof send !== 'function') return false
    const p = renderPush(alerts, { managerUrl })
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), PUSH_TIMEOUT_MS)
    try {
      // header values are ASCII only (ntfy reads UTF-8 titles from the X-Title
      // header too, but proxies may not): the title goes RFC 2047-encoded
      const res = await send(pushUrl, {
        method: 'POST',
        body: p.body,
        headers: {
          Title: /^[\x20-\x7e]*$/.test(p.title) ? p.title : `=?UTF-8?B?${Buffer.from(p.title).toString('base64')}?=`,
          Click: p.click,
          Priority: String(p.priority),
          Tags: p.tags,
          ...(ntfy.token ? { Authorization: `Bearer ${ntfy.token}` } : {})
        },
        signal: ctrl.signal
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return true
    } catch (err) {
      counters.pushFailed++
      log.warn?.(`[errors] push failed: ${String(err?.message || err).slice(0, 120)}`)
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  /** One bell notice per super admin and group, back to unread when it alerts again. */
  async function ring(alerts) {
    try {
      const { rows: admins } = await pool.query(
        `SELECT p.user_id FROM public.profiles p JOIN auth.users u ON u.id = p.user_id
          WHERE p.roles @> ARRAY['super_admin']::text[]
            AND coalesce((to_jsonb(u) ->> 'banned_until')::timestamptz <= now(), true)`)
      if (!admins.length) return 0
      let n = 0
      for (const a of alerts) {
        const details = JSON.stringify({ title: cut(flat(a.group.title), 160), count: a.count, reason: a.reason, product: a.group.product, kind: a.group.kind, tools: a.tools })
        const r = await pool.query(
          `INSERT INTO public.notifications (user_id, kind, app, target, details)
           SELECT x, 'error', $2, $3, $4::jsonb FROM unnest($1::uuid[]) AS x
           ON CONFLICT (user_id, target) WHERE kind = 'error'
           DO UPDATE SET read_at = NULL, created_at = now(), details = EXCLUDED.details`,
          [admins.map((x) => x.user_id), 'indoor', `errors/${a.group.id}`, details])
        n += r.rowCount || 0
      }
      return n
    } catch (err) {
      log.warn?.(`[errors] bell failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 120)}`)
      return 0
    }
  }

  /** One pass (server.js: every minute). Never throws. */
  async function tick() {
    if (running) return { skipped: 'running' }
    running = true
    try {
      const due = await tracker.dueAlerts({ limit: MAX_GROUPS_PER_MAIL * 2 })
      if (!due.length) return { due: 0 }
      const t = now()
      // the cooldown: a group alerted less than an hour ago waits for that hour
      const cooling = due.filter((a) => a.group.last_alert_at && t - Date.parse(a.group.last_alert_at) < cooldownMs)
      for (const a of cooling) await tracker.deferAlerts([a.group.id], Date.parse(a.group.last_alert_at) + cooldownMs)
      const ready = due.filter((a) => !cooling.includes(a))
      if (!ready.length) return { due: due.length, cooling: cooling.length }
      const sent = suppressed ? 0 : await sentLastHour()
      if (sent >= maxPerHour) {
        counters.deferred += ready.length
        await tracker.deferAlerts(ready.map((a) => a.group.id), t + CEILING_RETRY_MS)
        log.warn?.(`[errors] ${maxPerHour} digests in the last hour: ${ready.length} kind(s) wait ${CEILING_RETRY_MS / 60000} min`)
        return { due: due.length, deferred: ready.length }
      }
      // the groups only reports without a session fed: a few a mail, and not
      // in the digests the hour keeps for the others; they wait meanwhile
      const known = ready.filter((a) => !a.group.anonymous)
      const anonymous = ready.filter((a) => a.group.anonymous)
      const anonymousMay = sent < maxPerHour - anonymousReserve
      const batch = known.slice(0, MAX_GROUPS_PER_MAIL)
      if (anonymousMay) batch.push(...anonymous.slice(0, Math.max(0, Math.min(anonymousPerMail, MAX_GROUPS_PER_MAIL - batch.length))))
      if (!anonymousMay && anonymous.length) {
        counters.deferred += anonymous.length
        await tracker.deferAlerts(anonymous.map((a) => a.group.id), t + CEILING_RETRY_MS)
      }
      if (!batch.length) return { due: due.length, deferred: anonymous.length }
      const digest = renderDigest(batch, { managerUrl })
      if (suppressed) {
        counters.suppressed++
        log.log?.(`[errors] alert suppressed (TEST_MODE): ${digest.subject}`)
        await tracker.markAlerted(batch.map((a) => a.group.id))
        return { due: due.length, suppressed: batch.length }
      }
      let mailed = false
      if (recipient && mailer?.enabled && typeof mailer.sendOps === 'function') {
        try {
          const r = await mailer.sendOps({ to: recipient, ...digest })
          mailed = r?.sent === true
          if (!mailed) log.warn?.(`[errors] digest not mailed (${r?.skipped || 'unknown'})`)
        } catch (err) {
          counters.mailFailed++
          log.warn?.(`[errors] digest mail failed, next minute again: ${String(err?.code || err?.message || err).slice(0, 120)}`)
          return { due: due.length, mailFailed: batch.length }
        }
      }
      const pushed = await push(batch)
      const rung = await ring(batch)
      await tracker.markAlerted(batch.map((a) => a.group.id))
      counters.digests++
      counters.lastSentAt = new Date(t).toISOString()
      if (audit) {
        try {
          await audit(null, { actorId: null, action: 'errors.alert', details: { groups: batch.length, events: batch.reduce((n, a) => n + a.count, 0), mailed, pushed, bell: rung } })
        } catch (err) {
          log.warn?.(`[errors] alert audit failed: ${err?.code || err?.message}`)
        }
      }
      log.log?.(`[errors] digest: ${batch.length} kind(s), mail ${mailed ? 'sent' : 'no'}, push ${pushed ? 'sent' : 'no'}, bell ${rung}`)
      return { due: due.length, sent: batch.length, mailed, pushed, bell: rung }
    } catch (err) {
      log.warn?.(`[errors] alert pass failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 160)}`)
      return { failed: true }
    } finally {
      running = false
    }
  }

  return {
    tick,
    stats: () => ({ ...counters, mail: Boolean(recipient && mailer?.enabled), push: Boolean(pushUrl), suppressed })
  }
}
