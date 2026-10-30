import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

// The manager's Accounts tab: Reject a sign-up, Delete an account
// (POST /api/admin/accounts/:id/reject|delete), and what the lists show once
// an account is gone.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // the key, with the {{name}} / {{email}} it was given (so a test can see which account a text is about)
    t: (key, opts) => (typeof opts === 'string' ? opts : opts?.name ? `${key}|${opts.name}` : opts?.email ? `${key}|${opts.email}` : key),
    i18n: { language: 'en' }
  })
}))

const api = vi.hoisted(() => ({
  admin: { listAccounts: vi.fn(), setRoles: vi.fn(), setAccountClubs: vi.fn(), deleteAccount: vi.fn(), rejectAccount: vi.fn(), listMatches: vi.fn() },
  clubs: { list: vi.fn() }
}))
vi.mock('../../lib/accountApi', async (orig) => ({ ...(await orig()), admin: api.admin, clubsApi: api.clubs }))
const ui = vi.hoisted(() => ({ confirm: vi.fn(async () => true), toasts: [] }))
vi.mock('../../ui', async (orig) => {
  const real = await orig()
  return {
    ...real,
    confirmDialog: (...a) => ui.confirm(...a),
    toast: { ...real.toast, success: (m) => ui.toasts.push(['ok', m]), error: (m) => ui.toasts.push(['error', m]), info: (m) => ui.toasts.push(['info', m]) }
  }
})

import AccountsPanel, { deletion } from '../manage/AccountsPanel'
import ClosedMatchesPanel from '../manage/ClosedMatchesPanel'
import { auditDetailsLine } from '../manage/AuditPanel'
import { errorKeyOf } from '../../lib/accountApi'

const SELF = { id: 'u-self', email: 'me@club.ch', first_name: 'Ada', last_name: 'Admin', roles: ['admin'], pending: false, clubs: [] }
const NEWBIE = { id: 'u-new', email: 'new@club.ch', first_name: 'Pat', last_name: 'Pending', roles: [], pending: true, clubs: [] }
const SCORER = { id: 'u-sc', email: 'Sam@Club.ch', first_name: 'Sam', last_name: 'Scorer', roles: ['scorer'], pending: false, clubs: [] }
const BOSS = { id: 'u-boss', email: 'boss@club.ch', first_name: 'Bo', last_name: 'Boss', roles: ['super_admin'], pending: false, clubs: [] }
const ALL = [SELF, NEWBIE, SCORER, BOSS]

const list = (accounts, extra = { can_delete: true }) => ({ data: { accounts, ...extra }, error: null, status: 200 })
const ROW_OF = { 'Ada Admin': SELF, 'Pat Pending': NEWBIE, 'Sam Scorer': SCORER, 'Bo Boss': BOSS }
const rowOf = (name) => screen.getByTestId(`account-${ROW_OF[name].id}`)

beforeEach(() => {
  vi.clearAllMocks()
  ui.toasts = []
  ui.confirm.mockResolvedValue(true)
  api.admin.listAccounts.mockResolvedValue(list(ALL))
  api.clubs.list.mockResolvedValue({ data: { clubs: [] }, error: null, status: 200 })
})

describe('deletion(): what a row offers', () => {
  it('reject for a sign-up without any role, delete for the others, nothing on the own row or a super admin\'s (unless super admin)', () => {
    expect(deletion(NEWBIE, 'u-self')).toBe('reject')
    expect(deletion(SCORER, 'u-self')).toBe('delete')
    // a beach-only account is "pending" in OpenVolley's list, but has a role: delete, not reject
    expect(deletion({ id: 'b', roles: ['beach:scorer'], pending: true }, 'u-self')).toBe('delete')
    expect(deletion(SELF, 'u-self')).toBe(null)
    expect(deletion({ ...NEWBIE, id: 'u-self' }, 'u-self')).toBe(null)
    expect(deletion(BOSS, 'u-self')).toBe(null)
    expect(deletion(BOSS, 'u-self', true)).toBe('delete')
    expect(deletion(null, 'u-self')).toBe(null)
  })
})

describe('AccountsPanel: Reject and Delete account', () => {
  it('an older backend (no can_delete in the list): no Reject, no Delete account', async () => {
    api.admin.listAccounts.mockResolvedValue(list(ALL, {}))
    render(<AccountsPanel selfId="u-self" app="indoor" />)
    await screen.findByText('Sam Scorer')
    expect(screen.queryByTestId('reject-account')).toBeNull()
    expect(screen.queryByTestId('delete-account')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'manage.accounts.approve' }).length).toBe(1)
  })

  it('Reject sits next to Approve on a sign-up; Delete account on the others; none on the own row or a super admin\'s', async () => {
    render(<AccountsPanel selfId="u-self" app="indoor" />)
    await screen.findByText('Sam Scorer')
    expect(screen.getAllByTestId('reject-account')).toHaveLength(1)
    expect(screen.getAllByTestId('delete-account')).toHaveLength(1)
    const newbie = rowOf('Pat Pending')
    expect(within(newbie).getByRole('button', { name: 'manage.accounts.approve' })).toBeInTheDocument()
    expect(within(newbie).getByRole('button', { name: 'manage.accounts.reject' })).toBeInTheDocument()
    expect(within(rowOf('Sam Scorer')).getByRole('button', { name: 'manage.accounts.delete' })).toHaveClass('text-red-700')
    expect(within(rowOf('Ada Admin')).queryByTestId('delete-account')).toBeNull()
    expect(within(rowOf('Bo Boss')).queryByTestId('delete-account')).toBeNull()
  })

  it('a super admin also gets Delete account on another super admin\'s row', async () => {
    render(<AccountsPanel selfId="u-self" selfIsSuperAdmin app="indoor" />)
    await screen.findByText('Bo Boss')
    expect(within(rowOf('Bo Boss')).getByTestId('delete-account')).toBeInTheDocument()
  })

  it('Reject asks first (two steps), then rejects with the account\'s address and reloads', async () => {
    api.admin.rejectAccount.mockResolvedValue({ data: { id: 'u-new', deleted: true, rejected: true }, error: null, status: 200 })
    render(<AccountsPanel selfId="u-self" app="indoor" />)
    await screen.findByText('Pat Pending')
    // declined: nothing happens
    ui.confirm.mockResolvedValueOnce(false)
    fireEvent.click(screen.getByTestId('reject-account'))
    await waitFor(() => expect(ui.confirm).toHaveBeenCalledTimes(1))
    expect(api.admin.rejectAccount).not.toHaveBeenCalled()
    expect(ui.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'manage.accounts.rejectTitle|Pat Pending', message: 'manage.accounts.rejectBody|new@club.ch', tone: 'danger' }))
    const loads = api.admin.listAccounts.mock.calls.length
    fireEvent.click(screen.getByTestId('reject-account'))
    await waitFor(() => expect(api.admin.rejectAccount).toHaveBeenCalledWith('u-new', { email: 'new@club.ch' }))
    await waitFor(() => expect(ui.toasts).toContainEqual(['ok', 'manage.accounts.rejected']))
    await waitFor(() => expect(api.admin.listAccounts.mock.calls.length).toBeGreaterThan(loads))
  })

  it('a refused reject shows the server\'s reason on the row', async () => {
    api.admin.rejectAccount.mockResolvedValue({ data: null, error: { code: 'OV_NOT_PENDING', status: 409 }, status: 409 })
    render(<AccountsPanel selfId="u-self" app="indoor" />)
    await screen.findByText('Pat Pending')
    fireEvent.click(screen.getByTestId('reject-account'))
    expect(await within(rowOf('Pat Pending')).findByText('manage.accounts.notPending')).toBeInTheDocument()
  })

  it('Delete account: the dialog names the account, says what goes and stays, and deletes only once the address is typed', async () => {
    api.admin.deleteAccount.mockResolvedValue({ data: { id: 'u-sc', deleted: true }, error: null, status: 200 })
    render(<AccountsPanel selfId="u-self" app="indoor" />)
    await screen.findByText('Sam Scorer')
    fireEvent.click(screen.getByTestId('delete-account'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('manage.accounts.deleteTitle|Sam Scorer')).toBeInTheDocument()
    expect(within(dialog).getByText('manage.accounts.deleteWhatGoes')).toBeInTheDocument()
    expect(within(dialog).getByText('manage.accounts.deleteWhatStays')).toBeInTheDocument()
    const confirm = within(dialog).getByTestId('confirm-delete-account')
    expect(confirm).toBeDisabled()
    const field = within(dialog).getByTestId('delete-account-email')
    fireEvent.change(field, { target: { value: 'sam@club' } })
    expect(confirm).toBeDisabled()
    fireEvent.click(confirm)
    expect(api.admin.deleteAccount).not.toHaveBeenCalled()
    // the address in any case, with spaces around it
    fireEvent.change(field, { target: { value: '  sam@club.CH ' } })
    expect(confirm).not.toBeDisabled()
    fireEvent.click(confirm)
    await waitFor(() => expect(api.admin.deleteAccount).toHaveBeenCalledWith('u-sc', { email: 'sam@club.CH' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(ui.toasts).toContainEqual(['ok', 'manage.accounts.deleted|Sam Scorer'])
  })

  it('a refusal stays in the dialog with its reason; an older backend says it cannot delete yet', async () => {
    api.admin.deleteAccount.mockResolvedValueOnce({ data: null, error: { code: 'OV_LAST_SUPER_ADMIN', status: 409 }, status: 409 })
    api.admin.deleteAccount.mockResolvedValueOnce({ data: null, error: { code: 'OV_NOT_FOUND', status: 404 }, status: 404 })
    render(<AccountsPanel selfId="u-self" app="indoor" />)
    await screen.findByText('Sam Scorer')
    fireEvent.click(screen.getByTestId('delete-account'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByTestId('delete-account-email'), { target: { value: 'sam@club.ch' } })
    fireEvent.click(within(dialog).getByTestId('confirm-delete-account'))
    expect(await within(dialog).findByText('manage.accounts.lastSuperAdmin')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByTestId('confirm-delete-account'))
    expect(await within(dialog).findByText('manage.accounts.deleteUnavailable')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('an account deleted meanwhile: the dialog closes and the list reloads', async () => {
    api.admin.deleteAccount.mockResolvedValue({ data: null, error: { code: 'OV_ACCOUNT_NOT_FOUND', status: 404 }, status: 404 })
    render(<AccountsPanel selfId="u-self" app="indoor" />)
    await screen.findByText('Sam Scorer')
    const loads = api.admin.listAccounts.mock.calls.length
    fireEvent.click(screen.getByTestId('delete-account'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByTestId('delete-account-email'), { target: { value: 'sam@club.ch' } })
    fireEvent.click(within(dialog).getByTestId('confirm-delete-account'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(ui.toasts).toContainEqual(['info', 'manage.accounts.alreadyDeleted'])
    await waitFor(() => expect(api.admin.listAccounts.mock.calls.length).toBeGreaterThan(loads))
  })

  it('the error codes of the endpoint have their texts', () => {
    expect(errorKeyOf({ code: 'OV_SELF_DELETE' })).toBe('manage.accounts.selfDelete')
    expect(errorKeyOf({ code: 'OV_LAST_SUPER_ADMIN' })).toBe('manage.accounts.lastSuperAdmin')
    expect(errorKeyOf({ code: 'OV_NOT_PENDING' })).toBe('manage.accounts.notPending')
    expect(errorKeyOf({ code: 'OV_CONFIRM_MISMATCH' })).toBe('manage.accounts.confirmMismatch')
  })
})

describe('after an account is deleted', () => {
  it('the closed matches name the scorer from the scoresheet', async () => {
    api.admin.listMatches.mockResolvedValue({
      data: { matches: [{ id: 'm1', home_name: 'H', away_name: 'A', status: 'final', closed_at: '2026-10-30T10:00:00Z', scorer_name: null, scorer_email: null, sheet_scorer_name: 'Lea Leaver', approvals: [] }] },
      error: null,
      status: 200
    })
    render(<ClosedMatchesPanel />)
    expect(await screen.findByText('manage.games.scoredBy|Lea Leaver')).toBeInTheDocument()
  })

  it('the Audit log line of a deletion: roles, the matches kept, a short id, never an address', () => {
    const entry = { action: 'account.delete', details: { account_id: '6f1c2a9b-0000-4000-8000-000000000001', email_sha256: 'ab'.repeat(32), roles: ['scorer', 'referee'], apps: ['indoor'], matches_kept: 3 } }
    const t = (key, o) => (o?.count != null ? `${key}:${o.count}` : key)
    expect(auditDetailsLine(entry, { t })).toBe('scorer, referee · manage.audit.matchesKept:3 · ID 6f1c2a9b')
    expect(auditDetailsLine({ action: 'account.reject', details: { account_id: '1234567890ab', roles: [], matches_kept: 0 } }, { t })).toBe('manage.audit.noRole · ID 12345678')
    // OpenBeach's console names the roles plainly
    expect(auditDetailsLine({ action: 'account.delete', details: { roles: ['beach:scorer'] } }, { t, roleLabel: (r) => r.replace('beach:', '') })).toBe('scorer')
  })
})
