/**
 * Date formatting utility for consistent datetime display across the app
 */

/**
 * Format backup timestamp to dd.mm.yyyy, hh:mm:ss (24hrs) in local time
 * @param {string} date - Date string in yyyymmdd format (e.g., "20250104")
 * @param {string} time - Time string in hhmmss format (e.g., "153045")
 * @param {string} ms - Milliseconds string (e.g., "123")
 * @returns {string} Formatted datetime string (e.g., "04.01.2025, 15:30:45")
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

  // Create UTC date object from the timestamp
  const dateObj = new Date(`${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${ms}Z`)

  // Format to local time with dd.mm.yyyy, hh:mm:ss
  const localDay = String(dateObj.getDate()).padStart(2, '0')
  const localMonth = String(dateObj.getMonth() + 1).padStart(2, '0')
  const localYear = dateObj.getFullYear()
  const localHours = String(dateObj.getHours()).padStart(2, '0')
  const localMinutes = String(dateObj.getMinutes()).padStart(2, '0')
  const localSeconds = String(dateObj.getSeconds()).padStart(2, '0')

  return `${localDay}.${localMonth}.${localYear}, ${localHours}:${localMinutes}:${localSeconds}`
}
