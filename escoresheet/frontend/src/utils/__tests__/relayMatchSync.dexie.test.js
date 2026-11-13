// The one-match relay bundle App.jsx publishes, against the real app database
// (Dexie 4 on fake-indexeddb).
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../../db/db'
import { relayMatchBundle, relaySyncTrigger } from '../relayMatchSync'

const CLOUD = 'wss://backend.example.org'
const LOCAL = 'ws://192.168.1.20:8080'
const OFFICIAL = 'match_1791215210200_offcl1'
const REHEARSAL = 'test-match-rehearsal'

async function addMatch({ seed, test = false, createdAt, status = 'live', points, teamName, extra = {} }) {
  const homeTeamId = await db.teams.add({ name: `${teamName} home`, shortName: 'H', color: '#e2001a', benchStaff: [{ role: 'Coach', lastName: 'Coach', dob: '02.01.1980' }] })
  const awayTeamId = await db.teams.add({ name: `${teamName} away`, shortName: 'A', color: '#1d4ed8' })
  const matchId = await db.matches.add({
    ...(test ? { seedKey: seed, test: true } : { seed_key: seed }),
    status, createdAt, homeTeamId, awayTeamId, ...extra
  })
  await db.players.add({ teamId: homeTeamId, number: 7, lastName: `${teamName} player`, dob: '03.05.2011' })
  await db.sets.add({ matchId, index: 1, homePoints: points, awayPoints: 0, finished: false })
  await db.events.add({ matchId, setIndex: 1, seq: 1, type: 'point', payload: { team: 'home' }, stateSnapshot: { pointsA: points } })
  return matchId
}

describe('relayMatchBundle: the relay gets one whole match', () => {
  beforeEach(async () => {
    await db.open()
    await Promise.all(db.tables.map(t => t.clear()))
  })

  it('an older test match that is open gets its own sets and events, not the newer official match\'s', async () => {
    const older = await addMatch({ seed: REHEARSAL, test: true, createdAt: '2026-11-01T10:00:00.000Z', points: 4, teamName: 'Rehearsal' })
    const newer = await addMatch({ seed: OFFICIAL, createdAt: '2026-11-12T10:00:00.000Z', points: 11, teamName: 'Official' })

    const open = await relayMatchBundle(db, older, { relayUrl: LOCAL })
    expect(open.relayKey).toBe(REHEARSAL)
    expect(open.match.id).toBe(older)
    expect(open.homeTeam).toEqual({ name: 'Rehearsal home', shortName: 'H', color: '#e2001a' })
    expect(open.homePlayers.map(p => p.lastName)).toEqual(['Rehearsal player'])
    expect(open.sets.map(s => s.homePoints)).toEqual([4])
    expect(open.events.every(e => e.matchId === older)).toBe(true)
    // without the undo snapshots, people without dates of birth
    expect(open.events[0]).not.toHaveProperty('stateSnapshot')
    expect(JSON.stringify(open)).not.toMatch(/1980|2011/)

    // On the cloud relay the test match is not published at all
    expect(await relayMatchBundle(db, older, { relayUrl: CLOUD })).toBeNull()
    const official = await relayMatchBundle(db, newer, { relayUrl: CLOUD })
    expect(official.relayKey).toBe(OFFICIAL)
    expect(official.sets.map(s => s.homePoints)).toEqual([11])
    expect(official.homeTeam.name).toBe('Official home')
  })

  it('publishes no final match, no match without a room key, none another device scores and no closed copy', async () => {
    const final = await addMatch({ seed: 'match_1791215210201_final1', status: 'final', points: 25, teamName: 'Final' })
    const blank = await db.matches.add({ status: 'scheduled' })
    const moved = await addMatch({ seed: 'match_1791215210202_moved1', points: 3, teamName: 'Moved', extra: { cloudBlock: { code: 'OV_SCORER_MOVED' } } })
    const closed = await addMatch({ seed: 'match_1791215210203_close1', points: 3, teamName: 'Closed', extra: { closed_at: '2026-11-12T12:00:00.000Z' } })
    for (const id of [final, blank, moved, closed, 999, null]) {
      expect(await relayMatchBundle(db, id, { relayUrl: CLOUD }), String(id)).toBeNull()
    }
  })
})

describe('relaySyncTrigger: what makes App sync a match at once', () => {
  const match = {
    id: 3, seed_key: OFFICIAL, status: 'live',
    refereeConnectionEnabled: true, homeTeamConnectionEnabled: false, awayTeamConnectionEnabled: false,
    refereePin: '314159', homeTeamPin: '271828', awayTeamPin: '161803'
  }

  it('changes with the room key, a connection or a PIN, and with nothing else', () => {
    const base = relaySyncTrigger(match)
    expect(typeof base).toBe('string')
    expect(relaySyncTrigger({ ...match, updatedAt: 5, homeShortName: 'H' })).toBe(base)
    for (const change of [
      { seed_key: 'match_1791215210299_other' },
      { homeTeamConnectionEnabled: true },
      { refereePin: '000001' },
      { awayTeamPin: null }
    ]) expect(relaySyncTrigger({ ...match, ...change }), JSON.stringify(change)).not.toBe(base)
    // a blank match (no seed key yet) has one too: Create Match changes it
    expect(relaySyncTrigger({ ...match, seed_key: undefined })).not.toBe(base)
    expect(relaySyncTrigger(null)).toBeNull()
    expect(relaySyncTrigger(undefined)).toBeNull()
  })
})
