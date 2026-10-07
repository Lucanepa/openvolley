/**
 * eventRevisions — POST /api/match/event-revisions (db/015_event_revisions.sql).
 *
 * The scoring device sends one revision per undo / delete / edit / restore of
 * a logged event (frontend db/eventHistory.js). In ONE transaction, for each:
 *   1. the event row is locked (it may not be on the server yet),
 *   2. the revision is stored (idempotent by rev_uid; `applied` says whether
 *      the event was there; `before` is the server row as it was, never the
 *      state snapshot),
 *   3. void:    the event is marked voided (never deleted),
 *      edit:    type / set_index / seq / payload / score_a / score_b are rewritten,
 *      restore: the void is lifted (and the columns rewritten when given),
 *      each counting events.rev up.
 * A revision of an event that is not on the server is kept with applied=false;
 * db/015's insert trigger makes the event born voided when it arrives later.
 *
 * Body: { match_external_id, revisions: [{ rev_uid, op, event_external_id,
 *         reason, seq, set_index, type, client_ts, device_id, app_version, after? }] }
 * Answers 200 { data: { applied, pending } }, 400 OV_INVALID_REQUEST,
 * 403 OV_NOT_MATCH_OWNER / OV_SCORER_REQUIRED, 404 OV_MATCH_NOT_FOUND,
 * 409 OV_MATCH_CLOSED (db/007's guard).
 *
 * The caller (server.js) authenticates, rate-limits, reads the body (at most
 * MAX_BODY_BYTES) and resolves matchOwner. Never throws.
 */

import { createHash } from 'node:crypto'

export const MAX_REVISIONS = 200
export const MAX_BODY_BYTES = 256 * 1024

export const REVISION_OPS = Object.freeze(['void', 'edit', 'restore'])
export const REVISION_REASONS = Object.freeze([
  'undo', 'delete', 'decision_change', 'manual_adjustment',
  'forfeit_reversal', 'reopen_set', 'roster_reopen', 'correction', 'other'
])
const SCOPE_SEPARATORS = [':', '_']
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EDIT_KEYS = ['type', 'set_index', 'seq', 'payload', 'score_a', 'score_b']

const invalid = (details) => ({
  status: 400,
  body: { data: null, error: { message: 'Invalid request', code: 'OV_INVALID_REQUEST', details } }
})

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const optText = (v, max) => (v == null ? null : typeof v === 'string' && v.length <= max ? v : undefined)
const optInt = (v) => (v == null ? null : Number.isInteger(Number(v)) && Math.abs(Number(v)) < 1e6 ? Number(v) : undefined)
const optNum = (v) => (v == null ? null : Number.isFinite(Number(v)) && Math.abs(Number(v)) < 1e9 ? Number(v) : undefined)

/** Is the event id scoped to its match (`<match external_id><':' | '_'>...`)? */
export function isScopedToMatch(eventExt, matchExt) {
  if (typeof eventExt !== 'string' || typeof matchExt !== 'string' || !matchExt) return false
  if (eventExt.length <= matchExt.length || !eventExt.startsWith(matchExt)) return false
  return SCOPE_SEPARATORS.includes(eventExt[matchExt.length])
}

/** The columns an edit / restore writes, or undefined when `after` is malformed. */
export function editColumns(after) {
  if (after == null) return {}
  if (!isPlainObject(after)) return undefined
  const out = {}
  for (const k of Object.keys(after)) {
    if (!EDIT_KEYS.includes(k)) return undefined
  }
  if ('type' in after) {
    const t = optText(after.type, 64)
    if (t === undefined || t === null) return undefined
    out.type = t
  }
  if ('set_index' in after) {
    const v = optInt(after.set_index)
    if (v === undefined) return undefined
    out.set_index = v
  }
  if ('seq' in after) {
    const v = optNum(after.seq)
    if (v === undefined) return undefined
    out.seq = v
  }
  if ('payload' in after) {
    if (after.payload !== null && typeof after.payload !== 'object') return undefined
    out.payload = after.payload
  }
  for (const k of ['score_a', 'score_b']) {
    if (k in after) {
      const v = optInt(after[k])
      if (v === undefined) return undefined
      out[k] = v
    }
  }
  return out
}

/**
 * Validate the body. Returns { error } (a 400 answer) or { matchExt, revisions }.
 */
export function parseRevisionsBody(body) {
  if (!isPlainObject(body)) return { error: invalid('body must be an object') }
  const matchExt = body.match_external_id
  if (typeof matchExt !== 'string' || !matchExt || matchExt.length > 200) return { error: invalid('match_external_id') }
  const list = body.revisions
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_REVISIONS) {
    return { error: invalid(`revisions must be an array of 1 to ${MAX_REVISIONS}`) }
  }
  const revisions = []
  const seen = new Set()
  for (const [i, r] of list.entries()) {
    const bad = (what) => ({ error: invalid(`revisions[${i}].${what}`) })
    if (!isPlainObject(r)) return bad('(object)')
    if (typeof r.rev_uid !== 'string' || !UUID_RE.test(r.rev_uid)) return bad('rev_uid')
    if (seen.has(r.rev_uid.toLowerCase())) continue
    seen.add(r.rev_uid.toLowerCase())
    if (!REVISION_OPS.includes(r.op)) return bad('op')
    if (!REVISION_REASONS.includes(r.reason)) return bad('reason')
    if (typeof r.event_external_id !== 'string' || r.event_external_id.length > 200 || !isScopedToMatch(r.event_external_id, matchExt)) {
      return bad('event_external_id')
    }
    const ts = typeof r.client_ts === 'string' && r.client_ts.length <= 40 ? Date.parse(r.client_ts) : NaN
    if (!Number.isFinite(ts)) return bad('client_ts')
    const seq = optNum(r.seq)
    const setIndex = optInt(r.set_index)
    const type = optText(r.type, 64)
    const deviceId = optText(r.device_id, 64)
    const appVersion = optText(r.app_version, 32)
    if (seq === undefined) return bad('seq')
    if (setIndex === undefined) return bad('set_index')
    if (type === undefined) return bad('type')
    if (deviceId === undefined) return bad('device_id')
    if (appVersion === undefined) return bad('app_version')
    let after = null
    if (r.op !== 'void' && r.after != null) {
      after = editColumns(r.after)
      if (after === undefined) return bad('after')
    }
    if (r.op === 'edit' && (!after || Object.keys(after).length === 0)) return bad('after')
    revisions.push({
      revUid: r.rev_uid.toLowerCase(),
      op: r.op,
      reason: r.reason,
      eventExt: r.event_external_id,
      seq,
      setIndex,
      type,
      clientTs: new Date(ts).toISOString(),
      deviceId,
      appVersion,
      after
    })
  }
  return { matchExt, revisions }
}

const EVENT_COLUMNS = 'id, external_id, match_id, type, set_index, seq, payload, score_a, score_b, voided_at, voided_by, void_reason, rev'
// The realtime row of a changed event (the same columns /api/db writes publish)
const CHANGE_COLUMNS = 'id, external_id, match_id, set_index, type, seq, score_a, score_b, voided_at, void_reason, rev'

/**
 * The rev_uid of the void an /api/db delete of one event becomes: one per
 * event, so a retried delete is the same revision (idempotent by rev_uid).
 */
export function deleteRevUid(eventExt) {
  const h = createHash('sha256').update(`ov-event-delete:${eventExt}`).digest('hex')
  // UUID layout, version 5 / RFC 4122 variant bits
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/**
 * @param {object} db lib/pgQuery.js instance (withTransaction, assertMatchWritable, toErrorResult)
 */
export function createEventRevisions(db, { log = console } = {}) {
  /**
   * @param {{ body: object, user: {id:string}, matchOwner: object }} args
   * @returns {Promise<{status:number, body:object, changes?:Array}>}
   */
  async function apply({ body, user, matchOwner }) {
    const parsed = parseRevisionsBody(body)
    if (parsed.error) return parsed.error
    const { matchExt, revisions } = parsed
    try {
      const out = await db.withTransaction(async (client) => {
        await client.query("SELECT set_config('ov.user_id', $1, true)", [user.id])
        const match = await db.assertMatchWritable(client, matchExt, matchOwner)
        let applied = 0
        let pending = 0
        const changes = []
        for (const r of revisions) {
          const { rows: [ev] } = await client.query(
            `SELECT ${EVENT_COLUMNS} FROM public.events WHERE external_id = $1 AND match_id = $2 FOR UPDATE`,
            [r.eventExt, match.id])
          const before = ev
            ? { type: ev.type, set_index: ev.set_index, seq: ev.seq == null ? null : Number(ev.seq), payload: ev.payload, score_a: ev.score_a, score_b: ev.score_b, voided: ev.voided_at != null }
            : null
          const ins = await client.query(
            `INSERT INTO public.event_revisions
               (rev_uid, match_id, event_external_id, op, reason, event_seq, set_index, event_type,
                before, after, applied, actor_id, device_id, app_version, client_ts)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14, $15)
             ON CONFLICT (rev_uid) DO NOTHING
             RETURNING id`,
            [r.revUid, match.id, r.eventExt, r.op, r.reason, r.seq, r.setIndex, r.type,
              before ? JSON.stringify(before) : null, r.after ? JSON.stringify(r.after) : null,
              !!ev, user.id, r.deviceId, r.appVersion, r.clientTs])
          if (ins.rowCount === 0) continue // sent before (a retry): already handled
          if (!ev) {
            pending++
            continue
          }
          const sets = []
          const vals = []
          const p = (v) => { vals.push(v); return `$${vals.length}` }
          let where = ''
          if (r.op === 'void') {
            sets.push(`voided_at = ${p(r.clientTs)}`, `voided_by = ${p(user.id)}`, `void_reason = ${p(r.reason)}`)
            where = ' AND voided_at IS NULL'
          } else {
            if (r.op === 'restore') sets.push('voided_at = NULL', 'voided_by = NULL', 'void_reason = NULL')
            const cols = r.after || {}
            if ('type' in cols) sets.push(`type = ${p(cols.type)}`)
            if ('set_index' in cols) sets.push(`set_index = ${p(cols.set_index)}`)
            if ('seq' in cols) sets.push(`seq = ${p(cols.seq)}`)
            if ('payload' in cols) sets.push(`payload = ${p(cols.payload == null ? null : JSON.stringify(cols.payload))}::json`)
            if ('score_a' in cols) sets.push(`score_a = ${p(cols.score_a)}`)
            if ('score_b' in cols) sets.push(`score_b = ${p(cols.score_b)}`)
            if (r.op === 'restore') where = ' AND voided_at IS NOT NULL'
          }
          sets.push('rev = rev + 1')
          const upd = await client.query(
            `UPDATE public.events SET ${sets.join(', ')} WHERE id = ${p(ev.id)}${where} RETURNING ${CHANGE_COLUMNS}`, vals)
          if (upd.rowCount > 0) {
            applied++
            changes.push({ table: 'events', eventType: 'UPDATE', row: upd.rows[0] })
          }
        }
        return { applied, pending, changes }
      })
      return { status: 200, body: { data: { applied: out.applied, pending: out.pending }, error: null }, changes: out.changes }
    } catch (err) {
      const r = db.toErrorResult(err, { action: 'event-revisions', table: 'events' })
      if (r.status >= 500) log.warn?.('[event-revisions] failed:', err?.message)
      return { status: r.status, body: r.body }
    }
  }

  /** The revisions of a match (admin view), oldest first. */
  async function listForMatch({ matchId, limit = 2000 }) {
    if (typeof matchId !== 'string' || !UUID_RE.test(matchId)) return invalid('match id')
    try {
      const { rows } = await db.pool.query(
        `SELECT r.id, r.rev_uid, r.event_external_id, r.op, r.reason, r.event_seq, r.set_index, r.event_type,
                r.before, r.after, r.applied, r.actor_id, u.email AS actor_email, r.device_id, r.app_version,
                r.client_ts, r.at
           FROM public.event_revisions r
           LEFT JOIN auth.users u ON u.id = r.actor_id
          WHERE r.match_id = $1
          ORDER BY r.client_ts, r.id
          LIMIT $2`, [matchId, Math.min(Math.max(Number(limit) || 2000, 1), 5000)])
      return { status: 200, body: { data: rows, error: null } }
    } catch (err) {
      const r = db.toErrorResult(err, { action: 'select', table: 'event_revisions' })
      return { status: r.status, body: r.body }
    }
  }

  /**
   * An /api/db delete of ONE event by its external_id (apps that sent a
   * correction's removed event as a delete, before the event history): the
   * event is voided like a revision with the reason 'correction', never
   * deleted. Same owner / editor rule as the revision route. No event with
   * that id: nothing to do, like a delete that matched nothing.
   * @param {{ eventExt: string, user: {id:string}, matchOwner: object, clientTs?: string }} args
   * @returns {Promise<null|{status:number, body:object, changes?:Array}>} null: not handled
   */
  async function voidByExternalId({ eventExt, user, matchOwner, clientTs = new Date().toISOString() }) {
    if (typeof eventExt !== 'string' || !eventExt || eventExt.length > 200) return invalid('external_id')
    let matchExt
    try {
      const { rows: [row] } = await db.pool.query(
        `SELECT m.external_id FROM public.events e JOIN public.matches m ON m.id = e.match_id
          WHERE e.external_id = $1`, [eventExt])
      matchExt = row?.external_id
    } catch (err) {
      const r = db.toErrorResult(err, { action: 'select', table: 'events' })
      return { status: r.status, body: r.body }
    }
    if (!matchExt) return { status: 200, body: { data: null, error: null }, changes: [] }
    // an id not scoped to its match (never written by the app): the caller deletes as before
    if (!isScopedToMatch(eventExt, matchExt)) return null
    const r = await apply({
      body: {
        match_external_id: matchExt,
        revisions: [{ rev_uid: deleteRevUid(eventExt), op: 'void', event_external_id: eventExt, reason: 'correction', client_ts: clientTs }]
      },
      user,
      matchOwner
    })
    return r.status === 200 ? { status: 200, body: { data: null, error: null }, changes: r.changes } : r
  }

  return { apply, listForMatch, voidByExternalId }
}
