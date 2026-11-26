/**
 * A photo's roster checked against the side's saved team, before the scorer
 * sees it: the SV number is what the recognition reads best (digits), the
 * names what it reads worst (accents, "Müfler" for Müller). A player whose
 * SV number the saved team has gets the saved team's spelling, sure; one
 * whose SV number is no one's there but whose name the saved team knows
 * (accents and case aside, either order; one person only) gets the saved
 * team's number (amber when the read one looked right). Nothing else
 * changes: the confirm screen shows the rest as read.
 *
 * savedTeam: a saved team row (domain/savedTeams: players and staff with
 * first_name, last_name, license_number); null for none.
 */

import { normalizeName } from '../../domain/savedTeams'
import { licenceOf } from '../../domain/idMode'
import { OFFICIAL_KEYS } from '../../domain/importedRoster'

const fold = (v) => normalizeName(v).normalize('NFD').replace(/\p{Diacritic}/gu, '')
const keyOf = (first, last) => `${fold(last)}|${fold(first)}`
const PLAYER_LICENCE = /^\d{5,6}$/
const OFFICIAL_LICENCE = /^\d{4,7}$/

function finder (people) {
  const byLicence = new Map()
  const byName = new Map()
  for (const p of people) {
    const lic = licenceOf(p?.license_number)
    if (lic && !byLicence.has(lic)) byLicence.set(lic, p)
    for (const k of [keyOf(p?.first_name, p?.last_name), keyOf(p?.last_name, p?.first_name)]) {
      if (!byName.has(k)) byName.set(k, [])
      byName.get(k).push(p)
    }
  }
  return {
    byLicence: (lic) => (lic ? byLicence.get(licenceOf(lic)) || null : null),
    byName: (first, last) => {
      const hits = [...new Set(byName.get(keyOf(first, last)) || [])]
      return hits.length === 1 ? hits[0] : null
    }
  }
}

function checked (person, find, licenceRe) {
  const saved = find.byLicence(person.licence)
  if (saved && (saved.first_name || saved.last_name)) {
    return {
      ...person,
      firstName: String(saved.first_name || '').trim(),
      lastName: String(saved.last_name || '').trim(),
      fromSavedTeam: true,
      confidence: { ...person.confidence, licence: Math.max(person.confidence?.licence ?? 0, 0.95), firstName: 1, lastName: 1 }
    }
  }
  // the SV number read is no one's in the saved team, the name is someone's
  // (one person only): the saved team's number. A read that looked right
  // ("10031" for 100311, a digit lost) is replaced too, shown amber to check.
  const byName = find.byName(person.firstName, person.lastName)
  const lic = byName ? licenceOf(byName.license_number) : null
  if (lic && lic !== person.licence) {
    const readLooksRight = licenceRe.test(person.licence || '')
    return { ...person, licence: lic, fromSavedTeam: true, confidence: { ...person.confidence, licence: readLooksRight ? 0.75 : 0.85 } }
  }
  return person
}

/** The roster with the saved team's spelling and SV numbers where they match (see above). */
export function withSavedTeamNames (roster, savedTeam) {
  if (!roster || !savedTeam) return roster
  const players = finder(Array.isArray(savedTeam.players) ? savedTeam.players : [])
  const staff = Array.isArray(savedTeam.staff) ? savedTeam.staff : []
  const out = { ...roster, players: (roster.players || []).map((p) => checked(p, players, PLAYER_LICENCE)) }
  const officials = finder(staff)
  for (const k of OFFICIAL_KEYS) {
    if (roster[k]) out[k] = checked(roster[k], officials, OFFICIAL_LICENCE)
  }
  // a role the photo missed stays empty: the saved team's coach is not
  // necessarily this game's (the list says who is on the bench)
  return out
}
