// Review: TeamEditor was keyed on team.updated_at, so saving the team fields
// (or the roster) reloaded the bundle, remounted the editor and dropped the
// other section's unsaved edits.
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => (typeof opts === 'string' ? opts : key), i18n: { language: 'en' } })
}))

const state = vi.hoisted(() => ({ teamName: 'Volley Alpha', updatedAt: '2026-10-01T10:00:00Z' }))
const api = vi.hoisted(() => ({
  savedTeamsApi: {
    fetchBundle: vi.fn(),
    updateTeam: vi.fn(),
    putRoster: vi.fn()
  }
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

const COMP = { id: 'c1', name: 'Liga', season: '2026/27', gender: 'men', category: null, vm_leagues: [], archived: false, updated_at: '2026-10-01T10:00:00Z' }
const bundle = () => ({
  data: {
    version: state.updatedAt,
    competitions: [COMP],
    teams: [{
      id: 't1', competition_id: 'c1', name: state.teamName, short_name: null, club: null, color: null, svrz_team_name: null,
      updated_at: state.updatedAt,
      players: [{ id: 'p1', number: 7, first_name: 'Anna', last_name: 'Muster', dob: null, license_number: null, is_libero: false, is_captain: false, active: true, sort_order: 0 }],
      staff: []
    }]
  },
  error: null,
  status: 200
})

describe('saved team editor keeps unsaved edits of the other section', () => {
  it('saving the team fields does not drop an unsaved player edit', async () => {
    api.savedTeamsApi.fetchBundle.mockImplementation(async () => bundle())
    api.savedTeamsApi.updateTeam.mockImplementation(async (id, body) => {
      state.teamName = body.name
      state.updatedAt = '2026-10-02T10:00:00Z' // the touch trigger moves updated_at
      return { data: { team: { id } }, error: null, status: 200 }
    })
    render(<SavedTeamsPanel userId="u1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Liga' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Volley Alpha' }))

    const lastName = await screen.findByDisplayValue('Muster')
    fireEvent.change(lastName, { target: { value: 'Muster-Neu' } })
    fireEvent.change(screen.getByDisplayValue('Volley Alpha'), { target: { value: 'Volley Beta' } })
    fireEvent.click(screen.getByRole('button', { name: 'manage.accounts.save' }))

    await waitFor(() => expect(api.savedTeamsApi.fetchBundle).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByDisplayValue('Volley Beta')).toBeInTheDocument())
    expect(screen.getByDisplayValue('Muster-Neu')).toBeInTheDocument()
    expect(api.savedTeamsApi.putRoster).not.toHaveBeenCalled()
  })
})
