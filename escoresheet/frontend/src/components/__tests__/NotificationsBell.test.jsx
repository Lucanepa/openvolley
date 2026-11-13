import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => (opts && typeof opts === 'object' ? `${key}:${opts.name ?? opts.count ?? ''}` : key),
    i18n: { language: 'en' }
  })
}))

const api = vi.hoisted(() => ({
  list: vi.fn(),
  markRead: vi.fn(async () => ({ data: { unread: 0 }, error: null, status: 200 }))
}))
vi.mock('../../lib/accountApi', () => ({ notificationsApi: api }))

import NotificationsBell from '../manage/NotificationsBell'

const notice = (over = {}) => ({
  id: 'n-1',
  kind: 'signup',
  created_at: '2026-11-11T10:00:00Z',
  read: false,
  target: 'accounts/u-9',
  user: { id: 'u-9', email: 'nora@example.ch', name: 'Nora Neu' },
  parts: [{ kind: 'scorer', club: 'VBC Musterdorf', team: null }, { kind: 'team_manager', club: 'VBC Musterdorf', team: 'VBC Musterdorf H1' }],
  open: true,
  ...over
})

describe('NotificationsBell', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.list.mockResolvedValue({
      data: { notifications: [notice(), notice({ id: 'n-2', read: true, target: 'accounts/u-8', user: { id: 'u-8', email: 'old@example.ch', name: null }, parts: [], open: false })], unread: 1 },
      error: null,
      status: 200
    })
  })

  it('shows the unread count, lists the notices of its app, and opens a notice\'s page marking it read', async () => {
    const onOpen = vi.fn()
    render(<NotificationsBell app="indoor" onOpen={onOpen} />)
    expect(await screen.findByTestId('notifications-unread')).toHaveTextContent('1')
    expect(api.list).toHaveBeenCalledWith('indoor')
    fireEvent.click(screen.getByTestId('notifications-bell'))
    const list = await screen.findByTestId('notifications-list')
    const items = within(list).getAllByRole('button')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('manage.notifications.signupTitle:Nora Neu')
    expect(items[0]).toHaveTextContent('access.requests.kinds.scorer · VBC Musterdorf, access.requests.kinds.team_manager · VBC Musterdorf H1')
    expect(items[0]).toHaveTextContent('manage.notifications.stillOpen')
    // no role asked for: no open / decided state
    expect(items[1]).toHaveTextContent('manage.notifications.signupTitle:old@example.ch')
    expect(items[1]).toHaveTextContent('manage.notifications.noRole')
    expect(items[1]).not.toHaveTextContent('manage.notifications.decided')
    fireEvent.click(items[0])
    expect(onOpen).toHaveBeenCalledWith('accounts/u-9')
    expect(api.markRead).toHaveBeenCalledWith('indoor', { ids: ['n-1'] })
    await waitFor(() => expect(screen.queryByTestId('notifications-unread')).toBeNull())
  })

  it('a team manager\'s proposal (db/036): its own title, opens My club', async () => {
    api.list.mockResolvedValue({
      data: { notifications: [notice({ kind: 'team_manager_proposal', target: 'myclub/c-1', parts: [{ kind: 'team_manager', club: 'VBC Musterdorf', team: 'VBC Musterdorf H1' }] })], unread: 1 },
      error: null,
      status: 200
    })
    const onOpen = vi.fn()
    render(<NotificationsBell app="indoor" onOpen={onOpen} />)
    fireEvent.click(await screen.findByTestId('notifications-bell'))
    const [item] = within(await screen.findByTestId('notifications-list')).getAllByRole('button')
    expect(item).toHaveTextContent('manage.notifications.proposalTitle:Nora Neu')
    expect(item).not.toHaveTextContent('signupTitle')
    fireEvent.click(item)
    expect(onOpen).toHaveBeenCalledWith('myclub/c-1')
  })

  it('a read notice opens without another read; Mark all read clears the count', async () => {
    const onOpen = vi.fn()
    render(<NotificationsBell app="beach" onOpen={onOpen} />)
    await screen.findByTestId('notifications-unread')
    fireEvent.click(screen.getByTestId('notifications-bell'))
    fireEvent.click(await screen.findByText('manage.notifications.markAllRead'))
    expect(api.markRead).toHaveBeenCalledWith('beach', { all: true })
    expect(screen.queryByTestId('notifications-unread')).toBeNull()
    fireEvent.click(within(screen.getByTestId('notifications-list')).getAllByRole('button')[1])
    expect(onOpen).toHaveBeenCalledWith('accounts/u-8')
    expect(api.markRead).toHaveBeenCalledTimes(1)
  })

  it('no button on a server without notices (404)', async () => {
    api.list.mockResolvedValue({ data: null, error: { code: 'OV_NOT_FOUND' }, status: 404 })
    render(<NotificationsBell app="indoor" />)
    await waitFor(() => expect(screen.queryByTestId('notifications-bell')).toBeNull())
  })
})
