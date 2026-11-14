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
// at most 12 players besides the liberos: 13 or 14 only with two liberos (owner 2026-11-11)
export const GAME_ROSTER_MAX_REGULAR = 12
export const GAME_ROSTER_MIN_PLAYERS = 6
export const GAME_ROSTER_MAX_LIBEROS = 2
export const GAME_ROSTER_MAX_STAFF = 5

// Accents folded: "Felicián" typed by hand and "Felician" from VolleyManager are one person
const fold = (v) => normalizeName(v).normalize('NFD').replace(/\p{Diacritic}/gu, '')
const nameKey = (p) => `${fold(p?.last_name)}|${fold(p?.first_name)}`
const clean = (v) => String(v ?? '').trim()
const swappedKey = (p) => `${fold(p?.first_name)}|${fold(p?.last_name)}`
const licenceKey = (p) => clean(p?.license_number).toLowerCase()

const PDF_OFFICIAL_ROLES = [['coach', 'Coach'], ['ac1', 'Assistant Coach 1'], ['ac2', 'Assistant Coach 2']]

/** The parseRosterPdf result → { players, staff } in the API shape. */
export function parsedPdfToRoster(parsed) {
  const players = (parsed?.players || [])
    .filter((p) => clean(p?.lastName) || clean(p?.firstName))
    .map((p) => ({
      // an Einsatzliste never has shirt numbers, a captain or liberos (owner
      // 2026-11-10): whatever the PDF's text seems to say, they stay the team's
      number: null,
      first_name: clean(p.firstName),
      last_name: clean(p.lastName) || clean(p.firstName),
      dob: displayDobToIso(p.dob) || null,
      // VolleyManager's Einsatzliste: the SV number in front of each name
      license_number: /^\d{5,6}$/.test(clean(p.licence)) ? clean(p.licence) : null,
      is_libero: false,
      is_captain: false
    }))
  const staff = []
  for (const [k, role] of PDF_OFFICIAL_ROLES) {
    const s = parsed?.[k]
    if (!s || !(clean(s.lastName) || clean(s.firstName))) continue
    // the officials' SV number (#10001) is their licence; a year alone is no date of birth
    staff.push({
      role,
      first_name: clean(s.firstName),
      last_name: clean(s.lastName) || clean(s.firstName),
      dob: displayDobToIso(s.dob) || null,
      license_number: /^\d{4,7}$/.test(clean(s.licence)) ? clean(s.licence) : null
    })
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
/**
 * Who is who in a list of players (the API shape): find(p) is the index of
 * the same player, by licence, else by name (accents and case aside), else by
 * name with first and last name swapped, or undefined; remember(p, i) adds
 * one. The merge rules of an import, also used by "Add from club" (db/024).
 */
export function playerFinder(list = []) {
  const byName = new Map()
  const byLicence = new Map()
  const remember = (p, i) => {
    if (!byName.has(nameKey(p))) byName.set(nameKey(p), i)
    if (licenceKey(p) && !byLicence.has(licenceKey(p))) byLicence.set(licenceKey(p), i)
  }
  list.forEach(remember)
  const find = (p) => {
    const lk = licenceKey(p)
    return (lk ? byLicence.get(lk) : undefined) ?? byName.get(nameKey(p)) ?? byName.get(swappedKey(p))
  }
  return { find, remember }
}

/**
 * Are two people (the API shape or drafts) one? The same licence number when
 * both have one; else the same name, also with first and last name swapped.
 */
export function samePerson(a, b) {
  if (!a || !b) return false
  const la = licenceKey(a)
  const lb = licenceKey(b)
  if (la && lb) return la === lb
  return nameKey(a) === nameKey(b) || nameKey(a) === swappedKey(b)
}

export function mergeImportedRoster(players, staff, imported, makePlayer = (p) => p, makeStaff = (s) => s) {
  const out = [...(players || [])]
  let added = 0
  let updated = 0
  const { find, remember } = playerFinder(out)
  for (const p of imported?.players || []) {
    const i = find(p)
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
  // The Einsatzliste says who holds each of its roles (owner 2026-11-10: the
  // officials' roles follow it): the same person moves to the role, else the
  // role's row takes the person; whoever else held one of its roles, and the
  // same person in a second role, leaves the officials.
  const imp = (imported?.staff || []).filter((s) => s && STAFF_ROLES.includes(s.role))
  const onImport = (row) => imp.some((s) => samePerson(row, s))
  const work = [...(staff || [])]
  const keep = new Set()
  for (const s of imp) {
    let i = work.findIndex((x, j) => !keep.has(j) && samePerson(x, s))
    if (i === -1) i = work.findIndex((x, j) => !keep.has(j) && x.role === s.role && !onImport(x))
    if (i === -1) {
      work.push(makeStaff(s))
      keep.add(work.length - 1)
      added++
      continue
    }
    const cur = work[i]
    const same = samePerson(cur, s)
    const next = {
      ...cur,
      role: s.role,
      first_name: s.first_name,
      last_name: s.last_name,
      dob: s.dob || (same ? cur.dob : emptyLike(cur.dob)),
      license_number: s.license_number || (same ? cur.license_number : emptyLike(cur.license_number))
    }
    if (['role', 'first_name', 'last_name', 'dob', 'license_number'].some((f) => (next[f] ?? '') !== (cur[f] ?? ''))) updated++
    work[i] = next
    keep.add(i)
  }
  const roles = new Set(imp.map((s) => s.role))
  const outStaff = work.filter((x, j) => keep.has(j) || !(roles.has(x.role) || onImport(x)))
  if (outStaff.length < work.length) updated += work.length - outStaff.length
  return { players: out, staff: outStaff, added, updated }
}

/**
 * Each official role once in a game roster draft (owner 2026-11-11: "can't
 * be two coaches, two AC1, two AC2"), ticked or not: the ticked entries keep
 * their roles first, in order; an entry whose role is taken gets the first
 * free role, else none ('': it cannot be ticked until it gets one).
 */
export function uniqueStaffRoles(staff) {
  const list = staff || []
  const taken = new Set()
  const out = list.map((s) => ({ ...s }))
  const claim = (s) => {
    if (s.role && STAFF_ROLES.includes(s.role) && !taken.has(s.role)) {
      taken.add(s.role)
      return
    }
    const free = STAFF_ROLES.find((r) => !taken.has(r))
    s.role = free || ''
    if (free) taken.add(free)
    else s.picked = false
  }
  out.filter((s) => s.picked).forEach(claim)
  out.filter((s) => !s.picked).forEach(claim)
  return out
}

/**
 * A game roster draft (gameRosterDraft) with an Einsatzliste for the game
 * (parsedPdfToRoster) applied: its players ticked, the others unticked. An
 * Einsatzliste has no shirt numbers: a player already offered keeps the
 * draft's number, captain and libero (licence and date of birth filled from
 * the list); one not offered yet comes without a number. Its officials are
 * ticked in the roles it gives them (one entry per person: the draft's entry
 * moves to the role); every other official is unticked.
 * { draft, added } (added: the players not offered before).
 */
export function applyEinsatzlisteToGameDraft(draft, imported) {
  const before = draft?.players || []
  const { find } = playerFinder(before)
  const used = new Set()
  const keys = new Set(before.map((p) => p.key))
  const ticked = []
  let added = 0
  for (const p of imported?.players || []) {
    const i = find(p)
    if (i !== undefined && !used.has(i)) {
      used.add(i)
      const cur = before[i]
      ticked.push({ ...cur, license_number: cur.license_number || p.license_number || null, dob: cur.dob || p.dob || null, picked: true })
      continue
    }
    if (i !== undefined) continue // twice in the list
    let key = nameKey(p)
    while (keys.has(key)) key = `${key}|${p.license_number || added}`
    keys.add(key)
    ticked.push({ key, number: '', first_name: p.first_name, last_name: p.last_name, dob: p.dob || null, license_number: p.license_number || null, is_libero: false, is_captain: false, picked: true })
    added++
  }
  const rest = before.filter((_, i) => !used.has(i)).map((p) => ({ ...p, picked: false }))

  const staffBefore = draft?.staff || []
  const staffUsed = new Set()
  const staffKeys = new Set(staffBefore.map((s) => s.key))
  const staff = []
  for (const s of imported?.staff || []) {
    if (!STAFF_ROLES.includes(s?.role)) continue
    const i = staffBefore.findIndex((x, j) => !staffUsed.has(j) && samePerson(x, s))
    if (i !== -1) {
      staffUsed.add(i)
      const cur = staffBefore[i]
      staff.push({ ...cur, role: s.role, license_number: cur.license_number || s.license_number || null, dob: cur.dob || s.dob || null, picked: true })
      continue
    }
    let key = `${s.role}|${nameKey(s)}`
    while (staffKeys.has(key)) key = `${key}|${s.license_number || staff.length}`
    staffKeys.add(key)
    staff.push({ key, role: s.role, first_name: s.first_name, last_name: s.last_name, dob: s.dob || null, license_number: s.license_number || null, picked: true })
  }
  // the same person once: another entry of someone the list names goes
  const restStaff = staffBefore.filter((x, j) => !staffUsed.has(j) && !staff.some((s) => samePerson(x, s))).map((x) => ({ ...x, picked: false }))
  // with no officials in the list, the draft's ticks stay as they were
  const outStaff = staff.length ? [...staff, ...restStaff] : staffBefore
  return { draft: { ...(draft || {}), players: [...ticked, ...rest], staff: uniqueStaffRoles(outStaff) }, added }
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
  return { players, staff: uniqueStaffRoles(staff) }
}

/**
 * The PUT body of a game roster from the picker, its problems and warnings
 * ([{ key, params }], i18n keys under manage.myTeams.problems): problems
 * block sending (at most 14 players, more than 12 only with two liberos,
 * every one with a distinct number 0..99, one captain at most, two liberos
 * at most, each official role once; the server checks the same), warnings
 * do not (fewer than 6 players besides the liberos).
 */
export function gameRosterBody(draft) {
  const players = (draft?.players || []).filter((p) => p.picked)
  const staff = (draft?.staff || []).filter((s) => s.picked)
  const problems = []
  const liberos = players.filter((p) => p.is_libero).length
  if (players.length > GAME_ROSTER_MAX_PLAYERS) problems.push({ key: 'manage.myTeams.problems.tooMany', params: { max: GAME_ROSTER_MAX_PLAYERS } })
  else if (players.length > GAME_ROSTER_MAX_REGULAR && liberos < GAME_ROSTER_MAX_LIBEROS) problems.push({ key: 'manage.myTeams.problems.twoLiberos', params: { max: GAME_ROSTER_MAX_REGULAR, liberos: GAME_ROSTER_MAX_LIBEROS } })
  // fewer than 6 players besides the liberos: allowed (a game can start short), said
  const warnings = []
  const regular = players.length - liberos
  if (players.length > 0 && regular < GAME_ROSTER_MIN_PLAYERS) warnings.push({ key: 'manage.myTeams.problems.fewPlayers', params: { min: GAME_ROSTER_MIN_PLAYERS, count: regular } })
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
  if (liberos > GAME_ROSTER_MAX_LIBEROS) problems.push({ key: 'manage.myTeams.problems.liberos', params: { max: GAME_ROSTER_MAX_LIBEROS } })
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
    problems,
    warnings
  }
}

// ---------------------------------------------------------------- the club's players (db/024)

/** A club list person { sv_number, last_name, first_name, dob, gender } -> a player in the API shape (no number). */
export function clubPersonToPlayer(c) {
  return {
    number: null,
    first_name: clean(c?.first_name),
    last_name: clean(c?.last_name),
    dob: c?.dob || null,
    license_number: clean(c?.sv_number) || null,
    is_libero: false,
    is_captain: false
  }
}

/**
 * The club's players a team may add: those of the team's gender and those
 * whose gender the list does not say; all of them while the team's gender is
 * unknown (null).
 */
export function clubPlayersForGender(players, gender) {
  const list = Array.isArray(players) ? players : []
  if (gender !== 'm' && gender !== 'f') return list
  return list.filter((p) => !p?.gender || p.gender === gender)
}

/**
 * The indexes of `players` (the API shape, body order) whose licence number
 * is in the club's players list with the other gender than `gender`; [] while
 * the team's gender is unknown. The server refuses the same (OV_WRONG_GENDER).
 */
export function wrongGenderIndexes(players, clubPlayers, gender) {
  if (gender !== 'm' && gender !== 'f') return []
  const byLicence = new Map((clubPlayers || []).filter((c) => c?.gender).map((c) => [clean(c.sv_number), c.gender]))
  const out = []
  ;(players || []).forEach((p, i) => {
    const g = byLicence.get(clean(p?.license_number))
    if (g && g !== gender) out.push(i)
  })
  return out
}

/**
 * The squad editor's players and staff with `chosen` (club list people)
 * added: the merge rules of an import (the same licence, else name: the
 * existing row gets the licence and date of birth), new ones without a
 * number. { players, staff, added, updated }.
 */
export function addClubPlayersToSquad(players, staff, chosen, makePlayer = (p) => p, makeStaff = (s) => s) {
  return mergeImportedRoster(players, staff, { players: (chosen || []).map(clubPersonToPlayer), staff: [] }, makePlayer, makeStaff)
}

/**
 * A game roster draft (gameRosterDraft) with `chosen` (club list people)
 * ticked: one already offered (the same licence, else name) is ticked, the
 * others are added ticked, without a number. { draft, added, ticked }.
 */
export function addClubPlayersToGameDraft(draft, chosen) {
  const players = [...(draft?.players || [])]
  const { find, remember } = playerFinder(players)
  const keys = new Set(players.map((p) => p.key))
  let added = 0
  let ticked = 0
  for (const c of chosen || []) {
    const p = clubPersonToPlayer(c)
    const i = find(p)
    if (i !== undefined) {
      const cur = players[i]
      players[i] = { ...cur, picked: true, license_number: cur.license_number || p.license_number, dob: cur.dob || p.dob }
      if (!cur.picked) ticked++
      continue
    }
    let key = nameKey(p)
    while (keys.has(key)) key = `${key}|${p.license_number || added}`
    keys.add(key)
    players.push({ key, number: '', first_name: p.first_name, last_name: p.last_name, dob: p.dob, license_number: p.license_number, is_libero: false, is_captain: false, picked: true })
    remember(p, players.length - 1)
    added++
  }
  return { draft: { ...(draft || {}), players, staff: draft?.staff || [] }, added, ticked }
}

// ---------------------------------------------------------------- team officials from the club (db/024)
// Owner 2026-11-09: "coaches can literally be any player/member of the club
// from the list". An official (coach, assistant coaches, physiotherapist,
// medic) may be anyone of the club's three lists, of either gender: no
// gender filter and no gender rule for them.

/** A club list person -> a team official of `role` in the API shape. */
export function clubPersonToOfficial(c, role) {
  return {
    role,
    first_name: clean(c?.first_name),
    last_name: clean(c?.last_name) || clean(c?.first_name),
    dob: c?.dob || null,
    license_number: clean(c?.sv_number) || null
  }
}

/**
 * Is the official row `s` (the API shape) the club person `c`? The same
 * licence number; else the same name, also with first and last name swapped
 * (not when both have a licence number and they differ).
 */
export function officialIsPerson(s, c) {
  if (!s || !c) return false
  const p = clubPersonToOfficial(c, null)
  const a = licenceKey(s)
  const b = licenceKey(p)
  if (a && b) return a === b
  return nameKey(s) === nameKey(p) || nameKey(s) === swappedKey(p)
}

/** The roles in `staff` that the club person `c` holds (only the ticked entries with `pickedOnly`, a game roster). */
export function officialRolesOf(staff, c, { pickedOnly = false } = {}) {
  return [...new Set((staff || []).filter((s) => s && (!pickedOnly || s.picked) && officialIsPerson(s, c)).map((s) => s.role))]
}

/** The named person holding `role` in `staff` (the first one; only a ticked one with `pickedOnly`), or null. */
export function officialOfRole(staff, role, { pickedOnly = false } = {}) {
  return (staff || []).find((s) => s && s.role === role && (!pickedOnly || s.picked) && (clean(s.first_name) || clean(s.last_name))) || null
}

// the empty value of a field as the row keeps it ('' in the editor's drafts, null in the API shape)
const emptyLike = (v) => (typeof v === 'string' ? '' : null)

/**
 * The squad editor's officials with the club person `c` as `role`: the first
 * row of that role takes the person (names, date of birth, licence number;
 * the row keeps its key and id), else a row is added (makeStaff). Each role
 * once. { staff, replaced }: the person the row had before, when another one.
 */
export function setSquadOfficial(staff, role, c, makeStaff = (s) => s) {
  const out = [...(staff || [])]
  const person = clubPersonToOfficial(c, role)
  const i = out.findIndex((s) => s?.role === role)
  if (i === -1) {
    out.push(makeStaff(person))
    return { staff: out, replaced: null }
  }
  const cur = out[i]
  const same = officialIsPerson(cur, c)
  const named = !!(clean(cur.first_name) || clean(cur.last_name))
  out[i] = {
    ...cur,
    first_name: person.first_name,
    last_name: person.last_name,
    dob: person.dob || (same ? cur.dob : emptyLike(cur.dob)),
    license_number: person.license_number || (same ? cur.license_number : emptyLike(cur.license_number))
  }
  return { staff: out, replaced: named && !same ? cur : null }
}

/**
 * A game roster draft (gameRosterDraft) with the club person `c` as `role`,
 * ticked: the entry of that role and person when it is offered, else a new
 * entry; the other ticked entries of that role are unticked (each role once,
 * as gameRosterBody wants). { draft, replaced }: the person ticked in that
 * role before, when another one.
 */
export function setGameDraftOfficial(draft, role, c) {
  const staff = [...(draft?.staff || [])]
  const person = clubPersonToOfficial(c, role)
  const before = officialOfRole(staff, role, { pickedOnly: true })
  // the person once: an entry of them in another role moves to this one
  let at = staff.findIndex((s) => s?.role === role && officialIsPerson(s, c))
  if (at === -1) at = staff.findIndex((s) => officialIsPerson(s, c))
  if (at === -1) {
    const keys = new Set(staff.map((s) => s.key))
    let key = `${role}|${nameKey(person)}`
    while (keys.has(key)) key = `${key}|${person.license_number || staff.length}`
    staff.push({ key, ...person, picked: true })
    at = staff.length - 1
  } else {
    const cur = staff[at]
    staff[at] = { ...cur, role, picked: true, license_number: cur.license_number || person.license_number, dob: cur.dob || person.dob }
  }
  // the one who held the role moves to a free one, unticked (each role once)
  const out = staff.map((s, j) => (j !== at && s.role === role ? { ...s, picked: false } : s))
  const mine = out[at]
  const deduped = uniqueStaffRoles([mine, ...out.filter((_, j) => j !== at)])
  const ordered = out.map((s, j) => (j === at ? deduped[0] : deduped.find((d) => d.key === s.key)))
  return {
    draft: { ...(draft || {}), players: draft?.players || [], staff: ordered },
    replaced: before && !officialIsPerson(before, c) ? before : null
  }
}

// ---------------------------------------------------------------- green and gray shields
// Owner 2026-11-10: "Those from the club/recognized/linked -> green shield.
// Those added manually -> gray shield, but can be linked lately in case", and
// "if I add somebody manually, when saving ask if I want to save him/her in
// the club".

const SV_RE = /^[0-9]{4,7}$/

/**
 * The club person a roster row (a player or an official, the API shape or an
 * editor draft) is, or null: not in the club's lists. The same licence
 * number; else the same name (accents, case and the order of first and last
 * name aside) and the same date of birth, when that is one person of the club
 * (or one uploaded person among others kept by hand). A person kept by hand
 * (`manual`) has a gray shield too, an uploaded one a green shield.
 */
export function clubPersonOf(row, people) {
  if (!row || !Array.isArray(people) || !people.length) return null
  const lic = clean(row.license_number)
  if (SV_RE.test(lic)) {
    const hit = people.find((c) => clean(c?.sv_number) === lic)
    if (hit) return hit
  }
  const dob = clean(row.dob)
  if (!dob || !clean(row.last_name)) return null
  const keys = new Set([nameKey(row), swappedKey(row)])
  const hits = people.filter((c) => c?.dob === dob && keys.has(nameKey(c)))
  if (hits.length === 1) return hits[0]
  // one uploaded and others kept by hand: the uploaded one
  const uploaded = hits.filter((c) => !c.manual)
  return uploaded.length === 1 ? uploaded[0] : null
}

/** What the club person `c` adds to the row `row`: the fields the row leaves empty ({} when none). */
export function clubFillOf(row, c) {
  if (!row || !c) return {}
  const out = {}
  if (!clean(row.first_name) && clean(c.first_name)) out.first_name = clean(c.first_name)
  if (!clean(row.dob) && c.dob) out.dob = c.dob
  if (!clean(row.license_number) && clean(c.sv_number)) out.license_number = clean(c.sv_number)
  return out
}

/** The row `row` linked to the club person `c`: its names, date of birth and licence number from the club. */
export function linkRowToClubPerson(row, c) {
  return {
    ...row,
    first_name: clean(c?.first_name) || clean(row?.first_name),
    last_name: clean(c?.last_name) || clean(row?.last_name),
    dob: c?.dob || row?.dob || emptyLike(row?.dob),
    license_number: clean(c?.sv_number) || row?.license_number || emptyLike(row?.license_number)
  }
}

/**
 * The rows typed by hand that Save offers to keep in the club's lists: no
 * club person and a last name. The lists are keyed by the licence number, so
 * only those with one can go there (`offer`); the others are `noLicence`
 * (their names). Players go to the players list (with the team's gender when
 * it is known), officials to the coaches list; one entry per list and licence.
 * { offer: [{ key, list, name, person: { sv_number, last_name, first_name, dob, gender } }], noLicence: [name] }
 */
export function handTypedForClub(players, staff, people, gender = null) {
  const offer = []
  const noLicence = []
  const seen = new Set()
  const add = (row, list) => {
    if (!row || !clean(row.last_name) || clubPersonOf(row, people)) return
    const name = `${clean(row.first_name)} ${clean(row.last_name)}`.trim()
    const lic = clean(row.license_number)
    if (!SV_RE.test(lic)) {
      if (!noLicence.includes(name)) noLicence.push(name)
      return
    }
    const key = `${list}:${lic}`
    if (seen.has(key)) return
    seen.add(key)
    offer.push({
      key,
      list,
      name,
      person: {
        sv_number: lic,
        last_name: clean(row.last_name),
        first_name: clean(row.first_name) || null,
        dob: clean(row.dob) || null,
        gender: list === 'players' && (gender === 'm' || gender === 'f') ? gender : null
      }
    })
  }
  for (const p of players || []) add(p, 'players')
  for (const s of staff || []) add(s, 'coaches')
  return { offer, noLicence }
}

// ---------------------------------------------------------------- a game roster's officials
// Owner 2026-11-10: "have the possibility to change role for the staff
// (coach/ac1/ac2/p/m) and also have people be put as P/M manually (e.g. not
// necessarily from the club)".

/**
 * A game roster draft with the official `key` in `role`. Each role once
 * (uniqueStaffRoles): the entry that held the role takes the official's old
 * one, a swap (owner 2026-11-11). { draft, replaced }: that entry, or null.
 */
export function setGameDraftStaffRole(draft, key, role) {
  if (!STAFF_ROLES.includes(role)) return { draft, replaced: null }
  const staff = draft?.staff || []
  const me = staff.find((s) => s.key === key)
  if (!me || me.role === role) return { draft, replaced: null }
  const other = staff.find((s) => s.key !== key && s.role === role) || null
  const out = staff.map((s) => {
    if (s.key === key) return { ...s, role }
    if (other && s.key === other.key) return { ...s, role: me.role || '', picked: me.role ? s.picked : false }
    return s
  })
  return { draft: { ...(draft || {}), players: draft?.players || [], staff: uniqueStaffRoles(out) }, replaced: other }
}

/**
 * The role offered for an official added by hand to a game roster: the
 * physiotherapist, else the medic, else the first role nobody holds (ticked),
 * else the physiotherapist.
 */
export function roleForNewOfficial(staff) {
  const held = new Set((staff || []).filter((s) => s?.picked).map((s) => s.role))
  return ['Physiotherapist', 'Medic', ...STAFF_ROLES].find((r) => !held.has(r)) || 'Physiotherapist'
}
