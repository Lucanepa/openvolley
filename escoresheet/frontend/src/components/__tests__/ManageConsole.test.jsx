import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => (typeof opts === 'string' ? opts : key), i18n: { language: 'en' } })
}))

const auth = vi.hoisted(() => ({ value: null }))
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth.value }))

const api = vi.hoisted(() => ({
  admin: {
    listAccounts: vi.fn(async () => ({ data: { accounts: [] }, error: null, status: 200 })),
    setRoles: vi.fn(),
    listInvites: vi.fn(async () => ({ data: { invites: [] }, error: null, status: 200 })),
    createInvite: vi.fn(),
    revokeInvite: vi.fn(),
    listOfficialGames: vi.fn(async () => ({ data: { games: [] }, error: null, status: 200 })),
    listMatches: vi.fn(async () => ({ data: { matches: [] }, error: null, status: 200 })),
    reopenMatch: vi.fn(),
    addMatchEditor: vi.fn(),
    releaseGame: vi.fn(),
    listAudit: vi.fn(async () => ({ data: { entries: [], next_before: null }, error: null, status: 200 }))
  },
  savedTeamsApi: { fetchBundle: vi.fn(async () => ({ data: { version: '0', competitions: [], teams: [] }, error: null, status: 200 })) }
}))
vi.mock('../../lib/accountApi', async (orig) => ({ ...(await orig()), admin: api.admin, savedTeamsApi: api.savedTeamsApi }))
vi.mock('../../db/savedTeams', () => ({ storeSavedTeamsBundle: vi.fn(async () => []) }))
vi.mock('../../lib/apiClient', () => ({
  apiFrom: () => {
    const b = { select: () => b, in: () => b, limit: () => b, then: (r) => Promise.resolve({ data: [], error: null }).then(r) }
    return b
  },
  apiRequest: vi.fn()
}))

import ManageConsole, { manageTabsFor } from '../manage/ManageConsole'
import InvitesPanel from '../manage/InvitesPanel'
import { accessFromRoles } from '../../lib/access'

const asUser = (roles) => { auth.value = { user: { id: 'u-1', email: 'a@b.ch' }, access: { ...accessFromRoles(roles), known: true } } }

describe('ManageConsole', () => {
  beforeEach(() => vi.clearAllMocks())

  it('an admin sees six tabs, a competition manager only saved teams, others none', () => {
    expect(manageTabsFor(accessFromRoles(['admin']))).toEqual(['accounts', 'invites', 'games', 'matches', 'audit', 'teams'])
    expect(manageTabsFor(accessFromRoles(['competition_manager']))).toEqual(['teams'])
    expect(manageTabsFor(accessFromRoles(['scorer']))).toEqual([])
  })

  it('renders the tabs in the nav for an admin', async () => {
    asUser(['admin'])
    render(<ManageConsole tab="accounts" onTab={() => {}} onClose={() => {}} />)
    const nav = screen.getAllByRole('navigation')[0]
    expect(within(nav).getAllByRole('button')).toHaveLength(6)
    await waitFor(() => expect(api.admin.listAccounts).toHaveBeenCalled())
  })

  it('a competition manager lands on saved teams whatever tab was asked', async () => {
    asUser(['competition_manager'])
    render(<ManageConsole tab="accounts" onTab={() => {}} onClose={() => {}} />)
    const nav = screen.getAllByRole('navigation')[0]
    expect(within(nav).getAllByRole('button').map(b => b.textContent)).toEqual(['manage.tabs.teams'])
    await waitFor(() => expect(api.savedTeamsApi.fetchBundle).toHaveBeenCalled())
    expect(api.admin.listAccounts).not.toHaveBeenCalled()
  })

  it('without a role it shows the forbidden note and a way back', () => {
    asUser(['scorer'])
    const onClose = vi.fn()
    render(<ManageConsole tab="accounts" onTab={() => {}} onClose={onClose} />)
    expect(screen.getByText('manage.errors.forbidden')).toBeInTheDocument()
    fireEvent.click(screen.getByText('manage.backToApp'))
    expect(onClose).toHaveBeenCalled()
  })
})

describe('InvitesPanel', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows a new invite code once, and never again after closing', async () => {
    asUser(['admin'])
    api.admin.createInvite.mockResolvedValue({
      data: { code: 'ABCD-EFGH-JKMN', invite: { id: 'i1', label: 'VBC 26/27', club: null, role: 'scorer', code_hint: 'JKMN', state: 'active', uses: 0, max_uses: 1 } },
      error: null,
      status: 201
    })
    render(<InvitesPanel />)
    fireEvent.click(await screen.findByText('manage.invites.new'))
    fireEvent.change(screen.getByLabelText('manage.invites.label'), { target: { value: 'VBC 26/27' } })
    fireEvent.click(screen.getByTestId('create-invite'))
    expect(await screen.findByTestId('invite-code')).toHaveTextContent('ABCD-EFGH-JKMN')
    expect(api.admin.createInvite).toHaveBeenCalledWith(expect.objectContaining({ label: 'VBC 26/27', role: 'scorer', max_uses: 1 }))
    // Close: the plaintext code is gone from the page
    const closeButtons = screen.getAllByText('Close')
    fireEvent.click(closeButtons[closeButtons.length - 1])
    await waitFor(() => expect(screen.queryByTestId('invite-code')).toBeNull())
    expect(document.body.textContent).not.toContain('ABCD-EFGH-JKMN')
  })
})
