// A PIN on screen (Show PINs, the match popover, the connect dialog) is six
// digits, possibly grouped ("771 234"): a click on it must not put it in the
// log (eventCapture, comprehensiveLogger, diagnostics). Runs of 6+ digits go
// (a 6-digit game number too: the entry carries the game number anyway).
// No database or app import: the error screens and diagnostics use it.
const DIGIT_RUN = /\d(?:[\s\u00a0-]?\d){5,}/g
// A date on screen (a player's date of birth in a roster row: "14.03.2012",
// "14/03/2012", "2012-03-14") and an email address (an account row) go too.
// A four-digit year: a version number ("3.1.20") is no date. No lookbehind
// (older Safari / WebKit cannot parse it).
const DAY_MONTH_YEAR = /(^|\D)(?:0?[1-9]|[12]\d|3[01])[./](?:0?[1-9]|1[0-2])[./](?:19|20)\d{2}(?!\d)/g
const ISO_DATE = /(^|\D)(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?!\d)/g
// bounded parts: linear on a long text without an address
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}/g

/** Visible text of a clicked element for the log, without PIN-like digit runs, dates or email addresses. */
export function redactScreenText(text) {
  if (text == null) return null
  let s = String(text).replace(DAY_MONTH_YEAR, '$1[date]').replace(ISO_DATE, '$1[date]')
  if (s.includes('@')) s = s.replace(EMAIL, '[email]')
  return s.replace(DIGIT_RUN, '[digits]')
}

// Fields whose value is typed text (eventCapture, comprehensiveLogger): a
// key typed there or the value is never kept, only that and how much. Not
// a checkbox, a radio button, a button, a slider or a colour; a select is
// no input element.
const NOT_TYPED = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'image'])

/** A text field (input, textarea, contenteditable) by its tag name and type. */
export function isTypingField(tagName, type, contentEditable = false) {
  if (contentEditable) return true
  const tag = String(tagName || '').toLowerCase()
  if (tag === 'textarea') return true
  return tag === 'input' && !NOT_TYPED.has(String(type || 'text').toLowerCase())
}

// What a printable key typed into a text field is kept as: one character,
// so the support timeline still counts it as typing (utils/diagnosticsReport)
export const TYPED_KEY = '•'
