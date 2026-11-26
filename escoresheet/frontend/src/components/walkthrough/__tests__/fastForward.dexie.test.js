// "Skip to set 5" (fastForward.js): the demo rallies are written as live
// scoring writes them (the corrections' rebuild finds nothing to change and
// nothing inconsistent), the sets alternate to 2:2, and nothing but a test
// match is ever touched.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../../../db/db'
import { recomputeMatch } from '../../../domain/recompute'
import { getSetResult } from '../../../domain/rules'
import { TEST_TEAM_SEED_DATA } from '../../../constants/testSeeds'
import { writeDemoLineups, writeDemoRallies, planRallies, balancingWinner, setWonOnScore, demoLineupOf } from '../fastForward'
import { writeDemoUpload, seedDemoClub, removeDemoData } from '../demoData'
import { DEMO_USER_ID, isDemoUpload } from '../../../domain/walkthroughDemo'

async function seedMatch(fields = {}) {
  const [homeSeed, awaySeed] = TEST_TEAM_SEED_DATA
  const homeTeamId = await db.teams.add({ name: homeSeed.name, shortName: homeSeed.shortName, seedKey: homeSeed.seedKey })
  const awayTeamId = await db.teams.add({ name: awaySeed.name, shortName: awaySeed.shortName, seedKey: awaySeed.seedKey })
  await db.players.bulkAdd(homeSeed.players.map(p => ({ ...p, teamId: homeTeamId })))
  await db.players.bulkAdd(awaySeed.players.map(p => ({ ...p, teamId: awayTeamId })))
  const matchId = await db.matches.add({
    homeTeamId, awayTeamId, status: 'live', test: true, bestOf: 5, coinTossConfirmed: true,
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true, coinTossServeB: false,
    ...fields
  })
  await db.sets.add({ matchId, index: 1, homePoints: 0, awayPoints: 0, finished: false })
  return matchId
}

async function ctxOf(matchId) {
  const match = await db.matches.get(matchId)
  return {
    match,
    matchId,
    players: {
      home: await db.players.where('teamId').equals(match.homeTeamId).toArray(),
      away: await db.players.where('teamId').equals(match.awayTeamId).toArray()
    }
  }
}

const eventsOf = (matchId) => db.events.where('matchId').equals(matchId).toArray()

// what the scoring screen's set-end confirmation leaves: the set finished,
// its set_end, the next set's row (Scoreboard confirmSetEndTime)
async function endSet(matchId, index) {
  const set = await db.sets.where('matchId').equals(matchId).filter(s => s.index === index).first()
  const winner = set.homePoints > set.awayPoints ? 'home' : 'away'
  await db.sets.update(set.id, { finished: true, endTime: new Date().toISOString() })
  const seq = Math.floor(Math.max(...(await eventsOf(matchId)).map(e => e.seq))) + 1
  await db.events.add({ matchId, setIndex: index, type: 'set_end', payload: { team: winner, setIndex: index, homePoints: set.homePoints, awayPoints: set.awayPoints }, ts: new Date().toISOString(), seq })
  await db.sets.add({ matchId, index: index + 1, homePoints: 0, awayPoints: 0, finished: false })
  return winner
}

beforeEach(async () => {
  await Promise.all(db.tables.map(t => t.clear()))
})

describe('fast-forward: demo rallies', () => {
  it('plays a set as the scoring screen writes it: no rebuild change, no issue', async () => {
    const matchId = await seedMatch()
    expect(await writeDemoLineups(db, matchId, 1)).toBe(2)
    const score = await writeDemoRallies(db, matchId, { setIndex: 1, winner: 'home' })
    expect(score.home).toBe(25)
    expect(score.away).toBeLessThanOrEqual(23)
    const events = await eventsOf(matchId)
    const points = events.filter(e => e.type === 'point')
    expect(points).toHaveLength(score.home + score.away)
    // one rally_start per rally, the set's start once
    expect(events.filter(e => e.type === 'rally_start')).toHaveLength(points.length)
    expect(events.filter(e => e.type === 'set_start')).toHaveLength(1)
    // the running score on each point
    expect(points.at(-1).payload).toMatchObject({ team: 'home', score: { home: 25, away: score.away } })
    // a side-out rotates: the rotation sub-rows are there
    expect(events.some(e => e.type === 'lineup' && !e.payload.isInitial && e.seq % 1 !== 0)).toBe(true)
    const rc = recomputeMatch(events, await ctxOf(matchId))
    expect(rc.add).toEqual([])
    expect(rc.update).toEqual([])
    expect(rc.remove).toEqual([])
    expect(rc.issues.map(i => i.text)).toEqual([])
    const set1 = (await db.sets.where('matchId').equals(matchId).toArray())[0]
    expect(set1).toMatchObject({ homePoints: 25, awayPoints: score.away })
    expect(setWonOnScore(set1, await db.matches.get(matchId), [set1])).toBe(true)
  })

  it('alternates the winners to 2:2, and the log stays consistent over four sets', async () => {
    const matchId = await seedMatch()
    const winners = []
    for (let index = 1; index <= 4; index++) {
      const sets = await db.sets.where('matchId').equals(matchId).toArray()
      const winner = balancingWinner(sets, await db.matches.get(matchId))
      expect(winner).toBeTruthy()
      await writeDemoLineups(db, matchId, index)
      await writeDemoRallies(db, matchId, { setIndex: index, winner })
      winners.push(await endSet(matchId, index))
    }
    expect(winners).toEqual(['home', 'away', 'home', 'away'])
    const sets = await db.sets.where('matchId').equals(matchId).toArray()
    // the deciding set is next: nothing more to fill
    expect(balancingWinner(sets, await db.matches.get(matchId))).toBeNull()
    expect(sets.filter(s => s.finished)).toHaveLength(4)
    for (const s of sets.filter(x => x.finished)) expect(getSetResult(s.homePoints, s.awayPoints, s.index).isSetWon).toBe(true)
    // sets 2-4 start with set 1's line-ups
    const events = await eventsOf(matchId)
    const start = (set, team) => events.find(e => e.type === 'lineup' && e.setIndex === set && e.payload.team === team && e.payload.isInitial).payload.lineup
    expect(start(3, 'home')).toEqual(start(1, 'home'))
    const rc = recomputeMatch(events, await ctxOf(matchId))
    expect([rc.add, rc.update, rc.remove]).toEqual([[], [], []])
    expect(rc.issues.map(i => i.text)).toEqual([])
  })

  it('finishes a set the scorer started, a libero on court included', async () => {
    const matchId = await seedMatch()
    await writeDemoLineups(db, matchId, 1)
    // the libero (#12 of the home team) replaces the player at position V before the first serve
    const events = await eventsOf(matchId)
    const home = events.find(e => e.type === 'lineup' && e.payload.team === 'home').payload.lineup
    const seq = Math.max(...events.map(e => e.seq)) + 1
    await db.events.add({ matchId, setIndex: 1, type: 'libero_entry', payload: { team: 'home', position: 'V', playerOut: home.V, liberoIn: 12, liberoType: 'libero1' }, ts: new Date().toISOString(), seq })
    await db.events.add({ matchId, setIndex: 1, type: 'lineup', payload: { team: 'home', lineup: { ...home, V: 12 }, liberoSubstitution: { position: 'V', liberoNumber: 12, liberoType: 'libero1', playerNumber: home.V } }, ts: new Date().toISOString(), seq: seq + 0.1 })
    await writeDemoRallies(db, matchId, { setIndex: 1, winner: 'away' })
    const all = await eventsOf(matchId)
    // the rotation took the libero to the front row once at least: his exit was written
    expect(all.some(e => e.type === 'libero_exit' && e.payload.reason === 'rotation_to_front_row')).toBe(true)
    const rc = recomputeMatch(all, await ctxOf(matchId))
    expect([rc.add, rc.update, rc.remove]).toEqual([[], [], []])
  })

  it('stops at 7 for the change of courts in set 5', () => {
    const plan = planRallies({ home: 0, away: 0 }, 'away', { setIndex: 5, targets: { regular: 25, deciding: 15 }, stopAtLeader: 7 })
    const away = plan.filter(t => t === 'away').length
    const home = plan.filter(t => t === 'home').length
    expect(away).toBe(7)
    expect(home).toBeLessThan(7)
  })

  it('never ends a set on the way, a deuce included', () => {
    for (const start of [{ home: 0, away: 0 }, { home: 24, away: 24 }, { home: 3, away: 17 }, { home: 23, away: 24 }]) {
      for (const winner of ['home', 'away']) {
        const plan = planRallies(start, winner, { setIndex: 2, targets: { regular: 25, deciding: 15 } })
        const s = { ...start }
        plan.forEach((team, i) => {
          s[team] += 1
          const won = getSetResult(s.home, s.away, 2).isSetWon
          expect(won, `${JSON.stringify(start)} ${winner} at ${i}`).toBe(i === plan.length - 1)
        })
        expect(getSetResult(s.home, s.away, 2).winner).toBe(winner)
      }
    }
  })

  it('takes the captain and five players who are no libero', () => {
    const lineup = demoLineupOf(TEST_TEAM_SEED_DATA[1].players)
    const numbers = Object.values(lineup)
    expect(numbers).toHaveLength(6)
    expect(numbers).toContain(12) // the captain
    expect(numbers).not.toContain(1) // the libero
  })
})

describe('demo data never touches a match that is not a test match', () => {
  it('refuses an official, guest, Global or Easy match', async () => {
    for (const kind of [{ test: false }, { test: false, guest: true }, { test: false, global: true }, { test: true, easy: true }]) {
      await Promise.all(db.tables.map(t => t.clear()))
      const matchId = await seedMatch({ ...kind, status: 'scheduled', coinTossConfirmed: false })
      await expect(writeDemoLineups(db, matchId, 1)).rejects.toThrow()
      await expect(writeDemoRallies(db, matchId, { setIndex: 1, winner: 'home' })).rejects.toThrow()
      expect(await writeDemoUpload(matchId, db)).toBe(false)
      expect(await seedDemoClub(matchId, db)).toBe(false)
      expect(await db.events.count()).toBe(0)
      expect((await db.matches.get(matchId)).pendingHomeRoster).toBeUndefined()
      expect(await db.club_players.count()).toBe(0)
    }
  })

  it('puts the demo upload and the demo club on a test match, and takes them off again; a real upload stays', async () => {
    const matchId = await seedMatch({ status: 'scheduled', coinTossConfirmed: false })
    expect(await writeDemoUpload(matchId, db)).toBe(true)
    expect(isDemoUpload((await db.matches.get(matchId)).pendingHomeRoster)).toBe(true)
    expect(await seedDemoClub(matchId, db)).toBe(true)
    const club = await db.club_players.where('userId').equals(DEMO_USER_ID).toArray()
    expect(club).toHaveLength(1)
    expect(club[0].teamNames).toEqual([TEST_TEAM_SEED_DATA[0].name])
    // a real account's list and a real upload of another match are left alone
    await db.club_players.put({ clubId: 'real', userId: 'someone', teamNames: ['X'], players: [] })
    const other = await db.matches.add({ test: false, status: 'scheduled', pendingHomeRoster: { players: [], bench: [], timestamp: '2026-11-20T10:00:00Z' } })
    await removeDemoData(db)
    expect((await db.matches.get(matchId)).pendingHomeRoster).toBeNull()
    expect(await db.club_players.where('userId').equals(DEMO_USER_ID).count()).toBe(0)
    expect(await db.club_players.get('real')).toBeTruthy()
    expect((await db.matches.get(other)).pendingHomeRoster.timestamp).toBe('2026-11-20T10:00:00Z')
  })

  it('never puts the demo upload over a real one, nor after the coin toss', async () => {
    const real = { players: [], bench: [], timestamp: '2026-11-20T10:00:00Z' }
    const matchId = await seedMatch({ status: 'scheduled', coinTossConfirmed: false, pendingHomeRoster: real })
    expect(await writeDemoUpload(matchId, db)).toBe(false)
    expect((await db.matches.get(matchId)).pendingHomeRoster).toEqual(real)
    const tossed = await seedMatch({ status: 'live', coinTossConfirmed: true })
    expect(await writeDemoUpload(tossed, db)).toBe(false)
  })
})
