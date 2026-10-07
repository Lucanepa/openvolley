import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'

// t() resolves from the real English file, so the test reads what users see
vi.mock('react-i18next', async () => {
  const en = (await import('../../i18n/locales/en.json')).default
  const lookup = key => key.split('.').reduce((o, k) => (o == null ? o : o[k]), en)
  return {
    useTranslation: () => ({
      t: (key, a, b) => {
        const opts = typeof a === 'object' ? a : b
        const fallback = typeof a === 'string' ? a : opts?.defaultValue
        const text = typeof lookup(key) === 'string' ? lookup(key) : (fallback ?? key)
        return String(text).replace(/\{\{(\w+)\}\}/g, (_, k) => String(opts?.[k] ?? ''))
      }
    })
  }
})

import RostersPanel, { oneLine } from '../rosters/RostersPanel'
import en from '../../i18n/locales/en.json'
import de from '../../i18n/locales/de.json'
import deCH from '../../i18n/locales/de-CH.json'
import fr from '../../i18n/locales/fr.json'
import it_ from '../../i18n/locales/it.json'

const players = (prefix, numbers, extra = {}) => numbers.map(n => ({
  id: `${prefix}${n}`, number: n, lastName: `${prefix.toUpperCase()}Last${n}`, firstName: 'F', dob: '01.01.2000', ...(extra[n] || {})
}))

const baseData = () => ({
  homeTeam: { name: 'Home' },
  awayTeam: { name: 'Away' },
  homePlayers: players('h', [1, 2, 3, 4, 5, 6, 7, 8, 10], { 1: { isCaptain: true }, 10: { libero: 'libero1' } }),
  awayPlayers: players('a', [1, 2, 3, 4, 5, 6, 7], { 2: { isCaptain: true } }),
  match: { bench_home: [{ role: 'Coach', lastName: 'Boss', firstName: 'B' }], bench_away: [], homeCourtCaptain: 3 },
  set: { index: 1 },
  events: []
})

const row = (container, team, number) =>
  container.querySelector(`[data-team="${team}"] tr[data-player="${number}"]`)

describe('RostersPanel', () => {
  it('hides the Pos. column before the first lineup', () => {
    render(<RostersPanel data={baseData()} lineups={{ home: null, away: null }} servingTeam="home" />)
    expect(screen.queryAllByText('Pos.')).toHaveLength(0)
    expect(screen.getAllByText('Sanctions').length).toBeGreaterThan(0)
  })

  it('shows positions I-VI, a libero on court and the server', () => {
    const data = baseData()
    const { container } = render(
      <RostersPanel
        data={data}
        lineups={{ home: { I: 2, II: 3, III: 4, IV: 5, V: 10, VI: 6 }, away: { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 } }}
        servingTeam="home"
      />
    )
    expect(screen.getAllByText('Pos.').length).toBe(4) // players + liberos, both teams
    expect(row(container, 'home', '2').querySelector('[data-position]').textContent).toBe('I')
    expect(row(container, 'home', '2').querySelector('[data-server]')).not.toBeNull() // serve ball
    expect(row(container, 'away', '1').querySelector('[data-server]')).toBeNull()
    expect(row(container, 'home', '1').querySelector('[data-position]')).toBeNull() // captain on bench
    expect(row(container, 'home', '7').querySelector('[data-position]')).toBeNull()
    // captain #1 off court, #3 designated: game captain badge
    expect(within(row(container, 'home', '3')).getByTitle('Game captain')).toBeTruthy()
    // the libero (in its own table) is on court in V
    const libero = container.querySelector('tr[data-player="10"]')
    expect(libero.querySelector('[data-position]').textContent).toBe('V')
  })

  it('shows sanctions as cards with set and score, delays on the team line', () => {
    const data = baseData()
    data.events = [
      { id: 1, type: 'point', setIndex: 1, seq: 1, payload: { team: 'home' } },
      { id: 2, type: 'sanction', setIndex: 1, seq: 2, payload: { team: 'away', type: 'warning', playerNumber: 4 } },
      { id: 3, type: 'sanction', setIndex: 1, seq: 3, payload: { team: 'away', type: 'expulsion', playerNumber: 5 } },
      { id: 4, type: 'sanction', setIndex: 1, seq: 4, payload: { team: 'away', type: 'delay_warning' } },
      { id: 5, type: 'sanction', setIndex: 1, seq: 5, payload: { team: 'home', type: 'disqualification', playerNumber: 8 } },
      { id: 6, type: 'sanction', setIndex: 1, seq: 6, payload: { team: 'home', type: 'penalty', role: 'Coach' } },
      { id: 7, type: 'bench_injury', setIndex: 1, seq: 7, payload: { team: 'home', playerNumber: 7 } }
    ]
    const { container } = render(<RostersPanel data={data} lineups={{ home: null, away: null }} servingTeam={null} />)

    const warn = row(container, 'away', '4').querySelector('[data-sanction="warning"]')
    expect(warn.getAttribute('title')).toBe('Warning · Set 1, 0:1')
    expect(row(container, 'away', '5').querySelector('[data-sanction="expulsion"]')).not.toBeNull()
    expect(row(container, 'away', '5').querySelector('[data-out="expelled"]')).not.toBeNull()
    expect(row(container, 'home', '8').querySelector('[data-out="disqualified"]')).not.toBeNull()
    expect(within(row(container, 'home', '7')).getByTitle('Injured')).toBeTruthy()

    // delay warning: on the away team line, not on a player
    const teamLine = container.querySelector('[data-team="away"] [data-team-sanctions]')
    expect(teamLine.querySelector('[data-sanction="delay_warning"]')).not.toBeNull()
    expect(container.querySelector('tr [data-sanction="delay_warning"]')).toBeNull()

    // bench official sanction
    const coach = screen.getByText('Coach').closest('tr')
    expect(coach.querySelector('[data-sanction="penalty"]')).not.toBeNull()
  })
})

describe('rosterLive locale keys', () => {
  const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${p}${k}.`) : [`${p}${k}`]))
  const keys = flat(en.rosterLive)
  it.each([['de', de], ['de-CH', deCH], ['fr', fr], ['it', it_]])('%s has every rosterLive key', (_, loc) => {
    expect(flat(loc.rosterLive || {})).toEqual(keys)
  })
})

describe('oneLine', () => {
  it('puts the button labels with a soft break on one line for the tooltip', () => {
    expect(oneLine(de.scoreboard.sanctions.delayWarning)).toBe('Verzögerungswarnung')
    expect(oneLine(deCH.scoreboard.sanctions.delayWarning)).toBe('Verzögerigswarnig')
    expect(oneLine('Delay warning')).toBe('Delay warning')
    expect(oneLine('a\nb')).toBe('a b')
  })

  it('leaves no line break in any sanction label of any language', () => {
    for (const loc of [en, de, deCH, fr, it_]) {
      for (const label of Object.values(loc.scoreboard.sanctions)) {
        if (typeof label === 'string') expect(oneLine(label)).not.toMatch(/\n/)
      }
    }
  })
})
