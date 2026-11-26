// A team's stored players (db/teamPlayers), against the real app database
// (Dexie 4 on fake-indexeddb): the roster editor's Confirm, and a test match's
// side given another team.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { writeTeamPlayers, takeTestMatchTeam } from '../teamPlayers'
import { TEST_TEAM_SEED_DATA, TEST_HOME_BENCH } from '../../constants/testSeeds'

const [HOME] = TEST_TEAM_SEED_DATA
const stored = async (teamId) => (await db.players.where('teamId').equals(teamId).toArray())
  .sort((a, b) => a.number - b.number).map(p => [p.number, p.lastName, p.firstName, p.isCaptain])

async function seedHomeTeam() {
  const teamId = await db.teams.add({ name: HOME.name, color: HOME.color, seedKey: HOME.seedKey, test: true })
  await db.players.bulkAdd(HOME.players.map(p => ({ teamId, ...p, name: `${p.lastName} ${p.firstName}`, test: true })))
  return teamId
}

beforeEach(async () => {
  await db.open()
  await Promise.all(db.tables.map(t => t.clear()))
})

describe('writeTeamPlayers', () => {
  it('updates a player by shirt number, adds a new number and removes the rest', async () => {
    const teamId = await db.teams.add({ name: 'VBC Seewiese' })
    await db.players.bulkAdd([
      { teamId, number: 1, lastName: 'Alt', firstName: 'A', isCaptain: false },
      { teamId, number: 2, lastName: 'Weg', firstName: 'B', isCaptain: false }
    ])
    await writeTeamPlayers(teamId, [
      { number: 1, lastName: 'Alt', firstName: 'Anna', isCaptain: true },
      { number: 7, lastName: 'Neu', firstName: 'C' },
      { number: '', lastName: '', firstName: '' }
    ])
    expect(await stored(teamId)).toEqual([[1, 'Alt', 'Anna', true], [7, 'Neu', 'C', false]])
  })

  it('removes every stored player for an emptied roster', async () => {
    const teamId = await seedHomeTeam()
    await writeTeamPlayers(teamId, [])
    expect(await stored(teamId)).toEqual([])
  })
})

describe('takeTestMatchTeam', () => {
  it('gives a side on the seed team a team of its own with the scorer\'s players only; the seed team stays', async () => {
    const seedId = await seedHomeTeam()
    const own = { number: 99, lastName: 'Eigen', firstName: 'Mia', dob: '', isCaptain: true }
    const formRoster = [...HOME.players.map((p, i) => ({ id: i + 1, ...p })), { id: 50, ...own }]
    const out = await takeTestMatchTeam({ teamId: seedId, name: ' VC Tornado Adliswil D1 ', color: '#123456', roster: formRoster, bench: TEST_HOME_BENCH })
    expect(out.teamId).not.toBe(seedId)
    expect(out.roster).toEqual([own])
    expect(out.bench).toEqual([{ role: 'Coach', firstName: '', lastName: '', dob: '' }])
    expect(out.removed).toBe(HOME.players.length + TEST_HOME_BENCH.length)
    const team = await db.teams.get(out.teamId)
    expect([team.name, team.color, team.shortName, team.test, team.seedKey]).toEqual(['VC Tornado Adliswil D1', '#123456', undefined, true, 'test-match-team'])
    expect(await stored(out.teamId)).toEqual([[99, 'Eigen', 'Mia', true]])
    // the seed team as it was: the next test match starts with it
    expect((await db.teams.get(seedId)).name).toBe(HOME.name)
    expect((await stored(seedId)).length).toBe(HOME.players.length)
  })

  it('drops the seeded players from a team of the match\'s own (the test roster loaded again)', async () => {
    const teamId = await db.teams.add({ name: 'VC Tornado Adliswil D1', seedKey: 'test-match-team', test: true })
    await db.players.bulkAdd([{ teamId, number: 1, lastName: 'Keller', firstName: 'Luca', dob: '100211' }, { teamId, number: 99, lastName: 'Eigen', firstName: 'Mia' }])
    const roster = [{ number: 1, lastName: 'Keller', firstName: 'Luca', dob: '100211' }, { number: 99, lastName: 'Eigen', firstName: 'Mia' }]
    const out = await takeTestMatchTeam({ teamId, name: 'Volley Bergtal', roster, bench: [] })
    expect(out.teamId).toBe(teamId)
    expect(await stored(teamId)).toEqual([[99, 'Eigen', 'Mia', false]])
  })

  it('does nothing when the name is the stored team\'s, or there is no stored team', async () => {
    const seedId = await seedHomeTeam()
    expect(await takeTestMatchTeam({ teamId: seedId, name: 'vbc musterau ', roster: HOME.players, bench: TEST_HOME_BENCH })).toBe(null)
    expect(await takeTestMatchTeam({ teamId: null, name: 'VC Tornado Adliswil D1', roster: [], bench: [] })).toBe(null)
    expect((await stored(seedId)).length).toBe(HOME.players.length)
    expect(await db.teams.count()).toBe(1)
  })
})
