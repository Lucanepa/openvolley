/**
 * String utilities for filename sanitization
 */

/**
 * Sanitize a string for use in filenames
 * - Converts German umlauts: ü → ue, ö → oe, ä → ae
 * - Removes accents from other characters (é → e, ñ → n, etc.)
 * - Replaces non-alphanumeric characters with underscore or removes them
 *
 * @param {string} str - The string to sanitize
 * @param {Object} options - Options
 * @param {boolean} options.keepSpacesAsUnderscores - Replace spaces with underscores (default: true)
 * @param {number} options.maxLength - Maximum length of result (default: unlimited)
 * @returns {string} - Sanitized string safe for filenames
 */
export function sanitizeForFilename(str, options = {}) {
  if (!str) return ''

  const { keepSpacesAsUnderscores = true, maxLength = 0 } = options

  let result = str

  // Step 1: Convert German umlauts to their two-letter equivalents
  const umlautMap = {
    'ü': 'ue', 'Ü': 'Ue',
    'ö': 'oe', 'Ö': 'Oe',
    'ä': 'ae', 'Ä': 'Ae',
    'ß': 'ss'
  }

  for (const [umlaut, replacement] of Object.entries(umlautMap)) {
    result = result.split(umlaut).join(replacement)
  }

  // Step 2: Normalize other accented characters to their base form
  // Using NFD normalization to decompose characters, then removing combining marks
  result = result.normalize('NFD').replace(/[\u0300-\u036f]/g, '')

  // Step 3: Handle spaces
  if (keepSpacesAsUnderscores) {
    result = result.replace(/\s+/g, '_')
  }

  // Step 4: Remove any remaining non-alphanumeric characters (except underscores and hyphens)
  result = result.replace(/[^a-zA-Z0-9_-]/g, '')

  // Step 5: Clean up multiple underscores/hyphens
  result = result.replace(/[-_]{2,}/g, '_')

  // Step 6: Trim underscores from start and end
  result = result.replace(/^[-_]+|[-_]+$/g, '')

  // Step 7: Apply max length if specified
  if (maxLength > 0 && result.length > maxLength) {
    result = result.substring(0, maxLength)
    // Don't end with underscore or hyphen
    result = result.replace(/[-_]+$/, '')
  }

  return result
}

/**
 * Simplified sanitize function that just removes/replaces characters
 * without keeping spaces. Similar to the old behavior but with proper
 * umlaut and accent handling.
 *
 * @param {string} str - The string to sanitize
 * @param {number} maxLength - Maximum length (default: 15)
 * @returns {string} - Sanitized string
 */
export function sanitizeSimple(str, maxLength = 15) {
  if (!str) return ''

  let result = str

  // Convert German umlauts (all uppercase for consistency in filenames)
  const umlautMap = {
    'ü': 'UE', 'Ü': 'UE',
    'ö': 'OE', 'Ö': 'OE',
    'ä': 'AE', 'Ä': 'AE',
    'ß': 'SS'
  }

  for (const [umlaut, replacement] of Object.entries(umlautMap)) {
    result = result.split(umlaut).join(replacement)
  }

  // Remove accents from other characters
  result = result.normalize('NFD').replace(/[\u0300-\u036f]/g, '')

  // Remove non-alphanumeric
  result = result.replace(/[^a-zA-Z0-9]/g, '')

  // Convert to uppercase for filenames
  result = result.toUpperCase()

  // Apply max length
  if (maxLength > 0) {
    result = result.substring(0, maxLength)
  }

  return result
}
