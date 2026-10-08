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

// The footer's text: the score read in court order with the team letters
// ("A 20 : 16 B"), as on the scorer screen (parity with OpenBeach a237c69 /
// c1bdf49). It was "(20-16)": left-right numbers with no letters, so after a
// court switch or on the 2nd referee's side nothing said whose 20 it was.
describe('refereeEventLabel (the Last action line)', () => {
  // dynamic import: the helpers are added by this change
  const load = () => import('../refereeLastEvent')
  const t = (key, opts) => {
    const map = {
      'refereeDashboard.events.point': 'Point',
      'refereeDashboard.events.timeout': 'Timeout',
      'refereeDashboard.events.substitution': 'Substitution',
      'refereeDashboard.events.setEnd': `Set ${opts?.set} ended`
    }
    return map[key] ?? key
  }
  // 1st referee: B (away) on the left with 20, A (home) on the right with 16
  const ctx = {
    homeLabel: 'A', awayLabel: 'B', homeShort: 'Volley Home', awayShort: 'Volley Away',
    leftLabel: 'B', rightLabel: 'A', leftPoints: 20, rightPoints: 16, t
  }

  it('prints the score in court order with each side\'s letter', async () => {
    const { refereeEventLabel, courtScore } = await load()
    expect(courtScore(ctx)).toBe('B 20 : 16 A')
    expect(refereeEventLabel({ type: 'point', team: 'away' }, ctx)).toBe('Point B Volley Away (B 20 : 16 A)')
    expect(refereeEventLabel({ type: 'timeout', team: 'home' }, ctx)).toBe('Timeout A Volley Home (B 20 : 16 A)')
    expect(refereeEventLabel({ type: 'substitution', team: 'home', data: { playerOut: 7, playerIn: 12 } }, ctx))
      .toBe('Substitution A Volley Home (B 20 : 16 A): #7 → #12')
  })

  it('the 2nd referee sees the other side first', async () => {
    const { refereeEventLabel } = await load()
    const second = { ...ctx, leftLabel: 'A', rightLabel: 'B', leftPoints: 16, rightPoints: 20 }
    expect(refereeEventLabel({ type: 'point', team: 'away' }, second)).toBe('Point B Volley Away (A 16 : 20 B)')
  })

  it('never prints a bare "(20-16)"', async () => {
    const { refereeEventLabel } = await load()
    for (const type of ['point', 'timeout', 'libero_entry', 'sanction', 'court_captain_designation']) {
      const text = refereeEventLabel({ type, team: 'home', data: { type: 'warning', playerNumber: 4 } }, ctx)
      expect(text).not.toMatch(/\(\d+-\d+\)/)
      expect(text).toContain('(B 20 : 16 A)')
    }
  })

  it('keeps the other lines (sanction short form, set end, nothing for unknown types)', async () => {
    const { refereeEventLabel } = await load()
    expect(refereeEventLabel({ type: 'sanction', team: 'away', data: { type: 'delay_warning', playerNumber: 3 } }, ctx)).toBe('DW B Volley Away (B 20 : 16 A)')
    expect(refereeEventLabel({ type: 'sanction', team: 'away', data: { type: 'penalty', playerNumber: 3 } }, ctx)).toBe('P B Volley Away (B 20 : 16 A) #3')
    expect(refereeEventLabel({ type: 'set_end', data: { setIndex: 2 } }, { ...ctx, setLabel: (i) => i })).toBe('Set 2 ended')
    expect(refereeEventLabel({ type: 'whatever' }, ctx)).toBe('')
    expect(refereeEventLabel(null, ctx)).toBe('')
  })
})
