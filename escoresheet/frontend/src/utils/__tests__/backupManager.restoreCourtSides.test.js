import { describe, it, expect, vi, beforeEach } from 'vitest'

// A match restored by its PIN (port of OpenBeach 507bb74 + 1c60585):
//  - Team A comes from the coin_toss JSON: the matches table has no
//    coin_toss_team_a column, so reading only that put Team A on away always
//    (the live state's lineups and the no-snapshot event path went to the
//    wrong team whenever A was home).
//  - The restored match keeps its court sides (setLeftTeamOverrides,
//    set5LeftTeam, set5CourtSwitched): without them the scorer's court showed
//    the set number's sides whatever the court was. Set 5's side is its coin
//    toss (set5LeftTeam), never an override [5]: an override would pin the
//    court and the set 5 toss would no longer move the teams.

const store = vi.hoisted(() => ({ matches: [], sets: [], events: [] }))
vi.mock('../../db/db', () => {
  const table = (rows) => ({ add: vi.fn(async (row) => { rows.push(row); return rows.length }) })
  return {
    db: {
      transaction: async (...args) => args[args.length - 1](),
      matches: table(store.matches),
      teams: table([]),
      players: table([]),
      sets: table(store.sets),
      events: table(store.events)
    }
  }
})
vi.mock('../backendConfig', () => ({ getApiUrl: (p) => `http://backend.test${p}`, getCloudApiUrl: (p) => `http://backend.test${p}` }))
const byPin = vi.hoisted(() => ({ result: null }))
vi.mock('../../lib/apiClient', () => ({
  apiFrom: vi.fn(() => { throw new Error('no /api/db') }),
  apiStorage: { from: vi.fn() },
  apiMatchRestoreByPin: async () => byPin.result
}))

import { fetchMatchByPin, importMatchFromSupabase, savedCourtSides } from '../backupManager'
import { getSideAForSet, getFirstServeForSet } from '../../domain/rules'

const lineup = (base) => Object.fromEntries(['I', 'II', 'III', 'IV', 'V', 'VI'].map((p, i) => [p, { number: base + i }]))
const numbers = (base) => Object.fromEntries(['I', 'II', 'III', 'IV', 'V', 'VI'].map((p, i) => [p, base + i]))
const HOME = lineup(1)
const AWAY = lineup(11)
const lineupOf = (out, team) => out.events.find(e => e.type === 'lineup' && e.payload.team === team)?.payload.lineup

function restoreWith({ match = {}, events = [], liveState = null }) {
  byPin.result = {
    data: {
      match: { id: 'uuid', external_id: 'seed', game_n: 12, status: 'live', coin_toss: { team_a: 'home', team_b: 'away', confirmed: true }, ...match },
      sets: [],
      events,
      liveState
    },
    error: null
  }
  return fetchMatchByPin('123456', 12)
}

beforeEach(() => {
  store.matches.length = 0
  store.sets.length = 0
  store.events.length = 0
})

describe('fetchMatchByPin: Team A from the coin_toss JSON', () => {
  it('the live state fallback: A (home) gets lineup_a', async () => {
    const out = await restoreWith({
      liveState: { current_set: 1, side_a: 'left', points_a: 3, points_b: 1, lineup_a: HOME, lineup_b: AWAY }
    })
    expect(lineupOf(out, 'home')).toEqual(numbers(1))
    expect(lineupOf(out, 'away')).toEqual(numbers(11))
  })

  it('an event without a snapshot in set 2 (A right): home has its own lineup', async () => {
    const out = await restoreWith({
      events: [{ seq: 1, type: 'point', set_index: 2, payload: { team: 'home' }, lineup_left: AWAY, lineup_right: HOME }]
    })
    expect(lineupOf(out, 'home')).toEqual(numbers(1))
    expect(lineupOf(out, 'away')).toEqual(numbers(11))
  })

  it('team A away in the JSON: the live state\'s lineup_a is away\'s', async () => {
    const out = await restoreWith({
      match: { coin_toss: { team_a: 'away', team_b: 'home', confirmed: true } },
      liveState: { current_set: 1, side_a: 'left', lineup_a: AWAY, lineup_b: HOME }
    })
    expect(lineupOf(out, 'home')).toEqual(numbers(1))
    expect(lineupOf(out, 'away')).toEqual(numbers(11))
  })

  it('set 5 without a snapshot, B on the left by its coin toss (the live state): home (A) has its own lineup', async () => {
    const out = await restoreWith({
      events: [{ seq: 4, type: 'point', set_index: 5, payload: { team: 'home' }, lineup_left: AWAY, lineup_right: HOME }],
      liveState: { current_set: 5, side_a: 'right', points_a: 3, points_b: 2 }
    })
    expect(lineupOf(out, 'home')).toEqual(numbers(1))
    expect(lineupOf(out, 'away')).toEqual(numbers(11))
  })
})

describe('savedCourtSides: the sides the scorer last saved', () => {
  it('nothing says: {}', () => {
    expect(savedCourtSides([], null, 'home')).toEqual({})
  })

  it('a set 5 snapshot: its coin toss and its change of courts', () => {
    const events = [
      { seq: 1, state_snapshot: { teamAKey: 'home', currentSetIndex: 5, sideA: 'left', set5LeftTeam: 'B', set5CourtSwitched: true } }
    ]
    expect(savedCourtSides(events, null, 'home')).toEqual({ set5LeftTeam: 'B', set5CourtSwitched: true })
  })

  it('the latest snapshot wins', () => {
    const events = [
      { seq: 2, state_snapshot: { teamAKey: 'home', currentSetIndex: 5, sideA: 'right', set5LeftTeam: 'B', set5CourtSwitched: false } },
      { seq: 1, state_snapshot: { teamAKey: 'home', currentSetIndex: 5, sideA: 'left', set5LeftTeam: 'A', set5CourtSwitched: false } }
    ]
    expect(savedCourtSides(events, null, 'home').set5LeftTeam).toBe('B')
  })

  it('a set 1-4 snapshot off the set number\'s side: an override for that set', () => {
    const events = [{ seq: 1, state_snapshot: { teamAKey: 'home', currentSetIndex: 2, sideA: 'left' } }]
    expect(savedCourtSides(events, null, 'home')).toEqual({ setLeftTeamOverrides: { 2: 'A' } })
  })

  it('a set 1-4 snapshot on the set number\'s side: no override', () => {
    const events = [{ seq: 1, state_snapshot: { teamAKey: 'home', currentSetIndex: 2, sideA: 'right' } }]
    expect(savedCourtSides(events, null, 'home')).toEqual({})
  })

  it('a snapshot taken before A and B were swapped: its labels are flipped', () => {
    const events = [{ seq: 1, state_snapshot: { teamAKey: 'away', currentSetIndex: 5, sideA: 'left', set5LeftTeam: 'A' } }]
    expect(savedCourtSides(events, null, 'home').set5LeftTeam).toBe('B')
  })

  it('the snapshot\'s set 5 change of courts not yet saved: the live state\'s side says it was made', () => {
    // a point's snapshot is taken before its change of courts is confirmed
    const events = [{ seq: 1, state_snapshot: { teamAKey: 'home', currentSetIndex: 5, sideA: 'left', set5LeftTeam: 'A', set5CourtSwitched: false } }]
    const sides = savedCourtSides(events, { current_set: 5, side_a: 'right', points_a: 8, points_b: 6 }, 'home')
    expect(sides).toEqual({ set5LeftTeam: 'A', set5CourtSwitched: true })
    expect(getSideAForSet(5, sides)).toBe('right')
  })

  it('live state only, set 1-4 off the set number: an override', () => {
    expect(savedCourtSides([], { current_set: 3, side_a: 'right' }, 'home')).toEqual({ setLeftTeamOverrides: { 3: 'B' } })
  })

  it('live state only, set 5 before the change at 8: its coin toss (set5LeftTeam), not an override', () => {
    const sides = savedCourtSides([], { current_set: 5, side_a: 'right', points_a: 3, points_b: 5 }, 'home')
    expect(sides).toEqual({ set5LeftTeam: 'B', set5CourtSwitched: false })
    expect(sides.setLeftTeamOverrides).toBeUndefined()
  })

  it('live state only, set 5 after the change at 8: the toss side is the other one, switched', () => {
    const sides = savedCourtSides([], { current_set: 5, side_a: 'right', points_a: 9, points_b: 5 }, 'home')
    expect(sides).toEqual({ set5LeftTeam: 'A', set5CourtSwitched: true })
    expect(getSideAForSet(5, sides)).toBe('right')
  })

  it('live state only, set 5: the set 5 coin toss (it writes set5LeftTeam) still moves the teams', () => {
    const sides = savedCourtSides([], { current_set: 5, side_a: 'left', points_a: 0, points_b: 0 }, 'home')
    // the toss of the restored match: B on the left, not changed
    expect(getSideAForSet(5, { ...sides, set5LeftTeam: 'B', set5CourtSwitched: false })).toBe('right')
  })
})

describe('savedCourtSides: corrections made after the latest snapshot', () => {
  // The corrections card's "Switch sides" writes the match row and the live
  // state, no event: until the next rally the latest snapshot is older

  it('A and B swapped after the snapshot (a coin toss correction): each team stays on its side in every set', async () => {
    const { swapTeamDesignation } = await import('../../domain/coinToss')
    const { switchedSides } = await import('../../components/corrections/liveActions')
    // set 2, A = home on the right (the set number's side); then A and B
    // swapped: A = away, nothing moved (home still on the right)
    const events = [{ seq: 7, state_snapshot: { teamAKey: 'home', currentSetIndex: 2, sideA: 'right' } }]
    const sides = savedCourtSides(events, null, 'away')
    const m = { coinTossTeamA: 'away', coinTossTeamB: 'home', firstServe: 'home', ...sides }
    const homeLeft = (match, set) => (getSideAForSet(set, match) === 'left') === (match.coinTossTeamA === 'home')
    // home on the right in set 2, on the left in sets 1 and 3, as before the swap
    expect([1, 2, 3, 4].map(set => homeLeft(m, set))).toEqual([true, false, true, false])
    // swapped back: still nothing moves; "Switch sides" moves the teams
    expect(homeLeft({ ...m, ...swapTeamDesignation(m) }, 2)).toBe(false)
    expect(homeLeft({ ...m, setLeftTeamOverrides: switchedSides(m, 2) }, 2)).toBe(true)
  })

  it('the same during the interval (the snapshot is the set before\'s): the live side for the set, the others kept', () => {
    // live row of the restored Team A (away): set 3, away on the left
    const events = [{ seq: 7, state_snapshot: { teamAKey: 'home', currentSetIndex: 2, sideA: 'right' } }]
    const sides = savedCourtSides(events, { current_set: 3, side_a: 'left', points_a: 0, points_b: 0 }, 'away')
    expect(getSideAForSet(3, sides)).toBe('left')
    // set 2 as the snapshot had it: home (now B) on the right
    expect(getSideAForSet(2, sides)).toBe('left')
  })

  it('set 5 "Switch sides" before 8 after the snapshot: the toss side is the live one, not a change of courts', () => {
    // toss A left; at 5:3 the scorer switched the set 5 sides (set5LeftTeam B)
    const events = [{ seq: 9, state_snapshot: { teamAKey: 'home', currentSetIndex: 5, sideA: 'left', set5LeftTeam: 'A', set5CourtSwitched: false } }]
    const sides = savedCourtSides(events, { current_set: 5, side_a: 'right', points_a: 5, points_b: 3 }, 'home')
    // switched with no team on 8 would ask to change the courts back at the next point
    expect(sides).toEqual({ set5LeftTeam: 'B', set5CourtSwitched: false })
  })

  it('set 5 "Switch sides" after the change at 8: the toss side flips, the change stays made', () => {
    const events = [{ seq: 9, state_snapshot: { teamAKey: 'home', currentSetIndex: 5, sideA: 'right', set5LeftTeam: 'A', set5CourtSwitched: true } }]
    // set5LeftTeam A -> B with the change made: A back on the left
    const sides = savedCourtSides(events, { current_set: 5, side_a: 'left', points_a: 9, points_b: 6 }, 'home')
    expect(sides).toEqual({ set5LeftTeam: 'B', set5CourtSwitched: true })
  })

  it('set 5 at 8, the change not confirmed yet: not switched (the next point asks for it)', () => {
    const events = [{ seq: 9, state_snapshot: { teamAKey: 'home', currentSetIndex: 5, sideA: 'left', set5LeftTeam: 'A', set5CourtSwitched: false } }]
    const sides = savedCourtSides(events, { current_set: 5, side_a: 'left', points_a: 8, points_b: 5 }, 'home')
    expect(sides).toEqual({ set5LeftTeam: 'A', set5CourtSwitched: false })
  })

  it('set 5 back below 8 after the change, the change back not confirmed yet: still switched (the next point asks to change back)', () => {
    const events = [{ seq: 9, state_snapshot: { teamAKey: 'home', currentSetIndex: 5, sideA: 'right', set5LeftTeam: 'A', set5CourtSwitched: true } }]
    const sides = savedCourtSides(events, { current_set: 5, side_a: 'right', points_a: 7, points_b: 7 }, 'home')
    expect(sides).toEqual({ set5LeftTeam: 'A', set5CourtSwitched: true })
  })
})

describe('savedCourtSides: a live row older than the latest snapshot', () => {
  // The scorer's last live state write failed (offline) while the queued
  // events synced later: the live row's side is stale, the snapshot's event
  // newer (both times the scorer device's clock: event created_at from its
  // ts, the live row's last_event_ts). The live side wins over the snapshot
  // only when not older than the snapshot's event (OpenBeach b6ceb0e).
  const at = (m) => `2026-10-08T10:${String(m).padStart(2, '0')}:00.000Z`

  it('sets 1-4: the snapshot\'s side, no override from the stale live side', () => {
    // set 2: snapshot at 10:05 with A on the left (an override); the live row
    // from 10:01 still has A on the right
    const events = [{ seq: 9, created_at: at(5), state_snapshot: { teamAKey: 'home', currentSetIndex: 2, sideA: 'left', setLeftTeamOverrides: { 2: 'A' } } }]
    const sides = savedCourtSides(events, { current_set: 2, side_a: 'right', points_a: 6, points_b: 4, last_event_ts: at(1) }, 'home')
    expect(sides).toEqual({ setLeftTeamOverrides: { 2: 'A' } })
    expect(getSideAForSet(2, sides)).toBe('left')
  })

  it('set 5, a toss side corrected before the stale live row\'s point: the snapshot\'s toss side', () => {
    // live 10:01 B left; the set 5 "Switch sides" (A left) and the point at
    // 10:05 synced, their live writes failed
    const events = [{ seq: 9, created_at: at(5), state_snapshot: { teamAKey: 'home', currentSetIndex: 5, sideA: 'left', set5LeftTeam: 'A', set5CourtSwitched: false } }]
    const sides = savedCourtSides(events, { current_set: 5, side_a: 'right', points_a: 5, points_b: 3, last_event_ts: at(1) }, 'home')
    expect(sides.set5LeftTeam).toBe('A')
    expect(sides.set5CourtSwitched).not.toBe(true)
    expect(getSideAForSet(5, sides)).toBe('left')
  })

  it('set 5, the change at 8 made after the stale live row: still made', () => {
    // live 10:01 at 7:5, A left, not changed; the snapshot at 10:05 has the change
    const events = [{ seq: 12, created_at: at(5), state_snapshot: { teamAKey: 'home', currentSetIndex: 5, sideA: 'right', set5LeftTeam: 'A', set5CourtSwitched: true } }]
    const sides = savedCourtSides(events, { current_set: 5, side_a: 'left', points_a: 7, points_b: 5, last_event_ts: at(1) }, 'home')
    expect(sides).toEqual({ set5LeftTeam: 'A', set5CourtSwitched: true })
    expect(getSideAForSet(5, sides)).toBe('right')
  })

  it('a live row not older than the snapshot (later, or the same time): the live side still wins', () => {
    const events = [{ seq: 9, created_at: at(1), state_snapshot: { teamAKey: 'home', currentSetIndex: 5, sideA: 'left', set5LeftTeam: 'A', set5CourtSwitched: false } }]
    const live = { current_set: 5, side_a: 'right', points_a: 5, points_b: 3 }
    expect(savedCourtSides(events, { ...live, last_event_ts: at(3) }, 'home')).toEqual({ set5LeftTeam: 'B', set5CourtSwitched: false })
    expect(savedCourtSides(events, { ...live, last_event_ts: at(1) }, 'home')).toEqual({ set5LeftTeam: 'B', set5CourtSwitched: false })
  })

  it('a time unknown on either side: the live side wins (as before)', () => {
    const events = [{ seq: 9, state_snapshot: { teamAKey: 'home', currentSetIndex: 5, sideA: 'left', set5LeftTeam: 'A', set5CourtSwitched: false } }]
    expect(savedCourtSides(events, { current_set: 5, side_a: 'right', points_a: 5, points_b: 3, last_event_ts: at(1) }, 'home'))
      .toEqual({ set5LeftTeam: 'B', set5CourtSwitched: false })
  })

  it('the snapshot\'s own event decides, not a newer event without a snapshot', () => {
    // live 10:03 after the snapshot (10:01); a timeout row at 10:05 has no snapshot
    const events = [
      { seq: 10, created_at: at(5), type: 'timeout' },
      { seq: 9, created_at: at(1), state_snapshot: { teamAKey: 'home', currentSetIndex: 5, sideA: 'left', set5LeftTeam: 'A', set5CourtSwitched: false } }
    ]
    expect(savedCourtSides(events, { current_set: 5, side_a: 'right', points_a: 5, points_b: 3, last_event_ts: at(3) }, 'home'))
      .toEqual({ set5LeftTeam: 'B', set5CourtSwitched: false })
  })
})

describe('fetchMatchByPin: a row without a snapshot says its own left team', () => {
  // The row writer marks the serving team's lineup (position I isServing) and
  // names it (serve_team): rows written before 8df87d4e put set 5's sides by
  // the set number (A left before the change), not by the coin toss
  const serving = (l) => ({ ...l, I: { ...l.I, isServing: true } })

  it('set 5, an older row with A (home) on the left although the toss put B left', async () => {
    const out = await restoreWith({
      events: [{ seq: 4, type: 'point', set_index: 5, payload: { team: 'home' }, serve_team: 'home', lineup_left: serving(HOME), lineup_right: AWAY }],
      liveState: { current_set: 5, side_a: 'right', points_a: 3, points_b: 2 }
    })
    expect(lineupOf(out, 'home')).toEqual(numbers(1))
    expect(lineupOf(out, 'away')).toEqual(numbers(11))
  })

  it('the away team serving on the right', async () => {
    const out = await restoreWith({
      events: [{ seq: 4, type: 'point', set_index: 5, payload: { team: 'away' }, serve_team: 'away', lineup_left: HOME, lineup_right: serving(AWAY) }],
      liveState: { current_set: 5, side_a: 'right', points_a: 3, points_b: 4 }
    })
    expect(lineupOf(out, 'home')).toEqual(numbers(1))
    expect(lineupOf(out, 'away')).toEqual(numbers(11))
  })
})

describe('importMatchFromSupabase: the restored match keeps its court sides', () => {
  it('set 5 with B on the left after the change at 8 (live state only)', async () => {
    const cloud = await restoreWith({
      liveState: { current_set: 5, side_a: 'left', points_a: 6, points_b: 8, lineup_a: HOME, lineup_b: AWAY }
    })
    await importMatchFromSupabase(cloud)
    const m = store.matches[0]
    expect(m.set5LeftTeam).toBe('B')
    expect(m.set5CourtSwitched).toBe(true)
    expect(m.setLeftTeamOverrides).toBeUndefined()
    expect(getSideAForSet(5, m)).toBe('left')
  })

  it('a set 2 override from the latest snapshot', async () => {
    const cloud = await restoreWith({
      events: [{ seq: 1, type: 'point', set_index: 2, payload: { team: 'home' }, lineup_left: HOME, lineup_right: AWAY, state_snapshot: { teamAKey: 'home', currentSetIndex: 2, sideA: 'left', lineupA: HOME, lineupB: AWAY } }]
    })
    await importMatchFromSupabase(cloud)
    const m = store.matches[0]
    expect(m.setLeftTeamOverrides).toEqual({ 2: 'A' })
    expect(getSideAForSet(2, m)).toBe('left')
    expect(m.coinTossTeamA).toBe('home')
  })
})

// The set 5 setup's confirmation (its set5_coin_toss event) reaches the
// server since 9a855629: restored, it hides the set 5 setup panel, so the
// restored match needs the set's first server too. Only the event has it
// (no snapshot or live field carries set5FirstServe): without it set 5 was
// served by set 1's first server (found by a check, 2026-10-09).
describe('importMatchFromSupabase: the set 5 coin toss', () => {
  const toss = (over = {}) => ({ seq: 40, type: 'set5_coin_toss', set_index: 5, payload: { leftTeam: 'B', firstServe: 'B', leftTeamKey: 'away', firstServeTeamKey: 'away', ...over } })

  it('its first server, as the label of the restored Team A', async () => {
    const cloud = await restoreWith({ match: { coin_toss: { team_a: 'home', team_b: 'away', serve_a: true, first_serve: 'home', confirmed: true } }, events: [toss()] })
    await importMatchFromSupabase(cloud)
    const m = store.matches[0]
    expect(m.set5FirstServe).toBe('B')
    expect(getFirstServeForSet(5, m)).toBe('away')
  })

  it('A and B swapped since: the same team serves first', async () => {
    const cloud = await restoreWith({ match: { coin_toss: { team_a: 'away', team_b: 'home', serve_a: false, first_serve: 'home', confirmed: true } }, events: [toss()] })
    await importMatchFromSupabase(cloud)
    const m = store.matches[0]
    expect(m.set5FirstServe).toBe('A')
    expect(getFirstServeForSet(5, m)).toBe('away')
  })

  it('the latest toss counts; none: no set5FirstServe', async () => {
    const cloud = await restoreWith({ events: [toss(), toss({ firstServeTeamKey: 'home', firstServe: 'A' })].map((e, i) => ({ ...e, seq: 40 + i })) })
    await importMatchFromSupabase(cloud)
    expect(store.matches[0].set5FirstServe).toBe('A')
    store.matches.length = 0
    await importMatchFromSupabase(await restoreWith({ events: [] }))
    expect(store.matches[0]).not.toHaveProperty('set5FirstServe')
  })
})

describe('fetchMatchByPin: the live row\'s own Team A', () => {
  // An older version's "Switch sides" in sets 1-4 swapped A and B: the coin
  // toss queued (sync queue), the live state written at once. With the swap still in the
  // queue the cloud coin toss names the other team, and the live row's
  // side_a and lineup_a were read for it. The live row's team names tell
  // its own Team A; a live row not older than the latest event gives the
  // restored match its Team A (the swap as the scorer's match has it).
  const NAMES = { home_team: { name: 'Volley Näfels' }, away_team: { name: 'Chênois Genève' } }
  const homeLeft = (m, set) => (getSideAForSet(set, m) === 'left') === (m.coinTossTeamA === 'home')
  // set 2, A = home on the right; swapped: A = away, on the right (home left)
  const swappedLive = (over) => ({
    current_set: 2, side_a: 'right', points_a: 10, points_b: 8, lineup_a: AWAY, lineup_b: HOME,
    team_a_name: 'Chênois Genève', team_b_name: 'Volley Näfels',
    last_event_type: 'manual_switch_sides', last_event_ts: '2026-10-08T10:01:00.000Z', ...over
  })
  const pre = { seq: 7, type: 'point', set_index: 2, payload: { team: 'home' }, created_at: '2026-10-08T10:00:00.000Z', lineup_left: AWAY, lineup_right: HOME, state_snapshot: { teamAKey: 'home', currentSetIndex: 2, sideA: 'right', lineupA: HOME, lineupB: AWAY } }

  it('the swap still in the sync queue: the live row\'s Team A, home on the left; Swap A/B moves nothing, "Switch sides" moves the teams', async () => {
    const cloud = await restoreWith({
      match: { ...NAMES, coin_toss: { team_a: 'home', team_b: 'away', serve_a: true, first_serve: 'home', confirmed: true } },
      events: [pre],
      liveState: swappedLive()
    })
    await importMatchFromSupabase(cloud)
    const m = store.matches[0]
    expect(m.coinTossTeamA).toBe('away')
    expect(m.coinTossTeamB).toBe('home')
    // the first server stays home
    expect(m.firstServe).toBe('home')
    expect(m.coinTossServeA).toBe(false)
    expect(homeLeft(m, 2)).toBe(true)
    const { swapTeamDesignation } = await import('../../domain/coinToss')
    const { switchedSides } = await import('../../components/corrections/liveActions')
    expect(homeLeft({ ...m, ...swapTeamDesignation(m) }, 2)).toBe(true)
    expect(homeLeft({ ...m, setLeftTeamOverrides: switchedSides(m, 2) }, 2)).toBe(false)
  })

  it('without a snapshot: the live row\'s lineup_a is its own Team A\'s', async () => {
    const out = await restoreWith({
      match: { ...NAMES, coin_toss: { team_a: 'home', team_b: 'away', serve_a: true, first_serve: 'home', confirmed: true } },
      liveState: swappedLive()
    })
    expect(lineupOf(out, 'home')).toEqual(numbers(1))
    expect(lineupOf(out, 'away')).toEqual(numbers(11))
  })

  it('a row placed by the rule (no snapshot, no serve mark) synced before a Swap A/B at the match end: the restored match\'s sides', async () => {
    // set 2: A = home on the right (away left), the live row and the row
    // written so. Then "Swap A/B" (Manual adjustments): the cloud coin toss
    // says A = away, the live row is left as it was; nothing moved
    const out = await restoreWith({
      match: {
        ...NAMES,
        coin_toss: { team_a: 'away', team_b: 'home', serve_a: false, first_serve: 'home', confirmed: true },
        manual_changes: [{ ts: '2026-10-08T10:30:00.000Z', category: 'match', field: 'teamDesignation', before: 'A=home', after: 'A=away' }]
      },
      events: [{ seq: 7, type: 'point', set_index: 2, payload: { team: 'home' }, created_at: '2026-10-08T10:00:00.000Z', lineup_left: AWAY, lineup_right: HOME }],
      liveState: swappedLive({ side_a: 'right', lineup_a: HOME, lineup_b: AWAY, team_a_name: 'Volley Näfels', team_b_name: 'Chênois Genève', last_event_type: 'match_end' })
    })
    expect(out.match.coin_toss.team_a).toBe('away')
    expect(lineupOf(out, 'home')).toEqual(numbers(1))
    expect(lineupOf(out, 'away')).toEqual(numbers(11))
    await importMatchFromSupabase(out)
    const m = store.matches[0]
    expect(m.coinTossTeamA).toBe('away')
    // home on the right in set 2, on the left in sets 1 and 3: nothing moved
    expect([1, 2, 3, 4].map(set => homeLeft(m, set))).toEqual([true, false, true, false])
  })

  it('a live row older than the latest synced event: the cloud coin toss, the live side still read for its own Team A', async () => {
    const cloud = await restoreWith({
      match: { ...NAMES, coin_toss: { team_a: 'home', team_b: 'away', serve_a: true, first_serve: 'home', confirmed: true } },
      events: [{ seq: 9, type: 'timeout', set_index: 2, payload: { team: 'home' }, created_at: '2026-10-08T10:05:00.000Z' }],
      liveState: swappedLive()
    })
    await importMatchFromSupabase(cloud)
    const m = store.matches[0]
    expect(m.coinTossTeamA).toBe('home')
    expect(homeLeft(m, 2)).toBe(true)
  })

  it('a "Switch sides" synced while its live write failed: the snapshot\'s sides, not the stale live row\'s', async () => {
    // live row 10:01: set 2, A = home on the right. The scorer switched sides
    // (A = away, still on the right: home on the left) offline; the coin toss
    // and the next point (10:05, its snapshot) synced later, the live writes
    // did not
    const cloud = await restoreWith({
      match: { ...NAMES, coin_toss: { team_a: 'away', team_b: 'home', serve_a: false, first_serve: 'home', confirmed: true } },
      events: [{ seq: 9, type: 'point', set_index: 2, payload: { team: 'home' }, created_at: '2026-10-08T10:05:00.000Z', lineup_left: HOME, lineup_right: AWAY, state_snapshot: { teamAKey: 'away', currentSetIndex: 2, sideA: 'right', lineupA: AWAY, lineupB: HOME } }],
      liveState: swappedLive({ side_a: 'right', lineup_a: HOME, lineup_b: AWAY, team_a_name: 'Volley Näfels', team_b_name: 'Chênois Genève', last_event_type: 'point', last_event_ts: '2026-10-08T10:01:00.000Z' })
    })
    await importMatchFromSupabase(cloud)
    const m = store.matches[0]
    expect(m.coinTossTeamA).toBe('away')
    expect(homeLeft(m, 2)).toBe(true)
  })

  it('names that do not tell (the same on both teams, or missing): the cloud coin toss\'s Team A', async () => {
    const cloud = await restoreWith({
      match: { home_team: { name: 'X' }, away_team: { name: 'X' } },
      liveState: swappedLive({ team_a_name: 'X', team_b_name: 'X' })
    })
    await importMatchFromSupabase(cloud)
    expect(store.matches[0].coinTossTeamA).toBe('home')
    // side_a read for home (A): home on the right
    expect(homeLeft(store.matches[0], 2)).toBe(false)
  })
})

// "Swap A/B" in Manual adjustments at the match end corrects the coin toss
// (cloud coin_toss + a manual_changes entry) and leaves the live row and the
// events' snapshots as they were (Team A home). Restored by PIN: the
// corrected Team A, and each team on the side it played on.
describe('fetchMatchByPin after a Swap A/B at the match end', () => {
  const NAMES = { home_team: { name: 'Volley Näfels' }, away_team: { name: 'Chênois Genève' } }
  const homeLeft = (m, set) => (getSideAForSet(set, m) === 'left') === (m.coinTossTeamA === 'home')
  const corrected = {
    ...NAMES,
    coin_toss: { team_a: 'away', team_b: 'home', serve_a: false, first_serve: 'home', confirmed: true },
    manual_changes: [{ ts: '2026-10-08T11:00:00.000Z', category: 'match', field: 'teamDesignation', before: 'A=home', after: 'A=away' }]
  }
  const liveRow = (over) => ({
    team_a_name: 'Volley Näfels', team_b_name: 'Chênois Genève', match_status: 'ended',
    last_event_type: 'match_end', last_event_ts: '2026-10-08T10:50:00.000Z', ...over
  })

  it('ended in set 5 after the change at 8 (toss: home left; changed: home right): home on the right, the change made', async () => {
    const cloud = await restoreWith({
      match: corrected,
      events: [{ seq: 90, type: 'point', set_index: 5, payload: { team: 'home' }, created_at: '2026-10-08T10:49:00.000Z', state_snapshot: { teamAKey: 'home', currentSetIndex: 5, sideA: 'right', set5LeftTeam: 'A', set5CourtSwitched: true, lineupA: HOME, lineupB: AWAY } }],
      liveState: liveRow({ current_set: 5, side_a: 'right', points_a: 15, points_b: 12 })
    })
    await importMatchFromSupabase(cloud)
    const m = store.matches[0]
    expect(m.coinTossTeamA).toBe('away')
    expect(m.firstServe).toBe('home')
    expect(m.set5LeftTeam).toBe('B')
    expect(m.set5CourtSwitched).toBe(true)
    expect(homeLeft(m, 5)).toBe(false)
    // the sets before as they were played: home left in odd sets
    expect([1, 2, 3, 4].map(set => homeLeft(m, set))).toEqual([true, false, true, false])
  })

  it('ended in set 3, no saved side anywhere: each team on its side in every set', async () => {
    const cloud = await restoreWith({
      match: corrected,
      events: [{ seq: 60, type: 'point', set_index: 3, payload: { team: 'home' }, created_at: '2026-10-08T10:49:00.000Z', state_snapshot: { teamAKey: 'home', currentSetIndex: 3, sideA: 'left', lineupA: HOME, lineupB: AWAY } }],
      liveState: liveRow({ current_set: 3, side_a: 'left', points_a: 25, points_b: 20 })
    })
    await importMatchFromSupabase(cloud)
    const m = store.matches[0]
    expect(m.coinTossTeamA).toBe('away')
    expect([1, 2, 3, 4].map(set => homeLeft(m, set))).toEqual([true, false, true, false])
  })

  it('a live row written after the correction (play went on): its Team A as before', async () => {
    const cloud = await restoreWith({
      match: corrected,
      liveState: liveRow({ current_set: 3, side_a: 'right', team_a_name: 'Chênois Genève', team_b_name: 'Volley Näfels', last_event_ts: '2026-10-08T11:05:00.000Z', match_status: 'in_progress' })
    })
    await importMatchFromSupabase(cloud)
    const m = store.matches[0]
    expect(m.coinTossTeamA).toBe('away')
    // away (A) on the right: home on the left
    expect(homeLeft(m, 3)).toBe(true)
  })
})
