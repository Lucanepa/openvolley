// A PIN on screen (Show PINs, the match popover, the connect dialog) is six
// digits, possibly grouped ("771 234"): a click on it must not put it in the
// log (eventCapture, comprehensiveLogger, diagnostics). Runs of 6+ digits go
// (a 6-digit game number too: the entry carries the game number anyway).
// No database or app import: the error screens and diagnostics use it.
const DIGIT_RUN = /\d(?:[\s\u00a0-]?\d){5,}/g

/** Visible text of a clicked element for the log, without PIN-like digit runs. */
export function redactScreenText(text) {
  if (text == null) return null
  return String(text).replace(DIGIT_RUN, '[digits]')
}
