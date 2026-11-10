import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'

// Owner 2026-11-10: green shield = in the club's lists, gray = typed by hand
// (linkable later); Save asks whether the ones typed by hand go into the
// club's lists; a tab shown again refreshes, and the squad editor takes a
// newer copy while it holds no unsaved edits. Made-up people of VBC Musterdorf.

const tr = vi.hoisted(() => vi.fn((key, opts) => (typeof opts === 'string' ? opts : key)))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tr, i18n: { language: 'en' } })
}))
const ui = vi.hoisted(() => ({ toasts: [] }))
vi.mock('../../ui', async (orig) => {
  const real = await orig()
  return {
    ...real,
    toast: { ...real.toast, success: (m) => ui.toasts.push(['ok', m]), error: (m) => ui.toasts.push(['error', m]) }
  }
})

import TeamEditor from '../manage/TeamEditor'
import { usePanelData } from '../manage/common'
import { ConsolePanel, RowList, RowListCards } from '../../ui'

const okRes = (data, status = 200) => ({ data, error: null, status })
const MARCO = { sv_number: '100003', last_name: 'Probe', first_name: 'Marco', dob: '2001-11-02', gender: 'm', lists: ['players', 'coaches'] }
const NOAH = { sv_number: '100004', last_name: 'Testmann', first_name: 'Noah', dob: '2003-03-03', gender: 'm', lists: ['players'] }
const TINA = { sv_number: '200001', last_name: 'Trainer', first_name: 'Tina', dob: '1980-03-04', gender: 'f', lists: ['coaches'] }
const clubPlayers = { gender: 'm', players: [MARCO, NOAH], people: [MARCO, NOAH, TINA] }
const team = {
  id: 't-h1',
  name: 'VBC Musterdorf H1',
  players: [
    { number: 1, first_name: 'Marco', last_name: 'Probe', dob: '2001-11-02', license_number: '100003' },
    { number: 2, first_name: 'Hans', last_name: 'Hand', dob: '2000-01-01', license_number: '400001' },
    { number: 3, first_name: 'Nohan', last_name: 'Testman', dob: '', license_number: '' }
  ],
  staff: [
    { role: 'Coach', first_name: 'Tina', last_name: 'Trainer', dob: '1980-03-04', license_number: '' },
    { role: 'Physiotherapist', first_name: 'Phil', last_name: 'Physio', dob: '', license_number: '' }
  ]
}
const shields = (testId) => screen.getAllByTestId(testId).map((row) => within(row).getByTestId('club-shield').dataset.shield)

beforeEach(() => {
  vi.clearAllMocks()
  ui.toasts = []
  localStorage.clear()
})

describe('shields in the squad editor', () => {
  it('green for the club\'s people (licence, or name and date of birth), gray for the ones typed by hand', () => {
    render(<TeamEditor team={team} competition={null} online fixedFields saveRoster={vi.fn()} clubPlayers={clubPlayers} />)
    expect(shields('player-row')).toEqual(['club', 'hand', 'hand'])
    // Tina by name and date of birth: green, and a tap fills in her licence
    expect(shields('staff-row')).toEqual(['fill', 'hand'])
    fireEvent.click(within(screen.getAllByTestId('staff-row')[0]).getByTestId('club-shield'))
    expect(screen.getAllByLabelText('savedTeams.license').at(-2).value).toBe('200001')
    expect(shields('staff-row')).toEqual(['club', 'hand'])
  })

  it('no shields without the club\'s lists (Competitions)', () => {
    render(<TeamEditor team={team} competition={null} online fixedFields saveRoster={vi.fn()} />)
    expect(screen.queryAllByTestId('club-shield')).toEqual([])
  })

  it('the gray shield links the row: the search starts at its last name, the row takes the club person', async () => {
    render(<TeamEditor team={team} competition={null} online fixedFields saveRoster={vi.fn()} clubPlayers={clubPlayers} />)
    fireEvent.click(within(screen.getAllByTestId('player-row')[2]).getByTestId('club-shield'))
    const picker = await screen.findByTestId('club-picker')
    expect(picker.dataset.mode).toBe('link')
    expect(within(picker).getByTestId('club-picker-search').value).toBe('Testman')
    // the players list of the team's gender, searched
    const rows = within(picker).getAllByTestId('club-picker-row')
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('Testmann Noah')])
    fireEvent.click(within(rows[0]).getByRole('radio'))
    fireEvent.click(screen.getByTestId('club-picker-add'))
    await waitFor(() => expect(screen.queryByTestId('club-picker')).toBeNull())
    const row = screen.getAllByTestId('player-row')[2]
    expect(within(row).getByLabelText('savedTeams.lastName').value).toBe('Testmann')
    expect(within(row).getByLabelText('savedTeams.license').value).toBe('100004')
    expect(within(row).getByLabelText('savedTeams.number').value).toBe('3')
    expect(shields('player-row')).toEqual(['club', 'hand', 'club'])
    expect(ui.toasts).toContainEqual(['ok', 'clubPlayers.linked'])
  })
})

describe('Save asks about the club\'s lists', () => {
  it('offers the ones typed by hand with a licence; saves the roster, then adds the ticked ones', async () => {
    const saveRoster = vi.fn(async () => okRes({ team: null }))
    const onAddToClub = vi.fn(async () => okRes({ added: 1, already: 0 }, 201))
    const withCoach = { ...team, staff: [...team.staff, { role: 'Assistant Coach 1', first_name: 'Pia', last_name: 'Coach', dob: '', license_number: '500001' }] }
    const { rerender } = render(<TeamEditor team={withCoach} competition={null} online fixedFields saveRoster={saveRoster} clubPlayers={clubPlayers} onAddToClub={onAddToClub} clubName="VBC Musterdorf" />)
    fireEvent.click(screen.getByTestId('save-roster'))
    const offer = await screen.findByTestId('club-offer')
    expect(saveRoster).not.toHaveBeenCalled()
    expect(within(offer).getAllByTestId('club-offer-row').map((r) => r.textContent)).toEqual([
      expect.stringContaining('Hans Hand'),
      expect.stringContaining('Pia Coach')
    ])
    expect(tr).toHaveBeenCalledWith('clubPlayers.offer.body', { club: 'VBC Musterdorf' })
    // no licence number: named, not offered
    expect(tr).toHaveBeenCalledWith('clubPlayers.offer.noLicence', { names: 'Nohan Testman, Phil Physio' })
    // Pia stays out
    fireEvent.click(within(within(offer).getAllByTestId('club-offer-row')[1]).getByRole('checkbox'))
    fireEvent.click(screen.getByTestId('club-offer-save'))
    await waitFor(() => expect(onAddToClub).toHaveBeenCalledTimes(1))
    expect(saveRoster).toHaveBeenCalledTimes(1)
    expect(onAddToClub.mock.calls[0][0]).toEqual([
      { list: 'players', sv_number: '400001', last_name: 'Hand', first_name: 'Hans', dob: '2000-01-01', gender: 'm' }
    ])
    await waitFor(() => expect(screen.queryByTestId('club-offer')).toBeNull())
    expect(ui.toasts).toEqual([['ok', 'savedTeams.rosterSaved'], ['ok', 'clubPlayers.offer.added']])
    // Hans is in the club's lists now, by hand (the parent loads them again):
    // gray still ("added manually"), and not offered again; Pia, left out
    // once, is not asked again either
    const HANS = { sv_number: '400001', last_name: 'Hand', first_name: 'Hans', dob: '2000-01-01', gender: 'm', lists: ['players'], manual: true }
    rerender(<TeamEditor team={withCoach} competition={null} online fixedFields saveRoster={saveRoster} clubPlayers={{ ...clubPlayers, players: [...clubPlayers.players, HANS], people: [...clubPlayers.people, HANS] }} onAddToClub={onAddToClub} clubName="VBC Musterdorf" />)
    expect(shields('player-row')).toEqual(['club', 'manual', 'hand'])
    // linking him offers only people uploaded from VolleyManager
    fireEvent.click(within(screen.getAllByTestId('player-row')[1]).getByTestId('club-shield'))
    const picker = await screen.findByTestId('club-picker')
    fireEvent.change(within(picker).getByTestId('club-picker-search'), { target: { value: '' } })
    expect(within(picker).getAllByTestId('club-picker-row').map((r) => r.textContent)).toEqual([expect.stringContaining('Probe Marco'), expect.stringContaining('Testmann Noah')])
    fireEvent.click(screen.getByText('Cancel'))
    await waitFor(() => expect(screen.queryByTestId('club-picker')).toBeNull())
    fireEvent.click(screen.getByTestId('save-roster'))
    await waitFor(() => expect(saveRoster).toHaveBeenCalledTimes(2))
    expect(screen.queryByTestId('club-offer')).toBeNull()
  })

  it('a failed add keeps the saved roster and says so', async () => {
    const saveRoster = vi.fn(async () => okRes({ team: null }))
    const onAddToClub = vi.fn(async () => ({ data: null, status: 500, error: { code: 'OV_INTERNAL' } }))
    render(<TeamEditor team={team} competition={null} online fixedFields saveRoster={saveRoster} clubPlayers={clubPlayers} onAddToClub={onAddToClub} />)
    fireEvent.click(screen.getByTestId('save-roster'))
    fireEvent.click(await screen.findByTestId('club-offer-save'))
    await waitFor(() => expect(ui.toasts).toContainEqual(['error', 'clubPlayers.offer.failed']))
    expect(ui.toasts[0]).toEqual(['ok', 'savedTeams.rosterSaved'])
  })

  it('Back saves nothing; without onAddToClub Save asks nothing', async () => {
    const saveRoster = vi.fn(async () => okRes({ team: null }))
    const { unmount } = render(<TeamEditor team={team} competition={null} online fixedFields saveRoster={saveRoster} clubPlayers={clubPlayers} onAddToClub={vi.fn()} />)
    fireEvent.click(screen.getByTestId('save-roster'))
    await screen.findByTestId('club-offer')
    fireEvent.click(screen.getByText('clubPlayers.offer.back'))
    await waitFor(() => expect(screen.queryByTestId('club-offer')).toBeNull())
    expect(saveRoster).not.toHaveBeenCalled()
    unmount()
    render(<TeamEditor team={team} competition={null} online fixedFields saveRoster={saveRoster} clubPlayers={clubPlayers} />)
    fireEvent.click(screen.getByTestId('save-roster'))
    await waitFor(() => expect(saveRoster).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('club-offer')).toBeNull()
  })
})

describe('a newer copy of the team', () => {
  it('replaces the drafts while they hold no unsaved edits, keeps them otherwise', () => {
    const { rerender } = render(<TeamEditor team={team} competition={null} online fixedFields saveRoster={vi.fn()} />)
    const licences = () => screen.getAllByLabelText('savedTeams.license').map((i) => i.value)
    expect(licences().slice(-2)).toEqual(['', ''])
    // saved in My teams, loaded again when Competitions is shown
    const newer = { ...team, staff: [{ ...team.staff[0], license_number: '200001' }, team.staff[1]] }
    rerender(<TeamEditor team={newer} competition={null} online fixedFields saveRoster={vi.fn()} />)
    expect(licences().slice(-2)).toEqual(['200001', ''])
    // an unsaved edit stays when yet another copy comes
    fireEvent.change(screen.getAllByLabelText('savedTeams.license').at(-1), { target: { value: '777777' } })
    rerender(<TeamEditor team={{ ...newer, players: newer.players.slice(0, 2) }} competition={null} online fixedFields saveRoster={vi.fn()} />)
    expect(screen.getAllByTestId('player-row')).toHaveLength(3)
    expect(licences().at(-1)).toBe('777777')
  })
})

function Probe({ fetcher }) {
  const { data } = usePanelData(fetcher, [])
  return <p data-testid="probe">{data?.n ?? '-'}</p>
}

describe('the console\'s tabs', () => {
  it('a panel shown again refreshes its data quietly', async () => {
    let n = 0
    const fetcher = vi.fn(async () => okRes({ n: ++n }))
    const { rerender } = render(<ConsolePanel id="teams" current="teams"><Probe fetcher={fetcher} /></ConsolePanel>)
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('1'))
    rerender(<ConsolePanel id="teams" current="myteams"><Probe fetcher={fetcher} /></ConsolePanel>)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await act(async () => {
      rerender(<ConsolePanel id="teams" current="teams"><Probe fetcher={fetcher} /></ConsolePanel>)
    })
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('2'))
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('lists inside RowListCards draw each item as a card; soft lists keep their hairlines', () => {
    render(
      <RowListCards.Provider value>
        <RowList data-testid="cards"><p>a</p>{null}<p>b</p></RowList>
        <RowList soft data-testid="soft"><p>c</p></RowList>
      </RowListCards.Provider>
    )
    const cards = screen.getByTestId('cards')
    expect(cards.children).toHaveLength(2)
    expect([...cards.children].every((c) => c.className.includes('rounded-xl') && c.className.includes('border'))).toBe(true)
    expect(screen.getByTestId('soft').className).toContain('divide-y')
  })
})
