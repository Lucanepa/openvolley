// Owner, 15.11: Team A corrected before set 1 started (Seevolley made B) kept Seevolley
// on the left in set 1. Before set 1's first rally a new Team A is the coin
// toss done again: team A on the left in set 1. After it, only the letters
// change (owner 2026-10-09, domain/coinToss).
import { describe, it, expect } from 'vitest'
import { planCoinToss, setOnePlayed } from '../manualCorrections'
import { getLeftTeamLabelForSet } from '../rules'

const MATCH = { id: 1, bestOf: 5, firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true, coinTossServeB: false, status: 'live' }
const ctx = (match) => ({ match, homeTeam: { name: 'Seevolley HU23' }, awayTeam: { name: 'VBC Rebberg' }, matchId: 1, players: { home: [], away: [] }, liveSetIndex: 1 })
const coinToss = { id: 1, matchId: 1, setIndex: 1, type: 'coin_toss', seq: 1, payload: { teamA: 'home', teamB: 'away', serveA: true, serveB: false, firstServe: 'home' } }
const leftTeam = (match, set) => {
  const label = getLeftTeamLabelForSet(set, match)
  return label === 'A' ? match.coinTossTeamA : match.coinTossTeamB
}

describe('coin toss corrected before set 1 started', () => {
  it('the new team A starts set 1 on the left (Seevolley made B moves to the right)', () => {
    expect(leftTeam(MATCH, 1)).toBe('home') // Seevolley (home) is A, on the left
    const plan = planCoinToss([coinToss], { teamA: 'away' }, ctx(MATCH))
    expect(plan.error).toBeUndefined()
    const after = { ...MATCH, ...plan.matchPatch }
    expect(after.coinTossTeamA).toBe('away')
    expect(leftTeam(after, 1)).toBe('away') // Rebberg, now A, on the left
    expect(leftTeam(after, 2)).toBe('home')
    // the same team still serves first
    expect(after.firstServe).toBe('home')
    expect(plan.notes.map(n => n.key)).toContain('corrections.note.coinTossRedone')
  })

  it('a line-up entered (no rally yet) is not a started set', () => {
    const lineup = { id: 2, matchId: 1, setIndex: 1, type: 'lineup', seq: 2, payload: { team: 'home', lineup: { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 }, isInitial: true } }
    expect(setOnePlayed([coinToss, lineup])).toBe(false)
    const plan = planCoinToss([coinToss, lineup], { teamA: 'away' }, ctx(MATCH))
    expect(leftTeam({ ...MATCH, ...plan.matchPatch }, 1)).toBe('away')
  })

  it('once set 1 has had a rally, only the letters change: nobody moves', () => {
    const rally = { id: 3, matchId: 1, setIndex: 1, type: 'rally_start', seq: 2, payload: {} }
    expect(setOnePlayed([coinToss, rally])).toBe(true)
    const plan = planCoinToss([coinToss, rally], { teamA: 'away' }, ctx(MATCH))
    const after = { ...MATCH, ...plan.matchPatch }
    expect(after.coinTossTeamA).toBe('away')
    expect(leftTeam(after, 1)).toBe('home') // Seevolley stays left, now as B
    expect(plan.notes.map(n => n.key)).not.toContain('corrections.note.coinTossRedone')
  })
})
