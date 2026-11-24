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
 * Is the official of `key` (ref1, ref2, scorer, asstScorer) on the match?
 * Reads either format of match.officials and the older role spellings.
 */
export function hasOfficial(officials, key) {
  if (!OFFICIAL_ROLES[key]) return false
  return officialsToArray(officials).some(o => roleMatches(o, key))
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

const isoDobToDisplay = (dob) => {
  const m = String(dob || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[3]}.${m[2]}.${m[1]}` : ''
}

/**
 * The referees and line judges of a game loaded from the schedule
 * (LoadOfficialMatchModal's match), as MatchSetup's form fields. Every field
 * is the game's value or '': loading a second game must not keep the first
 * game's referees, their dates of birth or line judges.
 */
export function officialsFromSchedule(game = {}) {
  const referee = (n) => ({
    first: game[`referee${n}First`] || '',
    last: game[`referee${n}Last`] || '',
    country: 'CHE',
    dob: isoDobToDisplay(game[`referee${n}Dob`])
  })
  return {
    ref1: referee(1),
    ref2: referee(2),
    lineJudge1: game.linesman1 || '',
    lineJudge2: game.linesman2 || ''
  }
}

/**
 * A team's contact address for the final scoresheet (owner, 15.11: "the email
 * of a contact for each team to whom the scoresheet goes at the end, like
 * with the referees"). Kept in match.officials as { role: 'team contact',
 * team: 'home'|'away', email }: officials are never public and never relayed
 * to the tablets (backend publicColumns / serverDataSync NEVER_RELAYED), the
 * public listing names roles with a person only, and the scoresheet file
 * drops their contact data (scoresheetUploader). No name: never on the sheet.
 */
export const TEAM_CONTACT_ROLE = 'team contact'

/** Is this officials entry a team's contact address (not an official)? */
export const isTeamContact = (o) => String(o?.role || '').toLowerCase() === TEAM_CONTACT_ROLE

/** The contact address of `team` ('home' / 'away') in match.officials, '' without one. */
export function teamContactEmail(officials, team) {
  const entry = officialsToArray(officials).find(o => isTeamContact(o) && o.team === team)
  return typeof entry?.email === 'string' ? entry.email : ''
}

/**
 * match.officials with the two teams' contact addresses set (a blank one
 * removed). `clean` normalises an address and returns null for one that does
 * not look like an address (MatchSetup cleanEmail).
 * @param {Array|object|null} officials
 * @param {{ home?: string, away?: string }} contacts
 * @param {(raw: string) => string|null} clean
 * @returns {Array}
 */
export function withTeamContacts(officials, contacts = {}, clean = (s) => String(s || '').trim() || null) {
  const list = officialsToArray(officials).filter(o => !isTeamContact(o))
  for (const team of ['home', 'away']) {
    const email = clean(contacts[team])
    if (email) list.push({ role: TEAM_CONTACT_ROLE, team, email })
  }
  return list
}

/** A contact address as stored: trimmed, lower-case, null unless it looks like one (as MatchSetup cleanEmail). */
export function cleanContactEmail(raw) {
  const s = String(raw || '').trim().toLowerCase()
  return s.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : null
}
