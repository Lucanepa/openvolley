/**
 * The club's people in Match Setup (db/024, docs/club-licences-spec.md
 * section 5): "Add from club" for a team of the scorer's clubs, from the
 * tablet's copy (db/clubPlayers.js): players (the players list, the game's
 * gender) for the roster, anyone of the club's lists for the bench officials;
 * and the gender warning. Plain data, no React, no network.
 *
 * Match Setup's roster rows are { number, firstName, lastName, dob
 * (DD.MM.YYYY), libero, isCaptain, isLfp } and its bench rows { role,
 * firstName, lastName, dob }, without a licence number, so a club person is
 * matched by name (accents and case aside, also with first and last name
 * swapped) and, for the warning, when both have one, the date of birth.
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

/**
 * The roles of Match Setup's `bench` held by the club person `c` (by name,
 * also with the names swapped). Officials may be anyone of the club, of
 * either gender (owner 2026-11-09): no gender check for them.
 */
export function benchRolesOf(bench, c) {
  const want = rowKey(c?.last_name, c?.first_name)
  const swapped = rowKey(c?.first_name, c?.last_name)
  return [...new Set((bench || []).filter((b) => {
    if (!b || !(String(b.lastName || '').trim() || String(b.firstName || '').trim())) return false
    const k = rowKey(b.lastName, b.firstName)
    return k === want || k === swapped
  }).map((b) => b.role))]
}

/** The named bench row of `role`, or null. */
export function benchOfficialOfRole(bench, role) {
  return (bench || []).find((b) => b && b.role === role && (String(b.lastName || '').trim() || String(b.firstName || '').trim())) || null
}

/**
 * Match Setup's bench with the club person `c` as `role`: the row of that
 * role takes the names and the date of birth (DD.MM.YYYY), else a row of
 * that role is added. Each role once, as Match Setup keeps them. { bench,
 * replaced }: the row's person before ({ firstName, lastName }), when
 * another one.
 */
export function setBenchOfficial(bench, role, c) {
  const out = [...(bench || [])]
  const row = { firstName: String(c?.first_name || '').trim(), lastName: String(c?.last_name || '').trim(), dob: isoToDisplayDob(c?.dob) }
  const i = out.findIndex((b) => b?.role === role)
  if (i === -1) {
    out.push({ role, ...row })
    return { bench: out, replaced: null }
  }
  const cur = out[i]
  const same = benchRolesOf([cur], c).length > 0
  const named = !!(String(cur.firstName || '').trim() || String(cur.lastName || '').trim())
  out[i] = { ...cur, ...row, dob: row.dob || (same ? cur.dob || '' : '') }
  return { bench: out, replaced: named && !same ? cur : null }
}

// ---------------------------------------------------------------- shields
// Owner 2026-11-10: "Those from the club/recognized/linked -> green shield.
// Those added manually -> gray shield, but can be linked lately in case."
// Match Setup's rows have no licence number: a row is a club person by name
// (accents, case and the order of first and last name aside) and, when both
// have one, the date of birth.

/**
 * The club person of a Match Setup row ({ firstName, lastName, dob
 * DD.MM.YYYY }) in `people`, or null (typed by hand): one person of that
 * name (and date of birth), or one uploaded person among others kept by hand.
 * A person kept by hand (`manual`) has a gray shield too.
 */
export function clubPersonOfRow(row, people) {
  if (!row || !Array.isArray(people) || !people.length) return null
  if (!String(row.lastName || '').trim()) return null
  const keys = new Set([rowKey(row.lastName, row.firstName), rowKey(row.firstName, row.lastName)])
  let hits = people.filter((c) => c && keys.has(rowKey(c.last_name, c.first_name)))
  const dob = displayDobToIso(row.dob) || null
  if (dob) hits = hits.filter((c) => !c.dob || c.dob === dob)
  if (hits.length === 1) return hits[0]
  const uploaded = hits.filter((c) => !c.manual)
  return uploaded.length === 1 ? uploaded[0] : null
}

/** What the club person `c` adds to a Match Setup row: { first_name?, dob? } in the row's formats ({} when nothing). */
export function clubFillOfRow(row, c) {
  if (!row || !c) return {}
  const out = {}
  if (!String(row.firstName || '').trim() && String(c.first_name || '').trim()) out.first_name = String(c.first_name).trim()
  if (!String(row.dob || '').trim() && c.dob) out.dob = isoToDisplayDob(c.dob)
  return out
}

/** A Match Setup row with clubFillOfRow's fields applied. */
export function applyClubFill(row, fill) {
  return { ...row, ...(fill.first_name ? { firstName: fill.first_name } : {}), ...(fill.dob ? { dob: fill.dob } : {}) }
}

/** A Match Setup row (roster or bench) linked to the club person `c`: its names and date of birth from the club. */
export function linkRowToClub(row, c) {
  return {
    ...row,
    firstName: String(c?.first_name || '').trim() || row?.firstName || '',
    lastName: String(c?.last_name || '').trim() || row?.lastName || '',
    dob: isoToDisplayDob(c?.dob) || row?.dob || ''
  }
}
