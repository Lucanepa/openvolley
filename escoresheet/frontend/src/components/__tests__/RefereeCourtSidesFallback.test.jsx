import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act, waitFor, cleanup } from '@testing-library/react'

// The referee's court sides without a live state from the scoreboard (an API
// read or a relay bundle without one): the match's sides by the scorer's own
// rule (domain/rules getSideAForSet, the one the scorer's court draws). The
// 2nd referee stands on the scorer's side: his left is the scorer's left.

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

// Team A is home (HOM), team B away (AWY)
function bundle(match, set) {
  return {
    success: true,
    match: { id: 'match_seed', status: 'live', bestOf: 5, coinTossTeamA: 'home', coinTossTeamB: 'away', firstServe: 'home', homeShortName: 'HOM', awayShortName: 'AWY', ...match },
    homeTeam: { name: 'Home VC', color: '#2563eb' },
    awayTeam: { name: 'Away VC', color: '#dc2626' },
    homePlayers: [1, 2, 3, 4, 5, 6].map(number => ({ number })),
    awayPlayers: [11, 12, 13, 14, 15, 16].map(number => ({ number })),
    sets: [set],
    events: [],
    liveState: null
  }
}

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 200)) })

async function mount(match, set) {
  render(<Referee matchId="match_seed" onExit={() => {}} isMasterMode={false} />)
  await waitFor(() => expect(relay.onData || relay.subscriber).toBeTypeOf('function'))
  const push = relay.onData || relay.subscriber
  await act(async () => { push(bundle(match, set)) })
  await settle()
  await waitFor(() => expect(document.body.textContent).toContain('HOM'))
}

// The header names the left team first
const leftTeam = () => {
  const text = document.body.textContent
  return text.indexOf('HOM') < text.indexOf('AWY') ? 'A' : 'B'
}

const set = (index, extra = {}) => ({ index, homePoints: 3, awayPoints: 2, finished: false, ...extra })

describe('Referee: the court sides without a live state are the scorer\'s', () => {
  beforeEach(() => { cleanup(); relay.subscriber = null; relay.onData = null })

  it('sets 1-4 alternate: A left in set 1 and 3, right in set 2', async () => {
    await mount({}, set(1))
    expect(leftTeam()).toBe('A')
    cleanup()
    await mount({}, set(2))
    expect(leftTeam()).toBe('B')
    cleanup()
    await mount({}, set(3))
    expect(leftTeam()).toBe('A')
  })

  it('an override names the left team by its letter, not its home/away key', async () => {
    await mount({ setLeftTeamOverrides: { 2: 'A' } }, set(2))
    expect(leftTeam()).toBe('A')
    cleanup()
    await mount({ coinTossTeamA: 'away', coinTossTeamB: 'home', setLeftTeamOverrides: { 1: 'A' } }, set(1))
    // team A is away: AWY on the left
    expect(leftTeam()).toBe('B')
  })

  it('set 5 before its coin toss is written: where set 4 ended (A right), as on the scorer', async () => {
    await mount({}, set(5))
    expect(leftTeam()).toBe('B')
  })

  it('set 5: the coin toss (set5LeftTeam) wins over an older override [5], and flips at 8', async () => {
    await mount({ set5LeftTeam: 'A', setLeftTeamOverrides: { 5: 'B' } }, set(5))
    expect(leftTeam()).toBe('A')
    cleanup()
    await mount({ set5LeftTeam: 'A', set5CourtSwitched: true }, set(5, { homePoints: 8, awayPoints: 5 }))
    expect(leftTeam()).toBe('B')
  })
})
