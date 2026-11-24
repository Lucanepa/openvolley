// A correction that inserts an entry at a past score renumbers every later
// event (seq + 1). The referee's "Recorded by the scorer" popup announces only
// the inserted entry, not every time-out, substitution and sanction after it.
import 'fake-indexeddb/auto'
import { describe, it, expect, vi } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback, opts) => {
    let s = typeof fallback === 'string' ? fallback : key
    const o = typeof fallback === 'object' ? fallback : opts
    if (o) for (const [k, v] of Object.entries(o)) s = s.replace(`{{${k}}}`, v)
    return s
  }, i18n: { language: 'en', changeLanguage: () => {} } })
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
const { buildMatch, MATCH, HOME_TEAM, AWAY_TEAM } = await import('../../domain/__tests__/fixtures/correctionsMatch')
const { default: Referee } = await import('../../components/Referee')

const SEED = 'match_review_notice_renumber'

const bundleOf = async (matchId) => {
  const events = await db.events.where('matchId').equals(matchId).toArray()
  const setRow = (await db.sets.where('matchId').equals(matchId).toArray())[0]
  return {
    success: true,
    match: { id: SEED, status: 'live', coinTossTeamA: 'home', coinTossTeamB: 'away', firstServe: 'home', bestOf: 5 },
    homeTeam: { name: HOME_TEAM.name, color: HOME_TEAM.color },
    awayTeam: { name: AWAY_TEAM.name, color: AWAY_TEAM.color },
    homePlayers: [1, 2, 3, 4, 5, 6, 7].map(n => ({ number: n })),
    awayPlayers: [11, 12, 13, 14, 15, 16, 17].map(n => ({ number: n })),
    sets: [{ index: 1, homePoints: setRow.homePoints, awayPoints: setRow.awayPoints, finished: false }],
    events
  }
}

describe('referee recorded popup after a correction', () => {
  it('announces only the corrected entry, not the earlier ones again', async () => {
    await db.open()
    await Promise.all(db.tables.map(t => t.clear()))
    // a home time-out at 2 points, an away substitution #12 -> #17 at 4 points
    const { events, sets } = buildMatch({ sets: [{
      points: 'HAAHHAAHH', finished: false,
      extras: [{ at: 2, type: 'timeout', payload: { team: 'home' } }, { at: 4, type: 'substitution', payload: { team: 'away', playerOut: 12, playerIn: 17 } }]
    }] })
    const matchId = await db.matches.add({ ...MATCH, id: undefined, status: 'live', seed_key: SEED })
    for (const s of sets) await db.sets.add({ ...s, id: undefined, matchId })
    for (const e of events) await db.events.add({ ...e, id: undefined, matchId })

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1400 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
    render(<Referee matchId={SEED} onExit={() => {}} isMasterMode={false} />)
    await waitFor(() => expect(relay.fetches.length).toBeGreaterThan(0))
    const first = await bundleOf(matchId)
    await act(async () => { for (const res of relay.fetches.splice(0)) res(first) })
    await act(async () => { await new Promise(r => setTimeout(r, 300)) })
    expect(document.querySelector('[data-testid="referee-recorded-popup"]')).toBeNull()

    // The scorer adds a forgotten home substitution #3 -> #7 at 1:0
    const before = await db.events.where('matchId').equals(matchId).toArray()
    const at = scoreTimeline(before, 1).findIndex(x => x.home === 1 && x.away === 0)
    const plan = planAddSubstitution(before, { setIndex: 1, team: 'home', playerOut: 3, playerIn: 7, at },
      { match: MATCH, homeTeam: HOME_TEAM, awayTeam: AWAY_TEAM, matchId, mode: 'live' })
    expect(plan.error).toBeUndefined()
    await applyCorrectionPlan(plan, { matchId, db, mode: 'live' })

    // the next relay copy reaches the referee
    await act(async () => { window.dispatchEvent(new Event('online')) })
    await waitFor(() => expect(relay.fetches.length).toBeGreaterThan(0))
    const second = await bundleOf(matchId)
    await act(async () => { for (const res of relay.fetches.splice(0)) res(second) })
    await act(async () => { await new Promise(r => setTimeout(r, 400)) })

    const popup = document.querySelector('[data-testid="referee-recorded-popup"]')
    const entries = popup ? [...popup.querySelectorAll('li')].map(li => li.textContent.replace(/\s+/g, ' ').trim()) : []
    expect(entries.length).toBe(1)
    expect(entries.some(e => /#7 in for #3/.test(e))).toBe(true) // the corrected one
  })
})
