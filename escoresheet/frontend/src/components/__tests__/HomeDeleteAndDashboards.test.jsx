import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'

// Owner 2026-11-10: Delete match right under Continue match, in its card;
// Home's menu opens this phone or tablet as the referee or bench dashboard,
// and that dashboard goes back to the scorer.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key), i18n: { language: 'en' } })
}))
vi.mock('../../i18n', () => ({ default: { language: 'en', changeLanguage: () => {} } }))
vi.mock('../SupportFeedbackModal', () => ({ default: () => null }))
vi.mock('../auth/PendingApprovalBanner', () => ({ default: () => null }))
vi.mock('../auth/LoginModal', () => ({ default: () => null }))
vi.mock('../../db/db', () => ({ db: {} }))
vi.mock('../../hooks/useSyncQueue', () => ({ useSyncQueueStats: () => ({ pending: 0, error: 0, failed: 0 }) }))
vi.mock('../../hooks/useScaledLayout', () => ({
  useScaledLayout: () => ({ scaleFactor: 1, userScaleOverride: null, setUserScaleOverride: () => {} })
}))
vi.mock('../../hooks/useServiceWorker', () => ({ clearCachesAndReload: async () => true }))
vi.mock('../ConnectionStatus', () => ({ default: () => null }))
vi.mock('../TabletStatusIndicator', () => ({ default: () => null }))
vi.mock('../auth/UserButton', () => ({ default: () => null }))
vi.mock('../connect/ConnectTabletsModal', () => ({ default: () => null }))

const dash = vi.hoisted(() => ({ offer: true, open: vi.fn() }))
vi.mock('../../utils/scorerDashboards', () => ({
  canOfferDashboards: () => dash.offer,
  openScorerDashboard: (role) => dash.open(role)
}))
const back = vi.hoisted(() => ({ url: null, go: vi.fn() }))
vi.mock('../../utils/scorerReturn', () => ({
  scorerReturnUrl: () => back.url,
  returnToScorer: () => back.go()
}))

import HomePage from '../pages/HomePage'
import MainHeader from '../MainHeader'
import DashboardHeader from '../DashboardHeader'

const noop = () => {}
const home = (props) => render(
  <HomePage createNewTestMatch={noop} createEasyMatch={noop} onOfficialGame={noop} onOpenSettings={noop} onRestoreMatch={noop} {...props} />
)

describe('Home: Delete match under Continue match', () => {
  it('sits in the Continue card, right after Continue, Restore stays outside it', () => {
    const showDeleteMatchModal = vi.fn()
    home({ currentOfficialMatch: { id: 7 }, continueMatch: noop, showDeleteMatchModal, restartTestMatch: noop })
    const card = screen.getByTestId('continue-card')
    const buttons = within(card).getAllByRole('button').map((b) => b.textContent)
    expect(buttons).toEqual(['home.continueMatch', 'home.deleteMatch'])
    expect(within(card).queryByText('home.restoreMatch')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'home.deleteMatch' })).toHaveLength(1)
    fireEvent.click(screen.getByTestId('home-delete-match'))
    expect(showDeleteMatchModal).toHaveBeenCalledTimes(1)
    // the help's "Show me" still finds it
    expect(screen.getByTestId('home-delete-match').getAttribute('data-help-id')).toBe('home-delete-button')
  })

  it('a test match: the same button restarts (deletes) the test match', () => {
    const restartTestMatch = vi.fn()
    home({ currentTestMatch: { id: 3, test: true }, continueTestMatch: noop, showDeleteMatchModal: noop, restartTestMatch })
    fireEvent.click(within(screen.getByTestId('continue-card')).getByRole('button', { name: 'home.deleteMatch' }))
    expect(restartTestMatch).toHaveBeenCalledTimes(1)
  })

  it('no saved match: no Continue card, no Delete', () => {
    home({})
    expect(screen.queryByTestId('continue-card')).toBeNull()
    expect(screen.queryByRole('button', { name: 'home.deleteMatch' })).toBeNull()
    expect(screen.getByRole('button', { name: 'home.restoreMatch' })).toBeInTheDocument()
  })
})

const headerProps = {
  connectionStatuses: {},
  connectionDebugInfo: {},
  showMatchSetup: false,
  matchId: null,
  isFullscreen: false,
  toggleFullscreen: () => {},
  offlineMode: true,
  setOfflineMode: () => {}
}

describe('Home menu: referee and bench dashboards', () => {
  beforeEach(() => {
    dash.offer = true
    dash.open.mockClear()
  })
  afterEach(() => {
    window.innerWidth = 1024
  })

  for (const width of [390, 820, 1280]) {
    it(`on a phone or tablet, at ${width} px: both rows, each opens its dashboard`, () => {
      window.innerWidth = width
      render(<MainHeader {...headerProps} />)
      const menu = screen.queryByRole('button', { name: 'Menu' }) || screen.getByRole('button', { name: /header\.fullscreen|Fullscreen/ })
      fireEvent.click(menu)
      fireEvent.click(screen.getByTestId('header-referee-dashboard'))
      expect(dash.open).toHaveBeenLastCalledWith('referee')
      fireEvent.click(menu)
      fireEvent.click(screen.getByTestId('header-bench-dashboard'))
      expect(dash.open).toHaveBeenLastCalledWith('bench')
    })
  }

  it('not on a computer', () => {
    dash.offer = false
    window.innerWidth = 1280
    render(<MainHeader {...headerProps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
    expect(screen.queryByTestId('header-referee-dashboard')).toBeNull()
    expect(screen.queryByTestId('header-bench-dashboard')).toBeNull()
  })

  it('not during a match (Home only)', () => {
    window.innerWidth = 1280
    render(<MainHeader {...headerProps} matchId={7} onOpenSetup={noop} />)
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
    expect(screen.queryByTestId('header-referee-dashboard')).toBeNull()
  })
})

describe('the dashboard opened from the scorer goes back', () => {
  beforeEach(() => {
    back.go.mockClear()
  })

  it('a Scorer button in the bar and a row in the menu', () => {
    back.url = '/'
    render(<DashboardHeader title="Referee" />)
    fireEvent.click(screen.getByTestId('dashboard-scorer-button'))
    expect(back.go).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'header.menu' }))
    fireEvent.click(screen.getByTestId('dashboard-back-to-scorer'))
    expect(back.go).toHaveBeenCalledTimes(2)
  })

  it('in a bench match (its own Back): the menu row only', () => {
    back.url = '/'
    render(<DashboardHeader title="Bench" onBack={noop} />)
    expect(screen.queryByTestId('dashboard-scorer-button')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'header.menu' }))
    expect(screen.getByTestId('dashboard-back-to-scorer')).toBeInTheDocument()
  })

  it('opened any other way: nothing', () => {
    back.url = null
    render(<DashboardHeader title="Referee" />)
    expect(screen.queryByTestId('dashboard-scorer-button')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'header.menu' }))
    expect(screen.queryByTestId('dashboard-back-to-scorer')).toBeNull()
  })
})
