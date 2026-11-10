import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { useState } from 'react'

// Owner 2026-11-10: "prepare roster -> new page with url with the game id.
// and have the possibility to change role for the staff (coach/ac1/ac2/p/m)
// and also have people be put as P/M manually (e.g. not necessarily from the
// club)". Made-up people of VBC Musterdorf.

const tr = vi.hoisted(() => vi.fn((key, opts) => (typeof opts === 'string' ? opts : key)))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tr, i18n: { language: 'en' } })
}))
const api = vi.hoisted(() => ({
  team: {
    squad: vi.fn(), clubPlayers: vi.fn(), games: vi.fn(), roster: vi.fn(), putRoster: vi.fn(), putSquad: vi.fn(), deleteRoster: vi.fn(),
    requests: vi.fn(async () => ({ data: { requests: [] }, error: null, status: 200 })), decideRequests: vi.fn()
  }
}))
vi.mock('../../lib/accountApi', async (orig) => ({ ...(await orig()), teamApi: api.team }))
vi.mock('../../ui', async (orig) => {
  const real = await orig()
  return { ...real, toast: { ...real.toast, success: () => {}, error: () => {} } }
})

import MyTeamsPanel from '../manage/MyTeamsPanel'
import { roleForNewOfficial, setGameDraftStaffRole } from '../../domain/teamRosters'

const okRes = (data, status = 200) => ({ data, error: null, status })
const TEAM = { id: 't-h1', name: 'VBC Musterdorf H1', club_name: 'VBC Musterdorf' }
const squad = {
  id: 's1',
  name: 'VBC Musterdorf H1',
  players: [{ number: 1, first_name: 'Marco', last_name: 'Probe', dob: '2001-11-02', license_number: '100003', active: true }, { number: 4, first_name: 'Noah', last_name: 'Testmann', dob: null, license_number: '100004', active: true }],
  // both saved as coach (the owner's squad of 10 November)
  staff: [
    { role: 'Coach', first_name: 'Tina', last_name: 'Trainer', dob: '1980-03-04', license_number: '200001' },
    { role: 'Coach', first_name: 'Peter', last_name: 'Weber', dob: '1986-06-23', license_number: '200002' }
  ]
}
const GAME = { game_number: '950001', side: 'home', team_home: 'VBC Musterdorf H1', team_away: 'VBC Other H1', datetime: '2026-11-12T18:00:00', league: '2L Herren', hall: 'MSH', hall_address: 'Sportweg 1', hall_postal_code: '8000', city: 'Musterdorf', referees: ['Rita Referee', 'Sam Second'], roster: null }

beforeEach(() => {
  vi.clearAllMocks()
  api.team.squad.mockResolvedValue(okRes({ season: '2026/27', squad }))
  api.team.clubPlayers.mockResolvedValue(okRes({ gender: 'm', players: [], people: [] }))
  api.team.games.mockResolvedValue(okRes({ games: [GAME] }))
  api.team.roster.mockResolvedValue(okRes({ roster: null }))
  api.team.putRoster.mockResolvedValue(okRes({ roster: { game_number: '950001' } }))
})

/** The console's part: the route of My teams, in state (the console keeps it in the URL hash). */
function Routed({ initial = '', onRouteSpy = () => {} }) {
  const [route, setRoute] = useState(initial)
  return <MyTeamsPanel teams={[TEAM]} route={route} onRoute={(r, opts) => { onRouteSpy(r, opts); setRoute(r) }} />
}

describe('a game\'s roster is a page of its own', () => {
  it('Prepare roster opens the page at <team id>/<game number> (a new history entry); its back button returns', async () => {
    const spy = vi.fn()
    render(<Routed onRouteSpy={spy} />)
    fireEvent.click(await screen.findByTestId('my-team-game-roster'))
    expect(spy).toHaveBeenCalledWith('t-h1/950001', { push: true })
    await screen.findByTestId('game-roster-page')
    // the list of the team is gone: a page, not a dialog over it
    expect(screen.queryByTestId('my-team-games')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByTestId('game-roster-back'))
    expect(spy).toHaveBeenLastCalledWith('t-h1', { push: true })
    await screen.findByTestId('my-team-games')
  })

  it('opens straight from the URL, and says so for a game not in the schedule', async () => {
    const { unmount } = render(<Routed initial="t-h1/950001" />)
    await screen.findByTestId('game-roster')
    expect(api.team.roster).toHaveBeenCalledWith('t-h1', '950001')
    unmount()
    render(<Routed initial="t-h1/123" />)
    await waitFor(() => expect(tr).toHaveBeenCalledWith('manage.myTeams.gameNotFound', { number: '123' }))
  })
})

describe('the officials of a game\'s roster', () => {
  it('changes a role (the one ticked in it before is unticked), adds a physiotherapist by hand, and sends them', async () => {
    render(<Routed initial="t-h1/950001" />)
    await screen.findByTestId('game-roster')
    await waitFor(() => expect(screen.getAllByTestId('game-staff-row')).toHaveLength(2))
    const rows = () => screen.getAllByTestId('game-staff-row')
    // a new roster ticks one person per role: Tina (coach), Peter unticked
    expect(rows().map((r) => within(r).getByRole('checkbox').checked)).toEqual([true, false])
    // Peter becomes assistant coach 1 and is ticked: both go
    fireEvent.change(within(rows()[1]).getByTestId('game-staff-role'), { target: { value: 'Assistant Coach 1' } })
    fireEvent.click(within(rows()[1]).getByRole('checkbox'))
    expect(rows().map((r) => within(r).getByRole('checkbox').checked)).toEqual([true, true])
    // a physiotherapist from outside the club
    fireEvent.click(screen.getByTestId('game-official-add'))
    const form = screen.getByTestId('game-official-new')
    expect(within(form).getByTestId('game-official-new-role').value).toBe('Physiotherapist')
    expect(within(form).getByTestId('game-official-new-add')).toBeDisabled()
    fireEvent.change(within(form).getByTestId('game-official-new-first'), { target: { value: 'Pia' } })
    fireEvent.change(within(form).getByTestId('game-official-new-last'), { target: { value: 'Physio' } })
    fireEvent.click(within(form).getByTestId('game-official-new-add'))
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(screen.queryByTestId('game-official-new')).toBeNull()
    // Peter to coach: Tina is unticked (each role once)
    fireEvent.change(within(rows()[1]).getByTestId('game-staff-role'), { target: { value: 'Coach' } })
    expect(rows().map((r) => within(r).getByRole('checkbox').checked)).toEqual([false, true, true])
    fireEvent.click(screen.getByTestId('game-roster-save'))
    await waitFor(() => expect(api.team.putRoster).toHaveBeenCalledTimes(1))
    expect(api.team.putRoster.mock.calls[0][2].staff).toEqual([
      { role: 'Coach', first_name: 'Peter', last_name: 'Weber', dob: '1986-06-23', license_number: '200002' },
      { role: 'Physiotherapist', first_name: 'Pia', last_name: 'Physio', dob: null, license_number: null }
    ])
  })

  it('ticking an official takes the role from the one ticked in it', async () => {
    render(<Routed initial="t-h1/950001" />)
    await waitFor(() => expect(screen.getAllByTestId('game-staff-row')).toHaveLength(2))
    const rows = screen.getAllByTestId('game-staff-row')
    fireEvent.click(within(rows[1]).getByRole('checkbox'))
    expect(screen.getAllByTestId('game-staff-row').map((r) => within(r).getByRole('checkbox').checked)).toEqual([false, true])
  })
})

describe('setGameDraftStaffRole and roleForNewOfficial', () => {
  const draft = { players: [], staff: [
    { key: 'a', role: 'Coach', last_name: 'A', picked: true },
    { key: 'b', role: 'Medic', last_name: 'B', picked: true },
    { key: 'c', role: 'Coach', last_name: 'C', picked: false }
  ] }
  it('a ticked official takes the role; an unticked one only changes its own', () => {
    const r = setGameDraftStaffRole(draft, 'b', 'Coach')
    expect(r.draft.staff.map((s) => [s.key, s.role, s.picked])).toEqual([['a', 'Coach', false], ['b', 'Coach', true], ['c', 'Coach', false]])
    expect(r.replaced.key).toBe('a')
    const u = setGameDraftStaffRole(draft, 'c', 'Medic')
    expect(u.draft.staff.map((s) => [s.key, s.role, s.picked])).toEqual([['a', 'Coach', true], ['b', 'Medic', true], ['c', 'Medic', false]])
    expect(setGameDraftStaffRole(draft, 'a', 'Boss').draft).toBe(draft)
  })
  it('offers the physiotherapist, then the medic, then the first free role', () => {
    expect(roleForNewOfficial([])).toBe('Physiotherapist')
    expect(roleForNewOfficial([{ role: 'Physiotherapist', picked: true }])).toBe('Medic')
    expect(roleForNewOfficial([{ role: 'Physiotherapist', picked: true }, { role: 'Medic', picked: true }, { role: 'Coach', picked: true }])).toBe('Assistant Coach 1')
    expect(roleForNewOfficial([{ role: 'Physiotherapist', picked: false }])).toBe('Physiotherapist')
  })
})

describe('the page\'s facts and rows (owner 2026-11-10: "all on one line" and "at the top where, when, referees")', () => {
  it('shows when, where (a map link), league, referees and the game number; a person\'s date of birth and licence on the name\'s line', async () => {
    render(<Routed initial="t-h1/950001" />)
    const facts = await screen.findByTestId('game-facts')
    expect(facts.textContent).toContain('Rita Referee, Sam Second')
    expect(facts.textContent).toContain('2L Herren')
    expect(facts.textContent).toContain('#950001')
    const map = within(facts).getByRole('link')
    expect(map.textContent).toBe('MSH, Sportweg 1, 8000 Musterdorf')
    expect(map.getAttribute('href')).toContain(encodeURIComponent('MSH, Sportweg 1, 8000 Musterdorf'))
    await waitFor(() => expect(screen.getAllByTestId('game-staff-row')).toHaveLength(2))
    // one label: the name, then date of birth and licence
    const label = within(screen.getAllByTestId('game-staff-row')[0]).getByText('Trainer Tina').parentElement
    expect(label.textContent).toContain('clubPlayers.licence')
  })

  it('no referees yet: says so', async () => {
    api.team.games.mockResolvedValue(okRes({ games: [{ ...GAME, referees: [] }] }))
    render(<Routed initial="t-h1/950001" />)
    expect((await screen.findByTestId('game-facts')).textContent).toContain('manage.myTeams.facts.noReferees')
  })
})
