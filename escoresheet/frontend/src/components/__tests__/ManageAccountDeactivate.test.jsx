import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

// The manager's account page: an admin deactivates an account without
// deleting it, and reactivates it (owner 2026-11-11).

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => (typeof opts === 'string' ? opts : key), i18n: { language: 'en' } })
}))
const api = vi.hoisted(() => ({
  admin: { listAccounts: vi.fn(), setRoles: vi.fn(), updateAccount: vi.fn(), setAccountClubs: vi.fn(), deleteAccount: vi.fn(), rejectAccount: vi.fn(), deactivateAccount: vi.fn(), reactivateAccount: vi.fn() },
  clubs: { list: vi.fn() }
}))
vi.mock('../../lib/accountApi', async (orig) => ({ ...(await orig()), admin: api.admin, clubsApi: api.clubs }))
const ui = vi.hoisted(() => ({ toasts: [], confirm: true }))
vi.mock('../../ui', async (orig) => {
  const real = await orig()
  return {
    ...real,
    confirmDialog: async () => ui.confirm,
    toast: { ...real.toast, success: (m) => ui.toasts.push(['ok', m]), error: (m) => ui.toasts.push(['error', m]) }
  }
})

import AccountsPanel, { mayDeactivate } from '../manage/AccountsPanel'

const SCORER = { id: 'u-sc', email: 'sam@club.ch', first_name: 'Sam', last_name: 'Scorer', roles: ['scorer'], pending: false, clubs: [], deactivated: false }
const OFF = { ...SCORER, deactivated: true }
const BOSS = { id: 'u-boss', email: 'boss@club.ch', first_name: 'Bo', last_name: 'Boss', roles: ['super_admin'], pending: false, clubs: [] }
const list = (accounts, extra = { can_delete: true, can_edit: true, can_deactivate: true }) => ({ data: { accounts, ...extra }, error: null, status: 200 })
const page = (id) => render(<AccountsPanel selfId="u-self" app="indoor" route={id} onRoute={() => {}} />)

beforeEach(() => {
  vi.clearAllMocks()
  ui.toasts = []
  ui.confirm = true
  api.admin.listAccounts.mockResolvedValue(list([SCORER, BOSS]))
  api.clubs.list.mockResolvedValue({ data: { clubs: [] }, error: null, status: 200 })
})

describe('mayDeactivate', () => {
  it('never the own account; a super admin only as one', () => {
    expect(mayDeactivate(SCORER, 'u-self')).toBe(true)
    expect(mayDeactivate(SCORER, 'u-sc')).toBe(false)
    expect(mayDeactivate(BOSS, 'u-self')).toBe(false)
    expect(mayDeactivate(BOSS, 'u-self', true)).toBe(true)
    expect(mayDeactivate(null, 'u-self')).toBe(false)
  })
})

describe('AccountsPanel: Deactivate', () => {
  it('an older backend (no can_deactivate): no button', async () => {
    api.admin.listAccounts.mockResolvedValue(list([SCORER], { can_delete: true, can_edit: true }))
    page('u-sc')
    await screen.findByTestId('account-page')
    expect(screen.queryByTestId('deactivate-account')).toBeNull()
  })

  it('asks, deactivates, says so and reloads; nothing is deleted', async () => {
    api.admin.deactivateAccount.mockResolvedValue({ data: { id: 'u-sc', deactivated: true, changed: true }, error: null, status: 200 })
    page('u-sc')
    fireEvent.click(await screen.findByTestId('deactivate-account'))
    await waitFor(() => expect(api.admin.deactivateAccount).toHaveBeenCalledWith('u-sc'))
    await waitFor(() => expect(ui.toasts).toContainEqual(['ok', 'manage.accounts.deactivated']))
    expect(api.admin.deleteAccount).not.toHaveBeenCalled()
    expect(api.admin.listAccounts.mock.calls.length).toBeGreaterThan(2)
  })

  it('cancelled: nothing is sent', async () => {
    ui.confirm = false
    page('u-sc')
    fireEvent.click(await screen.findByTestId('deactivate-account'))
    await waitFor(() => expect(screen.getByTestId('deactivate-account')).toBeTruthy())
    expect(api.admin.deactivateAccount).not.toHaveBeenCalled()
  })

  it('a deactivated account: says so, the row has a chip, Reactivate without asking', async () => {
    api.admin.listAccounts.mockResolvedValue(list([OFF]))
    api.admin.reactivateAccount.mockResolvedValue({ data: { id: 'u-sc', deactivated: false, changed: true }, error: null, status: 200 })
    const { unmount } = render(<AccountsPanel selfId="u-self" app="indoor" />)
    expect(within(await screen.findByTestId('account-u-sc')).getByText('manage.accounts.deactivatedChip')).toBeTruthy()
    unmount()
    page('u-sc')
    expect(await screen.findByTestId('account-deactivated')).toBeTruthy()
    expect(screen.queryByTestId('deactivate-account')).toBeNull()
    fireEvent.click(screen.getByTestId('reactivate-account'))
    await waitFor(() => expect(api.admin.reactivateAccount).toHaveBeenCalledWith('u-sc'))
    await waitFor(() => expect(ui.toasts).toContainEqual(['ok', 'manage.accounts.reactivated']))
  })

  it('a super admin\'s page for an admin: no button', async () => {
    page('u-boss')
    await screen.findByTestId('account-page')
    expect(screen.queryByTestId('deactivate-account')).toBeNull()
  })
})
