import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

// db/018: the manager's clubs (admins), an account's clubs and an invite's club

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => (typeof opts === 'string' ? opts : key), i18n: { language: 'en' } })
}))

const api = vi.hoisted(() => ({
  clubs: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), vmTeams: vi.fn(), setRule: vi.fn() },
  admin: { listAccounts: vi.fn(), setRoles: vi.fn(), setAccountClubs: vi.fn(), listInvites: vi.fn(), createInvite: vi.fn() }
}))
vi.mock('../../lib/accountApi', async (orig) => ({ ...(await orig()), clubsApi: api.clubs, admin: api.admin }))
const ui = vi.hoisted(() => ({ confirm: vi.fn(async () => true), toasts: [] }))
vi.mock('../../ui', async (orig) => {
  const real = await orig()
  return {
    ...real,
    confirmDialog: (...a) => ui.confirm(...a),
    toast: { ...real.toast, success: (m) => ui.toasts.push(['ok', m]), error: (m) => ui.toasts.push(['error', m]) }
  }
})

import ClubsPanel from '../manage/ClubsPanel'
import AccountsPanel from '../manage/AccountsPanel'
import InvitesPanel from '../manage/InvitesPanel'

const KSC = { id: 'c1', name: 'KSC Wiedikon', teams: ['KSC Wiedikon H1'], scorers: 2 }
const OTHER = { id: 'c2', name: 'VBC Other', teams: ['VBC Other H1'], scorers: 0 }

beforeEach(() => {
  vi.clearAllMocks()
  ui.toasts = []
  ui.confirm.mockResolvedValue(true)
  api.clubs.list.mockResolvedValue({ data: { clubs: [KSC, OTHER], rule: { enabled: false } }, error: null, status: 200 })
  api.clubs.vmTeams.mockResolvedValue({
    data: { teams: [{ name: 'KSC Wiedikon D2', club_id: null, club_name: null }, { name: 'KSC Wiedikon H1', club_id: 'c1', club_name: 'KSC Wiedikon' }, { name: 'VBC Other H1', club_id: 'c2', club_name: 'VBC Other' }] },
    error: null, status: 200
  })
})

describe('ClubsPanel', () => {
  it('lists the clubs with their teams; switching the rule on asks first', async () => {
    api.clubs.setRule.mockResolvedValue({ data: { rule: { enabled: true } }, error: null, status: 200 })
    render(<ClubsPanel />)
    expect(await screen.findByText('KSC Wiedikon')).toBeInTheDocument()
    expect(screen.getByText('KSC Wiedikon H1')).toBeInTheDocument()
    const sw = screen.getByTestId('club-rule-switch')
    expect(sw).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(sw)
    await waitFor(() => expect(api.clubs.setRule).toHaveBeenCalledWith(true))
    expect(ui.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'manage.clubs.ruleOnTitle', tone: 'danger' }))

    // declined: nothing changes
    api.clubs.setRule.mockClear()
    ui.confirm.mockResolvedValueOnce(false)
    fireEvent.click(sw)
    await waitFor(() => expect(ui.confirm).toHaveBeenCalledTimes(2))
    expect(api.clubs.setRule).not.toHaveBeenCalled()
  })

  it('a new club takes a name and VolleyManager teams; another club\'s team cannot be picked', async () => {
    api.clubs.create.mockResolvedValue({ data: { club: { id: 'c3' } }, error: null, status: 201 })
    render(<ClubsPanel />)
    await screen.findByText('KSC Wiedikon')
    fireEvent.click(screen.getByTestId('new-club'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getAllByRole('textbox')[0], { target: { value: 'KSC Wiedikon 2' } })
    const options = await within(dialog).findByTestId('club-team-options')
    await waitFor(() => expect(within(options).getAllByRole('checkbox').length).toBe(3))
    const [d2, h1] = within(options).getAllByRole('checkbox')
    expect(h1).toBeDisabled() // KSC Wiedikon H1 plays for KSC Wiedikon
    fireEvent.click(d2)
    fireEvent.click(within(dialog).getByTestId('save-club'))
    await waitFor(() => expect(api.clubs.create).toHaveBeenCalledWith({ name: 'KSC Wiedikon 2', teams: ['KSC Wiedikon D2'] }))
  })

  it('a team another club has: the server\'s answer is shown', async () => {
    api.clubs.update.mockResolvedValue({ data: null, error: { code: 'OV_TEAM_TAKEN', details: 'VBC Other H1: VBC Other', status: 409 }, status: 409 })
    render(<ClubsPanel />)
    await screen.findByText('KSC Wiedikon')
    fireEvent.click(within(screen.getByText('KSC Wiedikon').closest('.flex-wrap')).getByRole('button', { name: 'manage.clubs.edit' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByTestId('save-club'))
    expect(await within(dialog).findByText('manage.clubs.teamTaken')).toBeInTheDocument()
  })
})

describe('AccountsPanel: clubs', () => {
  it('shows an account\'s clubs and saves its whole list', async () => {
    api.admin.listAccounts.mockResolvedValue({ data: { accounts: [{ id: 'u1', email: 'ada@example.ch', first_name: 'Ada', last_name: 'Scorer', roles: ['scorer'], pending: false, clubs: [{ id: 'c2', name: 'VBC Other' }] }] }, error: null, status: 200 })
    api.admin.setAccountClubs.mockResolvedValue({ data: { clubs: [] }, error: null, status: 200 })
    render(<AccountsPanel selfId="me" app="indoor" />)
    fireEvent.click(await screen.findByRole('radio', { name: 'manage.accounts.filterAll' }))
    expect(await screen.findByText('VBC Other')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'manage.accounts.editClubs' }))
    const dialog = await screen.findByRole('dialog')
    const boxes = await within(dialog).findAllByRole('checkbox')
    expect(boxes.map((b) => b.checked)).toEqual([false, true])
    fireEvent.click(boxes[0])
    fireEvent.click(within(dialog).getByTestId('save-account-clubs'))
    await waitFor(() => expect(api.admin.setAccountClubs).toHaveBeenCalledWith('u1', ['c2', 'c1']))
  })

  it('OpenBeach\'s console has no clubs', async () => {
    api.admin.listAccounts.mockResolvedValue({ data: { accounts: [{ id: 'u1', email: 'b@example.ch', roles: ['beach:scorer'], pending: false, clubs: [] }] }, error: null, status: 200 })
    render(<AccountsPanel selfId="me" app="beach" />)
    await screen.findAllByText('b@example.ch')
    expect(screen.queryByRole('button', { name: 'manage.accounts.editClubs' })).toBeNull()
  })
})

describe('InvitesPanel: a code\'s club', () => {
  it('an indoor code can carry a club', async () => {
    api.admin.listInvites.mockResolvedValue({ data: { invites: [] }, error: null, status: 200 })
    api.admin.createInvite.mockResolvedValue({ data: { code: 'ABCD-EFGH-JKMN', invite: { label: 'KSC 2026', club: 'KSC Wiedikon', role: 'scorer' } }, error: null, status: 201 })
    render(<InvitesPanel app="indoor" />)
    fireEvent.click(await screen.findByRole('button', { name: /manage\.invites\.new/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getAllByRole('textbox')[0], { target: { value: 'KSC 2026' } })
    const club = await within(dialog).findByTestId('invite-club')
    fireEvent.change(club, { target: { value: 'c1' } })
    fireEvent.click(within(dialog).getByTestId('create-invite'))
    await waitFor(() => expect(api.admin.createInvite).toHaveBeenCalled())
    expect(api.admin.createInvite.mock.calls[0][0]).toMatchObject({ label: 'KSC 2026', club: null, club_id: 'c1', sport: 'indoor' })
  })
})
