/**
 * The rosters of a team in earlier matches on this device, for the player
 * pool (domain/playerPool): the teams of the same name (normalised), each
 * with its match, newest first. Test and easy matches are left out (their
 * rosters are test players). Read only; never throws ([] on any error).
 */

import { db } from './db'
import { normalizeName } from '../domain/savedTeams'

const MAX_MATCHES = 5

const whenOf = (match, team) => Date.parse(match?.scheduledAt || match?.createdAt || team?.createdAt || '') || 0

/**
 * @param {string} teamName
 * @param {{excludeTeamIds?: (number|null|undefined)[], limit?: number}} [opts]
 *   excludeTeamIds: the team rows of the match being set up
 * @returns {Promise<{teamId: number, matchId: number, at: number, players: object[]}[]>}
 *   players as MatchSetup roster entries
 */
export async function rememberedRosters(teamName, { excludeTeamIds = [], limit = MAX_MATCHES } = {}) {
  const key = normalizeName(teamName)
  if (!key) return []
  try {
    const skip = new Set(excludeTeamIds.filter(id => id !== null && id !== undefined))
    const teams = (await db.teams.toArray()).filter(t => t?.id != null && !skip.has(t.id) && normalizeName(t.name) === key)
    const found = []
    for (const team of teams) {
      const matches = [
        ...await db.matches.where('homeTeamId').equals(team.id).toArray(),
        ...await db.matches.where('awayTeamId').equals(team.id).toArray()
      ].filter(m => m && !m.test)
      if (!matches.length) continue
      const match = matches.sort((a, b) => whenOf(b, team) - whenOf(a, team))[0]
      const players = (await db.players.where('teamId').equals(team.id).toArray())
        .filter(p => p && (String(p.lastName || '').trim() || String(p.firstName || '').trim()))
        .map(p => ({
          number: p.number ?? null,
          firstName: p.firstName || '',
          lastName: p.lastName || '',
          dob: p.dob || '',
          libero: p.libero || '',
          isCaptain: !!p.isCaptain,
          isLfp: !!p.isLfp
        }))
      if (players.length) found.push({ teamId: team.id, matchId: match.id, at: whenOf(match, team), players })
    }
    return found.sort((a, b) => b.at - a.at).slice(0, limit)
  } catch (err) {
    console.warn('[rememberedPlayers] read failed:', err?.message)
    return []
  }
}
