import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

// db/018: the manager's clubs (admins), an account's clubs and an invite's club

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => (typeof opts === 'string' ? opts : key), i18n: { language: 'en' } })
}))

const api = vi.hoisted(() => ({
  clubs: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), vmTeams: vi.fn(), setRule: vi.fn() },
  admin: { listAccounts: vi.fn(), setRoles: vi.fn(), setAccountClubs: vi.fn(), listInvites: vi.fn(), createInvite: vi.fn(), releaseGame: vi.fn() }
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

const VBCM = { id: 'c1', name: 'VBC Musterdorf', teams: ['VBC Musterdorf H1'], scorers: 2 }
const OTHER = { id: 'c2', name: 'VBC Other', teams: ['VBC Other H1'], scorers: 0 }

beforeEach(() => {
  vi.clearAllMocks()
  ui.toasts = []
  ui.confirm.mockResolvedValue(true)
  api.clubs.list.mockResolvedValue({ data: { clubs: [VBCM, OTHER], rule: { enabled: false } }, error: null, status: 200 })
  api.clubs.vmTeams.mockResolvedValue({
    data: { teams: [{ name: 'VBC Musterdorf D2', club_id: null, club_name: null }, { name: 'VBC Musterdorf H1', club_id: 'c1', club_name: 'VBC Musterdorf' }, { name: 'VBC Other H1', club_id: 'c2', club_name: 'VBC Other' }] },
    error: null, status: 200
  })
})

describe('ClubsPanel', () => {
  it('lists the clubs with their teams; switching the rule on asks first', async () => {
    api.clubs.setRule.mockResolvedValue({ data: { rule: { enabled: true } }, error: null, status: 200 })
    render(<ClubsPanel />)
    expect(await screen.findByText('VBC Musterdorf')).toBeInTheDocument()
    expect(screen.getByText('VBC Musterdorf H1')).toBeInTheDocument()
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

  it('warns while the club rule is off', async () => {
    render(<ClubsPanel />)
    expect(await screen.findByTestId('club-rule-off-warning')).toHaveTextContent('manage.clubs.ruleOffWarning')
  })

  it('no warning while the rule is on', async () => {
    api.clubs.list.mockResolvedValue({ data: { clubs: [VBCM], rule: { enabled: true }, held_outside: [] }, error: null, status: 200 })
    render(<ClubsPanel />)
    await screen.findByText('VBC Musterdorf')
    expect(screen.queryByTestId('club-rule-off-warning')).toBeNull()
    expect(screen.queryByTestId('club-held-outside')).toBeNull()
  })

  it('lists the official games held outside their home club and releases one with a reason', async () => {
    const held = { match_id: 'm1', game_n: 960001, status: 'setup', home_team: 'VBC Musterdorf H1', club: 'VBC Musterdorf', scorer_name: 'Rolf Beispiel' }
    api.clubs.list.mockResolvedValue({ data: { clubs: [VBCM], rule: { enabled: true }, held_outside: [held] }, error: null, status: 200 })
    api.admin.releaseGame.mockResolvedValue({ data: { match: { id: 'm1', official_game_exempt: true } }, error: null, status: 200 })
    render(<ClubsPanel />)
    const list = await screen.findByTestId('club-held-outside')
    expect(within(list).getByText('manage.clubs.heldOutsideGame')).toBeInTheDocument()
    expect(within(list).getByText('Rolf Beispiel')).toBeInTheDocument()
    fireEvent.click(within(list).getByRole('button', { name: 'manage.games.releaseGame' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'held by another club' } })
    fireEvent.click(within(dialog).getByTestId('reason-confirm'))
    await waitFor(() => expect(api.admin.releaseGame).toHaveBeenCalledWith('m1', { reason: 'held by another club' }))
    await waitFor(() => expect(api.clubs.list).toHaveBeenCalledTimes(2))
  })

  it('a new club takes a name and VolleyManager teams; another club\'s team cannot be picked', async () => {
    api.clubs.create.mockResolvedValue({ data: { club: { id: 'c3' } }, error: null, status: 201 })
    render(<ClubsPanel />)
    await screen.findByText('VBC Musterdorf')
    fireEvent.click(screen.getByTestId('new-club'))
    // a page of its own now (#clubs/new), not a dialog
    const dialog = await screen.findByTestId('club-page')
    fireEvent.change(within(dialog).getAllByRole('textbox')[0], { target: { value: 'VBC Musterdorf 2' } })
    const options = await within(dialog).findByTestId('club-team-options')
    await waitFor(() => expect(within(options).getAllByRole('checkbox').length).toBe(3))
    const [d2, h1] = within(options).getAllByRole('checkbox')
    expect(h1).toBeDisabled() // VBC Musterdorf H1 plays for VBC Musterdorf
    fireEvent.click(d2)
    fireEvent.click(within(dialog).getByTestId('save-club'))
    await waitFor(() => expect(api.clubs.create).toHaveBeenCalledWith({ name: 'VBC Musterdorf 2', teams: ['VBC Musterdorf D2'] }))
  })

  it('a team another club has: the server\'s answer is shown', async () => {
    api.clubs.update.mockResolvedValue({ data: null, error: { code: 'OV_TEAM_TAKEN', details: 'VBC Other H1: VBC Other', status: 409 }, status: 409 })
    render(<ClubsPanel />)
    await screen.findByText('VBC Musterdorf')
    fireEvent.click(within(screen.getByText('VBC Musterdorf').closest('.flex-wrap')).getByRole('button', { name: 'manage.clubs.edit' }))
    const dialog = await screen.findByTestId('club-page')
    fireEvent.click(within(dialog).getByTestId('save-club'))
    expect(await within(dialog).findByText('manage.clubs.teamTaken')).toBeInTheDocument()
  })

  // owner 2026-11-10: "every page there gets their own page": #clubs/<club id>, #clubs/new
  it('a club is a page of its own: opened from the URL, back to the list, a new club lands on its page', async () => {
    api.clubs.create.mockResolvedValue({ data: { club: { id: 'c3', name: 'VBC Neu' } }, error: null, status: 201 })
    const onRoute = vi.fn()
    const { rerender } = render(<ClubsPanel route="c1" onRoute={onRoute} />)
    const page = await screen.findByTestId('club-page')
    expect(within(page).getByRole('heading', { name: 'VBC Musterdorf' })).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('club-page-back'))
    expect(onRoute).toHaveBeenLastCalledWith('', { push: true })
    rerender(<ClubsPanel route="new" onRoute={onRoute} />)
    fireEvent.change(within(await screen.findByTestId('club-page')).getAllByRole('textbox')[0], { target: { value: 'VBC Neu' } })
    fireEvent.click(screen.getByTestId('save-club'))
    await waitFor(() => expect(onRoute).toHaveBeenLastCalledWith('c3', { push: false }))
    rerender(<ClubsPanel route="gone" onRoute={onRoute} />)
    expect(await screen.findByTestId('page-missing')).toBeInTheDocument()
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
    api.admin.createInvite.mockResolvedValue({ data: { code: 'ABCD-EFGH-JKMN', invite: { label: 'VBCM 2026', club: 'VBC Musterdorf', role: 'scorer' } }, error: null, status: 201 })
    render(<InvitesPanel app="indoor" />)
    fireEvent.click(await screen.findByRole('button', { name: /manage\.invites\.new/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getAllByRole('textbox')[0], { target: { value: 'VBCM 2026' } })
    const club = await within(dialog).findByTestId('invite-club')
    fireEvent.change(club, { target: { value: 'c1' } })
    fireEvent.click(within(dialog).getByTestId('create-invite'))
    await waitFor(() => expect(api.admin.createInvite).toHaveBeenCalled())
    expect(api.admin.createInvite.mock.calls[0][0]).toMatchObject({ label: 'VBCM 2026', club: null, club_id: 'c1', sport: 'indoor' })
  })
})
