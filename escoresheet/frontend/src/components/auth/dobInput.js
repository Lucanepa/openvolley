/**
 * Date of birth as typed text (DD.MM.YYYY), for the sign-up and profile forms.
 *
 * Why not <input type="date">: WebKit (Safari, and the desktop app's webview
 * on Linux and macOS) draws an EMPTY date field with today's date in it, so a
 * new account looked pre-filled with 06.10.2026. A text field shows nothing
 * until the user types, and a birth date is quicker to type than to scroll
 * back to in a picker.
 *
 * The value handed to the form stays ISO (YYYY-MM-DD), as the profile stores it.
 */

import { isoToDateText, parseDateText, shapeDateText } from '../../ui/dateTime.js'

const pad = (n) => String(n).padStart(2, '0')

/**
 * Shapes what the user typed into D.M.YYYY groups (the kit's DateField does
 * the same, ui/dateTime.js): digits only, a dot after a full day and month,
 * a typed separator ends a group early. Never adds a trailing dot by itself.
 * @param {string} raw
 * @returns {string}
 */
export const shapeDobText = shapeDateText

/** 'YYYY-MM-DD' (or an ISO timestamp) -> 'DD.MM.YYYY'; anything else -> ''. */
export const isoToDobText = isoToDateText

/**
 * Reads typed text as a birth date.
 * @param {string} text
 * @param {Date} [today]
 * @returns {{ iso: string|null, valid: boolean }} '' when empty (valid: the
 *   field is optional); null and valid: false for an unfinished or impossible
 *   date, one in the future or before 1900.
 */
export function parseDobText(text, today = new Date()) {
  const s = String(text || '').trim()
  if (!s) return { iso: '', valid: true }
  // Typed D.M.YYYY only (an ISO date is turned into that before it gets here).
  if (!/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(s)) return { iso: null, valid: false }
  const todayIso = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
  const { iso, status } = parseDateText(s, { min: '1900-01-01', max: todayIso })
  return status === 'ok' ? { iso, valid: true } : { iso: null, valid: false }
}
