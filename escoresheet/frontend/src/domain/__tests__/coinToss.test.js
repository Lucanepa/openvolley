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

  // Without firstServe the device plays home first (firstServe || 'home'),
  // whatever the old A/B flag says: the swap keeps that team and writes it.
  // It derived the first server from the old serve flag, so the cloud got
  // the other team than the device plays (found by a check, 2026-10-09).
  it('without firstServe keeps the team the device plays first (home), not the one the old serve flag names', () => {
    const patch = swapTeamDesignation({ coinTossTeamA: 'home', coinTossServeA: false })
    expect(patch.coinTossTeamA).toBe('away')
    expect(patch.firstServe).toBe('home')
    // home is now B and serves
    expect(patch.coinTossServeA).toBe(false)
    expect(patch.coinTossServeB).toBe(true)
  })

  it('without firstServe, home was B: home becomes A and serves', () => {
    const patch = swapTeamDesignation({ coinTossTeamA: 'away', coinTossTeamB: 'home', coinTossServeA: false })
    expect(patch.coinTossTeamA).toBe('home')
    expect(patch.firstServe).toBe('home')
    expect(patch.coinTossServeA).toBe(true)
    expect(patch.coinTossServeB).toBe(false)
  })

  it('writes the first server it keeps', () => {
    expect(swapTeamDesignation({ coinTossTeamA: 'home', firstServe: 'away', coinTossServeA: false }).firstServe).toBe('away')
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
