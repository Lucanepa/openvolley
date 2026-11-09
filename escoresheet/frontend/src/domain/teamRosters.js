/**
 * A team manager's rosters (db/023, docs/team-managers-spec.md): the
 * Einsatzliste read from a PDF, merged into the team's saved team, and the
 * roster of one game picked from it. Plain data, no React, no network.
 *
 * The API shape is the saved teams' one: { number, first_name, last_name,
 * dob (YYYY-MM-DD | null), license_number, is_libero, is_captain } and staff
 * { role, first_name, last_name, dob, license_number }.
 */

import { STAFF_ROLES, displayDobToIso, normalizeName } from './savedTeams'

// lib/teams.js (FIVB 4.1.1, VolleyManager's own limit)
export const GAME_ROSTER_MAX_PLAYERS = 14
export const GAME_ROSTER_MIN_PLAYERS = 6
export const GAME_ROSTER_MAX_LIBEROS = 2
export const GAME_ROSTER_MAX_STAFF = 5

// Accents folded: "Felicián" typed by hand and "Felician" from VolleyManager are one person
const fold = (v) => normalizeName(v).normalize('NFD').replace(/\p{Diacritic}/gu, '')
const nameKey = (p) => `${fold(p?.last_name)}|${fold(p?.first_name)}`
const clean = (v) => String(v ?? '').trim()
const swappedKey = (p) => `${fold(p?.first_name)}|${fold(p?.last_name)}`
const licenceKey = (p) => clean(p?.license_number).toLowerCase()

/** The parseRosterPdf result → { players, staff } in the API shape. */
export function parsedPdfToRoster(parsed) {
  const players = (parsed?.players || [])
    .filter((p) => clean(p?.lastName) || clean(p?.firstName))
    .map((p) => ({
      number: Number.isInteger(p.number) && p.number >= 0 && p.number <= 99 ? p.number : null,
      first_name: clean(p.firstName),
      last_name: clean(p.lastName) || clean(p.firstName),
      dob: displayDobToIso(p.dob) || null,
      // VolleyManager's Einsatzliste: the SV number in front of each name
      license_number: /^\d{5,6}$/.test(clean(p.licence)) ? clean(p.licence) : null,
      is_libero: false,
      is_captain: false
    }))
  const staff = []
  for (const [k, role] of [['coach', 'Coach'], ['ac1', 'Assistant Coach 1'], ['ac2', 'Assistant Coach 2']]) {
    const s = parsed?.[k]
    if (!s || !(clean(s.lastName) || clean(s.firstName))) continue
    staff.push({ role, first_name: clean(s.firstName), last_name: clean(s.lastName) || clean(s.firstName), dob: displayDobToIso(s.dob) || null, license_number: null })
  }
  return { players, staff }
}

/**
 * Merge an imported roster into the saved team's players and staff (drafts
 * keep their own fields, e.g. `key` and `id`): the same player gets the
 * imported number, date of birth and licence where the import has them, a new
 * player is added (active). The same player = the same licence, else the same
 * name (accents and case aside), else the same name with first and last name
 * swapped; a player twice in the import is one. Staff by role: the import fills
 * a role's person. Returns { players, staff, added, updated }.
 */
export function mergeImportedRoster(players, staff, imported, makePlayer = (p) => p, makeStaff = (s) => s) {
  const out = [...(players || [])]
  let added = 0
  let updated = 0
  const byName = new Map()
  const byLicence = new Map()
  const remember = (p, i) => {
    if (!byName.has(nameKey(p))) byName.set(nameKey(p), i)
    if (licenceKey(p) && !byLicence.has(licenceKey(p))) byLicence.set(licenceKey(p), i)
  }
  out.forEach(remember)
  for (const p of imported?.players || []) {
    const lk = licenceKey(p)
    const i = (lk ? byLicence.get(lk) : undefined) ?? byName.get(nameKey(p)) ?? byName.get(swappedKey(p))
    if (i === undefined) {
      out.push(makePlayer({ ...p, active: true }))
      remember(p, out.length - 1)
      added++
      continue
    }
    const cur = out[i]
    const next = { ...cur }
    if (p.number != null && String(cur.number ?? '') !== String(p.number)) next.number = p.number
    if (p.dob && cur.dob !== p.dob) next.dob = p.dob
    if (p.license_number && cur.license_number !== p.license_number) next.license_number = p.license_number
    if (cur.active === false) next.active = true
    if (next.number !== cur.number || next.dob !== cur.dob || next.license_number !== cur.license_number || next.active !== cur.active) {
      out[i] = next
      remember(next, i)
      updated++
    }
  }
  const outStaff = [...(staff || [])]
  for (const s of imported?.staff || []) {
    const i = outStaff.findIndex((x) => x.role === s.role)
    if (i === -1) {
      outStaff.push(makeStaff(s))
      added++
    } else if (nameKey(outStaff[i]) !== nameKey(s) || (s.dob && outStaff[i].dob !== s.dob)) {
      outStaff[i] = { ...outStaff[i], first_name: s.first_name, last_name: s.last_name, dob: s.dob || outStaff[i].dob }
      updated++
    }
  }
  return { players: out, staff: outStaff, added, updated }
}

/**
 * The picker of one game's roster: every active player of the saved team
 * (and the players of a roster already sent, ticked), with their numbers.
 * Returns [{ key, number, first_name, last_name, dob, license_number,
 * is_libero, is_captain, picked }] and the staff the same way.
 */
export function gameRosterDraft(squad, sent) {
  const picked = new Map((sent?.players || []).map((p) => [nameKey(p), p]))
  const players = []
  const seen = new Set()
  for (const p of (squad?.players || []).filter((x) => x && x.active !== false)) {
    const k = nameKey(p)
    if (seen.has(k)) continue
    seen.add(k)
    const s = picked.get(k)
    players.push({
      key: k,
      number: s?.number ?? p.number ?? '',
      first_name: p.first_name || '',
      last_name: p.last_name || '',
      dob: p.dob || null,
      license_number: p.license_number || null,
      is_libero: s ? !!s.is_libero : !!p.is_libero,
      is_captain: s ? !!s.is_captain : !!p.is_captain,
      picked: !!s
    })
  }
  // a player sent earlier who is no longer in the saved team stays offered
  for (const s of sent?.players || []) {
    const k = nameKey(s)
    if (seen.has(k)) continue
    seen.add(k)
    players.push({ key: k, number: s.number ?? '', first_name: s.first_name || '', last_name: s.last_name || '', dob: s.dob || null, license_number: s.license_number || null, is_libero: !!s.is_libero, is_captain: !!s.is_captain, picked: true })
  }
  const sentStaff = new Map((sent?.staff || []).map((s) => [`${s.role}|${nameKey(s)}`, s]))
  const staff = []
  const staffSeen = new Set()
  for (const s of [...(squad?.staff || []), ...(sent?.staff || [])]) {
    if (!STAFF_ROLES.includes(s?.role)) continue
    const k = `${s.role}|${nameKey(s)}`
    if (staffSeen.has(k)) continue
    staffSeen.add(k)
    staff.push({ key: k, role: s.role, first_name: s.first_name || '', last_name: s.last_name || '', dob: s.dob || null, license_number: s.license_number || null, picked: sent ? sentStaff.has(k) : true })
  }
  // A new roster: no player ticked yet when the saved team has more than 14
  if (!sent) {
    const active = players.length
    for (const p of players) p.picked = active <= GAME_ROSTER_MAX_PLAYERS
    // one person per role ticked by default
    const roles = new Set()
    for (const s of staff) {
      s.picked = !roles.has(s.role)
      roles.add(s.role)
    }
  }
  return { players, staff }
}

/**
 * The PUT body of a game roster from the picker, and its problems
 * ([{ key, params }], i18n keys under manage.myTeams.problems): at most 14
 * players, every one with a distinct number 0..99, one captain at most, two
 * liberos at most, each official role once. The server checks the same.
 */
export function gameRosterBody(draft) {
  const players = (draft?.players || []).filter((p) => p.picked)
  const staff = (draft?.staff || []).filter((s) => s.picked)
  const problems = []
  if (players.length > GAME_ROSTER_MAX_PLAYERS) problems.push({ key: 'manage.myTeams.problems.tooMany', params: { max: GAME_ROSTER_MAX_PLAYERS } })
  const numbers = new Set()
  for (const p of players) {
    const n = clean(p.number)
    const name = `${p.first_name} ${p.last_name}`.trim()
    if (!/^\d{1,2}$/.test(n)) {
      problems.push({ key: 'manage.myTeams.problems.number', params: { name } })
      continue
    }
    if (numbers.has(Number(n))) problems.push({ key: 'manage.myTeams.problems.numberTwice', params: { number: Number(n) } })
    numbers.add(Number(n))
  }
  if (players.filter((p) => p.is_captain).length > 1) problems.push({ key: 'manage.myTeams.problems.captains', params: {} })
  if (players.filter((p) => p.is_libero).length > GAME_ROSTER_MAX_LIBEROS) problems.push({ key: 'manage.myTeams.problems.liberos', params: { max: GAME_ROSTER_MAX_LIBEROS } })
  const roles = new Set()
  for (const s of staff) {
    if (roles.has(s.role)) problems.push({ key: 'manage.myTeams.problems.roleTwice', params: { role: s.role } })
    roles.add(s.role)
  }
  if (staff.length > GAME_ROSTER_MAX_STAFF) problems.push({ key: 'manage.myTeams.problems.tooManyStaff', params: { max: GAME_ROSTER_MAX_STAFF } })
  const person = (p) => ({ first_name: clean(p.first_name), last_name: clean(p.last_name), dob: p.dob || null, license_number: clean(p.license_number) || null })
  return {
    body: {
      players: players.map((p) => ({ number: /^\d{1,2}$/.test(clean(p.number)) ? Number(clean(p.number)) : null, ...person(p), is_libero: !!p.is_libero, is_captain: !!p.is_captain })),
      staff: staff.map((s) => ({ role: s.role, ...person(s) }))
    },
    problems
  }
}
