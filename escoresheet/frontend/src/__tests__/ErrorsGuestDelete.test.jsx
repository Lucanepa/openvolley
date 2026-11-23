// The Errors tab's "Delete guest errors…" (audit SEC-02, review ET-3):
// after a flood of junk reports without an account, the owner deletes the
// errors only guests reported from the list, after a confirmation, instead
// of through the SQL tab. The server is mocked (lib/accountApi); its rule
// (groups only reports without a session fed, not those marked important)
// is tested in the backend suite (errorTracker.quota.pg.test.js).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => (typeof opts === 'string' ? opts : opts && typeof opts === 'object' && 'count' in opts ? `${key}:${opts.count}:${opts.reports ?? ''}` : key),
    i18n: { language: 'en', changeLanguage: vi.fn() }
  })
}))

const ok = (data) => ({ data, error: null, status: 200 })
const admin = vi.hoisted(() => ({ listErrors: vi.fn(), deleteErrorEvents: vi.fn() }))
vi.mock('../lib/accountApi', async (orig) => ({ ...(await orig()), admin }))
const ui = vi.hoisted(() => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() }, confirmDialog: vi.fn() }))
vi.mock('../ui', async (orig) => ({ ...(await orig()), toast: ui.toast, confirmDialog: ui.confirmDialog }))

import ErrorsPanel from '../components/manage/ErrorsPanel'

beforeEach(() => {
  vi.clearAllMocks()
  admin.listErrors.mockResolvedValue(ok({ groups: [], counts: { open: 0, resolved: 0, muted: 0 } }))
  admin.deleteErrorEvents.mockResolvedValue(ok({ deleted: 7, groups: 3 }))
})

describe('Errors tab: delete the errors only guests reported', () => {
  it('asks first; on yes deletes them and loads the list again', async () => {
    ui.confirmDialog.mockResolvedValue(true)
    render(<ErrorsPanel route="" onRoute={() => {}} />)
    await waitFor(() => expect(admin.listErrors).toHaveBeenCalled())
    await screen.findByText('manage.errorsTab.empty.all')
    const loads = admin.listErrors.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'manage.errorsTab.deleteGuestEllipsis' }))
    await waitFor(() => expect(admin.deleteErrorEvents).toHaveBeenCalledWith({ anonymous: true }))
    expect(ui.confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'manage.errorsTab.deleteGuestTitle', tone: 'danger' }))
    await waitFor(() => expect(ui.toast.success).toHaveBeenCalledWith('manage.errorsTab.deletedGuest:3:7'))
    await waitFor(() => expect(admin.listErrors.mock.calls.length).toBeGreaterThan(loads))
  })

  it('on no deletes nothing', async () => {
    ui.confirmDialog.mockResolvedValue(false)
    render(<ErrorsPanel route="" onRoute={() => {}} />)
    await screen.findByText('manage.errorsTab.empty.all')
    fireEvent.click(screen.getByRole('button', { name: 'manage.errorsTab.deleteGuestEllipsis' }))
    await waitFor(() => expect(ui.confirmDialog).toHaveBeenCalled())
    expect(admin.deleteErrorEvents).not.toHaveBeenCalled()
  })
})
