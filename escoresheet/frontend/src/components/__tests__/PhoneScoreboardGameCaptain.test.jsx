// The phone layout's Game captain button (as the tablet's beside SERVE):
// while a game captain is needed, and quiet with the kept player's number
// while "Keep as game captain" is on; both open the Game captain dialog
// (actions.gameCaptain), where the switch is turned off.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import '../../i18n'
import PhoneScoreboard from '../scoreboard/PhoneScoreboard.jsx'

afterEach(() => cleanup())

const team = (side, teamKey, label, over = {}) => ({
  side, teamKey, label, name: `${label} team`, shortName: label, color: side === 'left' ? '#dc2626' : '#2563eb',
  setsWon: 0, points: 0, timeouts: 0, subs: 0, lineupSet: true,
  court: ['I', 'II', 'III', 'IV', 'V', 'VI'].map((position, i) => ({ position, number: i + 1 + (side === 'left' ? 0 : 10), isLibero: false })),
  liberos: [], benchPlayers: [], officials: [], improperRequestDone: false, delayWarned: false, needsRedesignation: false,
  ...over
})
const props = (left, right, actions = {}) => ({
  setNumber: 1,
  teams: { left, right },
  serving: 'left',
  rally: { status: 'idle', isFirstRally: false, startDisabled: false, canReplayRally: false, isRallyReplayed: false },
  centre: null, recent: [], canUndo: false,
  actions: new Proxy(actions, { get: (o, k) => o[k] || (() => {}) })
})

describe('PhoneScoreboard: the Game captain button', () => {
  it('is not shown while neither team needs one nor keeps one', () => {
    render(<PhoneScoreboard {...props(team('left', 'home', 'A'), team('right', 'away', 'B'))} />)
    expect(screen.queryByTestId('phone-game-captain-left')).toBeNull()
    expect(screen.queryByTestId('phone-game-captain-right')).toBeNull()
  })

  it('needed on one side, kept on the other; a tap opens the dialog of that side', () => {
    const gameCaptain = vi.fn()
    render(<PhoneScoreboard {...props(
      team('left', 'home', 'A', { gameCaptain: { state: 'needed' } }),
      team('right', 'away', 'B', { gameCaptain: { state: 'kept', number: 8 } }),
      { gameCaptain }
    )} />)
    const needed = screen.getByTestId('phone-game-captain-left')
    expect(needed.dataset.gameCaptainChip).toBe('needed')
    expect(needed.textContent).toBe('Game captain')
    const kept = screen.getByTestId('phone-game-captain-right')
    expect(kept.dataset.gameCaptainChip).toBe('kept')
    expect(kept.textContent).toBe('Game captain #8')
    expect(kept.getAttribute('aria-label')).toContain('Keep as game captain: #8')
    fireEvent.click(kept)
    expect(gameCaptain).toHaveBeenCalledWith('right')
    fireEvent.click(needed)
    expect(gameCaptain).toHaveBeenCalledWith('left')
  })
})
