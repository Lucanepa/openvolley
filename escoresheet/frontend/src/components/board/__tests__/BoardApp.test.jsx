import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act, within, cleanup } from '@testing-library/react'

// t() resolves from the real English file, so the test reads what users see
vi.mock('react-i18next', async () => {
  const en = (await import('../../../i18n/locales/en.json')).default
  const lookup = (key) => key.split('.').reduce((o, k) => (o == null ? o : o[k]), en)
  return {
    useTranslation: () => ({
      t: (key, a, b) => {
        const opts = typeof a === 'object' ? a : b
        const fallback = typeof a === 'string' ? a : opts?.defaultValue
        const text = typeof lookup(key) === 'string' ? lookup(key) : (fallback ?? key)
        return String(text).replace(/\{\{(\w+)\}\}/g, (_, k) => String(opts?.[k] ?? ''))
      }
    })
  }
})

import BoardApp from '../BoardApp'
import { emptyBoardView } from '../../../utils/boardFeed'

const TARGET = { kind: 'code', code: 'ABCD2345' }

/** A feed the test drives: push(view) as the real one would emit it */
function fakeFeed() {
  const made = []
  const createFeed = vi.fn(({ target, onView }) => {
    const feed = { target, onView, start: vi.fn(), stop: vi.fn() }
    made.push(feed)
    return feed
  })
  const push = (patch) => act(() => {
    const f = made[made.length - 1]
    f.onView({ ...emptyBoardView(f.target), connected: true, ...patch })
  })
  return { createFeed, made, push }
}

const team = (over = {}) => ({ name: 'Home VC', short: 'HOM', color: '#e2001a', points: 0, sets: 0, timeoutsUsed: 0, subs: 0, serving: false, ...over })

function liveView(over = {}) {
  return {
    state: 'live',
    left: team({ name: 'Away Volleyball Club Nord', short: 'AWA', color: '#fde047', points: 18, sets: 1, timeoutsUsed: 1, subs: 2, serving: true }),
    right: team({ name: 'Home VC', points: 21, sets: 1, timeoutsUsed: 2, subs: 6 }),
    setResults: [{ set: 1, left: 25, right: 22 }, { set: 2, left: 19, right: 25 }],
    setNumber: 3,
    bestOf: 5,
    phase: 'play',
    scorerPresent: true,
    ...over
  }
}

afterEach(() => {
  cleanup()
  window.history.replaceState(null, '', '/')
})

describe('BoardApp', () => {
  it('shows the code form without a code and follows what is typed', () => {
    const { createFeed, made } = fakeFeed()
    render(<BoardApp initialTarget={null} createFeed={createFeed} />)
    expect(screen.getByTestId('board-code-form')).toBeInTheDocument()
    expect(screen.getByTestId('board-state')).toHaveAttribute('data-state', 'form')
    const input = screen.getByTestId('board-code-input')
    expect(input).toHaveFocus()
    expect(createFeed).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: 'nope' } })
    fireEvent.click(screen.getByTestId('board-code-submit'))
    expect(screen.getByRole('alert')).toHaveTextContent(/not a code/i)
    expect(createFeed).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: 'abcd-2345' } })
    fireEvent.submit(input.closest('form'))
    expect(createFeed).toHaveBeenCalledTimes(1)
    expect(made[0].target).toEqual(TARGET)
    expect(made[0].start).toHaveBeenCalled()
    expect(window.location.hash).toBe('#ABCD2345')
    expect(screen.getByTestId('board-state')).toHaveAttribute('data-state', 'connecting')
  })

  it('takes a game number in the same form', () => {
    const { createFeed, made } = fakeFeed()
    render(<BoardApp initialTarget={null} createFeed={createFeed} />)
    fireEvent.change(screen.getByTestId('board-code-input'), { target: { value: '12345' } })
    fireEvent.click(screen.getByTestId('board-code-submit'))
    expect(made[0].target).toEqual({ kind: 'game', game: '12345' })
  })

  it('reads the code from the address', () => {
    window.history.replaceState(null, '', '/livescore/board#ABCD-2345')
    const { createFeed, made } = fakeFeed()
    render(<BoardApp createFeed={createFeed} />)
    expect(made[0].target).toEqual(TARGET)
  })

  it('shows names, points, sets, the serve, time-outs and substitutions', () => {
    const { createFeed, push } = fakeFeed()
    render(<BoardApp initialTarget={TARGET} createFeed={createFeed} />)
    push(liveView())
    expect(screen.getByTestId('board-state')).toHaveAttribute('data-state', 'live')
    // the full name, also a long one (the short name is retired)
    expect(screen.getByTestId('board-name-left')).toHaveTextContent('Away Volleyball Club Nord')
    expect(screen.getByTestId('board-name-right')).toHaveTextContent('Home VC')
    expect(screen.getByTestId('board-points-left')).toHaveTextContent('18')
    expect(screen.getByTestId('board-points-right')).toHaveTextContent('21')
    expect(screen.getByTestId('board-sets-left')).toHaveTextContent('1')
    expect(screen.getByTestId('board-serve-left')).toHaveAttribute('data-serving', 'true')
    expect(screen.getByTestId('board-serve-right')).toHaveAttribute('data-serving', 'false')
    expect(within(screen.getByTestId('board-serve-left')).getByText('Serving')).toBeInTheDocument()
    expect(screen.getByTestId('board-timeouts-left')).toHaveAttribute('aria-label', 'Time-outs used: 1 of 2')
    expect(screen.getByTestId('board-timeouts-right')).toHaveAttribute('aria-label', 'Time-outs used: 2 of 2')
    expect(screen.getByTestId('board-subs-left')).toHaveTextContent('2/6')
    expect(screen.getByTestId('board-subs-right')).toHaveTextContent('6/6')
    expect(screen.getByTestId('board-set-number')).toHaveTextContent('Set 3')
    expect(screen.getByTestId('board-set-results')).toHaveTextContent('25–22')
    expect(screen.getByTestId('board-set-results')).toHaveTextContent('19–25')
    expect(screen.queryByTestId('board-banner')).toBeNull()
    // the team colour is on the band, the text picked by contrast
    expect(screen.getByTestId('board-team-left')).toHaveStyle({ background: '#fde047', color: '#1c1917' })
    expect(screen.getByTestId('board-team-right')).toHaveStyle({ background: '#e2001a', color: '#ffffff' })
    // footer: live, the code small
    expect(screen.getByTestId('board-connection')).toHaveTextContent('Live')
    expect(screen.getByTestId('board-code')).toHaveTextContent('ABCD-2345')
  })

  it('hides time-outs and substitutions the source does not know (game numbers)', () => {
    const { createFeed, push } = fakeFeed()
    render(<BoardApp initialTarget={{ kind: 'game', game: '77' }} createFeed={createFeed} />)
    push(liveView({ left: team({ timeoutsUsed: null, subs: null }), right: team({ name: 'B', timeoutsUsed: null, subs: null }) }))
    expect(screen.queryByTestId('board-timeouts-left')).toBeNull()
    expect(screen.queryByTestId('board-subs-left')).toBeNull()
    expect(screen.getByTestId('board-code')).toHaveTextContent('Game 77')
  })

  it('shows the time-out and set break banners', () => {
    const { createFeed, push } = fakeFeed()
    render(<BoardApp initialTarget={TARGET} createFeed={createFeed} />)
    push(liveView({ phase: 'timeout' }))
    expect(screen.getByTestId('board-banner')).toHaveTextContent('Time-out')
    push(liveView({ phase: 'set_break' }))
    expect(screen.getByTestId('board-banner')).toHaveTextContent('Set break')
    expect(screen.getByTestId('board-banner')).toHaveAttribute('data-phase', 'set_break')
  })

  it('shows the match end with the sets won and the winner', () => {
    const { createFeed, push } = fakeFeed()
    render(<BoardApp initialTarget={TARGET} createFeed={createFeed} />)
    push(liveView({
      phase: 'final',
      left: team({ name: 'Away VC', color: '#1d4ed8', points: 15, sets: 3, serving: true }),
      right: team({ name: 'Home VC', points: 12, sets: 1 }),
      setResults: [{ set: 1, left: 25, right: 20 }, { set: 2, left: 20, right: 25 }, { set: 3, left: 25, right: 18 }, { set: 4, left: 25, right: 23 }]
    }))
    const banner = screen.getByTestId('board-banner')
    expect(banner).toHaveTextContent('Match end')
    expect(banner).toHaveTextContent('Away VC wins 3–1')
    // the big digits are the sets won now, no serve ball
    expect(screen.getByTestId('board-points-left')).toHaveTextContent('3')
    expect(screen.getByTestId('board-points-right')).toHaveTextContent('1')
    expect(screen.getByTestId('board-serve-left')).toHaveAttribute('data-serving', 'false')
    expect(screen.getByTestId('board-winner-left')).toHaveTextContent('Winner')
    expect(screen.queryByTestId('board-winner-right')).toBeNull()
    expect(screen.getByTestId('board-set-results')).toHaveTextContent('25–23')
  })

  it('says when it reconnects or the scorer is offline', () => {
    const { createFeed, push } = fakeFeed()
    render(<BoardApp initialTarget={TARGET} createFeed={createFeed} />)
    push(liveView({ scorerPresent: false }))
    expect(screen.getByTestId('board-connection')).toHaveTextContent('Scorer offline')
    push(liveView({ connected: false }))
    expect(screen.getByTestId('board-connection')).toHaveTextContent('Reconnecting…')
    // the score stays on screen
    expect(screen.getByTestId('board-points-right')).toHaveTextContent('21')
  })

  it.each([
    ['not-found', 'No match with this code'],
    ['ended', 'This code has ended'],
    ['waiting', 'Waiting for the scorer'],
    ['offline', 'No connection to the server'],
    ['connecting', 'Connecting…']
  ])('shows the %s screen', (state, title) => {
    const { createFeed, push } = fakeFeed()
    render(<BoardApp initialTarget={TARGET} createFeed={createFeed} />)
    push({ state })
    expect(screen.getByTestId('board-state')).toHaveAttribute('data-state', state)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(title)
    expect(screen.getByTestId('board-status-code')).toHaveTextContent('ABCD-2345')
  })

  it('names the wait when rate-limited and the game when it is not live', () => {
    const a = fakeFeed()
    const { unmount } = render(<BoardApp initialTarget={TARGET} createFeed={a.createFeed} />)
    a.push({ state: 'rate-limited', retryAfter: 120 })
    expect(screen.getByText('This scoreboard tries again in 120 s.')).toBeInTheDocument()
    unmount()
    const b = fakeFeed()
    render(<BoardApp initialTarget={{ kind: 'game', game: '77' }} createFeed={b.createFeed} />)
    b.push({ state: 'not-found' })
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Game 77 is not live')
  })

  it('goes back to the form with "Enter another code" and stops the feed', () => {
    window.history.replaceState(null, '', '/board#ABCD2345')
    const { createFeed, made, push } = fakeFeed()
    render(<BoardApp createFeed={createFeed} />)
    push({ state: 'ended' })
    fireEvent.click(screen.getByTestId('board-another-code'))
    expect(made[0].stop).toHaveBeenCalled()
    expect(screen.getByTestId('board-code-form')).toBeInTheDocument()
    expect(window.location.hash).toBe('')
  })

  it('keeps the screen awake where the browser can', async () => {
    const release = vi.fn(async () => {})
    const request = vi.fn(async () => ({ release }))
    Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true })
    try {
      const { createFeed } = fakeFeed()
      const { unmount } = render(<BoardApp initialTarget={TARGET} createFeed={createFeed} />)
      await act(async () => {})
      expect(request).toHaveBeenCalledWith('screen')
      unmount()
      expect(release).toHaveBeenCalled()
    } finally {
      delete navigator.wakeLock
    }
  })
})
