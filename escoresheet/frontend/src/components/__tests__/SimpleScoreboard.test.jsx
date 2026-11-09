import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, act } from '@testing-library/react'

// Home's Scoreboard: points and sets on the whole screen, nothing else
// (domain/simpleScoreboard.js has the rules of the board itself)

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => {
      const text = typeof opts === 'string' ? opts : (opts?.defaultValue ?? key)
      return typeof opts === 'object' ? text.replace(/\{\{(\w+)\}\}/g, (_, k) => String(opts[k] ?? '')) : text
    },
    i18n: { language: 'en' }
  })
}))

import SimpleScoreboard from '../SimpleScoreboard'
import HomePage from '../pages/HomePage'
import { UiHost } from '../../ui'
import { SIMPLE_BOARD_KEY, loadBoard } from '../../domain/simpleScoreboard'

vi.mock('../SupportFeedbackModal', () => ({ default: () => null }))
vi.mock('../auth/PendingApprovalBanner', () => ({ default: () => null }))
vi.mock('../auth/LoginModal', () => ({ default: () => null }))
vi.mock('../../utils/backendConfig', async (orig) => ({ ...(await orig()), isServedFromLocalServer: () => true }))

const board = (props = {}) => render(<><SimpleScoreboard onExit={() => {}} {...props} /><UiHost /></>)
const points = (team) => screen.getByTestId(`simple-board-points-${team}`).textContent
const half = (team) => screen.getByTestId(`simple-board-${team}`)
const tap = (team, n = 1) => { for (let i = 0; i < n; i++) fireEvent.click(within(half(team)).getAllByRole('button')[0]) }
const minus = (team) => fireEvent.click(within(half(team)).getByRole('button', { name: /One point off/ }))
const order = () => screen.getAllByTestId(/^simple-board-(home|away)$/).map(el => el.dataset.testid.replace('simple-board-', ''))

describe('SimpleScoreboard', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('a tap on a half is a point for that team; it serves', () => {
    board()
    expect(points('home')).toBe('0')
    tap('home', 3)
    tap('away')
    expect(points('home')).toBe('3')
    expect(points('away')).toBe('1')
    expect(screen.getByTestId('simple-board-serve-away')).toBeInTheDocument()
    expect(screen.queryByTestId('simple-board-serve-home')).toBeNull()
  })

  it('−1 takes a point off, and is off at 0', () => {
    board()
    const off = within(half('away')).getByRole('button', { name: /One point off/ })
    expect(off).toBeDisabled()
    tap('away', 2)
    minus('away')
    expect(points('away')).toBe('1')
  })

  it('Undo goes back one step at a time', () => {
    board()
    const undo = screen.getByRole('button', { name: 'Undo' })
    expect(undo).toBeDisabled()
    tap('home', 2)
    fireEvent.click(undo)
    expect(points('home')).toBe('1')
    fireEvent.click(undo)
    expect(points('home')).toBe('0')
    expect(undo).toBeDisabled()
  })

  it('Next set needs a leader, gives it the set and starts at 0:0', () => {
    board()
    const next = screen.getByTestId('simple-board-next-set')
    expect(next).toBeDisabled()
    tap('home', 25)
    tap('away', 20)
    fireEvent.click(next)
    expect(points('home')).toBe('0')
    expect(points('away')).toBe('0')
    expect(screen.getByTestId('simple-board-set')).toHaveTextContent('Set 2')
    expect(screen.getByTestId('simple-board-sets')).toHaveTextContent('25:20')
    expect(within(half('home')).getByText('Sets 1')).toBeInTheDocument()
    expect(within(half('away')).getByText('Sets 0')).toBeInTheDocument()
  })

  it('Swap sides puts the teams on the other halves, the set results with them', () => {
    board()
    tap('home', 2)
    fireEvent.click(screen.getByTestId('simple-board-next-set'))
    expect(order()).toEqual(['home', 'away'])
    fireEvent.click(screen.getByRole('button', { name: 'Swap sides' }))
    expect(order()).toEqual(['away', 'home'])
    expect(screen.getByTestId('simple-board-sets')).toHaveTextContent('0:2')
  })

  it('names the teams and picks the colours in Teams', () => {
    board()
    fireEvent.click(screen.getByRole('button', { name: 'Teams' }))
    fireEvent.change(document.getElementById('simple-board-home-name'), { target: { value: 'Musterdorf' } })
    fireEvent.change(document.getElementById('simple-board-away-name'), { target: { value: 'Limmattal' } })
    fireEvent.click(screen.getByTestId('simple-board-teams-save'))
    expect(within(half('home')).getByText('Musterdorf')).toBeInTheDocument()
    expect(within(half('away')).getByText('Limmattal')).toBeInTheDocument()
    expect(loadBoard().teams.home.name).toBe('Musterdorf')
  })

  it('an empty name shows Home and Away', () => {
    board()
    expect(within(half('home')).getByText('Home')).toBeInTheDocument()
    expect(within(half('away')).getByText('Away')).toBeInTheDocument()
  })

  it('New game asks first, then clears points and sets and keeps the names', async () => {
    localStorage.setItem(SIMPLE_BOARD_KEY, JSON.stringify({ v: 1, teams: { home: { name: 'A' }, away: { name: 'B' } }, points: { home: 4, away: 2 }, sets: [{ home: 25, away: 10 }] }))
    board()
    expect(points('home')).toBe('4')
    fireEvent.click(screen.getByRole('button', { name: 'New game' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Start a new game?')).toBeInTheDocument()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'New game' })) })
    expect(points('home')).toBe('0')
    expect(screen.queryByTestId('simple-board-sets')).toBeNull()
    expect(within(half('home')).getByText('A')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New game' })).toBeDisabled()
  })

  it('keeps the score on the device: a new board reads it back', () => {
    const { unmount } = board()
    tap('away', 7)
    unmount()
    board()
    expect(points('away')).toBe('7')
  })

  it('arrow keys score for the left and right team, Ctrl+Z and Backspace undo', () => {
    board()
    fireEvent.click(screen.getByRole('button', { name: 'Swap sides' })) // away on the left
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(points('away')).toBe('2')
    expect(points('home')).toBe('1')
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    expect(points('home')).toBe('0')
    fireEvent.keyDown(window, { key: 'Backspace' })
    expect(points('away')).toBe('1')
  })

  it('the keys stay off while Teams is open', () => {
    board()
    fireEvent.click(screen.getByRole('button', { name: 'Teams' }))
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(points('home')).toBe('0')
  })

  it('the keys stay off while the new-game question is open, and the help panel does not stop them', async () => {
    render(<div role="dialog" data-testid="help-panel" style={{ transform: 'translateX(100%)' }} />)
    localStorage.setItem(SIMPLE_BOARD_KEY, JSON.stringify({ v: 1, points: { home: 3, away: 0 } }))
    board()
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(points('home')).toBe('4')
    fireEvent.click(screen.getByRole('button', { name: 'New game' }))
    const dialog = await screen.findByRole('dialog', { name: 'Start a new game?' })
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(points('home')).toBe('4')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' })) })
    expect(points('home')).toBe('4')
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(points('home')).toBe('5')
  })

  it('Back leaves the board', () => {
    const onExit = vi.fn()
    board({ onExit })
    fireEvent.click(screen.getByTestId('simple-board-exit'))
    expect(onExit).toHaveBeenCalled()
  })
})

describe('Home: the Scoreboard button', () => {
  const noop = () => {}
  it('opens the scoreboard, signed in or out', () => {
    for (const signedIn of [false, true]) {
      const onOpenScoreboard = vi.fn()
      const { unmount } = render(
        <HomePage signInAvailable signedIn={signedIn} createNewTestMatch={noop} createEasyMatch={noop} onOfficialGame={noop}
          onOpenSettings={noop} onRestoreMatch={noop} onOpenScoreboard={onOpenScoreboard} />
      )
      fireEvent.click(screen.getByRole('button', { name: 'Scoreboard' }))
      expect(onOpenScoreboard).toHaveBeenCalledTimes(1)
      unmount()
    }
  })

  it('is not there without a handler', () => {
    render(<HomePage createNewTestMatch={noop} createEasyMatch={noop} onOfficialGame={noop} onOpenSettings={noop} onRestoreMatch={noop} />)
    expect(screen.queryByRole('button', { name: 'Scoreboard' })).toBeNull()
  })
})
