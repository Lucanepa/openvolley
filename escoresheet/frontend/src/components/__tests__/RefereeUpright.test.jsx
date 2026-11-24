import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'

// The referee dashboard is upright only on phones and tablets (owner,
// 2026-11-09): held sideways it shows a notice to turn the device upright
// instead of the dashboard; a computer (mouse, touchpad) keeps the landscape
// layout. The mirror of the scorer, who is asked to turn an upright tablet
// to landscape.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, params) => {
      const def = typeof fallback === 'string' ? fallback : (fallback?.defaultValue ?? key)
      const vars = typeof fallback === 'object' ? fallback : params
      return String(def).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars?.[k] ?? ''))
    },
    i18n: { language: 'en', changeLanguage: () => {} }
  })
}))
vi.mock('../../i18n', () => ({ default: { language: 'en', changeLanguage: () => {} } }))
vi.mock('../../contexts/AlertContext', () => ({ useAlert: () => ({ showAlert: vi.fn() }) }))
vi.mock('../../hooks/useSyncQueue', () => ({
  useSyncQueue: () => ({ syncStatus: 'idle', retryErrors: vi.fn() }),
  useSyncQueueStats: () => ({})
}))
vi.mock('../../lib/supabaseClient', () => {
  const channel = { on: () => channel, subscribe: (cb) => { if (cb) cb('SUBSCRIBED'); return channel } }
  return { supabase: { channel: () => channel, removeChannel: () => {} } }
})
vi.mock('../../lib/apiClient', () => ({
  apiFrom: () => {
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: null, error: null }) }
    return q
  }
}))
vi.mock('../../hooks/useScaledLayout', () => ({ useScaledLayout: () => ({ vmin: (v) => v * 10, scaleFactor: 1 }) }))
vi.mock('../WsDebugOverlay', () => ({ default: () => null }))

const relay = vi.hoisted(() => ({ fetches: [] }))
vi.mock('../../utils/serverDataSync', async (importOriginal) => ({
  ...(await importOriginal()),
  getMatchData: () => new Promise(res => relay.fetches.push(res)),
  subscribeToMatchData: () => () => {},
  listAvailableMatches: async () => ({ success: true, matches: [] }),
  getWebSocketStatus: () => 'connected',
  forceReconnect: vi.fn()
}))
vi.mock('../../hooks/useRealtimeConnection', async (importOriginal) => {
  const real = await importOriginal()
  return {
    ...real,
    useRealtimeConnection: () => ({ status: real.CONNECTION_STATUS.CONNECTED, activeConnection: 'websocket', error: null, lastUpdate: null, forceReconnect: vi.fn() })
  }
})

globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }

const { default: Referee } = await import('../Referee')

const BUNDLE = {
  success: true,
  access: 'full',
  match: { id: 'match_seed', status: 'live', coinTossTeamA: 'home', firstServe: 'home' },
  homeTeam: { name: 'VBC Musterdorf', color: '#ef4444' },
  awayTeam: { name: 'Volley Beispiel', color: '#3b82f6' },
  homePlayers: [1, 2, 3, 4, 5, 6].map(n => ({ number: n, lastName: `H${n}` })),
  awayPlayers: [1, 2, 3, 4, 5, 6].map(n => ({ number: n, lastName: `A${n}` })),
  sets: [{ index: 1, homePoints: 1, awayPoints: 0, finished: false }],
  events: [{ seq: 1, type: 'point', setIndex: 1, payload: { team: 'home' } }]
}

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 200)) })
const notice = () => screen.queryByTestId('referee-turn-upright')
// The dashboard: the teams' names and the live scoresheet button
const dashboardShown = () => screen.queryAllByText('VBC Musterdorf').length > 0 && screen.queryAllByTestId('referee-open-scoresheet').length > 0

function setViewport(width, height) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
}

// jsdom has a touch point ('ontouchstart' in window); the main pointer is
// what tells a tablet (coarse, a finger) from a computer (fine)
function setPointer(coarse) {
  window.matchMedia = vi.fn((query) => ({
    matches: query === '(pointer: coarse)' ? coarse : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {}
  }))
}

async function openMatch() {
  render(<Referee matchId="match_seed" onExit={() => {}} isMasterMode={false} />)
  await waitFor(() => expect(relay.fetches.length).toBeGreaterThan(0))
  await act(async () => { for (const res of relay.fetches) res(BUNDLE) })
  await settle()
}

describe('Referee: upright only on phones and tablets', () => {
  beforeEach(() => {
    relay.fetches = []
  })
  afterEach(() => {
    delete window.matchMedia
  })

  it('a tablet held sideways shows the notice to turn it upright, not the court', async () => {
    setPointer(true)
    setViewport(1180, 820)
    await openMatch()
    expect(notice()).toBeTruthy()
    expect(notice().textContent).toContain('Please hold the device upright')
    expect(dashboardShown()).toBe(false)
  })

  it('a tablet held upright shows the dashboard', async () => {
    setPointer(true)
    setViewport(820, 1180)
    await openMatch()
    expect(notice()).toBeNull()
    expect(dashboardShown()).toBe(true)
  })

  it('a phone on its side gets the notice too', async () => {
    setPointer(true)
    setViewport(844, 390)
    await openMatch()
    expect(notice()).toBeTruthy()
  })

  it('a computer (mouse, touchpad) in landscape keeps the landscape dashboard', async () => {
    setPointer(false)
    setViewport(1280, 800)
    await openMatch()
    expect(notice()).toBeNull()
    expect(dashboardShown()).toBe(true)
  })

  it('without matchMedia it never blocks (a guess is no reason to hide the dashboard)', async () => {
    setViewport(1280, 800)
    await openMatch()
    expect(notice()).toBeNull()
    expect(dashboardShown()).toBe(true)
  })

  it('turning the tablet sideways and back keeps the match on the dashboard', async () => {
    setPointer(true)
    setViewport(820, 1180)
    await openMatch()
    expect(dashboardShown()).toBe(true)
    const reads = relay.fetches.length

    setViewport(1180, 820)
    await act(async () => { window.dispatchEvent(new Event('resize')) })
    expect(notice()).toBeTruthy()
    expect(dashboardShown()).toBe(false)

    setViewport(820, 1180)
    await act(async () => { window.dispatchEvent(new Event('resize')) })
    expect(notice()).toBeNull()
    expect(dashboardShown()).toBe(true)
    // the match came back from the state kept while sideways, not a new read
    expect(relay.fetches.length).toBe(reads)
  })
})
