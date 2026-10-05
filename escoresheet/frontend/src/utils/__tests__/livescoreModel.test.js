import { describe, it, expect } from 'vitest'
import {
  hasMatchStarted,
  listedGames,
  getSetResults,
  trackWatched,
  needsFinalRefetch,
  shouldAutoConnect,
  applyMatchRowChange,
  jitterDelay,
  SETUP_EVENT_TYPES,
  IN_PLAY_EVENT_TYPES
} from '../livescoreModel'
import { applyLiveChange } from '../livescoreChanges'

// The row the scoreboard upserts at the first lineup confirm (Scoreboard.jsx
// syncLiveStateToSupabase('lineup'), before Start Set).
const lineupRow = (id = 'm1', extra = {}) => ({
  match_id: id,
  match_status: 'in_progress',
  current_set: 1,
  points_a: 0,
  points_b: 0,
  sets_won_a: 0,
  sets_won_b: 0,
  last_event_type: 'lineup',
  set_interval_active: false,
  timeout_active: false,
  ...extra
})

describe('hasMatchStarted', () => {
  it('a match is not live at its first lineup confirm (0:0, set 1)', () => {
    expect(hasMatchStarted(lineupRow())).toBe(false)
  })

  it('no setup event makes a 0:0 set-1 match live', () => {
    for (const ev of SETUP_EVENT_TYPES) {
      expect(hasMatchStarted(lineupRow('m', { last_event_type: ev }))).toBe(false)
    }
    expect(hasMatchStarted(lineupRow('m', { last_event_type: null }))).toBe(false)
  })

  it('events that also happen before Start Set do not make a 0:0 set-1 match live', () => {
    // handleUndo always syncs 'undo' (e.g. an undone lineup or court captain)
    expect(hasMatchStarted(lineupRow('m', { last_event_type: 'undo' }))).toBe(false)
    // a pre-match sanction goes through logEvent keyEvents
    expect(hasMatchStarted(lineupRow('m', { last_event_type: 'sanction' }))).toBe(false)
    expect(hasMatchStarted(lineupRow('m', { last_event_type: 'manual_score_update' }))).toBe(false)
    expect(hasMatchStarted(lineupRow('m', { last_event_type: 'libero_entry' }))).toBe(false)
    // an event type livescore does not know yet is not a start either
    expect(hasMatchStarted(lineupRow('m', { last_event_type: 'some_new_event' }))).toBe(false)
  })

  it('the same events do not hide a match that has points', () => {
    expect(hasMatchStarted(lineupRow('m', { last_event_type: 'undo', points_b: 1 }))).toBe(true)
    expect(hasMatchStarted(lineupRow('m', { last_event_type: 'sanction', points_a: 4 }))).toBe(true)
  })

  it('every in-play event makes a 0:0 set-1 match live', () => {
    for (const ev of IN_PLAY_EVENT_TYPES) {
      expect(hasMatchStarted(lineupRow('m', { last_event_type: ev }))).toBe(true)
    }
    expect(IN_PLAY_EVENT_TYPES.some((ev) => SETUP_EVENT_TYPES.includes(ev))).toBe(false)
  })

  it('is live from the first in-play event, point or set', () => {
    expect(hasMatchStarted(lineupRow('m', { last_event_type: 'set_start' }))).toBe(true)
    expect(hasMatchStarted(lineupRow('m', { last_event_type: 'point', points_a: 1 }))).toBe(true)
    expect(hasMatchStarted(lineupRow('m', { last_event_type: 'substitution' }))).toBe(true)
    expect(hasMatchStarted(lineupRow('m', { last_event_type: 'timeout', match_status: 'timeout', timeout_active: true }))).toBe(true)
    // a later setup-type event (side change at 3:1) does not hide a running match
    expect(hasMatchStarted(lineupRow('m', { last_event_type: 'manual_side_change', points_a: 3, points_b: 1 }))).toBe(true)
    // lineup of set 2 at 0:0
    expect(hasMatchStarted(lineupRow('m', { current_set: 2, sets_won_a: 1 }))).toBe(true)
    expect(hasMatchStarted(lineupRow('m', { match_status: 'interval', set_interval_active: true }))).toBe(true)
  })

  it('finished matches count; explicit pre-start statuses never do', () => {
    expect(hasMatchStarted(lineupRow('m', { match_status: 'ended', last_event_type: 'match_end', sets_won_a: 3 }))).toBe(true)
    expect(hasMatchStarted(lineupRow('m', { match_status: 'final' }))).toBe(true)
    expect(hasMatchStarted(lineupRow('m', { match_status: 'pre_match', last_event_type: 'point' }))).toBe(false)
    expect(hasMatchStarted(null)).toBe(false)
  })
})

describe('listedGames', () => {
  it('hides matches still in setup and keeps the list order', () => {
    const games = [lineupRow('a', { points_a: 2, last_event_type: 'point' }), lineupRow('b'), lineupRow('c', { match_status: 'ended' })]
    expect(listedGames(games).map((g) => g.match_id)).toEqual(['a', 'c'])
  })

  it('a match already shown stays listed after an undo back to 0:0', () => {
    const shown = new Set()
    listedGames([lineupRow('a', { points_a: 1, last_event_type: 'point' })], shown)
    const afterUndo = lineupRow('a', { last_event_type: 'lineup' })
    expect(listedGames([afterUndo], shown).map((g) => g.match_id)).toEqual(['a'])
    // but a match never shown stays hidden
    expect(listedGames([lineupRow('b')], shown)).toEqual([])
  })

  it('a lineup upsert then the first point: hidden, then listed', () => {
    const shown = new Set()
    let games = applyLiveChange([], { eventType: 'INSERT', new: lineupRow('a') })
    expect(listedGames(games, shown)).toEqual([])
    games = applyLiveChange(games, { eventType: 'UPDATE', new: { match_id: 'a', points_a: 1, last_event_type: 'point' } })
    expect(listedGames(games, shown).map((g) => g.match_id)).toEqual(['a'])
  })
})

describe('getSetResults', () => {
  const sets = [{ set: 1, home: 25, away: 4 }, { set: 2, home: 25, away: 0 }]

  it('prefers the live-state row, falls back to the joined match row', () => {
    expect(getSetResults({ set_results: sets, matches: { set_results: [] } })).toBe(sets)
    expect(getSetResults({ set_results: [], matches: { set_results: sets } })).toBe(sets)
    expect(getSetResults({ set_results: null, matches: [{ set_results: sets }] })).toBe(sets)
  })

  it('is empty when nothing is known', () => {
    expect(getSetResults({})).toEqual([])
    expect(getSetResults({ matches: null })).toEqual([])
    expect(getSetResults(undefined)).toEqual([])
  })
})

describe('needsFinalRefetch', () => {
  it('a match that ends while watched, with empty joined set_results, needs a refetch', () => {
    const watched = new Set()
    // initial select: live, join loaded before the match end wrote set_results
    let games = [lineupRow('a', { points_a: 10, last_event_type: 'point', matches: { set_results: [] } })]
    trackWatched(games, watched)
    // realtime UPDATE: match ended; carries only live-state columns
    games = applyLiveChange(games, { eventType: 'UPDATE', new: { match_id: 'a', match_status: 'ended', sets_won_a: 3, set_results: [] } })
    trackWatched(games, watched)
    expect(needsFinalRefetch(games[0], watched)).toBe(true)
    // refetch fills the join -> done
    const refetched = { ...games[0], matches: { set_results: [{ set: 1, home: 25, away: 4 }] } }
    expect(needsFinalRefetch(refetched, watched)).toBe(false)
  })

  it('a match that only arrived through realtime (no join) needs a refetch at the end', () => {
    const watched = new Set()
    const games = applyLiveChange([], { eventType: 'UPDATE', new: lineupRow('x', { match_status: 'ended' }) })
    trackWatched(games, watched)
    expect(needsFinalRefetch(games[0], watched)).toBe(true)
  })

  it('a match already finished at the initial select is not refetched', () => {
    const watched = new Set()
    const games = [lineupRow('old', { match_status: 'ended', matches: { set_results: null } })]
    trackWatched(games, watched)
    expect(needsFinalRefetch(games[0], watched)).toBe(false)
  })

  it('a running match or one with results never needs it', () => {
    const watched = new Set(['a'])
    expect(needsFinalRefetch(lineupRow('a'), watched)).toBe(false)
    expect(needsFinalRefetch(lineupRow('a', { match_status: 'ended', set_results: [{ set: 1, home: 25, away: 3 }] }), watched)).toBe(false)
  })
})

describe('shouldAutoConnect', () => {
  it('connects at once on *.openvolley.app (the case of hall TVs)', () => {
    expect(shouldAutoConnect({ staticDeployment: true })).toBe(true)
  })

  it('connects at once from the standalone LAN server / desktop app', () => {
    expect(shouldAutoConnect({ servedFromLocalServer: true })).toBe(true)
  })

  it('connects with ?match= or ?server=, or a server chosen before', () => {
    expect(shouldAutoConnect({ search: '?match=abc' })).toBe(true)
    expect(shouldAutoConnect({ search: '?server=192.168.1.5:8080' })).toBe(true)
    expect(shouldAutoConnect({ hasOverride: true })).toBe(true)
  })

  it('asks only in a dev build with no stored choice', () => {
    expect(shouldAutoConnect({})).toBe(false)
    expect(shouldAutoConnect({ search: '?foo=1' })).toBe(false)
  })
})

describe('applyMatchRowChange', () => {
  const sets = [{ set: 1, home: 25, away: 4 }]

  it('copies the match row set_results into the game with that match_id', () => {
    const games = [lineupRow('a', { match_status: 'ended', matches: { set_results: [] } }), lineupRow('b')]
    const next = applyMatchRowChange(games, { eventType: 'UPDATE', new: { id: 'a', set_results: sets, home_team: { x: 1 } } })
    expect(getSetResults(next[0])).toEqual(sets)
    expect(next[0].matches).toEqual({ set_results: sets })
    expect(next[1]).toBe(games[1])
  })

  it('also fills a game that arrived through realtime only (no join)', () => {
    const games = [lineupRow('a', { match_status: 'ended' })]
    const next = applyMatchRowChange(games, { eventType: 'UPDATE', new: { id: 'a', set_results: sets } })
    expect(getSetResults(next[0])).toEqual(sets)
  })

  it('a later live-state UPDATE keeps the merged set results', () => {
    let games = applyMatchRowChange([lineupRow('a', { matches: { set_results: [] } })], { eventType: 'UPDATE', new: { id: 'a', set_results: sets } })
    games = applyLiveChange(games, { eventType: 'UPDATE', new: { match_id: 'a', match_status: 'ended', set_results: [] } })
    expect(getSetResults(games[0])).toEqual(sets)
  })

  it('returns the same list when nothing applies', () => {
    const games = [lineupRow('a', { matches: { set_results: sets } })]
    expect(applyMatchRowChange(games, { eventType: 'UPDATE', new: { id: 'a', set_results: structuredClone(sets) } })).toBe(games)
    expect(applyMatchRowChange(games, { eventType: 'UPDATE', new: { id: 'zz', set_results: sets } })).toBe(games)
    expect(applyMatchRowChange(games, { eventType: 'UPDATE', new: { id: 'a' } })).toBe(games)
    expect(applyMatchRowChange(games, { eventType: 'DELETE', old: { id: 'a' } })).toBe(games)
  })
})

describe('jitterDelay', () => {
  it('stays within ±30%', () => {
    expect(jitterDelay(1000, () => 0)).toBe(700)
    expect(jitterDelay(1000, () => 0.5)).toBe(1000)
    expect(jitterDelay(1000, () => 0.999999)).toBe(1300)
  })
})
