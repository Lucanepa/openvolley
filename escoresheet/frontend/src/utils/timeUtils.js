/**
 * Time Utility Module
 *
 * TIMEZONE PHILOSOPHY:
 * - Storage: Always UTC with 'Z' suffix (e.g., "2024-01-15T13:00:00Z")
 * - Display: Always local timezone (browser time)
 * - Input: User enters local time (what they see on gym clock)
 *
 * This module handles all conversions between UTC storage and local display.
 */

/**
 * Format UTC ISO string to local time HH:MM
 * @param {string} isoString - ISO 8601 string with Z suffix (e.g., "2024-01-15T13:00:00Z")
 * @returns {string} Local time in HH:MM format (e.g., "14:00" in UTC+1)
 *
 * @example
 * formatTimeLocal("2024-01-15T11:00:00Z") // Returns "12:00" in UTC+1
 */
export function formatTimeLocal(isoString) {
  if (!isoString) return ''
  try {
    const date = new Date(isoString)
    if (isNaN(date.getTime())) return ''

    // Use LOCAL time methods (not UTC)
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    return `${hours}:${minutes}`
  } catch {
    return ''
  }
}

/**
 * Format UTC ISO string to local datetime for datetime-local input
 * @param {string} isoString - ISO 8601 string with Z suffix
 * @returns {string} Local datetime in YYYY-MM-DDTHH:MM format for datetime-local input
 *
 * @example
 * formatDateTimeLocal("2024-01-15T11:00:00Z") // Returns "2024-01-15T12:00" in UTC+1
 */
export function formatDateTimeLocal(isoString) {
  if (!isoString) return ''
  try {
    const date = new Date(isoString)
    if (isNaN(date.getTime())) return ''

    // Use LOCAL time methods
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')

    return `${year}-${month}-${day}T${hours}:${minutes}`
  } catch {
    return ''
  }
}

/**
 * Parse local datetime-local input to UTC ISO string
 * @param {string} dateTimeLocal - Local datetime from datetime-local input (YYYY-MM-DDTHH:MM)
 * @returns {string|null} UTC ISO string with Z suffix (e.g., "2024-01-15T11:00:00Z")
 *
 * @example
 * parseLocalToISO("2024-01-15T12:00") // Returns "2024-01-15T11:00:00Z" in UTC+1
 */
export function parseLocalToISO(dateTimeLocal) {
  if (!dateTimeLocal) return null
  try {
    // datetime-local input gives us local time as "YYYY-MM-DDTHH:MM"
    // When we create Date from this, it interprets as LOCAL time
    const date = new Date(dateTimeLocal)
    if (isNaN(date.getTime())) return null

    // toISOString() converts to UTC and adds 'Z' suffix
    return date.toISOString()
  } catch {
    return null
  }
}

/**
 * Parse separate date and time inputs (local) to UTC ISO string
 * Used for match setup scheduled time
 * @param {string} date - Date in YYYY-MM-DD format
 * @param {string} time - Time in HH:MM format (local time)
 * @returns {string|null} UTC ISO string with Z suffix
 *
 * @example
 * parseLocalDateTimeToISO("2024-01-15", "12:00") // Returns "2024-01-15T11:00:00Z" in UTC+1
 */
export function parseLocalDateTimeToISO(date, time = '00:00') {
  if (!date) return null
  try {
    // Combine date and time, interpret as local time
    const dateTimeLocal = `${date}T${time}`
    const dateObj = new Date(dateTimeLocal)
    if (isNaN(dateObj.getTime())) return null

    // Convert to UTC ISO string
    return dateObj.toISOString()
  } catch {
    return null
  }
}

/**
 * Format UTC ISO string to local date and time components
 * Used for splitting scheduled time back into date/time inputs
 * @param {string} isoString - ISO 8601 string with Z suffix
 * @returns {{date: string, time: string}} Object with date (YYYY-MM-DD) and time (HH:MM) in local timezone
 *
 * @example
 * splitLocalDateTime("2024-01-15T11:00:00Z") // Returns {date: "2024-01-15", time: "12:00"} in UTC+1
 */
export function splitLocalDateTime(isoString) {
  if (!isoString) return { date: '', time: '' }
  try {
    const date = new Date(isoString)
    if (isNaN(date.getTime())) return { date: '', time: '' }

    // Extract LOCAL time components
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')

    return {
      date: `${year}-${month}-${day}`,
      time: `${hours}:${minutes}`
    }
  } catch {
    return { date: '', time: '' }
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
