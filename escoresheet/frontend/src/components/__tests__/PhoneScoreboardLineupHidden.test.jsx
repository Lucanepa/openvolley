// The phone scoring screen covers a team's half court with "Line-up set"
// while its line-up is the only one of the set and the set has not started
// (domain/lineupPrivacy.js), as the tablet court and the referee do; Show
// line-up uncovers it while held.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '../../i18n'
import PhoneScoreboard from '../scoreboard/PhoneScoreboard.jsx'

afterEach(() => cleanup())

const team = (side, teamKey, label, lineupSet) => ({
  side, teamKey, label, name: `${label} team`, shortName: label, color: side === 'left' ? '#dc2626' : '#2563eb',
  setsWon: 0, points: 0, timeouts: 0, subs: 0, lineupSet,
  court: lineupSet ? ['I', 'II', 'III', 'IV', 'V', 'VI'].map((position, i) => ({ position, number: i + 1 + (side === 'left' ? 0 : 10), isLibero: false })) : [],
  liberos: [], benchPlayers: [], officials: [], improperRequestDone: false, delayWarned: false, needsRedesignation: false
})
const props = (left, right, isFirstRally = true, actions = {}) => ({
  setNumber: 1,
  teams: { left: team('left', 'home', 'A', left), right: team('right', 'away', 'B', right) },
  serving: 'left',
  rally: { status: 'idle', isFirstRally, startDisabled: false, canReplayRally: false, isRallyReplayed: false },
  centre: null, recent: [], canUndo: false,
  actions: new Proxy(actions, { get: (o, k) => o[k] || (() => {}) })
})

describe('phone scoring screen: the first line-up is covered until the other is in', () => {
  it('covers the lone line-up, uncovers both', () => {
    const openLineup = vi.fn()
    const { rerender } = render(<PhoneScoreboard {...props(true, false, true, { openLineup })} />)
    expect(screen.getByTestId('phone-lineup-hidden-left')).toBeInTheDocument()
    expect(screen.queryByTestId('phone-lineup-hidden-right')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Change line-up/i }))
    expect(openLineup).toHaveBeenCalledWith('left')
    // held: uncovered
    fireEvent.pointerDown(screen.getByRole('button', { name: /Show line-up/i }))
    expect(screen.queryByTestId('phone-lineup-hidden-left')).toBeNull()
    rerender(<PhoneScoreboard {...props(true, true)} />)
    expect(screen.queryByTestId('phone-lineup-hidden-left')).toBeNull()
    expect(screen.queryByTestId('phone-lineup-hidden-right')).toBeNull()
  })

  it('never once the set has started', () => {
    render(<PhoneScoreboard {...props(true, false, false)} />)
    expect(screen.queryByTestId('phone-lineup-hidden-left')).toBeNull()
  })
})
