import { describe, it, expect } from 'vitest'
import { newerLiveState, isLiveStateNewerThanBundle, createLiveStateTracker } from '../serverDataSync'
import { mergeRefetchedGames } from '../livescoreModel'

// Device A scored until 20:18; device B (clock 5 minutes behind, no internet
// in the hall) continues. The relay stamped every state and bundle it got.
const at = (m) => `2026-10-05T12:${m}:00.000Z`
const stateA = { current_set: 2, points_a: 20, points_b: 18, updated_at: at('30'), _session: 'A', _seq: 90, _relayEpoch: 'E1', _relaySeq: 40 }
const stateB = { current_set: 2, points_a: 22, points_b: 19, updated_at: at('26'), _session: 'B', _seq: 3, _relayEpoch: 'E1', _relaySeq: 44 }

describe('live states of two scorer devices: the relay order, not the clocks', () => {
  it('keeps the new device\'s state although its clock is behind', () => {
    expect(newerLiveState(stateA, stateB)).toBe(stateB)
    expect(newerLiveState(stateB, stateA)).toBe(stateB)
    // another relay run (restart) or no stamp: the clocks, as before
    expect(newerLiveState(stateA, { ...stateB, _relayEpoch: 'E2' })).toBe(stateA)
  })

  it('a bundle of the new device the relay got later replaces the old device\'s state', () => {
    const bundle = { success: true, match: { _syncSession: 'B', _syncedSeq: 4, _syncedAt: Date.parse(at('27')), _relayEpoch: 'E1', _relaySeq: 45, coinTossTeamA: 'home' }, sets: [{ index: 2, homePoints: 22, awayPoints: 19 }], liveState: stateB }
    expect(isLiveStateNewerThanBundle(stateA, bundle)).toBe(false)
    const tracker = createLiveStateTracker()
    tracker.liveState(stateA)
    const shown = tracker.bundle(bundle)
    expect(shown.sets[0]).toMatchObject({ homePoints: 22, awayPoints: 19 })
    expect(shown.liveState._session).toBe('B')
  })
})

describe('livescore refetch against the shown list', () => {
  const now = Date.parse(at('31'))
  it('keeps a newer relay frame over the older database row, with the joined set results', () => {
    const shown = [{ match_id: 'm1', points_a: 5, updated_at: at('30') }]
    const fetched = [{ match_id: 'm1', points_a: 4, updated_at: '2026-10-05T12:29:58.000Z', matches: { set_results: [] } }, { match_id: 'm2', points_a: 1, updated_at: at('30') }]
    const out = mergeRefetchedGames(shown, fetched, now)
    expect(out[0]).toMatchObject({ points_a: 5, matches: { set_results: [] } })
    expect(out[1].match_id).toBe('m2')
  })
  it('takes a newer database row', () => {
    const out = mergeRefetchedGames([{ match_id: 'm1', points_a: 5, updated_at: at('29') }], [{ match_id: 'm1', points_a: 6, updated_at: at('30') }], now)
    expect(out[0].points_a).toBe(6)
  })
})
