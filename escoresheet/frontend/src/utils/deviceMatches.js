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
 * @param {{ duplicateIds?: number[] }} [options] copies of one official match
 *   that the self-check on open kept, as each holds something the other lacks
 *   (utils/deviceSelfCheck): listed (a restored copy may lack
 *   matchInfoConfirmedAt) and marked, so each can be removed here
 * @returns {{ id: number, home: string|null, away: string|null, gameN: string|null,
 *   createdAt: string|null, status: string, cloudBlock: object|null, duplicate: boolean }[]}
 */
export function deviceMatchRows(matches, teamNames = new Map(), { duplicateIds = [] } = {}) {
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
      duplicate: copy(m)
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
