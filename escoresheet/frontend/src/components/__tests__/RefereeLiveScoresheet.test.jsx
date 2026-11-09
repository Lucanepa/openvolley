import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react'

// The referee tablet's live scoresheet: a "Scoresheet" button once the
// tablet holds a 'full' relay bundle (the referee PIN proved: rosters and
// events), never with the PIN-less 'summary'. It opens the scorer's paper
// form, read only, drawn from that bundle and redrawn with each new one.

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

// The scoresheet viewer: records what it is given (the paper form itself has its own tests)
const sheet = vi.hoisted(() => ({ props: [] }))
vi.mock('../../../scoresheet_pdf/App_Scoresheet', () => ({
  default: (props) => {
    sheet.props.push(props)
    return <div data-testid="sheet-stub">{props.matchData.events.length} events</div>
  }
}))

const relay = vi.hoisted(() => ({ fetches: [], push: null }))
vi.mock('../../utils/serverDataSync', async (importOriginal) => ({
  ...(await importOriginal()),
  getMatchData: () => new Promise(res => relay.fetches.push(res)),
  subscribeToMatchData: () => () => {},
  listAvailableMatches: async () => ({ success: true, matches: [] }),
  getWebSocketStatus: () => 'connected',
  forceReconnect: vi.fn()
}))
// The relay socket: the test pushes bundles through onData, as the hook does
vi.mock('../../hooks/useRealtimeConnection', async (importOriginal) => {
  const real = await importOriginal()
  return {
    ...real,
    useRealtimeConnection: ({ onData }) => {
      relay.push = onData
      return { status: real.CONNECTION_STATUS.CONNECTED, activeConnection: 'websocket', error: null, lastUpdate: null, forceReconnect: vi.fn() }
    }
  }
})

globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }

const { default: Referee } = await import('../Referee')

const ev = (seq, type, payload = {}) => ({ seq, type, setIndex: 1, payload })
const BASE = [ev(1, 'point', { team: 'home' })]

function bundle(events, access) {
  return {
    success: true,
    ...(access ? { access } : {}),
    match: { id: 'match_seed', status: 'live', coinTossTeamA: 'home', firstServe: 'home' },
    homeTeam: { name: 'VBC Musterdorf', color: '#ef4444' },
    awayTeam: { name: 'Volley Beispiel', color: '#3b82f6' },
    homePlayers: access === 'summary' ? [] : [1, 2, 3, 4, 5, 6].map(n => ({ number: n, lastName: `H${n}` })),
    awayPlayers: access === 'summary' ? [] : [1, 2, 3, 4, 5, 6].map(n => ({ number: n, lastName: `A${n}` })),
    sets: [{ index: 1, homePoints: events.filter(e => e.type === 'point').length, awayPoints: 0, finished: false }],
    events: access === 'summary' ? [] : events
  }
}

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 200)) })
const sheetButton = () => screen.queryAllByTestId('referee-open-scoresheet')

async function openMatch(first, { isMasterMode = false } = {}) {
  render(<Referee matchId="match_seed" onExit={() => {}} isMasterMode={isMasterMode} />)
  if (isMasterMode) { await settle(); return }
  await waitFor(() => expect(relay.fetches.length).toBeGreaterThan(0))
  await act(async () => { for (const res of relay.fetches) res(first) })
  await settle()
}

describe('Referee: live scoresheet', () => {
  beforeEach(() => {
    relay.fetches = []
    relay.push = null
    sheet.props = []
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 820 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1180 })
  })

  it('offers the scoresheet with a full bundle (referee PIN), in the bar and the menu', async () => {
    await openMatch(bundle(BASE, 'full'))
    expect(sheetButton()).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'header.menu' }))
    expect(screen.getAllByRole('button', { name: /Scoresheet/ }).length).toBeGreaterThanOrEqual(2)
  })

  it('never with the PIN-less summary, nor without an access mark, nor in test mode', async () => {
    await openMatch(bundle(BASE, 'summary'))
    expect(sheetButton()).toHaveLength(0)
  })

  it('not from a bundle without access (a match_live_state row, an older relay)', async () => {
    await openMatch(bundle(BASE, null))
    expect(sheetButton()).toHaveLength(0)
  })

  it('not in test mode (no relay bundle)', async () => {
    await openMatch(null, { isMasterMode: true })
    expect(sheetButton()).toHaveLength(0)
  })

  it('opens the sheet read only from the bundle, updates it live, and closes back to the court', async () => {
    await openMatch(bundle(BASE, 'full'))
    fireEvent.click(sheetButton()[0])
    expect(screen.getByTestId('referee-scoresheet-view')).toBeTruthy()
    const stub = await screen.findByTestId('sheet-stub')
    expect(stub.textContent).toBe('1 events')
    const props = sheet.props[sheet.props.length - 1]
    expect(props.readOnly).toBe(true)
    expect(props.embedded).toBe(true)
    expect(props.autoAction).toBeUndefined()
    expect(props.matchData.homePlayers).toHaveLength(6)
    expect(props.matchData.homeTeam.name).toBe('VBC Musterdorf')

    // the scorer's next sync reaches the open sheet
    await act(async () => { relay.push(bundle([...BASE, ev(2, 'point', { team: 'away' }), ev(3, 'timeout', { team: 'home' })], 'full')) })
    await settle()
    expect(screen.getByTestId('sheet-stub').textContent).toBe('3 events')
    expect(screen.getByTestId('referee-scoresheet-updated').textContent).toMatch(/^updated \d\d:\d\d:\d\d$/)

    // a summary push (another socket's view) never replaces it
    await act(async () => { relay.push(bundle([], 'summary')) })
    await settle()
    expect(screen.getByTestId('sheet-stub').textContent).toBe('3 events')

    fireEvent.click(screen.getByTestId('referee-scoresheet-close'))
    expect(screen.queryByTestId('referee-scoresheet-view')).toBeNull()
  })

  it('Escape closes it', async () => {
    await openMatch(bundle(BASE, 'full'))
    fireEvent.click(sheetButton()[0])
    await screen.findByTestId('sheet-stub')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('referee-scoresheet-view')).toBeNull()
  })
})
