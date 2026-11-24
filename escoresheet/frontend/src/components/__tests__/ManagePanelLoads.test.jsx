import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, renderHook, screen, waitFor } from '@testing-library/react'

// Owner 2026-11-11: the manager console "doesn't look loaded together";
// #accounts showed "No accounts found." first, then the accounts. A read
// belongs to its deps (another filter is loading, not the last one's list or
// the empty state), and a panel draws error, then skeleton, then empty, then
// the list.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => (typeof opts === 'string' ? opts : key), i18n: { language: 'en' } })
}))
const api = vi.hoisted(() => ({
  clubs: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), vmTeams: vi.fn(), setRule: vi.fn() },
  admin: { listAccounts: vi.fn(), setRoles: vi.fn() }
}))
vi.mock('../../lib/accountApi', async (orig) => ({ ...(await orig()), clubsApi: api.clubs, admin: api.admin }))

import { usePanelData, PageLoadGate } from '../manage/common'
import ClubsPanel from '../manage/ClubsPanel'
import AccountsPanel from '../manage/AccountsPanel'

const deferred = () => {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}
const ok = (data) => ({ data, error: null, status: 200 })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('usePanelData: the data belongs to its deps', () => {
  it('new deps: loading, no data (the old one as stale) until the new answer', async () => {
    const reads = { a: deferred(), b: deferred() }
    const { result, rerender } = renderHook(({ k }) => usePanelData(() => reads[k].promise, [k]), { initialProps: { k: 'a' } })
    expect(result.current).toMatchObject({ data: null, loading: true })
    await act(async () => { reads.a.resolve(ok('A')) })
    expect(result.current).toMatchObject({ data: 'A', loading: false, stale: null })
    rerender({ k: 'b' })
    // the same render: not A drawn under b, and not "nothing found" either
    expect(result.current).toMatchObject({ data: null, loading: true, stale: 'A' })
    await act(async () => { reads.b.resolve(ok('B')) })
    expect(result.current).toMatchObject({ data: 'B', loading: false, stale: null })
  })

  it('a slow answer of the old deps is dropped', async () => {
    const reads = { a: deferred(), b: deferred() }
    const { result, rerender } = renderHook(({ k }) => usePanelData(() => reads[k].promise, [k]), { initialProps: { k: 'a' } })
    rerender({ k: 'b' })
    await act(async () => { reads.b.resolve(ok('B')) })
    await act(async () => { reads.a.resolve(ok('A')) })
    expect(result.current.data).toBe('B')
  })

  it('a failed reload keeps the same deps\' data; a quiet one shows no loading', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(ok('A')).mockResolvedValueOnce({ data: null, error: { code: 'X' } })
    const { result } = renderHook(() => usePanelData(fetcher, ['a']))
    await waitFor(() => expect(result.current.data).toBe('A'))
    await act(async () => { await result.current.reload() })
    expect(result.current).toMatchObject({ data: 'A', error: { code: 'X' }, loading: false })
  })
})

describe('PageLoadGate: the page appears whole', () => {
  function Part({ read, label }) {
    const { data } = usePanelData(() => read.promise, [])
    return <p>{data ? label : `${label}…`}</p>
  }
  it('hidden with the fallback until every first read answered', async () => {
    const one = deferred()
    const two = deferred()
    render(
      <PageLoadGate fallback={<p>skeleton</p>}>
        <Part read={one} label="one" />
        <Part read={two} label="two" />
      </PageLoadGate>
    )
    expect(screen.getByText('skeleton')).toBeInTheDocument()
    expect(screen.getByText('one…').closest('[data-loading]')).not.toBeNull()
    await act(async () => { one.resolve(ok(1)) })
    expect(screen.getByText('skeleton')).toBeInTheDocument()
    await act(async () => { two.resolve(ok(2)) })
    await waitFor(() => expect(screen.queryByText('skeleton')).toBeNull())
    expect(screen.getByText('one').closest('[data-loading]')).toBeNull()
    expect(screen.getByText('two')).toBeInTheDocument()
  })
})

describe('a panel draws error, then skeleton, then empty, then the list', () => {
  it('loading: the skeleton, not the empty state', async () => {
    const read = deferred()
    api.clubs.list.mockReturnValue(read.promise)
    render(<ClubsPanel />)
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.queryByText('manage.clubs.empty')).toBeNull()
    await act(async () => { read.resolve(ok({ clubs: [], rule: { enabled: false } })) })
    expect(await screen.findByText('manage.clubs.empty')).toBeInTheDocument()
  })

  it('failed: the error alone, not the empty state under it', async () => {
    api.clubs.list.mockResolvedValue({ data: null, error: { status: 500, code: 'OV_SERVER' }, status: 500 })
    render(<ClubsPanel />)
    await waitFor(() => expect(api.clubs.list).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    expect(screen.queryByText('manage.clubs.empty')).toBeNull()
  })

  it('Accounts, Pending to All: never "No accounts found." before the accounts', async () => {
    const all = deferred()
    const ANNA = { id: 'u1', email: 'anna@example.ch', first_name: 'Anna', last_name: 'Muster', roles: ['scorer'], pending: false, created_at: '2026-10-01T10:00:00Z' }
    api.admin.listAccounts.mockImplementation(({ filter }) => (filter === 'all' ? all.promise : Promise.resolve(ok({ accounts: [] }))))
    render(<AccountsPanel selfId="me" />)
    expect(await screen.findByText('manage.accounts.emptyPending')).toBeInTheDocument()
    act(() => { screen.getByRole('radio', { name: 'manage.accounts.filterAll' }).click() })
    expect(screen.queryByText('manage.accounts.empty')).toBeNull()
    expect(screen.queryByText('manage.accounts.emptyPending')).toBeNull()
    expect(screen.getByRole('status')).toBeInTheDocument()
    await act(async () => { all.resolve(ok({ accounts: [ANNA] })) })
    expect(await screen.findByTestId('account-u1')).toBeInTheDocument()
  })
})
