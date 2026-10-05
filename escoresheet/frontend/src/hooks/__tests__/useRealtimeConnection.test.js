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

import { useRealtimeConnection, useRelayTablets } from '../useRealtimeConnection'

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
})
