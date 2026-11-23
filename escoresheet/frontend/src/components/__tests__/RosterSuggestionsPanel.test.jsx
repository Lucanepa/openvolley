import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

// db/058 (audit 2611 PERM-04, owner decision 2026-11-23 no. 2): another club's
// closed official match's roster of a team waits for a yes of whoever manages
// the team. My teams shows each one with what it would change and the roster
// as entered; Confirm merges it, Reject keeps nothing.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => (typeof opts === 'string' ? opts : opts?.count != null ? `${key}|${opts.count}` : opts?.number ? `${key}|${opts.number}` : key),
    i18n: { language: 'en' }
  })
}))

const api = vi.hoisted(() => ({ team: { rosterSuggestions: vi.fn(), decideRosterSuggestion: vi.fn() } }))
vi.mock('../../lib/accountApi', async (orig) => ({ ...(await orig()), teamApi: api.team }))
const ui = vi.hoisted(() => ({ confirm: vi.fn(async () => true), toasts: [] }))
vi.mock('../../ui', async (orig) => {
  const real = await orig()
  return {
    ...real,
    confirmDialog: (...a) => ui.confirm(...a),
    toast: { ...real.toast, success: (m) => ui.toasts.push(['ok', m]), error: (m) => ui.toasts.push(['error', m]), info: (m) => ui.toasts.push(['info', m]) }
  }
})

import RosterSuggestionsPanel from '../manage/RosterSuggestionsPanel'

const ok = (data) => ({ data, error: null, status: 200 })
const TEAM = { id: 't-b1', name: 'VC Beispielstadt D1', club_id: 'c-b', club_name: 'VC Beispielstadt' }
const SUG = {
  id: 's-1',
  game_number: '961001',
  kickoff: '2026-11-25T18:00:00',
  team_home: 'VBC Musterdorf D2',
  team_away: 'VC Beispielstadt D1',
  side: 'away',
  latest: true,
  changed: true,
  counts: { added: 3, numbers: 2, roles: 0 },
  club_new: 4,
  players: [
    { number: 2, first_name: 'Gina', last_name: 'Gast', license_number: '970201', known: true },
    { number: 3, first_name: 'Erfunden', last_name: 'Niemand', license_number: '971999', known: false }
  ],
  staff: [{ role: 'Coach', first_name: 'Falscher', last_name: 'Trainer', license_number: '971997', known: false }]
}

beforeEach(() => {
  vi.clearAllMocks()
  ui.toasts = []
  ui.confirm.mockResolvedValue(true)
  api.team.rosterSuggestions.mockResolvedValue(ok({ team: TEAM, suggestions: [SUG] }))
  api.team.decideRosterSuggestion.mockResolvedValue(ok({ suggestion: { id: 's-1', status: 'confirmed' } }))
})

describe('My teams: rosters from other clubs\' matches', () => {
  it('shows the game, what confirming changes and the roster, new people marked', async () => {
    render(<RosterSuggestionsPanel team={TEAM} />)
    const row = await screen.findByTestId('roster-suggestion-s-1')
    expect(api.team.rosterSuggestions).toHaveBeenCalledWith('t-b1')
    expect(row).toHaveTextContent('manage.myTeams.suggestions.game|961001')
    expect(row).toHaveTextContent('VBC Musterdorf D2 – VC Beispielstadt D1')
    expect(row).toHaveTextContent('25.11.2026')
    expect(row).toHaveTextContent('manage.myTeams.suggestions.added|3')
    expect(row).toHaveTextContent('manage.myTeams.suggestions.numbers|2')
    expect(row).toHaveTextContent('manage.myTeams.suggestions.clubNew|4')
    expect(row).not.toHaveTextContent('manage.myTeams.suggestions.roles')
    const people = within(row).getByTestId('roster-suggestion-people-s-1').querySelectorAll('li')
    expect([...people].map((li) => li.textContent)).toEqual([
      '2Gina Gast970201',
      '3Erfunden Niemand971999manage.myTeams.suggestions.new',
      'Falscher TrainerCoach971997manage.myTeams.suggestions.new'
    ])
    expect(screen.queryByTestId('roster-suggestion-older-s-1')).toBeNull()
  })

  it('Confirm merges it: the decision, a toast, the list and the squad read again', async () => {
    const onDecided = vi.fn()
    render(<RosterSuggestionsPanel team={TEAM} onDecided={onDecided} />)
    fireEvent.click(await screen.findByTestId('roster-suggestion-confirm-s-1'))
    await waitFor(() => expect(api.team.decideRosterSuggestion).toHaveBeenCalledWith('t-b1', 's-1', 'confirm'))
    expect(ui.confirm).not.toHaveBeenCalled()
    await waitFor(() => expect(onDecided).toHaveBeenCalled())
    expect(ui.toasts).toContainEqual(['ok', 'manage.myTeams.suggestions.confirmed'])
    expect(api.team.rosterSuggestions).toHaveBeenCalledTimes(2)
  })

  it('Reject asks first; no merge, the squad is not read again', async () => {
    const onDecided = vi.fn()
    api.team.decideRosterSuggestion.mockResolvedValue(ok({ suggestion: { id: 's-1', status: 'rejected' } }))
    render(<RosterSuggestionsPanel team={TEAM} onDecided={onDecided} />)
    ui.confirm.mockResolvedValueOnce(false)
    fireEvent.click(await screen.findByTestId('roster-suggestion-reject-s-1'))
    await waitFor(() => expect(ui.confirm).toHaveBeenCalledTimes(1))
    expect(api.team.decideRosterSuggestion).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('roster-suggestion-reject-s-1'))
    await waitFor(() => expect(api.team.decideRosterSuggestion).toHaveBeenCalledWith('t-b1', 's-1', 'reject'))
    expect(ui.confirm.mock.calls[1][0].tone).toBe('danger')
    await waitFor(() => expect(ui.toasts).toContainEqual(['ok', 'manage.myTeams.suggestions.rejected']))
    expect(onDecided).not.toHaveBeenCalled()
  })

  it('decided meanwhile: says so and reads the list again; a reopened match: the row says so', async () => {
    api.team.decideRosterSuggestion.mockResolvedValueOnce({ data: null, error: { code: 'OV_SUGGESTION_DECIDED', status: 409 } })
    render(<RosterSuggestionsPanel team={TEAM} />)
    fireEvent.click(await screen.findByTestId('roster-suggestion-confirm-s-1'))
    await waitFor(() => expect(ui.toasts).toContainEqual(['info', 'manage.myTeams.suggestions.gone']))
    await waitFor(() => expect(api.team.rosterSuggestions).toHaveBeenCalledTimes(2))
    api.team.decideRosterSuggestion.mockResolvedValueOnce({ data: null, error: { code: 'OV_MATCH_NOT_CLOSED', status: 409 } })
    fireEvent.click(await screen.findByTestId('roster-suggestion-confirm-s-1'))
    expect(await screen.findByText('manage.myTeams.suggestions.notClosed')).toBeInTheDocument()
  })

  it('an older game is marked; one that changes nothing says so', async () => {
    api.team.rosterSuggestions.mockResolvedValue(ok({ team: TEAM, suggestions: [{ ...SUG, latest: false, changed: false, counts: { added: 0, numbers: 0, roles: 0 }, club_new: 0 }] }))
    render(<RosterSuggestionsPanel team={TEAM} />)
    expect(await screen.findByTestId('roster-suggestion-older-s-1')).toHaveTextContent('manage.myTeams.suggestions.older')
    expect(screen.getByTestId('roster-suggestion-s-1')).toHaveTextContent('manage.myTeams.suggestions.nothing')
  })

  it('nothing at all without a suggestion, or on a server without the route', async () => {
    api.team.rosterSuggestions.mockResolvedValueOnce(ok({ team: TEAM, suggestions: [] }))
    const { container, unmount } = render(<RosterSuggestionsPanel team={TEAM} />)
    await waitFor(() => expect(api.team.rosterSuggestions).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 0))
    expect(container).toBeEmptyDOMElement()
    unmount()
    api.team.rosterSuggestions.mockResolvedValueOnce({ data: null, error: { code: 'OV_NOT_FOUND', status: 404 } })
    const other = render(<RosterSuggestionsPanel team={TEAM} />)
    await waitFor(() => expect(api.team.rosterSuggestions).toHaveBeenCalledTimes(2))
    await new Promise((r) => setTimeout(r, 0))
    expect(other.container).toBeEmptyDOMElement()
  })
})
