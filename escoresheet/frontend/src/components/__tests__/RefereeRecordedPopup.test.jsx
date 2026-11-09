import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor, fireEvent, within } from '@testing-library/react'

// Every referee tablet: a time-out, a substitution or a sanction the scorer
// records opens "Recorded by the scorer" (OK, or it closes 10 s after its last
// entry); what is recorded meanwhile joins the same popup. Nothing recorded
// before the tablet loaded the match, and an undo takes its entry out.

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

// The database's realtime channel: the test delivers its rows
const cloud = vi.hoisted(() => ({ onRow: null }))
vi.mock('../../lib/supabaseClient', () => {
  const channel = {
    on: (_kind, _filter, cb) => { cloud.onRow = cb; return channel },
    subscribe: (cb) => { if (cb) cb('SUBSCRIBED'); return channel }
  }
  return { supabase: { channel: () => channel, removeChannel: () => {} } }
})
vi.mock('../../lib/apiClient', () => ({
  apiFrom: () => {
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { id: '00000000-0000-4000-8000-000000000001' }, error: null }) }
    return q
  }
}))
vi.mock('../../hooks/useScaledLayout', () => ({ useScaledLayout: () => ({ vmin: (v) => v * 10, scaleFactor: 1 }) }))
vi.mock('../WsDebugOverlay', () => ({ default: () => null }))

// Each refetch resolves when the test says so; the tracker is the real one
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
    useRealtimeConnection: () => ({
      status: real.CONNECTION_STATUS.CONNECTED,
      activeConnection: 'websocket',
      error: null,
      lastUpdate: null,
      forceReconnect: vi.fn()
    })
  }
})

globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }

const { default: Referee } = await import('../Referee')

const T0 = Date.parse('2026-11-09T18:00:00Z')
const ev = (seq, type, payload = {}) => ({ seq, type, setIndex: 1, ts: new Date(T0 + seq * 1000).toISOString(), payload })
const BASE = [ev(1, 'point', { team: 'home' }), ev(2, 'substitution', { team: 'home', playerIn: 7, playerOut: 1 })]

function bundle(events) {
  return {
    success: true,
    match: { id: 'match_seed', status: 'live', coinTossTeamA: 'home', firstServe: 'home' },
    homeTeam: { name: 'VC Smash', color: '#ef4444' },
    awayTeam: { name: 'Volley Bern', color: '#3b82f6' },
    homePlayers: [1, 2, 3, 4, 5, 6, 7].map(n => ({ number: n, lastName: `H${n}` })),
    awayPlayers: [1, 2, 3, 4, 5, 6].map(n => ({ number: n, lastName: `A${n}` })),
    sets: [{ index: 1, homePoints: 1, awayPoints: 0, finished: false }],
    events
  }
}

// Data updates are applied at most every 150 ms (anti-flicker debounce)
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 200)) })
const popup = () => screen.queryByTestId('referee-recorded-popup')

let rowMs = 0
// A database row starts a refetch; the test answers it with the next bundle
async function scorerRecorded(events) {
  const before = relay.fetches.length
  rowMs += 1000
  await act(async () => { cloud.onRow({ new: { updated_at: new Date(T0 + rowMs).toISOString(), current_set: 1, points_a: 1, points_b: 0, match_status: 'live' } }) })
  await waitFor(() => expect(relay.fetches.length).toBeGreaterThan(before))
  await act(async () => { relay.fetches[relay.fetches.length - 1](bundle(events)) })
  await settle()
}

async function openMatch() {
  render(<Referee matchId="match_seed" onExit={() => {}} isMasterMode={false} />)
  await waitFor(() => expect(relay.fetches.length).toBeGreaterThan(0))
  await act(async () => { for (const res of relay.fetches) res(bundle(BASE)) })
  await settle()
  await waitFor(() => expect(cloud.onRow).toBeTypeOf('function'))
}

describe('Referee: recorded by the scorer', () => {
  beforeEach(() => {
    relay.fetches = []
    cloud.onRow = null
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 })
  })

  it('shows nothing recorded before, then one summary of what is recorded, until OK', async () => {
    await openMatch()
    expect(popup()).toBeNull()

    const to = ev(3, 'timeout', { team: 'away' })
    await scorerRecorded([...BASE, to])
    expect(within(popup()).getByText('Time-out')).toBeTruthy()
    expect(within(popup()).getByText('Volley Bern (B)')).toBeTruthy()

    // a substitution and a card while it is open: the same popup, three entries
    const sub = ev(4, 'substitution', { team: 'away', playerIn: 4, playerOut: 2, isExceptional: true })
    const card = ev(5, 'sanction', { team: 'home', type: 'penalty', playerType: 'player', playerNumber: 3 })
    await scorerRecorded([...BASE, to, sub, card])
    const items = within(popup()).getAllByRole('listitem')
    expect(items.map(li => li.textContent)).toEqual([
      expect.stringContaining('Time-out'),
      expect.stringContaining('Exceptional substitution#4 in for #2'),
      expect.stringContaining('PenaltyPlayer #3 · +1 point to Volley Bern')
    ])
    expect(screen.getAllByTestId('referee-recorded-popup')).toHaveLength(1)

    // an undo of the card takes it out
    await scorerRecorded([...BASE, to, sub])
    expect(within(popup()).getAllByRole('listitem')).toHaveLength(2)

    fireEvent.click(within(popup()).getByRole('button', { name: 'OK' }))
    expect(popup()).toBeNull()

    // the same list again announces nothing
    await scorerRecorded([...BASE, to, sub])
    expect(popup()).toBeNull()
  })

  it('closes by itself 10 s after its last entry', async () => {
    await openMatch()
    await scorerRecorded([...BASE, ev(3, 'sanction', { team: 'away', type: 'delay_warning' })])
    expect(within(popup()).getByText('Delay warning')).toBeTruthy()
    expect(within(popup()).getByText(/Closes in (10|9) s/)).toBeTruthy()
    await act(async () => { await new Promise(r => setTimeout(r, 6000)) })
    expect(popup()).not.toBeNull()
    await act(async () => { await new Promise(r => setTimeout(r, 4500)) })
    expect(popup()).toBeNull()
  }, 20000)
})
