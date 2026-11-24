import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const SEED = 'match_1791215210058_yxkc82'

const h = vi.hoisted(() => {
  const state = { relayCallback: null, channels: [], fetchResolvers: [], uuid: 'uuid-1', lookups: 0 }
  const makeChannel = (name) => {
    const ch = {
      name,
      bindings: [],
      statusCb: null,
      on(type, filter, cb) { this.bindings.push({ filter, cb }); return this },
      subscribe(cb) { this.statusCb = cb; return this }
    }
    state.channels.push(ch)
    return ch
  }
  return {
    state,
    supabase: { channel: vi.fn(makeChannel), removeChannel: vi.fn() },
    subscribeToMatchData: vi.fn((id, cb) => { state.relayCallback = cb; return vi.fn() }),
    getMatchData: vi.fn(() => new Promise((resolve) => state.fetchResolvers.push(resolve))),
    fetchRelayConnections: vi.fn(async () => null)
  }
})

vi.mock('../../lib/supabaseClient', () => ({ supabase: h.supabase }))
vi.mock('../../lib/apiClient', () => ({
  apiFrom: () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => {
          h.state.lookups += 1
          return { data: h.state.uuid ? { id: h.state.uuid } : null, error: null }
        }
      })
    })
  })
}))
vi.mock('../../utils/serverDataSync', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    subscribeToMatchData: h.subscribeToMatchData,
    getMatchData: h.getMatchData,
    fetchRelayConnections: h.fetchRelayConnections
  }
})

import { useRealtimeConnection, useRelayTablets, RELAY_BUNDLE_COVERS_MS } from '../useRealtimeConnection'

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

beforeEach(() => {
  vi.useFakeTimers()
  h.state.channels = []
  h.state.fetchResolvers = []
  h.state.relayCallback = null
  h.state.uuid = 'uuid-1'
  h.state.lookups = 0
  h.supabase.channel.mockClear()
  h.getMatchData.mockClear()
  h.subscribeToMatchData.mockClear()
  localStorage.clear()
})
afterEach(() => vi.useRealTimers())

describe('useRealtimeConnection AUTO mode', () => {
  it('follows db changes next to the relay room (the bench used to freeze when the relay room stayed empty)', async () => {
    const onData = vi.fn()
    renderHook(() => useRealtimeConnection({ matchId: SEED, onData }))
    await act(flush)
    expect(h.subscribeToMatchData).toHaveBeenCalledWith(SEED, expect.any(Function))
    const ch = h.state.channels.at(-1)
    expect(ch).toBeTruthy()
    const tables = ch.bindings.map((b) => b.filter.table).sort()
    expect(tables).toEqual(['events', 'match_live_state', 'matches', 'sets'])

    // A live_state change (one rally) -> one refetch, coalesced
    act(() => {
      ch.bindings.find((b) => b.filter.table === 'match_live_state').cb({ table: 'match_live_state', eventType: 'UPDATE' })
      ch.bindings.find((b) => b.filter.table === 'events').cb({ table: 'events', eventType: 'INSERT' })
    })
    await act(async () => { vi.advanceTimersByTime(300) })
    expect(h.getMatchData).toHaveBeenCalledTimes(1)
    await act(async () => { h.state.fetchResolvers.shift()({ success: true, match: { id: SEED }, sets: [] }) })
    expect(onData).toHaveBeenCalledTimes(1)
  })

  it('refetches when the db stream (re)subscribes, e.g. after a network drop', async () => {
    renderHook(() => useRealtimeConnection({ matchId: SEED, onData: vi.fn() }))
    await act(flush)
    const ch = h.state.channels.at(-1)
    act(() => ch.statusCb('SUBSCRIBED'))
    await act(async () => { vi.advanceTimersByTime(300) })
    expect(h.getMatchData).toHaveBeenCalledTimes(1)
  })

  it('drops a refetch answer that a newer relay push overtook', async () => {
    const onData = vi.fn()
    renderHook(() => useRealtimeConnection({ matchId: SEED, onData }))
    await act(flush)
    const ch = h.state.channels.at(-1)
    act(() => ch.statusCb('SUBSCRIBED'))
    await act(async () => { vi.advanceTimersByTime(300) })
    // relay push arrives while the fetch is in flight
    await act(async () => { vi.advanceTimersByTime(5) })
    act(() => h.state.relayCallback({ match: { id: SEED, from: 'relay' }, sets: [] }))
    await act(async () => { h.state.fetchResolvers.shift()({ success: true, match: { id: SEED, from: 'fetch' }, sets: [] }) })
    expect(onData).toHaveBeenCalledTimes(1)
    expect(onData.mock.calls[0][0].match.from).toBe('relay')
  })

  it('does not read the bundle again for a db change while the relay room pushes new bundles', async () => {
    const onData = vi.fn()
    renderHook(() => useRealtimeConnection({ matchId: SEED, onData }))
    await act(flush)
    const ch = h.state.channels.at(-1)
    const events = ch.bindings.find((b) => b.filter.table === 'events')
    // The scorer's sync: a new bundle on the relay socket, then its db rows
    act(() => h.state.relayCallback({ match: { id: SEED }, sets: [], events: [{ seq: 1 }] }))
    act(() => events.cb({ table: 'events', eventType: 'INSERT' }))
    await act(async () => { vi.advanceTimersByTime(300) })
    expect(h.getMatchData).not.toHaveBeenCalled()
    expect(onData).toHaveBeenCalledTimes(1)

    // A re-delivery of the same bundle with a live state is no new bundle:
    // once the last new one is old, a db change is read as before
    await act(async () => { vi.advanceTimersByTime(RELAY_BUNDLE_COVERS_MS) })
    act(() => h.state.relayCallback({ ...onData.mock.calls[0][0], liveState: { pointsA: 1 } }))
    act(() => events.cb({ table: 'events', eventType: 'INSERT' }))
    await act(async () => { vi.advanceTimersByTime(300) })
    expect(h.getMatchData).toHaveBeenCalledTimes(1)
  })

  it('still refetches when the db stream (re)subscribes right after a relay bundle', async () => {
    renderHook(() => useRealtimeConnection({ matchId: SEED, onData: vi.fn() }))
    await act(flush)
    const ch = h.state.channels.at(-1)
    act(() => h.state.relayCallback({ match: { id: SEED }, sets: [], events: [] }))
    act(() => ch.bindings.find((b) => b.filter.table === 'sets').cb({ table: 'sets', eventType: 'UPDATE' }))
    act(() => ch.statusCb('SUBSCRIBED'))
    await act(async () => { vi.advanceTimersByTime(300) })
    expect(h.getMatchData).toHaveBeenCalledTimes(1)
  })

  it('looks up a match missing from the database with backoff, and stops on a server without a db stream', async () => {
    h.state.uuid = null
    renderHook(() => useRealtimeConnection({ matchId: SEED, onData: vi.fn() }))
    await act(flush)
    expect(h.state.lookups).toBe(1)
    // 5 s, 10 s, 30 s, then 60 s: not a lookup every 5 s
    await act(async () => { vi.advanceTimersByTime(5000) })
    await act(flush)
    expect(h.state.lookups).toBe(2)
    await act(async () => { vi.advanceTimersByTime(9000) })
    await act(flush)
    expect(h.state.lookups).toBe(2)
    await act(async () => { vi.advanceTimersByTime(1000) })
    await act(flush)
    expect(h.state.lookups).toBe(3)
    await act(async () => { vi.advanceTimersByTime(30000) })
    await act(flush)
    expect(h.state.lookups).toBe(4)
    await act(async () => { vi.advanceTimersByTime(59000) })
    await act(flush)
    expect(h.state.lookups).toBe(4)
    await act(async () => { vi.advanceTimersByTime(1000) })
    await act(flush)
    expect(h.state.lookups).toBe(5)
    // A LAN relay: the shim reports no live db support -> no more lookups
    const ch = h.state.channels.at(-1)
    const err = Object.assign(new Error('unsupported'), { code: 'unsupported' })
    act(() => ch.statusCb('CHANNEL_ERROR', err))
    await act(async () => { vi.advanceTimersByTime(600000) })
    await act(flush)
    expect(h.state.lookups).toBe(5)
  })

  it('the referee can opt out (it runs its own live_state channel)', async () => {
    renderHook(() => useRealtimeConnection({ matchId: SEED, onData: vi.fn(), watchDbChanges: false }))
    await act(flush)
    expect(h.supabase.channel).not.toHaveBeenCalled()
  })
})

describe('useRelayTablets', () => {
  it('polls the relay for this match only while enabled', async () => {
    h.fetchRelayConnections.mockResolvedValue({ clients: [{ role: 'referee', matchId: SEED }] })
    const { result, rerender } = renderHook(({ enabled }) => useRelayTablets(SEED, {}, { enabled, intervalMs: 1000 }), { initialProps: { enabled: true } })
    await act(flush)
    expect(result.current.referee).toBe(1)
    expect(h.fetchRelayConnections).toHaveBeenCalledWith(SEED)
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(h.fetchRelayConnections).toHaveBeenCalledTimes(2)
    rerender({ enabled: false })
    await act(async () => { vi.advanceTimersByTime(5000) })
    expect(h.fetchRelayConnections).toHaveBeenCalledTimes(2)
    expect(result.current.referee).toBe(0)
  })

  // perf pass 22.11.2026: every answer is a new object, and its holder (the
  // header's tablet chip) rendered again every 10 s for the same tablets
  it('the same tablets again set no state; a new list, no answer or an answer again do', async () => {
    h.fetchRelayConnections.mockClear()
    const referee = { clients: [{ role: 'referee', matchId: SEED, proved: true }] }
    let renders = 0
    h.fetchRelayConnections.mockResolvedValue(null)
    const { result } = renderHook(() => { renders++; return useRelayTablets(SEED, {}, { intervalMs: 1000 }) })
    await act(flush)
    expect(result.current.reachable).toBe(false)
    const quiet = renders
    // null again: nothing
    await act(async () => { vi.advanceTimersByTime(1000) })
    await act(flush)
    expect(renders).toBe(quiet)

    // null to a list
    h.fetchRelayConnections.mockResolvedValue(referee)
    await act(async () => { vi.advanceTimersByTime(1000) })
    await act(flush)
    expect(result.current.reachable).toBe(true)
    expect(result.current.referee).toBe(1)
    const shown = result.current
    const afterList = renders

    // the same tablets, a new object (and other fields that nobody reads): nothing
    h.fetchRelayConnections.mockResolvedValue({ ...referee, clients: [{ ...referee.clients[0] }], totalClients: 9 })
    await act(async () => { vi.advanceTimersByTime(3000) })
    await act(flush)
    expect(h.fetchRelayConnections).toHaveBeenCalledTimes(6)
    expect(renders).toBe(afterList)
    expect(result.current).toBe(shown)

    // another list: shown
    h.fetchRelayConnections.mockResolvedValue({ clients: [...referee.clients, { role: 'bench', team: 'home', matchId: SEED, proved: true }] })
    await act(async () => { vi.advanceTimersByTime(1000) })
    await act(flush)
    expect(result.current.benchHome).toBe(1)

    // an empty list is an answer, not none
    h.fetchRelayConnections.mockResolvedValue({ clients: [] })
    await act(async () => { vi.advanceTimersByTime(1000) })
    await act(flush)
    expect(result.current.reachable).toBe(true)
    expect(result.current.referee).toBe(0)

    // the list to no answer (relay unreachable)
    h.fetchRelayConnections.mockResolvedValue(null)
    await act(async () => { vi.advanceTimersByTime(1000) })
    await act(flush)
    expect(result.current.reachable).toBe(false)
    expect(result.current.connections).toBeNull()
  })

  it('paused (the in-app view open): no poll, what was seen stays; asked again at once on resume', async () => {
    h.fetchRelayConnections.mockClear()
    h.fetchRelayConnections.mockResolvedValue({ clients: [{ role: 'referee', matchId: SEED, proved: true }] })
    const { result, rerender } = renderHook(({ paused }) => useRelayTablets(SEED, {}, { intervalMs: 1000, paused }), { initialProps: { paused: false } })
    await act(flush)
    expect(result.current.referee).toBe(1)
    expect(h.fetchRelayConnections).toHaveBeenCalledTimes(1)

    rerender({ paused: true })
    await act(async () => { vi.advanceTimersByTime(10000) })
    await act(flush)
    expect(h.fetchRelayConnections).toHaveBeenCalledTimes(1)
    // kept, not "not connected" (disabled would say so)
    expect(result.current.referee).toBe(1)
    expect(result.current.reachable).toBe(true)

    h.fetchRelayConnections.mockResolvedValue({ clients: [] })
    rerender({ paused: false })
    await act(flush)
    expect(h.fetchRelayConnections).toHaveBeenCalledTimes(2)
    expect(result.current.referee).toBe(0)
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(h.fetchRelayConnections).toHaveBeenCalledTimes(3)
  })

  it('disabled while paused: no tablets', async () => {
    h.fetchRelayConnections.mockClear()
    h.fetchRelayConnections.mockResolvedValue({ clients: [{ role: 'referee', matchId: SEED, proved: true }] })
    const { result, rerender } = renderHook(({ enabled, paused }) => useRelayTablets(SEED, {}, { enabled, intervalMs: 1000, paused }), { initialProps: { enabled: true, paused: false } })
    await act(flush)
    expect(result.current.referee).toBe(1)
    rerender({ enabled: false, paused: true })
    await act(flush)
    expect(result.current.referee).toBe(0)
    expect(result.current.connections).toBeNull()
    // enabled again: the same tablets are shown again
    rerender({ enabled: true, paused: false })
    await act(flush)
    expect(result.current.referee).toBe(1)
  })
})
