/**
 * Profile save: what is written, and whether the backend really wrote it.
 *
 * POST /api/db scopes `profiles` to the caller (user_id forced) and strips
 * `roles`/`user_id`/`id` from writes, so the client only sends the editable
 * columns. A save counts only when the backend hands the written row back with
 * those values: a client that turned the write into a plain read (an old
 * apiClient) or a row that does not exist must not be reported as saved.
 */

export const PROFILE_NOT_SAVED = 'OV_PROFILE_NOT_SAVED'

/** The columns a profile save writes, from the form's camelCase fields. */
export function profileUpdateColumns(updates = {}) {
  return {
    first_name: updates.firstName ?? null,
    last_name: updates.lastName ?? null,
    country: updates.country ?? null,
    dob: updates.dob || null,
    sport_type: 'indoor'
  }
}

const norm = (v) => (v === undefined || v === null || v === '' ? null : String(v))
// Postgres may hand a date back as a timestamp; the day is what was saved
const normDate = (v) => (norm(v) === null ? null : String(v).slice(0, 10))

/**
 * Did the backend write `sent`? Returns the saved row, or null when the answer
 * carries no row or a row with other values.
 */
export function confirmedProfileRow(sent, data) {
  const row = Array.isArray(data) ? (data.length === 1 ? data[0] : null) : data
  if (!row || typeof row !== 'object') return null
  for (const key of ['first_name', 'last_name', 'country']) {
    if (key in sent && norm(row[key]) !== norm(sent[key])) return null
  }
  if ('dob' in sent && normDate(row.dob) !== normDate(sent.dob)) return null
  return row
}
