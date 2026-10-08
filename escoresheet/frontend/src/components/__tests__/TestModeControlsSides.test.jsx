import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// The test-mode "Side" button wrote match.leftTeam, a field no screen reads:
// the court never moved. It makes the change of sides the corrections card
// makes (corrections/liveActions switchSides): sets 1-4 swap A and B, set 5
// flips its coin toss side (set5LeftTeam). Port of OpenBeach 9531133.

const store = vi.hoisted(() => ({ match: null, sets: [], updates: [] }))
vi.mock('../../db/db', () => {
  const sorted = (rows) => ({ sortBy: async () => rows })
  return {
    db: {
      matches: {
        get: vi.fn(async () => store.match),
        update: vi.fn(async (_id, patch) => { store.updates.push(patch); store.match = { ...store.match, ...patch }; return 1 })
      },
      sets: { where: () => ({ equals: () => sorted(store.sets) }) },
      events: { where: () => ({ equals: () => sorted([]) }) },
      sync_queue: { add: vi.fn(async () => 1) }
    }
  }
})

const { default: TestModeControls } = await import('../TestModeControls')
const { getSideAForSet } = await import('../../domain/rules')

// Which team the court draws on the left in a set
const leftTeamKey = (setIndex, match) => {
  const a = match.coinTossTeamA || 'home'
  return getSideAForSet(setIndex, match) === 'left' ? a : (a === 'home' ? 'away' : 'home')
}

describe('test mode "Side": a change of sides the court reads', () => {
  beforeEach(() => { store.updates.length = 0 })

  it('set 1 with home on the left: away goes to the left, and back', async () => {
    store.match = { id: 1, test: true, coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true, coinTossServeB: false, firstServe: 'home' }
    store.sets = [{ id: 1, index: 1, finished: false }]
    render(<TestModeControls matchId={1} onRefresh={() => {}} />)
    fireEvent.click(screen.getByText('Test mode'))
    expect(leftTeamKey(1, store.match)).toBe('home')
    fireEvent.click(screen.getByText('Side'))
    await waitFor(() => expect(store.updates.length).toBe(1))
    expect(leftTeamKey(1, store.match)).toBe('away')
    // the first server stays the same team
    expect(store.match.firstServe).toBe('home')
    fireEvent.click(screen.getByText('Side'))
    await waitFor(() => expect(store.updates.length).toBe(2))
    expect(leftTeamKey(1, store.match)).toBe('home')
  })

  it('set 5: its coin toss side flips', async () => {
    store.match = { id: 1, test: true, coinTossTeamA: 'home', coinTossTeamB: 'away', set5LeftTeam: 'A', set5CourtSwitched: false }
    store.sets = [1, 2, 3, 4].map(i => ({ id: i, index: i, finished: true })).concat({ id: 5, index: 5, finished: false })
    render(<TestModeControls matchId={1} onRefresh={() => {}} />)
    fireEvent.click(screen.getByText('Test mode'))
    fireEvent.click(screen.getByText('Side'))
    await waitFor(() => expect(store.updates.length).toBe(1))
    expect(store.match.set5LeftTeam).toBe('B')
    expect(leftTeamKey(5, store.match)).toBe('away')
  })
})
