/**
 * Saved teams (competition manager): pure conversions between a saved team
 * (GET /api/saved-teams bundle or the Dexie cache row) and MatchSetup's roster
 * and bench, plus the schedule-game suggestions. Spec section 6.1.
 *
 * A saved team may come in either shape:
 * - the API's snake_case team ({ svrz_team_name, competition_id, updated_at, ... }),
 * - the Dexie cache's camelCase row ({ svrzTeamName, competition: {...}, updatedAt, ... }).
 * Players and staff stay in the API's snake_case shape in both.
 */

import { seasonOf, seasonLabel } from './season'
import { licenceOf } from './idMode'

export const STAFF_ROLES = ['Coach', 'Assistant Coach 1', 'Assistant Coach 2', 'Physiotherapist', 'Medic']
export const MAX_PLAYERS = 40
export const MAX_STAFF = 10
export const SPORTS = ['indoor', 'beach']
export const BEACH_MAX_PLAYERS = 2
export const BEACH_MAX_STAFF = 1

/**
 * The sport of a competition, an API team or a cache row's competition:
 * 'beach' only when it says so (2.1.0 data has no sport and is indoor).
 */
export function sportOf(x) {
  return x?.sport === 'beach' ? 'beach' : 'indoor'
}

/**
 * A copy of a GET /api/saved-teams bundle with only the competitions of
 * `sport` and the teams of those competitions.
 */
export function bundleForSport(bundle, sport) {
  const competitions = (Array.isArray(bundle?.competitions) ? bundle.competitions : []).filter(c => c && sportOf(c) === sport)
  const ids = new Set(competitions.map(c => c.id))
  const teams = (Array.isArray(bundle?.teams) ? bundle.teams : []).filter(t => t && ids.has(t.competition_id))
  return { ...(bundle || {}), sport, competitions, teams }
}

/** The beach seasons to offer: last, this and next calendar year in Zurich, as strings. */
export function beachSeasonOptions(now = new Date()) {
  const y = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric' }).format(now))
  return [String(y - 1), String(y), String(y + 1)]
}

/** Lowercase, trimmed, inner whitespace collapsed. */
export function normalizeName(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

/** 'YYYY-MM-DD' → 'DD.MM.YYYY' (MatchSetup's DOB format); anything else → ''. */
export function isoToDisplayDob(dob) {
  if (!dob) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dob))
  return m ? `${m[3]}.${m[2]}.${m[1]}` : ''
}

/**
 * MatchSetup's DOB ('DD.MM.YYYY', 'DD/MM/YYYY' or ISO) → 'YYYY-MM-DD' or null.
 * The same rules as MatchSetup's formatDobForSync.
 */
export function displayDobToIso(dob) {
  if (!dob) return null
  const s = String(dob).trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/) || s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m) {
    const [, day, month, year] = m
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  }
  return null
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 && n <= 99 ? n : null
}

function sortByOrder(list) {
  return [...(Array.isArray(list) ? list : [])]
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const ao = Number.isFinite(a.item?.sort_order) ? a.item.sort_order : a.index
      const bo = Number.isFinite(b.item?.sort_order) ? b.item.sort_order : b.index
      return ao - bo || a.index - b.index
    })
    .map(x => x.item)
}

// Field access for both team shapes.
export function teamSvrzName(team) { return team?.svrzTeamName ?? team?.svrz_team_name ?? '' }
export function teamUpdatedAt(team) { return team?.updatedAt ?? team?.updated_at ?? null }
export function teamCompetitionId(team) { return team?.competitionId ?? team?.competition_id ?? team?.competition?.id ?? null }

/**
 * A saved team → MatchSetup roster + bench. The value beside each name is the
 * saved licence number (a Swiss match: licence or date of birth,
 * domain/idMode); a saved date of birth never comes into the match (owner
 * 2026-11-19).
 * @returns {{ roster: object[], bench: object[], meta: {name: string, color: string}, warnings: {key: string, params: object}[] }}
 */
export function savedTeamToRoster(team) {
  const warnings = []
  const players = sortByOrder(team?.players).filter(p => p && p.active !== false)
  let liberos = 0
  let captainTaken = false
  let extraLiberos = false
  const roster = players.map(p => {
    let libero = ''
    if (p.is_libero) {
      liberos += 1
      if (liberos === 1) libero = 'libero1'
      else if (liberos === 2) libero = 'libero2'
      else extraLiberos = true
    }
    const isCaptain = !!p.is_captain && !captainTaken
    if (isCaptain) captainTaken = true
    return {
      number: toNumberOrNull(p.number),
      firstName: p.first_name || '',
      lastName: p.last_name || '',
      dob: licenceOf(p.license_number) || '',
      libero,
      isCaptain,
      isLfp: false
    }
  })
  if (extraLiberos) warnings.push({ key: 'savedTeams.tooManyLiberos', params: { name: team?.name || '' } })

  const bench = sortByOrder(team?.staff)
    .filter(s => s && STAFF_ROLES.includes(s.role))
    .map(s => ({ role: s.role, firstName: s.first_name || '', lastName: s.last_name || '', dob: licenceOf(s.license_number) || '' }))
  if (!bench.some(b => b.role === 'Coach')) bench.unshift({ role: 'Coach', firstName: '', lastName: '', dob: '' })

  return {
    roster,
    bench,
    meta: { name: team?.name || '', color: team?.color || '' },
    warnings
  }
}

/**
 * Is `typed` the name `name` (spaces at the ends and case aside)? A
 * competition with teams, or a team with people, is deleted only with its
 * name typed (the server compares the same way, lib/savedTeams.js).
 */
export function sameTypedName(typed, name) {
  const norm = (v) => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
  return typeof typed === 'string' && norm(typed) !== '' && norm(typed) === norm(name)
}

/**
 * MatchSetup roster + bench → the PUT /api/saved-teams/teams/:id/roster body.
 *
 * The roster is this match's players, often some of the team ("Choose
 * players"): it updates the saved players it has and adds the others. The
 * saved players not in it stay as they are, active or not (owner,
 * 2026-10-21: saving a match roster must not delete the rest of the team).
 * Two things give way so the server takes the body: a kept player whose
 * number a roster player now wears loses the number, and a kept captain is
 * not one when the roster names one.
 *
 * The value beside a roster name is a licence or a date of birth
 * (domain/idMode): a licence goes to license_number, a date of birth is never
 * written (owner 2026-11-19: no birthdates outside the sheet), and the body
 * carries no dob at all, so the saved dates of birth go too.
 *
 * A saved player is the roster player with the same licence; else the same
 * number, last and first name; else the same last and first name (a new
 * number). Never one with another licence than the row's. Another first name
 * is another person, also with the same number or last name (a sibling, a
 * twin, who wears the other's former number never takes over the other's
 * record and licence): a new row. A saved player keeps its id, and its
 * licence when the row has none. Staff: the bench replaces them; an official
 * keeps its id and licence with the same licence, else the same role, last
 * name and first name (or none on the bench), else the same names in another
 * role.
 */
export function rosterToSavedRoster(roster, bench, existingTeam = null) {
  const existingPlayers = Array.isArray(existingTeam?.players) ? existingTeam.players : []
  const existingStaff = Array.isArray(existingTeam?.staff) ? existingTeam.staff : []
  const usedIds = new Set()

  const playerKey = (number, lastName) => `${toNumberOrNull(number) ?? ''}|${normalizeName(lastName)}`
  const free = (p) => p?.id && !usedIds.has(p.id)
  const sameFirst = (saved, row) => normalizeName(saved?.first_name) === normalizeName(row?.firstName)
  // the row's licence and the saved one's, when both have one, are the same
  const licenceFits = (saved, licence) => !licence || !licenceOf(saved?.license_number) || licenceOf(saved.license_number) === licence
  const findPlayer = (p) => {
    const licence = licenceOf(p.dob)
    if (licence) {
      const byLicence = existingPlayers.find(e => free(e) && licenceOf(e.license_number) === licence)
      if (byLicence) return byLicence
    }
    const byNumber = existingPlayers.find(e => free(e) && licenceFits(e, licence) && playerKey(e.number, e.last_name) === playerKey(p.number, p.lastName) && sameFirst(e, p))
    if (byNumber) return byNumber
    const last = normalizeName(p.lastName)
    const first = normalizeName(p.firstName)
    if (!last || !first) return null
    return existingPlayers.find(e => free(e) && licenceFits(e, licence) &&
      normalizeName(e.last_name) === last && sameFirst(e, p)) || null
  }

  const chosen = (Array.isArray(roster) ? roster : [])
    .filter(p => p && (String(p.lastName || '').trim() || String(p.firstName || '').trim()))
    .map(p => {
      const match = findPlayer(p)
      if (match) usedIds.add(match.id)
      const row = {
        number: toNumberOrNull(p.number),
        first_name: String(p.firstName || '').trim(),
        last_name: String(p.lastName || '').trim(),
        license_number: licenceOf(p.dob) ?? match?.license_number ?? null,
        is_libero: p.libero === 'libero1' || p.libero === 'libero2',
        is_captain: !!p.isCaptain,
        active: true
      }
      if (match) row.id = match.id
      return row
    })

  const takenNumbers = new Set(chosen.map(p => p.number).filter(n => n !== null))
  const rosterCaptain = chosen.some(p => p.is_captain)
  const kept = existingPlayers
    .filter(p => p && !(p.id && usedIds.has(p.id)))
    .map(p => {
      const active = p.active !== false
      const number = toNumberOrNull(p.number)
      return {
        ...(p.id ? { id: p.id } : {}),
        number: active && number !== null && takenNumbers.has(number) ? null : number,
        first_name: p.first_name || '',
        last_name: p.last_name || '',
        license_number: p.license_number ?? null,
        is_libero: !!p.is_libero,
        is_captain: active && !!p.is_captain && !rosterCaptain,
        active
      }
    })

  // The active players by number (without one last), then the inactive ones
  const byNumber = (a, b) => (a.number ?? 1000) - (b.number ?? 1000)
  const players = [
    ...[...chosen, ...kept.filter(p => p.active)].sort(byNumber),
    ...kept.filter(p => !p.active)
  ]

  const usedStaff = new Set()
  const staff = (Array.isArray(bench) ? bench : [])
    .filter(b => b && STAFF_ROLES.includes(b.role) && (String(b.lastName || '').trim() || String(b.firstName || '').trim()))
    .map(b => {
      const licence = licenceOf(b.dob)
      const free = (s) => s?.id && !usedStaff.has(s.id) && licenceFits(s, licence) && normalizeName(s.last_name) === normalizeName(b.lastName)
      const match = (licence ? existingStaff.find(s => s?.id && !usedStaff.has(s.id) && licenceOf(s.license_number) === licence) : null) ||
        existingStaff.find(s => free(s) && s.role === b.role && (sameFirst(s, b) || !normalizeName(b.firstName))) ||
        (normalizeName(b.firstName) ? existingStaff.find(s => free(s) && sameFirst(s, b)) : null) || null
      if (match) usedStaff.add(match.id)
      const row = {
        role: b.role,
        first_name: String(b.firstName || '').trim(),
        last_name: String(b.lastName || '').trim(),
        license_number: licence ?? match?.license_number ?? null
      }
      if (match) row.id = match.id
      return row
    })

  return { players, staff }
}

/**
 * Client-side check of a roster body, mirroring the server's rules (spec 5.5;
 * beach: docs/beach-saved-teams-spec.md 2.5), so the editor can show the
 * problem before the request.
 * @returns {{index: number|null, list: 'players'|'staff', key: string, params?: object}[]}
 */
export function validateSavedRoster({ players = [], staff = [] } = {}, { sport = 'indoor' } = {}) {
  const errors = []
  if (sport === 'beach') {
    if (players.length > BEACH_MAX_PLAYERS) errors.push({ index: null, list: 'players', key: 'manage.errors.generic' })
    if (staff.length > BEACH_MAX_STAFF) errors.push({ index: null, list: 'staff', key: 'manage.errors.generic' })
    players.forEach((p, index) => {
      if (!String(p.last_name || '').trim()) errors.push({ index, list: 'players', key: 'savedTeams.errors.lastNameRequired' })
      const country = String(p.country ?? '').trim()
      if (country && !/^[A-Z]{3}$/i.test(country)) errors.push({ index, list: 'players', key: 'savedTeams.errors.countryFormat' })
    })
    staff.forEach((s, index) => {
      if (!String(s.last_name || '').trim()) errors.push({ index, list: 'staff', key: 'savedTeams.errors.lastNameRequired' })
    })
    return errors
  }
  if (players.length > MAX_PLAYERS) errors.push({ index: null, list: 'players', key: 'manage.errors.generic' })
  if (staff.length > MAX_STAFF) errors.push({ index: null, list: 'staff', key: 'manage.errors.generic' })
  const numbers = new Map()
  let captains = 0
  players.forEach((p, index) => {
    if (!String(p.last_name || '').trim()) errors.push({ index, list: 'players', key: 'savedTeams.errors.lastNameRequired' })
    if (p.active !== false) {
      if (p.number !== null && p.number !== undefined && p.number !== '') {
        const n = Number(p.number)
        if (numbers.has(n)) errors.push({ index, list: 'players', key: 'savedTeams.errors.duplicateNumber', params: { number: n } })
        else numbers.set(n, index)
      }
      if (p.is_captain) {
        captains += 1
        if (captains > 1) errors.push({ index, list: 'players', key: 'savedTeams.errors.twoCaptains' })
      }
    }
  })
  staff.forEach((s, index) => {
    if (!String(s.last_name || '').trim()) errors.push({ index, list: 'staff', key: 'savedTeams.errors.lastNameRequired' })
  })
  return errors
}

function competitionOf(team, competitionsById) {
  if (team?.competition) return team.competition
  const id = teamCompetitionId(team)
  return id && competitionsById ? competitionsById.get(id) || null : null
}

function competitionLeagues(comp) {
  const list = comp?.vmLeagues ?? comp?.vm_leagues
  return Array.isArray(list) ? list.map(normalizeName) : []
}

/**
 * Saved teams that match a schedule game's home and away team names.
 * @param {object[]} teams saved teams (cache rows or API teams)
 * @param {{home?: string, away?: string, league?: string, gender?: string, scheduledAt?: string|Date|null, competitions?: object[]}} game
 * @returns {{home: object|null, away: object|null}}
 */
export function findSavedTeamSuggestions(teams, { home, away, league, scheduledAt, competitions } = {}) {
  const list = Array.isArray(teams) ? teams : []
  const competitionsById = Array.isArray(competitions) ? new Map(competitions.map(c => [c.id, c])) : null
  const leagueKey = normalizeName(league)
  const season = seasonOf(scheduledAt)
  const seasonText = season === null ? null : seasonLabel(season)

  const pick = (teamName) => {
    const key = normalizeName(teamName)
    if (!key) return null
    const candidates = list.filter(team => {
      const comp = competitionOf(team, competitionsById)
      if (comp?.archived) return false
      return normalizeName(teamSvrzName(team)) === key || normalizeName(team?.name) === key
    })
    if (!candidates.length) return null
    const score = (team) => {
      const comp = competitionOf(team, competitionsById)
      return [
        leagueKey && competitionLeagues(comp).includes(leagueKey) ? 1 : 0,
        seasonText && comp?.season === seasonText ? 1 : 0,
        Date.parse(teamUpdatedAt(team) || '') || 0
      ]
    }
    return candidates
      .map(team => ({ team, s: score(team) }))
      .sort((a, b) => (b.s[0] - a.s[0]) || (b.s[1] - a.s[1]) || (b.s[2] - a.s[2]))[0].team
  }

  return { home: pick(home), away: pick(away) }
}

// ---------------------------------------------------------------- the club of "Load saved team"
// Owner 2026-11-27: "load saved team of course should check for the same club".
// A saved team keeps its club's name (`club`: the manager's Club dropdown,
// components/manage/TeamEditor.jsx, lists the clubs by name) and its
// VolleyManager name (`svrzTeamName`); a match keeps its teams' names only (the
// schedule's VolleyManager names, or typed). The account's club lists on the
// device (db/024, db/clubPlayers.js clubOfTeam) give a club's id and name for
// the VolleyManager names of its teams (club_teams).

/**
 * The club of a match's team, the strongest link first:
 * 1. `clubTeam`, the team's club in the account's club lists (clubOfTeam): its id and name;
 * 2. the saved team of that VolleyManager name (else of that name) with a club: that club's name.
 * Null when neither tells (a guest match, a test match of no club, a team no
 * saved team names): then every saved team is offered, as before.
 * @param {{ teamName?: string, clubTeam?: {clubId?: string, clubName?: string}|null, savedTeams?: object[] }} o
 * @returns {{ id: string|null, name: string }|null}
 */
export function clubOfMatchTeam({ teamName, clubTeam = null, savedTeams = [] } = {}) {
  if (clubTeam?.clubId) return { id: String(clubTeam.clubId), name: String(clubTeam.clubName || '').trim() }
  const key = normalizeName(teamName)
  if (!key) return null
  const withClub = (Array.isArray(savedTeams) ? savedTeams : []).filter(team => team && normalizeName(team.club))
  const named = withClub.find(team => normalizeName(teamSvrzName(team)) === key) ||
    withClub.find(team => normalizeName(team.name) === key)
  return named ? { id: null, name: String(named.club).trim() } : null
}

/**
 * Whether saved team `team` is of `club` (clubOfMatchTeam): by the club's id
 * when both are known (`clubIdOf(name)`: the id of the account's club that has
 * the VolleyManager team `name`, or null), else by the club's name (case and
 * spaces aside). No club: every team is.
 */
export function savedTeamOfClub(team, club, clubIdOf = () => null) {
  if (!club) return true
  const id = clubIdOf(teamSvrzName(team)) ?? clubIdOf(team?.name) ?? null
  if (club.id && id != null) return String(id) === String(club.id)
  const name = normalizeName(club.name)
  return !!name && normalizeName(team?.club) === name
}

/** The saved teams of `club` (all of them when the club is not known). */
export function savedTeamsOfClub(teams, club, clubIdOf = () => null) {
  const list = Array.isArray(teams) ? teams : []
  return club ? list.filter(team => savedTeamOfClub(team, club, clubIdOf)) : list
}

// ---------------------------------------------------------------- shirt numbers from a saved team
// Owner 2026-11-19: "next games ... the numbers can be automatically filled
// with roster (einsatzliste) import". An Einsatzliste has no shirt numbers;
// the saved team has them: the server keeps the latest official match's
// numbers in it (backend lib/rosterSaveBack.js), and the tablet has a copy.

const foldName = (v) => normalizeName(v).normalize('NFD').replace(/\p{Diacritic}/gu, '')

/**
 * The shirt number a saved team (API team or cache row) knows for a person:
 * numberOf({ licence, firstName, lastName }) is the number of the saved
 * team's active player with that licence; else of the one active player of
 * that name (accents and case aside, also with first and last name swapped),
 * not of another licence; null when the saved team does not tell. With
 * `inactive`, a player set inactive answers too (after the active ones), when
 * no active player wears the number.
 */
export function savedNumberFinder(team, { inactive = false } = {}) {
  const all = (Array.isArray(team?.players) ? team.players : []).filter(p => p && toNumberOrNull(p.number) !== null)
  const active = all.filter(p => p.active !== false)
  const worn = new Set(active.map(p => toNumberOrNull(p.number)))
  const list = inactive ? [...active, ...all.filter(p => p.active === false && !worn.has(toNumberOrNull(p.number)))] : active
  const byLicence = new Map()
  const byName = new Map()
  for (const p of list) {
    const lic = licenceOf(p.license_number)
    if (lic && !byLicence.has(lic)) byLicence.set(lic, p)
    const k = `${foldName(p.last_name)}|${foldName(p.first_name)}`
    if (!byName.has(k)) byName.set(k, [])
    byName.get(k).push(p)
  }
  return ({ licence = null, firstName = '', lastName = '' } = {}) => {
    const lic = licenceOf(licence)
    if (lic && byLicence.has(lic)) return toNumberOrNull(byLicence.get(lic).number)
    if (!foldName(lastName)) return null
    const keys = [...new Set([`${foldName(lastName)}|${foldName(firstName)}`, `${foldName(firstName)}|${foldName(lastName)}`])]
    const hits = [...new Set(keys.flatMap(k => byName.get(k) || []))]
      .filter(p => !lic || !licenceOf(p.license_number))
    return hits.length === 1 ? toNumberOrNull(hits[0].number) : null
  }
}

/**
 * Match Setup roster rows ({ number, firstName, lastName, dob: the licence or
 * a date }) with the saved team's numbers where a row has none (an
 * Einsatzliste, a club person): { roster, filled }. A number the roster has
 * already (or a row before it got) is not given twice. `team` null: the rows
 * as they are.
 */
export function fillNumbersFromSaved(roster, team) {
  const list = Array.isArray(roster) ? roster : []
  if (!team) return { roster: list, filled: 0 }
  const numberOf = savedNumberFinder(team)
  const taken = new Set(list.map(p => toNumberOrNull(p?.number)).filter(n => n !== null))
  let filled = 0
  const out = list.map(p => {
    if (!p || toNumberOrNull(p.number) !== null) return p
    const n = numberOf({ licence: p.dob, firstName: p.firstName, lastName: p.lastName })
    if (n === null || taken.has(n)) return p
    taken.add(n)
    filled++
    return { ...p, number: n }
  })
  return { roster: out, filled }
}

/** Does a roster or bench hold anything a load would overwrite? */
export function rosterHasContent(roster, bench) {
  const anyPlayer = (Array.isArray(roster) ? roster : []).some(p =>
    p && (String(p.lastName || '').trim() || String(p.firstName || '').trim() || (p.number !== null && p.number !== undefined && p.number !== '')))
  const anyBench = (Array.isArray(bench) ? bench : []).some(b =>
    b && (String(b.lastName || '').trim() || String(b.firstName || '').trim()))
  return anyPlayer || anyBench
}
