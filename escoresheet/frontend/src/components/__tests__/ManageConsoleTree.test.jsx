import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'

// My club is a tree in the console's menu (owner 2026-11-15)
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => (typeof opts === 'string' ? opts : key), i18n: { language: 'en' } })
}))
const auth = vi.hoisted(() => ({ value: null }))
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth.value }))
vi.mock('../../lib/apiClient', () => ({
  apiFrom: () => { const b = { select: () => b, in: () => b, limit: () => b, then: (r) => Promise.resolve({ data: [], error: null }).then(r) }; return b },
  apiRequest: vi.fn(async () => ({ data: {}, error: null, status: 200 }))
}))
vi.mock('../manage/MyClubPanel', () => ({ default: ({ route }) => <div data-testid="my-club-panel">{route}</div> }))
vi.mock('../manage/NotificationsBell', () => ({ default: ({ onOpen }) => <button data-testid="bell" onClick={() => onOpen('myclub/c1')}>bell</button> }))

import ManageConsole from '../manage/ManageConsole'
import { accessFromRoles } from '../../lib/access'

const asManager = () => { auth.value = { user: { id: 'u-1', email: 'a@b.ch' }, access: { ...accessFromRoles([]), managedClubs: [{ id: 'c1', name: 'VBC' }], known: true } } }
const rail = () => screen.getAllByRole('navigation')[0]

describe('My club in the menu', () => {
  beforeEach(() => { vi.clearAllMocks(); asManager() })

  it('has one page per part under My club', () => {
    render(<ManageConsole tab="myclub/c1" onTab={() => {}} onClose={() => {}} />)
    const group = screen.getAllByRole('group', { name: 'manage.tabs.myclub' })[0]
    expect(within(group).getAllByRole('button').map((b) => b.textContent))
      .toEqual(['requests', 'members', 'teams', 'licences', 'invites', 'api'].map((p) => `manage.myClub.nav.${p}`))
  })

  it('a part opens the club\'s page of that part; the open part is marked', () => {
    const onTab = vi.fn()
    const { rerender } = render(<ManageConsole tab="myclub/c1" onTab={onTab} onClose={() => {}} />)
    fireEvent.click(within(rail()).getByRole('button', { name: 'manage.myClub.nav.api' }))
    expect(onTab).toHaveBeenLastCalledWith('myclub/c1/api')
    rerender(<ManageConsole tab="myclub/c1/api" onTab={onTab} onClose={() => {}} />)
    expect(within(rail()).getByRole('button', { name: 'manage.myClub.nav.api' }).getAttribute('aria-current')).toBe('page')
    // a person of the licence lists belongs to Licences
    rerender(<ManageConsole tab="myclub/c1/person/r-1" onTab={onTab} onClose={() => {}} />)
    expect(within(rail()).getByRole('button', { name: 'manage.myClub.nav.licences' }).getAttribute('aria-current')).toBe('page')
  })

  it('My club\'s own button returns to the club\'s first page, from any part', () => {
    const onTab = vi.fn()
    render(<ManageConsole tab="myclub/c1/members" onTab={onTab} onClose={() => {}} />)
    fireEvent.click(within(rail()).getByRole('button', { name: /manage.tabs.myclub/ }))
    expect(onTab).toHaveBeenLastCalledWith('myclub/c1')
  })

  it('a notice about a club opens that club\'s Requests', () => {
    const onTab = vi.fn()
    render(<ManageConsole tab="myclub/c1" onTab={onTab} onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('bell'))
    expect(onTab).toHaveBeenLastCalledWith('myclub/c1/requests', { push: true })
  })
})
