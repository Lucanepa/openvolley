/**
 * What a diagnostics line may carry: the activity log's rules
 * (domain/activitySummary: no key named pin / password / token / signature /
 * email / phone ..., no PIN or long number in text) and the click log's
 * (utils/screenText: no PIN-like digit run, also grouped "771 234"),
 * plus: no data URL or JWT, URLs without their query or fragment (tablet
 * links carry ?pin=), strings <= 120 characters, depth <= 4, arrays <= 20.
 * Never throws.
 */
import { DENIED_KEY, redactFreeText } from '../domain/activitySummary'
import { redactScreenText } from '../utils/screenText'

export const DIAG_STRING_MAX = 120
const MAX_DEPTH = 4
const MAX_ARRAY = 20
const DATA_URL = /^data:/i
const JWT = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/
const URL_LIKE = /^(?:https?|wss?|file|blob|tauri|capacitor):\/\//i
// a bare query string or path with one (?pin=, ?token=)
const QUERY = /[?#].*$/

/** A string as a diagnostics line may hold it. */
export function redactDiagText(text) {
  if (typeof text !== 'string') return text
  let s = text.trim()
  if (DATA_URL.test(s) || JWT.test(s)) return '[redacted]'
  if (URL_LIKE.test(s) || (s.startsWith('/') && s.includes('?'))) s = s.replace(QUERY, '')
  s = redactScreenText(redactFreeText(s))
  return s.length > DIAG_STRING_MAX ? s.slice(0, DIAG_STRING_MAX) : s
}

/** A deep copy of `value` without secrets (see the module comment). */
export function sanitizeDiagData(value, depth = 0) {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return redactDiagText(value)
  if (typeof value === 'bigint') return Number(value)
  if (typeof value !== 'object' || depth >= MAX_DEPTH) return undefined
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map(v => sanitizeDiagData(v, depth + 1)).filter(v => v !== undefined)
  }
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (DENIED_KEY.test(k)) continue
    const c = sanitizeDiagData(v, depth + 1)
    if (c !== undefined) out[k] = c
  }
  return out
}
