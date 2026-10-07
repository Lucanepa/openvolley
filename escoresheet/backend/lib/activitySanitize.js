/**
 * activitySanitize — the activity log's catalog and sanitizer, server side.
 * A copy of the scorer app's (escoresheet/frontend/src/domain/activitySummary.js):
 * every entry uploaded to POST /api/activity runs through it again here, so
 * a modified client cannot store more than the app would.
 * tests/activityLog.test.js checks that the two catalogs and results match.
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
