/**
 * Offline copy of the licence lists of the scorer's clubs (db/024,
 * docs/club-licences-spec.md section 5). Offline first: the scoring tablet
 * downloads them whenever it is online (GET /api/club-licences: sign-in,
 * every 15 minutes, back online; AuthContext) and Match Setup's "Add from
 * club" only ever reads this table, so a hall without internet still offers
 * the club's players (for the roster) and its people (for the bench
 * officials, who may be anyone of the club's lists).
 *
 * One row per club: { clubId, clubName, teamNames, teamGenders, players:
 * [{ sv_number, last_name, first_name, dob, gender }] (the players list),
 * people: [{ ...the same five fields, lists }] (everyone of the three lists
 * once), fetchedAt, userId }. A server before `people` (or a row kept by an
 * older app) has the players list only: people are then the players.
 * Owner decision 2: the server sends no dates of birth here (dob null);
 * withClubDob asks for those of the people added to a roster, online.
 * Personal data (names, dates of birth, licence numbers, gender): only for
 * the account that loaded them (row.userId) and cleared on sign-out and
 * account switch (AuthContext), like the saved teams and the sent rosters.
 */

import { db } from './db'
import { fetchClubDob, fetchClubLicences } from '../lib/accountApi'
import { accessFromRoles } from '../lib/access'
import { currentUserId } from './savedTeams'

export const CLUB_PLAYERS_CHANGED_EVENT = 'ov-club-players-changed'
// The background refresh while the app is open (AuthContext)
export const CLUB_PLAYERS_REFRESH_MS = 15 * 60 * 1000
const MIN_GAP_MS = 60 * 1000
let lastFetch = 0

const teamKey = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

function notify() {
  try { window.dispatchEvent(new Event(CLUB_PLAYERS_CHANGED_EVENT)) } catch { /* no window */ }
}

function isOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

function currentAccess() {
  try {
    const raw = localStorage.getItem('cachedProfile')
    return accessFromRoles(raw ? JSON.parse(raw)?.roles ?? [] : [])
  } catch {
    return accessFromRoles([])
  }
}

const LISTS = ['players', 'scorers', 'coaches']

/**
 * A person of a list: the five fields only, and whether every row of the
 * person was added by hand (db/026 `manual`: a gray shield in Match Setup).
 */
const personOf = (p) => ({
  sv_number: String(p.sv_number),
  last_name: p.last_name || '',
  first_name: p.first_name || null,
  dob: p.dob || null,
  gender: p.gender === 'm' || p.gender === 'f' ? p.gender : null,
  manual: p.manual === true
})

/**
 * The people of a club (row or answer): everyone of its lists once, with
 * `lists`; without them (an older server or row), the players list.
 */
export function peopleOfClub(c) {
  if (Array.isArray(c?.people)) {
    return c.people.filter((p) => p && p.sv_number != null).map((p) => {
      const lists = (Array.isArray(p.lists) ? p.lists : []).filter((l) => LISTS.includes(l))
      return { ...personOf(p), lists: lists.length ? lists : ['players'] }
    })
  }
  return (Array.isArray(c?.players) ? c.players : []).filter((p) => p && p.sv_number != null).map((p) => ({ ...personOf(p), lists: ['players'] }))
}

/** One club of GET /api/club-licences -> the cache row (the five fields of each person, and its lists). */
export function clubToRow(c, userId, fetchedAt = null) {
  const names = Array.isArray(c?.team_names) ? c.team_names.filter((n) => typeof n === 'string') : []
  const genders = c?.team_genders && typeof c.team_genders === 'object' ? c.team_genders : {}
  return {
    clubId: String(c.club_id),
    clubName: c.club_name || '',
    teamNames: names,
    teamGenders: Object.fromEntries(names.map((n) => [n, genders[n] === 'm' || genders[n] === 'f' ? genders[n] : null])),
    players: (Array.isArray(c?.players) ? c.players : []).filter((p) => p && p.sv_number != null).map(personOf),
    people: peopleOfClub(c),
    fetchedAt,
    userId
  }
}

/** Store an answer of GET /api/club-licences: this account's clubs replace whatever was kept. */
export async function storeClubPlayers(answer, userId) {
  const rows = (answer?.clubs || []).filter((c) => c && c.club_id).map((c) => clubToRow(c, userId, answer?.fetched_at || new Date().toISOString()))
  await db.transaction('rw', db.club_players, async () => {
    await db.club_players.clear()
    if (rows.length) await db.club_players.bulkPut(rows)
  })
  notify()
  return rows
}

/** Drop the lists; `keepUserId`: all but that account's (an account change, or the start of the app). */
export async function clearClubPlayers({ keepUserId = null } = {}) {
  try {
    if (!keepUserId) await db.club_players.clear()
    else if (!(await db.club_players.filter((r) => r.userId !== keepUserId).delete())) return
    notify()
  } catch (e) {
    console.warn('[clubPlayers] clear failed:', e?.message)
  }
}

/**
 * The cached club of team `teamName` for `rows` (the table's rows of the
 * signed-in account): { clubId, clubName, players (the players list), people
 * (everyone of the lists, with `lists`), gender (the team's: 'm' | 'f' |
 * null), fetchedAt } or null when the team is none of the clubs'.
 */
export function clubOfTeam(rows, teamName, userId) {
  const k = teamKey(teamName)
  if (!k) return null
  for (const r of rows || []) {
    if (!r || (userId && r.userId !== userId)) continue
    const name = (r.teamNames || []).find((n) => teamKey(n) === k)
    if (name === undefined) continue
    return { clubId: r.clubId, clubName: r.clubName, players: r.players || [], people: peopleOfClub(r), gender: r.teamGenders?.[name] ?? null, fetchedAt: r.fetchedAt || null }
  }
  return null
}

/**
 * Download the clubs' lists into the cache. Never throws; offline or
 * without the scoring role it leaves the cache as it is.
 * @returns {Promise<'refreshed'|'skipped'|'offline'|'forbidden'|'error'>}
 */
export async function refreshClubPlayers({ access, userId, online, force = false, timeoutMs = 8000 } = {}) {
  const uid = userId === undefined ? currentUserId() : userId
  const acc = access || currentAccess()
  if (!uid || !acc.canReadTeams || acc.isPending) return 'skipped'
  if (!(online ?? isOnline())) return 'offline'
  if (!force && Date.now() - lastFetch < MIN_GAP_MS) return 'skipped'
  lastFetch = Date.now()
  try {
    const { data, error, status } = await fetchClubLicences({ timeoutMs })
    if (error) {
      if (status === 403 || status === 401) return 'forbidden'
      // a server without db/024 (404): nothing to keep
      return error.network || status === 0 ? 'offline' : 'error'
    }
    await storeClubPlayers(data, uid)
    return 'refreshed'
  } catch (e) {
    console.warn('[clubPlayers] refresh failed:', e?.message)
    return 'error'
  }
}

/**
 * `people` (club people chosen in Match Setup) with the dates of birth of
 * club `clubId` filled in where they have none (GET /api/club-licences/dob:
 * those of the chosen people only, at most 30). Never throws: offline, on a
 * server that does not know the route, or on any error, `people` as they are
 * (the scorer types the date, or a sent roster brings it).
 */
export async function withClubDob(clubId, people, { online, timeoutMs = 5000 } = {}) {
  const list = Array.isArray(people) ? people : []
  const want = [...new Set(list.filter((p) => p && !p.dob && p.sv_number != null).map((p) => String(p.sv_number)))].slice(0, 30)
  if (!clubId || !want.length || !(online ?? isOnline())) return list
  try {
    const { data, error } = await fetchClubDob({ clubId, svNumbers: want, timeoutMs })
    if (error || !Array.isArray(data?.people)) return list
    const dobOf = new Map(data.people.filter((x) => x && x.dob).map((x) => [String(x.sv_number), x.dob]))
    return list.map((p) => (p && !p.dob && dobOf.has(String(p.sv_number)) ? { ...p, dob: dobOf.get(String(p.sv_number)) } : p))
  } catch (e) {
    console.warn('[clubPlayers] dates of birth not read:', e?.message)
    return list
  }
}

/** Tests only: forget the last download time. */
export function resetClubPlayersThrottle() {
  lastFetch = 0
}
