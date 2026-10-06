import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) })
}))
const auth = vi.hoisted(() => ({ value: null }))
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth.value }))
vi.mock('../auth/ProfileModal', () => ({ default: () => null }))
vi.mock('../auth/MatchHistory', () => ({ default: () => null }))
vi.mock('../auth/RedeemInviteModal', () => ({ default: ({ open }) => (open ? <div data-testid="redeem-modal" /> : null) }))

import UserButton from '../auth/UserButton'
import { accessFromRoles } from '../../lib/access'

const asUser = (roles, known = true) => {
  auth.value = { user: { id: 'u1', email: 'a@b.ch' }, profile: { first_name: 'Anna' }, loading: false, signOut: vi.fn(), access: { ...accessFromRoles(roles), known } }
}

describe('UserButton access rows', () => {
  it('an admin gets Admin and Saved teams; Admin opens the console', () => {
    asUser(['admin'])
    const seen = []
    const on = (e) => seen.push(e.detail)
    window.addEventListener('ov-open-manage', on)
    render(<UserButton inline />)
    expect(screen.getByText('manage.menuSavedTeams')).toBeInTheDocument()
    fireEvent.click(screen.getByText('manage.menuAdmin'))
    window.removeEventListener('ov-open-manage', on)
    expect(seen).toEqual([{ tab: 'accounts' }])
    expect(screen.queryByText('manage.menuInviteCode')).toBeNull()
    expect(screen.getByText('access.roles.admin')).toBeInTheDocument()
  })

  it('a pending account gets the amber chip and "Enter invite code"', () => {
    asUser([])
    render(<UserButton inline />)
    expect(screen.getByText('access.roles.pending')).toBeInTheDocument()
    expect(screen.queryByText('manage.menuAdmin')).toBeNull()
    fireEvent.click(screen.getByText('manage.menuInviteCode'))
    expect(screen.getByTestId('redeem-modal')).toBeInTheDocument()
  })

  it('a scorer sees the scorer chip and no manage rows', () => {
    asUser(['scorer'])
    render(<UserButton inline />)
    expect(screen.getByText('access.roles.scorer')).toBeInTheDocument()
    expect(screen.queryByText('manage.menuAdmin')).toBeNull()
    expect(screen.queryByText('manage.menuSavedTeams')).toBeNull()
    expect(screen.queryByText('manage.menuInviteCode')).toBeNull()
  })

  it('a referee or competition manager without the scorer role can enter an invite code too', () => {
    for (const roles of [['referee'], ['competition_manager']]) {
      asUser(roles)
      const { unmount } = render(<UserButton inline />)
      expect(screen.queryByText('access.roles.pending')).toBeNull()
      expect(screen.getByText('manage.menuInviteCode')).toBeInTheDocument()
      unmount()
    }
  })

  it('while a match is open the console rows are hidden (the console never opens over a match)', () => {
    asUser(['admin', 'competition_manager'])
    render(<UserButton inline inMatch />)
    expect(screen.queryByText('manage.menuAdmin')).toBeNull()
    expect(screen.queryByText('manage.menuSavedTeams')).toBeNull()
  })

  it('before the profile is known it shows no pending state', () => {
    asUser([], false)
    render(<UserButton inline />)
    expect(screen.queryByText('access.roles.pending')).toBeNull()
    expect(screen.queryByText('manage.menuInviteCode')).toBeNull()
  })
})
