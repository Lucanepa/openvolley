/**
 * Time Utility Module
 *
 * TIMEZONE PHILOSOPHY:
 * - Storage: Always UTC with 'Z' suffix (e.g., "2024-01-15T13:00:00Z")
 * - Display: Always the Zürich clock (ui/format.js APP_TZ), the gym's clock
 * - Input: User enters Zürich time (what they see on the gym clock)
 *
 * Not the device's zone: a scorer laptop left on a fixed GMT+2 after the
 * October change, or on UTC, stored the official 10:20 kick-off as 08:20Z
 * (on the server too) and printed set 1 at 11:20 on the official sheet
 * (stress test 2026-10-25). On a device in Zürich nothing changes.
 *
 * This module handles all conversions between UTC storage and Zürich display.
 * A zone-less "YYYY-MM-DDTHH:MM" given to the formatters (the schedule's
 * kick-off) is already Zürich wall time and is shown as it is.
 */
import { zonedParts, zurichWallTimeMs } from '../ui/format'

const pad2 = (n) => String(n).padStart(2, '0')

/** The Zürich wall clock of a stored value, or null when it has no clock. */
function zurichClock(value) {
  if (!value) return null
  const p = zonedParts(value)
  return p.valid && p.timed ? p : null
}

/**
 * The ISO instant of a Zürich date and time, or null when either does not
 * exist (2026-02-30, 24:00): Date.UTC would roll them over to another day.
 */
function zurichIso(date, time) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || '').trim())
  const t = /^(\d{1,2}):(\d{2})$/.exec(String(time || '').trim())
  if (!d || !t) return null
  const [year, month, day, hour, minute] = [d[1], d[2], d[3], t[1], t[2]].map(Number)
  const calendar = new Date(Date.UTC(year, month - 1, day))
  if (calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || hour > 23 || minute > 59) return null
  const ms = zurichWallTimeMs(year, month, day, hour, minute)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/**
 * Format UTC ISO string to Zürich time HH:MM
 * @param {string} isoString - ISO 8601 string with Z suffix (e.g., "2024-01-15T13:00:00Z")
 * @returns {string} Zürich time in HH:MM format (e.g., "14:00" in winter)
 *
 * @example
 * formatTimeLocal("2024-01-15T11:00:00Z") // Returns "12:00"
 */
export function formatTimeLocal(isoString) {
  const p = zurichClock(isoString)
  return p ? `${pad2(p.hour)}:${pad2(p.minute)}` : ''
}

/**
 * Format UTC ISO string to Zürich datetime for datetime-local input
 * @param {string} isoString - ISO 8601 string with Z suffix
 * @returns {string} Zürich datetime in YYYY-MM-DDTHH:MM format for datetime-local input
 *
 * @example
 * formatDateTimeLocal("2024-01-15T11:00:00Z") // Returns "2024-01-15T12:00"
 */
export function formatDateTimeLocal(isoString) {
  const p = zurichClock(isoString)
  return p ? `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}` : ''
}

/**
 * Parse Zürich datetime-local input to UTC ISO string
 * @param {string} dateTimeLocal - Zürich datetime from datetime-local input (YYYY-MM-DDTHH:MM)
 * @returns {string|null} UTC ISO string with Z suffix (e.g., "2024-01-15T11:00:00Z")
 *
 * @example
 * parseLocalToISO("2024-01-15T12:00") // Returns "2024-01-15T11:00:00.000Z"
 */
export function parseLocalToISO(dateTimeLocal) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{1,2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(String(dateTimeLocal || '').trim())
  return m ? zurichIso(m[1], m[2]) : null
}

/**
 * Parse separate date and time inputs (Zürich) to UTC ISO string
 * Used for match setup scheduled time
 * @param {string} date - Date in YYYY-MM-DD format
 * @param {string} time - Time in HH:MM format (Zürich time)
 * @returns {string|null} UTC ISO string with Z suffix
 *
 * @example
 * parseLocalDateTimeToISO("2024-01-15", "12:00") // Returns "2024-01-15T11:00:00.000Z"
 */
export function parseLocalDateTimeToISO(date, time = '00:00') {
  if (!date) return null
  return zurichIso(date, time)
}

/**
 * Format UTC ISO string to Zürich date and time components
 * Used for splitting scheduled time back into date/time inputs
 * @param {string} isoString - ISO 8601 string with Z suffix
 * @returns {{date: string, time: string}} Object with date (YYYY-MM-DD) and time (HH:MM) in Zürich
 *
 * @example
 * splitLocalDateTime("2024-01-15T11:00:00Z") // Returns {date: "2024-01-15", time: "12:00"}
 */
export function splitLocalDateTime(isoString) {
  const p = isoString ? zonedParts(isoString) : null
  if (!p?.valid) return { date: '', time: '' }
  return {
    date: `${p.year}-${pad2(p.month)}-${pad2(p.day)}`,
    // a bare date has no clock: never invent one (it was UTC midnight's)
    time: p.timed ? `${pad2(p.hour)}:${pad2(p.minute)}` : ''
  }
}

/**
 * Round UTC ISO string to the nearest minute (seconds and ms set to zero)
 * @param {string} isoString - ISO 8601 string
 * @returns {string|null} Wrapped ISO string with zeroed seconds/ms
 */
export function roundToMinute(isoString) {
  if (!isoString) return null
  try {
    const date = new Date(isoString)
    if (isNaN(date.getTime())) return null
    date.setUTCSeconds(0, 0)
    return date.toISOString()
  } catch {
    return null
  }
}
