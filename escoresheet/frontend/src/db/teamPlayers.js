/**
 * A team's stored players (db.players by teamId): what Coin toss, the
 * scoresheet and Match setup opened again read as the team's roster.
 */
import { db } from './db'
import { isSeedTestTeam, withoutSeedTestRoster } from '../domain/testRoster'

const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()

const hasNumber = (p) => p?.number !== null && p?.number !== undefined && p?.number !== ''
const sameNumber = (a, b) => hasNumber(a) && hasNumber(b) && Number(a.number) === Number(b.number)

/**
 * The stored players as a roster editor's Confirm leaves them: a roster
 * entry is the stored row of its id (an older row without one in the form:
 * the row of its shirt number), updated; a new one is added; the rows left
 * out are removed. A player without a shirt number is stored too (number
 * null): the coin toss waits for the numbers, the roster never loses them
 * (owner 23.11.2026: an uploaded roster without numbers was gone after
 * Confirm). An emptied roster removes every row. Rows without a name and a
 * number are skipped.
 * @param {number} teamId
 * @param {object[]} roster MatchSetup roster entries ({ id?, number, lastName, ... })
 * @returns {Promise<Array<number|null>>} the stored id of each entry (null: skipped)
 */
export async function writeTeamPlayers(teamId, roster = []) {
  if (teamId === null || teamId === undefined) return []
  const ids = []
  await db.transaction('rw', db.players, async () => {
    const existing = await db.players.where('teamId').equals(teamId).toArray()
    const kept = new Set()
    const free = (ep) => !kept.has(ep.id)
    for (const p of roster || []) {
      if (!hasNumber(p) && !String(p?.lastName || '').trim() && !String(p?.firstName || '').trim()) {
        ids.push(null)
        continue
      }
      const fields = {
        number: hasNumber(p) ? p.number : null,
        name: `${p.lastName || ''} ${p.firstName || ''}`.trim(),
        lastName: p.lastName,
        firstName: p.firstName,
        dob: p.dob || null,
        libero: p.libero || '',
        isCaptain: !!p.isCaptain,
        isLfp: !!p.isLfp
      }
      const found = (p.id != null && existing.find(ep => ep.id === p.id && free(ep))) ||
        existing.find(ep => free(ep) && sameNumber(ep, p))
      if (found) {
        await db.players.update(found.id, fields)
        kept.add(found.id)
        ids.push(found.id)
      } else {
        const id = await db.players.add({ teamId, ...fields, role: null, createdAt: new Date().toISOString() })
        kept.add(id)
        ids.push(id)
      }
    }
    for (const ep of existing) {
      if (!kept.has(ep.id)) await db.players.delete(ep.id)
    }
  })
  return ids
}

/**
 * A test match's side given another team (a schedule game, a name typed):
 * the seeded test players and officials go, the scorer's own stay. A side
 * still on a shared seed team gets a team of its own, so the seed team keeps
 * its name and players for the next test match (App renames a seed team back
 * on start, and refills an empty one: the test roster came back). Nothing
 * when the name is the stored team's.
 * @param {{ teamId: number|null|undefined, name: string, color?: string,
 *   roster: object[], bench: object[] }} side
 * @returns {Promise<null | { teamId: number, roster: object[], bench: object[], removed: number }>}
 */
export async function takeTestMatchTeam({ teamId, name, color, roster, bench }) {
  const team = teamId !== null && teamId !== undefined ? await db.teams.get(teamId) : null
  if (!team || sameName(team.name, name)) return null
  const kept = withoutSeedTestRoster(roster, bench)
  let id = teamId
  let players = kept.roster
  if (isSeedTestTeam(team)) {
    id = await db.teams.add({
      name: String(name || '').trim(),
      color: color ?? team.color,
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
