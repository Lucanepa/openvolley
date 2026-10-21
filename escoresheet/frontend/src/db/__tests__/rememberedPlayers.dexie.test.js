// The rosters of a team in earlier matches on this device (db/rememberedPlayers),
// against the real app database (Dexie 4 on fake-indexeddb).
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { rememberedRosters } from '../rememberedPlayers'

async function matchWith(teamName, players, over = {}) {
  const teamId = await db.teams.add({ name: teamName, createdAt: '2026-10-01T10:00:00Z' })
  const otherId = await db.teams.add({ name: 'Other', createdAt: '2026-10-01T10:00:00Z' })
  const matchId = await db.matches.add({ homeTeamId: teamId, awayTeamId: otherId, status: 'final', test: false, ...over })
  await db.players.bulkAdd(players.map(([number, lastName]) => ({ teamId, number, lastName, firstName: 'A', name: `${lastName} A`, libero: '', isCaptain: false })))
  return { teamId, matchId }
}

describe('rememberedRosters', () => {
  beforeEach(async () => {
    await db.open()
    await Promise.all(db.tables.map(t => t.clear()))
  })

  it('returns the rosters of the teams of that name, newest match first', async () => {
    await matchWith('VBC Seefeld', [[1, 'Old']], { scheduledAt: '2026-09-01T18:00:00Z' })
    const recent = await matchWith('vbc  seefeld', [[2, 'New']], { scheduledAt: '2026-10-15T18:00:00Z' })
    await matchWith('Volley Bergtal', [[3, 'Elsewhere']], { scheduledAt: '2026-10-16T18:00:00Z' })
    const found = await rememberedRosters('VBC Seefeld ')
    expect(found.map(r => r.players.map(p => p.lastName))).toEqual([['New'], ['Old']])
    expect(found[0].teamId).toBe(recent.teamId)
  })

  it('leaves out test matches, empty rosters and the teams of the match being set up', async () => {
    await matchWith('VBC Seefeld', [[1, 'Test']], { test: true })
    await matchWith('VBC Seefeld', [])
    const own = await matchWith('VBC Seefeld', [[4, 'Own']])
    expect(await rememberedRosters('VBC Seefeld', { excludeTeamIds: [own.teamId] })).toEqual([])
    expect(await rememberedRosters('')).toEqual([])
  })
})
