import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

// The manager's Accounts tab: an admin changes an account's name and address
// (PATCH /api/admin/accounts/:id, owner 2026-11-11).

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => (typeof opts === 'string' ? opts : key), i18n: { language: 'en' } })
}))
const api = vi.hoisted(() => ({
  admin: { listAccounts: vi.fn(), setRoles: vi.fn(), updateAccount: vi.fn(), setAccountClubs: vi.fn(), deleteAccount: vi.fn(), rejectAccount: vi.fn() },
  clubs: { list: vi.fn() }
}))
vi.mock('../../lib/accountApi', async (orig) => ({ ...(await orig()), admin: api.admin, clubsApi: api.clubs }))
const ui = vi.hoisted(() => ({ toasts: [] }))
vi.mock('../../ui', async (orig) => {
  const real = await orig()
  return { ...real, toast: { ...real.toast, success: (m) => ui.toasts.push(['ok', m]), error: (m) => ui.toasts.push(['error', m]) } }
})

import AccountsPanel, { canEditDetails } from '../manage/AccountsPanel'

const SCORER = { id: 'u-sc', email: 'sam@club.ch', first_name: 'Sam', last_name: 'Scorer', roles: ['scorer'], pending: false, clubs: [] }
const BOSS = { id: 'u-boss', email: 'boss@club.ch', first_name: 'Bo', last_name: 'Boss', roles: ['super_admin'], pending: false, clubs: [] }
const list = (accounts, extra = { can_delete: true, can_edit: true }) => ({ data: { accounts, ...extra }, error: null, status: 200 })

beforeEach(() => {
  vi.clearAllMocks()
  ui.toasts = []
  api.admin.listAccounts.mockResolvedValue(list([SCORER, BOSS]))
  api.clubs.list.mockResolvedValue({ data: { clubs: [] }, error: null, status: 200 })
})

describe('canEditDetails', () => {
  it('a super admin\'s only by a super admin', () => {
    expect(canEditDetails(SCORER)).toBe(true)
    expect(canEditDetails(BOSS)).toBe(false)
    expect(canEditDetails(BOSS, true)).toBe(true)
    expect(canEditDetails(null)).toBe(false)
  })
})

describe('AccountsPanel: Name and email', () => {
  it('an older backend (no can_edit in the list): no Name and email', async () => {
    api.admin.listAccounts.mockResolvedValue(list([SCORER], { can_delete: true }))
    render(<AccountsPanel selfId="u-self" app="indoor" />)
    await screen.findByTestId('account-u-sc')
    expect(screen.queryByTestId('edit-details')).toBeNull()
  })

  it('sends only the fields changed, then reloads', async () => {
    api.admin.updateAccount.mockResolvedValue({ data: { id: 'u-sc' }, error: null, status: 200 })
    render(<AccountsPanel selfId="u-self" app="indoor" />)
    const row = await screen.findByTestId('account-u-sc')
    // no Name and email on a super admin's row for an admin
    expect(within(screen.getByTestId('account-u-boss')).queryByTestId('edit-details')).toBeNull()
    fireEvent.click(within(row).getByTestId('edit-details'))
    const save = screen.getByTestId('save-account-details')
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByTestId('account-first-name'), { target: { value: ' Samuel ' } })
    fireEvent.change(screen.getByTestId('account-email'), { target: { value: 'samuel@club.ch' } })
    fireEvent.click(save)
    await waitFor(() => expect(api.admin.updateAccount).toHaveBeenCalledWith('u-sc', { first_name: 'Samuel', email: 'samuel@club.ch' }))
    await waitFor(() => expect(ui.toasts).toContainEqual(['ok', 'manage.accounts.saved']))
    expect(api.admin.listAccounts.mock.calls.length).toBeGreaterThan(1)
  })

  it('an address another account has: says so, stays open', async () => {
    api.admin.updateAccount.mockResolvedValue({ data: null, error: { code: 'OV_EMAIL_TAKEN', status: 409 }, status: 409 })
    render(<AccountsPanel selfId="u-self" app="indoor" />)
    fireEvent.click(within(await screen.findByTestId('account-u-sc')).getByTestId('edit-details'))
    fireEvent.change(screen.getByTestId('account-email'), { target: { value: 'boss@club.ch' } })
    fireEvent.click(screen.getByTestId('save-account-details'))
    expect(await screen.findByText('manage.accounts.emailTaken')).toBeTruthy()
    expect(screen.getByTestId('save-account-details')).toBeTruthy()
  })

  it('a broken address cannot be saved', async () => {
    render(<AccountsPanel selfId="u-self" app="indoor" />)
    fireEvent.click(within(await screen.findByTestId('account-u-sc')).getByTestId('edit-details'))
    fireEvent.change(screen.getByTestId('account-email'), { target: { value: 'nope' } })
    expect(screen.getByTestId('save-account-details').disabled).toBe(true)
  })
})

// owner 23.11.2026: "like here: name, email, licence" (db/048 profiles.license_number)
describe('AccountsPanel: the licence number', () => {
  const LICENSED = { ...SCORER, license_number: '1234567' }
  const NEW = { can_delete: true, can_edit: true, can_edit_licence: true }

  it('on the account page with the email; on the row; "–" when the account has none', async () => {
    api.admin.listAccounts.mockResolvedValue(list([LICENSED, { ...BOSS, license_number: null }], NEW))
    const { unmount } = render(<AccountsPanel selfId="u-self" app="indoor" route="u-sc" onRoute={() => {}} />)
    const facts = await screen.findByTestId('account-facts')
    expect(within(facts).getByText('manage.accounts.page.licence')).toBeTruthy()
    expect(within(facts).getByTestId('account-page-licence')).toHaveTextContent('1234567')
    expect(within(facts).getByTestId('edit-details')).toHaveTextContent('manage.accounts.editDetailsLicence')
    unmount()
    render(<AccountsPanel selfId="u-self" app="indoor" route="u-boss" onRoute={() => {}} selfIsSuperAdmin />)
    expect(await screen.findByTestId('account-page-licence')).toHaveTextContent('–')
  })

  it('an older backend (no license_number, no can_edit_licence): no licence line, no field, the old label', async () => {
    api.admin.listAccounts.mockResolvedValue(list([SCORER]))
    render(<AccountsPanel selfId="u-self" app="indoor" route="u-sc" onRoute={() => {}} />)
    const facts = await screen.findByTestId('account-facts')
    expect(within(facts).queryByTestId('account-page-licence')).toBeNull()
    fireEvent.click(within(facts).getByTestId('edit-details'))
    expect(within(facts).getByTestId('edit-details')).toHaveTextContent('manage.accounts.editDetails')
    expect(screen.queryByTestId('account-licence')).toBeNull()
  })

  it('Name, email and licence: digits only, a bad one is refused, a new one sent alone, empty removes it', async () => {
    api.admin.listAccounts.mockResolvedValue(list([LICENSED], NEW))
    api.admin.updateAccount.mockResolvedValue({ data: { id: 'u-sc' }, error: null, status: 200 })
    render(<AccountsPanel selfId="u-self" app="indoor" />)
    const row = await screen.findByTestId('account-u-sc')
    expect(within(row).getByTestId('account-row-licence')).toHaveTextContent('manage.accounts.licenceMeta')
    fireEvent.click(within(row).getByTestId('edit-details'))
    const field = screen.getByTestId('account-licence')
    expect(field).toHaveValue('1234567')
    fireEvent.change(field, { target: { value: '12' } })
    fireEvent.click(screen.getByTestId('save-account-details'))
    expect(await screen.findByText('auth.licenceNumberInvalid')).toBeTruthy()
    expect(api.admin.updateAccount).not.toHaveBeenCalled()
    fireEvent.change(field, { target: { value: 'SV 765-4321' } })
    expect(field).toHaveValue('7654321')
    fireEvent.click(screen.getByTestId('save-account-details'))
    await waitFor(() => expect(api.admin.updateAccount).toHaveBeenCalledWith('u-sc', { license_number: '7654321' }))

    api.admin.updateAccount.mockClear()
    fireEvent.click(within(await screen.findByTestId('account-u-sc')).getByTestId('edit-details'))
    fireEvent.change(screen.getByTestId('account-licence'), { target: { value: '' } })
    fireEvent.click(screen.getByTestId('save-account-details'))
    await waitFor(() => expect(api.admin.updateAccount).toHaveBeenCalledWith('u-sc', { license_number: null }))
  })
})

describe('requestedClubs: a sign-up request\'s clubs, shown in amber until approved', () => {
  it('the clubs of the request the account is not a member of, once each', async () => {
    const { requestedClubs } = await import('../manage/AccountsPanel')
    const a = {
      clubs: [{ id: 'c2', name: 'VBC Two' }],
      requests: [
        { id: 'r1', kind: 'scorer', club_id: 'c1', club_name: 'VBC One' },
        { id: 'r2', kind: 'team_manager', club_id: 'c1', club_name: 'VBC One', team_id: 't1', team_name: 'VBC One H2' },
        { id: 'r3', kind: 'scorer', club_id: 'c2', club_name: 'VBC Two' },
        { id: 'r4', kind: 'referee' }
      ]
    }
    expect(requestedClubs(a)).toEqual([{ id: 'c1', name: 'VBC One' }])
    expect(requestedClubs({})).toEqual([])
  })
})
