// The phone layout's header (PhoneScoreboard): it names the match home – away
// and counts the sets in that order, whichever side each team plays on. With
// the home team on the right it read "VBC Klosterau – VBC Rebberg" for a Rebberg
// home match (owner, 23.10.2026); the score cards below still follow the court.
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '../../i18n'
import PhoneScoreboard from '../scoreboard/PhoneScoreboard.jsx'

afterEach(() => cleanup())

const team = (side, teamKey, name, setsWon) => ({
  side, teamKey, label: side === 'left' ? 'A' : 'B', name, shortName: name, color: side === 'left' ? '#dc2626' : '#2563eb',
  setsWon, points: 5, timeouts: 0, subs: 0, lineupSet: true, court: [], liberos: [], benchPlayers: [], officials: [],
  improperRequestDone: false, delayWarned: false, needsRedesignation: false
})
const base = {
  setNumber: 3, serving: 'left',
  rally: { status: 'idle', isFirstRally: false, startDisabled: false, canReplayRally: false, isRallyReplayed: false },
  centre: null, recent: [], canUndo: false, actions: new Proxy({}, { get: () => () => {} })
}

describe('PhoneScoreboard: the header keeps home – away', () => {
  it('home on the left: home – away', () => {
    render(<PhoneScoreboard {...base} teams={{ left: team('left', 'home', 'VBC Rebberg', 2), right: team('right', 'away', 'VBC Klosterau', 0) }} />)
    expect(screen.getByTestId('phone-header-teams').textContent).toBe('VBC Rebberg – VBC Klosterau')
    expect(screen.getByTestId('phone-header-sets').textContent).toBe('Set 3 · sets 2 : 0')
  })

  it('home on the right: still home – away, the sets too', () => {
    render(<PhoneScoreboard {...base} teams={{ left: team('left', 'away', 'VBC Klosterau', 0), right: team('right', 'home', 'VBC Rebberg', 2) }} />)
    expect(screen.getByTestId('phone-header-teams').textContent).toBe('VBC Rebberg – VBC Klosterau')
    expect(screen.getByTestId('phone-header-sets').textContent).toBe('Set 3 · sets 2 : 0')
    // the score cards stay on their court sides
    expect(screen.getByTestId('phone-score-left').parentElement.textContent).toContain('A · VBC Klosterau')
    expect(screen.getByTestId('phone-score-right').parentElement.textContent).toContain('B · VBC Rebberg')
  })
})
