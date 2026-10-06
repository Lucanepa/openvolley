// docs/beach-saved-teams-spec.md 3.5-3.6: the console manages indoor and beach
// competitions; a beach team is a pair (two fixed slots) with an optional coach.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { mixedSavedTeamsBundle } from '../../domain/__tests__/fixtures/beachSavedTeamsBundle'
import { beachSeasonOptions } from '../../domain/savedTeams'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => (typeof opts === 'string' ? opts : key), i18n: { language: 'en' } })
}))

const api = vi.hoisted(() => ({
  savedTeamsApi: {
    fetchBundle: vi.fn(),
    createCompetition: vi.fn(),
    updateCompetition: vi.fn(),
    updateTeam: vi.fn(),
    putRoster: vi.fn()
  },
  svrzQueries: { n: 0 }
}))
const cache = vi.hoisted(() => ({ storeSavedTeamsBundle: vi.fn(async () => []) }))
vi.mock('../../lib/accountApi', async (orig) => ({ ...(await orig()), savedTeamsApi: api.savedTeamsApi }))
vi.mock('../../db/savedTeams', () => cache)
vi.mock('../../lib/apiClient', () => ({
  apiFrom: () => {
    api.svrzQueries.n += 1
    const b = { select: () => b, in: () => b, limit: () => b, then: (r) => Promise.resolve({ data: [], error: null }).then(r) }
    return b
  },
  apiRequest: vi.fn()
}))

import SavedTeamsPanel from '../manage/SavedTeamsPanel'
import { draftToBeachRosterBody, beachSlotsFromPlayers } from '../manage/TeamEditor'

const ok = (data) => ({ data, error: null, status: 200 })

describe('saved teams console: beach', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.svrzQueries.n = 0
    try { localStorage.clear() } catch { /* none */ }
    api.savedTeamsApi.fetchBundle.mockImplementation(async () => ok(mixedSavedTeamsBundle()))
  })

  it('loads every sport, hands the mixed bundle to the cache unchanged, and the segment switches the lists', async () => {
    render(<SavedTeamsPanel userId="u1" />)
    expect(await screen.findByRole('button', { name: '2. Liga Damen' })).toBeInTheDocument()
    expect(api.savedTeamsApi.fetchBundle).toHaveBeenCalledWith({ sport: 'all' })
    await waitFor(() => expect(cache.storeSavedTeamsBundle).toHaveBeenCalledWith(mixedSavedTeamsBundle(), 'u1'))
    expect(screen.queryByRole('button', { name: 'Coop Beachtour' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'savedTeams.sportBeach' }))
    expect(await screen.findByRole('button', { name: 'Coop Beachtour' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '2. Liga Damen' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Old tour' })).not.toBeInTheDocument() // archived
    expect(localStorage.getItem('ov_saved_teams_sport')).toBe('beach')
    // the season filter offers the beach seasons only
    const seasonSelect = screen.getByRole('combobox', { name: 'savedTeams.season' })
    expect(within(seasonSelect).queryByRole('option', { name: '2026/27' })).toBeNull()
    expect(within(seasonSelect).getByRole('option', { name: '2026' })).toBeInTheDocument()
  })

  it('remembers the sport and creates a beach competition with a year and no leagues', async () => {
    localStorage.setItem('ov_saved_teams_sport', 'beach')
    api.savedTeamsApi.createCompetition.mockResolvedValue({ data: { competition: { id: 'new' } }, error: null, status: 201 })
    render(<SavedTeamsPanel userId="u1" />)
    expect(await screen.findByRole('button', { name: 'Coop Beachtour' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'savedTeams.newCompetition' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('savedTeams.sportBeach')).toBeInTheDocument()
    expect(within(dialog).queryByText('savedTeams.vmLeagues')).toBeNull()
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'savedTeams.competitionName' }), { target: { value: 'Zürich Open' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'manage.accounts.save' }))
    await waitFor(() => expect(api.savedTeamsApi.createCompetition).toHaveBeenCalledTimes(1))
    expect(api.savedTeamsApi.createCompetition).toHaveBeenCalledWith({
      name: 'Zürich Open', season: beachSeasonOptions()[1], gender: null, category: null, sport: 'beach', vm_leagues: []
    })
    expect(api.svrzQueries.n).toBe(0) // no VolleyManager league lookup for beach
  })

  it('editing a beach competition never sends sport or leagues', async () => {
    localStorage.setItem('ov_saved_teams_sport', 'beach')
    api.savedTeamsApi.updateCompetition.mockResolvedValue(ok({ competition: {} }))
    render(<SavedTeamsPanel userId="u1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Coop Beachtour' }))
    expect(await screen.findAllByText('savedTeams.sportBeach')).not.toHaveLength(0) // the header chip
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'manage.accounts.save' }))
    await waitFor(() => expect(api.savedTeamsApi.updateCompetition).toHaveBeenCalledTimes(1))
    const [id, body] = api.savedTeamsApi.updateCompetition.mock.calls[0]
    expect(id).toBe('11111111-1111-4111-8111-111111111111')
    expect(body).toEqual({ name: 'Coop Beachtour', season: '2026', gender: 'women', category: 'A1', archived: false })
  })

  it('the beach team editor has two slots and a coach, no libero/captain/active, and saves the pair', async () => {
    localStorage.setItem('ov_saved_teams_sport', 'beach')
    api.savedTeamsApi.putRoster.mockImplementation(async (id, body) => ok({ team: { id, players: body.players, staff: body.staff } }))
    render(<SavedTeamsPanel userId="u1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Coop Beachtour' }))
    // the team list shows the players of each pair
    fireEvent.click(await screen.findByRole('button', { name: 'Müller / Weber' }))

    const slots = await screen.findAllByTestId('beach-slot')
    expect(slots).toHaveLength(2)
    expect(within(slots[0]).getByDisplayValue('Müller')).toBeInTheDocument()
    expect(within(slots[1]).getByDisplayValue('Weber')).toBeInTheDocument()
    for (const key of ['savedTeams.libero', 'savedTeams.captain', 'savedTeams.active', 'savedTeams.svrzTeamName', 'savedTeams.addPlayer']) {
      expect(screen.queryByText(key)).toBeNull()
    }
    expect(screen.queryAllByTestId('player-row')).toHaveLength(0)
    expect(screen.getByTestId('beach-coach')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'savedTeams.addCoach' })).toBeNull()

    // country is upper-cased while typing; the coach can be removed
    const country2 = within(slots[1]).getByRole('textbox', { name: 'savedTeams.country 2' })
    fireEvent.change(country2, { target: { value: 'ita' } })
    expect(country2).toHaveValue('ITA')
    fireEvent.click(screen.getByRole('button', { name: 'savedTeams.removeCoach' }))
    expect(screen.getByRole('button', { name: 'savedTeams.addCoach' })).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('save-roster'))
    await waitFor(() => expect(api.savedTeamsApi.putRoster).toHaveBeenCalledTimes(1))
    const [teamId, body] = api.savedTeamsApi.putRoster.mock.calls[0]
    expect(teamId).toBe('33333333-3333-4333-8333-333333333333')
    expect(body).toEqual({
      players: [
        { id: '44444444-4444-4444-8444-444444444441', number: 1, first_name: 'Anna', last_name: 'Müller', dob: '1998-01-05', license_number: 'B-1', country: 'CHE' },
        { id: '44444444-4444-4444-8444-444444444442', number: 2, first_name: 'Sara', last_name: 'Weber', dob: '1997-03-12', license_number: null, country: 'ITA' }
      ],
      staff: []
    })
  })

  it('an incomplete pair: slot 2 empty, clearing a slot drops it, a bad country is caught before the request', async () => {
    localStorage.setItem('ov_saved_teams_sport', 'beach')
    render(<SavedTeamsPanel userId="u1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Coop Beachtour' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Rossi' }))
    const slots = await screen.findAllByTestId('beach-slot')
    expect(within(slots[1]).getByRole('textbox', { name: 'savedTeams.lastName 2' })).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: 'savedTeams.addCoach' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'savedTeams.coach: savedTeams.lastName' }), { target: { value: 'Kunz' } })
    fireEvent.change(within(slots[1]).getByRole('textbox', { name: 'savedTeams.lastName 2' }), { target: { value: 'Bianchi' } })
    fireEvent.change(within(slots[1]).getByRole('textbox', { name: 'savedTeams.country 2' }), { target: { value: 'IT' } })
    fireEvent.click(screen.getByTestId('save-roster'))
    expect((await screen.findAllByText('savedTeams.errors.countryFormat')).length).toBeGreaterThan(0)
    expect(api.savedTeamsApi.putRoster).not.toHaveBeenCalled()

    fireEvent.click(within(slots[0]).getByRole('button', { name: 'savedTeams.clearPlayer' }))
    fireEvent.change(within(slots[1]).getByRole('textbox', { name: 'savedTeams.country 2' }), { target: { value: 'ITA' } })
    api.savedTeamsApi.putRoster.mockResolvedValue(ok({ team: null }))
    fireEvent.click(screen.getByTestId('save-roster'))
    await waitFor(() => expect(api.savedTeamsApi.putRoster).toHaveBeenCalledTimes(1))
    expect(api.savedTeamsApi.putRoster.mock.calls[0][1]).toEqual({
      players: [{ number: 2, first_name: '', last_name: 'Bianchi', dob: null, license_number: null, country: 'ITA' }],
      staff: [{ role: 'Coach', first_name: '', last_name: 'Kunz', dob: null, license_number: null }]
    })
  })

  it('draftToBeachRosterBody and beachSlotsFromPlayers', () => {
    const slots = beachSlotsFromPlayers([{ id: 'b', number: 2, last_name: 'Two' }, { id: 'x', number: null, last_name: 'Loose' }])
    expect(slots.map(s => [s.number, s.id, s.last_name])).toEqual([[1, 'x', 'Loose'], [2, 'b', 'Two']])
    expect(draftToBeachRosterBody([{ number: 1, first_name: ' ', last_name: '' }, { number: 2, first_name: 'Ana', last_name: '', country: ' che ' }], { first_name: '', last_name: ' ' }))
      .toEqual({ players: [{ number: 2, first_name: 'Ana', last_name: '', dob: null, license_number: null, country: 'CHE' }], staff: [] })
  })
})
