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

const LIMITS = [2, 2, 4]
const SEPARATOR = /[.\/\-\s,]/

/**
 * Shapes what the user typed into D.M.YYYY groups: digits only, a dot after a
 * full day and month (typed or not), a typed separator ends a group early
 * ("6." then "10." then "1990"). Never adds a trailing dot by itself, so
 * Backspace deletes the way the user expects.
 * @param {string} raw
 * @returns {string}
 */
export function shapeDobText(raw) {
  const groups = ['']
  for (const ch of String(raw || '')) {
    const cur = groups.length - 1
    if (/\d/.test(ch)) {
      if (groups[cur].length < LIMITS[cur]) groups[cur] += ch
      else if (cur < 2) groups.push(ch)
    } else if (SEPARATOR.test(ch)) {
      if (groups[cur].length > 0 && cur < 2) groups.push('')
    }
  }
  return groups.join('.')
}

/** 'YYYY-MM-DD' (or an ISO timestamp) -> 'DD.MM.YYYY'; anything else -> ''. */
export function isoToDobText(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''))
  return m ? `${m[3]}.${m[2]}.${m[1]}` : ''
}

const pad = (n) => String(n).padStart(2, '0')

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
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s)
  if (!m) return { iso: null, valid: false }
  const day = Number(m[1])
  const month = Number(m[2])
  const year = Number(m[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  const real = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  const iso = `${year}-${pad(month)}-${pad(day)}`
  const todayIso = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
  if (!real || year < 1900 || iso > todayIso) return { iso: null, valid: false }
  return { iso, valid: true }
}
