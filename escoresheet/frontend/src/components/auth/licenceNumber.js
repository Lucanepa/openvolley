/**
 * The account's licence number (profiles.license_number, db/048): optional,
 * the Swiss Volley licence ("SV") number, 4 to 7 digits. Sign-up and the
 * profile ask for it instead of a date of birth (owner 2026-11-19: "the
 * scorers/referees etc can sign up with their name, last name, email and
 * licence number (not mandatory)"). The backend checks the same rule
 * (lib/auth.js, the column's CHECK).
 */

export const LICENCE_NUMBER_RE = /^[0-9]{4,7}$/
export const LICENCE_NUMBER_MAX = 7

/**
 * What the field keeps of a keystroke or a paste: digits only, at most 7. The
 * input has no maxLength: the browser would cut a pasted "SV 1234567" to its
 * first 7 characters before this sees it.
 */
export function licenceInput (raw) {
  return String(raw ?? '').replace(/\D+/g, '').slice(0, LICENCE_NUMBER_MAX)
}

/** The value to save: the licence number, or null when the field is empty. */
export function licenceValue (raw) {
  const v = String(raw ?? '').trim()
  return v === '' ? null : v
}

/** Is the field's value fine to save? Empty (none) or 4 to 7 digits. */
export function licenceOk (raw) {
  const v = licenceValue(raw)
  return v === null || LICENCE_NUMBER_RE.test(v)
}
