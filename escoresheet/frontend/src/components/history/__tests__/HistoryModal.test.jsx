import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, within } from '@testing-library/react'

// t() resolves from the real English file, so the test reads what users see
vi.mock('react-i18next', async () => {
  const en = (await import('../../../i18n/locales/en.json')).default
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

import HistoryModal, { HISTORY_ORDER_KEY, readHistoryOrder } from '../HistoryModal.jsx'
import MenuList from '../../MenuList'
import { matchMenuSections, toMenuListSections } from '../../matchMenu'
import { buildMatch, MATCH, HOME_TEAM, AWAY_TEAM, pointsFor } from '../../../domain/__tests__/fixtures/correctionsMatch'
import en from '../../../i18n/locales/en.json'

const lookup = (key) => key.split('.').reduce((o, k) => (o == null ? o : o[k]), en)
const enT = (key, fallback) => (typeof lookup(key) === 'string' ? lookup(key) : fallback)

// Set 1 won 25:20 with a substitution and its return, a time-out, a libero,
// a warning and a delay warning; set 2 started (2 points)
function rich() {
  return buildMatch({
    sets: [
      {
        points: pointsFor(25, 20),
        finished: true,
        extras: [
          { at: 0, type: 'libero_entry', payload: { team: 'away', playerOut: 11, liberoIn: 20 } },
          { at: 3, type: 'timeout', payload: { team: 'away' } },
          { at: 12, type: 'substitution', payload: { team: 'home', playerOut: 2, playerIn: 7 } },
          { at: 20, type: 'sanction', payload: { team: 'away', type: 'delay_warning' } },
          { at: 22, type: 'sanction', payload: { team: 'away', type: 'warning', playerNumber: 12, playerType: 'player' } },
          { at: 30, type: 'substitution', payload: { team: 'home', playerOut: 7, playerIn: 2 } }
        ]
      },
      { points: 'AH' }
    ]
  })
}

function show(props = {}) {
  const { events, sets } = rich()
  const onClose = vi.fn()
  const onCorrections = vi.fn()
  render(<HistoryModal open onClose={onClose} onCorrections={onCorrections} events={events} sets={sets} match={MATCH} homeTeam={HOME_TEAM} awayTeam={AWAY_TEAM} {...props} />)
  return { onClose, onCorrections, events }
}

const rowsOf = (kind) => [...document.querySelectorAll(`[data-history-row="${kind}"]`)]
const cells = (tr) => [...tr.querySelectorAll('td')].map(td => td.textContent)

describe('History: the menu row opens it', () => {
  beforeEach(() => localStorage.clear())

  function Harness({ events, sets }) {
    const [open, setOpen] = useState(false)
    const sections = toMenuListSections(matchMenuSections(enT, { showActionLog: () => setOpen(true), manualChanges: () => {} }))
    return (
      <>
        <MenuList buttonLabel="Match" menuTitle="Match" columns={2} sections={sections} />
        <HistoryModal open={open} onClose={() => setOpen(false)} events={events} sets={sets} match={MATCH} homeTeam={HOME_TEAM} awayTeam={AWAY_TEAM} />
      </>
    )
  }

  it('"History" in the Match menu opens the History; both tabs render', () => {
    const { events, sets } = rich()
    render(<Harness events={events} sets={sets} />)
    fireEvent.click(screen.getByRole('button', { name: /Match/ }))
    fireEvent.click(within(screen.getByRole('menu', { name: 'Match' })).getByRole('menuitem', { name: 'History' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: 'History' })).toBeInTheDocument()
    // History tab: the table with its columns
    const table = within(dialog).getByTestId('history-table')
    const heads = [...table.querySelectorAll('thead th')].map(th => th.textContent)
    expect(heads).toEqual(['Time', 'A', 'B', 'What', 'Line-up A', 'Line-up B'])
    expect(rowsOf('point').length).toBe(47)
    // Set information tab
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Set information' }))
    expect(within(dialog).getByTestId('history-set-info')).toBeInTheDocument()
    expect(within(dialog).getByTestId('history-subs-A')).toBeInTheDocument()
    expect(within(dialog).getByTestId('history-sanctions')).toBeInTheDocument()
    expect(within(dialog).getByTestId('history-timeouts')).toBeInTheDocument()
    // and back
    fireEvent.click(within(dialog).getByRole('radio', { name: 'History' }))
    expect(within(dialog).getByTestId('history-table')).toBeInTheDocument()
  })
})

describe('History tab', () => {
  beforeEach(() => localStorage.clear())

  it('newest first by default; Oldest first is remembered on the device', () => {
    show()
    const first = () => document.querySelector('[data-history-row]')
    // the newest entry: set 2's second point
    expect(first().getAttribute('data-history-row')).toBe('point')
    expect(cells(first()).slice(1, 3)).toEqual(['1', '1'])
    fireEvent.click(within(screen.getByRole('group', { name: 'Order' })).getByRole('button', { name: 'Oldest first' }))
    expect(localStorage.getItem(HISTORY_ORDER_KEY)).toBe('oldest')
    expect(readHistoryOrder()).toBe('oldest')
    expect(first().getAttribute('data-history-row')).toBe('coin_toss')
  })

  it('a point row: the score of A and B and both courts, the libero marked', () => {
    localStorage.setItem(HISTORY_ORDER_KEY, 'oldest')
    show()
    const [p1, p2] = rowsOf('point')
    expect(cells(p1).slice(1, 3)).toEqual(['1', '0'])
    expect(p1.querySelector('[data-what]').textContent).toBe('Point for VC Smash')
    expect(p1.querySelector('[data-lineup="A"]').textContent).toBe('1,2,3,4,5,6')
    expect(p1.querySelector('[data-lineup="B"]').textContent).toBe('L20,12,13,14,15,16')
    expect(p1.querySelector('[data-lineup="B"] [title="Libero"]').textContent).toBe('L20')
    expect(cells(p2).slice(1, 3)).toEqual(['1', '1'])
    expect(p2.querySelector('[data-lineup="B"]').textContent).toBe('12,13,14,15,16,L20')
  })

  it('row tones: set rows, sanctions, libero rows', () => {
    show()
    expect(rowsOf('set_start')[0].getAttribute('data-tone')).toBe('set')
    expect(rowsOf('set_end')[0].getAttribute('data-tone')).toBe('set')
    expect(rowsOf('sanction').map(r => r.getAttribute('data-tone'))).toEqual(['sanction', 'sanction'])
    expect(rowsOf('libero_entry')[0].getAttribute('data-tone')).toBe('muted')
  })

  it('the automatic entries on request; the set filter and the search', () => {
    show()
    expect(rowsOf('rally_start')).toHaveLength(0)
    fireEvent.click(screen.getByRole('switch', { name: 'Show automatic entries' }))
    expect(rowsOf('rally_start')).toHaveLength(47)
    fireEvent.click(screen.getByRole('switch', { name: 'Show automatic entries' }))
    fireEvent.change(screen.getByTestId('history-set-filter'), { target: { value: '2' } })
    expect(rowsOf('point')).toHaveLength(2)
    expect(rowsOf('set_end')).toHaveLength(0)
    fireEvent.change(screen.getByTestId('history-set-filter'), { target: { value: 'all' } })
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), { target: { value: 'warning' } })
    expect([...document.querySelectorAll('[data-history-row]')].map(r => r.getAttribute('data-history-row'))).toEqual(['sanction', 'sanction'])
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), { target: { value: 'nothing like this' } })
    expect(screen.getByText('No entry matches your search.')).toBeInTheDocument()
  })

  it('an empty log says so', () => {
    show({ events: [], sets: [] })
    expect(screen.getByText('Nothing recorded yet.')).toBeInTheDocument()
  })
})

describe('Set information tab', () => {
  beforeEach(() => localStorage.clear())

  it('substitutions with score in and out, sanctions in W P E D, time-outs', () => {
    show()
    fireEvent.click(screen.getByRole('radio', { name: 'Set information' }))
    const subsA = screen.getByTestId('history-subs-A')
    expect([...subsA.querySelectorAll('thead th')].map(th => th.textContent)).toEqual(['Set', 'No. in', 'No. out', 'Score in', 'Score out'])
    expect([...subsA.querySelectorAll('tbody tr')].map(cells)).toEqual([['1', '7', '2', '7:5', '16:14']])
    expect(screen.getByText('No substitutions.')).toBeInTheDocument() // team B
    const sanctions = screen.getByTestId('history-sanctions')
    expect([...sanctions.querySelectorAll('thead th')].map(th => th.textContent)).toEqual(['Set', 'Score', 'A/B', 'W', 'P', 'E', 'D'])
    // the delay warning is a D in the W column; the warning the player's number
    expect([...sanctions.querySelectorAll('tbody tr')].map(cells)).toEqual([
      ['1', '9:11', 'B', 'D', '', '', ''],
      ['1', '10:12', 'B', '12', '', '', '']
    ])
    const timeouts = screen.getByTestId('history-timeouts')
    expect([...timeouts.querySelectorAll('tbody tr')].map(cells)).toEqual([['1', 'B', '1:2']])
    expect(screen.getByText('None.')).toBeInTheDocument() // no injuries
  })

  it('"Information related to" one set', () => {
    show()
    fireEvent.click(screen.getByRole('radio', { name: 'Set information' }))
    fireEvent.change(screen.getByTestId('history-info-filter'), { target: { value: '2' } })
    expect(screen.queryByTestId('history-sanctions')).toBeNull()
    expect(screen.getByText('No sanctions.')).toBeInTheDocument()
    expect(screen.getAllByText('No substitutions.')).toHaveLength(2)
  })
})

describe('footer', () => {
  it('Corrections closes History for the Manual changes panel; Close closes', () => {
    const { onClose, onCorrections } = show()
    fireEvent.click(screen.getByRole('button', { name: 'Corrections' }))
    expect(onCorrections).toHaveBeenCalledTimes(1)
    fireEvent.click(within(screen.getByTestId('history-footer')).getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('without a Corrections handler there is no Corrections button', () => {
    show({ onCorrections: undefined })
    expect(screen.queryByRole('button', { name: 'Corrections' })).toBeNull()
  })

  it('renders nothing when closed', () => {
    const { container } = render(<HistoryModal open={false} onClose={() => {}} events={[]} match={MATCH} />)
    expect(container).toBeEmptyDOMElement()
  })
})
