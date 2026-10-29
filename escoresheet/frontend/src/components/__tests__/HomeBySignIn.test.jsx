import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

// The home screen follows the sign-in (owner plan 2026-10-29, step 3), and
// Official game signed in lists today's home games of the account's clubs

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key), i18n: { language: 'en' } })
}))
vi.mock('../SupportFeedbackModal', () => ({ default: () => null }))
vi.mock('../auth/PendingApprovalBanner', () => ({ default: () => null }))
vi.mock('../auth/LoginModal', () => ({ default: ({ open }) => (open ? <div role="dialog" data-testid="login-modal" /> : null) }))
vi.mock('../../utils/backendConfig', async (orig) => ({ ...(await orig()), isServedFromLocalServer: () => true }))
const api = vi.hoisted(() => ({ fetchTodayGames: vi.fn() }))
vi.mock('../../lib/accountApi', async (orig) => ({ ...(await orig()), fetchTodayGames: (...a) => api.fetchTodayGames(...a) }))

import HomePage from '../pages/HomePage'
import TodayGamesModal, { readCachedTodayGames } from '../TodayGamesModal'

const noop = () => {}
const home = (props) => render(
  <HomePage createNewTestMatch={noop} createEasyMatch={noop} onOfficialGame={noop} onOpenSettings={noop} onRestoreMatch={noop} {...props} />
)
const btn = (name) => screen.queryByRole('button', { name })

describe('Home by sign-in', () => {
  it('signed out where sign-in exists: Test and Easy only, and a way to sign in', () => {
    home({ signInAvailable: true, signedIn: false })
    expect(btn('home.officialMatch')).toBeNull()
    expect(btn('home.testMatch')).toBeInTheDocument()
    expect(btn('Easy match')).toBeInTheDocument()
    expect(btn('home.restoreMatch')).toBeInTheDocument() // a broken device's match comes back signed out too
    fireEvent.click(screen.getByTestId('home-sign-in'))
    expect(screen.getByTestId('login-modal')).toBeInTheDocument()
  })

  it('signed in: Official game first, Test and Easy below', () => {
    const onOfficialGame = vi.fn()
    home({ signInAvailable: true, signedIn: true, onOfficialGame })
    fireEvent.click(btn('home.officialMatch'))
    expect(onOfficialGame).toHaveBeenCalled()
    expect(btn('home.testMatch')).toBeInTheDocument()
    expect(screen.queryByTestId('home-sign-in-note')).toBeNull()
  })

  it('no sign-in at all (offline mode, no cloud): Official game as before', () => {
    home({ signInAvailable: false, signedIn: false })
    expect(btn('home.officialMatch')).toBeInTheDocument()
    expect(screen.queryByTestId('home-sign-in-note')).toBeNull()
  })

  it('signed out, a match on the device still continues', () => {
    const continueMatch = vi.fn()
    home({ signInAvailable: true, signedIn: false, currentOfficialMatch: { id: 7 }, continueMatch })
    fireEvent.click(btn('home.continueMatch'))
    expect(continueMatch).toHaveBeenCalledWith(7)
  })
})

const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const GAME = {
  game_number: '930001', datetime: `${TODAY}T18:00:00`, team_home: 'KSC Wiedikon H1', team_away: 'VBC Other H1',
  league: '2L', gender: 'men', hall: 'Halle Wiedikon', city: 'Zürich', match_format: 5, match_type: 'championship',
  championship_type: 'regional', match_level: 'senior', referee_1_first_name: 'Rita', referee_1_last_name: 'Ref', club: 'KSC Wiedikon', claim: null
}
const answer = (data) => ({ data, error: null, status: 200 })

describe('TodayGamesModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.removeItem('ov:todayGames')
  })

  it('lists today\'s home games; a pick hands the schedule picker\'s match data', async () => {
    api.fetchTodayGames.mockResolvedValue(answer({ day: TODAY, clubs: ['KSC Wiedikon'], games: [GAME, { ...GAME, game_number: '930002', team_home: 'KSC Wiedikon D2', claim: { mine: false, closed: false } }] }))
    const onPick = vi.fn()
    render(<TodayGamesModal open userId="u1" onPick={onPick} onManual={noop} onClose={noop} />)
    const rows = await screen.findAllByTestId('today-game')
    expect(rows).toHaveLength(2)
    expect(within(rows[1]).getByText('home.todayGames.taken')).toBeInTheDocument()
    fireEvent.click(rows[0])
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({
      gameN: '930001', home: 'KSC Wiedikon H1', away: 'VBC Other H1', league: '2L', hall: 'Halle Wiedikon', city: 'Zürich',
      date: TODAY, time: '18:00', bestOf: 5, referee1First: 'Rita'
    }))
  })

  it('"Not in the list?" goes to the blank setup', async () => {
    api.fetchTodayGames.mockResolvedValue(answer({ day: TODAY, clubs: ['KSC Wiedikon'], games: [] }))
    const onManual = vi.fn()
    render(<TodayGamesModal open userId="u1" onPick={noop} onManual={onManual} onClose={noop} />)
    expect(await screen.findByText('home.todayGames.none')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('today-games-manual'))
    expect(onManual).toHaveBeenCalled()
  })

  it('an account without a club says so', async () => {
    api.fetchTodayGames.mockResolvedValue(answer({ day: TODAY, clubs: [], games: [] }))
    render(<TodayGamesModal open userId="u1" onPick={noop} onManual={noop} onClose={noop} />)
    expect(await screen.findByText('home.todayGames.noClub')).toBeInTheDocument()
  })

  it('offline: the day\'s last list of this account, else only the manual way', async () => {
    api.fetchTodayGames.mockResolvedValue(answer({ day: TODAY, clubs: ['KSC Wiedikon'], games: [GAME] }))
    const first = render(<TodayGamesModal open userId="u1" onPick={noop} onManual={noop} onClose={noop} />)
    await screen.findAllByTestId('today-game')
    expect(readCachedTodayGames('u1', TODAY)?.games).toHaveLength(1)
    first.unmount()

    api.fetchTodayGames.mockResolvedValue({ data: null, error: { network: true, status: 0 }, status: 0 })
    const again = render(<TodayGamesModal open userId="u1" onPick={noop} onManual={noop} onClose={noop} />)
    await waitFor(() => expect(screen.getByText('home.todayGames.offline')).toBeInTheDocument())
    expect(screen.getAllByTestId('today-game')).toHaveLength(1)
    again.unmount()

    render(<TodayGamesModal open userId="someone-else" onPick={noop} onManual={noop} onClose={noop} />)
    expect(await screen.findByText('home.todayGames.failed')).toBeInTheDocument()
    expect(screen.queryAllByTestId('today-game')).toHaveLength(0)
  })
})
