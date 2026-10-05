/**
 * Pure match-officials helpers — no React, no Dexie.
 *
 * match.officials is an ARRAY of { role, firstName, lastName, country, dob }
 * (line judges: { role: 'line judge N', name }), written by MatchSetup and read
 * with .find/.some/.map by the Scoreboard, CoinToss, MatchEnd and the PDF.
 * ManualAdjustments edits the four main officials as a role-keyed object
 * ({ ref1, ref2, scorer, asstScorer }); this module converts those edits back
 * into the array, merging into the existing entries so line judges and fields
 * the editor does not show are kept.
 */

/** Editor key -> canonical role, plus the role spellings found in older data. */
export const OFFICIAL_ROLES = Object.freeze({
  ref1: { role: '1st referee', aliases: ['1st referee', 'ref1', '1st_referee'] },
  ref2: { role: '2nd referee', aliases: ['2nd referee', 'ref2', '2nd_referee'] },
  scorer: { role: 'scorer', aliases: ['scorer'] },
  asstScorer: { role: 'assistant scorer', aliases: ['assistant scorer', 'asstScorer', 'assistant_scorer'] }
})

const roleMatches = (entry, key) =>
  OFFICIAL_ROLES[key].aliases.includes(String(entry?.role || '').toLowerCase()) ||
  OFFICIAL_ROLES[key].aliases.includes(entry?.role)

/**
 * Normalise whatever is stored in match.officials to the array format.
 * Accepts the array format, the role-keyed object format (written by older
 * ManualAdjustments saves) or nothing.
 */
export function officialsToArray(officials) {
  if (Array.isArray(officials)) return officials.map(o => ({ ...o }))
  if (!officials || typeof officials !== 'object') return []
  const out = []
  for (const key of Object.keys(OFFICIAL_ROLES)) {
    const o = officials[key]
    if (o && (o.firstName || o.lastName || o.first_name || o.last_name)) {
      out.push({ ...o, role: OFFICIAL_ROLES[key].role })
    }
  }
  return out
}

/**
 * Merge role-keyed edits into the officials array.
 * @param {Array|object|null} existing current match.officials
 * @param {{ref1?:object, ref2?:object, scorer?:object, asstScorer?:object}} edited
 * @param {{snakeCase?: boolean}} [opts] snake_case name keys (cloud payload)
 * @returns {Array} new officials array (input not mutated)
 */
export function mergeOfficialsEdits(existing, edited = {}, { snakeCase = false } = {}) {
  const fnKey = snakeCase ? 'first_name' : 'firstName'
  const lnKey = snakeCase ? 'last_name' : 'lastName'
  let result = officialsToArray(existing)

  for (const key of Object.keys(OFFICIAL_ROLES)) {
    if (!(key in edited)) continue
    const e = edited[key] || {}
    const firstName = e.firstName ?? e.first_name ?? ''
    const lastName = e.lastName ?? e.last_name ?? ''
    const idx = result.findIndex(o => roleMatches(o, key))

    if (!firstName && !lastName) {
      // Name cleared: drop the official (MatchSetup never stores unnamed ones)
      if (idx !== -1) result = result.filter((_, i) => i !== idx)
      continue
    }

    const base = idx !== -1 ? { ...result[idx] } : {}
    delete base.firstName; delete base.lastName; delete base.first_name; delete base.last_name
    const merged = { ...base, role: OFFICIAL_ROLES[key].role, [fnKey]: firstName, [lnKey]: lastName }
    if (e.country !== undefined) merged.country = e.country || null
    if (e.dob !== undefined) merged.dob = e.dob || null

    if (idx !== -1) result[idx] = merged
    else result.push(merged)
  }
  return result
}
