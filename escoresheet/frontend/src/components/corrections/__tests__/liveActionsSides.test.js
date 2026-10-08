import { describe, it, expect, vi } from 'vitest'
import { teamASide, switchSides } from '../liveActions'

// The live "Score and serve" card's Switch sides: its confirm names the team
// on the left as the scorer's court has it (domain/rules getSideAForSet), and
// in set 5 it moves the team the court shows on the left.

describe('teamASide (the corrections card)', () => {
  it('sets 1-4: odd sets A left, even sets A right; a set\'s override', () => {
    expect(teamASide({}, 3)).toBe('left')
    expect(teamASide({}, 4)).toBe('right')
    expect(teamASide({ setLeftTeamOverrides: { 4: 'A' } }, 4)).toBe('left')
  })

  it('set 5 after the change of courts at 8: the sides are swapped', () => {
    expect(teamASide({ set5LeftTeam: 'A' }, 5)).toBe('left')
    expect(teamASide({ set5LeftTeam: 'A', set5CourtSwitched: true }, 5)).toBe('right')
  })

  it('set 5 before its coin toss is written: where set 4 ended (A right)', () => {
    expect(teamASide({}, 5)).toBe('right')
  })
})

describe('switchSides in set 5', () => {
  const fakeDb = () => ({ matches: { update: vi.fn(async () => 1) }, sync_queue: { add: vi.fn(async () => 1) } })

  it('flips the coin toss side', async () => {
    const db = fakeDb()
    const r = await switchSides({ db, matchId: 1, match: { test: true, coinTossTeamA: 'home', set5LeftTeam: 'A' }, setIndex: 5 })
    expect(db.matches.update).toHaveBeenCalledWith(1, { set5LeftTeam: 'B' })
    expect(r).toEqual({ before: 'A left', after: 'B left' })
  })

  it('without a coin toss side: B is on the left (A right, as set 4 ended), so A moves left', async () => {
    for (const coinTossTeamA of ['home', 'away']) {
      const db = fakeDb()
      await switchSides({ db, matchId: 1, match: { test: true, coinTossTeamA }, setIndex: 5 })
      expect(db.matches.update, coinTossTeamA).toHaveBeenCalledWith(1, { set5LeftTeam: 'A' })
    }
  })
})
