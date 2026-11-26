import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act, waitFor, cleanup } from '@testing-library/react'

// The referee in the break between two sets (full-match test 21.11.2026).
// After a set end the scorer's bundle has no row for the next set yet, and
// often no other bundle follows before the next line-ups: the referee kept
// the previous set's sides with the SERVE box on the team that had served
// last, while the other team serves the next set.

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

// Team A is home (HOM, left in set 1, serves first in set 1), team B away (AWY)
const MATCH = { id: 'match_seed', status: 'live', bestOf: 5, coinTossTeamA: 'home', coinTossTeamB: 'away', firstServe: 'home', homeShortName: 'HOM', awayShortName: 'AWY', homeName: 'Home VC', awayName: 'Away VC' }
const fin = (index, homePoints, awayPoints) => ({ index, homePoints, awayPoints, finished: true })
const point = (setIndex, team, seq) => ({ type: 'point', setIndex, seq, payload: { team } })

function bundle({ sets, events = [], liveState = null, match = {} }) {
  return {
    success: true,
    match: { ...MATCH, ...match },
    homeTeam: { name: 'Home VC', color: '#2563eb' },
    awayTeam: { name: 'Away VC', color: '#dc2626' },
    homePlayers: [1, 2, 3, 4, 5, 6].map(number => ({ number })),
    awayPlayers: [11, 12, 13, 14, 15, 16].map(number => ({ number })),
    sets,
    events,
    liveState: liveState && { team_a_name: 'Home VC', team_b_name: 'Away VC', best_of: 5, points_a: 0, points_b: 0, ...liveState }
  }
}

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 200)) })

async function mount(b) {
  render(<Referee matchId="match_seed" onExit={() => {}} isMasterMode={false} />)
  await waitFor(() => expect(relay.onData || relay.subscriber).toBeTypeOf('function'))
  const push = relay.onData || relay.subscriber
  await act(async () => { push(b) })
  await settle()
  await waitFor(() => expect(document.querySelector('[data-score-row]')).not.toBeNull())
}

// The header names the left team first (by its full name; HOM / AWY below
// are the tests' labels for the two teams)
const leftTeam = () => {
  const text = document.body.textContent
  return text.indexOf('Home VC') < text.indexOf('Away VC') ? 'HOM' : 'AWY'
}
const serveSide = () => document.querySelector('[data-serve-block]')?.getAttribute('data-serve-block') ?? null
// The header's "SET n" and the big score ("SETS" over it in the interval)
const shownSet = () => [...document.querySelectorAll('span')].find(e => e.textContent === 'SET')?.nextElementSibling?.textContent ?? null
const shownScore = () => [...document.querySelectorAll('[data-score] span')].map(e => e.textContent).join('')
const caption = () => document.querySelector('[data-score-caption]')?.textContent ?? null

describe('Referee in the break: the next set\'s sides and server', () => {
  beforeEach(() => { cleanup(); relay.subscriber = null; relay.onData = null })

  it('set 1 ended, set 2 not in the bundle yet: AWY on the left serves set 2', async () => {
    await mount(bundle({
      sets: [fin(1, 25, 0)],
      events: [point(1, 'home', 1)],
      // the set end's push: set 2, Team A on the right, the left team serves
      liveState: { current_set: 2, side_a: 'right', serving_team: 'left', sets_won_a: 1, sets_won_b: 0, set_interval_active: true, last_event_type: 'set_end', match_status: 'interval' }
    }))
    expect(leftTeam()).toBe('AWY')
    expect(serveSide()).toBe('left')
  })

  it('without a live state: the scorer\'s rule (set 3: HOM back on the left, HOM serves)', async () => {
    await mount(bundle({ sets: [fin(1, 25, 0), fin(2, 20, 25)], events: [point(1, 'home', 1), point(2, 'away', 2)] }))
    expect(leftTeam()).toBe('HOM')
    expect(serveSide()).toBe('left')
  })

  it('the deciding set before its coin toss: set 4\'s sides and no SERVE box', async () => {
    await mount(bundle({
      sets: [fin(1, 25, 0), fin(2, 20, 25), fin(3, 25, 20), fin(4, 22, 25)],
      // the set 4 end writes set 5 defaults on the match: no coin toss yet
      match: { set5LeftTeam: 'B', set5FirstServe: 'B' },
      liveState: { current_set: 5, side_a: 'right', serving_team: 'right', sets_won_a: 2, sets_won_b: 2, set_interval_active: true, last_event_type: 'set_end', match_status: 'interval' }
    }))
    // set 4: Team A (HOM) on the right
    expect(leftTeam()).toBe('AWY')
    expect(serveSide()).toBe(null)
  })
})

// "SET 1 · 0:0" for about a second at a set change (sets 3 and 4 on the
// full-match test): the bundle with the set finished and no next set row,
// and a live state without the break flag (the last point's, or a push made
// before the scorer's break ran)
describe('Referee at a set change: never set 1 while no set is open', () => {
  beforeEach(() => { cleanup(); relay.subscriber = null; relay.onData = null })

  const set3Running = bundle({
    sets: [fin(1, 25, 20), fin(2, 20, 25), { index: 3, homePoints: 24, awayPoints: 20, finished: false }],
    events: [point(1, 'home', 1), point(2, 'away', 2), point(3, 'home', 3)],
    liveState: { current_set: 3, side_a: 'left', serving_team: 'left', points_a: 24, points_b: 20, sets_won_a: 1, sets_won_b: 1, set_interval_active: false, last_event_type: 'point', match_status: 'in_progress' }
  })
  const set3Ended = (liveState) => bundle({
    sets: [fin(1, 25, 20), fin(2, 20, 25), fin(3, 25, 20)],
    events: [point(1, 'home', 1), point(2, 'away', 2), point(3, 'home', 3), point(3, 'home', 4)],
    liveState
  })

  it('the set 3 end with the last point\'s live state: set 4 and the sets won (2:1), not SET 1 · 0:0', async () => {
    await mount(set3Running)
    expect(shownSet()).toBe('3')
    expect(shownScore()).toBe('24:20')
    const push = relay.onData || relay.subscriber
    await act(async () => {
      push(set3Ended({ current_set: 3, side_a: 'left', serving_team: 'left', points_a: 25, points_b: 20, sets_won_a: 1, sets_won_b: 1, set_interval_active: false, last_event_type: 'point', match_status: 'in_progress' }))
    })
    await settle()
    expect(shownSet()).toBe('4')
    expect(caption()).toBe('SETS')
    // set 4: HOM (A) on the right, 2 sets to 1
    expect(leftTeam()).toBe('AWY')
    expect(shownScore()).toBe('1:2')
  })

  it('the set end\'s push, then a push without the break flag on the ended set (as seen at sets 3 and 4): set 4 throughout', async () => {
    await mount(set3Running)
    const push = relay.onData || relay.subscriber
    await act(async () => {
      push(set3Ended({ current_set: 4, side_a: 'right', serving_team: 'left', points_a: 0, points_b: 0, sets_won_a: 2, sets_won_b: 1, set_interval_active: true, last_event_type: 'set_end', match_status: 'interval' }))
    })
    await settle()
    expect(shownSet()).toBe('4')
    expect(shownScore()).toBe('1:2')
    await act(async () => {
      push(set3Ended({ current_set: 3, side_a: 'left', serving_team: 'left', points_a: 25, points_b: 20, sets_won_a: 2, sets_won_b: 1, set_interval_active: false, last_event_type: 'lineup', match_status: 'in_progress' }))
    })
    await settle()
    expect(shownSet()).toBe('4')
    expect(shownScore()).toBe('1:2')
    expect(caption()).toBe('SETS')
    expect(leftTeam()).toBe('AWY')
  })

  it('a live state of the break without its flag (a push the scorer made in the break): still set 4', async () => {
    await mount(set3Ended({ current_set: 4, side_a: 'right', serving_team: 'left', points_a: 0, points_b: 0, sets_won_a: 2, sets_won_b: 1, set_interval_active: false, last_event_type: 'reconnect', match_status: 'in_progress' }))
    expect(shownSet()).toBe('4')
    expect(caption()).toBe('SETS')
  })
})

