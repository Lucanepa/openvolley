/**
 * Saved teams (competition manager): pure conversions between a saved team
 * (GET /api/saved-teams bundle or the Dexie cache row) and MatchSetup's roster
 * and bench, plus the schedule-game suggestions. Spec section 6.1.
 *
 * A saved team may come in either shape:
 * - the API's snake_case team ({ short_name, svrz_team_name, competition_id, updated_at, ... }),
 * - the Dexie cache's camelCase row ({ shortName, svrzTeamName, competition: {...}, updatedAt, ... }).
 * Players and staff stay in the API's snake_case shape in both.
 */

import { seasonOf, seasonLabel } from './season'

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
export function teamShortName(team) { return team?.shortName ?? team?.short_name ?? '' }
export function teamSvrzName(team) { return team?.svrzTeamName ?? team?.svrz_team_name ?? '' }
export function teamUpdatedAt(team) { return team?.updatedAt ?? team?.updated_at ?? null }
export function teamCompetitionId(team) { return team?.competitionId ?? team?.competition_id ?? team?.competition?.id ?? null }

/**
 * A saved team → MatchSetup roster + bench.
 * @returns {{ roster: object[], bench: object[], meta: {name: string, shortName: string, color: string}, warnings: {key: string, params: object}[] }}
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
      dob: isoToDisplayDob(p.dob),
      libero,
      isCaptain,
      isLfp: false
    }
  })
  if (extraLiberos) warnings.push({ key: 'savedTeams.tooManyLiberos', params: { name: team?.name || '' } })

  const bench = sortByOrder(team?.staff)
    .filter(s => s && STAFF_ROLES.includes(s.role))
    .map(s => ({ role: s.role, firstName: s.first_name || '', lastName: s.last_name || '', dob: isoToDisplayDob(s.dob) }))
  if (!bench.some(b => b.role === 'Coach')) bench.unshift({ role: 'Coach', firstName: '', lastName: '', dob: '' })

  return {
    roster,
    bench,
    meta: { name: team?.name || '', shortName: teamShortName(team) || '', color: team?.color || '' },
    warnings
  }
}

/**
 * MatchSetup roster + bench → the PUT /api/saved-teams/teams/:id/roster body.
 * Keeps the id and licence number of a saved player whose number and last name
 * match (staff: role + last name), and keeps the saved inactive players (they
 * were never loaded into the roster, so leaving them out would delete them).
 */
export function rosterToSavedRoster(roster, bench, existingTeam = null) {
  const existingPlayers = Array.isArray(existingTeam?.players) ? existingTeam.players : []
  const existingStaff = Array.isArray(existingTeam?.staff) ? existingTeam.staff : []
  const usedIds = new Set()

  const playerKey = (number, lastName) => `${toNumberOrNull(number) ?? ''}|${normalizeName(lastName)}`
  const findPlayer = (number, lastName) => existingPlayers.find(p =>
    p?.id && !usedIds.has(p.id) && playerKey(p.number, p.last_name) === playerKey(number, lastName))

  const players = (Array.isArray(roster) ? roster : [])
    .filter(p => p && (String(p.lastName || '').trim() || String(p.firstName || '').trim()))
    .map(p => {
      const match = findPlayer(p.number, p.lastName)
      if (match) usedIds.add(match.id)
      const row = {
        number: toNumberOrNull(p.number),
        first_name: String(p.firstName || '').trim(),
        last_name: String(p.lastName || '').trim(),
        dob: displayDobToIso(p.dob),
        license_number: match?.license_number ?? null,
        is_libero: p.libero === 'libero1' || p.libero === 'libero2',
        is_captain: !!p.isCaptain,
        active: true
      }
      if (match) row.id = match.id
      return row
    })

  for (const p of existingPlayers) {
    if (p && p.active === false && !usedIds.has(p.id)) {
      players.push({
        ...(p.id ? { id: p.id } : {}),
        number: toNumberOrNull(p.number),
        first_name: p.first_name || '',
        last_name: p.last_name || '',
        dob: p.dob || null,
        license_number: p.license_number ?? null,
        is_libero: !!p.is_libero,
        is_captain: false,
        active: false
      })
    }
  }

  const usedStaff = new Set()
  const staff = (Array.isArray(bench) ? bench : [])
    .filter(b => b && STAFF_ROLES.includes(b.role) && (String(b.lastName || '').trim() || String(b.firstName || '').trim()))
    .map(b => {
      const match = existingStaff.find(s => s?.id && !usedStaff.has(s.id) && s.role === b.role &&
        normalizeName(s.last_name) === normalizeName(b.lastName))
      if (match) usedStaff.add(match.id)
      const row = {
        role: b.role,
        first_name: String(b.firstName || '').trim(),
        last_name: String(b.lastName || '').trim(),
        dob: displayDobToIso(b.dob),
        license_number: match?.license_number ?? null
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

/** Does a roster or bench hold anything a load would overwrite? */
export function rosterHasContent(roster, bench) {
  const anyPlayer = (Array.isArray(roster) ? roster : []).some(p =>
    p && (String(p.lastName || '').trim() || String(p.firstName || '').trim() || (p.number !== null && p.number !== undefined && p.number !== '')))
  const anyBench = (Array.isArray(bench) ? bench : []).some(b =>
    b && (String(b.lastName || '').trim() || String(b.firstName || '').trim()))
  return anyPlayer || anyBench
}
