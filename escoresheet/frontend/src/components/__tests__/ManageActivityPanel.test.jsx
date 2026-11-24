import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

// The manager's Activity tab (fe-manage-4): "Delete activity…" deletes what
// the list shows, its confirm names the search that was run (not what the
// fields hold now), and an export carries no email address unless asked.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // the key, with the {{match}} / {{email}} / {{what}} / {{count}} it was given
    t: (key, opts) => {
      if (typeof opts === 'string') return opts
      const vars = ['what', 'match', 'email', 'count'].filter(k => opts?.[k] !== undefined).map(k => `${k}=${opts[k]}`)
      return vars.length ? `${key}|${vars.join('|')}` : key
    },
    i18n: { language: 'en' }
  })
}))

const api = vi.hoisted(() => ({
  admin: { listActivity: vi.fn(), listAccounts: vi.fn(), deleteActivity: vi.fn(), exportActivity: vi.fn() }
}))
vi.mock('../../lib/accountApi', async (orig) => ({ ...(await orig()), admin: api.admin }))
const ui = vi.hoisted(() => ({ confirm: vi.fn(async () => true), toasts: [] }))
vi.mock('../../ui', async (orig) => {
  const real = await orig()
  return {
    ...real,
    confirmDialog: (...a) => ui.confirm(...a),
    toast: { ...real.toast, success: (m) => ui.toasts.push(['ok', m]), error: (m) => ui.toasts.push(['error', m]), info: (m) => ui.toasts.push(['info', m]) }
  }
})

import ActivityPanel from '../manage/ActivityPanel'

const A = { id: '11111111-2222-4333-8444-555555555555', email: 'anna@example.ch' }
const B = { id: '66666666-2222-4333-8444-555555555555', email: 'ben@example.ch' }
const ok = (data) => ({ data, error: null, status: 200 })
const row = { id: 1, uid: 'u-1', client_ts: '2026-11-13T10:00:00.000Z', kind: 'event.add', level: 'info', game_n: 4711, match_external_id: 'match_1_a', data: {} }

const field = (key) => screen.getByLabelText(key)
const type = (key, value) => fireEvent.change(field(key), { target: { value } })
const searchNow = () => fireEvent.click(screen.getByRole('button', { name: /manage\.activity\.search/ }))
const deleteNow = () => fireEvent.click(screen.getByRole('button', { name: /manage\.activity\.deleteEllipsis/ }))

beforeEach(() => {
  vi.clearAllMocks()
  ui.toasts = []
  ui.confirm.mockResolvedValue(true)
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true })
  api.admin.listActivity.mockResolvedValue(ok({ entries: [row], next: null }))
  api.admin.listAccounts.mockImplementation(async ({ q }) => ok({ accounts: [A, B].filter(a => a.email === q) }))
  api.admin.deleteActivity.mockResolvedValue(ok({ deleted: 3 }))
  api.admin.exportActivity.mockResolvedValue({ blob: new Blob(['x']), filename: 'a.csv', error: null })
})
afterEach(() => cleanup())

describe('Activity tab: delete on request', () => {
  it('the confirm names the account that was searched, not an address typed since; that account is deleted', async () => {
    render(<ActivityPanel app="indoor" />)
    await waitFor(() => expect(api.admin.listActivity).toHaveBeenCalledTimes(1))
    type('manage.activity.account', A.email)
    searchNow()
    await waitFor(() => expect(api.admin.listActivity).toHaveBeenCalledTimes(2))
    expect(api.admin.listActivity.mock.calls[1][0]).toMatchObject({ account: A.id })
    // another address typed, Search not pressed
    type('manage.activity.account', B.email)
    deleteNow()
    await waitFor(() => expect(ui.confirm).toHaveBeenCalledTimes(1))
    const message = ui.confirm.mock.calls[0][0].message
    expect(message).toContain(A.email)
    expect(message).not.toContain(B.email)
    await waitFor(() => expect(api.admin.deleteActivity).toHaveBeenCalledTimes(1))
    expect(api.admin.deleteActivity.mock.calls[0][0]).toMatchObject({ account: A.id })
  })

  it('a game number is deleted as the list found it, with the other filters of the search', async () => {
    render(<ActivityPanel app="indoor" />)
    await waitFor(() => expect(api.admin.listActivity).toHaveBeenCalledTimes(1))
    type('manage.activity.match', '4711')
    type('manage.activity.account', A.email)
    searchNow()
    await waitFor(() => expect(api.admin.listActivity).toHaveBeenCalledTimes(2))
    deleteNow()
    await waitFor(() => expect(api.admin.deleteActivity).toHaveBeenCalledTimes(1))
    // the match AND the account, as the list showed them (not the whole match)
    expect(api.admin.deleteActivity.mock.calls[0][0]).toMatchObject({ match: '4711', account: A.id, app: 'indoor' })
    const message = ui.confirm.mock.calls[0][0].message
    expect(message).toContain('4711')
    expect(message).toContain(A.email)
    await waitFor(() => expect(ui.toasts).toEqual([['ok', 'manage.activity.deleted|count=3']]))
  })

  it('nothing deleted: a notice, not a success', async () => {
    api.admin.deleteActivity.mockResolvedValue(ok({ deleted: 0 }))
    render(<ActivityPanel app="indoor" initialMatch="4711" />)
    await waitFor(() => expect(api.admin.listActivity).toHaveBeenCalled())
    await screen.findByText(/#4711/)
    deleteNow()
    await waitFor(() => expect(ui.toasts.length).toBe(1))
    expect(ui.toasts[0][0]).toBe('info')
    expect(ui.toasts[0][1]).toBe('manage.activity.deletedNone')
  })
})

describe('Activity tab: export', () => {
  it('no email address unless the box is ticked', async () => {
    render(<ActivityPanel app="indoor" initialMatch="4711" />)
    await screen.findByText(/#4711/)
    fireEvent.click(screen.getByRole('button', { name: /manage\.activity\.exportCsv/ }))
    await waitFor(() => expect(api.admin.exportActivity).toHaveBeenCalledTimes(1))
    expect(api.admin.exportActivity.mock.calls[0][0]).toMatchObject({ match: '4711', format: 'csv', emails: false })
    fireEvent.click(screen.getByLabelText('manage.activity.exportEmails'))
    fireEvent.click(screen.getByRole('button', { name: /manage\.activity\.exportNdjson/ }))
    await waitFor(() => expect(api.admin.exportActivity).toHaveBeenCalledTimes(2))
    expect(api.admin.exportActivity.mock.calls[1][0]).toMatchObject({ match: '4711', format: 'ndjson', emails: true })
  })
})
