// The referee tablet takes a team's current line-up from the line-up event
// with the highest seq, not the last one in the order the relay bundle lists
// them (the scorer's Dexie primary-key order). A correction that adds a
// forgotten substitution at a past score writes the new rows with the highest
// ids but a seq in the middle of the set, and only renumbers the later rows in
// place. The scorer (and the bench, MatchEntry sorts by seq) shows the current
// rotation; so must the referee.
import 'fake-indexeddb/auto'
import { describe, it, expect, vi } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key), i18n: { language: 'en', changeLanguage: () => {} } })
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
vi.mock('../../lib/apiClient', async (importOriginal) => ({
  ...(await importOriginal()),
  apiFrom: () => {
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: null, error: null }) }
    return q
  }
}))
vi.mock('../../hooks/useScaledLayout', () => ({ useScaledLayout: () => ({ vmin: (v) => v * 10, scaleFactor: 1 }) }))
vi.mock('../../components/WsDebugOverlay', () => ({ default: () => null }))
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

const { db } = await import('../../db/db')
const { applyCorrectionPlan } = await import('../../services/corrections/applyCorrectionPlan')
const { planAddSubstitution, scoreTimeline } = await import('../../domain/manualCorrections')
const { compareBySeq } = await import('../../domain/describe')
const { buildMatch, MATCH, HOME_TEAM, AWAY_TEAM } = await import('../../domain/__tests__/fixtures/correctionsMatch')
const { default: Referee } = await import('../../components/Referee')

const SEED = 'match_review_lineup_order'

function homeDiscs() {
  const out = {}
  for (const el of document.querySelectorAll('[data-player-disc]')) {
    const n = Number(el.querySelector('[data-disc-number]')?.textContent)
    if (Number.isFinite(n) && n < 10) out[el.getAttribute('data-player-disc')] = n
  }
  return out
}

describe('referee line-up after a mid-set correction', () => {
  it('shows the current rotation after a correction at a past score', async () => {
    await db.open()
    await Promise.all(db.tables.map(t => t.clear()))
    // set 1 in play, 5:4; home rotates on its side-outs
    const { events, sets } = buildMatch({ sets: [{ points: 'HAAHHAAHH', finished: false }] })
    const matchId = await db.matches.add({ ...MATCH, id: undefined, status: 'live', seed_key: SEED })
    for (const s of sets) await db.sets.add({ ...s, id: undefined, matchId })
    for (const e of events) await db.events.add({ ...e, id: undefined, matchId })
    const before = await db.events.where('matchId').equals(matchId).toArray()

    // The scorer adds a forgotten home substitution at 1:0 (timeline entry 1)
    const tl = scoreTimeline(before, 1)
    const at = tl.findIndex(x => x.home === 1 && x.away === 0)
    const plan = planAddSubstitution(before, { setIndex: 1, team: 'home', playerOut: 3, playerIn: 7, at },
      { match: MATCH, homeTeam: HOME_TEAM, awayTeam: AWAY_TEAM, matchId, mode: 'live' })
    expect(plan.error).toBeUndefined()
    await applyCorrectionPlan(plan, { matchId, db, mode: 'live' })

    // What the scorer's relay sync sends (Scoreboard.jsx:1954): primary-key order
    const after = await db.events.where('matchId').equals(matchId).toArray()
    const homeLineups = after.filter(e => e.type === 'lineup' && e.setIndex === 1 && e.payload?.team === 'home')
    const scorerCurrent = [...homeLineups].sort(compareBySeq).at(-1).payload.lineup // Scoreboard / bench: by seq
    const lastInArray = homeLineups.at(-1).payload.lineup // Referee.jsx:1447-1454

    const setRow = (await db.sets.where('matchId').equals(matchId).toArray())[0]
    const bundle = {
      success: true,
      match: { id: SEED, status: 'live', coinTossTeamA: 'home', coinTossTeamB: 'away', firstServe: 'home', bestOf: 5 },
      homeTeam: { name: HOME_TEAM.name, color: HOME_TEAM.color },
      awayTeam: { name: AWAY_TEAM.name, color: AWAY_TEAM.color },
      homePlayers: [1, 2, 3, 4, 5, 6, 7].map(n => ({ number: n })),
      awayPlayers: [11, 12, 13, 14, 15, 16].map(n => ({ number: n })),
      sets: [{ index: 1, homePoints: setRow.homePoints, awayPoints: setRow.awayPoints, finished: false }],
      events: after
    }
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1400 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
    render(<Referee matchId={SEED} onExit={() => {}} isMasterMode={false} />)
    await waitFor(() => expect(relay.fetches.length).toBeGreaterThan(0))
    await act(async () => { for (const res of relay.fetches.splice(0)) res(bundle) })
    await act(async () => { await new Promise(r => setTimeout(r, 300)) })

    const shown = homeDiscs()
    const asNumbers = (l) => Object.fromEntries(Object.entries(l).map(([k, v]) => [k, Number(typeof v === 'object' ? v.number : v)]))
    expect(asNumbers(scorerCurrent)).not.toEqual(asNumbers(lastInArray))
    // The referee draws the scorer's current rotation, not the stale row
    expect(shown).toEqual(asNumbers(scorerCurrent))
  })
})
