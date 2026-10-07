import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'

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

import MenuList from '../MenuList'
import SanctionsResultsModal from '../SanctionsResultsModal'
import { matchMenuSections, toMenuListSections } from '../matchMenu'
import en from '../../i18n/locales/en.json'
import de from '../../i18n/locales/de.json'
import deCH from '../../i18n/locales/de-CH.json'
import fr from '../../i18n/locales/fr.json'
import it_ from '../../i18n/locales/it.json'

const LOCALES = { en, de, 'de-CH': deCH, fr, it: it_ }
const lookup = (dict, key) => key.split('.').reduce((o, k) => (o == null ? o : o[k]), dict)

const ACTION_NAMES = [
  'showRosters', 'showSanctions', 'showActionLog', 'openRemarks', 'openMatchSetup',
  'manualChanges', 'editRosterHome', 'editRosterAway', 'showPins', 'downloadGameData',
  'options', 'stopMatch'
]
const allActions = () => Object.fromEntries(ACTION_NAMES.map(n => [n, vi.fn()]))
const keyT = (key) => key

describe('match menu sections', () => {
  it('groups the rows, most used first and "Stop the match" alone at the end', () => {
    const sections = matchMenuSections(keyT, allActions())
    expect(sections.map(s => s.key)).toEqual(['info', 'corrections', 'devices', 'settings', 'end'])
    expect(sections.map(s => s.items.map(i => i.key))).toEqual([
      ['rosters', 'sanctions', 'action-log', 'remarks', 'match-setup'],
      ['manual', 'edit-roster-home', 'edit-roster-away'],
      ['pins', 'export'],
      ['options'],
      ['stop-match']
    ])
    const end = sections[sections.length - 1]
    expect(end.danger).toBe(true)
    expect(end.items[0].danger).toBe(true)
    // Every row has an icon
    sections.flatMap(s => s.items).forEach(i => expect(i.Icon).toBeTruthy())
  })

  it('drops a row without a handler (no match setup page) and an empty section', () => {
    const actions = allActions()
    delete actions.openMatchSetup
    delete actions.options
    const sections = matchMenuSections(keyT, actions)
    expect(sections.find(s => s.key === 'info').items.map(i => i.key)).not.toContain('match-setup')
    expect(sections.map(s => s.key)).not.toContain('settings')
  })

  it('every section title and row label exists in all five languages', () => {
    const keys = new Set()
    matchMenuSections((key) => { keys.add(key); return key }, allActions())
    expect(keys.size).toBeGreaterThan(10)
    for (const [lng, dict] of Object.entries(LOCALES)) {
      for (const key of keys) {
        expect(typeof lookup(dict, key), `${lng}: ${key}`).toBe('string')
      }
    }
  })
})

describe('MenuList with sections', () => {
  // detail 1: a pointer click; 0: Enter / Space on the button
  const setup = ({ detail = 1 } = {}) => {
    const actions = allActions()
    const sections = toMenuListSections(matchMenuSections(keyT, actions))
    render(<MenuList buttonLabel="Match" menuTitle="Match" columns={2} sections={sections} />)
    fireEvent.click(screen.getByRole('button', { name: /Match/ }), { detail })
    return actions
  }

  it('opened from the keyboard, the first row takes the focus', () => {
    setup({ detail: 0 })
    expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[0])
    fireEvent.keyDown(document, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[1])
  })

  it('draws one labelled group per section, the danger one last', () => {
    setup()
    const groups = within(screen.getByRole('menu')).getAllByRole('group')
    expect(groups.map(g => g.getAttribute('data-menu-section'))).toEqual(['info', 'corrections', 'devices', 'settings', 'end'])
    expect(groups[0]).toHaveAccessibleName('scoreboard.menu.sections.matchInfo')
    expect(within(groups[4]).getByRole('menuitem')).toHaveTextContent('scoreboard.menu.stopMatch')
  })

  it('a row runs its own handler and closes the menu', () => {
    const actions = setup()
    fireEvent.click(screen.getByRole('menuitem', { name: 'scoreboard.menu.showSanctionsResults' }))
    expect(actions.showSanctions).toHaveBeenCalledTimes(1)
    expect(actions.stopMatch).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('arrow keys move between rows across the groups; Escape closes and refocuses the button', () => {
    setup()
    const rows = screen.getAllByRole('menuitem')
    fireEvent.keyDown(document, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[0])
    fireEvent.keyDown(document, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(rows[rows.length - 1])
    fireEvent.keyDown(document, { key: 'Home' })
    expect(document.activeElement).toBe(rows[0])
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Match/ }))
  })

  it('a flat items list still works (other toolbars)', () => {
    const onClick = vi.fn()
    render(<MenuList buttonLabel="Tools" menuTitle="Tools" items={[{ header: 'Group' }, { key: 'a', label: 'Alpha', onClick }]} />)
    fireEvent.click(screen.getByRole('button', { name: /Tools/ }))
    expect(screen.getByText('Group')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Alpha' }))
    expect(onClick).toHaveBeenCalled()
  })
})

describe('SanctionsResultsModal', () => {
  const ev = (seq, setIndex, type, payload) => ({ id: seq, seq, setIndex, type, payload, ts: new Date(2026, 0, 1, 10, 0, seq).toISOString() })
  const baseData = (over = {}) => ({
    match: { status: 'live', sanctions: { improperRequestAway: true }, remarks: 'Floor wiped', bestOf: 5, ...(over.match || {}) },
    homeTeam: { name: 'Home Club', color: '#ef4444' },
    awayTeam: { name: 'Away Club', color: '#3b82f6' },
    sets: over.sets || [
      { id: 's1', index: 1, homePoints: 25, awayPoints: 20, finished: true, startTime: '2026-01-01T10:00:00Z', endTime: '2026-01-01T10:24:00Z' },
      { id: 's2', index: 2, homePoints: 3, awayPoints: 1, finished: false, startTime: '2026-01-01T10:28:00Z' }
    ],
    events: [
      ev(1, 1, 'point', { team: 'home' }),
      ev(2, 1, 'point', { team: 'away' }),
      ev(3, 1, 'sanction', { team: 'away', type: 'warning', playerNumber: 7 }),
      ev(4, 1, 'timeout', { team: 'home' }),
      ev(5, 2, 'point', { team: 'home' }),
      ev(6, 2, 'sanction', { team: 'home', type: 'delay_penalty' }),
      ev(7, 2, 'sanction', { team: 'home', type: 'expulsion', role: 'Coach' }),
      ev(8, 2, 'sanction', { team: 'away', type: 'improper_request' })
    ]
  })

  it('lists every sanction with its cards, person, team, set and score', () => {
    render(<SanctionsResultsModal open onClose={() => {}} data={baseData()} teamAKey="home" leftIsHome onSign={() => {}} />)
    const rows = document.querySelectorAll('[data-sanction-row]')
    // the improper request is the crossed box, not a row
    expect([...rows].map(r => r.getAttribute('data-sanction-row'))).toEqual(['warning', 'delay_penalty', 'expulsion'])
    expect(rows[0]).toHaveTextContent('Warning')
    expect(rows[0]).toHaveTextContent('#7')
    expect(rows[0]).toHaveTextContent('B') // away is team B
    expect(rows[0]).toHaveTextContent('1:1') // away 1 : home 1 when warned
    expect(rows[1]).toHaveTextContent('Team')
    expect(rows[2]).toHaveTextContent('C')
    expect(rows[0].querySelector('[data-sanction="warning"]')).not.toBeNull()
    expect(rows[2].querySelector('[data-sanction="expulsion"]')).not.toBeNull()
    expect(document.querySelectorAll('[data-improper-request="yes"]')).toHaveLength(1)
    expect(screen.getByText('Floor wiped')).toBeInTheDocument()
  })

  it('shows the played sets from the current sides while the match runs', () => {
    render(<SanctionsResultsModal open onClose={() => {}} data={baseData()} teamAKey="home" leftIsHome onSign={() => {}} />)
    const set1 = document.querySelector('[data-set-row="1"]')
    expect(set1).toHaveTextContent('25')
    expect(set1).toHaveTextContent("24'")
    expect(document.querySelector('[data-set-row="2"]')).toHaveTextContent('3')
  })

  it('shows the totals and the captains\' sign buttons once the match is over', () => {
    const onSign = vi.fn()
    const data = baseData({ match: { status: 'ended' } })
    render(<SanctionsResultsModal open onClose={() => {}} data={data} teamAKey="home" leftIsHome onSign={onSign} />)
    expect(document.querySelector('[data-set-row]')).toBeNull()
    const sign = screen.getAllByRole('button', { name: en.scoreboard.sign })
    fireEvent.click(sign[1])
    expect(onSign).toHaveBeenCalledWith('away-captain')
  })

  it('renders nothing when closed', () => {
    const { container } = render(<SanctionsResultsModal open={false} onClose={() => {}} data={baseData()} teamAKey="home" leftIsHome onSign={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })
})
