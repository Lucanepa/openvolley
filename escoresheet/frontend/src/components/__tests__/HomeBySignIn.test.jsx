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
  game_number: '930001', datetime: `${TODAY}T18:00:00`, team_home: 'VBC Musterdorf H1', team_away: 'VBC Other H1',
  league: '2L', gender: 'men', hall: 'Halle Musterdorf', city: 'Zürich', match_format: 5, match_type: 'championship',
  championship_type: 'regional', match_level: 'senior', referee_1_first_name: 'Rita', referee_1_last_name: 'Ref', club: 'VBC Musterdorf', claim: null
}
const answer = (data) => ({ data, error: null, status: 200 })

describe('TodayGamesModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.removeItem('ov:todayGames')
  })

  it('lists today\'s home games; a pick hands the schedule picker\'s match data', async () => {
    api.fetchTodayGames.mockResolvedValue(answer({ day: TODAY, clubs: ['VBC Musterdorf'], games: [GAME, { ...GAME, game_number: '930002', team_home: 'VBC Musterdorf D2', claim: { mine: false, closed: false } }] }))
    const onPick = vi.fn()
    render(<TodayGamesModal open userId="u1" onPick={onPick} onManual={noop} onClose={noop} />)
    const rows = await screen.findAllByTestId('today-game')
    expect(rows).toHaveLength(2)
    expect(within(rows[1]).getByText('home.todayGames.taken')).toBeInTheDocument()
    fireEvent.click(rows[0])
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({
      gameN: '930001', home: 'VBC Musterdorf H1', away: 'VBC Other H1', league: '2L', hall: 'Halle Musterdorf', city: 'Zürich',
      date: TODAY, time: '18:00', bestOf: 5, referee1First: 'Rita'
    }))
  })

  it('"Not in the list?" goes to the blank setup', async () => {
    api.fetchTodayGames.mockResolvedValue(answer({ day: TODAY, clubs: ['VBC Musterdorf'], games: [] }))
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

  // gap-fe-unread-dialogs-3: the copy on the device keeps what the list and a
  // pick need, never the referees' dates of birth (minors among them)
  it('the day\'s copy keeps no referee dates of birth; a pick from it still names the referees', async () => {
    api.fetchTodayGames.mockResolvedValue(answer({ day: TODAY, clubs: ['VBC Musterdorf'], games: [{ ...GAME, referee_1_dob: '2009-04-05', referee_2_first_name: 'Rolf', referee_2_last_name: 'Zweit', referee_2_dob: '1980-01-02' }] }))
    const onPick = vi.fn()
    const first = render(<TodayGamesModal open userId="u1" onPick={onPick} onManual={noop} onClose={noop} />)
    fireEvent.click((await screen.findAllByTestId('today-game'))[0])
    // online: the fresh answer, dates included (the scorer fills the sheet's officials)
    expect(onPick).toHaveBeenLastCalledWith(expect.objectContaining({ referee1Dob: '2009-04-05', referee2Dob: '1980-01-02' }))
    const stored = localStorage.getItem('ov:todayGames')
    expect(stored).not.toContain('2009-04-05')
    expect(stored).not.toContain('1980-01-02')
    expect(stored).not.toMatch(/dob/)
    first.unmount()

    api.fetchTodayGames.mockResolvedValue({ data: null, error: { network: true, status: 0 }, status: 0 })
    render(<TodayGamesModal open userId="u1" onPick={onPick} onManual={noop} onClose={noop} />)
    await waitFor(() => expect(screen.getByText('home.todayGames.offline')).toBeInTheDocument())
    fireEvent.click(screen.getAllByTestId('today-game')[0])
    expect(onPick).toHaveBeenLastCalledWith(expect.objectContaining({ home: 'VBC Musterdorf H1', referee1First: 'Rita', referee2First: 'Rolf', referee2Last: 'Zweit' }))
    expect(onPick.mock.lastCall[0].referee1Dob).toBeFalsy()
    expect(onPick.mock.lastCall[0].referee2Dob).toBeFalsy()
  })

  it('offline: the day\'s last list of this account, else only the manual way', async () => {
    api.fetchTodayGames.mockResolvedValue(answer({ day: TODAY, clubs: ['VBC Musterdorf'], games: [GAME] }))
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
