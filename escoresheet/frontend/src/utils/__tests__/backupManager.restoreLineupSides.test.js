import { describe, it, expect, vi } from 'vitest'

// A match restored by its PIN without lineup events: the lineups come from
// the latest synced event. Its lineup_left / lineup_right are by court side;
// its state snapshot has them by team (A / B). The side was guessed from the
// set number (odd: A left), wrong in set 5 whenever its coin toss put B on
// the left, and after the change of courts at 8.

vi.mock('../../db/db', () => ({ db: {} }))
vi.mock('../backendConfig', () => ({ getApiUrl: (p) => `http://backend.test${p}`, getCloudApiUrl: (p) => `http://backend.test${p}` }))
const byPin = vi.hoisted(() => ({ result: null }))
vi.mock('../../lib/apiClient', () => ({
  apiFrom: vi.fn(() => { throw new Error('no /api/db') }),
  apiStorage: { from: vi.fn() },
  apiMatchRestoreByPin: async () => byPin.result
}))

import { fetchMatchByPin } from '../backupManager'

const lineup = (base) => Object.fromEntries(['I', 'II', 'III', 'IV', 'V', 'VI'].map((p, i) => [p, { number: base + i }]))
const numbers = (base) => Object.fromEntries(['I', 'II', 'III', 'IV', 'V', 'VI'].map((p, i) => [p, base + i]))
const HOME = lineup(1) // team A (home)
const AWAY = lineup(11)

function restoreWith(event) {
  byPin.result = {
    data: {
      match: { id: 'uuid', external_id: 'seed', game_n: 12, status: 'live', coin_toss_team_a: 'home' },
      sets: [],
      events: [{ seq: 1, type: 'point', payload: { team: 'home' }, ...event }],
      liveState: null
    },
    error: null
  }
  return fetchMatchByPin('123456', 12)
}
const lineupOf = (out, team) => out.events.find(e => e.type === 'lineup' && e.payload.team === team)?.payload.lineup

describe('fetchMatchByPin: lineups from the latest event go to the right team', () => {
  it('set 5 with B on the left (its coin toss): home (A) has its own lineup', async () => {
    const out = await restoreWith({
      set_index: 5,
      lineup_left: AWAY,
      lineup_right: HOME,
      state_snapshot: { teamAKey: 'home', sideA: 'right', lineupA: HOME, lineupB: AWAY }
    })
    expect(lineupOf(out, 'home')).toEqual(numbers(1))
    expect(lineupOf(out, 'away')).toEqual(numbers(11))
  })

  it('an older row (lineup_left guessed by the set number: A left in set 5) still restores by its snapshot', async () => {
    const out = await restoreWith({
      set_index: 5,
      lineup_left: HOME,
      lineup_right: AWAY,
      state_snapshot: { teamAKey: 'home', sideA: 'right', lineupA: HOME, lineupB: AWAY }
    })
    expect(lineupOf(out, 'home')).toEqual(numbers(1))
    expect(lineupOf(out, 'away')).toEqual(numbers(11))
  })

  it('team A away: the snapshot\'s A lineup is the away team\'s', async () => {
    const out = await restoreWith({
      set_index: 3,
      lineup_left: AWAY,
      lineup_right: HOME,
      state_snapshot: { teamAKey: 'away', sideA: 'left', lineupA: AWAY, lineupB: HOME }
    })
    expect(lineupOf(out, 'home')).toEqual(numbers(1))
    expect(lineupOf(out, 'away')).toEqual(numbers(11))
  })

  it('a snapshot of another set is not used for this set\'s lineups', async () => {
    const out = await restoreWith({
      set_index: 2,
      lineup_left: AWAY,
      lineup_right: HOME,
      state_snapshot: { teamAKey: 'home', currentSetIndex: 3, sideA: 'left', lineupA: lineup(21), lineupB: lineup(31) }
    })
    expect(lineupOf(out, 'home')).toEqual(numbers(1))
    expect(lineupOf(out, 'away')).toEqual(numbers(11))
  })

  it('an event without a snapshot: by the set number as before (set 2: A right)', async () => {
    const out = await restoreWith({ set_index: 2, lineup_left: AWAY, lineup_right: HOME })
    expect(lineupOf(out, 'home')).toEqual(numbers(1))
  })
})
