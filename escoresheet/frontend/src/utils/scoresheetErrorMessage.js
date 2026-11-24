/**
 * The scoresheet page's error report to the scorer app that opened it
 * (scoresheet_pdf/index_scoresheet.tsx -> Scoreboard.jsx openScoresheet):
 * posted to the app's own origin only, and taken only from that origin and
 * from the scoresheet window the app opened. Any other page that holds a
 * reference to the scorer's tab, or that opened /scoresheet/ itself, neither
 * hears these errors nor can show its own text in the app's error dialog.
 */

export const SCORESHEET_ERROR = 'SCORESHEET_ERROR'
/** At most this many characters of the error text and of its details. */
export const MAX_ERROR_TEXT = 300
export const MAX_ERROR_DETAILS = 4000

/** A value as plain text of at most `max` characters ('' for none). */
export function clipText(value, max) {
  if (value === undefined || value === null) return ''
  let text
  try { text = typeof value === 'string' ? value : String(value) } catch { text = '' }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** The message the scoresheet page posts for `error` (an Error or a text). */
export function scoresheetErrorMessage(error, details) {
  const isError = error instanceof Error
  const stack = isError ? error.stack : undefined
  return {
    type: SCORESHEET_ERROR,
    error: clipText(isError ? error.message : error, MAX_ERROR_TEXT),
    details: clipText(details || stack || '', MAX_ERROR_DETAILS),
  }
}

/** Posts it to the window that opened the scoresheet, on this page's origin only. */
export function postScoresheetError(opener, error, details, win = window) {
  opener.postMessage(scoresheetErrorMessage(error, details), win.location.origin)
}

/**
 * The { error, details } of a scoresheet error message for the app's dialog,
 * or null when `event` is not one from the app's own scoresheet: another
 * origin, or (when the app knows the window it opened) another window.
 */
export function scoresheetErrorFromEvent(event, { win = window, source = null } = {}) {
  if (!event || event.origin !== win.location.origin) return null
  if (source && event.source !== source) return null
  const data = event.data
  if (!data || typeof data !== 'object' || data.type !== SCORESHEET_ERROR) return null
  return {
    error: clipText(data.error, MAX_ERROR_TEXT) || 'Unknown error',
    details: clipText(data.details || data.stack, MAX_ERROR_DETAILS),
  }
}
