// The phone's TIME-OUT and SUB tiles were disabled once used up, so a third
// time-out request (or a 7th substitution) never reached the scoreboard's
// handlers, which on the desktop record it as an improper request (FIVB
// 15.11.1.4, 16.1.3). They stay open, the count in red. And the libero sheet
// labelled a libero declared unable (after a re-designation) "L2".
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
const props = (left, actions = {}) => ({
  setNumber: 1,
  teams: { left, right: team('right', 'away', 'B') },
  serving: 'left',
  rally: { status: 'idle', isFirstRally: false, startDisabled: false, canReplayRally: false, isRallyReplayed: false },
  centre: null, recent: [], canUndo: false,
  actions: new Proxy(actions, { get: (o, k) => o[k] || (() => {}) })
})

describe('PhoneScoreboard: counters at the limit', () => {
  it('TIME-OUT with both used is still tapped through to the scoreboard (an improper request)', () => {
    const timeout = vi.fn()
    render(<PhoneScoreboard {...props(team('left', 'home', 'A', { timeouts: 2 }), { timeout })} />)
    const tile = screen.getByTestId('phone-timeout-left')
    expect(tile.disabled).toBe(false)
    expect(tile.querySelector('[data-count-state]').dataset.countState).toBe('max')
    fireEvent.click(tile)
    expect(timeout).toHaveBeenCalledWith('left')
  })

  it('SUB with all six used opens the substitution sheet', () => {
    render(<PhoneScoreboard {...props(team('left', 'home', 'A', { subs: 6 }))} />)
    const tile = screen.getByTestId('phone-sub-left')
    expect(tile.disabled).toBe(false)
    fireEvent.click(tile)
    expect(screen.getByTestId('phone-sub-sheet')).toBeTruthy()
  })

  // owner 22.11.2026: SUB counts exceptional substitutions; its colour stays
  // with the regular ones (subsRegular), the 6 of the rule
  it('SUB shows every substitution; 6 regular + 1 exceptional read 7, red', () => {
    render(<PhoneScoreboard {...props(team('left', 'home', 'A', { subs: 7, subsRegular: 6 }))} />)
    const count = screen.getByTestId('phone-sub-left').querySelector('[data-count-state]')
    expect(count.textContent).toBe('7')
    expect(count.dataset.countState).toBe('max')
  })

  it('5 regular + 1 exceptional read 6, amber: one regular substitution is left', () => {
    render(<PhoneScoreboard {...props(team('left', 'home', 'A', { subs: 6, subsRegular: 5 }))} />)
    const count = screen.getByTestId('phone-sub-left').querySelector('[data-count-state]')
    expect(count.textContent).toBe('6')
    expect(count.dataset.countState).toBe('warn')
  })

  it('an exceptional substitution alone reads 1, no colour', () => {
    render(<PhoneScoreboard {...props(team('left', 'home', 'A', { subs: 1, subsRegular: 0 }))} />)
    const tile = screen.getByTestId('phone-sub-left')
    expect(tile.textContent).toContain('1')
    expect(tile.querySelector('[data-count-state]')).toBeNull()
  })

  it('still closed while a rally is in play', () => {
    const p = props(team('left', 'home', 'A', { timeouts: 2 }))
    render(<PhoneScoreboard {...p} rally={{ ...p.rally, status: 'in_play' }} />)
    expect(screen.getByTestId('phone-timeout-left').disabled).toBe(true)
  })
})

describe('PhoneScoreboard: the libero sheet', () => {
  it('a libero declared unable is not labelled L2', () => {
    const liberos = [
      { number: 8, libero: 'redesignated', unable: false, onCourt: false, position: null },
      { number: 15, libero: 'unable', unable: true, onCourt: false, position: null }
    ]
    render(<PhoneScoreboard {...props(team('left', 'home', 'A', { liberos }))} />)
    fireEvent.click(screen.getByTestId('phone-action-libero'))
    expect(screen.getByTestId('phone-libero-left-8').textContent).toContain('LR')
    const unable = screen.getByTestId('phone-libero-left-15')
    expect(unable.textContent).not.toContain('L2')
    expect(unable.textContent).toContain('Unable')
    expect(unable.disabled).toBe(true)
  })
})

// Owner 22.11.2026: an injured libero no re-designation replaced may come
// back: his button stays open, marked injured, and opens his menu
describe('PhoneScoreboard: an injured libero who may come back', () => {
  it('is tappable and marked injured; one replaced by a re-designation stays closed', () => {
    const liberoClick = vi.fn()
    const liberos = [
      { number: 12, libero: 'libero1', unable: true, canReturn: true, onCourt: false, position: null },
      { number: 11, libero: 'unable', unable: true, canReturn: false, onCourt: false, position: null }
    ]
    render(<PhoneScoreboard {...props(team('left', 'home', 'A', { liberos }), { liberoClick })} />)
    fireEvent.click(screen.getByTestId('phone-action-libero'))
    const injured = screen.getByTestId('phone-libero-left-12')
    expect(injured.disabled).toBe(false)
    expect(injured.getAttribute('data-libero-state')).toBe('injured')
    expect(injured.textContent).toContain('injured')
    fireEvent.click(injured)
    expect(liberoClick).toHaveBeenCalledWith('home', liberos[0], expect.anything())
    fireEvent.click(screen.getByTestId('phone-action-libero'))
    const replaced = screen.getByTestId('phone-libero-left-11')
    expect(replaced.disabled).toBe(true)
    expect(replaced.getAttribute('data-libero-state')).toBe('unable')
  })
})
