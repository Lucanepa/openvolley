import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) })
}))
vi.mock('../../i18n', () => ({ default: { language: 'en', changeLanguage: () => {} } }))
vi.mock('../../db/db', () => ({ db: {} }))
vi.mock('../../hooks/useSyncQueue', () => ({ useSyncQueueStats: () => ({ pending: 0, error: 0, failed: 0 }) }))
vi.mock('../../hooks/useScaledLayout', () => ({
  useScaledLayout: () => ({ scaleFactor: 1, userScaleOverride: null, setUserScaleOverride: () => {} })
}))
vi.mock('../ConnectionStatus', () => ({ default: () => null }))
vi.mock('../TabletStatusIndicator', () => ({ default: () => null }))

const auth = vi.hoisted(() => ({ value: { user: null, profile: null, loading: false, signOut: async () => {} } }))
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth.value }))
vi.mock('../auth/LoginModal', () => ({ default: ({ open }) => (open ? <div role="dialog">login-modal</div> : null) }))
vi.mock('../auth/SignUpModal', () => ({ default: () => null }))
vi.mock('../auth/ProfileModal', () => ({ default: ({ open }) => (open ? <div role="dialog">profile-modal</div> : null) }))
vi.mock('../connect/ConnectTabletsModal', () => ({
  default: ({ match }) => <div role="dialog">connect-tablets {match?.seed_key || 'no match'}</div>
}))
vi.mock('../auth/MatchHistory', () => ({ default: ({ open }) => (open ? <div role="dialog">history-modal</div> : null) }))

import MainHeader from '../MainHeader'
import UserButton from '../auth/UserButton'
import MenuList from '../MenuList'

const baseProps = {
  connectionStatuses: {},
  connectionDebugInfo: {},
  showMatchSetup: false,
  matchId: null,
  isFullscreen: false,
  toggleFullscreen: () => {},
  offlineMode: false,
  setOfflineMode: () => {},
  currentPage: 'home'
}

const menuButton = () => screen.getByRole('button', { name: 'Menu' })
const menuIsOpen = () => menuButton().getAttribute('aria-expanded') === 'true'

describe('scorer header menu', () => {
  beforeEach(() => {
    window.innerWidth = 1280
    window.innerHeight = 800
    auth.value = { user: null, profile: null, loading: false, signOut: async () => {} }
  })

  it('closes on Escape', () => {
    render(<MainHeader {...baseProps} />)
    fireEvent.click(menuButton())
    expect(menuIsOpen()).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(menuIsOpen()).toBe(false)
  })

  it('closes on a press outside, not on a press inside', () => {
    render(<div><p>page</p><MainHeader {...baseProps} /></div>)
    fireEvent.click(menuButton())
    fireEvent.pointerDown(screen.getByText('Language'))
    expect(menuIsOpen()).toBe(true)
    fireEvent.pointerDown(screen.getByText('page'))
    expect(menuIsOpen()).toBe(false)
  })

  it('closes when the screen changes (new match, setup)', () => {
    const { rerender } = render(<MainHeader {...baseProps} />)
    fireEvent.click(menuButton())
    expect(menuIsOpen()).toBe(true)
    rerender(<MainHeader {...baseProps} matchId={7} showMatchSetup currentPage="setup" />)
    expect(menuIsOpen()).toBe(false)
  })

  it('opens Connect tablets for the current match, also without a local server', () => {
    render(<MainHeader {...baseProps} currentMatch={{ id: 7, seed_key: 'match_1_abc' }} />)
    fireEvent.click(menuButton())
    fireEvent.click(screen.getByTestId('header-connect-tablets'))
    expect(menuIsOpen()).toBe(false)
    expect(screen.getByText('connect-tablets match_1_abc')).toBeInTheDocument()
  })

  it('closes when Login is chosen and the login dialog stays up', () => {
    render(<MainHeader {...baseProps} />)
    fireEvent.click(menuButton())
    fireEvent.click(screen.getByRole('button', { name: /Login/ }))
    expect(menuIsOpen()).toBe(false)
    expect(screen.getByText('login-modal')).toBeInTheDocument()
  })
})

describe('account rows in the menu', () => {
  beforeEach(() => {
    auth.value = {
      user: { id: 'u1', email: 'scorer@example.org' },
      profile: { first_name: 'Eva', last_name: 'Amstutz' },
      loading: false,
      signOut: vi.fn(async () => {})
    }
  })

  it('renders Profile / My matches / Sign out inline (no clipped dropdown)', () => {
    render(<UserButton inline />)
    expect(screen.getByText('Eva Amstutz')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Profile/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /My matches/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Sign out/ })).toBeInTheDocument()
  })

  it('a row tells the menu to close and opens its dialog outside the menu', () => {
    const onAction = vi.fn()
    const { container } = render(<UserButton inline onAction={onAction} />)
    fireEvent.click(screen.getByRole('button', { name: /My matches/ }))
    expect(onAction).toHaveBeenCalledTimes(1)
    const dialog = screen.getByText('history-modal')
    expect(container.contains(dialog)).toBe(false)
  })

  it('sign out closes the menu and signs out', async () => {
    const onAction = vi.fn()
    render(<UserButton inline onAction={onAction} />)
    fireEvent.click(screen.getByRole('button', { name: /Sign out/ }))
    expect(onAction).toHaveBeenCalled()
    expect(auth.value.signOut).toHaveBeenCalled()
  })
})

describe('scoreboard toolbar menu (MenuList)', () => {
  it('closes on Escape', () => {
    render(<MenuList buttonLabel="Tools" items={[{ label: 'Rosters', onClick: () => {} }]} />)
    fireEvent.click(screen.getByRole('button', { name: /Tools/ }))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
