import { describe, it, expect } from 'vitest'
import { swapTeamDesignation } from '../coinToss'

describe('swapTeamDesignation', () => {
  it('swaps A and B so they stay two different teams', () => {
    const patch = swapTeamDesignation({ coinTossTeamA: 'home', coinTossTeamB: 'away', firstServe: 'home', coinTossServeA: true, coinTossServeB: false })
    expect(patch.coinTossTeamA).toBe('away')
    expect(patch.coinTossTeamB).toBe('home')
    expect(patch.coinTossTeamA).not.toBe(patch.coinTossTeamB)
  })

  it('keeps the physical first server (serve flags follow the team)', () => {
    const patch = swapTeamDesignation({ coinTossTeamA: 'home', coinTossTeamB: 'away', firstServe: 'home', coinTossServeA: true, coinTossServeB: false })
    // home served first and is now B
    expect(patch.coinTossServeA).toBe(false)
    expect(patch.coinTossServeB).toBe(true)
  })

  it('derives the first server from the old serve flag when firstServe is missing', () => {
    const patch = swapTeamDesignation({ coinTossTeamA: 'away', coinTossTeamB: 'home', coinTossServeA: false })
    // old B (home) served; home becomes A
    expect(patch.coinTossTeamA).toBe('home')
    expect(patch.coinTossServeA).toBe(true)
    expect(patch.coinTossServeB).toBe(false)
  })

  it('flips A/B-labelled fields so they keep pointing at the same team', () => {
    const patch = swapTeamDesignation({
      coinTossTeamA: 'home', coinTossTeamB: 'away', firstServe: 'away',
      set5LeftTeam: 'A', set5FirstServe: 'B', setLeftTeamOverrides: { 5: 'A', 2: 'B' }
    })
    expect(patch.set5LeftTeam).toBe('B')
    expect(patch.set5FirstServe).toBe('A')
    expect(patch.setLeftTeamOverrides).toEqual({ 5: 'B', 2: 'A' })
  })

  it('does not invent A/B fields that were not set', () => {
    const patch = swapTeamDesignation({ coinTossTeamA: 'home', coinTossTeamB: 'away', firstServe: 'home' })
    expect(patch).not.toHaveProperty('set5LeftTeam')
    expect(patch).not.toHaveProperty('set5FirstServe')
    expect(patch).not.toHaveProperty('setLeftTeamOverrides')
  })

  it('defaults to home=A when the coin toss is missing', () => {
    expect(swapTeamDesignation({}).coinTossTeamA).toBe('away')
  })
})
