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

// apiFrom('match_live_state').select().eq().gte().order() -> next queued response
const api = vi.hoisted(() => ({ responses: [], calls: 0, filters: [] }))
vi.mock('../lib/apiClient', () => ({
  apiFrom: () => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      gte: (column, value) => { api.filters.push({ type: 'gte', column, value }); return chain },
      order: () => {
        api.calls++
        const r = api.responses.length > 1 ? api.responses.shift() : api.responses[0]
        if (r && r.fail) return Promise.resolve({ data: null, error: { message: r.fail } })
        return Promise.resolve({ data: structuredClone(r), error: null })
      }
    }
    return chain
  }
}))

// Realtime shim: capture the postgres_changes handlers by table
// (rt.handler = match_live_state, rt.handlers.matches = matches)
const rt = vi.hoisted(() => ({ handler: null, handlers: {}, subscribed: null }))
vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    channel: () => {
      const ch = {
        on: (_type, filter, cb) => {
          rt.handlers[filter.table] = cb
          if (filter.table === 'match_live_state') rt.handler = cb
          return ch
        },
        subscribe: (cb) => { rt.subscribed = cb; return ch }
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
    api.filters = []
    rt.handler = null
    rt.handlers = {}
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

  it('never blocks the public viewer with "Screen too small" (laptops, short tablets, phones)', async () => {
    api.responses = [[row('a', { points_a: 5, points_b: 3, last_event_type: 'point' })]]
    for (const [w, h] of [[1366, 625], [1024, 600], [844, 390], [320, 568]]) {
      window.innerWidth = w
      window.innerHeight = h
      const { unmount } = render(<LivescoreApp />)
      await flush()
      expect(screen.queryByText('Screen too small')).toBeNull()
      fireEvent.click(screen.getByText('Home a'))
      expect(screen.queryByText('Screen too small')).toBeNull()
      unmount()
    }
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
    expect(screen.getByText('Final')).toBeInTheDocument()
    expect(screen.queryByText('25–4')).toBeNull()

    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(api.calls).toBe(2)
    expect(screen.getByText('25–4')).toBeInTheDocument()
    expect(screen.getAllByText('25–0')).toHaveLength(2)

    // filled: no further refetches
    await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
    expect(api.calls).toBe(2)
  })

  it('an undo before Start Set does not list the match', async () => {
    api.responses = [[row('a')]]
    render(<LivescoreApp />)
    await flush()
    // the scorer undoes a lineup / captain / rotation: handleUndo syncs 'undo'
    act(() => rt.handler({ eventType: 'UPDATE', new: { match_id: 'a', last_event_type: 'undo' }, old: {} }))
    act(() => rt.handler({ eventType: 'UPDATE', new: { match_id: 'a', last_event_type: 'sanction' }, old: {} }))
    expect(screen.queryByText('Home a')).toBeNull()
    expect(screen.getByText('No live games')).toBeInTheDocument()
  })

  it('FINAL set scores arrive with the realtime matches UPDATE, before any refetch', async () => {
    vi.useFakeTimers()
    const live = row('a', { points_a: 24, sets_won_a: 2, current_set: 3, last_event_type: 'point' })
    api.responses = [[live]]
    render(<LivescoreApp />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    fireEvent.click(screen.getByText('Home a'))
    act(() => rt.handler({
      eventType: 'UPDATE',
      new: { match_id: 'a', match_status: 'ended', sets_won_a: 3, points_a: 25, last_event_type: 'match_end', set_results: [] },
      old: {}
    }))
    expect(screen.queryByText('25–4')).toBeNull()
    act(() => rt.handlers.matches({
      eventType: 'UPDATE',
      new: { id: 'a', set_results: [{ set: 1, home: 25, away: 4 }, { set: 2, home: 25, away: 0 }, { set: 3, home: 25, away: 0 }] },
      old: {}
    }))
    expect(screen.getByText('25–4')).toBeInTheDocument()
    expect(api.calls).toBe(1)
    // filled: the safety-net refetch never runs
    await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
    expect(api.calls).toBe(1)
  })

  it('a failed refetch keeps the last good list with a notice', async () => {
    api.responses = [[row('a', { points_a: 5, last_event_type: 'point' })]]
    render(<LivescoreApp />)
    await flush()
    expect(screen.getByText('Home a')).toBeInTheDocument()
    // the realtime socket reconnects and the catch-up refetch fails (429)
    api.responses = [{ fail: 'HTTP 429' }]
    await act(async () => { rt.subscribed('SUBSCRIBED'); await Promise.resolve() })
    expect(screen.getByText('Home a')).toBeInTheDocument()
    expect(screen.queryByText('HTTP 429')).toBeNull()
    expect(screen.getByRole('status').textContent).toMatch(/last known scores/)
  })

  it('a failed first load shows the error view with Change server', async () => {
    api.responses = [{ fail: 'unreachable' }]
    render(<LivescoreApp />)
    await flush()
    expect(screen.getByText('unreachable')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Change server'))
    expect(screen.getByText('Connect to Server')).toBeInTheDocument()
  })

  it('a best-of-3 decider is set 3; FINAL counts the sets Team B won; FINAL games are not counted live', async () => {
    const now = Date.now()
    const decider = row('a', { best_of: 3, current_set: 5, sets_won_a: 1, sets_won_b: 1, points_a: 8, points_b: 5, last_event_type: 'point', updated_at: new Date(now).toISOString() })
    // the live row of game 991303: B's sets never counted (old scoreboard)
    const finished = row('b', {
      best_of: 3, current_set: 5, match_status: 'ended', sets_won_a: 1, sets_won_b: 1, points_a: 10, points_b: 15,
      last_event_type: 'match_end', updated_at: new Date(now).toISOString(),
      matches: { set_results: [{ set: 1, home: 25, away: 2 }, { set: 2, home: 18, away: 25 }, { set: 5, home: 10, away: 15 }] }
    })
    // abandoned in January (stuck at 'Set 4', interval)
    const stuck = row('c', { current_set: 4, match_status: 'interval', sets_won_a: 2, updated_at: '2026-01-29T19:00:00Z' })
    api.responses = [[decider, finished, stuck]]
    render(<LivescoreApp />)
    await flush()
    expect(api.filters.some((f) => f.column === 'updated_at')).toBe(true)
    // the restyled list row: set number in the status pill, sets in the meta line
    expect(screen.getByText('Set 3')).toBeInTheDocument()
    expect(screen.getByText('Sets: 1 – 1')).toBeInTheDocument()
    expect(screen.queryByText('Home c')).toBeNull()
    expect(screen.getByTestId('header').textContent).toContain('1 game live')
    fireEvent.click(screen.getByText('Home b'))
    expect(screen.getByText('Final')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('10–15')).toBeInTheDocument()
    fireEvent.click(screen.getByText('back'))
    fireEvent.click(screen.getByText('Home a'))
    expect(screen.getByText('SET').nextSibling.textContent).toBe('3')
  })

  it('a match already finished at load is not refetched in a loop', async () => {
    vi.useFakeTimers()
    api.responses = [[row('old', { match_status: 'ended', sets_won_a: 3, matches: { set_results: null } })]]
    render(<LivescoreApp />)
    await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
    expect(api.calls).toBe(1)
  })

  it('shows finished sets during the match and labels the set break', async () => {
    const results = [{ set: 1, home: 25, away: 13 }]
    api.responses = [[row('a', { current_set: 2, sets_won_a: 1, points_a: 0, points_b: 0, last_event_type: 'set_end', set_interval_active: true, matches: { set_results: results } })]]
    render(<LivescoreApp />)
    await flush()
    // list: the chip and the break label, the main digits are the points (0 : 0), not the set count
    expect(screen.getByText('25–13')).toBeInTheDocument()
    expect(screen.getByText('Set break')).toBeInTheDocument()
    expect(screen.getByText('Sets: 1 – 0')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Home a'))
    expect(screen.getByText('25–13')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Set break')

    // play resumes: no label, the chip stays
    act(() => rt.handler({ eventType: 'UPDATE', new: { match_id: 'a', set_interval_active: false, points_a: 1, last_event_type: 'point' }, old: {} }))
    expect(screen.queryByText('Set break')).toBeNull()
    expect(screen.getByText('25–13')).toBeInTheDocument()

    // a running timeout is labelled
    act(() => rt.handler({ eventType: 'UPDATE', new: { match_id: 'a', timeout_active: true, match_status: 'timeout', last_event_type: 'timeout' }, old: {} }))
    expect(screen.getByText('Timeout')).toBeInTheDocument()
  })

  it('match end: the set_end frame does not flip the sides before the match_end frame', async () => {
    api.responses = [[row('a', {
      current_set: 3, sets_won_a: 2, points_a: 24, points_b: 20, side_a: 'right', serving_team: 'right', last_event_type: 'point',
      updated_at: '2026-10-06T08:31:07.000Z', matches: { set_results: [{ set: 1, home: 25, away: 10 }, { set: 2, home: 25, away: 12 }], coin_toss: { team_a: 'home' } }
    })]]
    render(<LivescoreApp />)
    await flush()
    fireEvent.click(screen.getByText('Home a'))
    const sides = () => screen.getAllByText(/^(Home a|Away a)$/).map((n) => n.textContent)
    expect(sides()).toEqual(['Away a', 'Home a'])

    act(() => rt.handler({ eventType: 'UPDATE', old: {}, new: { match_id: 'a', match_status: 'ended', last_event_type: 'set_end', points_a: 0, points_b: 0, sets_won_a: 3, side_a: 'left', serving_team: 'left', set_interval_active: true, updated_at: '2026-10-06T08:31:17.000Z' } }))
    expect(screen.getByText('Final')).toBeInTheDocument()
    expect(sides()).toEqual(['Away a', 'Home a'])
    expect(screen.getAllByText(/^\d+–\d+$/).map((n) => n.textContent)).toEqual(['10–25', '12–25'])

    act(() => rt.handler({ eventType: 'UPDATE', old: {}, new: { match_id: 'a', match_status: 'ended', last_event_type: 'match_end', points_a: 25, points_b: 20, sets_won_a: 3, side_a: 'right', serving_team: 'right', set_interval_active: false, updated_at: '2026-10-06T08:31:18.000Z' } }))
    expect(sides()).toEqual(['Away a', 'Home a'])
  })
})
