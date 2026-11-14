/**
 * Date formatting utility for consistent datetime display across the app.
 * Zürich time (ui/format APP_TZ), the gym's clock, like every other clock in
 * the app: a scorer laptop left on another zone (GMT+2 after the October
 * change, UTC) listed a backup written at 14:30 gym time as 15:30.
 */

import { APP_TZ } from '../ui/format'

const pad = (n) => String(n).padStart(2, '0')

let zurichSeconds = null
// day, month, year, hour, minute, second of an instant on the Zürich clock
function zurichFields(date) {
  if (!zurichSeconds) {
    zurichSeconds = new Intl.DateTimeFormat('en-GB', {
      timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    })
  }
  const at = Object.fromEntries(zurichSeconds.formatToParts(date).map(p => [p.type, p.value]))
  // Some ICU builds render midnight as hour 24
  return { ...at, hour: at.hour === '24' ? '00' : at.hour }
}

/** "04.01.2025, 16:30:45": an instant (Date, ms or ISO text) on the Zürich clock, '' when there is none. */
export function formatZurichDateTime(value) {
  if (value === null || value === undefined || value === '') return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const p = zurichFields(date)
  return `${pad(p.day)}.${pad(p.month)}.${p.year}, ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`
}

/**
 * Format a backup's UTC timestamp to dd.mm.yyyy, hh:mm:ss (24 h) on the Zürich clock
 * @param {string} date - Date string in yyyymmdd format (e.g., "20250104")
 * @param {string} time - Time string in hhmmss format (e.g., "153045")
 * @param {string} ms - Milliseconds string (e.g., "123")
 * @returns {string} Formatted datetime string (e.g., "04.01.2025, 16:30:45")
 */
export function formatBackupDateTime(date, time, ms = '000') {
  if (!date || !time) return 'Unknown'

  // Parse yyyymmdd
  const year = date.substring(0, 4)
  const month = date.substring(4, 6)
  const day = date.substring(6, 8)

  // Parse hhmmss
  const hours = time.substring(0, 2)
  const minutes = time.substring(2, 4)
  const seconds = time.substring(4, 6)

  // The file name's timestamp is UTC
  const dateObj = new Date(`${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${ms}Z`)
  return formatZurichDateTime(dateObj) || 'Unknown'
}
