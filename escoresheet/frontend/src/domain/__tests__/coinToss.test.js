import { describe, it, expect } from 'vitest'
import { swapTeamDesignation, liveRowTeamA } from '../coinToss'
import { getSideAForSet, getFirstServeForSet } from '../rules'

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
    // every set 1-4 pinned to the team on its left now (set 2's saved B,
    // the others the set number's side), in the new labels
    expect(patch.setLeftTeamOverrides).toEqual({ 1: 'B', 2: 'A', 3: 'B', 4: 'A', 5: 'B' })
  })

  it('does not invent set 5 fields before set 5', () => {
    const patch = swapTeamDesignation({ coinTossTeamA: 'home', coinTossTeamB: 'away', firstServe: 'home' }, { currentSetIndex: 3 })
    expect(patch).not.toHaveProperty('set5LeftTeam')
    expect(patch).not.toHaveProperty('set5FirstServe')
  })

  it('defaults to home=A when the coin toss is missing', () => {
    expect(swapTeamDesignation({}).coinTossTeamA).toBe('away')
  })
})

// "Swap A/B" corrects the coin toss only (owner's decision, 2026-10-09):
// nothing moves on the court. A set without a saved side takes it from the
// set number (A left in odd sets), so flipping only the saved sides put the
// new A on the left, i.e. the teams changed courts.
describe('swapTeamDesignation: nothing moves on the court', () => {
  const leftTeam = (m, set) => {
    const a = m.coinTossTeamA || 'home'
    return getSideAForSet(set, m) === 'left' ? a : (a === 'home' ? 'away' : 'home')
  }
  const swapped = (m, opts) => ({ ...m, ...swapTeamDesignation(m, opts) })
  const base = { coinTossTeamA: 'home', coinTossTeamB: 'away', firstServe: 'home', coinTossServeA: true, coinTossServeB: false }

  for (const set of [1, 2, 3, 4]) {
    it(`set ${set} without a saved side: the same team on the left in every set`, () => {
      const after = swapped(base, { currentSetIndex: set })
      for (const s of [1, 2, 3, 4, 5]) expect(leftTeam(after, s), `set ${s}`).toBe(leftTeam(base, s))
    })
  }

  it('best-of-3: sets 1-2 pinned, the decider follows set 2', () => {
    const m = { ...base, bestOf: 3 }
    const patch = swapTeamDesignation(m, { currentSetIndex: 2 })
    expect(patch.setLeftTeamOverrides).toEqual({ 1: 'B', 2: 'A' })
    for (const s of [1, 2, 5]) expect(leftTeam({ ...m, ...patch }, s), `set ${s}`).toBe(leftTeam(m, s))
  })

  for (const switched of [false, true]) {
    it(`set 5 ${switched ? 'after' : 'before'} the change at 8, its toss side saved: the same team on the left`, () => {
      const m = { ...base, set5LeftTeam: 'B', set5FirstServe: 'A', set5CourtSwitched: switched }
      const after = swapped(m, { currentSetIndex: 5 })
      expect(after.set5CourtSwitched).toBe(switched)
      for (const s of [1, 2, 3, 4, 5]) expect(leftTeam(after, s), `set ${s}`).toBe(leftTeam(m, s))
      // set 5's first server is the same team
      expect(getFirstServeForSet(5, after)).toBe(getFirstServeForSet(5, m))
    })

    it(`set 5 ${switched ? 'after' : 'before'} the change at 8, no toss side saved: written, the same team on the left`, () => {
      const m = { ...base, set5CourtSwitched: switched }
      const patch = swapTeamDesignation(m, { currentSetIndex: 5 })
      // set 4 ended with A (home) on the right: set 5 started with B (away) left
      expect(patch.set5LeftTeam).toBe('A')
      expect(leftTeam({ ...m, ...patch }, 5)).toBe(leftTeam(m, 5))
    })
  }

  it('swapped twice: back to the same match sides', () => {
    const twice = swapped(swapped(base, { currentSetIndex: 2 }), { currentSetIndex: 2 })
    expect(twice.coinTossTeamA).toBe('home')
    for (const s of [1, 2, 3, 4, 5]) expect(leftTeam(twice, s)).toBe(leftTeam(base, s))
  })
})

describe('liveRowTeamA: the Team A a live row was written with', () => {
  it('by its team names', () => {
    expect(liveRowTeamA({ team_a_name: 'H', team_b_name: 'W' }, 'H', 'W')).toBe('home')
    expect(liveRowTeamA({ team_a_name: 'W', team_b_name: 'H' }, 'H', 'W')).toBe('away')
  })

  it('null when the names do not tell', () => {
    expect(liveRowTeamA({ team_a_name: 'X', team_b_name: 'X' }, 'X', 'X')).toBeNull()
    expect(liveRowTeamA({ team_a_name: 'H' }, 'H', 'W')).toBeNull()
    expect(liveRowTeamA(null, 'H', 'W')).toBeNull()
    expect(liveRowTeamA({ team_a_name: 'Other', team_b_name: 'W' }, 'H', 'W')).toBeNull()
  })
})
