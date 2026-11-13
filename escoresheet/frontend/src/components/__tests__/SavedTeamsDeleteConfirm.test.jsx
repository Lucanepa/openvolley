// fe-manage-2: deleting a competition that still has teams (every club's
// squad of a league goes with it) or a team that still has people needs its
// name typed; the server checks the same (?confirm=, 400 OV_CONFIRM_NAME).
// Made-up names.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { findButton } from '../../__tests__/buttonQueries'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => (typeof opts === 'string' ? opts : key), i18n: { language: 'en' } })
}))
const api = vi.hoisted(() => ({
  savedTeamsApi: { fetchBundle: vi.fn(), deleteCompetition: vi.fn(), deleteTeam: vi.fn(), updateTeam: vi.fn(), putRoster: vi.fn() }
}))
vi.mock('../../lib/accountApi', async (orig) => ({ ...(await orig()), savedTeamsApi: api.savedTeamsApi }))
vi.mock('../../db/savedTeams', () => ({ storeSavedTeamsBundle: vi.fn(async () => []) }))
vi.mock('../../lib/apiClient', () => ({
  apiFrom: () => {
    const b = { select: () => b, in: () => b, limit: () => b, then: (r) => Promise.resolve({ data: [], error: null }).then(r) }
    return b
  },
  apiRequest: vi.fn()
}))

import SavedTeamsPanel from '../manage/SavedTeamsPanel'
import { UiHost } from '../../ui'

const okRes = (data) => ({ data, error: null, status: 200 })
const COMP = { id: 'c1', name: 'Liga Muster', season: '2026/27', gender: 'men', category: null, vm_leagues: [], archived: false, updated_at: '2026-10-01T10:00:00Z' }
const EMPTY = { ...COMP, id: 'c2', name: 'Leer' }
const TEAM = {
  id: 't1', competition_id: 'c1', name: 'Volley Alpha', short_name: null, club: null, color: null, svrz_team_name: null, updated_at: '2026-10-01T10:00:00Z',
  players: [{ id: 'p1', number: 7, first_name: 'Anna', last_name: 'Muster', dob: null, license_number: null, is_libero: false, is_captain: false, active: true, sort_order: 0 }],
  staff: []
}

beforeEach(() => {
  vi.clearAllMocks()
  api.savedTeamsApi.fetchBundle.mockResolvedValue(okRes({ version: '1', competitions: [COMP, EMPTY], teams: [TEAM] }))
  api.savedTeamsApi.deleteCompetition.mockResolvedValue(okRes({ deleted: true }))
  api.savedTeamsApi.deleteTeam.mockResolvedValue(okRes({ deleted: true }))
})

const type = async (text) => {
  fireEvent.change(await screen.findByTestId('confirm-input'), { target: { value: text } })
  fireEvent.click(screen.getByTestId('confirm-accept'))
}

describe('deleting saved teams needs the name typed', () => {
  it('a competition with teams: a wrong name deletes nothing, the right one is sent', async () => {
    render(<><SavedTeamsPanel userId="u1" /><UiHost /></>)
    fireEvent.click(await findButton('Liga Muster'))
    fireEvent.click(await findButton('savedTeams.deleteCompetition'))
    await type('Liga')
    await screen.findByText('savedTeams.confirmNameMismatch')
    expect(api.savedTeamsApi.deleteCompetition).not.toHaveBeenCalled()
    fireEvent.click(await findButton('savedTeams.deleteCompetition'))
    await type(' liga muster ')
    await waitFor(() => expect(api.savedTeamsApi.deleteCompetition).toHaveBeenCalledWith('c1', { confirm: ' liga muster ' }))
  })

  it('an empty competition: one confirm, nothing to type', async () => {
    render(<><SavedTeamsPanel userId="u1" /><UiHost /></>)
    fireEvent.click(await findButton('Leer'))
    fireEvent.click(await findButton('savedTeams.deleteCompetition'))
    await screen.findByTestId('confirm-dialog')
    expect(screen.queryByTestId('confirm-input')).toBeNull()
    fireEvent.click(screen.getByTestId('confirm-accept'))
    await waitFor(() => expect(api.savedTeamsApi.deleteCompetition).toHaveBeenCalledWith('c2', { confirm: undefined }))
  })

  it('a team with players: its name typed', async () => {
    render(<><SavedTeamsPanel userId="u1" /><UiHost /></>)
    fireEvent.click(await findButton('Liga Muster'))
    fireEvent.click(await findButton('Volley Alpha'))
    fireEvent.click(await findButton('savedTeams.deleteTeam'))
    await type('Volley Beta')
    await screen.findByText('savedTeams.confirmNameMismatch')
    expect(api.savedTeamsApi.deleteTeam).not.toHaveBeenCalled()
    fireEvent.click(await findButton('savedTeams.deleteTeam'))
    await type('Volley Alpha')
    await waitFor(() => expect(api.savedTeamsApi.deleteTeam).toHaveBeenCalledWith('t1', { confirm: 'Volley Alpha' }))
  })
})
