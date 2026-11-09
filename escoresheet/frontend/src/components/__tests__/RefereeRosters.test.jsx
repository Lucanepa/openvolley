import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k, d, o) => {
    const s = typeof d === 'string' ? d : (o?.defaultValue || k)
    const vars = typeof d === 'object' ? d : o
    return vars ? s.replace(/\{\{(\w+)\}\}/g, (_, v) => vars[v] ?? '') : s
  } })
}))

const { default: RefereeRosters, rosterOfTeam } = await import('../referee/RefereeRosters.jsx')

// The referee tablet's rosters, one team after the other (owner 2026-11-09)
const bundle = {
  access: 'full',
  match: {
    coinTossTeamA: 'away',
    homeShortName: 'MUST', awayShortName: 'BSP',
    bench_home: [{ role: 'Coach', firstName: 'Carla', lastName: 'Muster' }, { role: 'Assistant Coach 1', firstName: 'Paul', lastName: 'Muster' }],
    bench_away: [{ role: 'Coach', firstName: 'Bruno', lastName: 'Beispielmann' }]
  },
  homeTeam: { name: 'VBC Musterdorf H1' },
  awayTeam: { name: 'Volley Beispiel H1' },
  homePlayers: [
    { number: 7, firstName: 'Timo', lastName: 'Muster', isCaptain: true },
    { number: 1, firstName: 'Luca', lastName: 'Muster' },
    { number: 13, firstName: 'David', lastName: 'Muster', libero: 'libero1' },
    { number: 14, firstName: 'Lars', lastName: 'Muster', libero: 'libero2' }
  ],
  awayPlayers: [
    { number: 5, firstName: 'Dario', lastName: 'Weber', isCaptain: true },
    { number: 1, firstName: 'Kilian', lastName: 'Wyss', libero: 'libero1' }
  ],
  events: [
    { type: 'sanction', payload: { team: 'away', type: 'warning', playerNumber: '5' } },
    { type: 'sanction', payload: { team: 'home', type: 'penalty', playerNumber: '1' } }
  ]
}

describe('rosterOfTeam', () => {
  it('players by number with captain, liberos and the match cards; officials with their codes', () => {
    const home = rosterOfTeam(bundle, 'home')
    expect(home.letter).toBe('B')
    expect(home.players.map(p => [p.number, p.name, p.captain, p.libero, p.cards])).toEqual([
      [1, 'Muster Luca', false, null, ['penalty']],
      [7, 'Muster Timo', true, null, []],
      [13, 'Muster David', false, 'L1', []],
      [14, 'Muster Lars', false, 'L2', []]
    ])
    expect(home.officials).toEqual([{ role: 'C', name: 'Muster Carla' }, { role: 'AC1', name: 'Muster Paul' }])
    const away = rosterOfTeam(bundle, 'away')
    expect(away.letter).toBe('A')
    expect(away.players.find(p => p.number === 1).libero).toBe('L') // one libero: L
    expect(away.players.find(p => p.number === 5).cards).toEqual(['warning'])
  })
})

describe('RefereeRosters', () => {
  afterEach(() => cleanup())

  it('starts with team A, switches to the other team and back, closes', () => {
    const onClose = vi.fn()
    render(<RefereeRosters bundle={bundle} onClose={onClose} />)
    expect(screen.getByTestId('referee-rosters-team').textContent).toContain('Volley Beispiel H1')
    expect(screen.getAllByTestId('referee-rosters-player')).toHaveLength(2)
    fireEvent.click(screen.getByTestId('referee-rosters-switch'))
    expect(screen.getByTestId('referee-rosters-team').textContent).toContain('VBC Musterdorf H1')
    expect(screen.getAllByTestId('referee-rosters-player')).toHaveLength(4)
    expect(screen.getByTestId('referee-rosters-switch-bottom').textContent).toContain('A · BSP')
    fireEvent.click(screen.getByTestId('referee-rosters-switch-bottom'))
    expect(screen.getByTestId('referee-rosters-team').textContent).toContain('Volley Beispiel H1')
    fireEvent.click(screen.getByTestId('referee-rosters-close'))
    expect(onClose).toHaveBeenCalled()
  })

  it('shows the cards of a sanctioned player', () => {
    render(<RefereeRosters bundle={bundle} onClose={() => {}} />)
    expect(document.querySelector('[data-card-glyph="warning"]')).not.toBeNull()
  })
})
