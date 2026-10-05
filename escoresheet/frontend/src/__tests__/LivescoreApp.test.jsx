import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => fallback || key })
}))

const env = vi.hoisted(() => ({ staticDeployment: true, localServer: false, override: null }))
vi.mock('../utils/backendConfig', () => ({
  isStaticDeployment: () => env.staticDeployment,
  isServedFromLocalServer: () => env.localServer,
  getBackendOverride: () => env.override,
  setBackendOverride: vi.fn(),
  getBackendUrl: () => 'https://backend.openvolley.app',
  clearBackendOverride: vi.fn()
}))

// apiFrom('match_live_state').select().eq().order() -> next queued response
const api = vi.hoisted(() => ({ responses: [], calls: 0 }))
vi.mock('../lib/apiClient', () => ({
  apiFrom: () => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: () => {
        api.calls++
        const r = api.responses.length > 1 ? api.responses.shift() : api.responses[0]
        return Promise.resolve({ data: structuredClone(r), error: null })
      }
    }
    return chain
  }
}))

// Realtime shim: capture the postgres_changes handler
const rt = vi.hoisted(() => ({ handler: null }))
vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    channel: () => {
      const ch = {
        on: (_type, _filter, cb) => { rt.handler = cb; return ch },
        subscribe: () => ch
      }
      return ch
    },
    removeChannel: vi.fn()
  }
}))

vi.mock('../components/UpdateBanner', () => ({ default: () => null }))
vi.mock('../components/DashboardHeader', () => ({
  default: ({ title, subtitle, onBack }) => (
    <div data-testid="header">
      {title} | {subtitle}
      {onBack && <button onClick={onBack}>back</button>}
    </div>
  )
}))
vi.mock('../components/ServerConnectionScreen', () => ({
  default: () => <div>Connect to Server</div>
}))

import LivescoreApp from '../LivescoreApp'

const row = (id, extra = {}) => ({
  match_id: id,
  match_status: 'in_progress',
  current_set: 1,
  points_a: 0,
  points_b: 0,
  sets_won_a: 0,
  sets_won_b: 0,
  team_a_name: `Home ${id}`,
  team_b_name: `Away ${id}`,
  side_a: 'left',
  last_event_type: 'lineup',
  set_results: [],
  matches: { set_results: [] },
  ...extra
})

const flush = async () => { await act(async () => { await Promise.resolve() }) }

describe('LivescoreApp', () => {
  beforeEach(() => {
    env.staticDeployment = true
    env.localServer = false
    env.override = null
    api.responses = []
    api.calls = 0
    rt.handler = null
    window.innerWidth = 1024
    window.innerHeight = 900
  })
  afterEach(() => { vi.useRealTimers() })

  it('on *.openvolley.app shows the scores without the server-connection screen', async () => {
    api.responses = [[row('a', { points_a: 5, points_b: 3, last_event_type: 'point' })]]
    render(<LivescoreApp />)
    await flush()
    expect(screen.queryByText('Connect to Server')).toBeNull()
    expect(screen.getByText('Home a')).toBeInTheDocument()
  })

  it('a dev build with no stored server still asks', async () => {
    env.staticDeployment = false
    render(<LivescoreApp />)
    await flush()
    expect(screen.getByText('Connect to Server')).toBeInTheDocument()
    expect(api.calls).toBe(0)
  })

  it('lists a match only once it is under way, not at the first lineup confirm', async () => {
    api.responses = [[row('a')]]
    render(<LivescoreApp />)
    await flush()
    expect(screen.queryByText('Home a')).toBeNull()
    expect(screen.getByText('No live games')).toBeInTheDocument()

    act(() => rt.handler({ eventType: 'UPDATE', new: { match_id: 'a', points_a: 1, last_event_type: 'point' }, old: {} }))
    expect(screen.getByText('Home a')).toBeInTheDocument()
    expect(screen.getByTestId('header').textContent).toContain('1 game live')
  })

  it('FINAL view gets the per-set scores without a reload', async () => {
    vi.useFakeTimers()
    const live = row('a', { points_a: 24, points_b: 0, sets_won_a: 2, current_set: 3, last_event_type: 'point' })
    const finalSets = [{ set: 1, home: 25, away: 4 }, { set: 2, home: 25, away: 0 }, { set: 3, home: 25, away: 0 }]
    const ended = { ...live, match_status: 'ended', sets_won_a: 3, points_a: 25, last_event_type: 'match_end', matches: { set_results: finalSets } }
    api.responses = [[live], [ended]]
    render(<LivescoreApp />)
    await flush()
    fireEvent.click(screen.getByText('Home a'))

    // realtime: match ends; the UPDATE carries only live-state columns
    act(() => rt.handler({
      eventType: 'UPDATE',
      new: { match_id: 'a', match_status: 'ended', sets_won_a: 3, points_a: 25, last_event_type: 'match_end', set_results: [] },
      old: {}
    }))
    expect(screen.getByText('FINAL')).toBeInTheDocument()
    expect(screen.queryByText('25-4')).toBeNull()

    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(api.calls).toBe(2)
    expect(screen.getByText('25-4')).toBeInTheDocument()
    expect(screen.getAllByText('25-0')).toHaveLength(2)

    // filled: no further refetches
    await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
    expect(api.calls).toBe(2)
  })

  it('a match already finished at load is not refetched in a loop', async () => {
    vi.useFakeTimers()
    api.responses = [[row('old', { match_status: 'ended', sets_won_a: 3, matches: { set_results: null } })]]
    render(<LivescoreApp />)
    await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
    expect(api.calls).toBe(1)
  })
})
