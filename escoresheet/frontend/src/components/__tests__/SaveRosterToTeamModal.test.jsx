// Review findings on "Save roster to team" (MatchSetup, competition managers):
// - a competition without teams yet must be offered (the cache keeps the
//   bundle's competitions, not only those embedded in team rows);
// - when the new team is created but its roster PUT fails, a retry must not
//   create the team again (409 duplicate): the new team is selected instead.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key) => key, i18n: { language: 'en' } })
}))

const EMPTY_COMP = { id: 'c-empty', name: '3. Liga Herren', season: '2026/27', vmLeagues: [], archived: false }
const cache = vi.hoisted(() => ({ rows: [], meta: null }))
vi.mock('../../db/savedTeams', () => ({
  SAVED_TEAMS_CHANGED_EVENT: 'ov-saved-teams-changed',
  getSavedTeams: vi.fn(async () => cache.rows),
  getSavedTeamsMeta: vi.fn(async () => cache.meta),
  refreshSavedTeams: vi.fn(async () => ({ status: 'refreshed', teams: cache.rows })),
  competitionsOf: (rows, meta) => {
    const map = new Map()
    for (const c of meta?.competitions || []) map.set(c.id, c)
    for (const r of rows) if (r.competition && !map.has(r.competition.id)) map.set(r.competition.id, r.competition)
    return [...map.values()]
  }
}))

const api = vi.hoisted(() => ({ createTeam: vi.fn(), putRoster: vi.fn() }))
vi.mock('../../lib/accountApi', async (orig) => ({ ...(await orig()), savedTeamsApi: api }))

const confirm = vi.hoisted(() => ({ fn: vi.fn(async () => true) }))
vi.mock('../../ui', async (orig) => ({ ...(await orig()), confirmDialog: (...a) => confirm.fn(...a) }))

import SaveRosterToTeamModal from '../SaveRosterToTeamModal'

const roster = [{ number: 4, firstName: 'Anna', lastName: 'Muster' }]
const props = { open: true, onClose: vi.fn(), userId: 'u1', access: { canManageTeams: true, canReadTeams: true }, roster, bench: [], meta: { name: 'VBC Neu', shortName: 'NEU', color: '#123456' } }

describe('SaveRosterToTeamModal', () => {
  let onLine
  beforeEach(() => {
    cache.rows = []
    cache.meta = { key: 'bundle', userId: 'u1', fetchedAt: new Date().toISOString(), version: '1', competitions: [EMPTY_COMP] }
    api.createTeam.mockReset()
    api.putRoster.mockReset()
    confirm.fn.mockClear()
    onLine = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true)
  })
  afterEach(() => onLine.mockRestore())

  it('offers a competition that has no team yet, and saves its first team', async () => {
    api.createTeam.mockResolvedValue({ data: { team: { id: 't-new', name: 'VBC Neu' } }, error: null, status: 201 })
    api.putRoster.mockResolvedValue({ data: { team: { id: 't-new' } }, error: null, status: 200 })
    render(<SaveRosterToTeamModal {...props} />)
    expect(await screen.findByRole('option', { name: '3. Liga Herren · 2026/27' })).toBeInTheDocument()
    const save = screen.getByTestId('save-roster-to-team')
    await waitFor(() => expect(save).not.toBeDisabled())
    fireEvent.click(save)
    await waitFor(() => expect(api.putRoster).toHaveBeenCalledWith('t-new', expect.any(Object)))
    expect(api.createTeam).toHaveBeenCalledWith(expect.objectContaining({ competition_id: 'c-empty', name: 'VBC Neu' }))
  })

  it('a roster PUT that fails after the team was created: the retry saves into that team, no second create', async () => {
    api.createTeam.mockImplementation(async (body) => {
      // the server now has the team; the refreshed cache will list it
      cache.rows = [{ id: 't-new', name: body.name, competitionId: 'c-empty', competition: EMPTY_COMP, players: [], staff: [], svrzTeamName: '' }]
      return { data: { team: { id: 't-new', name: body.name } }, error: null, status: 201 }
    })
    api.putRoster
      .mockResolvedValueOnce({ data: null, error: { message: 'down', code: 'OV_DB_UNAVAILABLE', status: 503 }, status: 503 })
      .mockResolvedValueOnce({ data: { team: { id: 't-new' } }, error: null, status: 200 })
    render(<SaveRosterToTeamModal {...props} />)
    const save = await screen.findByTestId('save-roster-to-team')
    await waitFor(() => expect(save).not.toBeDisabled())
    fireEvent.click(save)
    await screen.findByRole('alert')
    // switched to "existing" with the new team selected
    await waitFor(() => expect(screen.getByRole('option', { name: 'VBC Neu' }).selected).toBe(true))
    await waitFor(() => expect(save).not.toBeDisabled())
    fireEvent.click(save)
    await waitFor(() => expect(api.putRoster).toHaveBeenCalledTimes(2))
    expect(api.createTeam).toHaveBeenCalledTimes(1)
    expect(api.putRoster.mock.calls[1][0]).toBe('t-new')
  })
})
