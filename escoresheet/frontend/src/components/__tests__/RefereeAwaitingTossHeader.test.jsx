import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act, waitFor, cleanup, screen, fireEvent, within } from '@testing-library/react'

// The referee's header before the coin toss ("Awaiting coin toss"). Its own
// row (fullscreen, screen on, connection, refresh, ?, language, version,
// exit) was wider than a 360 px phone: the last button sat 93 % off the
// screen (full-match test 21.11.2026). It is the match view's bar now
// (SimpleHeader): the connection pill, the menu, ? and fullscreen; screen on,
// refresh, exit, the language and the version in the menu.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key), i18n: { language: 'en', changeLanguage: () => {} } })
}))
vi.mock('../../i18n', () => ({ default: { language: 'en', changeLanguage: () => {} } }))
vi.mock('../../contexts/AlertContext', () => ({ useAlert: () => ({ showAlert: vi.fn() }) }))
vi.mock('../../hooks/useSyncQueue', async (importOriginal) => ({
  ...(await importOriginal()),
  useSyncQueue: () => ({ syncStatus: 'idle', retryErrors: vi.fn() }),
  useSyncQueueStats: () => ({})
}))
vi.mock('../../lib/supabaseClient', () => ({ supabase: null }))
vi.mock('../../lib/apiClient', async (importOriginal) => ({
  ...(await importOriginal()),
  apiFrom: () => { throw new Error('no cloud') }
}))
vi.mock('../../hooks/useScaledLayout', () => ({ useScaledLayout: () => ({ vmin: (v) => v * 10, scaleFactor: 1 }) }))
vi.mock('../WsDebugOverlay', () => ({ default: () => null }))
vi.mock('../../hooks/useServiceWorker', async (importOriginal) => ({ ...(await importOriginal()), clearCachesAndReload: async () => true }))

const relay = vi.hoisted(() => ({ subscriber: null }))
vi.mock('../../utils/serverDataSync', async (importOriginal) => ({
  ...(await importOriginal()),
  getMatchData: () => new Promise(() => {}),
  subscribeToMatchData: (_id, cb) => { relay.subscriber = cb; return () => { relay.subscriber = null } },
  listAvailableMatches: async () => ({ success: true, matches: [] }),
  getWebSocketStatus: () => 'connected',
  forceReconnect: vi.fn()
}))
vi.mock('../../hooks/useRealtimeConnection', async (importOriginal) => {
  const real = await importOriginal()
  return {
    ...real,
    useRealtimeConnection: ({ onData }) => {
      relay.onData = onData
      return { status: real.CONNECTION_STATUS.CONNECTED, activeConnection: 'websocket', error: null, lastUpdate: null, forceReconnect: vi.fn() }
    }
  }
})

globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }

const { default: Referee } = await import('../Referee')

// A match on the scorer before the coin toss
const setupBundle = {
  success: true,
  match: { id: 'match_seed', status: 'setup', bestOf: 5, homeShortName: 'HOM', awayShortName: 'AWY' },
  homeTeam: { name: 'Home VC', color: '#2563eb' },
  awayTeam: { name: 'Away VC', color: '#dc2626' },
  homePlayers: [1, 2, 3, 4, 5, 6].map(number => ({ number })),
  awayPlayers: [11, 12, 13, 14, 15, 16].map(number => ({ number })),
  sets: [{ index: 1, homePoints: 0, awayPoints: 0, finished: false }],
  events: [],
  liveState: null
}

async function mount() {
  render(<Referee matchId="match_seed" onExit={() => {}} isMasterMode={false} />)
  await waitFor(() => expect(relay.onData || relay.subscriber).toBeTypeOf('function'))
  const push = relay.onData || relay.subscriber
  await act(async () => { push(setupBundle) })
  await act(async () => { await new Promise(r => setTimeout(r, 200)) })
  await waitFor(() => expect(document.body.textContent).toContain('Awaiting coin toss'))
}

// The header bar: the first child of the page (SimpleHeader's ov-kit bar)
const headerBar = () => document.querySelector('.ov-kit.border-b')

describe('Referee before the coin toss: the match view\'s header bar', () => {
  beforeEach(() => { cleanup(); relay.subscriber = null; relay.onData = null })

  it('shows the connection pill, the menu, ? and fullscreen, and nothing more', async () => {
    await mount()
    const bar = headerBar()
    expect(bar).not.toBeNull()
    const names = within(bar).getAllByRole('button').map(b => b.getAttribute('aria-label') || b.textContent.trim())
    expect(names).toHaveLength(4)
    expect(names[1]).toBe('header.menu')
    expect(names.slice(2)).toEqual(['Help', 'Fullscreen'])
    // the connection pill first (its text is the status)
    expect(bar.querySelector('[data-connection-menu] button')).not.toBeNull()
    // the version and the language are not in the bar any more
    expect(bar.textContent).not.toMatch(/v\d+\.\d+/)
  })

  it('the menu holds screen on, refresh, exit, the language and the version', async () => {
    await mount()
    fireEvent.click(within(headerBar()).getByRole('button', { name: 'header.menu' }))
    const menu = await screen.findByRole('group', { name: 'header.menu' })
    const text = menu.textContent
    for (const entry of ['refereeDashboard.keepScreenOn', 'refereeDashboard.refresh', 'refereeDashboard.exit', 'Language', 'Version ']) {
      expect(text).toContain(entry)
    }
  })
})
