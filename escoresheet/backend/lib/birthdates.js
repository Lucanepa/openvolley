/**
 * birthdates — what db/048 deletes, in JavaScript: the people's dates of
 * birth in a JSON value (a stored scoresheet's JSON file, a test's check of
 * the migration). Owner 2026-11-19: no birthdates outside a match's own
 * sheet, and the past sheets scrubbed too.
 *
 * The rule is db/048's, shared with the scorer app (frontend
 * domain/idMode.js isDateValue): a person's value beside the name is a DATE
 * when it is d.m.yy(yy) with '.', '/' or '-' between, or an ISO yyyy-mm-dd
 * (01.01.1900, the placeholder, is one); digits only are a licence number and
 * stay. A date goes (null) under a key named dob, dateOfBirth, date_of_birth,
 * birthDate, birthdate, birth_date or ending in one of them (referee_1_dob,
 * ref1Dob), and in the before / after of a manual change of such a field; a
 * date-of-birth correction in a `remarks` or `description` text keeps the
 * change and loses the dates (lib/publicColumns.js redactRemarkDobs).
 *
 * Pure; never throws.
 */

import { redactRemarkDobs } from './publicColumns.js'

const DATE_RE = /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/
const ISO_RE = /^\d{4}-\d{2}-\d{2}/
const DOB_KEY_RE = /(dob|date_?of_?birth|birth_?date)$/i
const TEXT_KEYS = new Set(['description', 'remarks'])

/** Is `v` a date of birth as a sheet keeps one (not a licence number)? */
export function isDateValue (v) {
  if (typeof v !== 'string') return false
  const s = v.trim()
  return DATE_RE.test(s) || ISO_RE.test(s)
}

/** Does key (or a manual change's field) `k` name a date of birth? */
export const isDobKey = (k) => typeof k === 'string' && DOB_KEY_RE.test(k)

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * `value` without its people's dates of birth: { value, changed } (the same
 * value, untouched, when there is none; else a copy).
 */
export function scrubBirthdates (value) {
  let changed = false
  const walk = (v) => {
    if (Array.isArray(v)) {
      let out = v
      v.forEach((x, i) => {
        const y = walk(x)
        if (y !== x) {
          if (out === v) out = [...v]
          out[i] = y
        }
      })
      return out
    }
    if (!isPlainObject(v)) return v
    const dobField = typeof v.field === 'string' && isDobKey(v.field)
    let out = v
    const set = (k, y) => {
      if (out === v) out = { ...v }
      out[k] = y
      changed = true
    }
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'string') {
        if ((isDobKey(k) || (dobField && (k === 'before' || k === 'after'))) && isDateValue(x)) set(k, null)
        else if (TEXT_KEYS.has(k)) {
          const r = redactRemarkDobs(x)
          if (r !== x) set(k, r)
        }
        continue
      }
      const y = walk(x)
      if (y !== x) {
        if (out === v) out = { ...v }
        out[k] = y
      }
    }
    return out
  }
  const result = walk(value)
  return { value: result, changed }
}

/** How many dates of birth `value` holds (the rule above): a test's and a dry run's count. */
export function countBirthdates (value) {
  let n = 0
  const walk = (v, key = null, dobField = false) => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x))
    if (isPlainObject(v)) {
      const f = typeof v.field === 'string' && isDobKey(v.field)
      for (const [k, x] of Object.entries(v)) walk(x, k, f)
      return
    }
    if (typeof v !== 'string' || key == null) return
    if ((isDobKey(key) || (dobField && (key === 'before' || key === 'after'))) && isDateValue(v)) n++
    else if (TEXT_KEYS.has(key) && redactRemarkDobs(v) !== v) n++
  }
  walk(value)
  return n
}
