/**
 * The match activity log: what is recorded, and what each entry may carry.
 * Pure (no Dexie, no React). The server runs the same sanitizer
 * (escoresheet/backend/lib/activitySanitize.js, kept identical; a backend test
 * compares the two catalogs).
 *
 * Privacy (docs/legal, docs/activity-log-spec.md): never a PIN, password,
 * session token, signature image, date of birth, email, phone or licence
 * number; remarks only by length; personal data limited to what the
 * scoresheet already holds (player numbers, official names in a manual
 * change). Click and keystroke streams are NOT here (comprehensiveLogger,
 * local only).
 */

export const ACTIVITY_DATA_MAX_BYTES = 4096
export const ACTIVITY_STRING_MAX = 200
const MAX_DEPTH = 3
const MAX_ARRAY = 20

// kind -> { cat, keys } : category (UI filter) and the data keys it may carry
export const ACTIVITY_KINDS = Object.freeze({
  'event.add': { cat: 'scoring', keys: ['type', 'seq', 'set', 'team', 'playerIn', 'playerOut', 'player', 'sanction', 'libero', 'scoreA', 'scoreB'] },
  'event.bulk_add': { cat: 'scoring', keys: ['count', 'types'] },
  'event.undo': { cat: 'correction', keys: ['type', 'seq', 'set', 'reason', 'revUid', 'actionId'] },
  'event.delete': { cat: 'correction', keys: ['type', 'seq', 'set', 'reason', 'revUid', 'actionId'] },
  'event.edit': { cat: 'correction', keys: ['type', 'seq', 'set', 'reason', 'revUid', 'actionId', 'changed'] },
  'event.restore': { cat: 'correction', keys: ['type', 'seq', 'set', 'reason', 'revUid', 'actionId'] },
  'set.start': { cat: 'scoring', keys: ['set', 'home', 'away'] },
  'set.end': { cat: 'scoring', keys: ['set', 'home', 'away'] },
  'set.reopen': { cat: 'correction', keys: ['set', 'home', 'away'] },
  'set.delete': { cat: 'correction', keys: ['set', 'home', 'away'] },
  'match.create': { cat: 'match', keys: ['status', 'test'] },
  'match.status': { cat: 'match', keys: ['from', 'to'] },
  'match.close': { cat: 'match', keys: ['from', 'to'] },
  'match.coin_toss': { cat: 'match', keys: ['keys', 'confirmed'] },
  'match.manual_change': { cat: 'correction', keys: ['category', 'field', 'before', 'after'] },
  'match.signature': { cat: 'match', keys: ['role', 'signed'] },
  'match.approval': { cat: 'match', keys: ['role', 'method', 'approved'] },
  'match.remarks': { cat: 'match', keys: ['length'] },
  'match.forfeit': { cat: 'correction', keys: ['team', 'forfeit', 'stopped'] },
  'match.roster': { cat: 'match', keys: ['team', 'number', 'fields', 'op'] },
  'sync.error': { cat: 'sync', keys: ['resource', 'action', 'status', 'code', 'requestId', 'attempt'] },
  'sync.dropped': { cat: 'sync', keys: ['resource', 'action', 'status', 'code', 'requestId', 'attempt'] },
  'sync.state': { cat: 'sync', keys: ['from', 'to'] },
  'sync.summary': { cat: 'sync', keys: ['sent', 'failed', 'pending'] },
  'app.start': { cat: 'app', keys: ['version', 'previous', 'platform', 'persisted'] },
  'app.update': { cat: 'app', keys: ['version', 'previous', 'platform', 'persisted'] },
  'app.quit': { cat: 'app', keys: [] },
  'app.error': { cat: 'error', keys: ['message', 'frames', 'source', 'repeats'] },
  'backup.error': { cat: 'error', keys: ['message'] },
  'auth.sign_in': { cat: 'app', keys: [] },
  'auth.sign_out': { cat: 'app', keys: [] },
  'activity.overflow': { cat: 'app', keys: ['dropped'] }
})

export const ACTIVITY_KIND_RE = /^[a-z_]+(\.[a-z_]+)+$/
export const ACTIVITY_LEVELS = Object.freeze(['info', 'warn', 'error'])

// Keys whose values are never kept, whatever the kind
export const DENIED_KEY = /pin|password|passwd|token|secret|signature|image|dataurl|dob|birth|email|phone|licen[cs]e/i
const DATA_URL = /^data:[^,]{0,100},/i
const JWT = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/
// A manual change of one of these fields says "changed", never the values
const SENSITIVE_FIELD = /dob|birth|pin|password|email|phone|licen[cs]e|signature/i

export const isKnownKind = (kind) => Object.prototype.hasOwnProperty.call(ACTIVITY_KINDS, kind)

/** UI filter group of a kind: 'scoring' | 'correction' | 'sync' | 'error' | 'match' | 'app'. */
export function activityCategory(kind, level) {
  if (level === 'error') return 'error'
  return ACTIVITY_KINDS[kind]?.cat || 'app'
}

function cleanValue(value, depth) {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    if (DATA_URL.test(value) || JWT.test(value.trim())) return undefined
    return value.length > ACTIVITY_STRING_MAX ? value.slice(0, ACTIVITY_STRING_MAX) : value
  }
  if (depth >= MAX_DEPTH) return undefined
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map(v => cleanValue(v, depth + 1)).filter(v => v !== undefined)
  }
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (DENIED_KEY.test(k)) continue
      const c = cleanValue(v, depth + 1)
      if (c !== undefined) out[k] = c
    }
    return out
  }
  return undefined
}

const byteLength = (s) => {
  try {
    return new TextEncoder().encode(s).length
  } catch {
    return s.length * 3
  }
}

/**
 * The data an entry of `kind` may carry: allowlisted keys, no denied key,
 * no data URL or JWT, strings <= 200 characters, depth <= 3, <= 4 KB.
 * Unknown kinds keep nothing. Never throws.
 */
export function sanitizeActivityData(kind, data) {
  const spec = ACTIVITY_KINDS[kind]
  if (!spec || !data || typeof data !== 'object' || Array.isArray(data)) return {}
  const out = {}
  for (const key of spec.keys) {
    if (!(key in data) || DENIED_KEY.test(key)) continue
    const v = cleanValue(data[key], 1)
    if (v !== undefined) out[key] = v
  }
  if (kind === 'match.manual_change' && typeof out.field === 'string' && SENSITIVE_FIELD.test(out.field)) {
    if ('before' in out) out.before = 'changed'
    if ('after' in out) out.after = 'changed'
  }
  let json = JSON.stringify(out)
  if (byteLength(json) <= ACTIVITY_DATA_MAX_BYTES) return out
  // Too big: shorten the strings, then drop the largest keys
  for (const k of Object.keys(out)) {
    if (typeof out[k] === 'string' && out[k].length > 40) out[k] = out[k].slice(0, 40)
    else if (Array.isArray(out[k])) out[k] = out[k].slice(0, 5)
  }
  json = JSON.stringify(out)
  while (byteLength(json) > ACTIVITY_DATA_MAX_BYTES && Object.keys(out).length) {
    const largest = Object.keys(out).sort((a, b) => JSON.stringify(out[b]).length - JSON.stringify(out[a]).length)[0]
    delete out[largest]
    json = JSON.stringify(out)
  }
  return out
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** event.add data of an event row (the score from its snapshot when present). */
export function eventActivityData(event) {
  const p = event?.payload || {}
  const out = { type: event?.type ?? null, seq: event?.seq ?? null, set: event?.setIndex ?? null }
  if (p.team) out.team = p.team
  if (p.playerIn != null) out.playerIn = p.playerIn
  if (p.playerOut != null) out.playerOut = p.playerOut
  const player = p.playerNumber ?? p.player ?? null
  if (player != null && typeof player !== 'object') out.player = player
  if (event?.type === 'sanction' && typeof p.type === 'string') out.sanction = p.type
  if (p.liberoIn != null || p.liberoNumber != null) out.libero = p.liberoIn ?? p.liberoNumber
  const s = event?.stateSnapshot
  const a = s?.pointsA ?? s?.scoreA
  const b = s?.pointsB ?? s?.scoreB
  if (Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && a !== null && b !== null) {
    out.scoreA = Number(a)
    out.scoreB = Number(b)
  }
  return out
}

/** The kind of an event history row (db/eventHistory). */
export function historyKind(row) {
  if (row?.op === 'edit') return 'event.edit'
  if (row?.op === 'restore') return 'event.restore'
  return row?.reason === 'undo' ? 'event.undo' : 'event.delete'
}

export function historyActivityData(row) {
  return {
    type: row?.type ?? null,
    seq: row?.seq ?? null,
    set: row?.setIndex ?? null,
    reason: row?.reason ?? null,
    revUid: row?.revUid ?? null,
    actionId: row?.actionId ?? null,
    ...(row?.op === 'edit' ? { changed: row.changed || [] } : {})
  }
}

// ---------------------------------------------------------------------------
// Match row writes
// ---------------------------------------------------------------------------

// Bookkeeping keys of the match row (utils/nativeBackup/matchWriteHook)
export const VOLATILE_MATCH_KEY = /heartbeat|lastseen|sessionid|synced|_sync|lastupdated|updatedat|cloudblock/i

const CLOSING = ['approved', 'final']

/**
 * Which match keys produce which entries. Checked against the writes of
 * Scoreboard, MatchEnd, ManualAdjustments and CoinToss.
 * Each rule: [key test, kind, (key, before, after, row) => data | null]
 */
export const MATCH_KEY_KINDS = Object.freeze([
  [k => k === 'status', 'match.status', (k, before, after) => ({ from: before ?? null, to: after ?? null })],
  [k => /^coinToss/.test(k) || k === 'firstServe', 'match.coin_toss', null],
  [k => /Signature$/.test(k), 'match.signature', (k, before, after) => ({ role: k.replace(/Signature$/, ''), signed: !!after })],
  [k => k === 'accountApprovals', 'match.approval', null],
  [k => k === 'remarks', 'match.remarks', (k, before, after) => ({ length: typeof after === 'string' ? after.length : 0 })],
  [k => k === 'forfeitTeam' || k === 'forfeitReason' || k === 'stoppedReason', 'match.forfeit', null],
  [k => k === 'manualChanges', 'match.manual_change', null]
])

const valueAt = (obj, keyPath) => String(keyPath).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
function same(a, b) {
  if (a === b) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

function approvalEntries(before, after) {
  const out = []
  const b = before && typeof before === 'object' ? before : {}
  const a = after && typeof after === 'object' ? after : {}
  for (const slot of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (same(b[slot], a[slot])) continue
    const rec = a[slot]
    out.push({ role: slot, approved: !!rec, method: rec ? (rec.method || (rec.pin_used || rec.pinUsed ? 'pin' : 'account')) : null })
  }
  return out
}

/**
 * The activity entries of one update of a match row.
 * @param {object} mods Dexie updating-hook modifications (key paths -> values)
 * @param {object} row  the match row before the update
 * @returns {Array<{kind:string, data:object, level?:string}>}
 */
export function matchUpdateEntries(mods, row) {
  const out = []
  const changed = Object.keys(mods || {})
    .filter(k => !VOLATILE_MATCH_KEY.test(k))
    .filter(k => !same(mods[k], valueAt(row, k)))
  const seen = new Set()
  for (const key of changed) {
    const top = key.split('.')[0]
    const rule = MATCH_KEY_KINDS.find(([test]) => test(top))
    if (!rule) continue
    const [, kind, build] = rule
    const before = valueAt(row, top)
    const after = top === key ? mods[key] : { ...(before || {}), [key.split('.').slice(1).join('.')]: mods[key] }
    if (kind === 'match.status') {
      out.push({ kind: CLOSING.includes(after) && !CLOSING.includes(before) ? 'match.close' : 'match.status', data: build(top, before, after) })
    } else if (kind === 'match.coin_toss') {
      if (seen.has(kind)) continue
      seen.add(kind)
      const keys = changed.map(k => k.split('.')[0]).filter(k => /^coinToss/.test(k) || k === 'firstServe')
      out.push({ kind, data: { keys: [...new Set(keys)], confirmed: (mods.coinTossConfirmed ?? row?.coinTossConfirmed) === true } })
    } else if (kind === 'match.approval') {
      for (const data of approvalEntries(before, after)) out.push({ kind, data })
    } else if (kind === 'match.forfeit') {
      if (seen.has(kind)) continue
      seen.add(kind)
      const team = 'forfeitTeam' in mods ? mods.forfeitTeam : row?.forfeitTeam
      const stopped = 'stoppedReason' in mods ? mods.stoppedReason : row?.stoppedReason
      out.push({ kind, data: { team: team ?? null, forfeit: !!team, stopped: !!stopped } })
    } else if (kind === 'match.manual_change') {
      const prev = Array.isArray(before) ? before : []
      const next = Array.isArray(after) ? after : []
      // New items only (the array grows; a rewrite of old ones is not an entry)
      for (const c of next.slice(prev.length)) {
        if (!c || typeof c !== 'object') continue
        out.push({ kind, data: { category: c.category ?? null, field: c.field ?? null, before: c.before ?? null, after: c.after ?? null } })
      }
    } else if (build) {
      out.push({ kind, data: build(top, before, after, row) })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Set rows
// ---------------------------------------------------------------------------

/** set.end / set.reopen of an update of a set row, or null. */
export function setUpdateEntry(mods, row) {
  if (!mods || !('finished' in mods)) return null
  const was = row?.finished === true
  const now = mods.finished === true
  if (was === now) return null
  const home = 'homePoints' in mods ? mods.homePoints : row?.homePoints
  const away = 'awayPoints' in mods ? mods.awayPoints : row?.awayPoints
  return { kind: now ? 'set.end' : 'set.reopen', data: { set: row?.index ?? null, home: home ?? null, away: away ?? null } }
}

// ---------------------------------------------------------------------------
// App errors
// ---------------------------------------------------------------------------

/** "file:line" of the top stack frames (no message text, no query strings). */
export function stackFrames(stack, max = 5) {
  if (typeof stack !== 'string') return []
  const frames = []
  for (const line of stack.split('\n')) {
    const m = line.match(/([^\s()@/]+\.(?:m?js|jsx|ts|tsx))(?:\?[^:)]*)?:(\d+)(?::\d+)?/)
    if (m) frames.push(`${m[1]}:${m[2]}`)
    if (frames.length >= max) break
  }
  return frames
}

/** One line of the activity list for an entry (English; the UI translates kinds). */
export function activityLine(entry) {
  const d = entry?.data || {}
  const score = d.scoreA != null && d.scoreB != null ? ` ${d.scoreA}:${d.scoreB}` : ''
  switch (entry?.kind) {
    case 'event.add': return `${d.type || 'event'}${d.team ? ` ${d.team}` : ''}${d.player != null ? ` #${d.player}` : ''}${d.playerOut != null ? ` ${d.playerOut}→${d.playerIn}` : ''}${d.sanction ? ` ${d.sanction}` : ''}${score}`
    case 'event.bulk_add': return `${d.count} events`
    case 'event.undo':
    case 'event.delete':
    case 'event.restore': return `${d.type || 'event'} (seq ${d.seq}) ${d.reason || ''}`.trim()
    case 'event.edit': return `${d.type || 'event'} (seq ${d.seq}) ${(d.changed || []).join(', ')}`
    case 'set.start':
    case 'set.end':
    case 'set.reopen':
    case 'set.delete': return `set ${d.set}${d.home != null ? ` ${d.home}:${d.away}` : ''}`
    case 'match.status':
    case 'match.close':
    case 'sync.state': return `${d.from ?? '–'} → ${d.to ?? '–'}`
    case 'match.manual_change': return `${d.category || ''} ${d.field || ''}: ${d.before ?? ''} → ${d.after ?? ''}`.trim()
    case 'match.signature': return `${d.role} ${d.signed ? 'signed' : 'cleared'}`
    case 'match.approval': return `${d.role} ${d.approved ? `approved (${d.method})` : 'approval removed'}`
    case 'match.remarks': return `${d.length} characters`
    case 'match.roster': return `${d.team || ''} #${d.number ?? '?'} ${d.op || ''}`.trim()
    case 'sync.error':
    case 'sync.dropped': return `${d.resource} ${d.action}: ${d.status ?? ''} ${d.code ?? ''}`.trim()
    case 'sync.summary': return `sent ${d.sent}, failed ${d.failed}, pending ${d.pending}`
    case 'app.start':
    case 'app.update': return `${d.version}${d.previous ? ` (was ${d.previous})` : ''} ${d.platform || ''}`.trim()
    case 'app.error':
    case 'backup.error': return d.message || ''
    case 'activity.overflow': return `${d.dropped} entries dropped`
    default: return ''
  }
}
