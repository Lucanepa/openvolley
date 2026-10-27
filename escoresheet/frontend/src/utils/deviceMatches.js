/**
 * The official matches kept on this device, for the home screen's
 * "On this device" list.
 *
 * The home screen's Continue and Delete only act on the newest open official
 * match. With two open matches (a backup restored next to a match created
 * again for the same game, 2026-10-19), deleting one brought the other up in
 * its place and nothing said why. The list shows them all, each with its own
 * Continue and Delete, and flags two matches of the same game.
 */
import { jobMatchKey } from './syncIds'

/** An open official match: confirmed in setup ("Create match"), not final, not a test. */
export const isOpenOfficialMatch = (m) => !!m && m.test !== true && m.status !== 'final' && !!m.matchInfoConfirmedAt

/** The match's official game number as a string, or null. */
export function matchGameNumber(m) {
  const n = m?.gameN ?? m?.game_n ?? m?.gameNumber ?? null
  return n == null || n === '' ? null : String(n)
}

/**
 * Rows for the list, newest first.
 * @param {object[]} matches all rows of db.matches
 * @param {Map<number, string>|Record<number, string>} teamNames team id -> name
 * @param {{ duplicateIds?: number[], stateOf?: (m: object) => string|null }} [options]
 *   duplicateIds: copies of one official match that the self-check flagged
 *   (utils/deviceSelfCheck): listed (a restored copy may lack
 *   matchInfoConfirmedAt) and marked, so each can be removed here.
 *   stateOf: the state the home screen shows for a match (deviceSelfCheck
 *   copyState: scoring here, on another device, closed on the server, not
 *   checked)
 * @returns {{ id: number, home: string|null, away: string|null, gameN: string|null,
 *   createdAt: string|null, status: string, cloudBlock: object|null, duplicate: boolean,
 *   seedKey: string|null, state: string|null }[]}
 */
export function deviceMatchRows(matches, teamNames = new Map(), { duplicateIds = [], stateOf = null } = {}) {
  const name = (id) => (id == null ? null : (teamNames instanceof Map ? teamNames.get(id) : teamNames[id]) || null)
  const copies = new Set(duplicateIds)
  const copy = (m) => copies.has(m.id) && m.test !== true && m.status !== 'final'
  return (matches || [])
    .filter(m => isOpenOfficialMatch(m) || copy(m))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .map(m => ({
      id: m.id,
      home: name(m.homeTeamId),
      away: name(m.awayTeamId),
      gameN: matchGameNumber(m),
      createdAt: m.createdAt || null,
      status: m.status || 'scheduled',
      cloudBlock: m.cloudBlock || null,
      duplicate: copy(m),
      seedKey: m.seed_key || null,
      state: stateOf ? stateOf(m) : null
    }))
}

/** Game numbers that two or more rows share. */
export function duplicateGameNumbers(rows) {
  const seen = new Set()
  const twice = new Set()
  for (const r of rows || []) {
    if (!r.gameN) continue
    if (seen.has(r.gameN)) twice.add(r.gameN)
    seen.add(r.gameN)
  }
  return twice
}

/**
 * The sync_queue jobs of one match: deleting a match removes these and keeps
 * the other matches' unsent work. A match that never had a seed_key queued
 * nothing.
 */
export function jobsOfMatch(jobs, seedKey) {
  if (!seedKey) return []
  return (jobs || []).filter(j => jobMatchKey(j) === seedKey)
}

/**
 * Where a match stands, from its sets (local rows or the server's): the
 * latest set and its points, and the sets each team has won. set null: no
 * set yet (not started).
 * @param {object[]} sets { index, homePoints | home_points, awayPoints | away_points, finished }
 * @returns {{ set: number|null, home: number, away: number, setsHome: number, setsAway: number }}
 */
export function setScore(sets) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  const rows = (sets || [])
    .map(s => ({ index: Number(s?.index ?? s?.set_index), home: num(s?.homePoints ?? s?.home_points), away: num(s?.awayPoints ?? s?.away_points), finished: !!s?.finished }))
    .filter(r => Number.isFinite(r.index))
    .sort((a, b) => a.index - b.index)
  const latest = rows.at(-1) || null
  return {
    set: latest ? latest.index : null,
    home: latest ? latest.home : 0,
    away: latest ? latest.away : 0,
    setsHome: rows.filter(r => r.finished && r.home > r.away).length,
    setsAway: rows.filter(r => r.finished && r.away > r.home).length
  }
}
