/**
 * Offline cache of the rosters teams sent ahead for their games (db/023,
 * docs/team-managers-spec.md section 4). Offline first: the scoring tablet
 * downloads them whenever it is online (GET /api/game-rosters) and Match Setup
 * only ever reads this table, so a hall without internet still offers them.
 *
 * The rows hold personal data (names, DOBs, licence numbers): they are only
 * for the account that loaded them (row.userId) and are cleared on sign-out
 * and account switch (AuthContext), like the saved teams.
 */

import { db } from './db'
import { fetchGameRosters } from '../lib/accountApi'
import { accessFromRoles } from '../lib/access'
import { isoToDisplayDob } from '../domain/savedTeams'
import { currentUserId } from './savedTeams'

export const GAME_ROSTERS_CHANGED_EVENT = 'ov-game-rosters-changed'
// The background refresh while the app is open (AuthContext)
export const GAME_ROSTERS_REFRESH_MS = 15 * 60 * 1000
const MIN_GAP_MS = 60 * 1000

const rowKey = (gameNumber, side) => `${String(gameNumber).trim()}|${side}`
let lastFetch = 0

function notify() {
  try { window.dispatchEvent(new Event(GAME_ROSTERS_CHANGED_EVENT)) } catch { /* no window */ }
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

/** An API roster → the cache row. */
export function rosterToRow(r, userId) {
  return {
    key: rowKey(r.game_number, r.side),
    gameNumber: String(r.game_number),
    season: r.season ?? null,
    side: r.side,
    teamName: r.team_name || '',
    kickoff: r.kickoff || null,
    players: Array.isArray(r.players) ? r.players : [],
    staff: Array.isArray(r.staff) ? r.staff : [],
    updatedAt: r.updated_at || null,
    updatedByName: r.updated_by_name || null,
    userId
  }
}

/**
 * A cached (or API) roster → MatchSetup's pending-roster shape, the one an
 * uploaded roster has: { players: [{ number, firstName, lastName, dob
 * (DD.MM.YYYY), libero: ''|'libero1'|'libero2', isCaptain, isLfp }], bench:
 * [{ role, firstName, lastName, dob }] } plus where it came from.
 */
export function rowToPendingRoster(row) {
  let liberos = 0
  const players = (row?.players || []).map((p) => {
    let libero = ''
    if (p.is_libero && liberos < 2) libero = ++liberos === 1 ? 'libero1' : 'libero2'
    return {
      number: Number.isInteger(p.number) ? p.number : (p.number == null || p.number === '' ? null : Number(p.number)),
      firstName: p.first_name || '',
      lastName: p.last_name || '',
      dob: isoToDisplayDob(p.dob),
      libero,
      isCaptain: !!p.is_captain,
      isLfp: false
    }
  })
  const bench = (row?.staff || []).map((s) => ({
    role: s.role,
    firstName: s.first_name || '',
    lastName: s.last_name || '',
    dob: isoToDisplayDob(s.dob)
  }))
  return {
    players,
    bench,
    source: 'team',
    teamName: row?.teamName || '',
    sentAt: row?.updatedAt || null,
    sentBy: row?.updatedByName || null
  }
}

// A match past these has its roster locked (coin toss done, or over)
const ROSTER_LOCKED_STATUSES = new Set(['live', 'ended', 'approved', 'final', 'closed'])

/**
 * The sent rosters Match Setup offers for `match`: { home, away } (a cached
 * row or null). None for a test match, or once the match has started; a
 * version already used or put aside ("Not now") is not offered again.
 */
export function offeredSentRosters(rows, match, userId) {
  const out = { home: null, away: null }
  if (!match || match.test || ROSTER_LOCKED_STATUSES.has(match.status)) return out
  for (const r of rows || []) {
    if (!r || (r.side !== 'home' && r.side !== 'away') || (userId && r.userId !== userId)) continue
    const version = r.updatedAt || 'sent'
    if (match.sentRosterUsed?.[r.side] === version || match.sentRosterDismissed?.[r.side] === version) continue
    out[r.side] = r
  }
  return out
}

/**
 * Store an answer of GET /api/game-rosters: the rosters it has, and for every
 * game it covers (answer.games) drop a cached side it no longer has (the team
 * deleted it). Other games' rows stay (another download covered them).
 */
export async function storeGameRosters(answer, userId) {
  const covered = new Set((answer?.games || []).map((g) => String(g.game_number)))
  for (const r of answer?.rosters || []) covered.add(String(r.game_number))
  const rows = (answer?.rosters || []).filter((r) => r && r.game_number && (r.side === 'home' || r.side === 'away')).map((r) => rosterToRow(r, userId))
  const keep = new Set(rows.map((r) => r.key))
  await db.transaction('rw', db.game_rosters, async () => {
    // rows of another account never stay next to this one's
    await db.game_rosters.filter((r) => r.userId !== userId).delete()
    if (covered.size) {
      await db.game_rosters.where('gameNumber').anyOf([...covered]).filter((r) => !keep.has(r.key)).delete()
    }
    if (rows.length) await db.game_rosters.bulkPut(rows)
  })
  notify()
  return rows
}

/** Drop rows of games more than a day ago (the match holds the roster by then). */
export async function pruneGameRosters(now = new Date()) {
  const cutoff = new Date(now.getTime() - 36 * 60 * 60 * 1000).toISOString().slice(0, 10)
  try {
    await db.game_rosters.filter((r) => typeof r.kickoff === 'string' && r.kickoff.slice(0, 10) < cutoff).delete()
  } catch (e) {
    console.warn('[gameRosters] prune failed:', e?.message)
  }
}

export async function clearGameRosters() {
  try {
    await db.game_rosters.clear()
    notify()
  } catch (e) {
    console.warn('[gameRosters] clear failed:', e?.message)
  }
}

/**
 * The cached roster a team sent for `gameNumber` / `side`, for the signed-in
 * account, or null. Never touches the network.
 */
export async function getGameRoster(gameNumber, side, { userId } = {}) {
  if (gameNumber == null || gameNumber === '' || (side !== 'home' && side !== 'away')) return null
  const uid = userId === undefined ? currentUserId() : userId
  if (!uid) return null
  try {
    const row = await db.game_rosters.get(rowKey(gameNumber, side))
    return row && row.userId === uid ? row : null
  } catch {
    return null
  }
}

/**
 * Download the sent rosters into the cache: the upcoming home games of the
 * account's clubs, or `games` (game numbers). Never throws; offline or
 * without the scoring role it leaves the cache as it is.
 * @returns {Promise<'refreshed'|'skipped'|'offline'|'forbidden'|'error'>}
 */
export async function refreshGameRosters({ access, userId, online, games, force = false, timeoutMs = 8000 } = {}) {
  const uid = userId === undefined ? currentUserId() : userId
  const acc = access || currentAccess()
  if (!uid || !acc.canReadTeams || acc.isPending) return 'skipped'
  if (!(online ?? isOnline())) return 'offline'
  const list = Array.isArray(games) ? games.map((g) => String(g).trim()).filter((g) => /^[0-9]{1,12}$/.test(g)) : null
  if (!list && !force && Date.now() - lastFetch < MIN_GAP_MS) return 'skipped'
  if (!list) lastFetch = Date.now()
  try {
    const { data, error, status } = await fetchGameRosters({ games: list || undefined, timeoutMs })
    if (error) {
      if (status === 403 || status === 401) return 'forbidden'
      return error.network || status === 0 ? 'offline' : 'error'
    }
    await storeGameRosters(data, uid)
    if (!list) await pruneGameRosters()
    return 'refreshed'
  } catch (e) {
    console.warn('[gameRosters] refresh failed:', e?.message)
    return 'error'
  }
}
