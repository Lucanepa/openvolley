// The centre of the phone layout (PhoneScoreboard) between rallies: Start
// rally, a time-out's countdown, the set interval, the deciding set's setup.
// It takes the place of the two point buttons, which get as low as 56px on a
// short screen (390x664, 360x640). It was laid over that row (absolutely
// positioned), so the time-out's countdown and Stop button ran over the team
// actions and the action grid there, and the deciding set's setup (three
// buttons and its countdown) ran over them at every size, 412x915 included.
// The centre now shares the row with the two square slots, in the flow: the
// row is as high as the point buttons, or as its content when that is higher
// (the view scrolls instead of overlapping).
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '../../i18n'
import PhoneScoreboard from '../scoreboard/PhoneScoreboard.jsx'

afterEach(() => cleanup())

const team = (side, teamKey, label) => ({
  side, teamKey, label, name: `${label} team`, shortName: label, color: side === 'left' ? '#dc2626' : '#2563eb',
  setsWon: 0, points: 0, timeouts: 0, subs: 0, lineupSet: true,
  court: ['I', 'II', 'III', 'IV', 'V', 'VI'].map((position, i) => ({ position, number: i + 1 + (side === 'left' ? 0 : 10), isLibero: false })),
  liberos: [], benchPlayers: [], officials: [], improperRequestDone: false, delayWarned: false, needsRedesignation: false
})
const noop = () => {}
const props = (over = {}) => ({
  setNumber: 1,
  teams: { left: team('left', 'home', 'A'), right: team('right', 'away', 'B') },
  serving: 'left',
  rally: { status: 'idle', isFirstRally: false, startDisabled: false, canReplayRally: false, isRallyReplayed: false },
  centre: null, recent: [], canUndo: false,
  actions: new Proxy({}, { get: () => noop }),
  ...over
})

const centreOf = () => screen.getByTestId('phone-centre')
const inRow = (el) => {
  expect(el.style.position).not.toBe('absolute')
  expect(el.style.gridRow).toBe('1')
  expect(el.style.gridColumn).toBe('1 / -1')
  // the two slots that give the row the point buttons' height share it
  const slots = [...el.parentElement.querySelectorAll(':scope > .phone-square')]
  expect(slots).toHaveLength(2)
  for (const s of slots) expect(s.style.gridRow).toBe('1')
}

describe('PhoneScoreboard: the centre between rallies', () => {
  it('Start rally sits in the point buttons\' row, in the flow', () => {
    render(<PhoneScoreboard {...props()} />)
    inRow(centreOf())
    expect(centreOf().textContent).toBe('Start rally')
  })

  it('a time-out\'s countdown and Stop button sit in that row, never over the rest', () => {
    render(<PhoneScoreboard {...props({ centre: { kind: 'timeout', teamName: 'A team', countdown: 24, countdownText: '24', total: 30 } })} />)
    inRow(centreOf())
    expect(centreOf().textContent).toContain('24')
    expect(centreOf().textContent).toContain('Stop timeout')
  })

  it('the set interval (countdown, End set interval) sits in that row', () => {
    render(<PhoneScoreboard {...props({ centre: { kind: 'interval', countdown: 158, countdownText: '2:38', total: 180 } })} />)
    inRow(centreOf())
    expect(centreOf().textContent).toContain('2:38')
  })

  it('the deciding set\'s setup sits in that row, its two switches side by side', () => {
    render(<PhoneScoreboard {...props({ setNumber: 5, centre: { kind: 'set5', confirmLabel: 'Confirm set 5 setup', countdown: 158, countdownText: '2:38', total: 180 } })} />)
    inRow(centreOf())
    const sides = screen.getByRole('button', { name: /Switch sides/ })
    const serve = screen.getByRole('button', { name: 'Switch serve' })
    // one row of two: the setup fits the point buttons' height at 360x780
    expect(sides.parentElement).toBe(serve.parentElement)
    expect(sides.parentElement.style.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))')
    expect(centreOf().textContent).toContain('Confirm set 5 setup')
    expect(centreOf().textContent).toContain('2:38')
  })

  it('a rally in play shows the two point buttons, no centre', () => {
    render(<PhoneScoreboard {...props({ rally: { status: 'in_play', isFirstRally: false, startDisabled: false, canReplayRally: false, isRallyReplayed: false } })} />)
    expect(screen.queryByTestId('phone-centre')).toBeNull()
    expect(screen.getByRole('button', { name: 'Point A' }).classList.contains('phone-square')).toBe(true)
  })
})
