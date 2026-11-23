// An injured player with no legal or exceptional substitute (FIVB 6.4.3,
// 15.7-15.8; owner decision 23.11.2026, audit LOG-15). Swiss referee exam
// Q226: "Team A has 7 players available, including one libero. In the 2nd
// set, one player (not the libero) is injured and cannot continue playing."
// Correct: "Team A is declared incomplete and loses the entire game". The
// team is incomplete for the MATCH when it cannot field six for the rest of
// the match without him; for the SET when it can.
import { describe, it, expect } from 'vitest'
import { automaticForfeitScope } from '../matchEnd'

const team = (n, { libero = 9 } = {}) => [
  ...Array.from({ length: n }, (_, i) => ({ number: i + 1, libero: '' })),
  ...(libero != null ? [{ number: libero, libero: 'libero1' }] : [])
]

describe('automaticForfeitScope: an injured player nobody may replace', () => {
  it('Q226: 7 players with one libero, one injured: incomplete for the MATCH', () => {
    // #1-#6 and libero #9: the libero may not replace him, nobody else can
    expect(automaticForfeitScope(team(6), [], 'home', 'injury', 3)).toBe('match')
    // numbers stored as strings (a court disc) match
    expect(automaticForfeitScope(team(6), [], 'home', 'injury', '3')).toBe('match')
  })

  it('six left without him for the rest of the match: incomplete for the SET', () => {
    // #7 on the bench is expelled for this set (no exceptional substitute
    // now), back next set: six without the injured one
    const events = [{ type: 'sanction', setIndex: 2, payload: { team: 'home', type: 'expulsion', playerType: 'bench', playerNumber: 7 } }]
    expect(automaticForfeitScope(team(7), events, 'home', 'injury', 3)).toBe('set')
  })

  it('fewer than six once those out for the match leave: the MATCH', () => {
    // 8 players: #7 disqualified, #8 replaced exceptionally earlier, #3 injured now
    const events = [
      { type: 'sanction', setIndex: 1, payload: { team: 'home', type: 'disqualification', playerType: 'bench', playerNumber: 7 } },
      { type: 'substitution', setIndex: 1, payload: { team: 'home', playerOut: 8, playerIn: 6, isExceptional: true, isInjury: true } }
    ]
    expect(automaticForfeitScope(team(8), events, 'home', 'injury', 3)).toBe('match')
    expect(automaticForfeitScope(team(8), events, 'home', 'illness', 3)).toBe('match')
  })

  it('an expelled player is back next set: the SET when six play with him (unchanged)', () => {
    expect(automaticForfeitScope(team(6), [], 'home', 'expulsion', 3)).toBe('set')
  })

  it('a disqualified one is out for the match: the MATCH below six (unchanged)', () => {
    expect(automaticForfeitScope(team(6), [], 'home', 'disqualification', 3)).toBe('match')
    expect(automaticForfeitScope(team(7), [], 'home', 'disqualification', 3)).toBe('set')
  })

  it('the manual forfeit always ends the match; another team\'s events do not count', () => {
    expect(automaticForfeitScope(team(10), [], 'home', 'forfeit')).toBe('match')
    const away = [{ type: 'sanction', setIndex: 1, payload: { team: 'away', type: 'disqualification', playerType: 'player', playerNumber: 7 } }]
    expect(automaticForfeitScope(team(7), away, 'home', 'injury', 3)).toBe('set')
  })
})
