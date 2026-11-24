// The coin toss page's choices before its confirm: kept as a draft on the
// match, shown again after Back (owner 2026-11-15: "I said go back and it did
// not save the coin toss result").
import { describe, it, expect } from 'vitest'
import { coinTossChoiceOf, coinTossDraftOf } from '../coinTossDraft'

const DEFAULT = { teamA: 'home', teamB: 'away', serveA: true, serveB: false }

describe('coinTossDraftOf', () => {
  it('keeps Team A and whether A serves', () => {
    expect(coinTossDraftOf('away', false)).toEqual({ teamA: 'away', serveA: false })
    expect(coinTossDraftOf('home', true)).toEqual({ teamA: 'home', serveA: true })
  })
})

describe('coinTossChoiceOf', () => {
  it('a new match: Team A home, A serving', () => {
    expect(coinTossChoiceOf({})).toEqual(DEFAULT)
    expect(coinTossChoiceOf(null)).toEqual(DEFAULT)
    expect(coinTossChoiceOf({ coinTossTeamA: null, coinTossTeamB: null })).toEqual(DEFAULT)
  })

  it('the draft of a toss not yet confirmed', () => {
    expect(coinTossChoiceOf({ coinTossConfirmed: false, coinTossDraft: { teamA: 'away', serveA: false } }))
      .toEqual({ teamA: 'away', teamB: 'home', serveA: false, serveB: true })
  })

  it('a confirmed toss wins over a draft left on the row', () => {
    const match = {
      coinTossConfirmed: true, coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: false, coinTossServeB: true,
      coinTossDraft: { teamA: 'away', serveA: true }
    }
    expect(coinTossChoiceOf(match)).toEqual({ teamA: 'home', teamB: 'away', serveA: false, serveB: true })
  })

  it('the stored toss without a draft (redone in Corrections before set 1)', () => {
    expect(coinTossChoiceOf({ coinTossConfirmed: false, coinTossTeamA: 'away', coinTossTeamB: 'home', coinTossServeA: true }))
      .toEqual({ teamA: 'away', teamB: 'home', serveA: true, serveB: false })
  })

  it('a broken draft is ignored', () => {
    expect(coinTossChoiceOf({ coinTossDraft: { teamA: 'left', serveA: true } })).toEqual(DEFAULT)
    expect(coinTossChoiceOf({ coinTossDraft: { teamA: 'away' } })).toEqual(DEFAULT)
  })
})
