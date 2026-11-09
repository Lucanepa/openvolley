/**
 * The club's players in Match Setup (db/024, docs/club-licences-spec.md
 * section 5): "Add from club" for a team of the scorer's clubs, from the
 * tablet's copy (db/clubPlayers.js), and the gender warning. Plain data, no
 * React, no network.
 *
 * Match Setup's roster rows are { number, firstName, lastName, dob
 * (DD.MM.YYYY), libero, isCaptain, isLfp } without a licence number, so a
 * club person is matched by name (accents and case aside, also with first and
 * last name swapped) and, when both have one, the date of birth.
 *
 * Owner decision D2: in the hall the scorer can adjust anything, so a player
 * of the other gender is a warning in Match Setup, never a block (the
 * manager's squad and game rosters refuse it).
 */

import { displayDobToIso, isoToDisplayDob, normalizeName } from './savedTeams'

const fold = (v) => normalizeName(v).normalize('NFD').replace(/\p{Diacritic}/gu, '')
const rowKey = (last, first) => `${fold(last)}|${fold(first)}`

/** The gender of a match for the club's players: none for a test match; else the schedule's (men / women). */
export function matchGenderOf({ test = false, type2 = null } = {}) {
  if (test) return null
  if (type2 === 'men') return 'm'
  if (type2 === 'women') return 'f'
  return null
}

/** The club people offered for a match of `gender` (others are left out; all without a gender). */
export function offeredClubPlayers(players, gender) {
  const all = Array.isArray(players) ? players : []
  const list = gender === 'm' || gender === 'f' ? all.filter((p) => !p?.gender || p.gender === gender) : all
  return { players: list, hidden: all.length - list.length }
}

/** Is the club person `c` already in `roster` (by name, or the names swapped)? */
export function rosterHasPerson(roster, c) {
  const want = rowKey(c?.last_name, c?.first_name)
  const swapped = rowKey(c?.first_name, c?.last_name)
  return (roster || []).some((p) => {
    const k = rowKey(p?.lastName, p?.firstName)
    return k === want || k === swapped
  })
}

/**
 * The roster with `chosen` (club people) added: one already in it stays as it
 * is, the others come without a number. { roster, added }.
 */
export function addClubPlayersToRoster(roster, chosen) {
  const out = [...(roster || [])]
  let added = 0
  for (const c of chosen || []) {
    if (rosterHasPerson(out, c)) continue
    out.push({
      number: null,
      firstName: String(c.first_name || '').trim(),
      lastName: String(c.last_name || '').trim(),
      dob: isoToDisplayDob(c.dob),
      libero: '',
      isCaptain: false,
      isLfp: false
    })
    added++
  }
  return { roster: out, added }
}

/**
 * The roster's players the club's list has with the other gender than the
 * match's: [{ index, name, gender }]. A roster player is the club person of
 * the same name, and of the same date of birth when both have one; a name
 * that is twice in the list without a date of birth to tell them apart says
 * nothing. [] while the match's gender is unknown (a test match).
 */
export function clubGenderWarnings(roster, clubPlayers, gender) {
  if (gender !== 'm' && gender !== 'f') return []
  const byName = new Map()
  for (const c of clubPlayers || []) {
    if (!c) continue
    for (const k of new Set([rowKey(c.last_name, c.first_name), rowKey(c.first_name, c.last_name)])) {
      if (!byName.has(k)) byName.set(k, [])
      byName.get(k).push(c)
    }
  }
  const out = []
  ;(roster || []).forEach((p, index) => {
    const same = byName.get(rowKey(p?.lastName, p?.firstName)) || []
    if (!same.length) return
    const dob = displayDobToIso(p?.dob) || null
    const hits = dob ? same.filter((c) => !c.dob || c.dob === dob) : same
    const genders = new Set(hits.map((c) => c.gender).filter(Boolean))
    if (genders.size !== 1) return
    const [g] = genders
    if (g !== gender) out.push({ index, name: `${p.firstName || ''} ${p.lastName || ''}`.trim(), gender: g })
  })
  return out
}
