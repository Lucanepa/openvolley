/**
 * A team's stored players (db.players by teamId): what Coin toss, the
 * scoresheet and Match setup opened again read as the team's roster.
 */
import { db } from './db'
import { isSeedTestTeam, withoutSeedTestRoster } from '../domain/testRoster'

const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()

/**
 * The stored players as a roster editor's Confirm leaves them: a player of
 * the same shirt number is updated, a new number added, the rest removed.
 * An emptied roster removes them all (kept, they came back as the team's
 * roster wherever the stored players are read, while the editor showed 0).
 * Rows without a number are skipped (the editor refuses a named one).
 * @param {number} teamId
 * @param {object[]} roster MatchSetup roster entries
 */
export async function writeTeamPlayers(teamId, roster = []) {
  if (teamId === null || teamId === undefined) return
  await db.transaction('rw', db.players, async () => {
    const existing = await db.players.where('teamId').equals(teamId).toArray()
    const numbers = new Set((roster || []).map(p => p.number).filter(n => n != null))
    for (const p of roster || []) {
      if (!p.number) continue
      const fields = {
        name: `${p.lastName} ${p.firstName}`,
        lastName: p.lastName,
        firstName: p.firstName,
        dob: p.dob || null,
        libero: p.libero || '',
        isCaptain: !!p.isCaptain,
        isLfp: !!p.isLfp
      }
      const found = existing.find(ep => ep.number === p.number)
      if (found) await db.players.update(found.id, fields)
      else await db.players.add({ teamId, number: p.number, ...fields, role: null, createdAt: new Date().toISOString() })
    }
    for (const ep of existing) {
      if (!numbers.has(ep.number)) await db.players.delete(ep.id)
    }
  })
}

/**
 * A test match's side given another team (a schedule game, a name typed):
 * the seeded test players and officials go, the scorer's own stay. A side
 * still on a shared seed team gets a team of its own, so the seed team keeps
 * its name and players for the next test match (App renames a seed team back
 * on start, and refills an empty one: the test roster came back). Nothing
 * when the name is the stored team's.
 * @param {{ teamId: number|null|undefined, name: string, color?: string,
 *   shortName?: string, roster: object[], bench: object[] }} side
 * @returns {Promise<null | { teamId: number, roster: object[], bench: object[], removed: number }>}
 */
export async function takeTestMatchTeam({ teamId, name, color, shortName, roster, bench }) {
  const team = teamId !== null && teamId !== undefined ? await db.teams.get(teamId) : null
  if (!team || sameName(team.name, name)) return null
  const kept = withoutSeedTestRoster(roster, bench)
  let id = teamId
  let players = kept.roster
  if (isSeedTestTeam(team)) {
    id = await db.teams.add({
      name: String(name || '').trim(),
      color: color ?? team.color,
      shortName: shortName || team.shortName || '',
      benchStaff: kept.bench,
      test: true,
      // removed with the other test data (App clearLocalTestData: seedKey test-*)
      seedKey: 'test-match-team',
      createdAt: new Date().toISOString()
    })
    // the stored ids are the seed team's players
    players = kept.roster.map(({ id: _seedPlayerId, ...p }) => p)
  }
  await writeTeamPlayers(id, players)
  return { teamId: id, roster: players, bench: kept.bench, removed: kept.removed }
}
