import { describe, it, expect } from 'vitest'
import {
  lastEventFromLiveState,
  lastEventFromEvents,
  lastEventFromMatchData,
  pickNewerLastEvent
} from '../refereeLastEvent'

const T0 = Date.parse('2026-10-06T10:33:24Z')
const T1 = Date.parse('2026-10-06T10:34:09Z')

describe('lastEventFromLiveState', () => {
  it('uses the scorer time of the action, not the time the row arrived', () => {
    const e = lastEventFromLiveState({
      last_event_type: 'timeout',
      last_event_team: 'away',
      last_event_data: { duration: 30 },
      last_event_ts: new Date(T1).toISOString(),
      updated_at: new Date(T1 + 500).toISOString()
    })
    expect(e).toEqual({ type: 'timeout', team: 'away', data: { duration: 30 }, timestamp: T1 })
  })

  it('falls back to updated_at, then to the given time', () => {
    expect(lastEventFromLiveState({ last_event_type: 'point', updated_at: new Date(T0).toISOString() }).timestamp).toBe(T0)
    expect(lastEventFromLiveState({ last_event_type: 'point' }, { fallbackTs: 42 }).timestamp).toBe(42)
  })

  it('ignores rows whose last event is not shown in the footer', () => {
    expect(lastEventFromLiveState({ last_event_type: 'undo', last_event_ts: T1 })).toBeNull()
    expect(lastEventFromLiveState({ last_event_type: null })).toBeNull()
    expect(lastEventFromLiveState(null)).toBeNull()
  })
})

describe('lastEventFromEvents', () => {
  const events = [
    { type: 'lineup', seq: 1, ts: T0 - 9000, payload: { team: 'home' } },
    { type: 'rally_start', seq: 2, ts: T0 - 5000, payload: {} },
    { type: 'point', seq: 3, ts: T0, setIndex: 1, payload: { team: 'home' } },
    { type: 'timeout', seq: 4, ts: new Date(T1).toISOString(), setIndex: 1, payload: { team: 'away' } },
    { type: 'lineup', seq: 4.1, ts: T1 + 10, payload: { team: 'away' } },
    { type: 'rally_start', seq: 5, ts: T1 + 60000, payload: {} }
  ]

  it('returns the displayable event with the highest sequence', () => {
    const e = lastEventFromEvents(events)
    expect(e.type).toBe('timeout')
    expect(e.team).toBe('away')
    expect(e.timestamp).toBe(T1)
    expect(e.data.setIndex).toBe(1)
  })

  it('keeps payload fields the footer reads (substitution numbers)', () => {
    const e = lastEventFromEvents([{ type: 'substitution', seq: 9, ts: T1, payload: { team: 'home', playerOut: 4, playerIn: 7 } }])
    expect(e.data).toMatchObject({ playerOut: 4, playerIn: 7 })
  })

  it('returns null when nothing is displayable', () => {
    expect(lastEventFromEvents([{ type: 'rally_start', seq: 1, ts: T0 }])).toBeNull()
    expect(lastEventFromEvents([])).toBeNull()
    expect(lastEventFromEvents(undefined)).toBeNull()
  })
})

describe('pickNewerLastEvent', () => {
  const stale = { type: 'point', team: 'home', data: null, timestamp: T0 }
  const fresh = { type: 'timeout', team: 'away', data: null, timestamp: T1 }

  it('replaces a stale line after a reconnect refetch', () => {
    expect(pickNewerLastEvent(stale, fresh)).toBe(fresh)
  })

  it('does not let an older copy overwrite a newer line', () => {
    expect(pickNewerLastEvent(fresh, stale)).toBe(fresh)
  })

  it('handles missing values', () => {
    expect(pickNewerLastEvent(null, fresh)).toBe(fresh)
    expect(pickNewerLastEvent(fresh, null)).toBe(fresh)
    expect(pickNewerLastEvent(null, null)).toBeNull()
  })
})

describe('lastEventFromMatchData', () => {
  it('seeds the line after a reload from a relay bundle without live state', () => {
    const e = lastEventFromMatchData({ liveState: null, events: [{ type: 'point', seq: 3, ts: T0, payload: { team: 'away' } }] })
    expect(e).toMatchObject({ type: 'point', team: 'away', timestamp: T0 })
  })

  it('prefers the newer of the live-state row and the events', () => {
    const liveState = { last_event_type: 'timeout', last_event_team: 'away', last_event_ts: new Date(T1).toISOString() }
    const events = [{ type: 'point', seq: 3, ts: T0, payload: { team: 'home' } }]
    expect(lastEventFromMatchData({ liveState, events }).type).toBe('timeout')
  })
})
