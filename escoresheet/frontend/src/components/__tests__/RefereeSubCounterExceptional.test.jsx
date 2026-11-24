import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act, waitFor, cleanup } from '@testing-library/react'

// The referee's SUB counter with an exceptional substitution (FIVB 15.7) in
// the scorer's live state: SUB counts every substitution, exceptional ones
// included (owner 22.11.2026: "SUB shall count exceptional substitutions"),
// as the scorer's SUB box and the bench tablet; its colour follows the
// regular ones, the 6 of the rule.

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

const sub = (playerIn, playerOut, exceptional = false) => ({ playerIn, playerOut, position: 'I', exceptional, ts: '2026-11-21T22:20:00.000Z' })

// Team A is home (HOM, on the left in set 1), team B away (AWY)
function bundle(liveState) {
  return {
    success: true,
    match: { id: 'match_seed', status: 'live', bestOf: 5, coinTossTeamA: 'home', coinTossTeamB: 'away', firstServe: 'home', homeShortName: 'HOM', awayShortName: 'AWY', homeName: 'Home VC', awayName: 'Away VC' },
    homeTeam: { name: 'Home VC', color: '#2563eb' },
    awayTeam: { name: 'Away VC', color: '#dc2626' },
    homePlayers: [1, 2, 3, 4, 5, 6, 8, 9, 10, 11].map(number => ({ number })),
    awayPlayers: [11, 12, 13, 14, 15, 16, 17].map(number => ({ number })),
    sets: [{ index: 1, homePoints: 14, awayPoints: 12, finished: false }],
    events: [{ type: 'point', setIndex: 1, seq: 1, payload: { team: 'home' } }],
    liveState: {
      team_a_name: 'Home VC',
      team_b_name: 'Away VC',
      current_set: 1,
      side_a: 'left',
      serving_team: 'left',
      points_a: 14,
      points_b: 12,
      sets_won_a: 0,
      sets_won_b: 0,
      set_interval_active: false,
      match_status: 'in_progress',
      ...liveState
    }
  }
}

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 200)) })

async function mount(liveState) {
  render(<Referee matchId="match_seed" onExit={() => {}} isMasterMode={false} />)
  await waitFor(() => expect(relay.onData || relay.subscriber).toBeTypeOf('function'))
  const push = relay.onData || relay.subscriber
  await act(async () => { push(bundle(liveState)) })
  await settle()
  await waitFor(() => expect(counters('left')).not.toBeNull())
}

// upright: the strip under the court (left / right); landscape (jsdom's
// 1024 x 768): the side columns (lcnt / rcnt)
const counters = (side) => document.querySelector(`[data-team-counters="${side}"], [data-team-counters="${side === 'left' ? 'lcnt' : 'rcnt'}"]`)
const subCount = (side) => counters(side)?.querySelector('[data-counter="SUB"]')?.textContent.replace('SUB', '').trim()
const subTone = (side) => counters(side)?.querySelector('[data-counter="SUB"]')?.getAttribute('data-tone') || null

describe('Referee SUB counter: exceptional substitutions are counted, the colour follows the 6 regular ones', () => {
  beforeEach(() => { cleanup(); relay.subscriber = null; relay.onData = null })

  it('6 regular + 1 exceptional shows 7, red, as the scorer and the bench', async () => {
    await mount({
      subs_a: [sub(8, 1), sub(9, 2), sub(10, 3), sub(1, 8), sub(2, 9), sub(3, 10), sub(4, 11, true)],
      subs_b: [sub(17, 15, true)]
    })
    expect(subCount('left')).toBe('7')
    expect(subTone('left')).toBe('max')
    // an exceptional substitution alone: 1, no colour (all 6 regular left)
    expect(subCount('right')).toBe('1')
    expect(subTone('right')).toBe(null)
  })

  it('5 regular + 1 exceptional shows 6, amber: one regular substitution is left', async () => {
    await mount({
      subs_a: [sub(8, 1), sub(9, 2), sub(10, 3), sub(1, 8), sub(2, 9), sub(4, 11, true)],
      subs_b: []
    })
    expect(subCount('left')).toBe('6')
    expect(subTone('left')).toBe('near')
  })
})
