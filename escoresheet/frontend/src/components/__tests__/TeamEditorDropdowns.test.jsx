import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

// The saved team's details (owner: "why are these not dropdowns"): Club is a
// dropdown of OpenVolley's clubs (or none, or the team's current one), the
// VolleyManager team name a searchable dropdown of the schedule's teams,
// narrowed to the club's teams, that still takes any text; picking a name
// names an unnamed team.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => (typeof opts === 'string' ? opts : opts?.name ? `${key}|${opts.name}` : opts?.club ? `${key}|${opts.club}` : key), i18n: { language: 'en' } })
}))

const api = vi.hoisted(() => ({
  savedTeamsApi: { updateTeam: vi.fn(), putRoster: vi.fn(), deleteTeam: vi.fn(), vmTeams: vi.fn() },
  fetchPublicClubs: vi.fn()
}))
vi.mock('../../lib/accountApi', async (orig) => ({ ...(await orig()), savedTeamsApi: api.savedTeamsApi, fetchPublicClubs: api.fetchPublicClubs }))
vi.mock('../../lib/apiClient', () => ({
  apiFrom: () => {
    const b = { select: () => b, in: () => b, limit: () => b, then: (r) => Promise.resolve({ data: [], error: null }).then(r) }
    return b
  },
  apiRequest: vi.fn()
}))

import TeamEditor, { clubFieldOptions, vmNameOptions } from '../manage/TeamEditor'

const ok = (data) => ({ data, error: null, status: 200 })
const CLUBS = [
  { id: 'c-must', name: 'VBC Musterdorf', teams: [{ id: 't-h1', name: 'VBC Musterdorf H1' }, { id: 't-d2', name: 'VBC Musterdorf D2' }] },
  { id: 'c-msh', name: 'VBC Mustershausen', teams: [] }
]
const SCHEDULE = ['VBC Musterdorf D2', 'VBC Musterdorf H1', 'VBC Mustershausen H1', 'Volley Zürichsee D1']
const COMP = { id: 'c1', name: 'Liga', season: '2026/27', gender: 'men', vm_leagues: [], sport: 'indoor' }
const team = (over = {}) => ({ id: 't1', competition_id: 'c1', name: '', short_name: null, club: null, color: null, svrz_team_name: null, players: [], staff: [], ...over })
const t = (k, o) => (o?.name ? `${k}|${o.name}` : k)

beforeEach(() => {
  vi.clearAllMocks()
  api.fetchPublicClubs.mockResolvedValue(ok({ clubs: CLUBS }))
  api.savedTeamsApi.vmTeams.mockResolvedValue(ok({ teams: SCHEDULE.map((name) => ({ name, club_id: null, club_name: null })) }))
  api.savedTeamsApi.updateTeam.mockResolvedValue(ok({ team: { id: 't1' } }))
})

const options = (listbox) => within(listbox).queryAllByRole('option').map((o) => o.textContent)

describe('what the dropdowns offer', () => {
  it('Club: no club, the clubs, and a current club that is not one of them', () => {
    expect(clubFieldOptions(CLUBS, '', t).map((o) => o.value)).toEqual(['', 'VBC Musterdorf', 'VBC Mustershausen'])
    expect(clubFieldOptions(CLUBS, 'vbc musterdorf', t)).toHaveLength(3)
    expect(clubFieldOptions(CLUBS, 'Old Club', t).at(-1)).toEqual({ value: 'Old Club', label: 'savedTeams.clubNotListed|Old Club' })
  })

  it('VolleyManager names: the club\'s teams when it has some, else the schedule\'s', () => {
    expect(vmNameOptions({ clubs: CLUBS, clubName: 'VBC Musterdorf', scheduleNames: SCHEDULE })).toEqual({ names: ['VBC Musterdorf D2', 'VBC Musterdorf H1'], narrowed: true, club: 'VBC Musterdorf' })
    expect(vmNameOptions({ clubs: CLUBS, clubName: 'VBC Musterdorf', scheduleNames: SCHEDULE, all: true }).names).toEqual(SCHEDULE)
    expect(vmNameOptions({ clubs: CLUBS, clubName: 'VBC Mustershausen', scheduleNames: SCHEDULE })).toEqual({ names: SCHEDULE, narrowed: false, club: 'VBC Mustershausen' })
    expect(vmNameOptions({ clubs: CLUBS, clubName: '', scheduleNames: SCHEDULE }).narrowed).toBe(false)
  })
})

describe('the saved team editor', () => {
  it('picks the club from a dropdown, the VolleyManager name from the club\'s teams, and names the team', async () => {
    render(<TeamEditor team={team()} competition={COMP} online />)
    const club = await screen.findByTestId('team-club-select')
    expect(within(club).getAllByRole('option').map((o) => o.value)).toEqual(['', 'VBC Musterdorf', 'VBC Mustershausen'])
    fireEvent.change(club, { target: { value: 'VBC Musterdorf' } })
    const vm = screen.getByTestId('team-vm-name')
    expect(vm).toHaveAttribute('role', 'combobox')
    fireEvent.keyDown(vm, { key: 'ArrowDown' })
    const list = screen.getByRole('listbox')
    expect(options(list)).toEqual(['VBC Musterdorf D2', 'VBC Musterdorf H1'])
    fireEvent.click(within(list).getByText('VBC Musterdorf H1'))
    expect(vm).toHaveValue('VBC Musterdorf H1')
    expect(screen.queryByRole('listbox')).toBeNull()
    // the empty team name takes the VolleyManager name (still editable)
    expect(screen.getAllByDisplayValue('VBC Musterdorf H1').map((el) => el.getAttribute('role'))).toEqual([null, 'combobox'])
    fireEvent.click(screen.getByText('manage.accounts.save'))
    await waitFor(() => expect(api.savedTeamsApi.updateTeam).toHaveBeenCalledWith('t1', {
      name: 'VBC Musterdorf H1', short_name: null, club: 'VBC Musterdorf', color: null, svrz_team_name: 'VBC Musterdorf H1'
    }))
  })

  it('searches the whole schedule ("Show every team"), keeps a typed name and a named team\'s name', async () => {
    render(<TeamEditor team={team({ name: 'Herren 1', club: 'VBC Musterdorf' })} competition={COMP} online />)
    const vm = await screen.findByTestId('team-vm-name')
    await waitFor(() => expect(screen.getByTestId('team-vm-scope')).toHaveTextContent('savedTeams.svrzShowAll'))
    fireEvent.click(screen.getByTestId('team-vm-scope'))
    expect(screen.getByTestId('team-vm-scope')).toHaveTextContent('savedTeams.svrzClubOnly|VBC Musterdorf')
    // typing filters, accents and case aside
    fireEvent.change(vm, { target: { value: 'zuri' } })
    expect(options(screen.getByRole('listbox'))).toEqual(['Volley Zürichsee D1'])
    fireEvent.keyDown(vm, { key: 'ArrowDown' })
    fireEvent.keyDown(vm, { key: 'Enter' })
    expect(vm).toHaveValue('Volley Zürichsee D1')
    // a named team keeps its name
    expect(screen.getByDisplayValue('Herren 1')).toBeInTheDocument()
    // a name the schedule does not have is kept as typed
    fireEvent.change(vm, { target: { value: 'VBC Musterdorf H9' } })
    expect(screen.getByText('savedTeams.svrzNoMatch')).toBeInTheDocument()
    fireEvent.keyDown(vm, { key: 'Escape' })
    fireEvent.click(screen.getByText('manage.accounts.save'))
    await waitFor(() => expect(api.savedTeamsApi.updateTeam).toHaveBeenCalledWith('t1', expect.objectContaining({ name: 'Herren 1', club: 'VBC Musterdorf', svrz_team_name: 'VBC Musterdorf H9' })))
  })

  it('keeps a club that is not one of OpenVolley\'s, and "No club" clears it', async () => {
    render(<TeamEditor team={team({ name: 'Gäste', club: 'Old Club' })} competition={COMP} online />)
    const club = await screen.findByTestId('team-club-select')
    expect(club).toHaveValue('Old Club')
    fireEvent.change(club, { target: { value: '' } })
    fireEvent.click(screen.getByText('manage.accounts.save'))
    await waitFor(() => expect(api.savedTeamsApi.updateTeam).toHaveBeenCalledWith('t1', expect.objectContaining({ club: null })))
  })

  it('without the lists (an older server): the plain fields as before', async () => {
    api.fetchPublicClubs.mockResolvedValue({ data: null, error: { code: 'OV_NOT_FOUND' }, status: 404 })
    api.savedTeamsApi.vmTeams.mockResolvedValue({ data: null, error: { code: 'OV_NOT_FOUND' }, status: 404 })
    render(<TeamEditor team={team({ name: 'Herren 1', club: 'VBC Musterdorf' })} competition={COMP} online />)
    await waitFor(() => expect(api.savedTeamsApi.vmTeams).toHaveBeenCalled())
    expect(screen.queryByTestId('team-club-select')).toBeNull()
    expect(screen.queryByTestId('team-vm-name')).toBeNull()
    expect(screen.getByDisplayValue('VBC Musterdorf')).toBeInTheDocument()
  })

  it('a beach team keeps its plain club field and has no VolleyManager name', async () => {
    render(<TeamEditor team={team({ name: 'Muster / Beispiel', club: 'Beach Club' })} competition={{ ...COMP, sport: 'beach' }} online />)
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId('team-club-select')).toBeNull()
    expect(screen.getByDisplayValue('Beach Club')).toBeInTheDocument()
    expect(screen.queryByTestId('team-vm-name')).toBeNull()
    expect(api.fetchPublicClubs).not.toHaveBeenCalled()
  })
})
